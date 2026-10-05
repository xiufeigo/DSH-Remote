# T78：重连横幅状态机 / 判据 / 探针只读性的 JVM 行为测试（生产 ReconnectBanner，无模拟器）。
# 与 test-direct-nodes.ps1 同一套编译/运行方式：只用 android.jar 当编译期符号，
# 逻辑全在纯 Java 部分（Debouncer / isOnScreen / shouldSuppress / bandHeightPx / PROBE_JS 常量），
# 运行时不触达任何 Android stub 方法。
#
# T86 加了两样东西：
#   · 参数：hook 源（断言 7 逐字符比对）+ MainActivity 源（缺口② 的判据来源断言）；
#   · 臂②：把**真实 PROBE_JS**（从 ReconnectBanner.java 按 Java 拼接规则抽出来）放进一个
#     极简 DOM 桩真跑 —— JVM 里没有 JS 引擎，臂①只能验"探针里的正则字面量"，
#     验不了匹配**流程**（层 1 优先 / 排除清单否决 / 可见性闸 / 整串锚定 / 两层顺序）。
#     ⚠️ DOM 桩是**模型**不是浏览器 ⇒ 设备侧真机证据仍是终审（见 scratch/t86/report.md）。
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build/reconnect'
New-Item -ItemType Directory -Force "$out/classes" | Out-Null
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$src = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote'
# 单一源：hook 里的 RECONNECT_STATUS_RE（断言 7 逐字符比对，上游换文案时先红）
$hook = Join-Path (Split-Path $PSScriptRoot -Parent) 'packages/gateway/assets/mobile-web.js'
$main = Join-Path $src 'MainActivity.java'
Write-Host "== hook 单一源（断言 7 比对对象）：$hook"
Write-Host "== MainActivity 源（T86 缺口② 判据来源）：$main"
Write-Host "== jdk：$jdk"
& "$jdk/bin/javac.exe" -encoding UTF-8 -nowarn -cp "$platform" -d "$out/classes" `
    "$src/ReconnectBanner.java" "$PSScriptRoot/tests/ReconnectBannerTest.java"
if ($LASTEXITCODE -ne 0) { throw 'JVM test compile failed' }
& "$jdk/bin/java.exe" "-Dstdout.encoding=UTF-8" "-Dstderr.encoding=UTF-8" -cp "$out/classes;$platform" top.d1studio.dshremote.ReconnectBannerTest $hook $main
if ($LASTEXITCODE -ne 0) { throw 'ReconnectBanner tests failed' }

# ── 臂②：真实 PROBE_JS 的 DOM 桩行为臂 ─────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) {
	Write-Host 'skip probe DOM-stub arm (node not found)'
	exit 0
}
$harness = Join-Path ([System.IO.Path]::GetTempPath()) 't86-probe-dom-stub.mjs'
$harnessJs = @'
/**
 * T86 臂②：把**真实 PROBE_JS**（从 `ReconnectBanner.java` 里按 Java 字符串拼接规则抽出来）
 * 放进一个**极简 DOM 桩**里真跑，验匹配**流程**（JVM 里没有 JS 引擎，Java 只能验字面量）。
 *
 * ⚠️ 诚实边界：这里的 DOM 是**模型**，不是浏览器。浏览器侧终审证据在设备真机跑
 * （`scratch/t86/report.md` §3/§6）。这一臂的价值：快、可重复、把「层 1 的
 * data-phase 优先 / 排除清单否决 / 可见性闸 / 整串锚定 / 两层顺序」钉在源码级回归网里。
 *
 * 用法：node probe-dom-stub.mjs <仓库根>/android/app/src/main/java/top/d1studio/dshremote/ReconnectBanner.java
 */
import fs from 'node:fs';

// ── ① 从 Java 源里把常量表求出来（只认 String/int 字面量 + 常量名 + 数字 + '+' 拼接）─
function readStringLiteral(s, i) {
	let j = i + 1, buf = '';
	while (j < s.length) {
		const c = s[j];
		if (c === '\\') {
			const n = s[j + 1];
			if (n === 'u') { buf += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 6; continue; }
			buf += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', "'": "'" })[n] ?? n;
			j += 2; continue;
		}
		if (c === '"') return { value: buf, next: j + 1 };
		buf += c; j++;
	}
	throw new Error('unterminated Java string literal at ' + i);
}

function evalExpr(s, i, consts) {
	let cur = null;
	while (i < s.length) {
		const c = s[i];
		if (c === ';') break;
		if (/\s/.test(c) || c === '+') { i++; continue; }
		if (c === '"') {
			const r = readStringLiteral(s, i);
			cur = (cur === null ? '' : cur) + r.value;
			i = r.next; continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i;
			while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
			const name = s.slice(i, j);
			i = j;
			if (!(name in consts)) throw new Error('unknown constant: ' + name);
			cur = (cur === null ? '' : cur) + String(consts[name]);
			continue;
		}
		if (/[0-9]/.test(c)) {
			let j = i;
			while (j < s.length && /[0-9]/.test(s[j])) j++;
			cur = (cur === null ? '' : cur) + s.slice(i, j);
			i = j; continue;
		}
		throw new Error('unexpected char in constant expression: ' + JSON.stringify(c));
	}
	return { value: cur === null ? '' : cur, next: i };
}

function collectConstants(java) {
	const decls = [];
	const re = /public static final (String|int) ([A-Za-z0-9_]+)\s*=\s*/g;
	let m;
	while ((m = re.exec(java))) decls.push({ name: m[2], at: m.index + m[0].length });
	const consts = {};
	for (let pass = 0; pass < 6; pass++) {
		let pending = 0;
		for (const d of decls) {
			if (d.name in consts) continue;
			try { consts[d.name] = evalExpr(java, d.at, consts).value; }
			catch (e) { if (/unknown constant/.test(String(e.message))) { pending++; continue; } throw e; }
		}
		if (pending === 0) break;
	}
	return consts;
}

// ── ② 极简 DOM 桩：只实现探针用到的那几个 API（选择器：tag / [attr] / [attr="v"] / 逗号并列）─
function parseSelector(sel) {
	return sel.split(',').map((part) => {
		let s = part.trim(), tag = null;
		const attrRe = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g;
		let mm = /^[a-zA-Z][a-zA-Z0-9]*/.exec(s);
		if (mm) { tag = mm[0].toLowerCase(); s = s.slice(mm[0].length); }
		const attrs = [];
		let a;
		while ((a = attrRe.exec(s))) attrs.push([a[1].toLowerCase(), a[2] === undefined ? null : a[2]]);
		return { tag, attrs };
	});
}

function matches(node, sel) {
	return parseSelector(sel).some(({ tag, attrs }) => {
		if (tag && String(node.tagName).toLowerCase() !== tag) return false;
		return attrs.every(([name, val]) => {
			const have = node.attrs[name];
			if (have === undefined) return false;
			return val === null || have === val;
		});
	});
}

function makeNode(spec) {
	const node = {
		nodeType: 1, attrs: {}, childNodes: [], parent: null, visible: true,
		rect: { left: 0, top: 0, width: 100, height: 20 }
	};
	const tag = spec[0], rest = spec.slice(1);
	node.tagName = String(tag).toUpperCase();
	for (const item of rest) {
		if (Array.isArray(item)) { const c = makeNode(item); c.parent = node; node.childNodes.push(c); }
		else if (item && typeof item === 'object') {
			for (const k of Object.keys(item)) {
				if (k === 'rect') node.rect = item[k];
				else if (k === 'visible') node.visible = !!item[k];
				else node.attrs[String(k).toLowerCase()] = String(item[k]);
			}
		} else if (typeof item === 'string') {
			node.childNodes.push({ nodeType: 3, nodeValue: item, parent: node });
		}
	}
	// textContent = 全部后代文字（含 aria-hidden / 不可见）；innerText = **渲染出来的**文字
	Object.defineProperty(node, 'textContent', {
		get: () => node.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('')
	});
	Object.defineProperty(node, 'innerText', {
		get: () => {
			if (!node.visible) return '';
			return node.childNodes
				.map((c) => (c.nodeType === 3 ? c.nodeValue : (c.visible ? c.innerText : ''))).join('');
		}
	});
	node.getAttribute = (n) => (n.toLowerCase() in node.attrs ? node.attrs[n.toLowerCase()] : null);
	node.hasAttribute = (n) => n.toLowerCase() in node.attrs;
	node.getClientRects = () => (node.visible ? [node.rect] : []);
	node.getBoundingClientRect = () => node.rect;
	node.closest = (sel) => {
		let cur = node;
		while (cur) { if (matches(cur, sel)) return cur; cur = cur.parent; }
		return null;
	};
	node.querySelectorAll = (sel) => {
		const out = [];
		const walk = (n) => {
			for (const c of n.childNodes) {
				if (c.nodeType !== 1) continue;
				if (matches(c, sel)) out.push(c);
				walk(c);
			}
		};
		walk(node);
		return out;
	};
	return node;
}

function makeEnv(children) {
	const body = makeNode(['body', ...children]);
	body.parent = null;
	return {
		window: { innerWidth: 411, innerHeight: 800 },
		document: { body, documentElement: makeNode(['html', ['body']]) }
	};
}

// ── ③ 夹具：正例/负例成对（官方结构 = 真；发送/「+」/composer = 假）─────────────
// 官方 q_() 的三点 dots：<span class="dots" aria-hidden="true"><span>.</span>×3</span>
const DOTS_OK = ['span', { class: 'dots', 'aria-hidden': 'true' }, ['span', {}, '.'], ['span', {}, '.'], ['span', {}, '.']];

function offIndicator(phase, ariaLabel, label) {
	return ['button', {
		type: 'button', 'data-phase': phase,
		...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
		class: 'indicator warning'
	},
		['span', { class: 'icon', 'aria-hidden': 'true' }, '⟳'],
		['span', { class: 'label' }, label, DOTS_OK]];
}

const FIXTURES = [
	// 正例
	{ name: 'official-zh-connecting（官方按钮同构：button+span.label+三点 dots）', expect: { re: 1, src: 1 },
		tree: [offIndicator('connecting', '连接中断，正在重试，点击立即重连', '重新连接中')] },
	{ name: 'official-en-connecting（英文词典 Reconnecting）', expect: { re: 1, src: 1 },
		tree: [offIndicator('connecting', 'Reconnecting, reconnect now', 'Reconnecting')] },
	{ name: 'official-zh-无 aria-label（只靠文案锚定）', expect: { re: 1, src: 1 },
		tree: [offIndicator('connecting', null, '重新连接中')] },
	{ name: 'legacy-span（非交互文案旧路径，向后兼容）', expect: { re: 1, src: 2 },
		tree: [['div', {}, ['span', {}, '重新连接中']]] },
	{ name: 'legacy-ellipsis（旧路径 + …）', expect: { re: 1, src: 2 },
		tree: [['p', {}, '重新连接中…']] },
	{ name: 'legacy-en（旧路径英文）', expect: { re: 1, src: 2 },
		tree: [['span', {}, 'Reconnecting...']] },
	{ name: 'mixed（官方按钮与旧路径同时在场 ⇒ 层 1 优先）', expect: { re: 1, src: 1 },
		tree: [['div', {}, ['span', {}, '重新连接中']], offIndicator('connecting', '连接中断，正在重试，点击立即重连', '重新连接中')] },
	// 负例
	{ name: 'NEG 发送按钮（en aria-label）+ data-phase=connecting（只有排除清单挡得住）', expect: { re: 0 },
		tree: [['button', { 'data-phase': 'connecting', 'aria-label': 'Send message' }, '重新连接中']] },
	{ name: 'NEG 发送按钮（zh aria-label）+ data-phase=connecting', expect: { re: 0 },
		tree: [['button', { 'data-phase': 'connecting', 'aria-label': '发送消息' }, '重新连接中']] },
	{ name: 'NEG 「+」按钮（en aria-label）', expect: { re: 0 },
		tree: [['button', { 'aria-label': 'Add files or run commands' }, '重新连接中']] },
	{ name: 'NEG 「+」按钮（zh aria-label）', expect: { re: 0 },
		tree: [['button', { 'aria-label': '添加文件或运行命令' }, '重新连接中']] },
	{ name: 'NEG composer（contenteditable 自己）', expect: { re: 0 },
		tree: [['div', { contenteditable: 'true' }, '重新连接中']] },
	{ name: 'NEG composer（contenteditable 的后代 span）', expect: { re: 0 },
		tree: [['div', { contenteditable: 'true' }, ['span', {}, '重新连接中']]] },
	{ name: 'NEG composer（textbox 祖先）', expect: { re: 0 },
		tree: [['div', { role: 'textbox' }, ['span', {}, '重新连接中']]] },
	{ name: 'NEG 散文（重新连接中，请稍候）', expect: { re: 0 },
		tree: [['p', {}, '重新连接中，请稍候']] },
	{ name: 'NEG data-phase=disconnected（文案是「连接异常，刷新重试」不是「重新连接中」）', expect: { re: 0 },
		tree: [offIndicator('disconnected', '连接异常，点击立即重连', '连接异常，刷新重试')] },
	{ name: 'NEG 按钮内的旧路径文案（层 2 排除交互件后代）', expect: { re: 0 },
		tree: [['button', {}, ['span', {}, '重新连接中']]] },
	{ name: 'NEG 不可见（有布局盒的那条不可见）', expect: { re: 0 },
		tree: [['div', {}, ['span', { visible: false }, '重新连接中']]] },
	{ name: 'NEG 不可见的官方按钮（getClientRects 空）', expect: { re: 0 },
		tree: [['button', { 'data-phase': 'connecting', 'aria-label': '连接中断，正在重试，点击立即重连', visible: false }, '重新连接中']] },
	{ name: 'NEG 普通发送按钮（无 data-phase、aria=Send message）', expect: { re: 0 },
		tree: [['button', { 'aria-label': 'Send message' }, '发送']] },
	{ name: 'NEG 前缀扩展文案（正在重新连接中）', expect: { re: 0 },
		tree: [['span', {}, '正在重新连接中']] }
];

// ── ④ 跑 ────────────────────────────────────────────────────────────────────
const javaPath = process.argv[2];
if (!javaPath) { console.error('usage: node probe-dom-stub.mjs <ReconnectBanner.java>'); process.exit(2); }
const java = fs.readFileSync(javaPath, 'utf8');
const consts = collectConstants(java);
if (!consts.PROBE_JS) { console.error('PROBE_JS not found in ' + javaPath); process.exit(2); }
const PROBE = consts.PROBE_JS;

let checks = 0, failed = 0;
for (const fx of FIXTURES) {
	const env = makeEnv(fx.tree);
	let out;
	try {
		// 探针是表达式（IIFE），在受控的 window/document 上下文里求值 —— 与 WebView 的 evaluateJavascript 同形
		out = new Function('window', 'document', 'return (' + PROBE + ')')(env.window, env.document);
	} catch (e) {
		console.log('not ok ' + fx.name + ' → probe threw: ' + e.message);
		failed++; checks++; continue;
	}
	const ok = out && out.ok === 1 && out.re === fx.expect.re
		&& (fx.expect.src === undefined || out.src === fx.expect.src);
	checks++;
	if (ok) console.log('ok ' + fx.name + ' → ' + JSON.stringify({ re: out.re, src: out.src || 0 }));
	else { failed++; console.log('not ok ' + fx.name + ' → ' + JSON.stringify(out) + ' 期望 ' + JSON.stringify(fx.expect)); }
}

// 只读性再确认（与 JVM 臂 ⑪ 同一批禁词，这里是"真跑一遍探针"之后的第二道）
for (const forbidden of ['appendChild', 'insertBefore', 'setAttribute', 'removeAttribute', 'innerHTML',
	'classList', 'createElement', 'document.write', 'localStorage', 'setTimeout', 'addEventListener']) {
	checks++;
	if (PROBE.includes(forbidden)) { failed++; console.log('not ok probe stays read-only: ' + forbidden); }
	else console.log('ok probe stays read-only: ' + forbidden);
}

console.log('probe DOM-stub arm: ' + (checks - failed) + '/' + checks + ' passed');
process.exit(failed === 0 ? 0 : 1);

'@
Set-Content -Path $harness -Value $harnessJs -Encoding utf8NoBOM
& $node.Source $harness (Join-Path $src 'ReconnectBanner.java')
if ($LASTEXITCODE -ne 0) { throw 'probe DOM-stub arm failed' }
