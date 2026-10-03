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
import { spawn } from "node:child_process";
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
	 * 载入真实页面并等它**渲染完成**，返回渲染完成快照（对照 JSON 要用）。
	 * 「导航成功但应用没起来 / 停在半渲染」的真实页重试一次；仍拿不到就抛错中止。
	 */
	async function loadRealPage() {
		// 真实页偶尔会「导航成功但应用没起来」（bodyScrollHeight≈15、关键元素全 null），
		// 或停在 header 高 0 / 右栏未挂载的半渲染态。那种页面当对照臂会产出整屏 null
		// 的假差异，所以最多重试两次，仍不行就中止。
		for (let attempt = 1; attempt <= 2; attempt++) {
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
						throw new Error(`视口下发失败：期望 ${width}×${height}，页面实际 ${JSON.stringify(got)}`);
					}
				}
				await wait(2200); // React 首屏与官方过渡稳定
				const snap = await waitForRenderComplete();
				if (snap) return snap;
				info("load", `第 ${attempt} 次加载未达渲染完成（未满足：${unmetText()}），重试`);
				continue;
			}
			info("load", `第 ${attempt} 次加载连 #root 子节点都没有，重试`);
		}
		throw new Error(`真实页面两次加载都没达渲染完成状态（最后未满足：${unmetText()}）——中止，不产出对照证据`);
	}
	async function injectHook(device) {
		await evaluate(`window.__DSHR_MOBILE__ = Object.assign(window.__DSHR_MOBILE__ || {}, { device: '${device}' }); true`);
		await evaluate(HOOK_SOURCE);
		await wait(1200);
		// 注入也会引起官方侧重排/重挂，注入后必须重新过同一道闸（两臂同闸）。
		const snap = await waitForRenderComplete();
		if (!snap) {
			throw new Error(`注入 device=${device} 后未达渲染完成状态（未满足：${unmetText()}）——中止，不产出对照证据`);
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
	exitCode = 1;
	console.error("\ntest:device 运行失败：");
	console.error(err && err.stack ? err.stack : err);
} finally {
	try { child.kill(); } catch { /* ignore */ }
	try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
	// ── 清理义务：吊销本次创建的测试设备 ──
	if (testDeviceId) {
		try {
			const rev = await fetch(`${GATEWAY}/__dsh_remote__/admin/revoke`, { method: "POST", headers: ADMIN_HEADERS, body: JSON.stringify({ id: testDeviceId }) });
			console.log(`\n吊销测试设备 ${testDeviceId} → HTTP ${rev.status} ${JSON.stringify(await rev.json())}`);
		} catch (err) {
			console.error(`\n⚠ 吊销测试设备 ${testDeviceId} 失败：${String(err.message || err)}`);
			console.error(`⚠ 残留设备 id=${testDeviceId}；请手工执行：`);
			console.error(`⚠ curl -k -X POST https://127.0.0.1:18443/__dsh_remote__/admin/revoke -H "x-dshr-admin-token: <adminToken>" -H "content-type: application/json" -d '{"id":"${testDeviceId}"}'`);
			exitCode = 1;
		}
	}
	try {
		const after = (await (await fetch(`${GATEWAY}/__dsh_remote__/admin/devices`, { headers: ADMIN_HEADERS })).json()).devices;
		const leaked = after.filter((d) => !devicesBefore.some((b) => b.id === d.id) && !d.revokedAt);
		console.log(`设备表：运行前 ${devicesBefore.length} 个 → 运行后 ${after.length} 个；未吊销的新设备 ${leaked.length} 个${leaked.length ? " → " + leaked.map((d) => d.id).join(",") : ""}`);
		if (leaked.length) exitCode = 1;
	} catch (err) {
		console.error(`读取设备表失败：${String(err.message || err)}`);
	}
	const failed = results.filter((r) => r.ok === false);
	const skipped = results.filter((r) => r.ok === null);
	console.log(`\n断言合计 ${results.length}：通过 ${results.length - failed.length - skipped.length}，失败 ${failed.length}，跳过 ${skipped.length}`);
	console.log(`截图目录：${SHOT_DIR}`);
	console.log(`对照快照：${SCRATCH}\\dom-baseline-tablet-*.json`);
	if (exitCode === 0) console.log("\ntest:device 通过：真实 0.2.0-rc.2 页面上的手机/平板/横屏/运行中切换矩阵全部符合契约。");
	process.exitCode = exitCode;
}
