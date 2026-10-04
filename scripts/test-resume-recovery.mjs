#!/usr/bin/env node
/**
 * T31-3/T31-4 回归：切后台 / 锁屏回来时的连接恢复（页面侧 visibilitychange）。
 *
 * 覆盖（全部在真 Chrome 里跑真实 mobile-web.js，不 mock DOM）：
 *   安装      visibilitychange / pageshow 监听器确实装上了；
 *   不误触发  连接健康（页面无"重连中"文案）⇒ probeResumeRecovery() 派发 0 次 online；
 *   会触发    页面出现 DSH 真实文案「重新连接中...」⇒ 恰好派发 1 次 online；
 *   幂等      15s 内连续探测 5 次 ⇒ 仍只派发 1 次（不会把连接刷成重连风暴）；
 *   文案覆盖  T30 用的 /正在重连|重连中/ 匹配不到"重新连接中..."，这里证明新正则能匹配；
 *   诊断字段  collectUiDiag() 带上 wsState / lastDisconnectAt。
 *
 * 运行：node scripts/test-resume-recovery.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "packages/gateway/assets/mobile-web.js");
const RAW_COPY = join(ROOT, "android/app/src/main/res/raw/mobile.js");

// ---------- 0) 源码契约：字节级同步 + 关键片段存在 ----------

const src = readFileSync(HOOK, "utf8");
const rawCopy = readFileSync(RAW_COPY);
assert.ok(
	readFileSync(HOOK).equals(rawCopy),
	"WEB-02 单一源漂移：res/raw/mobile.js ≠ packages/gateway/assets/mobile-web.js（跑 android/build.ps1 的同步步骤）",
);
assert.ok(src.includes("document.addEventListener('visibilitychange'"), "缺少 visibilitychange 监听");
assert.ok(src.includes("window.addEventListener('pageshow'"), "缺少 pageshow 监听（bfcache 回前台）");
assert.ok(src.includes("function probeResumeRecovery()"), "缺少 probeResumeRecovery");
assert.ok(src.includes("window.dispatchEvent(new Event('online'))"), "缺少 online 派发");
assert.ok(src.includes("重新连接"), "重连文案正则必须覆盖 DSH 真实文案「重新连接中...」");
assert.ok(src.includes("wsState:"), "collectUiDiag 缺少 wsState");
assert.ok(src.includes("lastDisconnectAt:"), "collectUiDiag 缺少 lastDisconnectAt");
// 门禁：必须是「不健康才推」，不能无条件推。
// T38-2 起判据换成 findReconnectStatusElement()，健康分支写成多行复位 + return false，
// 所以**不能再匹配 `if (!reconnecting) return false;` 这个字面量**（那会把可读性锁死成一行）。
// 改为断言同一件事的顺序语义：在 probeResumeRecovery 函数体内，
// 「健康判据 if (!reconnecting)」与「return false」都必须出现在**第一次 dispatchEvent 之前**
// —— 即健康路径一定在任何动作之前返回。
// （不用 \{[^}]*\} 去配对花括号：return false 本身就在花括号**里面**，
//   [^}]* 会把它一起吞掉再去找第二个 return false，永远匹配不上。）
{
	const fnAt = src.indexOf("function probeResumeRecovery() {");
	assert.ok(fnAt >= 0, "缺少 probeResumeRecovery");
	const fnEnd = src.indexOf("\n\tfunction ", fnAt);
	const body = src.slice(fnAt, fnEnd > 0 ? fnEnd : fnAt + 4000);
	const guardAt = body.indexOf("if (!reconnecting)");
	const firstDispatch = body.indexOf("dispatchEvent");
	assert.ok(guardAt >= 0, "probeResumeRecovery 缺少健康判据 if (!reconnecting)");
	assert.ok(
		body.indexOf("return false;", guardAt) >= 0 && body.indexOf("return false;", guardAt) < (firstDispatch < 0 ? body.length : firstDispatch),
		"健康路径必须在任何 online 派发之前 return false（不误触发门禁）",
	);
}
console.log("  ok  源码契约：字节级同步 + visibilitychange/pageshow + 不误触发门禁 + 诊断字段");

// ---------- 浏览器 ----------

function findBrowser() {
	const candidates = [
		join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
		join(process.env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
	];
	return candidates.find((p) => existsSync(p));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };

// 夹具页面：模拟 DSH 外壳（含 __dsh_boot__ 注入点），并把 hook 打进去
const FIXTURE = "/scratch/t31-fixture-resume.html";
// T38-2：健康态页面里**故意**放四种诱饵 —— 它们都会骗过 T31 的裸写法
// （整页 innerText + 不锚定的 /reconnect/i），但都不代表"正在重连"：
//   · 一个真人可点的 <button>Reconnect</button>（是"让你点"，不是"正在重连"）
//   · 正文里一句含 reconnect 的英文散文
//   · 一个叫 reconnect-handler.js 的文件名
//   · 一行终端输出
// 没有这些诱饵，本脚本对"裸 reconnect 误触发"这个缺陷是**盲的**（T38 负控制实测：
// 换回 T31 写法后本脚本仍然 11/11 通过）。加上它们后健康态断言才真正有区分力。
const fixtureHtml = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>resume fixture</title>
<style>html,body{margin:0;height:100%}#app{min-height:100%}</style>
</head><body><div id="app"><div class="frame"><div id="conn">已连接</div>
<button id="reconnectBtn" type="button">Reconnect</button></div>
<section id="bait">
<p id="baitProse">If the socket drops the client will attempt to reconnect automatically after backoff.</p>
<p id="baitFile">reconnect-handler.js</p>
<pre id="baitLog">2026-10-03 12:00:00 [info] reconnect scheduled in 500ms</pre>
</section></div>
<script>
window.__onlineCount = 0;
window.addEventListener('online', function () { window.__onlineCount += 1; });
// 把 body 文案改成 DSH 的重连指示，供测试切换
window.__setConn = function (text) { document.getElementById('conn').textContent = text; };
// T38-2：T31 的旧判据留在这里做对照，证明这些诱饵确实骗得过它
window.__oldPageSaysReconnecting = function () {
	return /重新连接|正在重连|重连中|reconnect/i.test(document.body ? (document.body.innerText || '') : '');
};
</script>
<script src="/packages/gateway/assets/mobile-web.js"></script>
<script>window.__dshBoot && window.__dshBoot();</script>
</body></html>`;

const server = createServer((req, res) => {
	const url = decodeURIComponent((req.url || "/").split("?")[0]);
	if (url === FIXTURE) {
		res.writeHead(200, { "content-type": MIME[".html"] });
		res.end(fixtureHtml);
		return;
	}
	const file = join(ROOT, ...url.replace(/^\//, "").split("/").filter(Boolean));
	if (!file.startsWith(ROOT) || !existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
	res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${String(port)}${FIXTURE}`;

const browser = findBrowser();
if (!browser) {
	server.close();
	throw new Error("未找到 Chrome/Edge");
}

function listenFreePort() {
	return new Promise((r) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => { const { port: p } = s.address(); s.close(() => r(p)); });
	});
}
async function waitForJson(url, timeoutMs) {
	const start = Date.now();
	let lastErr;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return await res.json();
			lastErr = new Error(`HTTP ${res.status}`);
		} catch (err) { lastErr = err; }
		await sleep(120);
	}
	throw lastErr || new Error(`timeout ${url}`);
}

const dbgPort = await listenFreePort();
const profile = mkdtempSync(join(tmpdir(), "dshr-resume-"));
const child = spawn(browser, [
	`--remote-debugging-port=${String(dbgPort)}`,
	`--user-data-dir=${profile}`,
	"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
	"--disable-extensions", "--disable-background-networking", "--disable-sync",
	"--window-size=390,844", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

function cdpCall(ws, id, method, params = {}) {
	return new Promise((res, rej) => {
		const onMessage = (event) => {
			const msg = JSON.parse(String(event.data));
			if (msg.id !== id) return;
			ws.removeEventListener("message", onMessage);
			if (msg.error) rej(new Error(`${method}: ${JSON.stringify(msg.error)}`));
			else res(msg.result);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluate(call, expression) {
	const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
	return r.result && r.result.value;
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
}

try {
	let page = null;
	for (let i = 0; i < 60 && page === null; i++) {
		const list = await waitForJson(`http://127.0.0.1:${String(dbgPort)}/json/list`, 1000).catch(() => []);
		page = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
		if (page === null) await sleep(150);
	}
	if (page === null) throw new Error("没有可用的 page target");

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws"))); });
	let nextId = 1;
	const call = (method, params) => cdpCall(ws, nextId++, method, params);

	await call("Page.enable");
	await call("Runtime.enable");
	await call("Page.navigate", { url: pageUrl });
	await sleep(2500);

	const installed = await evaluate(call, `(function(){
		var a = window.__dshRemoteAndroidMobile;
		return JSON.stringify({
			hook: !!a,
			hasProbe: !!(a && a.probeResumeRecovery),
			hasState: !!(a && a.resumeRecoveryState),
			state: a && a.resumeRecoveryState ? a.resumeRecoveryState() : null,
		});
	})()`);
	const inst = JSON.parse(installed ?? "{}");
	check("hook 已安装并暴露 probeResumeRecovery / resumeRecoveryState", inst.hook === true && inst.hasProbe === true && inst.hasState === true);
	check("resumeRecoveryState 报告 vis=visible、nudges=0", inst.state?.vis === "visible" && inst.state?.nudges === 0, JSON.stringify(inst.state));

	// --- 不误触发：连接健康时一次都不许派发 ---
	await evaluate(call, `window.__setConn('已连接'); window.__onlineCount = 0; true`);
	let healthy = null;
	for (let i = 0; i < 5; i++) {
		healthy = JSON.parse(await evaluate(call, `(function(){
			var a = window.__dshRemoteAndroidMobile;
			var pushed = a.probeResumeRecovery();
			return JSON.stringify({ pushed: pushed, online: window.__onlineCount, st: a.resumeRecoveryState() });
		})()`) ?? "{}");
	}
	check("连接健康：连续 5 次探测全部不派发 online（不误触发）", healthy.online === 0 && healthy.pushed === false, `online=${String(healthy.online)}`);

	// T38-2：证明这一条对"裸 reconnect"缺陷**有区分力**。
	// 页面此刻是健康态，但正文/按钮/文件名/日志里都含 reconnect；
	// T31 的旧判据会说"在重连"，收口后的判据必须说"没有"。
	const bait = JSON.parse(await evaluate(call, `JSON.stringify({
		oldSays: window.__oldPageSaysReconnecting(),
		reconnecting: window.__dshRemoteAndroidMobile.resumeRecoveryState().reconnecting,
	})`) ?? "{}");
	check("健康页含 reconnect 诱饵：旧判据会误判为重连，收口后判据仍判健康",
		bait.oldSays === true && bait.reconnecting === false,
		`oldSays=${String(bait.oldSays)}（诱饵确实骗得过旧写法） reconnecting=${String(bait.reconnecting)}`);

	// 模拟真实的 visibilitychange（visible）路径
	await evaluate(call, `(function(){
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return 'visible'; } });
		document.dispatchEvent(new Event('visibilitychange'));
		return true;
	})()`);
	await sleep(2000);
	const afterVisibility = JSON.parse(await evaluate(call, `JSON.stringify({ online: window.__onlineCount, st: window.__dshRemoteAndroidMobile.resumeRecoveryState() })`) ?? "{}");
	check("health 状态下 visibilitychange(visible) 也不派发", afterVisibility.online === 0, `online=${String(afterVisibility.online)}`);

	// --- 会触发 + 幂等：DSH 真实文案「重新连接中...」 ---
	await evaluate(call, `window.__setConn('重新连接中...'); window.__onlineCount = 0; true`);
	const legacy = await evaluate(call, `JSON.stringify({
		legacy: /正在重连|重连中/.test(document.body.innerText),
		newRe: /重新连接|正在重连|重连中/.test(document.body.innerText),
	})`);
	const legacyProbe = JSON.parse(legacy ?? "{}");
	check("T30 的旧正则匹配不到「重新连接中...」，新正则能匹配", legacyProbe.legacy === false && legacyProbe.newRe === true);

	let nudges = [];
	for (let i = 0; i < 5; i++) {
		nudges.push(JSON.parse(await evaluate(call, `(function(){
			var a = window.__dshRemoteAndroidMobile;
			var pushed = a.probeResumeRecovery();
			return JSON.stringify({ pushed: pushed, online: window.__onlineCount });
		})()`) ?? "{}"));
	}
	const totalOnline = nudges[nudges.length - 1].online;
	const pushedCount = nudges.filter((n) => n.pushed).length;
	check("重连中文案下恰好派发 1 次 online", totalOnline === 1 && pushedCount === 1, `online=${String(totalOnline)} pushed=${String(pushedCount)}`);
	check("15s 内连探 5 次仍然幂等（不刷重连风暴）", totalOnline === 1, `online=${String(totalOnline)}`);

	const diag = JSON.parse(await evaluate(call, `JSON.stringify(window.__dshrMobileDiag())`) ?? "{}");
	check("诊断载荷含 wsState / lastDisconnectAt", typeof diag.wsState === "string" && typeof diag.lastDisconnectAt === "number", `wsState=${String(diag.wsState)} lastDisconnectAt=${String(diag.lastDisconnectAt)}`);
	check("观测到重连后 lastDisconnectAt 已被记录", diag.lastDisconnectAt > 0, String(diag.lastDisconnectAt));
	check("wsState 反映当前处于重连态", diag.wsState === "reconnecting", String(diag.wsState));

	await evaluate(call, `window.__setConn('已连接'); true`);
	await sleep(1500);
	const diag2 = JSON.parse(await evaluate(call, `JSON.stringify(window.__dshrMobileDiag())`) ?? "{}");
	check("恢复正常后 wsState 变为 ok-recovered", diag2.wsState === "ok-recovered", String(diag2.wsState));
} finally {
	try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
	server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
	for (const f of failed) console.error(`FAIL ${f.name} ${f.detail}`);
	process.exit(1);
}
process.exit(0);
