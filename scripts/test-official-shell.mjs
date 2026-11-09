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
import { inflateSync } from "node:zlib";
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
assert.match(
	hook,
	/\[data-sidebar-right-panel="fullscreen"\]:not\(\[data-sidebar-right-open\]\)/,
	"收起的 fullscreen 右栏不得再铺不透明底",
);
assert.doesNotMatch(
	hook.slice(hook.indexOf("function installOfficialDrawerGestures"), hook.indexOf("function installOfficialHost")),
	/dshr-mobile-whale|createElement\(/,
	"跟手接线不得创建鲸鱼或任何节点",
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

const openRight = plan({ dx: -200, dy: 0, leftWidth: 280, rightWidth: 320 });
assert.equal(openRight.side, "right");
assert.equal(openRight.open, true);
assert.equal(openRight.toggle, true);

const closeRight = plan({ dx: 200, dy: 0, leftWidth: 280, rightWidth: 320, rightOpen: true });
assert.equal(closeRight.side, "right");
assert.equal(closeRight.open, false);
assert.equal(closeRight.toggle, true);
assert.equal(plan({ dx: -80, dy: 0, leftWidth: 280, rightWidth: 320, rightOpen: true }), null);

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

const transcript = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #fff; }
  #frame {
    position: relative; display: grid;
    grid-template-columns: 0px minmax(0, 1fr) minmax(0, 0px);
    width: 390px; height: 844px; overflow: clip;
  }
  #center { grid-column: 2; grid-row: 1; position: relative; min-width: 0; }
  #tab { position: relative; z-index: 1; height: 48px; }
  #msg { height: 72px; margin: 16px; background: #1a7f37; color: #fff; }
  #composer { position: relative; z-index: 9; height: 64px; margin: 16px; background: #f3f3f3; }
  #rightcol { grid-column: 3; grid-row: 1; position: relative; overflow: visible; }
  #panel {
    position: absolute; top: 0; right: 0; bottom: 0; width: 100vw;
    pointer-events: none; --dsh-sidebar-width: 100vw;
  }
  #dock { height: 100%; background: #d6e4ff; transform: translateX(100vw); visibility: hidden; }
</style>
</head>
<body>
<script>
window.__DSHR_MOBILE__ = { device: 'phone', chrome: false };
document.documentElement.style.setProperty('--dshr-inset-top', '47px');
document.documentElement.style.setProperty('--dshr-inset-bottom', '34px');
document.documentElement.style.setProperty('--dshr-inset-left', '0px');
document.documentElement.style.setProperty('--dshr-inset-right', '0px');
</script>
<div id="frame" data-sidebar-drawer data-sidebar-collapsed>
  <div id="center">
    <div id="tab" data-slot="header">对话</div>
    <div id="msg">可见消息</div>
    <div id="composer" data-composer-seat>发消息或创建任务</div>
  </div>
  <div id="rightcol">
    <div id="panel" data-sidebar-right-panel="fullscreen" aria-hidden="true">
      <div id="dock" data-dockkit-host="dock">dock</div>
    </div>
  </div>
</div>
<script src="/packages/gateway/assets/mobile-web.js"></script>
</body>
</html>`;

function pngPixel(buf, x, y) {
	let offset = 8;
	let width = 0;
	let height = 0;
	let color = 0;
	const idats = [];
	while (offset + 8 <= buf.length) {
		const len = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			color = data[9];
		} else if (type === "IDAT") idats.push(data);
		else if (type === "IEND") break;
		offset += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idats));
	const bpp = color === 6 ? 4 : 3;
	const stride = width * bpp;
	let cursor = 0;
	let prev = null;
	const row = Buffer.alloc(stride);
	const targetY = Math.max(0, Math.min(height - 1, y));
	for (let py = 0; py <= targetY; py++) {
		const filter = raw[cursor++];
		for (let i = 0; i < stride; i++) {
			const value = raw[cursor++];
			const left = i >= bpp ? row[i - bpp] : 0;
			const up = prev ? prev[i] : 0;
			const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
			let out = value;
			if (filter === 1) out = value + left;
			else if (filter === 2) out = value + up;
			else if (filter === 3) out = value + Math.floor((left + up) / 2);
			else if (filter === 4) {
				const guess = left + up - upLeft;
				const pa = Math.abs(guess - left);
				const pb = Math.abs(guess - up);
				const pc = Math.abs(guess - upLeft);
				const pick = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				out = value + pick;
			}
			row[i] = out & 255;
		}
		prev = Buffer.from(row);
	}
	const px = Math.max(0, Math.min(width - 1, x));
	const i = px * bpp;
	return { r: row[i], g: row[i + 1], b: row[i + 2], width, height };
}

function findBrowser() {
	const candidates = [
		process.env.CHROME_PATH || "",
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
	if (url === "/transcript") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(transcript);
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

	await drag(300, 40, 280);
	const rightMid = await evaluate("document.getElementById('dock').style.transform");
	assert.match(String(rightMid), /translateX\(/, `右栏跟手缺失：${rightMid}`);
	await touch("touchEnd");
	await wait(900);
	const rightOpen = await evaluate(`({
		open: document.getElementById('right').hasAttribute('data-sidebar-right-open'),
		transform: document.getElementById('dock').style.transform,
		clicks: window.__clicks,
	})`);
	assert.equal(rightOpen.open, true, JSON.stringify(rightOpen));
	assert.equal(rightOpen.transform, "");
	assert.equal(rightOpen.clicks.expand, 1);

	await drag(40, 300, 280);
	await touch("touchEnd");
	await wait(900);
	const rightClosed = await evaluate(`({
		open: document.getElementById('right').hasAttribute('data-sidebar-right-open'),
		clicks: window.__clicks,
	})`);
	assert.equal(rightClosed.open, false, JSON.stringify(rightClosed));
	assert.equal(rightClosed.clicks.collapse, 1);

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

	await call("Page.navigate", { url: `http://127.0.0.1:${port}/transcript` });
	await wait(600);
	const closedSample = await evaluate(`(() => {
		const msg = document.getElementById('msg').getBoundingClientRect();
		const panel = document.getElementById('panel');
		return {
			x: msg.x + msg.width / 2,
			y: msg.y + msg.height / 2,
			bg: getComputedStyle(panel).backgroundColor,
			open: panel.hasAttribute('data-sidebar-right-open'),
			official: window.__dshrOfficialHost === true,
			whale: !!document.getElementById('dshr-mobile-whale'),
			w: window.innerWidth,
			h: window.innerHeight,
		};
	})()`);
	assert.equal(closedSample.official, true, JSON.stringify(closedSample));
	assert.equal(closedSample.whale, false);
	assert.equal(closedSample.open, false);
	assert.equal(closedSample.bg, "rgba(0, 0, 0, 0)", JSON.stringify(closedSample));
	const closedShot = Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64");
	const closedSize = { width: closedShot.readUInt32BE(16), height: closedShot.readUInt32BE(20) };
	const closedPixel = pngPixel(
		closedShot,
		Math.round(closedSample.x * closedSize.width / closedSample.w),
		Math.round(closedSample.y * closedSize.height / closedSample.h),
	);
	assert.ok(
		closedPixel.g > 90 && closedPixel.r < 80 && closedPixel.b < 100,
		`收起右栏不应盖住消息，像素 ${JSON.stringify(closedPixel)} @ ${closedSize.width}x${closedSize.height}`,
	);

	await evaluate("document.getElementById('panel').setAttribute('data-sidebar-right-open','')");
	const openBg = await evaluate("getComputedStyle(document.getElementById('panel')).backgroundColor");
	assert.equal(openBg, "rgb(255, 255, 255)", openBg);
	const openShot = Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64");
	const openPixel = pngPixel(
		openShot,
		Math.round(closedSample.x * closedSize.width / closedSample.w),
		Math.round(closedSample.y * closedSize.height / closedSample.h),
	);
	assert.ok(
		openPixel.r > 240 && openPixel.g > 240 && openPixel.b > 240,
		`打开的右栏仍应铺底盖住消息，像素 ${JSON.stringify(openPixel)}`,
	);
	ws.close();
} finally {
	child.kill("SIGKILL");
	server.close();
}

console.log("official shell tests passed");
