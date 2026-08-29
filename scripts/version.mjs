#!/usr/bin/env node
// DSH-Remote 版本号工具。规则详见 docs/versioning.md：
//
//   版本号 = <deepseek-harness 基线版本>.<我们自己的发版号>
//   例如 harness 为 0.1.1-rc.2 时：0.1.1-rc.2.1、0.1.1-rc.2.2、…
//   · 每次发新版发版号 +1（即使代码没变也要递增，保证 tag/APK 可区分）
//   · harness 出新版本时用 --base 切换基线，发版号重置为 1
//
// 用法：
//   node scripts/version.mjs              # 显示当前版本（等价 show）
//   node scripts/version.mjs next         # 只打印下一个版本号，不改文件
//   node scripts/version.mjs bump         # 发版号 +1，写回所有 package.json
//   node scripts/version.mjs bump --base 0.1.2-rc.1
//                                         # 切换 harness 基线，发版号重置为 1

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgFiles = [
	path.join(root, "package.json"),
	path.join(root, "packages", "gateway", "package.json"),
	path.join(root, "packages", "plugin", "package.json"),
];

// 宽松 semver：主版本.次版本.修订号[-预发布]，预发布段允许字母数字与 .-（如 0.1.1-rc.2）
const BASE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};

function readState() {
	const raw = readFileSync(pkgFiles[0], "utf8");
	const pkg = JSON.parse(raw);
	let { version, dshVersion } = pkg;
	if (!dshVersion) {
		// 兼容旧文件：未显式声明基线时，按「去掉末尾 .<发版号>」推断
		const m = /^(.+)\.(\d+)$/.exec(version ?? "");
		if (!m) fail(`package.json 的 version "${version}" 不符合 <基线>.<发版号> 规则`);
		dshVersion = m[1];
	}
	if (!BASE_RE.test(dshVersion)) fail(`dshVersion "${dshVersion}" 不是合法的 semver 基线`);
	const m = /^\.(\d+)$/.exec(version.slice(dshVersion.length));
	if (!m || Number(m[1]) < 1) {
		fail(`version "${version}" 应等于 "<基线>.<发版号>"（当前基线 ${dshVersion}）`);
	}
	return { version, dshVersion, release: Number(m[1]) };
}

function writeAll({ version, dshVersion }) {
	for (const file of pkgFiles) {
		const pkg = JSON.parse(readFileSync(file, "utf8"));
		pkg.version = version;
		if (path.relative(root, file) === "package.json") pkg.dshVersion = dshVersion;
		writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
	}
}

// OPS-07：bump 后自动同步 docs/versioning.md「当前状态」快照表，
// 避免状态表与根 package.json 漂移。定位不到对应行时降级为手动义务提示。
const VERSIONING_DOC = path.join(root, "docs", "versioning.md");

function syncVersioningDoc(version, nextVersion) {
	let text;
	try {
		text = readFileSync(VERSIONING_DOC, "utf8");
	} catch {
		console.warn(`⚠ 无法读取 ${path.relative(root, VERSIONING_DOC)}，跳过状态表自动同步`);
		return;
	}
	// 注意：行尾用 [ \t]* 而非 \s*——\s 会吞掉换行，空行相邻时会破坏文档结构
	const rows = [
		{
			label: "当前已发布版本",
			re: /^\|[ \t]*当前已发布版本[ \t]*\|.*\|[ \t]*$/m,
			to: `| 当前已发布版本 | \`${version}\`（tag \`v${version}\`） |`,
		},
		{
			label: "下一次发布",
			re: /^\|[ \t]*下一次发布[ \t]*\|.*\|[ \t]*$/m,
			to: `| 下一次发布 | \`${nextVersion}\` |`,
		},
	];
	let updated = text;
	for (const row of rows) {
		if (!row.re.test(updated)) {
			console.warn(`⚠ docs/versioning.md 未找到「${row.label}」行，请手动更新当前状态表`);
			continue;
		}
		updated = updated.replace(row.re, row.to);
	}
	if (updated !== text) {
		writeFileSync(VERSIONING_DOC, updated);
		console.log(`  已同步 ${path.relative(root, VERSIONING_DOC)} 当前状态表`);
	}
}

const [, , cmd = "show", ...rest] = process.argv;
const flagOf = (name) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};

const s = readState();

switch (cmd) {
	case "show": {
		console.log(`${s.version}  （harness 基线 ${s.dshVersion}，发版号 ${s.release}）`);
		break;
	}
	case "next": {
		console.log(`${s.dshVersion}.${s.release + 1}`);
		break;
	}
	case "bump": {
		const base = flagOf("--base");
		let next;
		if (base !== undefined) {
			if (!BASE_RE.test(base)) fail(`--base "${base}" 不是合法的 semver 基线（如 0.1.2-rc.1）`);
			if (base === s.dshVersion) fail(`基线本来就是 ${base}，无需切换；直接用不带参数的 bump 递增发版号即可`);
			next = { version: `${base}.1`, dshVersion: base };
			console.log(`harness 基线 ${s.dshVersion} → ${base}，发版号重置为 1`);
		} else {
			next = { version: `${s.dshVersion}.${s.release + 1}`, dshVersion: s.dshVersion };
		}
		writeAll(next);
		console.log(`✓ ${s.version} → ${next.version}`);
		for (const f of pkgFiles) console.log(`  已更新 ${path.relative(root, f)}`);
		const nextRelease = Number(next.version.slice(next.dshVersion.length + 1));
		syncVersioningDoc(next.version, `${next.dshVersion}.${nextRelease + 1}`);
		const tag = `v${next.version}`;
		console.log(`
下一步发布：
  git add -A && git commit -m "release: ${tag}"
  git tag ${tag}
  git push && git push origin ${tag}
推送 tag 后 CI 会校验一致性并自动打包发布 GitHub Release。`);
		break;
	}
	default:
	fail(`未知命令 "${cmd}"；可用：show（默认）/ next / bump [--base <semver>]`);
}
