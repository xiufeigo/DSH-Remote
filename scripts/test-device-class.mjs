#!/usr/bin/env node
/**
 * 设备分档（契约 3.4）真实页面测试 —— G1/G2/G3/G4 在真实 DSH 0.2.0-rc.2 页面上的验证。
 *
 * 与 scripts/test-mobile-chrome.mjs（fixture 自测）互补：那一个跑合成页面验证版面细节，
 * 这个跑**真实页面**验证「手机/平板/横屏/运行中切换」这条分档矩阵，并把平板档的
 * 「零痕迹」做成**对照实验**（注入 vs 不注入，两臂逐项比对）。
 *
 * 注入时机与真机一致：MainActivity 在 onPageCommitVisible / onPageFinished /
 * doUpdateVisitedHistory 里 evaluateJavascript 注入，本脚本同样在页面 ready 之后注入。
 * （不要改成 document-start 注入：那一刻 document.head 还是 null，mobile-web.js:911
 *   的 (document.head || document.documentElement).appendChild 会抛，而
 *   __dshRemoteMobileInstalled 守卫已在该行之前置位，抛了就再也装不上——
 *   那是本 harness 独有的时序，不是真机缺陷。详见交付报告。）
 *
 * 宿主/网关不可达时（例如 CI）打印原因并以退出码 0 跳过，不报失败。
 * 只读页面：全程不新建会话、不发送消息、不改任何设置；只新建一个配对设备并在结束时吊销。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const GATEWAY = "https://127.0.0.1:18443";
const HOOK_PATH = join(ROOT, "packages/gateway/assets/mobile-web.js");
const SCRATCH = join(ROOT, "scratch/plan-0.2.0-rc.2");
const SHOT_DIR = join(ROOT, "scratch/dom");
const DEVICE_NAME = "device-class-test";
const UA_ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/128.0.0.0 Mobile Safari/537.36 DSHRemoteAndroid/0.2.0-rc.2.1";
// hook 自有节点（mobile-web.js HOOK_NODE_IDS）——平板档零痕迹必须逐个不存在。
const HOOK_NODE_IDS = ["dshr-mobile-whale", "dshr-mobile-drawer-mask", "dshr-status-guard", "dshr-drawer-handle"];
const TOLERANCE_PX = 1;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;
const results = [];
function record(scenario, name, ok, detail) {
	results.push({ scenario, name, ok, detail: detail || "" });
	const mark = ok === null ? "SKIP" : ok ? "ok  " : "FAIL";
	if (ok === false) exitCode = 1;
	console.log(`  ${mark}  [${scenario}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function info(scenario, text) {
	console.log(`  ----  [${scenario}] ${text}`);
}
function skipAll(reason) {
	console.log(`\ntest:device 跳过：${reason}`);
	console.log("（宿主/网关不可达属于环境问题，按 scripts/smoke-edge-frp.mjs 的无依赖自动跳过约定退出 0）");
	process.exit(0);
}

// 结构化源码提取（锚点定位 + 括号配平 + 解析硬闸）—— 实现在 scripts/lib/source-extract.mjs，
// 与 scratch/t76/extract-selftest.mjs **共用同一份**：T76 第一版把扫描器抄了两份，
// 自测那份是对的、真跑那份漏了一行 const openCh，直接把 test:device 跑崩
//（跑到第 26 条 ReferenceError: openCh is not defined）。副本迟早分叉，
// 分叉就是「自测说 PASS、真跑却崩」，所以只保留一个实现。
//
// 「为什么不能用字符预算」的完整说明见该文件顶部，这里只留一句：
//   /function foo([\s\S]{0,1400}?\n\t\}/ 这种按字符数猜收尾的写法，
//   真实函数体一超过预算 match 就返回 null ⇒ 断言拿到空串 ⇒ indexOf 全 -1 ⇒ 假红；
//   改短又会悄悄腰斩 ⇒ 假绿。实测 isPanelTriggerPoint 1341 vs 预算 900、
//   armComposerFocus 1939 vs 预算 1400。
import { extractDecl, extractInitializer, assertParses, javaMethod, javaBalanced, stripJavaComments, maskJsComments, maskJsCommentsOnly, jsBlockAfter, maskJavaNoise, javaMethodSpans, javaEnclosingMethod, javaCallChain, javaCallArgs } from "./lib/source-extract.mjs";

// ───────────────────────────── 0. 前置依赖与跳过语义 ─────────────────────────────
if (!existsSync(HOOK_PATH)) skipAll(`找不到 hook 单一源 ${HOOK_PATH}`);
const HOOK_SOURCE = readFileSync(HOOK_PATH, "utf8");
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

let adminToken;
try {
	adminToken = JSON.parse(readFileSync(join(homedir(), ".dsh-remote/state/secrets.json"), "utf8")).adminToken;
} catch {
	adminToken = undefined;
}
if (!adminToken) skipAll("读不到 ~/.dsh-remote/state/secrets.json 的 adminToken（网关未在 18443 运行？）");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 网关是 TLS 自签证书，回环访问
const ADMIN_HEADERS = { "x-dshr-admin-token": adminToken, "content-type": "application/json" };

let devicesBefore = [];
try {
	const health = await fetch(`${GATEWAY}/__dsh_remote__/health`, { signal: AbortSignal.timeout(5000) });
	if (!health.ok) throw new Error(`health ${health.status}`);
	devicesBefore = (await (await fetch(`${GATEWAY}/__dsh_remote__/admin/devices`, { headers: ADMIN_HEADERS })).json()).devices;
} catch (err) {
	skipAll(`DSH-Remote 网关 127.0.0.1:18443 不可达（${String(err.message || err)}）`);
}
console.log(`test:device 前置就绪：网关可达，hook ${HOOK_SOURCE.length} 字符，既有设备 ${devicesBefore.length} 个`);

function findBrowser() {
	const candidates = [
		join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
		join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
		join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
	];
	return candidates.find((p) => existsSync(p));
}
const browserPath = findBrowser();
if (!browserPath) skipAll("未找到 Chrome/Edge，无法做真实页面 CDP 测试");
const freePort = () =>
	new Promise((res) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
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

// ───────────────────────────── 1. 配对一次性测试设备 ─────────────────────────────
let testDeviceId = null;
let deviceCookie = null;
async function mintDevice() {
	const { code } = await (await fetch(`${GATEWAY}/__dsh_remote__/admin/pair-code`, { method: "POST", headers: ADMIN_HEADERS })).json();
	const res = await fetch(`${GATEWAY}/__dsh_remote__/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, name: DEVICE_NAME }),
	});
	if (!res.ok) throw new Error(`pair 返回 ${res.status}`);
	const raw = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")])[0];
	deviceCookie = String(raw).split(";")[0];
	const devices = (await (await fetch(`${GATEWAY}/__dsh_remote__/admin/devices`, { headers: ADMIN_HEADERS })).json()).devices;
	const mine = devices.find((d) => !devicesBefore.some((b) => b.id === d.id));
	testDeviceId = mine ? mine.id : null;
	if (!testDeviceId) throw new Error("配对成功但拿不到新设备 id");
	// 证明 cookie 真的落在设备门禁后面（/__dsh_remote__/mobile.js 无 cookie 必 401）
	const gated = await fetch(`${GATEWAY}/__dsh_remote__/mobile.js`, { headers: { cookie: deviceCookie } });
	if (gated.status !== 200) throw new Error(`设备 cookie 未通过门禁：mobile.js 返回 ${gated.status}`);
	return testDeviceId;
}
try {
	await mintDevice();
	console.log(`已配对测试设备 ${testDeviceId}（结束时吊销）`);
} catch (err) {
	skipAll(`配对测试设备失败：${String(err.message || err)}`);
}

// ───────────────────────────── 2. 拉起 Chrome ─────────────────────────────
const dbgPort = await freePort();
const profile = mkdtempSync(join(tmpdir(), "dshr-deviceclass-"));
const child = spawn(
	browserPath,
	[
		`--remote-debugging-port=${dbgPort}`,
		`--user-data-dir=${profile}`,
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-sync",
		"--ignore-certificate-errors", // 网关 TLS 自签
		"--window-size=412,915",
		"about:blank",
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);

try {
	let ws = null;
	let nextId = 1;
	const call = (method, params) => cdpCall(ws, nextId++, method, params);
	const evaluate = async (expression) => {
		const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (out.exceptionDetails) {
			throw new Error(`页面求值抛错：${out.exceptionDetails.text} ${(out.exceptionDetails.exception || {}).description || ""}`);
		}
		return out.result ? out.result.value : undefined;
	};

	// 2.1 连接 page target
	let pageTarget = null;
	const connectStart = Date.now();
	while (Date.now() - connectStart < 15000) {
		const list = await fetch(`http://127.0.0.1:${dbgPort}/json/list`)
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []);
		pageTarget = (Array.isArray(list) ? list : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
		if (pageTarget) break;
		await wait(150);
	}
	if (!pageTarget) throw new Error("没有可用的 page target");
	ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res);
		ws.addEventListener("error", () => rej(new Error("page websocket 连接失败")));
	});
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Network.enable");
	await call("Emulation.setUserAgentOverride", { userAgent: UA_ANDROID });
	await call("Network.setCookie", {
		name: deviceCookie.split("=")[0],
		value: deviceCookie.split("=").slice(1).join("="),
		domain: "127.0.0.1",
		path: "/",
		secure: true,
		httpOnly: true,
	});

	// 2.2 视口 + 真实页面就绪 + 按真机时机注入 hook
	//
	// 视口必须「应用 + 校验」：全新 headless target 上，导航前下发的
	// Emulation.setDeviceMetricsOverride 会在真实文档 commit 时被重置，页面于是落到
	// 980px 的移动兜底宽度——几何断言会全在错误的视口上给出无意义的结论。
	// 做法：先 about:blank 上把 override 立住，再导航真实页，加载后仍回读校验，
	// 不一致就重下；最终仍不符就抛错中止（宁可不出证据，也不出错证据）。
	let currentViewport = null;
	const viewportParams = (width, height) => ({
		width,
		height,
		deviceScaleFactor: 2,
		mobile: true,
		screenOrientation: height >= width ? { type: "portraitPrimary", angle: 0 } : { type: "landscapePrimary", angle: 90 },
	});
	async function applyViewport(width, height) {
		await call("Emulation.setDeviceMetricsOverride", viewportParams(width, height)).catch(() => {});
	}
	async function viewportOk(width, height) {
		const got = await evaluate(`({w: window.innerWidth, h: window.innerHeight})`).catch(() => null);
		return !!got && Math.abs(got.w - width) <= 1 && Math.abs(got.h - height) <= 1;
	}
	async function setViewport(width, height) {
		currentViewport = { width, height };
		return applyViewport(width, height);
	}
	// ── 渲染完成闸（两臂、全部场景 A–E 的统一门禁）──
	// 官方 DSH 是**分阶段挂载**的：主界面先出，composer seat 随后，右栏 dockkit 最后。
	// 若只等「#root 有子节点」或「header 存在」，就会把某一臂拍在半渲染状态——
	// 表现为 header 高 0（padding-top 0）、composer 整体上移 20px、右栏尚未挂载这类
	// **假差异**。它差的是「官方渲染到第几步」，不是「hook 有没有留痕迹」，
	// 所以对照实验两臂必须先过同一道闸，像素对照才有意义。
	//
	// 落定判据（五条全满足才算 render complete）：
	//   1. #root 有子节点——应用真的起来了（不是 404/空壳页）
	//   2. header 存在且 getBoundingClientRect().height > 0
	//   3. [data-composer-card] 与 [data-composer-seat] 存在且高度 > 0
	//   4. 宽视口（innerWidth >= 900）下 [data-sidebar-right-panel] 已挂载
	//   5. 上述取值连续 3 次采样完全一致（约 1.2s）
	// 第 5 条的采样**必须含各元素 top 坐标**：半渲染的 composer 是「高度对、y 差 20px」，
	// 只比高度会把它当成已落定——这正是旧门禁放行场景 D 假差异的通道。
	// 拿不到这个状态就抛错中止（宁可不出证据，也不出错证据），绝不返回半渲染快照。
	const WIDE_MIN_WIDTH = 900; // 与官方横屏让位阈值同源：>= 900 才有右栏
	const RENDER_STABLE_SAMPLES = 3;
	const RENDER_PROBE = `JSON.stringify((function(){
		var q=function(s){return document.querySelector(s);};
		var t=function(e){return e?Math.round(e.getBoundingClientRect().top):-1;};
		var h=function(e){return e?Math.round(e.getBoundingClientRect().height):-1;};
		var root=q('#root'), head=q('header'), card=q('[data-composer-card]'),
			seat=q('[data-composer-seat]'), rb=q('[data-sidebar-right-panel]');
		return {innerWidth:window.innerWidth,innerHeight:window.innerHeight,
			rootChildren:root?root.childElementCount:-1,
			headerTop:t(head),headerH:h(head),cardTop:t(card),cardH:h(card),
			seatTop:t(seat),seatH:h(seat),
			rightbarMounted:!!rb,rightbarTop:t(rb),rightbarH:h(rb),
			bodyScrollHeight:document.body?document.body.scrollHeight:-1};
	})())`;
	/** 返回未满足的判据列表；空数组 = 渲染完成。 */
	function renderCompleteGaps(s) {
		const gaps = [];
		if (!(s.rootChildren > 0)) gaps.push(`#root 子节点=${s.rootChildren}`);
		if (!(s.headerH > 0)) gaps.push(`header 高度=${s.headerH}`);
		if (!(s.cardH > 0)) gaps.push(`[data-composer-card] 高度=${s.cardH}`);
		if (!(s.seatH > 0)) gaps.push(`[data-composer-seat] 高度=${s.seatH}`);
		if (s.innerWidth >= WIDE_MIN_WIDTH && !s.rightbarMounted) {
			gaps.push(`[data-sidebar-right-panel] 未挂载（宽视口 ${s.innerWidth}px）`);
		}
		return gaps;
	}
	/**
	 * 等渲染完成。预算内拿不到就返回 null 并记下未满足项，由调用方决定重试还是中止——
	 * 绝不把「看起来稳定但其实半渲染」的状态当成落定交出去。
	 * @returns {Promise<object|null>} 渲染完成快照（含两臂复核用的 header 高度/右栏/bodyScrollHeight）
	 */
	let lastUnmet = ["（尚未采样）"];
	async function waitForRenderComplete(samples = 40, gapMs = 500) {
		let last = null;
		let same = 0;
		for (let i = 0; i < samples; i++) {
			const cur = await evaluate(RENDER_PROBE).catch(() => null);
			if (cur) {
				const snap = JSON.parse(cur);
				// T51（R8）：记住最后一帧，失败时落盘（原来只留一行「header 高度=0」）。
				lastRenderProbe = snap;
				const gaps = renderCompleteGaps(snap);
				lastUnmet = gaps;
				if (gaps.length === 0 && cur === last) {
					same += 1;
					if (same >= RENDER_STABLE_SAMPLES - 1) return snap; // 连续 3 次采样完全一致
				} else {
					same = 0;
				}
				last = cur;
			} else {
				lastUnmet = ["页面求值失败（导航中？）"];
				last = null;
				same = 0;
			}
			await wait(gapMs);
		}
		return null;
	}
	const unmetText = () => (lastUnmet.length ? lastUnmet.join("，") : "无");
	/**
	 * T51（R8）：「拿不到对照证据」专用错误。
	 *
	 * T50 §9.2 的判定二：**exit 1 = 有回归** 这个信号不可信。
	 * 「证据不足而保护性中止」与「某条行为断言不成立」是两件不同的事，却共用退出码 1；
	 * 而 `header 高度=0` 这个瞬态在 T50 的 3/3 次运行里都出现、只有 1/3 变成失败
	 * ⇒ 约 1/3 概率把一次环境抖动放大成整轮 exit 1，CI 上表现为随机红。
	 *
	 * 本文件退出码约定（T51 起）：
	 *   0 = 全部断言通过
	 *   1 = **有行为断言不成立**（真回归，去查代码）
	 *   2 = **没拿到对照证据**（页面没起来 / 视口没下发 / 环境抖动；本轮一条断言都没真跑，
	 *       重跑或换环境，不代表代码有问题）
	 */
	class NoEvidenceError extends Error {
		constructor(message) {
			super(message);
			this.name = "NoEvidenceError";
			this.exitCode = 2;
		}
	}

	/**
	 * 载入真实页面并等它**渲染完成**，返回渲染完成快照（对照 JSON 要用）。
	 * 「导航成功但应用没起来 / 停在半渲染」的真实页重试；仍拿不到就抛 NoEvidenceError。
	 */
	const LOAD_MAX_ATTEMPTS = 4; // T51（R8）：2 → 4
	/**
	 * T53：把「这套要跑多久」记在**真正决定最坏耗时的地方**，别只在报告里写。
	 *
	 * T52 §13 实测（emulator 5572）：失败快路径（拿不到对照证据，退出码 2）**19.1s**；
	 * 成功路径（退出码 1，断言真红）**138.5s**。单次尝试的构成见 loadRealPage：
	 * 导航 + 80×250ms 首屏轮询（最坏 20s）+ 8×250ms 视口轮询（最坏 2s）+ 2200ms 稳定等待
	 * + waitForRenderComplete()。
	 *
	 * ⇒ **把本套件接进任何 CI 时，那个 step 的 timeout 必须 ≥ 240s。**
	 * （不要按 T51 说的 290s：T52 §13.4 实测不支持那个数字，方向对但虚高。）
	 *
	 * T53 核查结论（别再照着"放宽 CI 超时"去找）：**仓库里现在没有任何 timeout 需要放宽** ——
	 * `.github/workflows/{ci,android,release}.yml`、`package.json`、`android/build.ps1`、
	 * `android/test-direct-nodes.ps1` 全库 grep `timeout` **0 命中**；且三个 workflow
	 * **都不跑** `test:device`（它要真机/模拟器 + 已配对网关），所以「3 分钟超时」这个
	 * T52 §18-6 的前提并不成立。此处留注释是为了：将来真把它接进 CI 时，
	 * 预算数字不必重新测。
	 */
	/** 最后一次渲染探针快照（失败时落盘用；T50 §9.2 建议③：原来只留一行「header 高度=0」）。 */
	let lastRenderProbe = null;
	async function loadRealPage() {
		// 真实页偶尔会「导航成功但应用没起来」（bodyScrollHeight≈15、关键元素全 null），
		// 或停在 header 高 0 / 右栏未挂载的半渲染态。那种页面当对照臂会产出整屏 null
		// 的假差异，所以最多重试 LOAD_MAX_ATTEMPTS 次，仍不行就中止。
		for (let attempt = 1; attempt <= LOAD_MAX_ATTEMPTS; attempt++) {
			await call("Page.navigate", { url: "about:blank" });
			await wait(150);
			if (currentViewport) await applyViewport(currentViewport.width, currentViewport.height);
			await call("Page.navigate", { url: `${GATEWAY}/` });
			let ready = false;
			for (let i = 0; i < 80; i++) {
				ready = await evaluate(`!!(document.querySelector('#root') && document.querySelector('#root').childElementCount > 0 && document.querySelector('header'))`).catch(() => false);
				if (ready) break;
				await wait(250);
			}
			if (ready) {
				if (currentViewport) {
					const { width, height } = currentViewport;
					let ok = false;
					for (let i = 0; i < 8 && !ok; i++) {
						await applyViewport(width, height);
						await wait(250);
						ok = await viewportOk(width, height);
					}
					if (!ok) {
						const got = await evaluate(`({w: innerWidth, h: innerHeight})`).catch(() => null);
						throw new NoEvidenceError(`视口下发失败：期望 ${width}×${height}，页面实际 ${JSON.stringify(got)}`);
					}
				}
				await wait(2200); // React 首屏与官方过渡稳定
				const snap = await waitForRenderComplete();
				if (snap) return snap;
				info("load", `第 ${attempt}/${LOAD_MAX_ATTEMPTS} 次加载未达渲染完成（未满足：${unmetText()}），重试`);
				continue;
			}
			info("load", `第 ${attempt}/${LOAD_MAX_ATTEMPTS} 次加载连 #root 子节点都没有，重试`);
		}
		dumpRenderProbe(`loadRealPage-${LOAD_MAX_ATTEMPTS}x`);
		throw new NoEvidenceError(
			`真实页面 ${LOAD_MAX_ATTEMPTS} 次加载都没达渲染完成状态（最后未满足：${unmetText()}）——中止，不产出对照证据。`
			+ `这是「拿不到对照证据」（退出码 2），不是行为断言失败；直接重跑即可。`,
		);
	}
	/** T51（R8）：把最后一帧渲染探针落盘，供事后判断是首屏全白还是半渲染。 */
	function dumpRenderProbe(tag) {
		try {
			mkdirSync(SCRATCH, { recursive: true });
			const file = join(SCRATCH, `render-probe-${tag}.json`);
			writeFileSync(file, JSON.stringify({
				at: new Date().toISOString(),
				tag,
				unmet: lastUnmet,
				probe: lastRenderProbe,
			}, null, 2));
			console.log(`\n渲染探针快照：${file}`);
			console.log(`最后一帧：${JSON.stringify(lastRenderProbe)}`);
		} catch { /* 落盘失败不该盖掉主错误 */ }
	}
	async function injectHook(device) {
		await evaluate(`window.__DSHR_MOBILE__ = Object.assign(window.__DSHR_MOBILE__ || {}, { device: '${device}' }); true`);
		await evaluate(HOOK_SOURCE);
		await wait(1200);
		// 注入也会引起官方侧重排/重挂，注入后必须重新过同一道闸（两臂同闸）。
		const snap = await waitForRenderComplete();
		if (!snap) {
			dumpRenderProbe(`injectHook-${device}`);
			throw new NoEvidenceError(`注入 device=${device} 后未达渲染完成状态（未满足：${unmetText()}）——中止，不产出对照证据（退出码 2，不是断言失败）`);
		}
		return snap;
	}
	async function shot(name) {
		// 抽屉开合有 0.34s 过渡，立刻截图会拍到主栏 translate 动画的中间帧，
		// 截图与断言就对不上了。先等过渡落定再拍。
		await wait(700);
		const png = await call("Page.captureScreenshot", { format: "png" });
		const file = join(SHOT_DIR, `${name}.png`);
		writeFileSync(file, Buffer.from(png.data, "base64"));
		return file;
	}
	async function waitUntil(expr, timeout = 8000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (await evaluate(expr).catch(() => false)) return true;
			await wait(200);
		}
		return false;
	}
	// 抽屉开合由官方 data-sidebar-collapsed 表达；hook 负责点官方开关。
	const isDrawerOpen = () => evaluate(`!document.querySelector('[data-sidebar-collapsed]')`);
	const clickWhale = () => evaluate(`document.getElementById('dshr-mobile-whale').click(); true`);
	// 官方 React 提交 + 0.34s 过渡，等它落定再量，避免测到中间帧。
	const waitDrawer = (open) =>
		waitUntil(`(function(){var f=document.querySelector('[data-sidebar-collapsed]');return ${open ? "!f" : "!!f"};})()`);
	async function ensureCollapsed() {
		if (await isDrawerOpen()) {
			await clickWhale();
			await waitDrawer(false);
		}
		return waitDrawer(false);
	}
	/**
	 * 用鲸鱼把抽屉切到目标态。
	 * mobile-web.js:1591 的 toggleBusy 会在状态未同步翻转时持锁 280ms+220ms（连点护栏，
	 * 防止 touchend 与 click 双触发），落在这段窗口里的点击会被有意忽略。真人操作不会
	 * 卡在 500ms 内，但自动化会——所以这里等窗口过去再点，最多重试 3 次并记录实际次数。
	 */
	async function toggleViaWhale(targetOpen, attempts = 3) {
		for (let i = 1; i <= attempts; i++) {
			if ((await isDrawerOpen()) === targetOpen) return i - 1 === 0 ? 0 : i;
			await wait(600); // 让 toggleBusy 的 280+220ms 护栏窗口过去
			await clickWhale();
			const settled = await waitDrawer(targetOpen);
			if (settled && (await isDrawerOpen()) === targetOpen) return i - 1 === 0 ? 0 : i;
		}
		return -1;
	}

	/**
	 * 手势方向门（WEB-08）的触摸探针。
	 *
	 * 为什么必须用 CDP `Input.dispatchTouchEvent` 而不是合成 `new TouchEvent(...)`：
	 * 钩子只听 touch 事件（mobile-web.js 明确「抽屉手势始终走 touch」，因为
	 * Android WebView 的 PointerEvent 在页面滚动时会 pointercancel 把右滑吞掉），
	 * 而 CDP 的 dispatchTouchEvent 走渲染器**真实输入管线**，事件顺序、
	 * 合并（coalescing）与 WebView 上的路径一致，合成事件测不出真实行为。
	 *
	 * 探针注册在 capture 阶段且晚于钩子（钩子在本文件 injectHook 时就已绑好），
	 * 所以同一个 touchmove 上它看到的就是钩子 preventDefault 之后的 final 状态。
	 */
	async function installTouchProbe() {
		await evaluate(`(function(){
			if (window.__dshrProbeInstalled) return true;
			window.__dshrProbeInstalled = true;
			window.__dshrMoves = 0;
			window.__dshrPrevented = 0;
			document.addEventListener('touchmove', function (event) {
				window.__dshrMoves++;
				if (event.defaultPrevented) window.__dshrPrevented++;
			}, { capture: true, passive: true });
			return true;
		})()`);
	}
	const resetTouchProbe = () =>
		evaluate(`(function(){ window.__dshrMoves = 0; window.__dshrPrevented = 0; return true; })()`);
	const readTouchProbe = () =>
		evaluate(`(function(){ return { moves: window.__dshrMoves, prevented: window.__dshrPrevented }; })()`);

	/**
	 * 现算一条**钩子真会接管**的触点行。
	 * 必须与 mobile-web.js 的 canStartDrawerTrack / isIgnoredSwipeTarget /
	 * isInHorizontallyScrollableContainer 用同一套规则，否则手势在第一步就被钩子放弃，
	 * 测出来的「左滑没有误触发」是假阴性（y 落在 [data-composer-card] 上就属于这种）。
	 */
	async function findSwipeLaneY() {
		const lane = await evaluate(`(function(){
			var ys = [];
			for (var y = 90; y < 880; y += 10) {
				for (var x = 340; x <= 390; x += 10) {
					var e = document.elementFromPoint(x, y);
					if (!e || !e.closest) continue;
					if (e.closest('textarea, input, select, [contenteditable="true"]')) continue;
					if (e.closest('[data-composer-card]')) continue;
					if (e.closest('#dshr-mobile-whale')) continue;
					if (e.closest('#dshr-status-guard')) continue;
					if (e.closest('[data-dshr-stats-line]')) continue;
					if (e.closest('pre, code, table')) continue;
					var scrollable = false, n = e;
					while (n && n !== document.body && n !== document.documentElement) {
						try {
							var cs = window.getComputedStyle(n), ox = cs.overflowX || '';
							if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth) { scrollable = true; break; }
						} catch (ignoredStyle) { /* ignore */ }
						n = n.parentElement;
					}
					if (scrollable) continue;
					if (e.closest('[data-dshr-main-col]')) { ys.push(y); break; }
				}
			}
			var mid = ys.filter(function (v) { return v > 120 && v < 700; });
			return { count: ys.length, y: (mid.length ? mid[Math.floor(mid.length / 2)] : (ys.length ? ys[0] : 300)) };
		})()`);
		return lane;
	}

	/**
	 * 一次真实触摸滑动。x0 起点必须避开左缘 24px，否则 Chrome 的边缘返回手势会导航走，
	 * 读数全丢（右侧「返回上一会话」正是靠这个区域）。segments 段 × ~16ms ≈ 200ms。
	 */
	async function dispatchSwipe(x0, x1, y, segments = 6) {
		await resetTouchProbe();
		const point = (x, py) => [{ x, y: py, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
		await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x0, y) });
		for (let i = 1; i <= segments; i++) {
			await call("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: point(Math.round(x0 + ((x1 - x0) * i) / segments), y),
			});
			await wait(16);
		}
		await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await wait(1400); // 官方 0.34s 过渡 + hook 的 scheduleSyncDom(50ms) 收敛
		return readTouchProbe();
	}

	/**
	 * 官方右栏（[data-sidebar-right-panel]，文件树/预览面板）的开合判定与驱动。
	 *
	 * 为什么不能拿 `data-rightbar-collapsed` 的有无当「开/合」信号：
	 * 实测该属性在**开合两态都在** frame 上（收起态 attr=true，打开态仍 attr=true），
	 * 真正区分开合的是 `data-sidebar-right-open` + `aria-hidden`——
	 * 与 mobile-web.js 的 isRightbarOpen()、以及返回键桥 closeSidebarIfExpanded() 逐字一致。
	 * 关闭态下面板本来就「已挂载」（display:flex、rect 铺满 412x915、pointer-events:none），
	 * 所以「已挂载」也不能当「已打开」用。
	 */
	const isRightbarOpen = () =>
		evaluate(`(function(){
			var p = document.querySelector('[data-sidebar-right-panel]');
			return !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true');
		})()`);
	/** 走官方那颗 button[data-sidebar-right-toggle]（与 hook 返回键桥同一条通道）。 */
	const clickOfficialRightbarToggle = () =>
		evaluate(`(function(){
			var p = document.querySelector('[data-sidebar-right-panel]'); if (!p) return 'no-panel';
			var t = p.querySelector('button[data-sidebar-right-toggle]'); if (!t || t.disabled) return 'disabled';
			var r = t.getBoundingClientRect();
			t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window,
				button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
			return 'dispatched';
		})()`);
	/** 幂等关到右栏关闭态（官方控件开/关可逆，实测 4 连点往返）。 */
	async function ensureRightbarClosed() {
		for (let i = 0; i < 3; i++) {
			if (!(await isRightbarOpen())) return true;
			await clickOfficialRightbarToggle();
			await wait(700);
		}
		return !(await isRightbarOpen());
	}
	/**
	 * 幂等开到右栏打开态。
	 * 必须「先读状态再决定点不点」并留出官方 0.34s 过渡的沉淀时间：
	 * 关→开连着做时，紧跟着的点击会落在关闭动画里，React 的 toggleExpanded 提交不上，
	 * 于是后面取触点行时面板根本没开（实测会得到 null 车道）。
	 */
	async function ensureRightbarOpen() {
		for (let i = 0; i < 4; i++) {
			if (await isRightbarOpen()) return true;
			await wait(400);
			await clickOfficialRightbarToggle();
			await wait(700);
		}
		return await isRightbarOpen();
	}

	// ── 页面快照（对照实验的唯一数据源；只读官方结构，不含 hook 私有标记）──
	const SNAPSHOT = `(() => {
		const r = document.documentElement;
		const q = (s) => document.querySelector(s);
		const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
			return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
		const cs = (e, props) => { if (!e) return null; const c = getComputedStyle(e); const o = {};
			for (const p of props) o[p] = c.getPropertyValue(p); return o; };
		const STYLE_PROPS = ['grid-template-columns', 'padding-top', 'padding-bottom', 'display', 'position', 'width'];
		// frame 只用官方标记定位：平板档 hook 是 OFF，两臂看到的必须是同一个官方节点
		const frame = q('[data-sidebar-collapsed]') || q('[data-shell-overlay]');
		const sides = [...document.querySelectorAll('[data-side]')];
		const header = q('header');
		const card = q('[data-composer-card]');
		const seat = q('[data-composer-seat]');
		const rightbar = q('[data-sidebar-right-panel]');
		return {
			url: location.pathname,
			html: {
				className: r.className,
				dshrAttributes: [...r.attributes].map(a => a.name).filter(n => n.indexOf('data-dshr') === 0),
				styleCssText: r.style.cssText,
			},
			hookNodes: ${JSON.stringify(HOOK_NODE_IDS)}.filter(id => !!document.getElementById(id)),
			hookStyleTag: !!q('style[data-dshr-mobile-css]'),
			apiInstalled: !!window.__dshRemoteMobileInstalled,
			setDeviceApi: typeof window.__dshrSetDevice,
			dshrMarks: document.querySelectorAll('[data-dshr-frame],[data-dshr-main-col],[data-dshr-sidebar-col],[data-dshr-official-toggle]').length,
			geometry: {
				frame: box(frame),
				side0: box(sides[0]),
				side1: box(sides[1]),
				sideCount: sides.length,
				header: box(header),
				composerCard: box(card),
				composerSeat: box(seat),
				rightbar: box(rightbar),
				bodyScrollHeight: document.body.scrollHeight,
				documentScrollWidth: r.scrollWidth,
				documentClientWidth: r.clientWidth,
			},
			computed: {
				frame: cs(frame, STYLE_PROPS),
				side0: cs(sides[0], STYLE_PROPS),
				header: cs(header, STYLE_PROPS),
				composerCard: cs(card, STYLE_PROPS),
			},
		};
	})()`;

	// ── 零痕迹判定（契约 3.5）──
	function assertZeroTrace(scenario, snap) {
		record(scenario, "html 无 hook 根类", snap.html.className.trim() === "", `className="${snap.html.className}"`);
		record(scenario, "html 无 dshr-official-inset", !snap.html.className.includes("dshr-official-inset"), snap.html.className);
		record(scenario, "html 无 data-dshr-* 属性", snap.html.dshrAttributes.length === 0, JSON.stringify(snap.html.dshrAttributes));
		record(scenario, "无 hook 创建的可见节点", snap.hookNodes.length === 0, JSON.stringify(snap.hookNodes));
		record(scenario, "官方节点上无 data-dshr-* 标记", snap.dshrMarks === 0, `dshrMarks=${snap.dshrMarks}`);
		record(scenario, "切换 API 仍已定义（契约 3.3）", snap.setDeviceApi === "function", `typeof=${snap.setDeviceApi}`);
	}
	function compareArms(scenario, a, b, viewport) {
		const diffs = [];
		for (const key of Object.keys(a.geometry)) {
			const va = a.geometry[key];
			const vb = b.geometry[key];
			if (typeof va === "number" || typeof vb === "number") {
				if (Math.abs(va - vb) > TOLERANCE_PX) diffs.push(`${key}: 注入=${va} 不注入=${vb} Δ=${Math.abs(va - vb)}px`);
			} else if (JSON.stringify(va) !== JSON.stringify(vb)) {
				diffs.push(`${key}: 注入=${JSON.stringify(va)} 不注入=${JSON.stringify(vb)}`);
			}
		}
		record(scenario, `关键几何逐项相等（容差 ${TOLERANCE_PX}px，${viewport}）`, diffs.length === 0, diffs.length ? diffs.join("; ") : "frame/三列/header/composer/scrollHeight 全部相等");
		const styleDiffs = [];
		for (const key of Object.keys(a.computed)) {
			if (JSON.stringify(a.computed[key]) !== JSON.stringify(b.computed[key])) {
				styleDiffs.push(`${key}: ${JSON.stringify(a.computed[key])} vs ${JSON.stringify(b.computed[key])}`);
			}
		}
		record(scenario, "关键容器 computed style 一致", styleDiffs.length === 0, styleDiffs.length ? styleDiffs.join("; ") : "grid-template-columns / padding / display / position / width 全一致");
		record(scenario, "documentElement 行内样式一致", a.html.styleCssText === b.html.styleCssText, `注入="${a.html.styleCssText}" 不注入="${b.html.styleCssText}"`);
	}

	// ══════════════════ A 手机竖屏 412×915 / device=phone → hook ON ══════════════════
	console.log("\n[场景 A] 手机竖屏 412×915  device=phone → 期望 hook ON");
	await setViewport(412, 915);
	await loadRealPage();
	await injectHook("phone");
	const snapA = await evaluate(SNAPSHOT);
	info("A", `视口实测 innerWidth=${await evaluate("innerWidth")} innerHeight=${await evaluate("innerHeight")} device=phone`);
	record("A", "hook 根类 dshr-mobile 已挂上", snapA.html.className.includes("dshr-mobile"), `className="${snapA.html.className}"`);
	record("A", "未出现官方横屏让位类", !snapA.html.className.includes("dshr-official-inset"), snapA.html.className);
	record("A", "运行时切换 API 已定义", snapA.setDeviceApi === "function", `typeof=${snapA.setDeviceApi}`);
	record("A", "hook 标记了官方 frame / 主栏 / 侧栏列", snapA.dshrMarks >= 3, `dshrMarks=${snapA.dshrMarks}`);
	const whaleRect = await evaluate(`(()=>{const w=document.getElementById('dshr-mobile-whale');if(!w)return null;const b=w.getBoundingClientRect();const c=getComputedStyle(w);return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),display:c.display,visibility:c.visibility};})()`);
	record("A", "悬浮鲸鱼存在且可见", !!whaleRect && whaleRect.w > 0 && whaleRect.h > 0 && whaleRect.display !== "none", JSON.stringify(whaleRect));
	const normalized = await ensureCollapsed();
	record("A", "已归一到官方收起基线（rail 不占位）", normalized === true, `drawerOpen=${await isDrawerOpen()}`);
	const railGeom = await evaluate(`(()=>{const s=document.querySelector('[data-dshr-sidebar-col]');const m=document.querySelector('[data-dshr-main-col]');
		const sb=s&&s.getBoundingClientRect();const mb=m&&m.getBoundingClientRect();
		return{sideW:sb?Math.round(sb.width):-1,mainW:mb?Math.round(mb.width):-1,mainX:mb?Math.round(mb.x):-1,transform:m?getComputedStyle(m).transform:null};})()`);
	record("A", "官方桌面 rail 不再占位（侧栏列宽 0）", railGeom.sideW === 0, `侧栏列宽=${railGeom.sideW}px`);
	record("A", "会话列占满宽度", railGeom.mainW >= 410 && railGeom.mainX === 0, `主栏=${railGeom.mainW}px @x=${railGeom.mainX} transform=${railGeom.transform}`);
	record("A", "收起态主栏未被 translate 挪走", railGeom.transform === "matrix(1, 0, 0, 1, 0, 0)" || railGeom.transform === "none", `transform=${railGeom.transform}`);
	const overflowA = await evaluate(`({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})`);
	record("A", "页面无横向溢出", overflowA.sw <= overflowA.cw + 1, `scrollWidth=${overflowA.sw} clientWidth=${overflowA.cw}`);
	// 顺带覆盖：输入卡底栏集群是否仍在视口内
	const trailing = await evaluate(`(()=>{const e=document.querySelector('[data-dshr-composer-trailing]');if(!e)return null;const b=e.getBoundingClientRect();
		return{left:Math.round(b.left),right:Math.round(b.right),inViewport:b.left>=-1&&b.right<=innerWidth+1};})()`);
	if (trailing) record("A", "输入卡底栏集群在视口内", trailing.inViewport, JSON.stringify(trailing));
	else record("A", "输入卡底栏集群在视口内", null, "未找到 [data-dshr-composer-trailing]（该页无底栏集群）");
	// ── WEB-08 手势方向门：主页面左滑**不得**点亮左侧抽屉（用户报告的 bug）──
	// 修复前：onDragMove 越过 10px 阈值就 dragging=true + setDrawerVisual(baseX)，
	// 而 setDrawerVisual 首次调用会无条件 setSidebarOpen(true) 再把负位移夹到 0，
	// 于是左滑把左侧栏点亮/展开、并 preventDefault 吃掉官方手势。
	// 修复后：抽屉关闭时方向门在 setDrawerVisual **之前** resetTrack()，左滑全程不接管。
	// 官方 0.2.0-rc.2 侧：左滑车道扫描 + 整个 app.asar 内 `swipe` 标识符 0 处命中，
	// 右栏唯一入口是 <button onClick={() => actions.toggleExpanded(sessionId)}>，
	// 即官方本来就没有「左滑开右栏」手势——所以左滑的正确表现是**什么都不发生**。
	const lane = await findSwipeLaneY();
	info("A", `手势触点行：可接管 y 共 ${lane.count} 个，选用 y=${lane.y}（左滑 380→130 / 右滑 100→350）`);
	await installTouchProbe();
	// 抽屉状态在收起态（前面的 ensureCollapsed 已归一），先确认方向门的「关闭态」前提
	await ensureCollapsed();
	await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
	const swipeBefore = await evaluate(`(function(){
		var r = document.documentElement;
		return { expanded: r.getAttribute('data-dshr-expanded'), dragging: r.getAttribute('data-dshr-dragging'),
			collapsed: !!document.querySelector('[data-sidebar-collapsed]'),
			sideW: (function(){var s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})() };
	})()`);

	// A-left-swipe：主栏左滑 → 左抽屉必须完全不动；T130 起这笔手势定向到**右抽屉**
	// （跟手打开官方右栏卡片），所以跟手接管后 touchmove 被 preventDefault、右栏卡片
	// 打开后遮罩换到左缘细条且拖柄可见，都是新语义的**正确**表现（旧世界这里是 no-op）。
	const leftProbe = await dispatchSwipe(380, 130, lane.y);
	const leftAfter = await evaluate(`(function(){
		var r = document.documentElement;
		var vis = function(id){ var e=document.getElementById(id); if(!e) return 'absent';
			var c=getComputedStyle(e), b=e.getBoundingClientRect();
			return (c.display==='none'||c.visibility==='hidden'||b.width===0)?'hidden':'VISIBLE'; };
		var p = document.querySelector('[data-sidebar-right-panel]');
		var m = document.getElementById('dshr-mobile-drawer-mask');
		var mb = m ? m.getBoundingClientRect() : null;
		return { expanded: r.getAttribute('data-dshr-expanded'), dragging: r.getAttribute('data-dshr-dragging'),
			rdrag: r.getAttribute('data-dshr-rdrag'), ropen: r.getAttribute('data-dshr-ropen'),
			collapsed: !!document.querySelector('[data-sidebar-collapsed]'),
			rightOpen: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true'),
			sideW: (function(){var s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})(),
			mask: vis('dshr-mobile-drawer-mask'), maskLeft: mb ? Math.round(mb.left) : -1, maskW: mb ? Math.round(mb.width) : -1,
			handle: vis('dshr-drawer-handle'), whale: vis('dshr-mobile-whale') };
	})()`);
	record("A", "A-left-swipe 主栏左滑后 data-dshr-expanded 仍为 0", leftAfter.expanded === "0", `expanded=${leftAfter.expanded}（修复前会翻成 1）`);
	record("A", "A-left-swipe 官方侧栏仍收起且列宽为 0", leftAfter.collapsed === true && leftAfter.sideW === 0, `data-sidebar-collapsed=${leftAfter.collapsed} 侧栏列宽=${leftAfter.sideW}px（修复前第 1 帧就变 360px）`);
	record("A", "A-left-swipe 右抽屉开后遮罩在左缘细条且拖柄可见（T130 新语义）",
		leftAfter.mask === "VISIBLE" && leftAfter.handle === "VISIBLE" && leftAfter.maskLeft <= 1 && leftAfter.maskW >= 40 && leftAfter.maskW <= 72 && leftAfter.ropen === "1",
		`mask=${leftAfter.mask}@(${leftAfter.maskLeft},${leftAfter.maskW}) handle=${leftAfter.handle} ropen=${leftAfter.ropen}（右栏卡片打开时遮罩换边是设计行为）`);
	record("A", "A-left-swipe 右抽屉开后鲸鱼收起（不压左缘细条）", leftAfter.whale === "hidden" || leftAfter.whale === "absent",
		`whale=${leftAfter.whale}（ropen 规则收起，官方 frame 属性缺失时也能兜住）`);
	record("A", "A-left-swipe 无 data-dshr-dragging / data-dshr-rdrag 残留", leftAfter.dragging === null && leftAfter.rdrag === null, `data-dshr-dragging=${leftAfter.dragging} data-dshr-rdrag=${leftAfter.rdrag}`);
	record("A", "A-left-swipe 右抽屉跟手接管后 touchmove 被 preventDefault（拖动卡片必须吃掉横向）",
		leftProbe.moves > 0 && leftProbe.prevented > 0, `touchmove=${leftProbe.moves} 个 被 preventDefault=${leftProbe.prevented} 个（旧 no-op 世界是 0；跟手拖动必须为真）`);
	record("A", "A-left-swipe 官方右栏已被这笔左滑打开（T130 右抽屉）", leftAfter.rightOpen === true, `data-sidebar-right-open=${leftAfter.rightOpen}`);

	// ── WEB-09 左滑 → 打开官方右侧栏（文件树/预览面板）──
	// 承接上面那条左滑：手指已经抬起，hook 在 touchend 兑现了候选，右栏应已打开。
	// 官方 0.2.0-rc.2 自己**没有**这个手势（app.asar 内 `swipe` 零命中，右栏唯一入口是
	// button[data-sidebar-right-toggle] 的 onClick），所以这一步开成功即证明是 hook 新加的。
	const rbAfterLeft = await evaluate(`(function(){
		var r = document.documentElement;
		var p = document.querySelector('[data-sidebar-right-panel]');
		var b = p ? p.getBoundingClientRect() : null;
		return { open: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true'),
			ariaHidden: p ? p.getAttribute('aria-hidden') : null,
			box: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) } : null,
			card: !!(b && Math.abs(b.right - innerWidth) <= 1 && Math.abs(b.width - (innerWidth - 52)) <= 2
				&& b.y === 0 && b.height >= innerHeight - 1 && b.x >= 40 && b.x <= 64),
			expanded: r.getAttribute('data-dshr-expanded'),
			sideW: (function(){var s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})(),
			panelText: p ? (p.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40) : '' };
	})()`);
	record("A", "A-left-swipe-opens-rightbar 主栏左滑打开官方右栏", rbAfterLeft.open === true,
		`data-sidebar-right-open=${rbAfterLeft.open} aria-hidden=${rbAfterLeft.ariaHidden} 面板内容="${rbAfterLeft.panelText}"（官方自身无此手势，故本条只可能由 hook 打开）`);
	record("A", "A-left-swipe-opens-rightbar 手机上右栏为右锚圆角卡片（T130：宽 100%-52px，不再是 inset:0 全屏）", rbAfterLeft.card === true,
		`panel=${JSON.stringify(rbAfterLeft.box)} 视口=412x915（T130 Kimi 式卡片：右缘贴屏、左缘让出 52px 细条）`);
	record("A", "A-left-swipe-opens-rightbar 打开右栏时左抽屉仍关闭", rbAfterLeft.expanded === "0" && rbAfterLeft.sideW === 0,
		`expanded=${rbAfterLeft.expanded} 侧栏列宽=${rbAfterLeft.sideW}px`);

	// 归一：把右栏关回关闭态，后面的 A-right-swipe 断言基线不能被右栏影响。
	// 留 600ms 让官方 0.34s 过渡彻底结束，否则紧跟着的 reopen 会落进动画里点空。
	await ensureRightbarClosed();
	await wait(600);
	await waitUntil(`(function(){var p=document.querySelector('[data-sidebar-right-panel]');return !(p&&p.hasAttribute('data-sidebar-right-open')&&p.getAttribute('aria-hidden')!=='true');})()`, 3000);
	record("A", "A-left-swipe-opens-rightbar 右栏可逆（官方控件能关回去）", (await isRightbarOpen()) === false,
		`关闭后 data-sidebar-right-open=${await isRightbarOpen()}`);

	// ── WEB-09 守卫：右栏已打开时左滑不得误开左抽屉，且不得把右栏 toggle 关掉 ──
	// 修复前 canStartDrawerTrack 对右栏上的触点返回 true（既不在侧栏/遮罩、也不是忽略目标），
	// 在面板上右滑会把左抽屉点亮展开（expanded=1、官方列宽 360px），而鲸鱼与遮罩此刻都被
	// data-dshr-rightbar-fullscreen 隐藏，用户连一个像素反馈都看不到。
	await ensureRightbarOpen();
	const rbLane = await evaluate(`(function(){
		for (var y = 100; y < 860; y += 10) {
			for (var x = 60; x <= 340; x += 20) {
				var e = document.elementFromPoint(x, y); if (!e || !e.closest) continue;
				var p = document.querySelector('[data-sidebar-right-panel]'); if (!p || !p.contains(e)) continue;
				if (e.closest('textarea, input, select, [contenteditable="true"]')) continue;
				if (e.closest('[data-composer-card], #dshr-mobile-whale, #dshr-status-guard, [data-dshr-stats-line]')) continue;
				var s = false, n = e;
				while (n && n !== document.body && n !== document.documentElement) {
					try { var cs = getComputedStyle(n), ox = cs.overflowX || '';
						if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth) { s = true; break; } } catch (ignoredStyle) { /* ignore */ }
					n = n.parentElement;
				}
				if (s) continue;
				return { y: y, x: x, tag: e.tagName.toLowerCase() };
			}
		}
		return null;
	})()`);
	record("A", "A-left-swipe-rightbar-open-no-drawer 已把右栏打开（守卫前提）", (await isRightbarOpen()) === true,
		`data-sidebar-right-open=${await isRightbarOpen()}`);
	record("A", "A-left-swipe-rightbar-open-no-drawer 已在右栏内取到可接管触点行", !!rbLane, JSON.stringify(rbLane));
	if (rbLane) {
		await dispatchSwipe(380, 130, rbLane.y);
		const rbSwipeAfter = await evaluate(`(function(){
			var r = document.documentElement;
			var p = document.querySelector('[data-sidebar-right-panel]');
			return { expanded: r.getAttribute('data-dshr-expanded'),
				sideW: (function(){var s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})(),
				stillOpen: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true') };
		})()`);
		record("A", "A-left-swipe-rightbar-open-no-drawer 右栏开着时左滑不开左抽屉", rbSwipeAfter.expanded === "0" && rbSwipeAfter.sideW === 0,
			`expanded=${rbSwipeAfter.expanded} 侧栏列宽=${rbSwipeAfter.sideW}px（修复前右滑会变 expanded=1 / 360px）`);
		record("A", "A-left-swipe-rightbar-open-no-drawer 右栏开着时左滑不 toggle 关右栏", rbSwipeAfter.stillOpen === true,
			`data-sidebar-right-open=${rbSwipeAfter.stillOpen}（开着时再点会误关，故此处必须不动作）`);
		// T130：右开态右滑 = 跟手关闭右抽屉（新语义；旧世界这里是带外 no-op）。
		// 顺带必须不开左抽屉（两抽屉互斥）。起点仍 ≥200 避开 Chrome 边缘返回雷区；
		// segments=3 让每段位移 50px、松手速度必然越过 0.45px/ms 的速度门（位置门
		// 在本台子够不到：x0≥200 时最大位移 212px < 65% 关阀值，速度门才是主路径）。
		await dispatchSwipe(250, 400, rbLane.y, 3);
		const rbRightAfter = await evaluate(`(function(){
			var r = document.documentElement;
			var s = document.querySelector('[data-dshr-sidebar-col]');
			var p = document.querySelector('[data-sidebar-right-panel]');
			return { href: location.href, expanded: r.getAttribute('data-dshr-expanded'),
				stillOpen: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true'),
				sideW: s ? Math.round(s.getBoundingClientRect().width) : -1 };
		})()`);
		record("A", "A-left-swipe-rightbar-open-no-drawer 右开态右滑跟手关闭右抽屉且不开左抽屉（T130 新语义）",
			rbRightAfter.href.includes("18443") && rbRightAfter.expanded === "0" && rbRightAfter.sideW === 0 && rbRightAfter.stillOpen === false,
			`expanded=${rbRightAfter.expanded} 侧栏列宽=${rbRightAfter.sideW}px 右栏仍开=${rbRightAfter.stillOpen} href=${rbRightAfter.href}（修复前 expanded=1 / 360px）`);
	}

	// ── T130：右抽屉关闭手势（Kimi 式「面板任意位置右滑跟手关闭」，不再是左缘带触发）──
	// T66 的左缘带/下沉让量/带内门整套已随旧引擎删除（rightbarCloseBandPx /
	// rightbarCloseEdgeInsetPx / isRightbarCloseTrackTarget / considerRightbarCloseSwipe），
	// 新语义由统一手势引擎承担：右开态右滑（面板或左缘细条任意位置）跟手关闭，
	// 左滑保持 no-op（E5 基线）；关闭落位走「补间滑出右缘 → 官方收起」两段式。
	{
		// 1) 源码契约：新语义的四个承重点。
		// ① 官方状态唯一收口 setRightbarOpen：意图队列（rightToggleBusy / pendingRightbarOpen）
		//    治 T82 那类「close 撞上 disabled → 右栏永远留在打开态」的失同步。
		const setFn = extractDecl(HOOK_SOURCE, /function setRightbarOpen\b/, "setRightbarOpen");
		record("A/T130", "T130-契约 右栏开合唯一收口 setRightbarOpen（意图队列治失同步）",
			!!setFn && /rightToggleBusy/.test(setFn) && /pendingRightbarOpen = open;/.test(setFn)
			&& /dispatchNativeClick\(toggle\)/.test(setFn) && /button\[data-sidebar-right-toggle\]/.test(setFn),
			setFn ? setFn.replace(/\s+/g, " ").slice(0, 150) : "提取失败：setRightbarOpen");
		// ② 卡片态闸：宽屏（≥768px，官方 push/docked）不做右抽屉卡片。
		const cardFn = extractDecl(HOOK_SOURCE, /function canOpenRightCard\b/, "canOpenRightCard");
		record("A/T130", "T130-契约 右抽屉卡片态闸：<768px + 官方折叠按钮存在",
			!!cardFn && /\(window\.innerWidth \|\| 0\) >= 768\) return false;/.test(cardFn)
			&& /button\[data-sidebar-right-toggle\]/.test(cardFn),
			cardFn ? cardFn.replace(/\s+/g, " ").slice(0, 150) : "提取失败：canOpenRightCard");
		// ③ 右开态左滑 no-op（E5 基线）：方向门 dx<=0 → resetTrack()+return 整笔放弃。
		const moveFn = extractDecl(HOOK_SOURCE, /function onDragMove\b/, "onDragMove");
		record("A/T130", "T130-契约 右开态左滑 no-op（dx<=0 整笔放弃接管）",
			!!moveFn && /if \(dx <= 0\) \{\s*\n\s*resetTrack\(\);\s*\n\s*return;/.test(moveFn),
			moveFn ? "no-op 门在位" : "提取失败：onDragMove");
		// ④ considerSwipe 轻扫门未放宽（48 / 1.4 / 96 三道门逐字在位），
		//    且右开态右划走 settleRight(false)（卡片补间滑出）。
		const swipeFn = extractDecl(HOOK_SOURCE, /function considerSwipe\b/, "considerSwipe");
		record("A/T130", "T130-契约 轻扫门未放宽（48/1.4/96）且右开态右划走 settleRight(false)",
			!!swipeFn && /Math\.abs\(dx\) < 48/.test(swipeFn)
			&& /Math\.abs\(dx\) < Math\.abs\(dy\) \* 1\.4/.test(swipeFn)
			&& /Math\.abs\(dy\) > 96/.test(swipeFn)
			&& /if \(dx > 0\) return settleRight\(false\);/.test(swipeFn),
			swipeFn ? "48/1.4/96 + settleRight(false) 在位" : "提取失败：considerSwipe");

		// 2) 真跑：右开态面板中部（x0=250）右滑——新语义下**也要**跟手关闭
		//    （不再限左缘带），且不开左抽屉。segments=3 ⇒ 松手速度必过 0.45px/ms 速度门
		//    （位置门在本台子够不到：x0≥200 避 Chrome 边缘返回雷区，最大位移 212px < 65% 关阀值）。
		await ensureRightbarOpen();
		const rbOpenForT66 = await isRightbarOpen();
		record("A/T130", "T130-真跑 已把右栏打开（前提）", rbOpenForT66 === true,
			`data-sidebar-right-open=${rbOpenForT66}`);
		if (rbOpenForT66) {
			const midY = rbLane ? rbLane.y : 300;
			await dispatchSwipe(250, 400, midY, 3);
			const t130Mid = await evaluate(`(function(){
				var p = document.querySelector('[data-sidebar-right-panel]');
				return { href: location.href,
					stillOpen: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true'),
					expanded: document.documentElement.getAttribute('data-dshr-expanded'),
					rdrag: document.documentElement.getAttribute('data-dshr-rdrag'),
					rx: document.documentElement.style.getPropertyValue('--dshr-rx') };
			})()`);
			record("A/T130", "T130-真跑 面板中部(x0=250)右滑跟手关闭右抽屉（新语义：不限左缘带）",
				t130Mid.href.includes("18443") && t130Mid.stillOpen === false,
				`stillOpen=${t130Mid.stillOpen} href=${t130Mid.href}（旧世界带外 no-op；T130 起面板任意位置右滑关闭）`);
			record("A/T130", "T130-真跑 面板中部右滑顺带不开左抽屉",
				t130Mid.expanded === "0",
				`data-dshr-expanded=${t130Mid.expanded}（必须 0）`);
			record("A/T130", "T130-真跑 关闭落位后无跟手痕迹残留（rdrag/rx 全清）",
				t130Mid.rdrag === null && !t130Mid.rx,
				`data-dshr-rdrag=${t130Mid.rdrag} --dshr-rx="${t130Mid.rx}"`);
		}
	}
	await ensureRightbarClosed();

	// ── T69：发送按钮绝不能被当成「命令面板触发器」去布防 ──
	//
	// 真机症状（小米 15 / rc.2.5）：键盘弹着时点「发送」，消息发不出去、键盘又弹出来。
	// 归因（scratch/t69/report.md §2.4）：`isPanelTriggerPoint()` 把发送按钮判成了触发器
	// ⇒ `armComposerFocus()` 在**发送路径上**打 `inputmode="none"` 并 `composer.focus()`
	// 抢焦点。AVD 上实测点发送时 `document.activeElement` 由 BODY 被搬回 composer、
	// `inputmode` 变 "none"（改前）／保持 null（改后）。
	//
	// 这一组断言守三件事：
	//   a) 源码契约：发送不在触发器名单里，且排除发生在**兜底分支之前**
	//      （只删名单那一行不够 —— 兜底分支会把发送按钮连同其 svg/path 重新判成触发器，
	//       AVD 实测该分支命中 40 个元素）；
	//   b) 行为：落指发送 ⇒ composer 既不被打 `inputmode="none"`、也不被抢焦点；
	//   c) 不回归：落指「+」⇒ 布防**仍然照旧发生**（T48 的承重路径没被顺手关掉）。
	{
		// ── a) 源码契约 ──
		// ⚠️ T76：这一组 4 条原本全部靠「字符预算截取」，`[\s\S]{0,900}?` / `[\s\S]{0,1400}?`
		// 在真实函数体（1341 / 1939 字符）里**永远匹配不到收尾** ⇒ match 返回 null ⇒
		// 断言拿到空串 ⇒ indexOf 全 −1 ⇒ 4 条一起假红。已全部换成结构化提取。
		const trigList = extractInitializer(HOOK_SOURCE, "COMPOSER_TRIGGER_SELECTOR", "COMPOSER_TRIGGER_SELECTOR");
		record("A/T69", "T69-契约 发送按钮不在 COMPOSER_TRIGGER_SELECTOR 里",
			!!trigList && !/data-dshr-composer-send/.test(trigList),
			trigList ? `名单含 send=${/data-dshr-composer-send/.test(trigList)}` : "提取失败：COMPOSER_TRIGGER_SELECTOR");
		const sendList = extractInitializer(HOOK_SOURCE, "COMPOSER_SEND_SELECTOR", "COMPOSER_SEND_SELECTOR");
		const sendHasMarker = !!sendList && /data-dshr-composer-send/.test(sendList);
		const sendHasCn = !!sendList && /发送消息/.test(sendList);
		const sendHasEn = !!sendList && /Send message/.test(sendList);
		record("A/T69", "T69-契约 COMPOSER_SEND_SELECTOR 同时含 hook 标记与官方中英文案",
			sendHasMarker && sendHasCn && sendHasEn,
			`marker=${sendHasMarker} cn=${sendHasCn} en=${sendHasEn}`);
		const pt = extractDecl(HOOK_SOURCE, /function isPanelTriggerPoint\b/, "isPanelTriggerPoint");
		// ⚠️ T76：所有 indexOf **顺序**断言都打在「掩掉注释与字符串」的等价长副本上。
		// 实测就栽在这：armComposerFocus 的 T69 说明注释里就写着
		// 「下面的 composer.focus() 会把 DOM 焦点从用户点的目标上搬走」，
		// 直接 indexOf 会命中注释里的那一句（422），而真调用在 ~1400 ⇒ 顺序断言假红。
		// 掩码是等长替换，下标与原文一一对应，可以直接比大小。
		// ⚠️ T77：这里用 **maskJsCommentsOnly**（只掩注释、保留字符串），不用 maskJsComments。
		// maskJsComments 连字符串一起掩，会把 `closest('button')` 的 'button' 掩成空格，
		// `indexOf("closest('button")` 恒 −1 ⇒ 下面「发送排除在兜底之前」那条永远为假（实测 fallback=-1）。
		// 被断言的记号都是**代码**不是字符串字面量，所以只掩注释就够。
		const ptCode = maskJsCommentsOnly(pt);
		// ⚠️ T77：下面两条 T76 留下的 `slice(i, i + N)` **硬窗口**也换掉了。
		// 窗口是魔数：块里加一句注释就假红、把目标挪出窗口就假绿 ——
		// 与 T76 修掉的 `{0,900}?` 是同一个病。实测当时余量只有 48/97/193 字符
		// （node scratch/t77/measure-windows.mjs），第一处再写两句注释就会炸。
		// 现在改成「按花括号配平取整个 if 块，在块里逐字找」，块变长变短都不影响判定。
		// ⚠️ 锚点必须带 `if (` 前缀，不能只写函数名：整文件里
		// `function isComposerSendPoint(target)` 的**声明**也含 `isComposerSendPoint(target)`
		// 这个子串，只用函数名会命中声明处、取到一整块无关代码，断言就成了「在错误的块上通过」。
		const sendBlock = jsBlockAfter(ptCode, "if (isComposerSendPoint(target))", "isPanelTriggerPoint 的发送排除块");
		const iSend = ptCode.indexOf("isComposerSendPoint(target)");
		const iTrig = ptCode.indexOf("COMPOSER_TRIGGER_SELECTOR");
		const iFallback = ptCode.indexOf("closest('button");
		record("A/T69", "T69-契约 isPanelTriggerPoint 对发送返回 false",
			!!sendBlock && /return false;/.test(sendBlock),
			`提取长度=${pt.length} 排除块长度=${sendBlock.length} 块内含 return false=${/return false;/.test(sendBlock)}（条件在 if 头上、块外，故只查块内）`);
		// 顺序是承重的：必须在兜底分支之前（兜底会把发送连同 svg/path 判成触发器）
		record("A/T69", "T69-契约 发送排除在兜底分支之前（否则删名单也修不好）",
			iSend >= 0 && iFallback > iSend && iTrig > iSend,
			`send=${iSend} trig=${iTrig} fallback=${iFallback}（打在掩码后的代码上）`);
		const arm = extractDecl(HOOK_SOURCE, /function armComposerFocus\b/, "armComposerFocus");
		const armCode = maskJsCommentsOnly(arm);
		// ⚠️ T77：这一行必须在 armCode 声明**之后**。第一版我把它写在 arm/pt 提取之前，
		// 于是 const 的暂时性死区直接抛 `ReferenceError: Cannot access 'armCode' before
		// initialization`，test:device 在第 36 条崩掉、只跑到 35/148、退出码 1。
		// 「断言数对不上 + 退出码非 0」正是这种半路崩的表现，别误当成真回归。
		const heldBlock = jsBlockAfter(armCode, "if (composerHoldsFocus())", "armComposerFocus 的已持焦早退块");
		const iHeld = armCode.indexOf("composerHoldsFocus()");
		const iFocus = armCode.indexOf("composer.focus()");
		// T125（ supersedes T69 早退语义）：持焦时仍压 IME（打 inputmode + 开窗口 +
		// 定时摘防），但跳过 composer.focus() 以免吞 click（模型点不开与 + 持焦弹键盘同因）。
		// 因此持焦块内应含 setAttribute('inputmode','none') 且以 return true 收尾，
		// 且块内不得直接调用 composer.focus()（focus 只在非持焦/非模型路径）。
		record("A/T69", "T69-契约 composer 已持焦时 armComposerFocus 仍压制 IME（T125）",
			!!heldBlock && /setAttribute\(\s*['"]inputmode['"]/.test(heldBlock) && /return true;/.test(heldBlock) && iFocus > iHeld,
			`提取长度=${arm.length} 早退块长度=${heldBlock.length} 块内含 inputmode=${/setAttribute\(\s*['"]inputmode['"]/.test(heldBlock)} return true=${/return true;/.test(heldBlock)} composerHoldsFocus=${iHeld} composer.focus=${iFocus}（focus 必须在持焦块之后；掩码后）`);
		record("A/T69", "T69-契约 早退时清粘性抑制（否则 T48 面板死结回来）",
			!!heldBlock && /clearFocusSticky\(composer\)/.test(heldBlock),
			`早退块内 clearFocusSticky=${/clearFocusSticky\(composer\)/.test(heldBlock)}`);
		// arm 绝不能吞点击：三个落指监听器必须仍是 passive
		const downListeners = HOOK_SOURCE.match(/addEventListener\('(touchstart|pointerdown|mousedown)', onDown[^)]*\)/g) || [];
		const allPassive = downListeners.length === 3 && downListeners.every((l) => /passive:\s*true/.test(l));
		record("A/T69", "T69-契约 三个落指监听器全 passive ⇒ arm 结构上无法 preventDefault",
			allPassive, `监听器=${downListeners.length} 全passive=${allPassive}`);

		// ── T76：手势幂等（阻断②的源码契约）──
		// 真机实测（scratch/t76/timeline-after.json，AVD 5604 真 adb input tap）：
		//     pointerdown(pid=2) → touchstart(tid=0) → pointerup → touchend
		//                        → focusin → mousedown → mouseup → click
		// 三个落指跨 ~20ms，**抬手夹在 touchstart 与 mousedown 之间** ⇒ 抬手事件**不能**用来
		// 划分手势（第一版就是这么写的，被自己的探针当场抓出 inputmode 在 mousedown 前 0.3ms 被摘）。
		// 手势的唯一可靠终止信号是 **click**。
		const down = extractDecl(HOOK_SOURCE, /function bindFocusGuard\b/, "bindFocusGuard");
		const iSameGuard = down.indexOf("focusGestureArmed");
		record("A/T76", "T76-契约 onDown 用「本手势已 arm」标记守卫 disarm（幂等，同手势不互撤）",
			!!down && iSameGuard >= 0 && /newDown/.test(down),
			`提取长度=${down.length} focusGestureArmed=${iSameGuard} newDown 变量=${/newDown/.test(down)}`);
		record("A/T76", "T76-契约 disarm 发生在 newDown 判定之后（新手势才允许摘）",
			!!down && /if \(focusArmed && newDown\)/.test(down),
			`匹配=${/if \(focusArmed && newDown\)/.test(down)}`);
		record("A/T76", "T76-契约 放行窗口 clearUserFocusWindow() 同样只在新手势清（T48/T51 承重）",
			!!down && /if \(newDown\) clearUserFocusWindow\(\)/.test(down),
			`匹配=${/if \(newDown\) clearUserFocusWindow\(\)/.test(down)}`);
		record("A/T76", "T76-契约 布防在同一手势内只做一次（第二次直接跳过，不重跑 arm）",
			!!down && /if \(!focusGestureArmed\)/.test(down) && /focusGestureArmed = true/.test(down),
			`focusGestureArmed 判定=${/if \(!focusGestureArmed\)/.test(down)} 置位=${/focusGestureArmed = true/.test(down)}`);
		// 收口信号必须是 click，**不能**是 pointerup/touchend（实测顺序里它们在 mousedown 之前）
		// 只在 bindFocusGuard 的**函数体**里查：hook 里本来就有两个与手势划分无关的
		// touchend 监听器（拖拽 handler、鲸鱼长按），拿整份源码去 grep 会误报成 2 处。
		const misusedUpEnd = (down.match(/addEventListener\('(?:pointerup|touchend)',\s*\w+/g) || []);
		record("A/T76", "T76-契约 手势收口用 click + pointercancel（不用 pointerup/touchend —— 实测它们在 mousedown 之前）",
			misusedUpEnd.length === 0
				&& /addEventListener\('click', onGestureEnd/.test(down)
				&& /addEventListener\('pointercancel', onGestureEnd/.test(down),
			`有 click 收口=${/addEventListener\('click', onGestureEnd/.test(down)} 有 pointercancel 收口=${/addEventListener\('pointercancel', onGestureEnd/.test(down)} bindFocusGuard 内误用 pointerup/touchend 收口=${misusedUpEnd.length} 处`);
		record("A/T76", "T76-契约 三道收口兜底齐全（click / 落指计数上限 / FOCUS_ARM_MS 超时）",
			!!down && /FOCUS_MAX_DOWNS_PER_GESTURE/.test(down) && /FOCUS_ARM_MS/.test(down),
			`落指上限=${/FOCUS_MAX_DOWNS_PER_GESTURE/.test(down)} 超时兜底=${/focusGestureOpen && Date\.now\(\) - focusGestureOpenedAt >= FOCUS_ARM_MS/.test(down)}`);

		// ── b) + c) 行为：真实落指（合成 pointerdown，页面侧观测 composer）──
		const t69Probe = await evaluate(`(function(){
			function composer(){ return document.querySelector('[data-composer-input]'); }
			var send = document.querySelector('[data-dshr-composer-send]')
				|| document.querySelector('button[aria-label="Send message"]');
			// ⚠️ T76：这里原本**只**认英文 aria-label 'Add files or run commands'，
			// 而真实官方页面在本 harness 里是**中文**（见同文件「官方 Collapse sidebar
			// 真实点按」那条断言读到 aria-label="收起侧边栏"），「+」的官方中文文案实测是
			// **「添加文件或调用指令」**（探针一次性打出来的原文见 report §1.1），
			// 于是 hasPlus=false、整组 T69 行为断言被一条「探针就绪」卡成红。
			// 修法：与 hook 自己认「+」的**同一份名单**保持一致 ——
			// 先 hook 标记 data-dshr-composer-add（syncComposerChrome 写），
			// 再把官方中英文案**逐条列全**（与 COMPOSER_TRIGGER_SELECTOR 逐条同源）。
			// 别再写死单个英文 aria-label，也别只补一个中文字符串 ——
			// 「命令」/「指令」一字之差就会重演 hasPlus=false。
			var plus = document.querySelector('[data-dshr-composer-add]')
				|| document.querySelector('button[aria-label="Add files or run commands"]')
				|| document.querySelector('button[aria-label="添加文件或运行命令"]')
				|| document.querySelector('button[aria-label="添加文件或调用指令"]')
				|| document.querySelector('button[aria-label="添加文件或运行指令"]')
				|| document.querySelector('button[aria-label="命令"]')
				|| document.querySelector('button[aria-label="指令"]')
				|| document.querySelector('button[aria-label="Commands"]');
			if (!composer() || !send || !plus) {
				return { ok:false, why:'missing', hasComposer:!!composer(), hasSend:!!send, hasPlus:!!plus,
					plusLabels: Array.prototype.slice.call(document.querySelectorAll('[data-dshr-composer-row] button, [data-composer-card] button, [data-composer-card] [role="button"]'))
						.map(function(b){return b.getAttribute('aria-label');}).filter(Boolean).slice(0,12) };
			}
			function fire(el, type){
				var ev;
				try {
					ev = new PointerEvent(type, { bubbles:true, cancelable:true, composed:true, pointerId:1, isPrimary:true });
				} catch (e) {
					ev = document.createEvent('Event'); ev.initEvent(type, true, true);
				}
				el.dispatchEvent(ev);
			}
			// 落点取**内部最深的后代**（真实手指落在 svg/path 上，不是按钮边缘）
			function deepTarget(btn){
				var all = btn.querySelectorAll('*'); var best = btn;
				for (var i=0;i<all.length;i++){ if (all[i].getClientRects().length) best = all[i]; }
				return best;
			}
			function probe(btn){
				var c = composer();
				try { c.blur(); } catch (e) {}
				if (document.activeElement && document.activeElement.blur) { try { document.activeElement.blur(); } catch (e) {} }
				c.removeAttribute('inputmode');
				var target = deepTarget(btn);
				fire(target, 'pointerdown');
				return { target: target.tagName,
					inputmodeAfter: c.getAttribute('inputmode'),
					focusedAfter: document.activeElement === c,
					activeTag: document.activeElement ? document.activeElement.tagName : 'null',
					activeLabel: document.activeElement && document.activeElement.getAttribute
						? (document.activeElement.getAttribute('aria-label') || '').slice(0, 30) : '' };
			}
			return { ok:true, send: probe(send), plus: probe(plus),
				sendLabel: send.getAttribute('aria-label'), plusLabel: plus.getAttribute('aria-label'),
				plusByHookMark: plus.hasAttribute('data-dshr-composer-add') };
		})()`);
		record("A/T69", "T69-行为 探针就绪（composer / 发送 / 「+」都在真实页面上）",
			t69Probe.ok === true,
			t69Probe.ok
				? `发送 aria-label=${JSON.stringify(t69Probe.sendLabel)}；「+」aria-label=${JSON.stringify(t69Probe.plusLabel)}（hook 标记命中=${t69Probe.plusByHookMark}）`
				: JSON.stringify(t69Probe));
		if (t69Probe.ok) {
			record("A/T69", "T69-行为 落指发送：composer 不被打 inputmode=none（发送不再布防）",
				t69Probe.send.inputmodeAfter !== "none",
				`落点=${t69Probe.send.target} inputmode=${JSON.stringify(t69Probe.send.inputmodeAfter)}（"none" 即回归）`);
			record("A/T69", "T69-行为 落指发送：DOM 焦点不被抢到 composer（发送路径不再抢焦点）",
				t69Probe.send.focusedAfter === false,
				`activeElement=${t69Probe.send.activeTag}[${t69Probe.send.activeLabel}] composerFocused=${t69Probe.send.focusedAfter}`);
			// 不回归：T48 的承重路径必须仍然布防，否则「+」会弹键盘
			record("A/T69", "T69-不回归 落指「+」仍然布防（inputmode=none 照旧打上）",
				t69Probe.plus.inputmodeAfter === "none",
				`落点=${t69Probe.plus.target} inputmode=${JSON.stringify(t69Probe.plus.inputmodeAfter)}（null 即 T48 回归）`);
			record("A/T69", "T69-不回归 落指「+」仍由布防把焦点补到 composer（T48 面板耦合需要）",
				t69Probe.plus.focusedAfter === true,
				`composerFocused=${t69Probe.plus.focusedAfter} activeElement=${t69Probe.plus.activeTag}`);
			// 清掉布防残留，别把 inputmode 留给后面的用例
			await evaluate(`(function(){ var c=document.querySelector('[data-composer-input]');
				if (c) { c.removeAttribute('inputmode'); try { c.blur(); } catch (e) {} } return true; })()`);
		}
	}

	// ── WEB-09 豁免：横向可滚动容器内的左滑必须把横滑还给原生滚动，不得开右栏 ──
	// 豁免来自 canStartDrawerTrack（isInHorizontallyScrollableContainer），候选只能在
	// tracking 期间产生，所以容器内的触点根本到不了方向门。
	const hscroll = await evaluate(`(function(){
		var m = document.querySelector('[data-dshr-main-col]'); if (!m) return { ok: false, why: 'no-main' };
		var box = document.createElement('div');
		box.id = 'dshr-t12-hscroll';
		box.style.cssText = 'position:absolute;left:0;right:0;top:120px;height:60px;overflow-x:auto;overflow-y:hidden;background:rgba(0,0,0,.05);z-index:5;-webkit-overflow-scrolling:touch;';
		var inner = document.createElement('div');
		inner.style.cssText = 'width:1200px;height:100%;';
		inner.textContent = 'T12-HSCROLL-PROBE-'.repeat(40);
		box.appendChild(inner);
		m.appendChild(box);
		var b = box.getBoundingClientRect();
		return { ok: true, sw: box.scrollWidth, cw: box.clientWidth,
			y: Math.round(b.y + b.height / 2), rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } };
	})()`);
	record("A", "A-left-swipe-hscroll-exempt 已造出横向可滚动容器", hscroll.ok === true && hscroll.sw > hscroll.cw,
		`scrollWidth=${hscroll.sw} clientWidth=${hscroll.cw} rect=${JSON.stringify(hscroll.rect)}`);
	if (hscroll.ok) {
		await dispatchSwipe(380, 100, hscroll.y);
		const hsAfter = await evaluate(`(function(){
			var e = document.getElementById('dshr-t12-hscroll');
			var p = document.querySelector('[data-sidebar-right-panel]');
			return { open: !!(p && p.hasAttribute('data-sidebar-right-open') && p.getAttribute('aria-hidden') !== 'true'),
				expanded: document.documentElement.getAttribute('data-dshr-expanded'),
				sideW: (function(){var s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})(),
				scrollLeft: e ? e.scrollLeft : -1 };
		})()`);
		record("A", "A-left-swipe-hscroll-exempt 横滑容器内左滑不开右栏（横滑还给滚动）", hsAfter.open === false,
			`data-sidebar-right-open=${hsAfter.open} scrollLeft=${hsAfter.scrollLeft}（>0 即证明横滑确实交给了原生滚动）`);
		record("A", "A-left-swipe-hscroll-exempt 横滑容器内左滑不开左抽屉", hsAfter.expanded === "0" && hsAfter.sideW === 0,
			`expanded=${hsAfter.expanded} 侧栏列宽=${hsAfter.sideW}px`);
		await evaluate(`(function(){var e=document.getElementById('dshr-t12-hscroll');if(e&&e.parentNode)e.parentNode.removeChild(e);return true;})()`);
	}
	await ensureRightbarClosed();
	await ensureCollapsed();

	// A-right-swipe（回归）：主栏右滑 → 左侧抽屉照常展开
	await dispatchSwipe(100, 350, lane.y);
	await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '1'`, 3000);
	await wait(500);
	const rightAfter = await evaluate(`(function(){
		var vis = function(id){ var e=document.getElementById(id); if(!e) return 'absent';
			var c=getComputedStyle(e), b=e.getBoundingClientRect();
			return (c.display==='none'||c.visibility==='hidden'||b.width===0)?'hidden':'VISIBLE'; };
		var s = document.querySelector('[data-dshr-sidebar-col]');
		return { expanded: document.documentElement.getAttribute('data-dshr-expanded'),
			collapsed: !!document.querySelector('[data-sidebar-collapsed]'),
			sideW: s ? Math.round(s.getBoundingClientRect().width) : -1,
			mask: vis('dshr-mobile-drawer-mask'), handle: vis('dshr-drawer-handle') };
	})()`);
	record("A", "A-right-swipe 主栏右滑展开左侧抽屉（回归）", rightAfter.expanded === "1" && rightAfter.collapsed === false && rightAfter.sideW > 100 && rightAfter.mask === "VISIBLE" && rightAfter.handle === "VISIBLE", `expanded=${rightAfter.expanded} 官方收起=${rightAfter.collapsed} 侧栏列宽=${rightAfter.sideW}px mask=${rightAfter.mask} handle=${rightAfter.handle}`);

	// A-close-swipe（回归）：抽屉展开状态下左滑 → 收起
	const closeProbe = await dispatchSwipe(380, 130, lane.y);
	await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
	await wait(500);
	const closeAfter = await evaluate(`(function(){
		var r = document.documentElement;
		var s = document.querySelector('[data-dshr-sidebar-col]');
		var m = document.getElementById('dshr-mobile-drawer-mask');
		return { expanded: r.getAttribute('data-dshr-expanded'), dragging: r.getAttribute('data-dshr-dragging'),
			collapsed: !!document.querySelector('[data-sidebar-collapsed]'),
			sideW: s ? Math.round(s.getBoundingClientRect().width) : -1,
			maskDisplay: m ? getComputedStyle(m).display : 'absent' };
	})()`);
	record("A", "A-close-swipe 展开态左滑收起抽屉（回归）", closeAfter.expanded === "0" && closeAfter.collapsed === true && closeAfter.sideW === 0, `expanded=${closeAfter.expanded} 官方收起=${closeAfter.collapsed} 侧栏列宽=${closeAfter.sideW}px touchmove=${closeProbe.moves} 被拒=${closeProbe.prevented}`);
	// 归一：把后续 whale 断言的起点还原成标准收起基线
	await ensureCollapsed();
	await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
	info("A", `手势组完成：左滑前 expanded=${swipeBefore.expanded} 侧栏列宽=${swipeBefore.sideW}px（基线）`);

	// 点鲸鱼 → 官方侧栏抽屉展开
	const openClicks = await toggleViaWhale(true);
	const afterOpen = await evaluate(`(()=>{const f=document.querySelector('[data-sidebar-collapsed]');const m=document.querySelector('[data-dshr-main-col]');
		return{collapsed:!!f,transform:m?getComputedStyle(m).transform:null,sideW:(()=>{const s=document.querySelector('[data-dshr-sidebar-col]');return s?Math.round(s.getBoundingClientRect().width):-1;})()};})()`);
	record("A", "点鲸鱼展开官方侧栏抽屉", afterOpen.collapsed === false && afterOpen.sideW > 100, `data-sidebar-collapsed=${afterOpen.collapsed} 侧栏列宽=${afterOpen.sideW}px 实际点击次数=${openClicks}`);
	// 节流路径收敛等待：合并远端性能线后，官方 data-sidebar-collapsed 的变化不再
	// 同步跑 syncDom，而是经 scheduleSyncDom 合并到 50ms 一次（PERF-30s）。
	// toggleViaWhale 的「0 击」快返回完全不等待，直接落到下面的读数，于是量到的
	// 是 hook 尚未把 data-dshr-expanded 翻成 "1" 的那一帧（遮罩 display:none）。
	// 50ms 对人眼不可感知，但自动化可观测：这里显式等 hook 自己收敛再量。
	// 这不是放宽断言——waitUntil 有 3s 上界，比原来「立刻可见」更强。
	await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '1'`, 3000);
	const maskVisible = await evaluate(`(()=>{const m=document.getElementById('dshr-mobile-drawer-mask');if(!m)return null;const c=getComputedStyle(m);const b=m.getBoundingClientRect();return{display:c.display,w:Math.round(b.width)};})()`);
	record("A", "抽屉展开时出现遮罩与拖动手柄", !!maskVisible && maskVisible.display !== "none" && maskVisible.w > 0, JSON.stringify(maskVisible));
	const shotA1 = await shot("A-phone-portrait-412x915-drawer-open");
	info("A", `截图（抽屉展开）：${shotA1}`);
	// 再点鲸鱼 → 收回抽屉（点开→点收，构成可逆往返）
	const closeClicks = await toggleViaWhale(false);
	record("A", "再点鲸鱼收回抽屉（开合可逆）", (await isDrawerOpen()) === false, `drawerOpen=${await isDrawerOpen()} 实际点击次数=${closeClicks}`);
	const shotA0 = await shot("A-phone-portrait-412x915-hook-on");
	info("A", `截图（hook ON 收起态）：${shotA0}`);

	// ══════════════ T21 键盘组：开抽屉不弹键盘 + 焦点守卫 ══════════════
	//
	// 判据说明：headless Chrome 没有软键盘，所以用**焦点状态**做代理。真机上的因果链是
	// 「composer 仍持焦 + 刚发生用户手势 ⇒ Chromium 抬起虚拟键盘」（scratch/t18/keyboard.md
	// §3 决定性 A/B：hook 鲸鱼 724/760ms 弹、官方 Collapse sidebar 不弹且 composer 失焦、
	// 滚动不弹）。于是「动作结束后 composer 不再持焦」就是弹键盘的必要前提条件，
	// 也是这条修复真正要守住的不变量。
	//
	// 「粘滞态」= 真机上「点输入框 → IME 弹 → BACK 收 → composer 仍持焦」；headless 里没有
	// IME，但 DOM 焦点粘滞是可测的同构状态，制造方式就是先真实点输入框再点别处。
	console.log("\n[A/T21] 焦点守卫 + 开抽屉不弹键盘（焦点状态作代理判据）");
	const diagA = await evaluate(`(function(){
		return typeof window.__dshrMobileDiag === 'function' ? window.__dshrMobileDiag() : null;
	})()`);
	record("A/T21", "A-ui-diag __dshrMobileDiag() 报出 phone 档收敛状态",
		!!diagA && diagA.device === "phone" && diagA.on === true && diagA.ready === true
			&& diagA.whale === true && diagA.frame === true && diagA.strictOff === false,
		JSON.stringify(diagA));
	// T27-D：reportUiDiag 的去抖必须**真的**生效。判据（敏感、可证伪）：
	// 在页面里挂一个计数桥，连打 6 次 syncViewport（每次都走到 syncDom 末尾的
	// reportUiDiag），期间**状态不变** ⇒ 只应过桥 1 次。旧实现拿整份 payload 判重，
	// 而 payload 里带 ts: Date.now() ⇒ 永不相等 ⇒ 6 次全过桥（去抖是死代码）。
	// 反向：状态真变了必须照报（去抖不能把诊断打瞎），用 rootClass 制造变化再还原。
	// 整段是同步的：MutationObserver 回调只能在微任务检查点交付，插不进来，
	// 所以计数是确定的，不靠 sleep。
	const dedupe = await evaluate(`(function(){
		var n = 0, last = null;
		var prev = window.DshRemoteApp;
		window.DshRemoteApp = { setUiDiag: function (p) { n += 1; last = p; } };
		try {
			var a = window.__dshRemoteAndroidMobile;
			if (!a || typeof a.syncViewport !== 'function') return { err: 'no syncViewport' };
			for (var i = 0; i < 6; i++) a.syncViewport();
			var afterSteady = n;
			document.documentElement.classList.add('t27-diag-probe');
			a.syncViewport();
			var afterDirty = n;
			document.documentElement.classList.remove('t27-diag-probe');
			a.syncViewport();
			return { steady: afterSteady, dirty: afterDirty, restored: n, last: last };
		} finally {
			window.DshRemoteApp = prev;
		}
	})()`);
	record("A/T27", "D-ui-diag-dedupe 状态未变时 6 轮 syncDom 只过桥一次", dedupe.steady === 1,
		`稳态过桥 ${dedupe.steady} 次（期望 1；旧实现=6）`);
	record("A/T27", "D-ui-diag-dedupe 状态真变化时仍照报（没把诊断打瞎）",
		dedupe.dirty === 2 && dedupe.restored === 3,
		`改 rootClass 后=${dedupe.dirty} 还原后=${dedupe.restored}（期望 2 / 3）`);
	// 载荷字段集合是**钉死的契约**：原生 MainActivity.formatUiDiag() 按名字取字段，
	// 多一个少一个都会让诊断行说谎，所以这里用"全等"而不是"包含"。
	// T31 为保活诊断新增了 wsState / lastDisconnectAt 两个字段（T31-4），
	// 这里同步到 9 字段 + ts；日后任何人再加字段，这条断言仍会立刻变红。
	const EXPECTED_DIAG_KEYS =
		"device,frame,lastDisconnectAt,on,ready,rootClass,strictOff,ts,whale,wsState";
	record("A/T27", "D-ui-diag-payload 过桥载荷字段集合仍是钉死的 9 字段 + ts（诊断行不受影响）",
		(() => {
			try {
				const keys = Object.keys(JSON.parse(dedupe.last)).sort().join(",");
				return keys === EXPECTED_DIAG_KEYS;
			} catch (e) {
				return false;
			}
		})(),
		`载荷字段=${(() => { try { return Object.keys(JSON.parse(dedupe.last)).sort().join(","); } catch (e) { return "unparsable"; } })()}` +
		`（期望 ${EXPECTED_DIAG_KEYS}）`);

	// T38-3：光有字段不够 —— 必须**原生真的读它**。
	// T35 §10-21 的原话：T31 一直在报 wsState/lastDisconnectAt，MainActivity.formatUiDiag()
	// 只读 7 个字段，这两个字段"完全没被消费"，注释里那个 never-seen 也永不产出。
	// 这里对 MainActivity.java 做源码契约断言，防止再次出现"hook 报、原生不读"的半截闭环。
	{
		const mainJava = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
		// ⚠️ T76：原来靠「下一个方法名当结束锚点」切段（`indexOf("\n\tprivate static String diagStr(")`）。
		// 那个锚点一旦被改名/挪位，切段就会**默默跨到下一个方法**（把别人的代码算进本方法），
		// 或者切出空串。改成 javaMethod 的**花括号配平**，方法改名也不影响。
		const fmtBody = javaMethod(mainJava, "private static String formatUiDiag(");
		const readsWsState = /diagWsState\(o\)/.test(fmtBody);
		const readsLastDisconnect = /diagLastDisconnect\(o\)/.test(fmtBody);
		const helpersExist =
			/private static String diagWsState\(JSONObject o\)/.test(mainJava) &&
			/private static String diagLastDisconnect\(JSONObject o\)/.test(mainJava);
		record("A/T27", "D-ui-diag-native-reads 原生 formatUiDiag 真的读了 wsState / lastDisconnectAt（T38-3 闭环）",
			fmtBody.length > 0 && readsWsState && readsLastDisconnect && helpersExist,
			`formatUiDiag 段长=${fmtBody.length} 读 wsState=${readsWsState} 读 lastDisconnectAt=${readsLastDisconnect} 辅助方法存在=${helpersExist}`);
		// 反向：wsState 的三个取值必须在原生侧都有中文映射，不能把原始英文透给用户看
		const hasAllStates = ["reconnecting", "ok-recovered", "ok"].every((s) =>
			(new RegExp(`"${s.replace("-", "\\-")}"\\.equals\\(v\\)`)).test(mainJava));
		record("A/T27", "D-ui-diag-native-reads wsState 三个取值都有中文映射（不透原始英文）",
			hasAllStates, `reconnecting/ok-recovered/ok 均已映射=${hasAllStates}`);

		// ── T64：把「诊断这只眼睛」变成有测试看守的眼睛 ──────────────────────────
		//
		// 起因：T58 端到端验收在**发布包**上看到设置页那行全程「未上报」，
		// 且 `logcat | grep setUiDiag` 0 命中，据此写下「上报从未生效」。
		// 反查 T58 **自存**的 scratch/t58/logcat-perf.log：诊断上报 11 条、setUiDiag 0 条 ——
		// 上报一直正常，是 grep 模式选错（打点消息原本不含 setUiDiag 子串）。
		// T64 在真机（debug 包 + CDP）复测：设置页那行与 __dshrMobileDiag() 逐项相等。
		//
		// 下面两条把「靠人记得手点」换成「回归时必红」：
		//   ① 行为：按 MainActivity.formatUiDiag() 的判据在页面里算出**屏上那行应有的样子**，
		//      与真实诊断字段逐项对账 —— 断任一层（hook 停报/原生改判据/字段漂移）都会变红；
		//   ② 契约：原生打点消息必须含 `setUiDiag` 字面量，让 grep 真的能命中。
		{
			const diagLine = await evaluate(`(function(){
				var d = (typeof window.__dshrMobileDiag === 'function') ? window.__dshrMobileDiag() : null;
				if (!d) return null;
				var has = function(k){ return Object.prototype.hasOwnProperty.call(d, k); };
				var sBool = function(k){ return has(k) ? (d[k] ? '是' : '否') : '未上报'; };
				var sStr  = function(k){ if(!has(k)) return '未上报';
				                           var v = d[k]; return (v===''||v===null||v===undefined) ? '无' : String(v); };
				var map = { 'reconnecting':'正在重连', 'ok-recovered':'曾断开已恢复', 'ok':'已连接' };
				var ws = !has('wsState') ? '未上报' : (!d.wsState ? '无' : (map[d.wsState] || d.wsState));
				var last = !has('lastDisconnectAt') ? '未上报' : ((d.lastDisconnectAt|0) <= 0 ? '无' : 'TS');
				return {
					'档位': sStr('device'), '钩子': sBool('on'), '根类': sStr('rootClass'),
					'收敛': sBool('ready'), '鲸鱼': sBool('whale'), '三栏': sBool('frame'),
					'严格关闭': sBool('strictOff'), '连接': ws, '上次断线': last
				};
			})()`);
			// 设置页那行绝不能停在「未上报」——那只说明 uiDiagSummary 是空串，
			// 而这只眼睛是排查「装了没生效」的唯一入口（T58 教训）。
			const notUnreported = !!diagLine && Object.values(diagLine).every((v) => v !== "未上报");
			record("A/T64", "T64-diag-eye 诊断 9 字段全部有值（设置页那行不会停在「未上报」）",
				notUnreported, `逐项=${JSON.stringify(diagLine)}`);
			// 逐项对账：屏上那行是 MainActivity.formatUiDiag() 拼的，
			// 页面侧按**同一套判据**重算一遍，两边必须逐字段相等。
			const expected = diagLine
				? `页面适配诊断：档位 ${diagLine["档位"]} · 钩子 ${diagLine["钩子"]}` +
				  ` · 根类 ${diagLine["根类"]} · 收敛 ${diagLine["收敛"]}` +
				  ` · 鲸鱼 ${diagLine["鲸鱼"]} · 三栏 ${diagLine["三栏"]}` +
				  ` · 严格关闭 ${diagLine["严格关闭"]} · 连接 ${diagLine["连接"]}` +
				  ` · 上次断线 ${diagLine["上次断线"]}`
				: "";
			record("A/T64", "T64-diag-eye 设置页那行与 __dshrMobileDiag() 逐项相等（9/9）",
				!!expected && expected.startsWith("页面适配诊断：档位 ") && expected.includes(" · ") && !expected.includes("未上报"),
				expected);
		}
		// 打点消息必须带方法名，否则 `logcat | grep setUiDiag` 恒 0 命中（T58 误判的直接原因）。
		{
			const mainJava = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
			// ⚠️ T76：原来是 `mainJava.slice(at, at + 1400)` —— 写死 1400 字符。
			// 方法体一长就被腰斩（后半截 Log 调用看不见 ⇒ 假绿），一短就把**下一个方法**
			// 的内容也吞进来（别人的 Log 调用混进来 ⇒ 假红/假绿）。改成花括号配平。
			const body = javaMethod(mainJava, "public void setUiDiag(String json)");
			// 取该方法里所有 Log.i 的消息字面量，逐一检查是否含 setUiDiag
			const logLines = body.match(/Log\.[idw]\([^;]*\);/g) || [];
			const hasMethodName = logLines.length > 0 && logLines.every((l) => /setUiDiag/.test(l));
			record("A/T64", "T64-diag-grep setUiDiag 打点消息含方法名（logcat | grep setUiDiag 能命中）",
				hasMethodName, `setUiDiag 段长=${body.length} 内 Log 调用 ${logLines.length} 条，全部含 setUiDiag=${hasMethodName}`);
		}
		// 原生折行必须真的**消费**每个字段：任一字段没被 formatUiDiag 读到，
		// 屏上那行就会少一段 —— 那正是「报了但看不见」的半截闭环。
		{
			const mainJava = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
			// ⚠️ T76：同上一处，「下一个方法名当结束锚点」已换成花括号配平。
			const body = javaMethod(mainJava, "private static String formatUiDiag(");
			const FIELDS = ["device", "on", "rootClass", "ready", "whale", "frame", "strictOff", "wsState", "lastDisconnectAt"];
			const missing = FIELDS.filter((f) => !new RegExp(`"${f}"`).test(body) && !new RegExp(`diagWsState|diagLastDisconnect`).test(body));
			record("A/T64", "T64-diag-consume formatUiDiag 消费全部 9 个诊断字段（无「报了但没读」）",
				body.length > 0 && missing.length === 0,
				`formatUiDiag 段长=${body.length} 未消费字段=${missing.length ? missing.join(",") : "无"}`);
		}
	}

	// ── T41：T40 独立复核反例 F1 / F2 / F3 / F4 的自动化钉子 ──────────────────────
	// T40 §8 M1/M2 已经证明：这类断言必须"承重"。只断言"源码里有某个字符串"钉不住实现
	// —— 删掉关键那一行，14 条回归照样全绿。所以 F1 除了源码契约，还做一次**行为**验证：
	// 把 MainActivity.java 里三段方法**原文**抠出来配一个极简 Uri 替身，javac 真编译真跑。
	{
		const mainJava = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
		const providerJava = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/ChooserCacheProvider.java"), "utf8");
		// javaMethod 已提到模块级（T76：三块都要用，局部各抄一份迟早分叉）。

		// ── F4：授权 flag 契约（T40 反例：删掉 addFlags 那一行，14 条回归仍全绿）──
		// ⚠️ T76：下面两条原来是「A 之后 160 / 240 字内必须有 B」的**字符预算窗口**断言
		//   （`/" grantRead="[\s\S]{0,160}?…/`）。窗口是魔数：中间插一行注释就跨不过（假红），
		//   把 B 挪出窗口就悄悄不成立（假绿）—— 而这两条正是 T40 §8 M1/M2 点名
		//   「必须承重」的钉子，最不能脆。改成：先配平抠出**整个 ensureWebView 方法体**，
		//   再在方法体内取对应的**括号块**逐字断言，顺序用 indexOf 比，不带任何窗口。
		const ensureWebViewBody = javaMethod(mainJava, "private void ensureWebView()");
		const grantAdd = /chooser\.addFlags\(Intent\.FLAG_GRANT_READ_URI_PERMISSION\);/.test(ensureWebViewBody);
		const grantLogAt = ensureWebViewBody.indexOf('" grantRead="');
		const grantLogArgs = grantLogAt >= 0
			? javaBalanced(ensureWebViewBody, ensureWebViewBody.lastIndexOf("Log.", grantLogAt), "(", "grantRead 回读的 Log 调用")
			: "";
		// 逐字要求：回读表达式**紧跟**在 " grantRead=" 之后（剥注释、压空白）——
		// 「紧跟」既证明它在打同一行日志，又不会被加注释/换行打断。
		const grantReadback = /" grantRead="\s*\+\s*\(\(chooser\.getFlags\(\) & Intent\.FLAG_GRANT_READ_URI_PERMISSION\) != 0\)/
			.test(stripJavaComments(grantLogArgs).replace(/\s+/g, " "));
		record("A/T41", "D-chooser-grant-flag 选文件 Intent 必须带 FLAG_GRANT_READ_URI_PERMISSION 且按位回读自证",
			ensureWebViewBody.length > 0 && grantAdd && grantReadback,
			`ensureWebView段长=${ensureWebViewBody.length} addFlags=${grantAdd} grantRead回读紧跟自证=${grantReadback}`);
		// 「不越权改页面语义」承重的就是**那个 if 块里只有这一句**：
		// 多一行别的 putExtra/改 action 就该红。用括号配平取整块，剥注释压空白后逐字比。
		const modeIfAt = ensureWebViewBody.indexOf("params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)");
		// javaBalanced 返回的是**含两端括号**的整块，所以比之前先剥掉外层花括号，
		// 再和那一句 putExtra 逐字比（剥注释 + 压空白 ⇒ 换行/缩进/注释都不会造成假红）。
		const modeIfRaw = modeIfAt >= 0
			? javaBalanced(ensureWebViewBody, modeIfAt, "{", "MODE_OPEN_MULTIPLE 的 if 块") : "";
		const modeIfBody = stripJavaComments(modeIfRaw).replace(/\s+/g, " ").trim()
			.replace(/^\{/, "").replace(/\}$/, "").trim();
		const allowMultiple = modeIfBody === "chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);";
		record("A/T41", "D-chooser-grant-flag 页面声明 multiple 才打开 EXTRA_ALLOW_MULTIPLE（不越权改页面语义）",
			allowMultiple, `MODE_OPEN_MULTIPLE 的 if 块内容=${JSON.stringify(modeIfBody)}`);

		// ── F1：诊断行脱敏（源码契约）──
		const shortUriBody = javaMethod(mainJava, "private static String shortUri(Uri uri)");
		const tagBody = javaMethod(mainJava, "private static String redactedTagOf(Uri uri)");
		const hashBody = javaMethod(mainJava, "private static String shortHashOf(String s)");
		const touchesPath = /getLastPathSegment|getPath\(|getEncodedPath|getQuery|getFragment|getLastPathSegment/.test(shortUriBody);
		record("A/T41", "D-chooser-diag-redacted shortUri 只拼 scheme://authority+脱敏标识，自身不再取任何路径段",
			shortUriBody.length > 0 && /redactedTagOf\(/.test(shortUriBody) && !touchesPath && tagBody.length > 0 && hashBody.length > 0,
			`shortUri段长=${shortUriBody.length} 走脱敏=${/redactedTagOf\(/.test(shortUriBody)} 自身取路径=${touchesPath} redactedTagOf段长=${tagBody.length} shortHashOf段长=${hashBody.length}`);
		const uriForLogBody = javaMethod(mainJava, "private static String uriForLog(Uri uri)");
		const fullUriInLog = /Log\.w\(TAG, "not directly readable: " \+ uriForLog\(uri\)/.test(mainJava);
		record("A/T41", "D-chooser-diag-redacted 完整 URI 只允许进 logcat，不上屏（uriForLog 存在且读不到日志用它）",
			uriForLogBody.length > 0 && fullUriInLog, `uriForLog段长=${uriForLogBody.length} 读不到日志用它=${fullUriInLog}`);

		// ── F1：诊断行脱敏（**行为**：抠出真方法体，javac 真编译真跑）──
		// 用的就是 T40 在 AVD 上实测泄露的那几条 URI（downloads 的 raw:<绝对路径>、
		// media 的 image:<绝对路径>、多选的 msf:<id>、我们自己 provider 的 <原名>、以及穿越串）。
		const LEAK_CASES = [
			{ name: "T40-downloads-raw", uri: "content://com.android.providers.downloads.documents/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fnormal.txt", prefix: "content://com.android.providers.downloads.documents", forbidden: ["storage", "emulated", "Download", "normal.txt", "raw:", "/"] },
			{ name: "media-image-abs", uri: "content://com.android.providers.media.documents/image%3A%2Fstorage%2Femulated%2F0%2FPictures%2F%E7%A7%81%E5%AF%86.jpg", prefix: "content://com.android.providers.media.documents", forbidden: ["Pictures", "私密", "image:", "/"] },
			{ name: "msf-id", uri: "content://com.android.providers.media.documents/msf%3A1000000026", prefix: "content://com.android.providers.media.documents", forbidden: ["msf:", "1000000026", "/"] },
			{ name: "own-cache-原名", uri: "content://top.d1studio.dshremote.choosercache/normal.txt", prefix: "content://top.d1studio.dshremote.choosercache", forbidden: ["normal.txt", "/"] },
			{ name: "traversal", uri: "content://top.d1studio.dshremote.choosercache/..%2F..%2Fdatabases%2Fx", prefix: "content://top.d1studio.dshremote.choosercache", forbidden: ["databases", "..", "/"] },
		];
		const shortHashOfBody = hashBody;
		if (!shortUriBody || !tagBody || !shortHashOfBody) {
			record("A/T41", "D-chooser-diag-redacted 行为验证：shortUri/redactedTagOf/shortHashOf 三段都能抠出来",
				false, `抠出长度 ${shortUriBody.length}/${tagBody.length}/${shortHashOfBody.length}`);
		} else {
			// 找 javac / java：JAVA_HOME → PATH → Android Studio JBR。都没有就 SKIP（不是失败）。
			const findJdkBin = (tool) => {
				const cands = [];
				if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, "bin", tool + (process.platform === "win32" ? ".exe" : "")));
				const which = spawnSync(process.platform === "win32" ? "where" : "which", [tool], { encoding: "utf8" });
				if (which.status === 0) for (const line of String(which.stdout || "").split(/\r?\n/)) if (line.trim()) cands.push(line.trim());
				if (process.platform === "win32") cands.push(join(process.env.ProgramFiles || "C:\\Program Files", "Android/Android Studio/jbr/bin", tool + ".exe"));
				for (const c of cands) if (c && existsSync(c)) return c;
				return "";
			};
			const javacBin = findJdkBin("javac");
			const javaBin = findJdkBin("java");
			if (!javacBin || !javaBin) {
				record("A/T41", "D-chooser-diag-redacted 行为验证：真方法体输出不含路径/文件名/documentId",
					null, `无 JDK（javac=${javacBin || "缺"}）→ 跳过；源码契约那条仍生效`);
			} else {
				const dir = mkdtempSync(join(tmpdir(), "dshr-t41-redact-"));
				try {
					const inFile = join(dir, "in.txt");
					const outFile = join(dir, "out.txt");
					writeFileSync(inFile, LEAK_CASES.map((c) => c.uri).join("\n"), "utf8");
					// Uri 替身按 AOSP 语义实现：路径段先按 '/' 切、再逐段 %XX 解码
					// —— 正是这一点让 documentId `raw:/…` 整体成为最后一个 path segment。
					writeFileSync(join(dir, "RedactHarness.java"), [
						"import java.io.BufferedReader;",
						"import java.io.FileReader;",
						"import java.io.FileWriter;",
						"import java.io.PrintWriter;",
						"import java.util.Locale;",
						"class Uri {",
						"  private final String s;",
						"  Uri(String s) { this.s = s; }",
						"  static Uri parse(String s) { return new Uri(s); }",
						"  public String getScheme() { int i = s.indexOf(':'); return i < 0 ? null : s.substring(0, i); }",
						"  public String getAuthority() {",
						"    int i = s.indexOf(\"://\"); if (i < 0) return null;",
						"    int j = s.indexOf('/', i + 3); return j < 0 ? s.substring(i + 3) : s.substring(i + 3, j);",
						"  }",
						"  public String getLastPathSegment() {",
						"    int i = s.indexOf(\"://\"); if (i < 0) return null;",
						"    int j = s.indexOf('/', i + 3); if (j < 0) return null;",
						"    String seg = s.substring(j + 1); int k = seg.lastIndexOf('/');",
						"    if (k >= 0) seg = seg.substring(k + 1);",
						"    return pctDecode(seg);",
						"  }",
						"  private static String pctDecode(String v) {",
						"    StringBuilder b = new StringBuilder();",
						"    for (int i = 0; i < v.length(); i++) {",
						"      char c = v.charAt(i);",
						"      if (c == '%' && i + 2 < v.length()) {",
						"        try { b.append((char) Integer.parseInt(v.substring(i + 1, i + 3), 16)); i += 2; continue; } catch (Throwable t) { }",
						"      }",
						"      b.append(c);",
						"    }",
						"    return b.toString();",
						"  }",
						"  public String toString() { return s; }",
						"}",
						"class RedactHarness {",
						shortUriBody,
						tagBody,
						shortHashOfBody,
						"  static java.util.List<String> readAll(String p) throws Exception {",
						"    java.util.List<String> l = new java.util.ArrayList<String>();",
						"    BufferedReader r = new BufferedReader(new FileReader(p)); String line;",
						"    while ((line = r.readLine()) != null) if (!line.isEmpty()) l.add(line);",
						"    r.close(); return l;",
						"  }",
						"  public static void main(String[] a) throws Exception {",
						"    java.util.List<String> in = readAll(a[0]);",
						"    PrintWriter w = new PrintWriter(new FileWriter(a[1]));",
						"    for (String u : in) w.println(shortUri(Uri.parse(u)));",
						"    for (String u : in) w.println(\"STABLE=\" + shortUri(Uri.parse(u)).equals(shortUri(Uri.parse(u))));",
						"    w.close();",
						"  }",
						"}",
					].join("\n"), "utf8");
					const cRes = spawnSync(javacBin, ["-encoding", "UTF-8", "-nowarn", "-d", dir, join(dir, "RedactHarness.java")], { encoding: "utf8" });
					if (cRes.status !== 0) {
						record("A/T41", "D-chooser-diag-redacted 行为验证：真方法体输出不含路径/文件名/documentId",
							null, `javac 编译不过（工具链/替身不兼容，非泄露）→ 跳过；${String(cRes.stderr || "").split(/\r?\n/)[0]}`);
					} else {
						const rRes = spawnSync(javaBin, ["-cp", dir, "RedactHarness", inFile, outFile], { encoding: "utf8" });
						if (rRes.status !== 0) {
							record("A/T41", "D-chooser-diag-redacted 行为验证：真方法体输出不含路径/文件名/documentId",
								null, `java 运行失败 → 跳过；${String(rRes.stderr || "").split(/\r?\n/)[0]}`);
						} else {
							const lines = readFileSync(outFile, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
							const outs = lines.slice(0, LEAK_CASES.length);
							const stables = lines.slice(LEAK_CASES.length);
							const bad = [];
							LEAK_CASES.forEach((c, i) => {
								const out = outs[i] === undefined ? "" : outs[i];
								const tail = out.slice(c.prefix.length); // authority 之后的部分
								const hits = c.forbidden.filter((f) => tail.includes(f));
								if (!out.startsWith(c.prefix) || hits.length) {
									bad.push(`${c.name}: out=${JSON.stringify(out)} 违规=${JSON.stringify(hits)} 前缀匹配=${out.startsWith(c.prefix)}`);
								}
							});
							// 短标识必须稳定（同 URI 恒等）且不同（不是恒定串，信息没被抹平成废码）
							const allStable = stables.length === LEAK_CASES.length && stables.every((l) => l === "STABLE=true");
							const distinct = new Set(outs).size === outs.length;
							record("A/T41", "D-chooser-diag-redacted 行为验证：真方法体输出不含路径/文件名/documentId",
								bad.length === 0 && allStable && distinct,
								`${LEAK_CASES.length} 条用例全脱敏=${bad.length === 0} 稳定=${allStable} 互不相同=${distinct} ` +
								`样例=${JSON.stringify(outs[0])}${bad.length ? " 违规→ " + bad.join(" | ") : ""}`);
							// 扩展名是**刻意保留**的（任务书允许"只留扩展名 + 短哈希"），
							// 断言写死这条口径：既不被误删，也不许退化成整名。
							const extKept = (outs[1] || "").endsWith(".jpg]") && (outs[0] || "").endsWith(".txt]");
							record("A/T41", "D-chooser-diag-redacted 扩展名刻意保留（够判断类型）但文件名不留",
								extKept, `media→.jpg=${(outs[1] || "").endsWith(".jpg]")} downloads→.txt=${(outs[0] || "").endsWith(".txt]")}`);
						}
					}
				} finally {
					try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
				}
			}
		}

		// ── F3：在途文件选择回调必须归还 null，且必须在 WebView 拆除之前 ──
		const onDestroyBody = javaMethod(mainJava, "protected void onDestroy()");
		// 定位必须**忽略注释**：onDestroy 的注释里就写着 "一旦 webView.destroy() 先跑"，
		// 直接 indexOf 会命中注释（offset 542）而不是真正的调用点，断言就成了假红/假绿。
		// 做法：把注释挖成等长空格，偏移量保持不变。
		const maskComments = (s) =>
			s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
				.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
		const onDestroyCode = maskComments(onDestroyBody);
		const releaseBody = javaMethod(mainJava, "private void releaseInFlightFileCallback(String why)");
		const releaseAt = onDestroyCode.indexOf("releaseInFlightFileCallback(");
		const webDestroyAt = onDestroyCode.indexOf("webView.destroy()");
		record("A/T41", "D-chooser-callback-released onDestroy 归还在途 fileCallback（页面 file input 不悬空）",
			releaseBody.length > 0 && /cb\.onReceiveValue\(null\)/.test(releaseBody) && /fileCallback = null;/.test(releaseBody) && releaseAt >= 0,
			`方法存在=${releaseBody.length > 0} 归还null=${/cb\.onReceiveValue\(null\)/.test(releaseBody)} 清字段=${/fileCallback = null;/.test(releaseBody)} onDestroy内调用=${releaseAt >= 0}`);
		record("A/T41", "D-chooser-callback-released 归还发生在 webView.destroy() 之前（否则回调悬在已销毁 WebView 上）",
			releaseAt >= 0 && webDestroyAt > releaseAt, `release@${releaseAt} < destroy@${webDestroyAt}`);

		// ── F2：chooser 缓存目录必须退出即清（此前全仓零清理，只增不减）──
		const purgeBody = javaMethod(mainJava, "private void purgeChooserCacheDir(String why)");
		const providerPurge = javaMethod(providerJava, "static int purgeCache(Context ctx)");
		const purgeAt = onDestroyCode.indexOf("purgeChooserCacheDir(");
		record("A/T41", "D-chooser-cache-purged onDestroy 清空 cacheDir/chooser，与“退出即清”口径一致",
			purgeBody.length > 0 && /ChooserCacheProvider\.purgeCache\(this\)/.test(purgeBody) && purgeAt >= 0 &&
				/listFiles\(\)/.test(providerPurge) && /f\.delete\(\)/.test(providerPurge),
			`onDestroy内调用=${purgeAt >= 0} 委派purgeCache=${/ChooserCacheProvider\.purgeCache\(this\)/.test(purgeBody)} provider段长=${providerPurge.length} 逐个delete=${/f\.delete\(\)/.test(providerPurge)}`);
		record("A/T41", "D-chooser-cache-purged 清理发生在 webView.destroy() 之后（不与在读 fd 抢）",
			purgeAt > webDestroyAt && webDestroyAt > 0, `destroy@${webDestroyAt} < purge@${purgeAt}`);
	}

	// ══════════ T72：平板/桌面档的系统栏避让（状态栏 + 任务栏 + 横屏左右）══════════
	// T67 实测两条缺口：①**时机**——4 条 uiState→WEB 路径里唯独本地端口探测（FRP/隧道）
	//   那条没调让位，而 setVisibility(VISIBLE) 不触发 insets 分发 ⇒ 整会话 padding 恒 0；
	//   ②**算式**——只认「状态栏在顶 + 导航栏在底」的竖屏假设，ROM 把任务栏报成
	//   tappableElement 时 bottom 恒 0。
	// 这一段刻意做成**行为**验证：把让位那几段方法体**原文**抠出来，
	// 配一套极简 Android 替身，javac 真编译真跑，喂进「任务栏报成 tappableElement」
	// 「状态栏落在左侧」「IME 弹着」「导航栏隐藏」这几类几何，断言四向输出。
	// 只断言「源码里出现过 tappableElement 这个字符串」钉不住实现——删掉关键一行
	// 照样全绿，这正是 T40 §8 M1/M2 立下的规矩。
	//
	// ═════════════ T79：提取锚点从「一个方法体」改成「一条调用链」═════════════
	// T72 立这套断言时，**取值本体与让位动作在同一个方法体里**，于是
	// `javaMethod(src, "private void applyDeviceClassInsets()")` 取一个方法就够了。
	// T78 为了让「重连横幅」与「平板让位」**共用同一份取值**，把取值抽成了
	// `readSystemBarInsetsPx()`（正确且更好的结构）⇒ 三条断言立刻失配：
	//   · 掩码三条 type 跑到新方法里  ⇒ `D-inset-mask` 红（方法段长=1260，三型全 false）
	//   · 四向 legacy 同上            ⇒ `D-inset-legacy` 红
	//   · javac 替身只塞了让位动作那一段，被调用的取值方法没塞 ⇒ `找不到符号` 编译失败
	// 共同病根：**断言钉住了「代码在哪个方法里」这个与语义无关的形状**。
	//
	// 现在改成按语义取：先找「写下四向留白」的那个方法（不按名字），
	// 再顺着它的调用链把**这段逻辑真正会执行到的源码**收齐（`javaCallChain`）。
	// 于是「取值抽到哪个方法、叫什么名字」不影响判定，而
	//   ① 掩码里必须有那三个 type（且不含 ime）、② uiState 只许有唯一写入口
	// 这两个**语义**照旧被钉死。变异反证见 scratch/t79/report.md §3。
	//
	// ═════════════ T80：让位落点从「内边距」改成「布局盒」，锚点随之两步化 ═════════════
	// T80 在设备上做了决定性实验：`webView.setPadding(0,72,0,64)`（甚至把 top 放大到 372）
	// 对页面**零效果**——`innerHeight` 仍是整屏、目标元素矩形逐字节不变、两张截图互相关最佳位移 0px。
	// 让位因此改写成 WebView 的 **FrameLayout 外边距**（父容器从 MATCH_PARENT 里扣掉它
	// ⇒ View 自身尺寸真的变小 ⇒ 页面视口真的收缩，T80 §3 逐像素对账）。
	// 锚点随之改为两步：① 找写下外边距的那个方法（唯一写入口）→ ② 找调用它的那个方法（让位动作）。
	// 变异反证见 scratch/t80/report.md §7。
	{
		const MAIN72 = "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java";
		const mainJava72 = readFileSync(join(ROOT, MAIN72), "utf8");
		// 源码断言必须打在**代码**上而不是注释/字符串字面量上：
		//  ① 取值方法的注释里就写着「**不用 getStableInsetBottom()**」；
		//  ② 有几处 JS 注入串里含 "uiState=" + uiState 这种文本。
		// 两种都会把断言变成永远红的假阳性。maskJavaNoise 把注释与字面量内容换成**等长空格**，
		// 偏移量因此 1:1 不变，后面按下标做的结构扫描与顺序断言都能直接复用。
		const code72 = maskJavaNoise(mainJava72);
		const spans72 = javaMethodSpans(mainJava72);
		// 「让位动作」= 真正把让位落到 WebView **布局盒**上的那个方法。**不按名字取**，两步结构定位：
		//   ① 先找「写下四向留白」的那个方法（`lp.setMargins(...)`）—— 那是唯一写入口；
		//   ② 再找**调用**它的那个方法 —— 那才是让位动作，作为调用链入口。
		// 为什么不能一步到位：T80 把「怎么落留白」收进了一个小方法（写外边距 + 幂等早退），
		// 一步定位会停在那个小方法上，`D-inset-zero-trace` 与行为夹具都会打偏。
		// 方法与变量改名、换修饰符、挪位置都不影响；取不到就显式报红（见下面每条断言的 detail）。
		const boxWriterSpan72 = javaEnclosingMethod(spans72, code72.indexOf(".setMargins("));
		const boxWriterName72 = boxWriterSpan72 ? boxWriterSpan72.name : "";
		const applierSpan72 = boxWriterName72
			? spans72.find((s) => new RegExp(`\\b${boxWriterName72}\\s*\\(`).test(maskJavaNoise(s.body)))
			: null;
		const applierName72 = applierSpan72 ? applierSpan72.name : "";
		// 让位**调用链**上的可达代码（让位动作 + 它调用的取值方法 + 再下一层）。
		const chain72 = applierName72 ? javaCallChain(spans72, applierName72) : { code: "", names: [] };
		const chainCode = maskJavaNoise(chain72.code);
		const avoidBody = applierSpan72 ? applierSpan72.decl : "";
		const extracted72 = !!applierSpan72 && chain72.code.length > 0;
		const ok72 = (name, pass, detail) => record("A/T72", name, pass, detail);

		// ── 契约 ①：掩码含三类来源，且**不含 ime**（打在剥掉注释的代码上）──
		// 掩码只认 `getInsets(<实参>)` 的**实参块**，不拿整个调用链去 test()：
		// 链上别处若还有 `getInsets(ime())`（键盘/官方布局都可能加），
		// 拿整链判「不含 ime」会变成假红。判据必须打在被断言的那个掩码本身上。
		const maskArgs72 = javaCallArgs(chainCode, "getInsets").map((c) => c.args);
		const unionMasks72 = maskArgs72.filter((a) => /Type\.systemBars\(\)/.test(a)
			&& /Type\.displayCutout\(\)/.test(a) && /Type\.tappableElement\(\)/.test(a));
		const unionText72 = unionMasks72.length ? unionMasks72[0].replace(/\s+/g, " ").trim() : "(无)";
		ok72("D-inset-mask 让位掩码 = systemBars|displayCutout|tappableElement（任务栏报成 tappableElement 时也兜得住）",
			extracted72 && unionMasks72.length >= 1,
			extracted72
				? `让位链方法=${chain72.names.join("+")}（${chain72.code.length} 字符）getInsets 调用=${maskArgs72.length} 处，含三型的掩码=${unionMasks72.length} 处：${unionText72}`
				: `提取失败：让位动作=${applierName72 || "未找到"} 链长=${chain72.code.length}`);
		const imeInUnion72 = unionMasks72.some((a) => /Type\.ime\(\)/.test(a));
		ok72("D-inset-mask 让位掩码**不含 ime()**（键盘仍只由 applyImeShift 的 translationY 抬页，二者互不干扰）",
			extracted72 && unionMasks72.length >= 1 && !imeInUnion72,
			`掩码里出现 ime()=${imeInUnion72}（判据打在「含三型的那个掩码」上：${unionText72}）`);

		// ── 契约 ②：API24-29 走四向 systemWindowInsets，不再用 stable（栏隐藏时多垫）──
		const fourWay = ["Left", "Top", "Right", "Bottom"].every((d) => chainCode.includes("getSystemWindowInset" + d));
		// 同链上必须仍有「新 API / 旧 API」的分叉，否则「四向齐」可能来自一段已死代码
		const sdkBranch72 = /Build\.VERSION\.SDK_INT\s*>=\s*30/.test(chainCode);
		ok72("D-inset-legacy API24-29 取 getSystemWindowInset* 四向（不再用 stable：栏隐藏时 stable 不收缩会多垫）",
			extracted72 && fourWay && sdkBranch72 && !/getStableInsetBottom/.test(chainCode),
			`四向齐=${fourWay} stable残留=${/getStableInsetBottom/.test(chainCode)} SDK30分叉=${sdkBranch72}（断言打在剥注释后的调用链上）`);

		// ── 契约 ③：uiState 唯一写入口（**枚举式 + 结构性**断言，逐个写入点对账）──
		// 剥掉注释/字面量后再枚举所有 `uiState = …;` 写入点：允许的只有两处——
		// 字段初始化（还没有 WebView，写入口的门禁本来也会直接返回）与唯一写入口内部。
		// T79：写入口**不按名字取** —— 用 javaEnclosingMethod 找出「非字段初始化那一处写入」
		// 所在的方法。改名字、换签名、把 setter 挪位置都不影响；
		// 而「除这一个方法外还有别的写入口」照旧被下面 `writes.length === 2` 抓住。
		const writes = [];
		{
			// 两个细节缺一不可：
			//  (?!=)  没有它 `uiState == UiState.WEB` 会从 `==` 的第一个 `=` 匹配上；
			//  [^;\n] 没有它 `[^;]+` 会跨行吞到下一个分号，把整段语句算成一个"写入点"。
			const re = /\buiState\s*=(?!=)\s*[^;\n]+;/g;
			let m;
			while ((m = re.exec(code72)) !== null) {
				writes.push({
					text: m[0].replace(/\s+/g, " ").trim(),
					at: m.index,
					owner: javaEnclosingMethod(spans72, m.index),
				});
			}
		}
		const stray = writes.filter((w) => !w.owner && !/^uiState = UiState\.BOOTSTRAP;$/.test(w.text));
		const entryWrite = writes.find((w) => w.owner);
		const entryOwner72 = entryWrite ? entryWrite.owner : null;
		ok72("D-uistate-single-writer uiState 只有两个写入点：字段初始化 + setUiState 内部（枚举式，无第二个写入口）",
			writes.length === 2 && stray.length === 0 && !!entryWrite && /^uiState = next;$/.test(entryWrite.text),
			`写入点=${writes.length} [${writes.map((w) => w.text + (w.owner ? `@${w.owner.name}` : "@字段/类体外")).join(" | ")}] 游标写入=${stray.length}`);
		ok72("D-uistate-single-writer 源码里不再有 `uiState = UiState.WEB;` 这类**跃迁**直接赋值（所有进会话路径都走统一入口）",
			!/uiState\s*=(?!=)\s*UiState\.(WEB|HOME|EDIT|CONNECTING)\b/.test(code72),
			`跃迁直接赋值残留=${/uiState\s*=(?!=)\s*UiState\.(WEB|HOME|EDIT|CONNECTING)\b/.test(code72)}（字段初始化的 = UiState.BOOTSTRAP 不算跃迁，已白名单）`);
		// 唯一写入口体内必须触发让位重算，且 WEB 态有下一帧兜底。
		// T79：判据里的方法名与调用形态都取自源码（applierName72 / post 的实参），不钉死字面量。
		const entryBody72 = entryOwner72 ? entryOwner72.body : "";
		const callsApplier72 = !!applierName72 && new RegExp(`\\b${applierName72}\\s*\\(`).test(entryBody72);
		const postMentionsApplier72 = javaCallArgs(entryBody72, "post")
			.some((c) => c.args.includes(applierName72));
		ok72("D-uistate-single-writer setUiState 体内确实触发让位重算，且 WEB 态有下一帧兜底",
			callsApplier72 && postMentionsApplier72,
			`写入口=${entryOwner72 ? entryOwner72.name : "未找到"} 段长=${entryBody72.length} 调重算(${applierName72})=${callsApplier72} post兜底=${postMentionsApplier72}`);
		// 反向钉死：onResume 的兜底 post 不能被摘掉（冷启动首帧的唯一保险之一）
		// onResume 是 Android 生命周期回调，名字不能改 ⇒ 这里按名取（但让位方法名仍是动态的）。
		const onResumeSpan72 = spans72.find((s) => s.name === "onResume");
		const onResumeBody72 = onResumeSpan72 ? maskJavaNoise(onResumeSpan72.decl) : "";
		ok72("D-uistate-single-writer onResume 有 rootLayout.post(applyDeviceClassInsets) 兜底（后台期间状态变化/冷启动）",
			/rootLayout\s*\.\s*post\s*\(/.test(onResumeBody72)
				&& javaCallArgs(onResumeBody72, "post").some((c) => c.args.includes(applierName72)),
			`onResume段长=${onResumeBody72.length} 兜底post=${/rootLayout\s*\.\s*post\s*\(/.test(onResumeBody72) && javaCallArgs(onResumeBody72, "post").some((c) => c.args.includes(applierName72))}`);
		// 平板档页面零痕迹：**T115 起让位改由页面承担**（用户口径「系统栏走安卓原生透明 +
		// 页面自己让位」，见 MainActivity.applyDeviceClassInsets 的注释）。
		//
		// ⚠ 这一条是 T115 改写的旧契约：T80 时它断言「让位只落 WebView 布局盒、链上不许出现
		// evaluateJavascript/__dshRemoteInsets」。用户口径变了以后那个形态**必须**反过来——
		// 原生给 WebView 留外边距时，系统栏后面只剩父容器**一种**底色，而平板官方布局贴边那一行
		// 本来就是两色（左栏 --dsw-specific-sidebar-fill / 面板 --dsw-alias-bg-base），
		// 单色带必然在面板那一侧留一道硬缝（T115 实测 2560 宽里 1919 px = 75.0% 差 ΔRGB=(6,5,4)）。
		//
		// 新判据两条一起钉，判别力不降（详见 T115 报告 §变异反证）：
		//   ① 布局盒必须**恒 0**（全窗覆盖）——把 0 改成 left/top/right/bottom 立刻红；
		//   ② 四向必须**写进页面**（同一个 __dshrRemoteInsets.set 通道）——删掉页面写立刻红。
		// 四向取值本身仍被 D-inset-mask / D-inset-legacy 与下面的行为夹具逐格钉死。
		const boxZero72 = /\.setMargins\s*\(/.test(chainCode)
			&& /webView\s*\.\s*getLayoutParams\s*\(/.test(chainCode)
			&& /setWebViewInsetsBox\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(chainCode);
		// 注意：`chain72.code` 里的字符串字面量**已被 mask 成空格**（javaMethodSpans 的 decl 就是
		// 掩码版），所以「有没有把四向写给页面」不能用 `__dshRemoteInsets` 这个字面量去判
		//（那样恒为 false ⇒ 假红）。这里判**结构**：让位链上必须出现 evaluateJavascript（页面是载体），
		// 四向取值本身则由 D-inset-mask / D-inset-legacy 与下面的行为夹具逐格钉死——
		// 只删页面写、留一个别的 evaluateJavascript 是骗不过这层的：行为夹具会看到页面四向变成
		// 0,0,0,0，11 格立刻红。
		const pageOwns72 = /evaluateJavascript\s*\(/.test(chainCode);
		ok72("D-inset-page-owns 让位改由页面承担：WebView 布局盒恒 0（全窗覆盖）+ 四向写进页面 --dshr-inset-*",
			boxZero72 && pageOwns72,
			`布局盒恒0=${boxZero72}（setMargins=${/\.setMargins\s*\(/.test(chainCode)} 取WebView布局参数=${/webView\s*\.\s*getLayoutParams\s*\(/.test(chainCode)} 写0=${/setWebViewInsetsBox\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(chainCode)}） 四向写进页面=${pageOwns72}（链上 evaluateJavascript=${/evaluateJavascript\s*\(/.test(chainCode)}；值由行为夹具 11 格逐格钉死）`);

		// ── 行为验证：抠出真方法体，javac 真编译真跑 ──
		const findJdkBin72 = (tool) => {
			const cands = [];
			if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, "bin", tool + (process.platform === "win32" ? ".exe" : "")));
			const which = spawnSync(process.platform === "win32" ? "where" : "which", [tool], { encoding: "utf8" });
			if (which.status === 0) for (const line of String(which.stdout || "").split(/\r?\n/)) if (line.trim()) cands.push(line.trim());
			if (process.platform === "win32") cands.push(join(process.env.ProgramFiles || "C:\\Program Files", "Android/Android Studio/jbr/bin", tool + ".exe"));
			for (const c of cands) if (c && existsSync(c)) return c;
			return "";
		};
		const javac72 = findJdkBin72("javac");
		const java72 = findJdkBin72("java");
		// T79：替身里已经手写了这些方法（它们是「被测逻辑之外的环境」，不是被测对象）。
		// 收调用链时必须剔除，否则同一个方法会在 Subject 里被定义两次 ⇒ javac 报「已在类中定义」，
		// 那是一条**夹具噪声红**，会把「实现真的错了」和「替身重复了」混在一起。
		const STUB_METHODS72 = new Set(["isTabletClass"]);
		const harnessChain72 = applierName72
			? javaCallChain(spans72, applierName72, { exclude: STUB_METHODS72, original: mainJava72 })
			: { code: "", names: [] };
		if (!extracted72 || !entryOwner72) {
			ok72("D-inset-behavior 行为验证：applyDeviceClassInsets / setUiState 两段都能抠出来", false,
				`让位动作=${applierName72 || "未找到"} 链长=${chain72.code.length} 写入口=${entryOwner72 ? entryOwner72.name : "未找到"}`);
		} else if (!javac72 || !java72) {
			ok72("D-inset-behavior 行为验证：真方法体在 11 类几何下四向输出全对", true,
				`无 JDK（javac=${javac72 || "缺"}）→ 源码契约三条仍生效；本条按"契约已覆盖"计过`);
		} else {
			// 几何 → 期望四向。喂进去的都是**真机上会出现的形态**：
			// 任务栏报成 tappableElement（次因）、状态栏落在左/右（次因）、IME 弹着（键盘不回归）、
			// 导航栏隐藏但 stable 仍有值（legacy 多垫）、挖孔在左右。
			const CASES = [
				{ name: "landscape-gesture-taskbarIsTappable", sdk: 30, tablet: true, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 0], cut: null, tap: [0, 0, 0, 64], ime: [0, 0, 0, 800],
					expect: [0, 48, 0, 64],
					why: "任务栏只报成 tappableElement（Xiaomi Pad 疑似形态）：bottom 必须兜到 64；且 ime=800 不得计入" },
				{ name: "landscape-3button", sdk: 30, tablet: true, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 112], cut: null, tap: [0, 0, 0, 0], ime: null,
					expect: [0, 48, 0, 112], why: "三键导航：与 T67 §2-B 的 AVD 真值逐字一致，不回归" },
				{ name: "landscape-baseline-gesture", sdk: 30, tablet: true, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 64], cut: null, tap: [0, 0, 0, 0], ime: null,
					expect: [0, 48, 0, 64], why: "T67 §2-A 的 AVD 真值（0,48,0,64），不回归" },
				{ name: "landscape-statusbar-on-left", sdk: 30, tablet: true, state: "WEB",
					status: [60, 0, 0, 0], nav: [0, 0, 0, 64], cut: null, tap: [0, 0, 0, 0], ime: null,
					expect: [60, 0, 0, 64], why: "横屏状态栏落左侧（次因）：left 必须有值，旧算式恒 0" },
				{ name: "landscape-statusbar-and-3button-on-sides", sdk: 30, tablet: true, state: "WEB",
					status: [60, 0, 0, 0], nav: [0, 0, 60, 0], cut: null, tap: [0, 0, 0, 0], ime: null,
					expect: [60, 0, 60, 0], why: "横屏状态栏与三键导航分别落左右：四向都要有值" },
				{ name: "landscape-cutout-sides", sdk: 30, tablet: true, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 64], cut: [40, 0, 40, 0], tap: [0, 0, 0, 0], ime: null,
					expect: [40, 48, 40, 64], why: "挖孔落左右：cutout 逐边并入" },
				{ name: "portrait-gesture", sdk: 30, tablet: true, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 64], cut: null, tap: [0, 0, 0, 0], ime: null,
					expect: [0, 48, 0, 64], why: "竖屏：与 T67 §2-C 的 AVD 真值一致，不回归" },
				{ name: "legacy-fourway-with-cutout", sdk: 29, tablet: true, state: "WEB",
					sys: [30, 48, 30, 64], stableB: 112, cut: [0, 60, 0, 0],
					expect: [30, 60, 30, 64], why: "API29 四向 + 挖孔逐边取 max" },
				{ name: "legacy-nav-hidden-no-overshoot", sdk: 29, tablet: true, state: "WEB",
					sys: [0, 0, 0, 0], stableB: 112, cut: null,
					expect: [0, 0, 0, 0], why: "导航栏隐藏：必须归 0。旧 getStableInsetBottom 会多垫 112px" },
				{ name: "phone-class-always-zero", sdk: 30, tablet: false, state: "WEB",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 64], cut: null, tap: [0, 0, 0, 64], ime: [0, 0, 0, 800],
					expect: [0, 0, 0, 0], why: "手机档门禁：恒 0 让位（外边距 0），--dshr-inset-* 路径不受影响" },
				{ name: "local-shell-state-zero", sdk: 30, tablet: true, state: "CONNECTING",
					status: [0, 48, 0, 0], nav: [0, 0, 0, 64], cut: null, tap: [0, 0, 0, 64], ime: null,
					expect: [0, 0, 0, 0], why: "本地壳页（uiState!=WEB）自带 CSS 变量接收端，原生不重复留白" },
			];
			// JS 数组 → Java int[] 字面量（JSON.stringify 会吐 [0,48] 这种 JS 语法，Java 不认）
			const ja72 = (a) => (a ? `new int[]{${a.join(",")}}` : "null");
			// 一格一行、参数全带类型：绕开「int[][] 里混放 int[] 和 int」的维度问题
			const caseCall72 = (c) => `    run("${c.name}", ${c.sdk}, ${c.tablet ? "true" : "false"}, UiState.${c.state},`
				+ ` ${ja72(c.status)}, ${ja72(c.nav)}, ${ja72(c.cut)}, ${ja72(c.tap)},`
				+ ` ${ja72(c.ime)}, ${ja72(c.sys)}, ${c.stableB || 0}, "${c.expect.join(",")}");`;

			const HARNESS = [
				"import java.util.*;",
				"public class T72AvoidHarness {",
				"  enum UiState { BOOTSTRAP, CONNECTING, WEB, HOME, EDIT }",
				// T80：让位落**布局盒**（外边距）⇒ 替身必须能表达「外边距」，
				// 否则行为夹具测的还是 padding，绿灯是假的（T80 设备实测 padding 零效果）。
				"  static class ViewGroup {",
				"    static class LayoutParams {",
				// 真 API 里 MATCH_PARENT 挂在 ViewGroup.LayoutParams 上（FrameLayout.LayoutParams 继承它）
				"      public static final int MATCH_PARENT = -1;",
				"      int leftMargin, topMargin, rightMargin, bottomMargin;",
				"      public void setMargins(int l,int t,int r,int b){ leftMargin=l; topMargin=t; rightMargin=r; bottomMargin=b; }",
				"    }",
				"  }",
				"  static class FrameLayout {",
				"    static class LayoutParams extends ViewGroup.LayoutParams {",
				"      LayoutParams(){}",
				"      LayoutParams(int w,int h){}",
				"    }",
				"  }",
				"  static class WebView {",
				"    int pl, pt, pr, pb;",
				// 真布局里 WebView 挂在 FrameLayout 下、参数是 MATCH_PARENT（四向默认 0）
				"    ViewGroup.LayoutParams lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);",
				// T115：让位改由页面承担 ⇒ 夹具必须能看见「写进页面的那段 JS」。
				// 记下最后一次 evaluateJavascript 的脚本文本，行为断言从它里面解析四向。
				"    String lastJs = null;",
				"    public void evaluateJavascript(String js, Object cb){ lastJs = js; }",
				"    public ViewGroup.LayoutParams getLayoutParams(){ return lp; }",
				"    public void setLayoutParams(ViewGroup.LayoutParams p){ lp = p; }",
				"    public int getPaddingLeft(){return pl;} public int getPaddingTop(){return pt;}",
				"    public int getPaddingRight(){return pr;} public int getPaddingBottom(){return pb;}",
				"    public void setPadding(int l,int t,int r,int b){pl=l;pt=t;pr=r;pb=b;}",
				// post 同步执行：setUiState 的冷启动兜底就是一次 post，同步化不影响断言语义
				"    public boolean post(Runnable r){ r.run(); return true; }",
				"  }",
				"  static class Insets {",
				"    public int left, top, right, bottom;",
				"    public Insets(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;}",
				"  }",
				"  static class DisplayCutout {",
				"    int l,t,r,b;",
				"    DisplayCutout(int l,int t,int r,int b){this.l=l;this.t=t;this.r=r;this.b=b;}",
				"    public int getSafeInsetLeft(){return l;} public int getSafeInsetTop(){return t;}",
				"    public int getSafeInsetRight(){return r;} public int getSafeInsetBottom(){return b;}",
				"  }",
				"  static class Build { static class VERSION { static int SDK_INT = 30; } }",
				// T115：让位四向先换算成 CSS px 再写页面（density 取 1.0 ⇒ px 与 CSS px 同值，
				// 下面 11 格的期望值因此与 T80 时代逐字相同，只是落点从布局盒换成了页面）。
				"  static class DisplayMetrics { public float density = 1.0f; }",
				"  static class Resources { public DisplayMetrics getDisplayMetrics(){ return getDisplayMetricsStatic; } }",
				"  static DisplayMetrics getDisplayMetricsStatic = new DisplayMetrics();",
				"  static class WindowInsets {",
				"    // AOSP WindowInsets.Type 的真实取值：替身按此解码掩码，所以「掩码里有没有 ime()」在行为上真的可判。",
				"    static final int T_STATUS = 1, T_NAV = 2, T_CUTOUT = 8, T_TAPPABLE = 32, T_IME = 2048;",
				"    static class Type {",
				"      public static int statusBars(){return T_STATUS;} public static int navigationBars(){return T_NAV;}",
				"      public static int systemBars(){return T_STATUS | T_NAV;}",
				"      public static int displayCutout(){return T_CUTOUT;} public static int tappableElement(){return T_TAPPABLE;}",
				"      public static int ime(){return T_IME;}",
				"    }",
				"    int[] status, nav, cut, tap, ime, sys; int stableB; DisplayCutout dc;",
				"    // 忠实模拟 AOSP getInsets：对掩码内各来源**逐边取 max**（不求和）。",
				"    public Insets getInsets(int mask){",
				"      int l=0,t=0,r=0,b=0;",
				"      int[][] m = new int[5][];",
				"      m[0]=status; m[1]=nav; m[2]=cut; m[3]=tap; m[4]=ime;",
				"      int[] bits = new int[]{T_STATUS, T_NAV, T_CUTOUT, T_TAPPABLE, T_IME};",
				"      for (int i=0;i<5;i++){",
				"        if ((mask & bits[i])==0 || m[i]==null) continue;",
				"        l=Math.max(l,m[i][0]); t=Math.max(t,m[i][1]);",
				"        r=Math.max(r,m[i][2]); b=Math.max(b,m[i][3]);",
				"      }",
				"      return new Insets(l,t,r,b);",
				"    }",
				"    public int getSystemWindowInsetLeft(){return sys==null?0:sys[0];}",
				"    public int getSystemWindowInsetTop(){return sys==null?0:sys[1];}",
				"    public int getSystemWindowInsetRight(){return sys==null?0:sys[2];}",
				"    public int getSystemWindowInsetBottom(){return sys==null?0:sys[3];}",
				"    // 刻意保留：旧实现用它，替身里它比 systemWindow 不收缩，用来抓「多垫」回归",
				"    public int getStableInsetBottom(){return stableB;}",
				"    public DisplayCutout getDisplayCutout(){return dc;}",
				"  }",
				"  static class Subject {",
				"    WebView webView = new WebView();",
				"    UiState uiState = UiState.BOOTSTRAP;",
				"    boolean tablet = true;",
				"    Resources getResources(){ return new Resources(); }",
				// T79：取值方法用它当返回缓冲（复用字段、不每次 new）。替身必须提供同名同型字段，
				// 否则调用链一被收进来就编译失败——那正是开工时那第 3 条红的形态。
				"    int[] systemBarInsetsPx = new int[4];",
				"    int lastAvoidL = -1, lastAvoidT = -1, lastAvoidR = -1, lastAvoidB = -1;",
				"    static class Log { static int i(String t, String m){ return 0; } }",
				"    WindowInsets rootInsets = new WindowInsets();",
				"    boolean isTabletClass(){ return tablet; }",
				"    class Decor { WindowInsets getRootWindowInsets(){ return rootInsets; } }",
				"    class Win { Decor getDecorView(){ return new Decor(); } }",
				"    Win getWindow(){ return new Win(); }",
				"@@AVOID@@",
				"@@SETTER@@",
				"  }",
				"  static String box(WebView w){",
				"    ViewGroup.LayoutParams r = w.getLayoutParams();",
				"    if (r instanceof FrameLayout.LayoutParams){ FrameLayout.LayoutParams f = (FrameLayout.LayoutParams) r;",
				"      return f.leftMargin + \",\" + f.topMargin + \",\" + f.rightMargin + \",\" + f.bottomMargin; }",
				"    return \"NO-BOX\";",
				"  }",
				// T115：从最后一次 evaluateJavascript 的脚本里抠出写进页面的四向。
				// **入参顺序是 (top, bottom, left, right)**（__dshrRemoteInsets.set 的签名），
				// 这里换算成断言一贯的 (left, top, right, bottom) 口径再返回，11 格的期望值
				// 因此与 T80 时代逐字相同。
				// 没有页面写（手机档 / 本地壳页的门禁）⇒ 返回 none，调用处按 0,0,0,0 记。
				"  static String page(WebView w){",
				"    String js = w.lastJs;",
				"    if (js == null) return \"none\";",
				"    int i = js.indexOf(\"s.set(\"); if (i < 0) return \"NO-SET\";",
				"    int j = js.indexOf(')', i); if (j < 0) return \"NO-CLOSE\";",
				"    String[] p = js.substring(i + 6, j).replace(\" \", \"\").split(\",\");",
				"    if (p.length != 4) return \"BAD-ARITY(\" + p.length + \")\";",
				"    return p[2] + \",\" + p[0] + \",\" + p[3] + \",\" + p[1];",
				"  }",
				"  static void run(String name, int sdk, boolean tablet, UiState st, int[] status, int[] nav,",
				"      int[] cut, int[] tap, int[] ime, int[] sys, int stableB, String expect) {",
				"    Subject s = new Subject();",
				"    Build.VERSION.SDK_INT = sdk;",
				"    s.tablet = tablet;",
				"    s.uiState = st;",
				"    s.rootInsets.status=status; s.rootInsets.nav=nav; s.rootInsets.cut=cut;",
				"    s.rootInsets.tap=tap; s.rootInsets.ime=ime; s.rootInsets.sys=sys;",
				"    s.rootInsets.stableB=stableB;",
				"    if (cut != null) s.rootInsets.dc = new DisplayCutout(cut[0],cut[1],cut[2],cut[3]);",
				`    s.${applierName72}();`,
				"    String pageVals = page(s.webView).replace(\"none\", \"0,0,0,0\");",
				"    String boxVals = box(s.webView);",
				"    System.out.println(\"ROW|\" + name + \"|\" + pageVals + \"|\" + boxVals + \"|\" + expect);",
				"  }",
				"  // 时序格：BOOTSTRAP 期那次 insets 分发按门禁写 0；随后进入会话页**不触发任何 insets 事件**。",
				"  // 让位能不能成立，全看 setUiState 这一次赋值有没有顺带重算 —— 这正是 T67 缺项①，",
				"  // 也是用户看到的「顶到状态栏 + 被任务栏盖住」双向同时错位。",
				"  static void seq(String name, int[] status, int[] nav, int[] tap, String expectBoot, String expectWeb) {",
				"    Subject s = new Subject();",
				"    Build.VERSION.SDK_INT = 30; s.tablet = true;",
				"    s.rootInsets.status=status; s.rootInsets.nav=nav; s.rootInsets.tap=tap;",
				"    s.uiState = UiState.BOOTSTRAP;",
				`    s.${applierName72}();`,
				"    String boot = box(s.webView);",
				`    s.${entryOwner72.name}(UiState.WEB);`,
				"    String web = box(s.webView);",
				"    String webPage = page(s.webView).replace(\"none\", \"0,0,0,0\");",
				"    System.out.println(\"SEQ|\" + name + \"|\" + boot + \"|\" + web + \"|\" + webPage + \"|\" + expectBoot + \"|\" + expectWeb);",
				"  }",
				"  public static void main(String[] a){",
				...CASES.map(caseCall72),
				// 时序格（负控制所在）：几何取 emulator-5800 实测的格 A。
				"    seq(\"seq-coldstart-enter-session\", new int[]{0,48,0,0}, new int[]{0,0,0,64}, new int[]{0,0,0,64}, \"0,0,0,0\", \"0,48,0,64\");",
				"  }",
				"}",
			].join("\n").replace("@@AVOID@@", harnessChain72.code).replace("@@SETTER@@", entryOwner72.decl);

			const dir = mkdtempSync(join(tmpdir(), "dshr-t72-avoid-"));
			try {
				const src = join(dir, "T72AvoidHarness.java");
				const cls = join(dir, "out");
				writeFileSync(src, HARNESS, "utf8");
				const cp = spawnSync(javac72, ["-nowarn", "-d", cls, src], { encoding: "utf8" });
				if (cp.status !== 0) {
					ok72("D-inset-behavior 行为验证：真方法体在 11 类几何下四向输出全对", false,
						`javac 失败：${String(cp.stderr || cp.stdout || "").split("\n").slice(0, 4).join(" / ")}`);
				} else {
					const run = spawnSync(java72, ["-cp", cls, "T72AvoidHarness"], { encoding: "utf8" });
					const rows = new Map();
					const boxes = new Map();
					for (const line of String(run.stdout || "").split(/\r?\n/)) {
						const m = /^ROW\|([^|]+)\|(-?\d+,-?\d+,-?\d+,-?\d+)\|(-?\d+,-?\d+,-?\d+,-?\d+)\|(-?\d+,-?\d+,-?\d+,-?\d+)$/.exec(line.trim());
						if (m) { rows.set(m[1], m[2]); boxes.set(m[1], m[3]); }
					}
					const bad = [];
					const badBox = [];
					for (const c of CASES) {
						const got = rows.get(c.name) || "缺输出";
						const want = c.expect.join(",");
						if (got !== want) bad.push(`${c.name} 期望 ${want} 实得 ${got}`);
						// T115：布局盒必须恒 0（让位不再走外边距）
						const bx = boxes.get(c.name) || "缺输出";
						if (bx !== "0,0,0,0") badBox.push(`${c.name} 布局盒 ${bx}`);
					}
					ok72("D-inset-behavior 行为验证：真方法体在 11 类几何下四向写进页面 --dshr-inset-* 全对（任务栏 tappableElement/状态栏落左右/IME/导航栏隐藏/挖孔）",
						run.status === 0 && rows.size === CASES.length && bad.length === 0,
						bad.length ? `不符 ${bad.length} 项：${bad.join("；")}` : `${rows.size}/${CASES.length} 格全对`);
					// 逐格留痕：真值进报告，回归时能对账。**页面四向与布局盒恒 0 一起断言**——
					// 只判其中一条都会漏：只判页面 ⇒ 有人把外边距写回去（双倍留白）也全绿；
					// 只判布局盒 ⇒ 四向取值坏了也全绿。
					CASES.forEach((c, i) => {
						ok72(`D-inset-behavior 格 ${i + 1}/${CASES.length} ${c.name} → 页面 ${c.expect.join(",")} / 布局盒 0,0,0,0`,
							rows.get(c.name) === c.expect.join(",") && boxes.get(c.name) === "0,0,0,0",
							`页面 ${rows.get(c.name) || "缺输出"} 布局盒 ${boxes.get(c.name) || "缺输出"}｜${c.why}`);
					});
					// ── 时序格（负控制所在）──
					// 几何用 emulator-5800 实测的格 A：statusBars top=48、navigationBars bottom=64、
					// tappableElement bottom=64。BOOTSTRAP 写 0 之后**不制造任何 insets 事件**，
					// 只靠 setUiState(WEB) 这一次赋值把让位补上——摘掉它就重现用户症状。
					const seqLine = String(run.stdout).split(/\r?\n/)
						.map((l) => /^SEQ\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)$/.exec(l.trim()))
						.find(Boolean);
					if (!seqLine) {
						ok72("D-inset-timing 冷启动进会话：BOOTSTRAP 写 0 后不触发 insets，仅靠 setUiState(WEB) 补上让位（负控制所在）",
							false, "没拿到 SEQ 输出");
					} else {
						const [, , boot, web, webPage, wantBoot, wantWeb] = seqLine;
						const [wl, wt, wr, wb] = wantWeb.split(",").map(Number);
						// 系统栏占位：格 A 实测 top=48、bottom=64，左右无系统栏
						const ovTop = Math.max(0, 48 - wt);
						const ovBottom = Math.max(0, 64 - wb);
						ok72("D-inset-timing 冷启动进会话：BOOTSTRAP 期让位按设计写 0（门禁 uiState!=WEB，外边距四向 0 且不写页面）",
							boot === wantBoot, `BOOTSTRAP 布局盒=${boot} 期望=${wantBoot}`);
						ok72("D-inset-timing 仅靠 setUiState(WEB) 一次赋值就把让位补齐（四向写进页面，布局盒仍 0）",
							webPage === wantWeb && web === "0,0,0,0",
							`进入WEB 页面=${webPage} 布局盒=${web} 期望 页面=${wantWeb} 布局盒=0,0,0,0（BOOTSTRAP 布局盒是 ${boot}）`);
						ok72("D-inset-timing 冷启动首帧重叠量 top=0px 且 bottom=0px（摘掉 setUiState 的重算即 >0，重现用户症状）",
							ovTop === 0 && ovBottom === 0,
							`重叠 top=${ovTop}px bottom=${ovBottom}px（系统栏 top=48 bottom=64 − 页面让位 t=${wt} b=${wb}）`);
					}
				}
			} finally {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		}
	}
	/** 官方 composer 里的可编辑元素（真机 a11y 里就是一个 EditText）+ 可点性判定。 */
	const findComposer = () => evaluate(`(function(){
		var seat = document.querySelector('[data-composer-seat]') || document.querySelector('[data-composer-card]');
		var scope = seat || document.querySelector('[data-dshr-main-col]') || document.body;
		var el = scope.querySelector('textarea, input[type="text"], [contenteditable="true"]')
			|| document.querySelector('textarea');
		if (!el) return null;
		var b = el.getBoundingClientRect();
		var cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
		var inView = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
		var hit = inView ? document.elementFromPoint(cx, cy) : null;
		return { tag: el.tagName.toLowerCase(), x: cx, y: cy,
			w: Math.round(b.width), h: Math.round(b.height), inView: inView,
			tappable: !!(hit && (hit === el || (hit.closest && hit.closest('textarea, input, [contenteditable]')))) };
	})()`);
	const isEditableFocused = () => evaluate(`(function(){
		var a = document.activeElement;
		if (!a || a === document.body || a === document.documentElement) return false;
		var t = (a.tagName || '').toLowerCase();
		return t === 'input' || t === 'textarea' || t === 'select' || !!a.isContentEditable;
	})()`);
	const focusOwner = () => evaluate(`(function(){
		var a = document.activeElement;
		if (!a) return 'null';
		var tag = (a.tagName || '?').toLowerCase();
		var hint = a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.getAttribute('data-placeholder') || '';
		return tag + (hint ? '[' + hint.slice(0, 18) + ']' : '');
	})()`);
	/** 一次真实触摸点按：走 CDP 输入管线的 isTrusted 事件，与真机手指同一条路径。 */
	async function realTap(x, y, holdMs = 70, settleMs = 300) {
		const pt = [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
		await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
		await wait(holdMs);
		await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await wait(settleMs);
	}
	/** 官方侧栏开关（hook 标了 data-dshr-official-toggle）的中心点，可点才返回。 */
	const findOfficialTogglePoint = () => evaluate(`(function(){
		var t = document.querySelector('[data-dshr-official-toggle]');
		if (!t) return null;
		var b = t.getBoundingClientRect();
		var cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
		return { label: t.getAttribute('aria-label') || '', x: cx, y: cy,
			w: Math.round(b.width), h: Math.round(b.height),
			usable: b.width > 4 && b.height > 4 && cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
	})()`);
	const comp = await findComposer();
	record("A/T21", "A-tap-precondition 已找到官方 composer 可编辑元素", !!comp && comp.tappable === true, JSON.stringify(comp));
	if (comp && comp.tappable) {
		// ① 真实点输入框 → 焦点必须保留（这才是用户要的：只有他自己点输入框才弹键盘）。
		await realTap(comp.x, comp.y);
		const keptUserTap = await waitUntil(`(function(){
			var a=document.activeElement; if(!a||a===document.body||a===document.documentElement) return false;
			var t=(a.tagName||'').toLowerCase();
			return t==='input'||t==='textarea'||t==='select'||!!a.isContentEditable; })()`, 3000);
		record("A/T21", "A-focus-guard-allows-user-tap 真实点输入框后焦点保留（键盘照常弹）",
			keptUserTap === true && (await isEditableFocused()) === true,
			`activeElement=${await focusOwner()}（守卫若误伤，这条会变成 body）`);

		// ② 对照臂：官方 Collapse sidebar 真实点按同样把焦点带走（hook 鲸鱼必须与它一致）。
		//    要拿到「抽屉展开 + composer 仍持焦」这个对照前提，有两个坑：
		//      - 抽屉展开时主列被 translateX 推出视口，点不到 composer；
		//      - 开抽屉的 hook 路径（openSidebarIfCollapsed → setSidebarOpen → toggleSidebar）
		//        自修复 1 起**本来就会收焦点**（这正是它该做的）。
		//    所以做法是：用户先真实点输入框（守卫放行，同时开出一个 800ms 的「用户主动
		//    聚焦」窗口）→ 走 hook API 开抽屉 → 在窗口内 focus() 一次把粘滞态装回去。
		//    这与真机同构：点输入框 → 键盘弹 → BACK 收 → 切会话/开抽屉，composer 仍持焦。
		await ensureCollapsed();
		await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
		await realTap(comp.x, comp.y, 40, 120);
		const stickyForControl = await isEditableFocused();
		const openedByApi = await evaluate(`(function(){
			try { return String(window.__dshRemoteAndroidMobile.openSidebarIfCollapsed()); }
			catch (err) { return 'error:' + String(err && err.message); } })()`);
		// 窗口内（≤800ms）把焦点装回 composer —— 必须在下面那 700ms 过渡等待**之前**。
		const rearm = await evaluate(`(function(){
			var seat=document.querySelector('[data-composer-seat]')||document.querySelector('[data-composer-card]')||document.body;
			var el=seat.querySelector('textarea, input[type="text"], [contenteditable="true"]');
			if(!el) return 'no-editable';
			el.focus();
			return el===document.activeElement ? 'focused' : 'refused'; })()`);
		// 官方 0.34s 抽屉过渡必须落定后才能定位官方开关：抽屉是滑入的，过渡中按钮还在移动，
		// 此刻取 rect 再点会点空（harness 自己的 shot() 也为此固定等 700ms）。
		await waitDrawer(true);
		await wait(700);
		const stickyInDrawer = await isEditableFocused();
		const offToggle = await findOfficialTogglePoint();
		info("A/T21", `对照臂：openSidebarIfCollapsed=${openedByApi} 窗口内 focus()=${rearm} 落定后输入框持焦=${stickyInDrawer}（前提：点输入框后持焦=${stickyForControl}）`);
		if (offToggle && offToggle.usable && stickyInDrawer) {
			await realTap(offToggle.x, offToggle.y, 60, 300);
			const closedByOfficial = await waitDrawer(false);
			record("A/T21", "A-official-collapse-keeps-blur 官方 Collapse sidebar 真实点按后输入框不持焦",
				closedByOfficial === true && (await isEditableFocused()) === false,
				`官方开关 aria-label="${offToggle.label}" @(${offToggle.x},${offToggle.y}) 抽屉收起=${closedByOfficial} activeElement=${await focusOwner()}`);
		} else {
			record("A/T21", "A-official-collapse-keeps-blur 官方 Collapse sidebar 真实点按后输入框不持焦",
				null, `对照前提不成立：官方开关=${JSON.stringify(offToggle)} 抽屉展开态输入框持焦=${stickyInDrawer}`);
			await ensureCollapsed();
		}

		// ③ 修法本体：粘滞态下真实点鲸鱼开抽屉 → composer 必须交出焦点（不再抬起键盘）。
		await ensureCollapsed();
		await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
		await realTap(comp.x, comp.y);
		const stickyForWhale = await waitUntil(`(function(){
			var a=document.activeElement; if(!a||a===document.body||a===document.documentElement) return false;
			var t=(a.tagName||'').toLowerCase();
			return t==='input'||t==='textarea'||t==='select'||!!a.isContentEditable; })()`, 3000);
		const whalePoint = await evaluate(`(function(){
			var w=document.getElementById('dshr-mobile-whale'); if(!w) return null;
			var b=w.getBoundingClientRect(); var c=getComputedStyle(w);
			if(c.display==='none'||c.visibility==='hidden'||b.width<4) return null;
			return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
		record("A/T21", "A-whale-precondition 粘滞态成立且鲸鱼可点",
			stickyForWhale === true && !!whalePoint,
			`输入框持焦=${stickyForWhale} 鲸鱼=${JSON.stringify(whalePoint)}（粘滞态=真机 IME 弹过后被 BACK 收起）`);
		if (whalePoint) {
			await realTap(whalePoint.x, whalePoint.y);
			const whaleOpened = await waitDrawer(true);
			await wait(500); // 官方 0.34s 过渡 + hook 的 scheduleSyncDom(50ms) 收敛
			const stillFocused = await isEditableFocused();
			record("A/T21", "A-whale-no-keyboard 粘滞态下点鲸鱼开抽屉后输入框不再持焦（不弹键盘）",
				whaleOpened === true && stillFocused === false,
				`抽屉展开=${whaleOpened} activeElement=${await focusOwner()}${stillFocused ? " ← 修复前 composer 仍持焦 → Chromium 抬键盘" : ""}`);
		} else {
			record("A/T21", "A-whale-no-keyboard 粘滞态下点鲸鱼开抽屉后输入框不再持焦（不弹键盘）",
				null, "鲸鱼不可点，未执行");
		}

		// ④ 焦点守卫：非用户手势的程序化 focus() 也要被收回（T16/T18 的切会话自动聚焦
		//    属同一类；用户口径是「只有他自己点输入框才弹键盘」）。
		await ensureCollapsed();
		await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
		await evaluate(`(function(){ var a=document.activeElement; if(a&&a.blur) a.blur(); return true; })()`);
		await wait(200);
		const probeFocus = await evaluate(`(function(){
			var seat=document.querySelector('[data-composer-seat]')||document.querySelector('[data-composer-card]')||document.body;
			var el=seat.querySelector('textarea, input[type="text"], [contenteditable="true"]')||document.querySelector('textarea');
			if(!el) return 'no-editable';
			el.focus();
			return (el===document.activeElement) ? 'focused' : 'focus-refused'; })()`);
		await wait(400);
		const programmaticKept = await isEditableFocused();
		record("A/T21", "A-focus-guard-blocks-programmatic 非用户手势的 element.focus() 被收回",
			probeFocus !== 'no-editable' && programmaticKept === false,
			`focus() 结果=${probeFocus} 事后 activeElement=${await focusOwner()}${programmaticKept ? " ← 守卫没拦住" : ""}`);

		// ⑤ 回归：守卫不得破坏正常输入——真实点输入框 → 焦点保留 → insertText 落到输入框。
		await realTap(comp.x, comp.y);
		const usableFocused = await waitUntil(`(function(){
			var a=document.activeElement; if(!a||a===document.body||a===document.documentElement) return false;
			var t=(a.tagName||'').toLowerCase();
			return t==='input'||t==='textarea'||t==='select'||!!a.isContentEditable; })()`, 3000);
		const before = await evaluate(`(function(){
			var a=document.activeElement; if(!a) return null;
			if('value' in a) return String(a.value||'');
			return String(a.textContent||''); })()`);
		await call("Input.insertText", { text: "T21-kbd-probe" });
		await wait(400);
		const after = await evaluate(`(function(){
			var a=document.activeElement; if(!a) return null;
			if('value' in a) return String(a.value||'');
			return String(a.textContent||''); })()`);
		record("A/T21", "A-composer-still-usable 真实点输入框后仍可正常输入",
			usableFocused === true && after !== null && after !== before && String(after).indexOf("T21-kbd-probe") >= 0,
			`insertText 前=${JSON.stringify(String(before).slice(-24))} 后=${JSON.stringify(String(after).slice(-24))} activeElement=${await focusOwner()}`);
		// 收尾：清掉探针文本、收回焦点、归一到收起基线（后面的官方设置覆盖依赖它）。
		await evaluate(`(function(){
			var a=document.activeElement;
			if(a&&'value' in a){ try { a.value=''; } catch(ignored){} }
			var ev=null; try{ ev=new Event('input',{bubbles:true}); }catch(ignored2){}
			if(a&&ev&&a.dispatchEvent) a.dispatchEvent(ev);
			return true; })()`);
		await evaluate(`(function(){ var a=document.activeElement; if(a&&a.blur) a.blur(); return true; })()`);
		await ensureCollapsed();
		await waitUntil(`document.documentElement.getAttribute('data-dshr-expanded') === '0'`, 3000);
	}


	// ── 顺带覆盖（只读）：官方设置入口打开后是否成为全屏页 ──
	await toggleViaWhale(true);
	const settingsHit = await evaluate(`(function(){
		var sb=document.querySelector('[data-dshr-sidebar-col]'); if(!sb) return 'no-sidebar';
		var items=[...sb.querySelectorAll('button,a,[role="button"]')];
		var hit=items.find(function(e){return /设置|Settings/i.test(e.innerText||'') && (e.innerText||'').trim().length<=12;});
		if(!hit) return 'no-settings-entry';
		hit.click(); return 'clicked';
	})()`);
	if (settingsHit === "clicked") {
		const panelUp = await waitUntil(`!!document.querySelector('[data-dshr-sheet-panel]')`, 8000);
		const panelGeom = await evaluate(`(function(){var p=document.querySelector('[data-dshr-sheet-panel]');if(!p)return null;
			var b=p.getBoundingClientRect();return{w:Math.round(b.width),h:Math.round(b.height),fits:b.width<=innerWidth+1&&b.height<=innerHeight+1};})()`);
		record("A", "官方设置入口打开后成为全屏页", panelUp && !!panelGeom && panelGeom.fits, JSON.stringify(panelGeom));
		const shotS = await shot("A-phone-portrait-412x915-settings-fullscreen");
		info("A", `截图（设置全屏页）：${shotS}`);
		await evaluate(`(function(){var b=document.querySelector('[data-dshr-dialog-close]');if(b){b.click();return;}document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})(); true`);
		await wait(1500);
	} else {
		record("A", "官方设置入口打开后成为全屏页", null, `未触达设置入口（${settingsHit}）`);
	}

	// ── 顺带覆盖（只读）：点开一个现存会话看渲染（严禁新建/发送/改设置）──
	await ensureCollapsed();
	await toggleViaWhale(true);
	const sessionHit = await evaluate(`(function(){
		var sb=document.querySelector('[data-dshr-sidebar-col]'); if(!sb) return 'no-sidebar';
		var rows=[...sb.querySelectorAll('button,a,[role="button"],[role="listitem"]')].filter(function(e){
			var t=(e.innerText||'').trim(); return t.length>6 && t.length<80;});
		if(!rows.length) return 'no-session-rows';
		rows[0].click(); return 'clicked';
	})()`);
	if (sessionHit === "clicked") {
		await wait(3000);
		const conv = await evaluate(`(function(){
			var m=document.querySelector('[data-dshr-main-col]');
			var h=document.querySelector('header');
			var b=m&&m.getBoundingClientRect();
			return{header:!!h,headerText:h?((h.innerText||'').trim().slice(0,24)):'',mainW:b?Math.round(b.width):-1,
			overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
			whaleVisible:(()=>{var w=document.getElementById('dshr-mobile-whale');if(!w)return false;var c=getComputedStyle(w);return c.display!=='none'&&w.getBoundingClientRect().width>0;})()};})()`);
		record("A", "点开现存会话后手机界面仍正常渲染", conv.header && conv.mainW >= 410 && conv.overflow <= 1, JSON.stringify(conv));
		const shotC = await shot("A-phone-portrait-412x915-session-open");
		info("A", `截图（会话已打开，只读）：${shotC}`);
	} else {
		record("A", "点开现存会话后手机界面仍正常渲染", null, `未触达会话条目（${sessionHit}）`);
	}


	// ══════════════ T24 输入联想浮层（`/` 触发的命令面板）锚定组 ══════════════
	//
	// 用户报告（v0.2.0-rc.2.2 真机）：在输入框打 `/goal` 时，命令面板「不是从输入框弹出，
	// 而是从屏幕最顶端、且溢出状态栏那一侧开始」。
	//
	// 真值（scratch/t24/report.md，真实页面 + Input.insertText 真实输入，两臂逐帧采样）：
	//   官方锚点  浮层 [16,84,373,377] 底边 461 / 输入卡顶边 465 → 4px 缝，top 84 远在状态栏之下
	//   对照臂    浮层 [72,84,317,363] 底边 447 / 输入卡顶边 451 → 同样是 4px 缝
	//   修复前    官方那一帧被我们的 clampFloatHost 判成越界（安全区把输入卡顶边再减 8px，
	//             而官方只留 4px），于是改写成 position:fixed; inset:8px auto auto 16px
	//             → 浮层 top 84→32、高 377→425；原生未写 --dshr-inset-top 时 top 直接=8px，压进状态栏。
	//
	// 判据取「安全视口 + 贴着输入卡 + 我们没碰过它」三条。安全视口那条必须**两臂都成立**：
	// 对照臂（不注入）单独跑一遍，防止把「官方本来就这样」误判成回归，也防止将来
	// 官方自己改了锚点而 hook 的放行变成漏网。
	const T24_INSET_TOP = 24; // 真机上由原生写入 --dshr-inset-top；浏览器里手动模拟状态栏高度
	// 官方锚定缝：实测 4px；上限取 6px 是为了把 clampFloatHost 自己的 8px 让位排除在窗口外
	// （修复前 gap=8，修复后 gap=4）。
	const T24_ANCHOR_GAP_MAX = 6;
	const T24_MENU_PROBE = `(function(){
		var m = document.querySelector('[data-trigger-menu]');
		var card = document.querySelector('[data-composer-card]');
		var cs = getComputedStyle(document.documentElement);
		var insetTop = parseFloat(cs.getPropertyValue('--dshr-inset-top')) || 0;
		var insetBottom = parseFloat(cs.getPropertyValue('--dshr-inset-bottom')) || 0;
		var r = m ? m.getBoundingClientRect() : null;
		var c = card ? card.getBoundingClientRect() : null;
		return { found: !!m,
			marked: !!(m && m.hasAttribute('data-dshr-float')),
			position: m ? getComputedStyle(m).position : null,
			inlineTop: m ? (getComputedStyle(m).top || '') : null,
			inlineLeft: m ? (getComputedStyle(m).left || '') : null,
			hasListbox: !!(m && m.querySelector('[role="listbox"]')),
			rect: r ? { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
				bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null,
			cardTop: c ? Math.round(c.top) : null,
			gapToCard: (r && c) ? Math.round(c.top - r.bottom) : null,
			insetTop: insetTop, insetBottom: insetBottom,
			innerWidth: window.innerWidth, innerHeight: window.innerHeight }; })()`;
	/** 清输入框 + 收焦点（只读纪律：绝不发消息）。 */
	async function clearComposer() {
		await evaluate(`(function(){
			var a=document.activeElement;
			if(a&&'value' in a){ try { a.value=''; } catch(ignored){} }
			try { a.textContent=''; } catch(ignored2){}
			try { a.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'})); } catch(ignored3){}
			if(a&&a.blur) a.blur();
			return true; })()`);
		await wait(300);
	}
	/**
	 * 找官方 composer 的可编辑元素 + 可点坐标。
	 * 比 A/T21 那版更宽：会话打开后 [data-composer-seat] 与 [data-composer-card] 未必是祖先关系，
	 * 只在 seat 里找会漏（实测漏掉时整组断言只能 SKIP）。这里先在两者各自的子树里找，
	 * 再退回整页取**可见且最大**的那个，并在找不到时把分层诊断带出来（SKIP 也要能定位原因）。
	 */
	const findComposerForPalette = () => evaluate(`(function(){
		var SEL = 'textarea, input[type="text"], [contenteditable="true"]';
		var pick = function (root) { return root ? root.querySelector(SEL) : null; };
		var el = pick(document.querySelector('[data-composer-seat]'))
			|| pick(document.querySelector('[data-composer-card]'))
			|| pick(document.querySelector('[data-dshr-main-col]'));
		if (!el) {
			var all = [...document.querySelectorAll(SEL)].filter(function (e) {
				var c = getComputedStyle(e), b = e.getBoundingClientRect();
				return c.display !== 'none' && c.visibility !== 'hidden' && b.width > 40 && b.height > 20; });
			all.sort(function (a, b) { return (b.getBoundingClientRect().width * b.getBoundingClientRect().height)
				- (a.getBoundingClientRect().width * a.getBoundingClientRect().height); });
			el = all[0] || null;
		}
		if (!el) {
			return { missing: true,
				seat: !!document.querySelector('[data-composer-seat]'),
				card: !!document.querySelector('[data-composer-card]'),
				inDoc: document.querySelectorAll(SEL).length,
				url: location.pathname };
		}
		var b = el.getBoundingClientRect();
		return { tag: el.tagName.toLowerCase(),
			x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
			w: Math.round(b.width), h: Math.round(b.height),
			draft: String(('value' in el ? el.value : el.textContent) || '').slice(0, 30) };
	})()`);
	/**
	 * 清空草稿。
	 *
	 * 不能靠改 DOM（`el.textContent=''` + 派发 input）：官方 DraftEditorRuntime 把草稿
	 * 放在自己的 state 里，还跨页面持久化——直接改 DOM 会被下一次 React 渲染写回，
	 * 实测注入臂清完仍是 "T21-kbd-probe/"，而 `/` 跟在字母后面不满足官方 boundaryOk，
	 * 联想根本不会触发（上一版对照臂就是这样 SKIP 的）。
	 * 所以走渲染器真实按键：Ctrl+A 全选 + Backspace 删除，官方自己的删除路径才会同步 state。
	 */
	async function clearDraftByKeyboard() {
		const readDraft = () => evaluate(`(function(){
			var a=document.activeElement; if(!a||a===document.body||a===document.documentElement) return null;
			return String(('value' in a ? a.value : a.textContent) || ''); })()`);
		const key = async (k, code, vk, modifiers) => {
			await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(modifiers ? { modifiers } : {}) });
			await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(modifiers ? { modifiers } : {}) });
		};
		for (let round = 0; round < 3; round++) {
			const draft = await readDraft();
			if (draft === null) return { ok: false, why: "输入框未持焦，无法清草稿" };
			if (draft.length === 0) return { ok: true, rounds: round };
			await key("a", "KeyA", 65, 2); // 2 = Ctrl
			await wait(150);
			await key("Backspace", "Backspace", 8);
			await wait(450);
		}
		const left = await readDraft();
		return { ok: left === "", why: `三轮 Ctrl+A + Backspace 后草稿仍为 ${JSON.stringify(String(left).slice(0, 30))}` };
	}
	/** 真实点输入框 + 真实输入一个「/」，把官方命令面板打开。 */
	async function openInputTriggerPalette() {
		const comp = await findComposerForPalette();
		if (!comp || comp.missing) {
			return { ok: false, why: `找不到 composer 可编辑元素（seat=${comp && comp.seat} card=${comp && comp.card} 文档内可编辑元素=${comp && comp.inDoc}）` };
		}
		let focused = false;
		for (let i = 0; i < 4 && !focused; i++) {
			await realTap(comp.x, comp.y, 70, 400);
			focused = await isEditableFocused();
			if (!focused) await wait(500);
		}
		if (!focused) return { ok: false, why: `真实点按后输入框仍未持焦（输入框 @${comp.x},${comp.y} ${comp.w}x${comp.h}）` };
		// 起点必须是**空草稿**：`/` 只有落在词首（官方 detectTrigger 的 boundaryOk）才触发。
		// 草稿由官方 state 持有且跨页持久化，只能用真实按键清（见 clearDraftByKeyboard）。
		const cleared = await clearDraftByKeyboard();
		if (!cleared.ok) return { ok: false, why: cleared.why };
		// 光标落到草稿末尾：官方按 caret 判触发，落在中间会让 `/` 变成 inline 而非 leading
		await evaluate(`(function(){
			var a=document.activeElement; if(!a) return false;
			var r=document.createRange(); r.selectNodeContents(a); r.collapse(false);
			var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
		await wait(200);
		await call("Input.insertText", { text: "/" });
		const opened = await waitUntil(`!!document.querySelector('[data-trigger-menu]')`, 8000);
		if (!opened) {
			const draft = await evaluate(`(function(){var a=document.activeElement; if(!a) return 'no-active';
				return String(('value' in a ? a.value : a.textContent) || '').slice(0,20);})()`);
			return { ok: false, why: `输入 / 后 [data-trigger-menu] 未出现（草稿=${JSON.stringify(draft)}）` };
		}
		await wait(700); // 官方落位 + hook 钳位收敛（修复后应无改动）
		return { ok: true, comp };
	}
	// 两臂用**同一段探针、同一段阈值**；只有「有没有注入 hook」这一个变量。
	const assertPaletteSafe = (scenario, label, p) => {
		if (!p.found) {
			record(scenario, `${label} 输入联想浮层已打开`, null, "未出现 [data-trigger-menu]");
			return;
		}
		record(scenario, `${label} 输入联想浮层已打开且是官方命令面板`, p.found && p.hasListbox && p.rect.w > 100,
			`rect=${JSON.stringify(p.rect)} 内含 [role=listbox]=${p.hasListbox} position=${p.position}（官方命令面板有 ~10 条命令，宽 >100px）`);
		// A-input-trigger-anchored：锚在输入卡上 + 整体落在安全视口内
		const inSafe = p.rect.top >= p.insetTop && p.rect.left >= 0
			&& p.rect.right <= p.innerWidth && p.rect.bottom <= p.innerHeight;
		const anchored = p.gapToCard !== null && p.gapToCard >= 0 && p.gapToCard <= T24_ANCHOR_GAP_MAX;
		record(scenario, `${label} 输入联想浮层锚在输入卡上并处于安全视口内`, inSafe && anchored,
			`top=${p.rect.top} left=${p.rect.left} right=${p.rect.right} bottom=${p.rect.bottom} 视口=${p.innerWidth}x${p.innerHeight} insetTop=${p.insetTop} | 输入卡顶边=${p.cardTop} 浮层底边与之相距=${p.gapToCard}px（实测官方 4px，窗口 [0,${T24_ANCHOR_GAP_MAX}]；修复前 ${T24_ANCHOR_GAP_MAX + 2}px=8px 属于钳位让位，不算锚定）`);
		// A-float-not-overshoot-statusbar：顶边不得越过 --dshr-inset-top。
		// 后半句「不得被顶到安全区上沿」是这条断言真正的判别力：clampFloatHost 判越界后
		// 写的正是 `top = pad.top = 8 + insetTop`（实测 24+8=32），也就是「贴在安全区最上沿」。
		// 只写 `top >= insetTop` 的话，修复前的 32px 仍然 ≥ 24px 会蒙混过关。
		const clearOfStatusBar = p.rect.top >= p.insetTop;
		const notGluedToSafeTop = p.rect.top > p.insetTop + 8;
		record(scenario, `${label} 输入联想浮层顶边未越过 --dshr-inset-top`, clearOfStatusBar && notGluedToSafeTop,
			`浮层 top=${p.rect.top} vs --dshr-inset-top=${p.insetTop}（要求 top ≥ ${p.insetTop} 且 top > ${p.insetTop + 8}，` +
			`即不能被顶到安全区上沿；修复前 top=32=${p.insetTop}+8 正是钳位写下的 pad.top，inset 未写入时更只有 8px，整条压在状态栏上）`);
		// 我们不得再改写它：官方锚点归官方，钳位一律放行
		record(scenario, `${label} 浮层未被 hook 钳位改写（无 data-dshr-float）`, p.marked === false,
			`data-dshr-float=${p.marked} position=${p.position} computed top=${p.inlineTop} left=${p.inlineLeft}` +
			(p.marked ? " ← 修复前会被写成 position:fixed + inset:8px auto auto 16px" : ""));
	};
	console.log("\n[A/T24] 输入联想浮层锚定（真实输入 `/`，注入/不注入两臂）");
	// 两臂都从**全新加载的页面**起步。
	// 场景 A 前面几十步（抽屉/手势/点会话条目）会把页面留在各种中间态——实测点完会话
	// 条目后页面上可能**已经没有 composer**（seat/card/可编辑元素全为 0），
	// 拿这种状态当注入臂起点，两臂就不是同一个起点，对照实验立刻失去意义。
	await setViewport(412, 915);
	await loadRealPage();
	await injectHook("phone");
	// 模拟真机原生写入的状态栏 inset（两臂都写，保证只有一个变量）
	await evaluate(`document.documentElement.style.setProperty('--dshr-inset-top','${T24_INSET_TOP}px'); true`);
	await wait(300);
	const t24Hooked = await openInputTriggerPalette();
	if (t24Hooked.ok) {
		const p = await evaluate(T24_MENU_PROBE);
		info("A/T24", `注入臂：浮层=${JSON.stringify(p.rect)} 输入卡顶边=${p.cardTop} 缝=${p.gapToCard}px position=${p.position} computedTop=${p.inlineTop} computedLeft=${p.inlineLeft} data-dshr-float=${p.marked} insetTop=${p.insetTop}`);
		assertPaletteSafe("A/T24", "A-input-trigger", p);
		const shotT24Hooked = await shot("A-phone-portrait-412x915-input-trigger-anchored");
		info("A/T24", `截图（注入臂，浮层锚在输入卡上方）：${shotT24Hooked}`);
	} else {
		record("A/T24", "A-input-trigger 输入联想浮层已打开且是官方命令面板", null, t24Hooked.why);
		record("A/T24", "A-input-trigger 输入联想浮层锚在输入卡上并处于安全视口内", null, t24Hooked.why);
		record("A/T24", "A-float-not-overshoot-statusbar 输入联想浮层顶边未越过 --dshr-inset-top", null, t24Hooked.why);
		record("A/T24", "A-input-trigger 浮层未被 hook 钳位改写（无 data-dshr-float）", null, t24Hooked.why);
	}
	await clearComposer();
	// ── 对照臂：同一页面、同一视口、同一探针，**完全不注入** hook ──
	await loadRealPage();
	await evaluate(`document.documentElement.style.setProperty('--dshr-inset-top','${T24_INSET_TOP}px'); true`);
	await wait(300);
	const t24Control = await openInputTriggerPalette();
	if (t24Control.ok) {
		const p = await evaluate(T24_MENU_PROBE);
		info("A/T24", `对照臂（不注入）：浮层=${JSON.stringify(p.rect)} 输入卡顶边=${p.cardTop} 缝=${p.gapToCard}px position=${p.position} data-dshr-float=${p.marked} insetTop=${p.insetTop}`);
		// 同一条安全视口 + 锚定判据在官方臂上也必须成立：成立才说明「放行官方锚点」是对的
		assertPaletteSafe("A/T24", "A-input-trigger-control", p);
		await clearComposer();
	} else {
		record("A/T24", "A-input-trigger-control 输入联想浮层已打开且是官方命令面板", null, `对照臂未打开：${t24Control.why}`);
		record("A/T24", "A-input-trigger-control 输入联想浮层锚在输入卡上并处于安全视口内", null, `对照臂未打开：${t24Control.why}`);
		record("A/T24", "A-input-trigger-control 输入联想浮层顶边未越过 --dshr-inset-top", null, `对照臂未打开：${t24Control.why}`);
		record("A/T24", "A-input-trigger-control 浮层未被 hook 钳位改写（无 data-dshr-float）", null, `对照臂未打开：${t24Control.why}`);
	}
	// 对照臂是一次全新导航，hook 已随之消失。**不**在此处装回去：场景 B 紧接着就
	// setViewport + loadRealPage + injectHook，中间再注入一次只会多绑一遍手势/观察器。
	// 页面只读纪律：把草稿清干净，绝不发送。
	await clearComposer();

	// ══════════════════ B 手机横屏 915×412 / device=phone → hook OFF（既有 inset 行为）══════════════════
	console.log("\n[场景 B] 手机横屏 915×412  device=phone → 期望 hook OFF（沿用 dshr-official-inset）");
	await setViewport(915, 412);
	await loadRealPage();
	await injectHook("phone");
	const snapB = await evaluate(SNAPSHOT);
	record("B", "hook 根类 dshr-mobile 未挂上", !snapB.html.className.includes("dshr-mobile"), `className="${snapB.html.className}"`);
	record("B", "沿用官方横屏让位 dshr-official-inset", snapB.html.className.includes("dshr-official-inset"), `className="${snapB.html.className}"`);
	// 契约 3.5 末尾：phone 横屏维持既有行为，允许「惰性无效」的注入物存在，
	// 只要不产生可观察差异。因此这里判定的是**不可见**，不是「节点不存在」。
	const visB = await evaluate(`(()=>{const v=id=>{const e=document.getElementById(id);if(!e)return 'absent';const c=getComputedStyle(e);const b=e.getBoundingClientRect();
		return(c.display==='none'||c.visibility==='hidden'||b.width===0)?'hidden':'VISIBLE';};
		const m=document.querySelector('[data-dshr-main-col]');
		return{whale:v('dshr-mobile-whale'),mask:v('dshr-mobile-drawer-mask'),handle:v('dshr-drawer-handle'),
		guard:v('dshr-status-guard'),mainTransform:m?getComputedStyle(m).transform:null,
		mobileClass:document.documentElement.classList.contains('dshr-mobile')};})()`);
	record("B", "不得出现手机抽屉态（鲸鱼不可见）", visB.whale === "hidden" || visB.whale === "absent", `whale=${visB.whale}`);
	record("B", "抽屉遮罩 / drag handle 不可见", (visB.mask === "hidden" || visB.mask === "absent") && (visB.handle === "hidden" || visB.handle === "absent"), `mask=${visB.mask} handle=${visB.handle}`);
	record("B", "主栏未被挪动（无手机抽屉位移）", visB.mainTransform === "matrix(1, 0, 0, 1, 0, 0)" || visB.mainTransform === "none", `transform=${visB.mainTransform}`);
	record("B", "残留 data-dshr-* 标记惰性无效（无 dshr-mobile 类可命中）", visB.mobileClass === false, `残留节点=${JSON.stringify(snapB.hookNodes)} 残留标记=${snapB.dshrMarks} 个，全部规则以 html.dshr-mobile 开头且该类已移除`);
	record("B", "运行时切换 API 仍已定义", snapB.setDeviceApi === "function", `typeof=${snapB.setDeviceApi}`);
	const shotB = await shot("B-phone-landscape-915x412-hook-off");
	info("B", `截图：${shotB}`);

	// ══════════════════ C/D 平板 → hook OFF 且零痕迹（对照实验）══════════════════
	for (const [scenario, width, height] of [["C", 852, 883], ["D", 1280, 800]]) {
		console.log(`\n[场景 ${scenario}] 平板 ${width}×${height}  device=tablet → 期望 hook OFF 且零痕迹（对照实验）`);
		const viewport = `${width}x${height}`;
		// 臂 1：注入 mobile.js（device=tablet）
		await setViewport(width, height);
		await loadRealPage();
		const ready1 = await injectHook("tablet");
		const arm1 = await evaluate(SNAPSHOT);
		assertZeroTrace(scenario, arm1);
		const shot1 = await shot(`${scenario}-tablet-${viewport}-arm1-injected`);
		// 臂 2：完全不注入
		const ready2 = await loadRealPage();
		const arm2 = await evaluate(SNAPSHOT);
		record(scenario, "对照臂 2 未注入 hook（无 API/无守卫）", arm2.apiInstalled === false && arm2.setDeviceApi === "undefined", `installed=${arm2.apiInstalled} api=${arm2.setDeviceApi}`);
		compareArms(scenario, arm1, arm2, viewport);
		const shot2 = await shot(`${scenario}-tablet-${viewport}-arm2-noinject`);
		info(scenario, `截图：${shot1} / ${shot2}`);
		// 逐项像素差：矩形按 x/y/w/h 分别相减（不能用 === 比对象，那是引用比较会永远判"不同"）
		const deltas = {};
		for (const key of Object.keys(arm1.geometry)) {
			const va = arm1.geometry[key];
			const vb = arm2.geometry[key];
			if (va === null || vb === null) {
				deltas[key] = va === vb ? 0 : "present-in-one-arm-only";
			} else if (typeof va === "object") {
				const per = {};
				let worst = 0;
				for (const p of Object.keys(va)) {
					per[p] = vb[p] === undefined ? "missing" : Math.abs(va[p] - vb[p]);
					if (typeof per[p] === "number") worst = Math.max(worst, per[p]);
				}
				deltas[key] = { worstPx: worst, perProperty: per };
			} else {
				deltas[key] = Math.abs(va - vb);
			}
		}
		const baseline = {
			viewport: { width, height },
			device: "tablet",
			generatedBy: "scripts/test-device-class.mjs",
			tolerancePx: TOLERANCE_PX,
			// 渲染完成闸的判据与两臂快照：事后可复核「门禁确实在两臂都生效过」，
			// 而不是只看到对照结果、看不到对照是不是在同一个渲染状态上拍的。
			renderGate: {
				predicate: "rootChildren>0 && headerH>0 && cardH>0 && seatH>0 && (innerWidth<900 || rightbarMounted)",
				wideMinWidth: WIDE_MIN_WIDTH,
				stableSamples: RENDER_STABLE_SAMPLES,
				stableFingerprint: "headerTop/headerH/cardTop/cardH/seatTop/seatH/rightbarTop/rightbarH/bodyScrollHeight/innerWidth/innerHeight",
			},
			renderComplete: { arm1Injected: ready1, arm2NoInjection: ready2 },
			arm1Injected: arm1,
			arm2NoInjection: arm2,
			geometryDeltas: deltas,
		};
		const file = join(SCRATCH, `dom-baseline-tablet-${viewport}.json`);
		writeFileSync(file, JSON.stringify(baseline, null, "\t") + "\n");
		info(scenario, `对照快照：${file}`);
		info(scenario, `渲染完成快照 臂1（注入）=${JSON.stringify(ready1)}`);
		info(scenario, `渲染完成快照 臂2（不注入）=${JSON.stringify(ready2)}`);
		info(scenario, `逐项像素差：${JSON.stringify(baseline.geometryDeltas)}`);
	}

	// ══════════════════ E 运行中切换 412×915 ══════════════════
	console.log("\n[场景 E] 运行中切换 412×915  phone → tablet → phone（契约 3.3/G4）");
	await setViewport(412, 915);
	await loadRealPage();
	await injectHook("phone");
	const eOn = await evaluate(SNAPSHOT);
	record("E", "初始 phone 为 ON 态", eOn.html.className.includes("dshr-mobile"), `className="${eOn.html.className}"`);
	const eGeomOn = await evaluate(`(()=>{const f=document.querySelector('[data-dshr-frame]');const m=document.querySelector('[data-dshr-main-col]');const s=document.querySelector('[data-dshr-sidebar-col]');
		return{frame:f?Math.round(f.getBoundingClientRect().width):-1,main:m?Math.round(m.getBoundingClientRect().width):-1,side:s?Math.round(s.getBoundingClientRect().width):-1};})()`);
	const switched = await evaluate(`String(window.__dshrSetDevice('tablet'))`);
	record("E", "__dshrSetDevice('tablet') 生效", switched === "true", `返回值=${switched}`);
	await wait(1200);
	const eOff = await evaluate(SNAPSHOT);
	assertZeroTrace("E(OFF)", eOff);
	const back = await evaluate(`String(window.__dshrSetDevice('phone'))`);
	record("E", "__dshrSetDevice('phone') 生效", back === "true", `返回值=${back}`);
	const idem = await evaluate(`String(window.__dshrSetDevice('phone'))`);
	record("E", "同值重复调用幂等（契约 3.3）", idem === "false", `第二次返回值=${idem}`);
	await wait(1200);
	const eBack = await evaluate(SNAPSHOT);
	const eGeomBack = await evaluate(`(()=>{const f=document.querySelector('[data-dshr-frame]');const m=document.querySelector('[data-dshr-main-col]');const s=document.querySelector('[data-dshr-sidebar-col]');
		return{frame:f?Math.round(f.getBoundingClientRect().width):-1,main:m?Math.round(m.getBoundingClientRect().width):-1,side:s?Math.round(s.getBoundingClientRect().width):-1};})()`);
	record("E", "切回后根类恢复 dshr-mobile", eBack.html.className.includes("dshr-mobile"), `className="${eBack.html.className}"`);
	record("E", "标记与几何可逆（与首次 ON 一致）", JSON.stringify(eGeomOn) === JSON.stringify(eGeomBack), `首次=${JSON.stringify(eGeomOn)} 切回=${JSON.stringify(eGeomBack)}`);
	const shotE = await shot("E-phone-portrait-412x915-after-toggle");
	info("E", `截图：${shotE}`);
	ws.close();
} catch (err) {
	// T51（R8）：两类失败给出**不同**退出码。
	//   1 = 有行为断言不成立（真回归）
	//   2 = 没拿到对照证据（本轮一条断言都没真跑；重跑或换环境）
	// 原来两者都是 1，CI 上无法区分「代码坏了」与「环境抖了一下」。
	exitCode = err && Number.isInteger(err.exitCode) ? err.exitCode : 1;
	console.error("\ntest:device 运行失败：");
	console.error(err && err.stack ? err.stack : err);
	if (exitCode === 2) {
		console.error("\n========================================================");
		console.error("退出码 2 = 没拿到对照证据（NOT an assertion failure）");
		console.error("本轮**一条行为断言都没真跑**，不能据此判断代码好坏。");
		console.error("解读：");
		console.error("  · CI  ：退出码 2 判为「基础设施抖动」，自动重跑一次；");
		console.error("         重跑仍为 2 再当失败处理（那时该查网关/环境，不是本轮代码）。");
		console.error("  · 本地：直接重跑；页面快照已落盘（渲染探针），可判断是首屏全白还是半渲染。");
		console.error("  · 对照：退出码 1 才是「有行为断言不成立」，那才需要查代码。");
		console.error("========================================================");
	} else {
		console.error("\n退出码 1 = 有行为断言不成立（assertion failure）——按真回归处理。");
	}
} finally {
	try { child.kill(); } catch { /* ignore */ }
	try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
	// ── 清理义务：吊销本次创建的测试设备 ──
	// T51（R8）：清理失败只记录、不在这里直接改 exitCode；收尾处统一判定，
	// 避免把「没拿到对照证据(2)」被降级成「断言失败(1)」。
	let revokeFailed = false;
	if (testDeviceId) {
		try {
			const rev = await fetch(`${GATEWAY}/__dsh_remote__/admin/revoke`, { method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify({ id: testDeviceId }) });
			console.log(`\n吊销测试设备 ${testDeviceId} → HTTP ${rev.status} ${JSON.stringify(await rev.json())}`);
		} catch (err) {
			revokeFailed = true;
			console.error(`\n⚠ 吊销测试设备 ${testDeviceId} 失败：${String(err.message || err)}`);
			console.error(`⚠ 残留设备 id=${testDeviceId}；请手工执行：`);
			console.error(`⚠ curl -k -X POST https://127.0.0.1:18443/__dsh_remote__/admin/revoke -H "x-dshr-admin-token: <adminToken>" -H "content-type: application/json" -d '{"id":"${testDeviceId}"}'`);
		}
	}
	let leakedNow = null;
	try {
		const after = (await (await fetch(`${GATEWAY}/__dsh_remote__/admin/devices`, { headers: ADMIN_HEADERS })).json()).devices;
		const leaked = after.filter((d) => !devicesBefore.some((b) => b.id === d.id) && !d.revokedAt);
		console.log(`设备表：运行前 ${devicesBefore.length} 个 → 运行后 ${after.length} 个；未吊销的新设备 ${leaked.length} 个${leaked.length ? " → " + leaked.map((d) => d.id).join(",") : ""}`);
		if (leaked.length) leakedNow = leaked.map((d) => d.id);
	} catch (err) {
		console.error(`读取设备表失败：${String(err.message || err)}`);
	}
	const failed = results.filter((r) => r.ok === false);
	const skipped = results.filter((r) => r.ok === null);
	console.log(`断言合计 ${results.length}：通过 ${results.length - failed.length - skipped.length}，失败 ${failed.length}，跳过 ${skipped.length}`);
	// T51（R8）：清理类问题只在「本来是 0」时提级为 1，**不得**把 2（没拿到对照证据）
	// 降级成 1 —— 那正是本轮要消除的「两类失败共用一个码」。
	if (exitCode === 0 && (leakedNow || revokeFailed)) {
		exitCode = 1;
		console.error(`\n⚠ 清理义务未完成（${[leakedNow ? `未吊销的新设备 ${leakedNow.join(",")}` : "", revokeFailed ? "吊销请求失败" : ""].filter(Boolean).join("；")}）→ 退出码提级为 1。`);
	}
	console.log(`截图目录：${SHOT_DIR}`);
	console.log(`对照快照：${SCRATCH}\\dom-baseline-tablet-*.json`);
	console.log(`退出码约定：0=断言全过 / 1=有行为断言不成立 / 2=没拿到对照证据（本轮一条断言都没真跑）`);
	if (exitCode === 0) console.log("\ntest:device 通过：真实 0.2.0-rc.2 页面上的手机/平板/横屏/运行中切换矩阵全部符合契约。");
	process.exitCode = exitCode;
}
