#!/usr/bin/env node
/**
 * dsh-remote-plugin 安装器 / 修复器（幂等）。
 *
 * 安装做四件事：
 *   1. 把 plugin 与 gateway 两个包 junction 进 DSH 的共享包农场
 *      ~/.dsh/profiles/node_modules（服务 gateway 兜底解析）；
 *   2. 把 plugin 以裸包名 dsh-remote-plugin junction 进目标 profile 的
 *      node_modules——cordis loader 按 patch 行的 name 从 profile 目录向上
 *      解析裸名，作用域链接解析不到（与 dsh-explorer 等兄弟插件一致）；
 *   3. 向 profile 的 cordis.patch.yml 追加 insert 行（已存在则跳过）；
 *      追加前先把原文件备份为 cordis.patch.yml.bak-<时间戳>（PLG-01，
 *      DSH 升级/重装可能重置该文件，备份保证可回滚）；
 *   4. 写安装标记 .dsh-remote-plugin.json：记录插件版本、仓库根目录与
 *      所适配的 DSH 宿主版本（尽力从 DSH 安装位置读取），供 --repair
 *      体检时判断"宿主升级后 patch/链接是否可能被重置"（PLG-01）。
 *
 * 用法：
 *   node scripts/install.mjs               # 默认 profile web
 *   node scripts/install.mjs --profile xxx
 *   node scripts/install.mjs --dry-run
 *   node scripts/install.mjs --repair      # 体检并修复：检测 patch 行缺失 /
 *                                          # node_modules 链接断裂并重建（幂等）
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");
const GATEWAY_DIR = join(REPO_ROOT, "packages", "gateway");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const REPAIR = argv.includes("--repair");
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const PROFILE = opt("--profile") ?? "web";
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const PATCH_PATH = join(PROFILE_DIR, "cordis.patch.yml");
const FARM_DIR = join(DSH_HOME, "profiles", "node_modules");
const MARKER_PATH = join(PROFILE_DIR, ".dsh-remote-plugin.json");
const PLUGIN_PKG = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
const PLUGIN_NAME = PLUGIN_PKG.name;

const log = (...parts) => console.log(...parts);

/**
 * PLG-01：尽力读取所适配的 DSH 宿主版本（写进安装标记）。
 * 优先级：env DSH_HOST_VERSION → DSH Desktop 安装位置的 payload-manifest.json
 * （frontend.version）→ dsh-web-frontend 包 package.json → "unknown"。
 * 读不到不阻塞安装：标记里记 "unknown"，--repair 仍能按链接/行本身体检。
 */
function detectHostVersion() {
	const fromEnv = process.env.DSH_HOST_VERSION;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return { version: fromEnv.trim(), source: "env:DSH_HOST_VERSION" };
	}
	const home = process.env.USERPROFILE || process.env.HOME || "";
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const bases = process.platform === "win32"
		? [join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "DSH Desktop")]
		: process.platform === "darwin"
			? [join(home, "Library", "Application Support", "DSH Desktop")]
			: [join(configHome, "DSH Desktop"), join(home, ".local", "share", "DSH Desktop")];
	for (const base of bases) {
		try {
			const manifest = JSON.parse(readFileSync(join(base, "payload", "payload-manifest.json"), "utf8"));
			const version = manifest?.frontend?.version;
			if (typeof version === "string" && version.length > 0) {
				return { version, source: join(base, "payload", "payload-manifest.json") };
			}
		} catch { /* 尝试下一个来源 */ }
		try {
			const frontendPkgPath = join(base, "payload", "app", "node_modules", "@deepseek-ai", "dsh-web-frontend", "package.json");
			const frontendPkg = JSON.parse(readFileSync(frontendPkgPath, "utf8"));
			if (typeof frontendPkg.version === "string" && frontendPkg.version.length > 0) {
				return { version: frontendPkg.version, source: frontendPkgPath };
			}
		} catch { /* 尝试下一个来源 */ }
	}
	return { version: "unknown", source: "not-detected" };
}

function readMarker() {
	try {
		return JSON.parse(readFileSync(MARKER_PATH, "utf8"));
	} catch {
		return null;
	}
}

/** 写安装标记：installedAt 保留首次安装时间，updatedAt/hostVersion 每次刷新。 */
function writeMarker(previous) {
	const host = detectHostVersion();
	const marker = {
		plugin: PLUGIN_NAME,
		pluginVersion: PLUGIN_PKG.version,
		profile: PROFILE,
		installedAt: typeof previous?.installedAt === "string" ? previous.installedAt : new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		hostVersion: host.version,
		hostVersionSource: host.source,
		repoRoot: REPO_ROOT,
		patchPath: PATCH_PATH,
		links: {
			farmGateway: join(FARM_DIR, "@dsh-remote", "gateway"),
			farmPlugin: join(FARM_DIR, "@dsh-remote", "plugin"),
			profilePlugin: join(PROFILE_DIR, "node_modules", PLUGIN_NAME),
		},
	};
	if (!DRY) writeFileSync(MARKER_PATH, `${JSON.stringify(marker, null, "\t")}\n`, "utf8");
	return marker;
}

/** PLG-01：修改 profile 的 cordis.patch.yml 前备份原文件（含时间戳）；返回备份路径。 */
function backupFile(filePath) {
	if (!existsSync(filePath)) return undefined;
	const now = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
		+ `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		+ `-${pad(now.getMilliseconds(), 3)}`;
	const backupPath = `${filePath}.bak-${stamp}`;
	copyFileSync(filePath, backupPath);
	return backupPath;
}

/**
 * 体检链接状态：
 *   ok       链接存在且指向目标
 *   dangling 链接存在但目标已丢失（仓库搬迁/宿主重置的典型症状）
 *   wrong    链接指向别处，或链接位置被普通目录/文件占用
 *   missing  链接不存在
 */
function inspectLink(linkPath, target) {
	try {
		lstatSync(linkPath);
	} catch {
		return { state: "missing", isLink: false };
	}
	let current;
	try {
		current = readlinkSync(linkPath);
	} catch {
		current = undefined;
	}
	if (current === undefined) return { state: "wrong", isLink: false }; // 普通目录/文件占用
	const resolvedCurrent = resolve(dirname(linkPath), current);
	const alive = existsSync(linkPath); // 跟随到最终目标
	if (resolvedCurrent === resolve(target)) return { state: alive ? "ok" : "dangling", isLink: true };
	return { state: alive ? "wrong" : "dangling", isLink: true };
}

/** 移除链接位点：链接/联接只删链接本身（绝不递归进目标内容），普通目录才递归删。 */
function removeLinkLike(linkPath, isLink) {
	if (isLink) {
		try {
			rmSync(linkPath, { recursive: false, force: true });
			return;
		} catch { /* 落到下方递归兜底（普通目录占用等） */ }
	}
	rmSync(linkPath, { recursive: true, force: true });
}

/** 确保 linkPath 是指向 target 的目录联接/符号链接；返回 ok / created / replaced。 */
function ensureLink(linkPath, target) {
	const { state, isLink } = inspectLink(linkPath, target);
	if (state === "ok") {
		log(`  ✓ ${linkPath} 已就位`);
		return "ok";
	}
	if (state === "missing") {
		log(`  + 链接 ${linkPath} → ${target}`);
	} else {
		log(`  ↻ ${linkPath} ${state === "dangling" ? "目标已丢失" : "指向错误位置"}，重建`);
	}
	if (!DRY) {
		if (state !== "missing") removeLinkLike(linkPath, isLink);
		mkdirSync(dirname(linkPath), { recursive: true });
		if (process.platform === "win32") {
			const result = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, target], { stdio: "inherit" });
			if (result.status !== 0) throw new Error(`mklink 失败：${linkPath} → ${target}`);
		} else {
			symlinkSync(target, linkPath, "dir");
		}
	}
	return state === "missing" ? "created" : "replaced";
}

function patchHasRow(patchText, id) {
	return patchText.includes(`id: ${id}`) || patchText.includes(`id: '${id}'`) || patchText.includes(`id: "${id}"`);
}

/** 确保 patch 行存在；追加前先备份原文件（PLG-01）。返回 ok / appended。 */
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
		return "ok";
	}
	log(`  + 写入 ${PATCH_PATH}`);
	if (!DRY) {
		mkdirSync(dirname(PATCH_PATH), { recursive: true });
		const backupPath = backupFile(PATCH_PATH);
		writeFileSync(PATCH_PATH, `${text}${row}`, "utf8");
		if (backupPath !== undefined) log(`  ✓ 原 patch 已备份 → ${backupPath}`);
	}
	return "appended";
}

log(`▶ dsh-remote-plugin ${REPAIR ? "修复体检" : "安装"}${DRY ? "（dry-run）" : ""}`);
log(`  repo:     ${REPO_ROOT}`);
log(`  profile:  ${PROFILE_DIR}`);

if (!existsSync(join(GATEWAY_DIR, "src", "cli.ts"))) throw new Error(`找不到 gateway 包：${GATEWAY_DIR}`);
if (!existsSync(join(PLUGIN_DIR, "lib", "index.js"))) throw new Error(`找不到 plugin 包：${PLUGIN_DIR}`);

// ── PLG-01：修复模式先对照安装标记，识别"宿主升级可能重置过 profile"的情形 ──
const previousMarker = readMarker();
if (REPAIR) {
	if (previousMarker === null) {
		log("  ⚠ 未找到安装标记（可能是旧版安装），体检完成后补写");
	} else {
		const host = detectHostVersion();
		if (typeof previousMarker.hostVersion === "string" && previousMarker.hostVersion !== "unknown"
			&& host.version !== "unknown" && previousMarker.hostVersion !== host.version) {
			log(`  ⚠ 安装标记记录的宿主版本已变化：${previousMarker.hostVersion} → ${host.version}`);
			log("    宿主升级可能重置过 profile 的 cordis.patch.yml / node_modules 链接，下面逐项体检并重建");
		} else {
			log(`  ✓ 安装标记存在（宿主版本 ${previousMarker.hostVersion ?? "unknown"}，安装于 ${previousMarker.installedAt ?? "未知"}）`);
		}
	}
}

// 包解析基地：共享农场，不存在则创建（与 DSH 自身布局一致）
if (!DRY) mkdirSync(FARM_DIR, { recursive: true });
const scope = join(FARM_DIR, "@dsh-remote");

const repairs = [];
const track = (label, result) => {
	if (result === "created") repairs.push(`${label}：缺失，已重建`);
	else if (result === "replaced") repairs.push(`${label}：断裂/错位，已重建`);
};

log("▶ 包农场链接");
track("农场 @dsh-remote/gateway", ensureLink(join(scope, "gateway"), GATEWAY_DIR));
track("农场 @dsh-remote/plugin", ensureLink(join(scope, "plugin"), PLUGIN_DIR));

// 关键：loader 按裸名解析，必须链接进 per-profile node_modules
log("▶ profile node_modules 链接");
track(`profile ${PLUGIN_NAME}`, ensureLink(join(PROFILE_DIR, "node_modules", PLUGIN_NAME), PLUGIN_DIR));

log("▶ profile patch");
const patchResult = ensurePatchRow();
if (patchResult !== "ok") repairs.push("cordis.patch.yml：缺 dsh-remote-plugin 行，已补写（原文件已备份）");

// 标记只是辅助体检信息：写失败（如 profile 目录权限受限）不影响链接/补丁修复结果
let marker = null;
try {
	marker = writeMarker(previousMarker);
	if (!DRY) log(`  ✓ 安装标记 ${MARKER_PATH}`);
} catch (error) {
	log(`  ⚠ 安装标记写入失败 ${MARKER_PATH}：${String(error.message ?? error)}`);
	log("    （不影响以上链接/补丁修复结果；如需标记，请检查 profile 目录写权限后重跑）");
}

if (REPAIR) {
	log(repairs.length === 0
		? "\n✅ 修复体检完成：一切正常，无需重建"
		: `\n✅ 修复完成，重建 ${String(repairs.length)} 项：\n${repairs.map((item) => `  - ${item}`).join("\n")}`);
	if (!DRY && marker !== null) log(`宿主版本已记录为 ${marker.hostVersion}（来源：${marker.hostVersionSource}）。重启 DSH Desktop 生效。`);
} else {
	log(DRY ? "\n[dry-run] 未做任何修改" : "\n✅ 安装完成。重启 DSH Desktop 后网关随 profile 自启（config.json autoStart=false 可关闭）。");
}
