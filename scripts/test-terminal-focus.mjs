#!/usr/bin/env node
/**
 * 手机档「终端点不动」修复的行为级钉桩（T-终端）。
 *
 * 覆盖什么（全部在真 Chrome 里跑**真实 mobile-web.js**，不 mock 守卫本身）：
 *   1. 守卫的本职仍在：**非用户手势**的程序化聚焦照样被收回（终端修复不能把关守让开）；
 *   2. 用户真触摸终端屏幕面（`.xterm-screen`，xterm 随后自己 focus 那个 0×0、
 *      `left:-9999em` 的 `.xterm-helper-textarea`）⇒ 焦点必须**留住**、
 *      且不得被压成 `inputmode="none"`（那等于键盘不弹，症状同样是「点了没反应」）；
 *   3. 键盘抬起矩形：终端聚焦时上报给原生的必须是**光标行**矩形（helper textarea 的
 *      矩形是 (0,0)，原生 computeImeShift 据此算出 needed ≤ 0 ⇒ 平移恒 0 ⇒ 键盘盖住终端）；
 *   4. 不做过度修正：同一页里的 composer 真触摸照常聚焦（回归钉桩）。
 *
 * 为什么要合成终端而不是开真终端：DSH 的终端池按 Session 计 8 个、**已退出的也占名额**，
 * 只有关标签页才释放（见 dsh-api-terminal-controller 文档）。这条用例只验证**页面侧**
 * 的焦点/IME 契约，不需要真 PTY，因此不该去吃用户会话的终端名额。
 * 真终端端到端另见交付报告（本轮受终端池限制，如实标注）。
 *
 * 用法：
 *   node scripts/test-terminal-focus.mjs                 # 跑当前 hook
 *   DSHR_TEST_HOOK=<path> node scripts/test-terminal-focus.mjs   # A/B：换一份 hook
 * 退出码：0 全过；1 有断言不成立；2 拿不到证据（Chrome 缺失/环境抖动）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = process.env.DSHR_TEST_HOOK || join(ROOT, "packages", "gateway", "assets", "mobile-web.js");
const UA_ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/128.0.0.0 Mobile Safari/537.36 DSHRemoteAndroid/0.2.0-rc.2.23";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let exitCode = 0;
function record(name, ok, detail) {
	results.push({ name, ok });
	if (ok === false) exitCode = 1;
	console.log(`  ${ok === null ? "SKIP" : ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function skipAll(reason) {
	console.log(`\ntest:terminal 跳过：${reason}`);
	process.exit(0);
}

if (!existsSync(HOOK_PATH)) skipAll(`找不到 hook：${HOOK_PATH}`);
const HOOK_SOURCE = readFileSync(HOOK_PATH, "utf8");

function findBrowser() {
	const candidates = [
		join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
	];
	return candidates.find((p) => existsSync(p));
}
const browser = findBrowser();
if (!browser) skipAll("未找到 Chrome/Edge");

const freePort = () =>
	new Promise((res) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});

// ── 合成页面：官方 composer（可编辑）+ 一个 xterm 形态的终端 ──
// 终端 DOM 与 xterm.css 的真实形态逐条对齐：
//   .xterm （relative）> .xterm-screen（铺满）> .xterm-rows > div > span.xterm-cursor
//   .xterm-helper-textarea：width/height 0、left:-9999em、opacity 0
// 并复刻 xterm 的聚焦时机：抬手（touchend / mouseup）之后自己 focus textarea。
const FIXTURE = (device) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;font:14px sans-serif}
  #root{height:100%}
  .frame{display:flex;flex-direction:column;height:100%}
  header{height:40px;flex:none}
  .main{flex:1;position:relative;overflow:hidden}
  [data-composer-card]{position:absolute;left:8px;right:8px;bottom:8px;height:96px;border:1px solid #ccc}
  [data-composer-input]{height:60px;outline:none}
  .xterm{position:relative;width:100%;height:60%;background:#111;color:#eee}
  .xterm .xterm-screen{position:absolute;inset:0}
  .xterm .xterm-rows{position:absolute;top:0;left:0}
  .xterm .xterm-rows>div{height:17px;line-height:17px}
  .xterm .xterm-helper-textarea{opacity:0;z-index:-5;white-space:nowrap;resize:none;border:0;width:0;height:0;margin:0;padding:0;position:absolute;top:0;left:-9999em;overflow:hidden}
</style></head><body>
<div id="root"><div class="frame">
  <header><nav>会话标题</nav></header>
  <div class="main">
    <div class="xterm" id="term">
      <div class="xterm-screen" id="termScreen"></div>
      <div class="xterm-rows"><div><span>Microsoft Windows [版本 10.0.28000]</span></div><div><span class="xterm-cursor xterm-cursor-block">C:\\&gt;</span></div></div>
      <textarea class="xterm-helper-textarea" id="termInput" aria-label="终端输入"></textarea>
    </div>
    <div data-composer-card><div data-composer-input contenteditable="true" id="composer">输入…</div></div>
  </div>
</div></div>
<script>
  window.__DSHR_MOBILE__ = { device: '${device}', breakpoint: 1024 };
  window.__imeRects = [];
  window.__diag = [];
  // 原生桥：hook 的 reportImeFocusToNative() / reportUiDiag() 只认这两个接口
  window.DshRemoteApp = {
    imeFocusRect: function (top, bottom) { window.__imeRects.push([top, bottom]); },
    setUiDiag: function (payload) { window.__diag.push(payload); }
  };
  // 复刻 xterm：抬手后把焦点交给隐藏的 helper textarea
  (function () {
    var input = document.getElementById('termInput');
    var screen = document.getElementById('termScreen');
    var focusInput = function () { try { input.focus(); } catch (e) {} };
    screen.addEventListener('touchend', focusInput);
    screen.addEventListener('mouseup', focusInput);
    window.__termInput = input;
    window.__termCursor = document.querySelector('.xterm-cursor');
  })();
</script></body></html>`;

const dbgPort = await freePort();
const profile = mkdtempSync(join(tmpdir(), "dshr-termfocus-"));
const child = spawn(
	browser,
	[
		`--remote-debugging-port=${dbgPort}`,
		`--user-data-dir=${profile}`,
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--window-size=412,915",
		"about:blank",
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);

let ws;
try {
	let target = null;
	const started = Date.now();
	while (Date.now() - started < 20000) {
		const list = await fetch(`http://127.0.0.1:${dbgPort}/json/list`)
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []);
		target = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		if (target) break;
		await sleep(150);
	}
	if (!target) skipAll("CDP 没有可用 page target");
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res);
		ws.addEventListener("error", () => rej(new Error("CDP 连接失败")));
	});
	let nextId = 1;
	const call = (method, params = {}) =>
		new Promise((res, rej) => {
			const id = nextId++;
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
	const evaluate = async (expression) => {
		const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (out.exceptionDetails) {
			throw new Error(`页面求值抛错：${out.exceptionDetails.text} ${out.exceptionDetails.exception?.description ?? ""}`);
		}
		return out.result?.value;
	};
	const tap = async (x, y) => {
		const point = [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
		await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
		await sleep(60);
		await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await sleep(250);
	};

	await call("Page.enable");
	await call("Runtime.enable");
	// 真机页面是持焦的：不打开焦点模拟，headless 里程序化 focus() 不派发 focusin，
	// 「守卫收回非手势聚焦」这条根本不会被触发（假绿）。
	await call("Emulation.setFocusEmulationEnabled", { enabled: true });
	await call("Emulation.setUserAgentOverride", { userAgent: UA_ANDROID, platform: "Android" });
	await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	await call("Emulation.setDeviceMetricsOverride", {
		width: 412,
		height: 915,
		deviceScaleFactor: 2,
		mobile: true,
		screenOrientation: { type: "portraitPrimary", angle: 0 },
	});
	/** 载入某一档的合成页并注入 hook（与真机同序：页面 ready 之后注入）。 */
	const loadArm = async (device) => {
		await call("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE(device))}` });
		await sleep(600);
		const ok = await evaluate(`(function(){ ${HOOK_SOURCE}\n; return !!window.__dshRemoteMobileInstalled; })()`);
		if (ok) await sleep(900);
		return ok === true;
	};

	// ── 手机档臂 ──
	if (!(await loadArm("phone"))) {
		record("hook 安装（手机档）", false, "window.__dshRemoteMobileInstalled 未置位");
	} else {
		record("hook 安装（手机档）", true);
		const on = await evaluate(`document.documentElement.className`);
		record("手机档 hook 生效（dshr-mobile）", /dshr-mobile/.test(String(on)), `className=${JSON.stringify(on)}`);
		record("手机档收敛诊断已上报（setUiDiag 到达桥）", (await evaluate(`window.__diag.length > 0`)) === true, await evaluate(`JSON.stringify(window.__diag.slice(-1))`));

		// ── 1. 守卫本职：程序化聚焦（无用户手势）必须被收回 ──
		await evaluate(`window.__termInput.blur(); window.__termInput.focus(); true`);
		await sleep(300);
		const afterProgrammatic = await evaluate(`document.activeElement === window.__termInput`);
		record("非手势的程序化聚焦仍被收回（守卫本职）", afterProgrammatic === false, `activeElement 仍为终端输入面 = ${String(afterProgrammatic)}`);

		// ── 2. 真触摸终端 ⇒ 焦点留住、且不被 IME 压制 ──
		const center = await evaluate(`(function(){var r=document.getElementById('termScreen').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
		await tap(center.x, center.y);
		const tapState = await evaluate(`JSON.stringify({
			active: document.activeElement === window.__termInput,
			inputmode: window.__termInput.getAttribute('inputmode'),
			muted: window.__termInput.getAttribute('data-dshr-imemute'),
			mutedNodes: document.querySelectorAll('[data-dshr-imemute]').length
		})`);
		const st = JSON.parse(tapState);
		record("真触摸终端后焦点留在 helper textarea", st.active === true, tapState);
		record("终端输入面未被压成 inputmode=none", st.inputmode !== "none" && st.muted === null && st.mutedNodes === 0, tapState);

		// ── 3. 键盘抬起矩形 = 光标行（不是 (0,0) 的 helper textarea） ──
		const lift = await evaluate(`JSON.stringify((function(){
			var cursor = window.__termCursor.getBoundingClientRect();
			var rects = window.__imeRects.slice();
			var last = rects.length ? rects[rects.length-1] : null;
			return { cursorTop: Math.round(cursor.top), cursorBottom: Math.round(cursor.bottom), last: last };
		})())`);
		const lf = JSON.parse(lift);
		const lifted = Array.isArray(lf.last) && Math.abs(lf.last[1] - lf.cursorBottom) <= 1 && Math.abs(lf.last[0] - lf.cursorTop) <= 1 && lf.last[1] > 0;
		record("终端聚焦上报的键盘抬起矩形 = 光标行", lifted, `cursorTop=${lf.cursorTop} cursorBottom=${lf.cursorBottom} 上报=${JSON.stringify(lf.last)}`);

		// ── 4. 回归：composer 真触摸照常聚焦（没有过度修正） ──
		const composer = await evaluate(`(function(){var r=document.getElementById('composer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
		await tap(composer.x, composer.y);
		const composerFocused = await evaluate(`document.activeElement === document.getElementById('composer')`);
		record("composer 真触摸仍能聚焦（无过度修正）", composerFocused === true, `activeElement=${await evaluate("document.activeElement && document.activeElement.id")}`);

		// ── 5. 平板档臂：严格 OFF 也必须上报一次收敛诊断（PAD-02）──
		// 平板档 `syncWsStateWatch(false)` 不装 WS 观察器 ⇒ 除 applyWidthScope 末尾那一发
		// 之外的上报点一次都走不到；而那一发原本在严格 OFF 早退之后 ⇒ 原生「页面适配诊断」
		// 永远显示「未上报」（真机 1/1 复现）。
		if (!(await loadArm("tablet"))) {
			record("hook 安装（平板档）", false, "window.__dshRemoteMobileInstalled 未置位");
		} else {
			await sleep(1200); // 覆盖报告里那一发 1.5s 一次性延迟上报
			const diag = await evaluate(`JSON.stringify((function(){
				var last = window.__diag.length ? window.__diag[window.__diag.length-1] : null;
				return { count: window.__diag.length, payload: last, cls: document.documentElement.className,
					whale: !!document.getElementById('dshr-mobile-whale') };
			})())`);
			const d = JSON.parse(diag);
			record("平板档严格 OFF（无根类/无 hook 节点）", d.cls === "" && d.whale === false, diag);
			record("平板档收敛诊断已上报（setUiDiag 到达桥）", d.count > 0, diag);
			record("平板档诊断载荷如实标注 on=false / strictOff=true", !!d.payload && /"on":false/.test(d.payload) && /"strictOff":true/.test(d.payload), String(d.payload));
		}
	}
} catch (err) {
	record("测试执行", false, String(err?.message ?? err));
} finally {
	try {
		ws?.close();
	} catch {
		/* ignore */
	}
	try {
		child.kill();
	} catch {
		/* ignore */
	}
}

const pass = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
console.log(`\n断言合计 ${results.length}：通过 ${pass}，失败 ${fail}`);
console.log(`hook 源：${HOOK_PATH}（${HOOK_SOURCE.length} 字符）`);
process.exit(exitCode);
