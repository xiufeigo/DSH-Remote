#!/usr/bin/env node
/**
 * 手机会话条自测：源码契约 + 390×844 真视口。
 * 断言整列聊天不会被标成操作栏、消息不会被裁切、超长模型名不会盖住 + / 权限。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = "/scripts/fixtures/mobile-selftest.html";
const SCREENSHOT = join(ROOT, "scripts/fixtures/mobile-selftest-390.png");
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
};

function assertSourceContracts() {
	const src = readFileSync(join(ROOT, "android/app/src/main/res/raw/mobile.js"), "utf8");
	const block = src.match(/\[data-dshr-msg-actions\] \{\s*([^}]+)\}/);
	if (!block) throw new Error("源码契约：找不到 [data-dshr-msg-actions] 容器样式");
	if (/height\s*:/.test(block[1])) {
		throw new Error("源码契约：操作栏容器不得设 height（会裁掉整列消息）");
	}
	if (/overflow\s*:\s*hidden/.test(block[1])) {
		throw new Error("源码契约：操作栏容器不得 overflow:hidden");
	}
	if (/flex-wrap\s*:/.test(block[1]) || /display\s*:/.test(block[1]) || /gap\s*:/.test(block[1])) {
		throw new Error("源码契约：操作栏容器不得改 display/gap/flex-wrap");
	}
	if (src.includes("max-width: 42%")) {
		throw new Error("源码契约：不得用 max-width:42% 误伤模型选择器");
	}
	if (!src.includes("[data-dshr-composer-model]")) {
		throw new Error("源码契约：缺少 [data-dshr-composer-model]");
	}
	if (!src.includes("[data-dshr-composer-trailing]")) {
		throw new Error("源码契约：缺少 [data-dshr-composer-trailing]，超长模型名会盖住 +");
	}
	if (!src.includes("[data-dshr-composer-tools]")) {
		throw new Error("源码契约：缺少 [data-dshr-composer-tools]");
	}
	const modelRule = src.match(/\[data-dshr-composer-model\] \{[\s\S]*?'\}/);
	if (!modelRule) {
		throw new Error("源码契约：找不到 [data-dshr-composer-model] 规则块");
	}
	if (!/min-width:\s*0/.test(modelRule[0])) {
		throw new Error("源码契约：模型按钮必须 min-width:0 才能省略超长名");
	}
	if (/max-width:\s*none/.test(modelRule[0])) {
		throw new Error("源码契约：模型按钮不得 max-width:none（会盖住左侧按钮）");
	}
	if (!src.includes("[data-dshr-composer-access-chevron]")) {
		throw new Error("源码契约：缺少权限按钮箭头隐藏 [data-dshr-composer-access-chevron]");
	}
	if (!src.includes("[data-dshr-main-col]")) {
		throw new Error("源码契约：缺少 [data-dshr-main-col]（DeepSeek 式浮层会话栏）");
	}
	if (!src.includes("translateX(calc(100% - var(--dshr-drawer-peek)))")) {
		throw new Error("源码契约：缺少主栏 translateX 滑动展开");
	}
	if (!src.includes("grid-column: 2")) {
		throw new Error("源码契约：主栏必须 grid-column:2，否则 absolute 侧栏后会掉进 0px 列");
	}
	if (!src.includes("function findMainCol")) {
		throw new Error("源码契约：缺少 findMainCol");
	}
	if (!src.includes("data-dshr-dragging")) {
		throw new Error("源码契约：缺少跟手拖动 data-dshr-dragging");
	}
	if (!src.includes("function setDrawerVisual")) {
		throw new Error("源码契约：缺少 setDrawerVisual");
	}
	if (!src.includes('height: 100% !important') || !src.includes('[data-dshr-sheet-panel]')) {
		throw new Error("源码契约：设置页必须全屏 height:100%");
	}
	if (!src.includes("dshr-settings-rise")) {
		throw new Error("源码契约：缺少设置全屏进入动画");
	}
	if (src.includes("if (isDialogOpen() && isSidebarOpen()) setSidebarOpen(false)")) {
		throw new Error("源码契约：打开设置不得先收起侧栏（会闪回会话）");
	}
	if (!src.includes("function considerSwipe")) {
		throw new Error("源码契约：缺少主屏右划 considerSwipe");
	}
	if (!src.includes("function isSessionNavigationClick")) {
		throw new Error("源码契约：缺少会话点击 isSessionNavigationClick");
	}
	if (!src.includes("openSidebarIfCollapsed")) {
		throw new Error("源码契约：缺少 openSidebarIfCollapsed");
	}
	if (!src.includes("function clampFloatingMenus")) {
		throw new Error("源码契约：缺少浮动选框 clampFloatingMenus");
	}
	if (!src.includes("interactive-widget=overlays-content")) {
		throw new Error("源码契约：Android 壳必须 overlays-content，避免 layout viewport 再缩一次");
	}
	if (!src.includes("'overlays-content' : 'resizes-content'")) {
		throw new Error("源码契约：非壳 PWA 仍用 resizes-content 兜底");
	}
	if (!src.includes("function applyImeLift")) {
		throw new Error("源码契约：缺少 applyImeLift");
	}
	if (!src.includes("键盘占位只由原生平移负责")) {
		throw new Error("源码契约：Android 壳不得锁 visualViewport 高度");
	}
	if (!src.includes("-webkit-text-size-adjust: 100%")) {
		throw new Error("源码契约：移动页必须关掉系统字体自动缩放，否则键盘时字号会抖");
	}
	if (!src.includes("isAndroidShell() || !isMobileMode()")) {
		throw new Error("源码契约：applyImeLift 必须在 Android 壳上直接清掉高度锁");
	}
	if (src.includes("vv.addEventListener('scroll'")) {
		throw new Error("源码契约：不得在 visualViewport.scroll 上改 IME 高度");
	}
	if (!src.includes("--dshr-ime")) {
		throw new Error("源码契约：缺少 --dshr-ime");
	}
	const java = readFileSync(
		join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"),
		"utf8",
	);
	if (!java.includes("imeAnimating")) {
		throw new Error("源码契约：IME 动画期间不得每帧注入 inset JS");
	}
	if (!java.includes("IME_PAD_HYSTERESIS_DP")) {
		throw new Error("源码契约：syncImeFromVisibleFrame 必须有平移滞回");
	}
	if (!java.includes("setTranslationY(-imePx)")) {
		throw new Error("源码契约：键盘必须用 translationY 抬起，不得改 WebView 高度");
	}
	if (java.includes("rootLayout.setPadding(0, 0, 0, imePx)")) {
		throw new Error("源码契约：不得再用 padding 缩小 WebView（会重排字体）");
	}
	if (!java.includes("SOFT_INPUT_ADJUST_NOTHING")) {
		throw new Error("源码契约：API 30+ 必须 adjustNothing，避免系统改窗口高度");
	}
	if (!src.includes('[data-dshr-dialog="1"] [data-dshr-main-col]')) {
		throw new Error("源码契约：打开设置时必须压低主会话栏，避免盖住设置");
	}
	if (!src.includes("data-dshr-explorer-details")) {
		throw new Error("源码契约：缺少与 dsh-explorer overlay 的握手 data-dshr-explorer-details");
	}
	if (!src.includes("data-dshx-overlay")) {
		throw new Error("源码契约：必须侦听 Explorer 的 data-dshx-overlay");
	}
	if (!src.includes(":not([data-dshx-details-col])")) {
		throw new Error("源码契约：隐藏 details 不得误伤 Explorer 的 details 列");
	}
	if (!src.includes("grid-template-columns: 0px 0px minmax(0, 1fr)")) {
		throw new Error("源码契约：Explorer 替换模式必须把第三列让成全宽");
	}
	if (!src.includes("function isExplorerDetailsOpen")) {
		throw new Error("源码契约：缺少 isExplorerDetailsOpen");
	}
	if (!src.includes("z-index: 1400")) {
		throw new Error("源码契约：设置 overlay 必须 z-index:1400 盖住会话浮层");
	}
	if (!src.includes("DshRemoteApp.openSettings")) {
		throw new Error("源码契约：App 设置必须走 DshRemoteApp.openSettings，避免写入 WebView 历史");
	}
	if (!src.includes("抽屉手势始终走 touch")) {
		throw new Error("源码契约：抽屉手势必须走 touch，PointerEvent 会在滚动时被取消");
	}
	if (!src.includes("DSHRemoteAndroid")) {
		throw new Error("源码契约：Android WebView 必须强制启用移动适配，不得只看 1024px");
	}
	console.log("  ok  源码契约");
}

function findBrowser() {
	const candidates = [
		join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
		join(process.env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
	];
	return candidates.find((p) => existsSync(p));
}

function listenFreePort() {
	return new Promise((resolveListen) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolveListen(port));
		});
	});
}

function wait(ms) {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForJson(url, timeoutMs) {
	const start = Date.now();
	let lastErr;
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return await res.json();
			lastErr = new Error(`HTTP ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await wait(120);
	}
	throw lastErr || new Error(`timeout waiting ${url}`);
}

async function waitForPageTarget(dbgPort, timeoutMs) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const list = await waitForJson(`http://127.0.0.1:${dbgPort}/json/list`, 1000).catch(() => []);
		const page = (Array.isArray(list) ? list : []).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
		if (page) return page;
		await wait(120);
	}
	throw new Error("没有可用的 page target");
}

async function collectSelftest(call) {
	for (let i = 0; i < 25; i++) {
		const evaluated = await call("Runtime.evaluate", {
			expression: "window.__dshrSelftest || null",
			returnByValue: true,
		});
		const report = evaluated.result && evaluated.result.value;
		if (report) return report;
		await wait(150);
	}
	throw new Error("自测页未写出 window.__dshrSelftest");
}

function printChecks(report) {
	for (const check of report.checks) {
		const mark = check.ok ? "ok" : "FAIL";
		console.log(`  ${mark}  ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
	}
}

function cdpCall(ws, id, method, params = {}) {
	return new Promise((resolveCall, rejectCall) => {
		const onMessage = (event) => {
			const msg = JSON.parse(String(event.data));
			if (msg.id !== id) return;
			ws.removeEventListener("message", onMessage);
			if (msg.error) rejectCall(new Error(`${method}: ${JSON.stringify(msg.error)}`));
			else resolveCall(msg.result);
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

assertSourceContracts();

const server = createServer((req, res) => {
	const url = decodeURIComponent((req.url || "/").split("?")[0]);
	const file = join(ROOT, ...url.replace(/^\//, "").split("/").filter(Boolean));
	if (!file.startsWith(ROOT) || !existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
	res.end(readFileSync(file));
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const pageUrl = `http://127.0.0.1:${port}${FIXTURE}`;
const browser = findBrowser();
if (!browser) {
	server.close();
	throw new Error("未找到 Chrome/Edge，无法做 390px 布局自测");
}

const dbgPort = await listenFreePort();
const profile = mkdtempSync(join(tmpdir(), "dshr-chrome-"));
const child = spawn(browser, [
	`--remote-debugging-port=${dbgPort}`,
	`--user-data-dir=${profile}`,
	"--headless=new",
	"--disable-gpu",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-sync",
	"--window-size=390,844",
	"about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

try {
	const page = await waitForPageTarget(dbgPort, 8000);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolveOpen, rejectOpen) => {
		ws.addEventListener("open", resolveOpen);
		ws.addEventListener("error", () => rejectOpen(new Error("page websocket 连接失败")));
	});

	let nextId = 1;
	const call = (method, params) => cdpCall(ws, nextId++, method, params);

	await call("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: true,
	});
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Page.navigate", { url: pageUrl });
	await wait(2200);
	const report = await collectSelftest(call);

	const shot = await call("Page.captureScreenshot", { format: "png" });
	writeFileSync(SCREENSHOT, Buffer.from(shot.data, "base64"));

	await call("Emulation.setUserAgentOverride", {
		userAgent:
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 DSHRemoteAndroid/0.1.1-rc.2.5",
	});
	await call("Page.navigate", { url: pageUrl });
	await wait(2200);
	const androidReport = await collectSelftest(call);
	ws.close();

	console.log("  -- Chrome 390 视口 --");
	printChecks(report);
	console.log("  -- Android 壳 UA --");
	printChecks(androidReport);
	if (!report.ok || !androidReport.ok) {
		process.exitCode = 1;
		console.error("\nmobile chrome 自测失败");
		console.error(`截图：${SCREENSHOT}`);
	} else {
		console.log("\nmobile chrome 自测通过");
		console.log(`截图：${SCREENSHOT}`);
	}
} catch (err) {
	process.exitCode = 1;
	console.error(err && err.stack ? err.stack : err);
} finally {
	try { child.kill(); } catch { /* ignore */ }
	server.close();
	try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
