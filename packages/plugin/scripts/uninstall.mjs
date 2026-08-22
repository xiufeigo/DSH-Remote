#!/usr/bin/env node
/** dsh-remote-plugin 卸载器：移除 junction 与 patch 行（幂等）。 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

for (const name of ["gateway", "plugin"]) {
	const linkPath = join(FARM_DIR, "@dsh-remote", name);
	if (existsSync(linkPath)) {
		console.log(`- 移除 ${linkPath}`);
		if (!DRY) rmSync(linkPath, { recursive: true, force: true });
	}
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
		const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
		console.log(`- 从 ${PATCH_PATH} 移除第 ${String(start + 1)}~${String(end + 1)} 行`);
		if (!DRY) writeFileSync(PATCH_PATH, kept.join("\n"), "utf8");
	}
}

console.log(DRY ? "\n[dry-run] 未做任何修改" : "\n✅ 卸载完成。重启 DSH Desktop 生效。");
