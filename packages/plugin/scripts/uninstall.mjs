#!/usr/bin/env node
/**
 * dsh-remote-plugin 卸载器：移除 junction 与 patch 行（幂等）。
 *
 * PLG-01：删除 patch 行前先把原文件备份为 cordis.patch.yml.bak-<时间戳>
 * （与 install.mjs 同一备份约定，误卸载可回滚）；同时清理安装标记
 * .dsh-remote-plugin.json。
 */

import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const PROFILE = opt("--profile") ?? "web";
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const PATCH_PATH = join(DSH_HOME, "profiles", PROFILE, "cordis.patch.yml");
const FARM_DIR = join(DSH_HOME, "profiles", "node_modules");
const MARKER_PATH = join(DSH_HOME, "profiles", PROFILE, ".dsh-remote-plugin.json");

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

/** 链接位点是否存在（lstat 不跟随目标：悬空链接也算存在，需要清理）。 */
function existsLoose(linkPath) {
	try {
		lstatSync(linkPath);
		return true;
	} catch {
		return false;
	}
}

/** 移除链接位点：链接/联接只删链接本身（绝不递归进目标内容），普通目录才递归删。 */
function removeLinkLike(linkPath) {
	let isLink = false;
	try {
		lstatSync(linkPath);
		try {
			readlinkSync(linkPath);
			isLink = true;
		} catch { /* 普通目录/文件占用 */ }
	} catch {
		return; // 不存在
	}
	if (isLink) {
		try {
			rmSync(linkPath, { recursive: false, force: true });
			return;
		} catch { /* 落到下方递归兜底 */ }
	}
	rmSync(linkPath, { recursive: true, force: true });
}

for (const name of ["gateway", "plugin"]) {
	const linkPath = join(FARM_DIR, "@dsh-remote", name);
	if (existsLoose(linkPath)) {
		console.log(`- 移除 ${linkPath}`);
		if (!DRY) removeLinkLike(linkPath);
	}
}

const profilePluginLink = join(DSH_HOME, "profiles", PROFILE, "node_modules", "dsh-remote-plugin");
if (existsLoose(profilePluginLink)) {
	console.log(`- 移除 ${profilePluginLink}`);
	if (!DRY) removeLinkLike(profilePluginLink);
}

if (existsSync(PATCH_PATH)) {
	const lines = readFileSync(PATCH_PATH, "utf8").split("\n");
	const anchorIndex = lines.findIndex((line) => line.includes("dsh-remote-plugin"));
	if (anchorIndex === -1) {
		console.log("- patch 中无 dsh-remote-plugin 行，跳过");
	} else {
		// 向上扩到最近的顶层 "- insert:"，向下扩到连续的缩进/注释行结束
		let start = anchorIndex;
		while (start > 0 && lines[start - 1].trim() !== "- insert:" && !lines[start - 1].startsWith("- ")) start -= 1;
		let end = anchorIndex;
		while (end + 1 < lines.length && (lines[end + 1].startsWith(" ") || lines[end + 1].startsWith("#"))) end += 1;

		// 若 "- insert:" 开行与被删内容之间只有本块的注释/缩进行，
		// 且删完后该 insert 块不再有任何子项，则把开行一并移除
		const openerIndex = (() => {
			for (let i = start - 1; i >= 0; i -= 1) {
				if (lines[i].trim() === "- insert:") {
					const between = lines.slice(i + 1, start);
					if (between.every((l) => l.startsWith(" ") || l.startsWith("#"))) return i;
					return -1;
				}
				if (!lines[i].startsWith(" ") && !lines[i].startsWith("#") && lines[i].trim() !== "") break;
			}
			return -1;
		})();
		if (openerIndex >= 0) {
			const rest = lines.slice(end + 1);
			const hasMoreChildren = rest.length > 0 && (rest[0].startsWith(" ") || rest[0].startsWith("#"));
			if (!hasMoreChildren) start = openerIndex;
		}

		const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
		console.log(`- 从 ${PATCH_PATH} 移除第 ${String(start + 1)}~${String(end + 1)} 行`);
		if (!DRY) {
			const backupPath = backupFile(PATCH_PATH);
			writeFileSync(PATCH_PATH, kept.join("\n"), "utf8");
			if (backupPath !== undefined) console.log(`  原 patch 已备份 → ${backupPath}`);
		}
	}
}

if (existsSync(MARKER_PATH)) {
	console.log(`- 移除安装标记 ${MARKER_PATH}`);
	if (!DRY) rmSync(MARKER_PATH, { force: true });
}

console.log(DRY ? "\n[dry-run] 未做任何修改" : "\n✅ 卸载完成。重启 DSH Desktop 生效。");
