#!/usr/bin/env node
/**
 * dsh-remote-plugin 安装器（幂等）。
 *
 * 做两件事：
 *   1. 把 plugin 与 gateway 两个包 junction 进 DSH 的包解析农场
 *      （优先共享农场 ~/.dsh/profiles/node_modules，其次 per-profile 目录）；
 *   2. 向 profile 的 cordis.patch.yml 追加 insert 行（已存在则跳过）。
 *
 * 用法：
 *   node scripts/install.mjs               # 默认 profile web
 *   node scripts/install.mjs --profile xxx
 *   node scripts/install.mjs --dry-run
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");
const GATEWAY_DIR = join(REPO_ROOT, "packages", "gateway");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const PROFILE = opt("--profile") ?? "web";
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const PATCH_PATH = join(PROFILE_DIR, "cordis.patch.yml");
const FARM_DIR = join(DSH_HOME, "profiles", "node_modules");

const log = (...parts) => console.log(...parts);

/** 确保 linkPath 是指向 target 的目录联接/符号链接；已正确就位则跳过。 */
function ensureLink(linkPath, target) {
	if (existsSync(linkPath)) {
		let current = undefined;
		try {
			current = readlinkSync(linkPath);
		} catch {
			try {
				// 目录联接（junction）在部分实现下 readlink 可读；目录则视为占用
				if (lstatSync(linkPath).isDirectory()) current = linkPath;
			} catch {}
		}
		const resolvedCurrent = current === undefined ? undefined : resolve(dirname(linkPath), current);
		if (resolvedCurrent === resolve(target)) {
			log(`  ✓ ${linkPath} 已就位`);
			return;
		}
		log(`  ↻ 替换已有 ${linkPath}`);
		if (!DRY) rmSync(linkPath, { recursive: true, force: true });
	}
	log(`  + 链接 ${linkPath} → ${target}`);
	if (!DRY) {
		mkdirSync(dirname(linkPath), { recursive: true });
		if (process.platform === "win32") {
			const result = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "inherit" });
			if (result.status !== 0) throw new Error(`mklink 失败：${linkPath} → ${target}`);
		} else {
			symlinkSync(target, linkPath, "dir");
		}
	}
}

function patchHasRow(patchText, id) {
	return patchText.includes(`id: ${id}`) || patchText.includes(`id: '${id}'`) || patchText.includes(`id: "${id}"`);
}

function ensurePatchRow() {
	const row = [
		"",
		"- insert:",
		"    # DSH-Remote：随 profile 启动自动拉起远程网关（手机访问入口）。",
		"    - id: dsh-remote-plugin",
		"      name: dsh-remote-plugin",
		"",
	].join("\n");
	let text = "";
	if (existsSync(PATCH_PATH)) text = readFileSync(PATCH_PATH, "utf8");
	if (patchHasRow(text, "dsh-remote-plugin")) {
		log("  ✓ cordis.patch.yml 已包含 dsh-remote-plugin 行");
		return;
	}
	log(`  + 写入 ${PATCH_PATH}`);
	if (!DRY) {
		mkdirSync(dirname(PATCH_PATH), { recursive: true });
		writeFileSync(PATCH_PATH, `${text}${row}`, "utf8");
	}
}

log("▶ dsh-remote-plugin 安装");
log(`  repo:     ${REPO_ROOT}`);
log(`  profile:  ${PROFILE_DIR}`);

if (!existsSync(join(GATEWAY_DIR, "src", "cli.ts"))) throw new Error(`找不到 gateway 包：${GATEWAY_DIR}`);
if (!existsSync(join(PLUGIN_DIR, "lib", "index.js"))) throw new Error(`找不到 plugin 包：${PLUGIN_DIR}`);

// 包解析基地：优先共享农场，不存在则创建（与 DSH 自身布局一致）
const base = existsSync(FARM_DIR) ? FARM_DIR : FARM_DIR;
if (!DRY) mkdirSync(base, { recursive: true });
const scope = join(base, "@dsh-remote");
ensureLink(join(scope, "gateway"), GATEWAY_DIR);
ensureLink(join(scope, "plugin"), PLUGIN_DIR);

log("▶ profile patch");
ensurePatchRow();

log(DRY ? "\n[dry-run] 未做任何修改" : "\n✅ 安装完成。重启 DSH Desktop 后网关随 profile 自启（config.json autoStart=false 可关闭）。");
