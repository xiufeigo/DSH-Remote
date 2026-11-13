#!/usr/bin/env node
/**
 * Android 壳官方界面：chrome:false 关掉自有抽屉，跟手计划只决定官方面板开合。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(root, "packages/gateway/assets/mobile-web.js"), "utf8");
const raw = readFileSync(join(root, "android/app/src/main/res/raw/mobile.js"));
const java = readFileSync(join(root, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");

assert.equal(raw.equals(Buffer.from(hook)), true, "res/raw/mobile.js 必须与 mobile-web.js 字节相同");
assert.match(java, /chrome:false/, "Android 注入必须写 chrome:false");
assert.match(java, /__dshrOfficialHost===true/, "自检必须认官方接线，而不是悬浮鲸鱼");
assert.match(hook, /function officialAndroidShell\(\)/);
assert.match(hook, /if \(officialAndroidShell\(\)\) return false;/);
assert.match(hook, /\[data-sidebar-opener\]/);
assert.match(hook, /\[data-sidebar-right-expand\]/);
assert.match(hook, /startX >= width - edge/);
assert.match(hook, /data-plugin-panel/);
assert.match(hook, /function dismissOfficialShellSubpage/);
assert.match(
	hook.slice(hook.indexOf("closeSidebarIfExpanded: function"), hook.indexOf("openSidebarIfCollapsed")),
	/if \(isOfficialShellSubpage\(\)\) return dismissOfficialShellSubpage\(\);[\s\S]*if \(isSidebarOpen\(\) \|\| toggleBusy\)/,
	"插件等全页必须先于收左栏处理，避免返回键先把侧栏关掉再退桌面",
);
assert.doesNotMatch(
	hook.slice(hook.indexOf("function dismissOfficialShellSubpage"), hook.indexOf("function officialGesturePlan")),
	/data-sidebar-opener/,
	"离开插件页不得先点开左侧栏",
);
assert.match(hook, /function findSessionReturnTarget/);
assert.match(hook, /\[data-sidebar-right-panel="fullscreen"\]\[data-sidebar-right-open\]/);
assert.match(hook, /\[data-sidebar-right-panel="fullscreen"\]:not\(\[data-sidebar-right-open\]\)/);
assert.match(hook, /div:has\(> \[data-sidebar-right-panel="push"\]\)/);
assert.doesNotMatch(
	hook.slice(hook.indexOf("function installOfficialDrawerGestures"), hook.indexOf("function installOfficialHost")),
	/dshr-mobile-whale|createElement\(|data-dockkit-host|rightPieces/,
	"跟手接线不得创建节点，也不得自己平移右栏 dock",
);

function extract(name) {
	const at = hook.indexOf(`function ${name}(`);
	assert.ok(at > 0, name);
	let i = hook.indexOf("{", at);
	let depth = 0;
	for (; i < hook.length; i++) {
		if (hook[i] === "{") depth += 1;
		else if (hook[i] === "}") {
			depth -= 1;
			if (depth === 0) return hook.slice(at, i + 1);
		}
	}
	throw new Error("unclosed " + name);
}

const context = {};
vm.createContext(context);
vm.runInContext(extract("officialGesturePlan"), context);
const plan = context.officialGesturePlan;

assert.equal(plan({ dx: 8, dy: 0, leftWidth: 280, rightWidth: 320 }), null);
assert.equal(plan({ dx: 40, dy: 40, leftWidth: 280, rightWidth: 320 }), null);
assert.equal(plan({ dx: 200, dy: 0, blocked: true, leftWidth: 280, rightWidth: 320 }), null);

const openLeft = plan({ dx: 200, dy: 4, leftWidth: 280, rightWidth: 320, leftOpen: false, rightOpen: false });
assert.equal(openLeft.side, "left");
assert.equal(openLeft.open, true);
assert.equal(openLeft.toggle, true);

const peekLeft = plan({ dx: 40, dy: 0, leftWidth: 280, rightWidth: 320 });
assert.equal(peekLeft.side, "left");
assert.equal(peekLeft.open, false);
assert.equal(peekLeft.toggle, false);

const closeLeft = plan({ dx: -200, dy: 0, leftWidth: 280, rightWidth: 320, leftOpen: true });
assert.equal(closeLeft.side, "left");
assert.equal(closeLeft.open, false);
assert.equal(closeLeft.toggle, true);
assert.equal(plan({ dx: 80, dy: 0, leftWidth: 280, rightWidth: 320, leftOpen: true }), null);

const openRight = plan({ dx: -80, dy: 0, leftWidth: 280, startX: 360, width: 390 });
assert.equal(openRight.side, "right");
assert.equal(openRight.open, true);
assert.equal(openRight.toggle, true);
assert.equal(plan({ dx: -200, dy: 0, leftWidth: 280, startX: 200, width: 390 }), null, "屏幕中间左滑不得打开右栏");
assert.equal(plan({ dx: -20, dy: 0, leftWidth: 280, startX: 360, width: 390 }), null, "左滑太短不打开右栏");
assert.equal(plan({ dx: 200, dy: 0, leftWidth: 280, rightWidth: 320, rightOpen: true }), null, "右栏开着时不代关，交给官方");
assert.equal(plan({ dx: -80, dy: 0, leftWidth: 280, startX: 360, width: 390, rightOpen: true }), null);

const picker = readFileSync(join(root, "android/app/src/main/res/raw/server_picker.js"), "utf8");
assert.match(picker, /dshr-server-picker/);
assert.match(java, /syncServerPicker\(view\)/);
assert.match(picker, /data-window-drag/);

const fixture = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 390px; height: 844px; overflow: hidden; }
  #frame { position: relative; width: 390px; height: 844px; }
  #col { position: absolute; left: 0; top: 0; width: 280px; height: 100%; background: #ddd; }
  #frame[data-sidebar-collapsed] #col { transform: translateX(-100%); visibility: hidden; }
  #mask { position: absolute; inset: 0; background: rgba(0,0,0,.35); opacity: 0; }
  #right { position: absolute; top: 0; right: 0; width: 320px; height: 100%; --dsh-sidebar-width: 320px; }
  #dock { width: 320px; height: 100%; background: #eef; transform: translateX(320px); }
  #composer { position: absolute; left: 16px; top: 760px; width: 340px; height: 48px; }
</style>
</head>
<body>
<script>
window.__DSHR_MOBILE__ = { device: 'phone', chrome: false };
window.__clicks = { opener: 0, toggle: 0, expand: 0, collapse: 0 };
</script>
<div id="frame" data-sidebar-drawer data-sidebar-collapsed>
  <div id="col" data-shortcut-modal="sidebar">
    <div data-slot="sidebar" data-window-drag="true">brand</div>
    <button id="toggle" data-sidebar-toggle type="button">collapse</button>
  </div>
  <div id="mask" data-sidebar-mask></div>
  <div data-shell-leading><button id="opener" data-sidebar-opener type="button">open</button></div>
  <main data-slot="main">session</main>
</div>
<aside id="right" data-sidebar-right-panel>
  <div id="dock" data-dockkit-host="dock">dock</div>
  <button id="expand" data-sidebar-right-expand type="button">expand</button>
  <button id="collapse" data-sidebar-right-toggle type="button">collapse-right</button>
</aside>
<textarea id="composer"></textarea>
<script>
document.getElementById('opener').onclick = function () {
  window.__clicks.opener += 1;
  document.getElementById('frame').removeAttribute('data-sidebar-collapsed');
};
document.getElementById('toggle').onclick = function () {
  window.__clicks.toggle += 1;
  document.getElementById('frame').setAttribute('data-sidebar-collapsed', '');
};
document.getElementById('expand').onclick = function () {
  window.__clicks.expand += 1;
  document.getElementById('right').setAttribute('data-sidebar-right-open', '');
};
document.getElementById('collapse').onclick = function () {
  window.__clicks.collapse += 1;
  document.getElementById('right').removeAttribute('data-sidebar-right-open');
};
</script>
<script src="/packages/gateway/assets/mobile-web.js"></script>
</body>
</html>`;

/**
 * PERF-05/06 流式夹具：30 轮问答 + 一个可追加 token 的 live 气泡。
 * mode=android 走官方壳观察器路径（installOfficialHost），mode=web 走普通
 * 移动 hook 路径；bridge=1 时补一个原生桥接收 setSessionNotice。
 * 探针统计：gbcr（强制布局读取）、qsa（全文档 querySelectorAll）、
 * noticeScans（通知链路特有的 DOM 扫描：'停止生成' 探测与 'div, p' 全量扫）。
 */
function streamFixture(mode, bridge) {
	const mobileCfg = mode === "android" ? "{ device: 'phone', chrome: false }" : "{ breakpoint: 980 }";
	const bridgeJs = bridge
		? "window.DshRemoteApp = { setSessionNotice: function (title, text, running) { window.__notices.push([title, text, running]); } };\n"
		: "";
	let turns = "";
	for (let i = 1; i <= 30; i++) {
		// 用户气泡按官方 0.2.2 真实结构造：userRow > userStack > [data-message-bubble]。
		turns += `<div class="turn"><div class="userRow"><div class="userStack"><div data-message-bubble=""><p>question ${String(i)}</p></div></div></div></div>`
			+ `<div class="turn"><div class="msg"><p>answer ${String(i)}</p></div><div data-turn-tail><button type="button" aria-label="Copy">c</button></div></div>`;
	}
	// 探针：隐藏容器与输入区里的同名标记不得被当成最新用户消息。
	turns += `<div hidden><div data-message-bubble=""><p>hidden draft</p></div></div>`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%}#frame{position:relative;height:100vh}#col{position:absolute;left:0;top:0;width:280px;height:100%}#frame[data-sidebar-collapsed] #col{transform:translateX(-100%);visibility:hidden}main{height:100vh;overflow:auto}</style></head>
<body>
<script>
window.__DSHR_MOBILE__ = ${mobileCfg};
window.__notices = []; window.__rowClicks = [];
${bridgeJs}window.__spy = { gbcr: 0, qsa: 0, noticeScans: 0 };
(function () {
  var gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { window.__spy.gbcr += 1; return gbcr.apply(this, arguments); };
  var dqsa = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function () { window.__spy.qsa += 1; return dqsa.apply(this, arguments); };
  var eqsa = Element.prototype.querySelectorAll;
  Element.prototype.querySelectorAll = function (sel) { if (sel === 'div, p') window.__spy.noticeScans += 1; return eqsa.apply(this, arguments); };
  var dqs = Document.prototype.querySelector;
  Document.prototype.querySelector = function (sel) { if (String(sel).indexOf('停止生成') >= 0) window.__spy.noticeScans += 1; return dqs.apply(this, arguments); };
})();
</script>
<div id="frame" data-sidebar-drawer data-sidebar-collapsed>
  <div id="col" data-shortcut-modal="sidebar"><div data-slot="sidebar">
    <div role="treeitem" data-row-key="session:a" aria-current="page" onclick="window.__rowClicks.push('session:a')">Alpha</div>
    <div role="treeitem" data-row-key="session:b" onclick="window.__rowClicks.push('session:b')">Beta</div>
  </div><button data-sidebar-toggle aria-label="收起侧边栏" type="button">x</button></div>
  <div data-sidebar-mask></div>
  <main data-slot="main" id="main">
    <header data-slot="conversation.header"><span id="title">Alpha</span></header>
    <div id="list">
      ${turns}
      <div class="turn"><div class="msg" id="live"><p></p></div></div>
    </div>
    <div data-composer-seat><div data-composer-card><div data-message-bubble=""><p>queued preview</p></div><textarea></textarea><button type="button" aria-label="停止生成">stop</button></div></div>
  </main>
</div>
<script>
window.__stream = function (ticks) { return new Promise(function (done) {
  var p = document.getElementById('live').lastElementChild, i = 0, ch = new MessageChannel();
  ch.port1.onmessage = function () {
    if (i >= ticks) { done(i); return; }
    i += 1; var s = document.createElement('span'); s.textContent = 'tok' + i + ' '; p.appendChild(s);
    ch.port2.postMessage(0);
  };
  ch.port2.postMessage(0);
}); };
</script>
<script src="/packages/gateway/assets/mobile-web.js"></script>
</body></html>`;
}

function findBrowser() {
	const candidates = [
		process.env.CHROME_PATH || "",
		join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
		"/usr/local/bin/google-chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	];
	return candidates.find((p) => p && existsSync(p));
}

const browser = findBrowser();
assert.ok(browser, "需要本机 Chrome 才能验证官方抽屉跟手");

const server = createServer((req, res) => {
	const url = (req.url || "/").split("?")[0];
	if (url === "/fixture") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(fixture);
		return;
	}
	if (url === "/fixture-stream") {
		const params = new URL(req.url || "/", "http://fixture.local").searchParams;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(streamFixture(params.get("mode"), params.get("bridge") === "1"));
		return;
	}
	if (url === "/packages/gateway/assets/mobile-web.js") {
		res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
		res.end(hook);
		return;
	}
	res.writeHead(404).end("missing");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const profile = mkdtempSync(join(tmpdir(), "dshr-official-"));
const dbg = await new Promise((resolve) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1", () => {
		const p = probe.address().port;
		probe.close(() => resolve(p));
	});
});
const child = spawn(browser, [
	`--remote-debugging-port=${dbg}`,
	`--user-data-dir=${profile}`,
	"--user-agent=Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 DSHRemoteAndroid/0.2.0",
	"--headless=new",
	"--disable-gpu",
	"--no-first-run",
	"--window-size=390,844",
	"about:blank",
], { stdio: "ignore" });

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

try {
	let page;
	const start = Date.now();
	while (Date.now() - start < 8000) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
			page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
			if (page) break;
		} catch { /* debugger not up yet */ }
		await wait(120);
	}
	assert.ok(page, "没有 Chrome page target");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve);
		ws.addEventListener("error", () => reject(new Error("page websocket 失败")));
	});
	let id = 0;
	const call = (method, params = {}) => new Promise((resolve, reject) => {
		const msgId = ++id;
		const onMessage = (event) => {
			const msg = JSON.parse(String(event.data));
			if (msg.id !== msgId) return;
			ws.removeEventListener("message", onMessage);
			if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
			else resolve(msg.result);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id: msgId, method, params }));
	});
	const evaluate = async (expression) => {
		const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await call("Emulation.setUserAgentOverride", {
		userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 DSHRemoteAndroid/0.2.0",
	});
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Page.navigate", { url: `http://127.0.0.1:${port}/fixture` });
	await wait(600);
	const host = await evaluate(`({
		official: window.__dshrOfficialHost === true,
		gestures: window.__dshrOfficialGestures === true,
		whale: !!document.getElementById('dshr-mobile-whale'),
		mask: !!document.getElementById('dshr-mobile-drawer-mask'),
		handle: !!document.getElementById('dshr-drawer-handle'),
		klass: document.documentElement.className,
	})`);
	assert.equal(host.official, true, JSON.stringify(host));
	assert.equal(host.gestures, true);
	assert.equal(host.whale, false);
	assert.equal(host.mask, false);
	assert.equal(host.handle, false);
	assert.equal(host.klass.includes("dshr-mobile"), false);

	const closedCover = await evaluate(`(() => {
		const el = document.getElementById("right");
		el.setAttribute("data-sidebar-right-panel", "fullscreen");
		el.removeAttribute("data-sidebar-right-open");
		document.documentElement.style.setProperty("--dshr-inset-top", "24px");
		const cs = getComputedStyle(el);
		return { bg: cs.backgroundColor, padTop: cs.paddingTop };
	})()`);
	assert.equal(closedCover.bg, "rgba(0, 0, 0, 0)", "关闭的全屏右侧栏不能铺底，否则会话被盖成空白: " + JSON.stringify(closedCover));
	assert.equal(closedCover.padTop, "0px", "关闭的全屏右侧栏不能垫状态栏，否则会挤开看不见的遮罩: " + JSON.stringify(closedCover));

	const openCover = await evaluate(`(() => {
		const el = document.getElementById("right");
		el.setAttribute("data-sidebar-right-panel", "fullscreen");
		el.setAttribute("data-sidebar-right-open", "");
		const cs = getComputedStyle(el);
		const out = { bg: cs.backgroundColor, padTop: cs.paddingTop };
		el.removeAttribute("data-sidebar-right-open");
		el.setAttribute("data-sidebar-right-panel", "");
		document.documentElement.style.removeProperty("--dshr-inset-top");
		return out;
	})()`);
	assert.notEqual(openCover.bg, "rgba(0, 0, 0, 0)", "打开的全屏右侧栏仍要铺底让位: " + JSON.stringify(openCover));
	assert.equal(openCover.padTop, "24px", "打开的全屏右侧栏仍要垫状态栏: " + JSON.stringify(openCover));

	const touch = (type, x, y) => call("Input.dispatchTouchEvent", {
		type, touchPoints: type === "touchEnd" ? [] : [{ x, y }],
	});
	async function drag(from, to, y) {
		await touch("touchStart", from, y);
		for (let i = 1; i <= 8; i++) {
			await touch("touchMove", from + (to - from) * i / 8, y);
			await wait(16);
		}
	}
	await drag(40, 220, 400);
	const mid = await evaluate("document.getElementById('col').style.transform");
	const percent = Number(String(mid).match(/translateX\(([-\d.]+)%\)/)?.[1]);
	assert.ok(percent > -80 && percent < -20, `跟手中列位移应停在半开附近，实际 ${mid}`);
	await touch("touchEnd");
	await wait(900);
	const opened = await evaluate(`({
		collapsed: document.getElementById('frame').hasAttribute('data-sidebar-collapsed'),
		transform: document.getElementById('col').style.transform,
		clicks: window.__clicks,
	})`);
	assert.equal(opened.collapsed, false, JSON.stringify(opened));
	assert.equal(opened.transform, "");
	assert.equal(opened.clicks.opener, 1);
	assert.equal(opened.clicks.toggle, 0);

	await drag(320, 40, 400);
	await touch("touchEnd");
	await wait(900);
	const closed = await evaluate(`({
		collapsed: document.getElementById('frame').hasAttribute('data-sidebar-collapsed'),
		clicks: window.__clicks,
	})`);
	assert.equal(closed.collapsed, true, JSON.stringify(closed));
	assert.equal(closed.clicks.toggle, 1);
	assert.equal(closed.clicks.opener, 1);

	await drag(200, 40, 280);
	await touch("touchEnd");
	await wait(200);
	const fromMiddle = await evaluate("window.__clicks");
	assert.equal(fromMiddle.expand, 0, "屏幕中间左滑不得打开右栏: " + JSON.stringify(fromMiddle));

	const vw = await evaluate("window.innerWidth");
	await drag(Math.max(8, vw - 8), 40, 280);
	const rightMid = await evaluate("document.getElementById('dock').style.transform");
	assert.equal(String(rightMid), "", `左滑过程不得自己平移右栏：${rightMid}`);
	await touch("touchEnd");
	await wait(400);
	const rightOpen = await evaluate(`({
		open: document.getElementById('right').hasAttribute('data-sidebar-right-open'),
		transform: document.getElementById('dock').style.transform,
		clicks: window.__clicks,
	})`);
	assert.equal(rightOpen.open, true, JSON.stringify(rightOpen));
	assert.equal(rightOpen.transform, "");
	assert.equal(rightOpen.clicks.expand, 1);
	assert.equal(rightOpen.clicks.collapse, 0);

	await drag(40, 300, 280);
	await touch("touchEnd");
	await wait(400);
	const rightStillOpen = await evaluate(`({
		open: document.getElementById('right').hasAttribute('data-sidebar-right-open'),
		clicks: window.__clicks,
	})`);
	assert.equal(rightStillOpen.open, true, JSON.stringify(rightStillOpen));
	assert.equal(rightStillOpen.clicks.collapse, 0, "收回右栏不得走自制手势");
	assert.equal(rightStillOpen.clicks.expand, 1);

	const beforeComposer = await evaluate("JSON.stringify(window.__clicks)");
	await drag(30, 250, 780);
	await touch("touchEnd");
	await wait(200);
	const afterComposer = await evaluate(`({
		clicks: JSON.stringify(window.__clicks),
		collapsed: document.getElementById('frame').hasAttribute('data-sidebar-collapsed'),
		transform: document.getElementById('col').style.transform,
	})`);
	assert.equal(afterComposer.clicks, beforeComposer);
	assert.equal(afterComposer.collapsed, true);
	assert.equal(afterComposer.transform, "");

	// ---- PERF-05：官方壳观察器按批合并，不逐次提交做布局读取/全文档扫描 ----
	await call("Page.navigate", { url: `http://127.0.0.1:${port}/fixture-stream?mode=android` });
	await wait(600);
	assert.equal(await evaluate("window.__dshrOfficialHost === true"), true, "官方壳观察器应已安装");
	await wait(500);
	const streamCost = await evaluate(`(async () => {
		window.__spy.gbcr = 0; window.__spy.qsa = 0;
		await window.__stream(200);
		return { gbcr: window.__spy.gbcr, qsa: window.__spy.qsa };
	})()`);
	assert.ok(streamCost.gbcr <= 10, `官方壳观察器不得逐次提交做布局读取/全文档扫描：gbcr=${String(streamCost.gbcr)} qsa=${String(streamCost.qsa)}`);
	assert.ok(streamCost.qsa <= 20, `官方壳观察器不得逐次提交做布局读取/全文档扫描：gbcr=${String(streamCost.gbcr)} qsa=${String(streamCost.qsa)}`);
	await wait(500);
	const tailGbcr = await evaluate("window.__spy.gbcr");
	assert.ok(tailGbcr >= 1, `尾沿同步必须仍然发生：gbcr=${String(tailGbcr)}`);
	assert.ok(tailGbcr <= 12, `尾沿同步不应放大布局读取：gbcr=${String(tailGbcr)}`);

	// ---- PERF-05 护栏：主题属性翻转仍当场同步（状态栏配色不能迟到）----
	await evaluate(`document.body.setAttribute('data-ds-dark-theme','')`);
	assert.equal(await evaluate(`document.documentElement.getAttribute('data-dshr-dark')`), "1", "主题翻转必须当场同步");
	await evaluate(`document.body.removeAttribute('data-ds-dark-theme')`);
	assert.equal(await evaluate(`document.documentElement.getAttribute('data-dshr-dark')`), "0", "主题翻转恢复必须当场同步");

	// ---- PERF-05 护栏：合并后仍能记住最近会话行（无点击路径）----
	await evaluate(`(() => {
		const a = document.querySelector('[data-row-key="session:a"]');
		const b = document.querySelector('[data-row-key="session:b"]');
		a.removeAttribute('aria-current');
		b.setAttribute('aria-current', 'page');
		document.getElementById('title').textContent = 'Beta';
	})()`);
	await wait(500);
	const subpageClosed = await evaluate(`(() => {
		document.getElementById('main').style.display = 'none';
		const p = document.createElement('div');
		p.setAttribute('data-plugin-panel', '');
		p.textContent = 'plugin';
		document.body.appendChild(p);
		return window.__dshRemoteAndroidMobile.closeSidebarIfExpanded();
	})()`);
	assert.equal(subpageClosed, true, "插件子页应走会话行回退路径");
	assert.deepEqual(await evaluate("window.__rowClicks"), ["session:b"], "应点击记住的 session:b 行");

	// ---- 通知正文：官方壳没有 [data-dshr-main-col]，必须按官方语义标记
	// [data-message-bubble] 取最后一条可见用户气泡（rc.2.26 起恒为「正在生成…」）----
	await call("Page.navigate", { url: `http://127.0.0.1:${port}/fixture-stream?mode=android&bridge=1` });
	await wait(800);
	assert.equal(await evaluate("window.__dshrOfficialHost === true"), true, "官方壳观察器应已安装");
	assert.equal(await evaluate("!!document.querySelector('[data-dshr-main-col]')"), false, "官方壳下不得有主列标记");
	await evaluate("window.__stream(30)");
	await wait(2600);
	const androidNotices = await evaluate("window.__notices");
	assert.ok(androidNotices.length >= 1, "官方壳有桥时通知照常上报: " + JSON.stringify(androidNotices));
	const androidLast = androidNotices[androidNotices.length - 1];
	assert.equal(androidLast[2], true, "应上报 running=true 的通知: " + JSON.stringify(androidLast));
	assert.equal(androidLast[1], "question 30",
		"通知正文应取最后一条可见用户气泡（隐藏/输入区标记不计）: " + JSON.stringify(androidLast));
	await evaluate("document.querySelectorAll('[data-message-bubble]').forEach((el) => el.remove())");
	await evaluate("window.__stream(5)");
	await wait(2600);
	const androidFallback = (await evaluate("window.__notices")).pop();
	assert.equal(androidFallback[1], "正在生成…", "没有用户气泡时仍回退占位文案: " + JSON.stringify(androidFallback));

	// ---- PERF-06：没有原生桥时不得为通知扫描 DOM；有桥照常上报 ----
	await call("Emulation.setUserAgentOverride", {
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	});
	await call("Page.navigate", { url: `http://127.0.0.1:${port}/fixture-stream?mode=web` });
	await wait(800);
	assert.equal(await evaluate(`document.documentElement.classList.contains('dshr-mobile')`), true, "浏览器模式手机档 hook 应生效");
	await evaluate("window.__spy.noticeScans = 0");
	await evaluate("window.__stream(50)");
	await wait(2600);
	assert.equal(await evaluate("window.__spy.noticeScans"), 0, "没有原生桥时不得为通知扫描 DOM");

	await call("Page.navigate", { url: `http://127.0.0.1:${port}/fixture-stream?mode=web&bridge=1` });
	await wait(800);
	await evaluate("window.__stream(50)");
	await wait(2600);
	const notices = await evaluate("window.__notices");
	assert.ok(notices.length >= 1, "有桥时通知照常上报");
	assert.ok(notices.some((n) => n[2] === true), "有桥时应上报 running=true 的通知");
	assert.equal(notices[notices.length - 1][1], "question 30", "浏览器档通知正文同样取最后一条用户气泡");
	ws.close();
} finally {
	child.kill("SIGKILL");
	server.close();
}

console.log("official shell tests passed");
