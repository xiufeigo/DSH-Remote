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

/**
 * 去掉 Java 源码里的注释（`//` 行注释与 `/* *\/` 块注释），**保留字符串/字符字面量内容**。
 *
 * 为什么需要：源码契约要在**代码**上判据，但说明性注释里经常要**引用**被禁掉的写法
 * （例如 R7 那条契约要禁 `url.contains(SW_SCRIPT_PATH)`，而修复说明里必须原样写出它）。
 * 不去注释就匹配 ⇒ 契约被自己的注释触发（我第一版就踩了，当场红）。
 *
 * 用状态机而不是正则：正则分不清 `"//"` 里的斜杠和注释，而 MainActivity 里满是
 * `"https://…"` 这类字面量，误删会把后面整行代码吃掉 ⇒ 制造假绿。
 */
function stripJavaComments(src) {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (c === "/" && c2 === "/") {
			while (i < n && src[i] !== "\n") i += 1;
			continue;
		}
		if (c === "/" && c2 === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
			i += 2; // 跳过 */
			// 保留换行，行号不变（后面的 indexOf("\n\t}") 之类切片才靠谱）
			out += "\n";
			continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			out += c;
			i += 1;
			while (i < n) {
				if (src[i] === "\\") {
					out += src[i] + (src[i + 1] || "");
					i += 2;
					continue;
				}
				out += src[i];
				if (src[i] === quote) {
					i += 1;
					break;
				}
				i += 1;
			}
			continue;
		}
		out += c;
		i += 1;
	}
	return out;
}

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
	if (!src.includes("translateX(var(--dshr-drawer-width))")) {
		throw new Error("源码契约：缺少主栏 translateX(var(--dshr-drawer-width)) 滑动展开");
	}
	if (!src.includes("data-dshr-tablet")) {
		throw new Error("源码契约：平板竖屏必须用 data-dshr-tablet 限制侧栏宽度");
	}
	if (!src.includes("function isPortraitViewport")) {
		throw new Error("源码契约：缺少 isPortraitViewport，横屏会误用 hook");
	}
	if (!src.includes("dshr-official-inset")) {
		throw new Error("源码契约：横屏官方界面必须 dshr-official-inset 让出状态栏");
	}
	if (!src.includes("html.dshr-official-inset [data-dshr-sidebar-col]")) {
		throw new Error("源码契约：横屏必须把侧栏背景延伸进状态栏，不得整页垫白顶");
	}
	if (!src.includes("dshr-status-guard")) {
		throw new Error("源码契约：缺少状态栏误触挡板 dshr-status-guard");
	}
	// 0.2.0-rc.2 设备分档：启用矩阵（契约 3.4）取代旧的
	// `portrait && (isAndroidShell() || mql.matches)` 单式。
	if (!src.includes("function resolveHookEnabled")) {
		throw new Error("源码契约：缺少 resolveHookEnabled 启用矩阵");
	}
	const matrix = src.match(/function resolveHookEnabled\(portrait\) \{[\s\S]{0,400}?\n\t\}/);
	if (!matrix) {
		throw new Error("源码契约：找不到 resolveHookEnabled 函数体");
	}
	if (!/deviceMode === 'tablet'\) return false/.test(matrix[0])) {
		throw new Error("源码契约：device='tablet' 必须任意朝向 OFF（平板走官方桌面布局）");
	}
	if (!/deviceMode === 'phone'\) return portrait/.test(matrix[0])) {
		throw new Error("源码契约：device='phone' 必须竖屏 ON、横屏 OFF");
	}
	if (!/if \(isAndroidShell\(\)\) return portrait/.test(matrix[0]) || !/return !!mql\.matches/.test(matrix[0])) {
		throw new Error("源码契约：device='auto' 必须等价于改动前行为（壳内只看竖屏，web 端只看宽度断点）");
	}
	// 契约 3.3：运行时切换 API 必须挂在脚本顶层且幂等。
	if (!/window\.__dshrSetDevice = function \(mode\)/.test(src)) {
		throw new Error("源码契约：缺少 window.__dshrSetDevice 运行时档位切换 API");
	}
	if (!src.includes("if (next === deviceMode) return false;")) {
		throw new Error("源码契约：__dshrSetDevice 必须幂等——同值重复调用零副作用");
	}
	// 契约 3.5：平板档 OFF 必须走零痕迹拆除路径。
	if (!src.includes("function teardownHookTraces") || !src.includes("if (!on && isStrictOff())")) {
		throw new Error("源码契约：device='tablet' 的 OFF 必须走 teardownHookTraces 零痕迹拆除");
	}
	if (!src.includes("grid-column: 2")) {
		throw new Error("源码契约：主栏必须 grid-column:2，否则 absolute 侧栏后会掉进 0px 列");
	}
	if (!src.includes("function findMainCol")) {
		throw new Error("源码契约：缺少 findMainCol");
	}
	// ── 深色启动（theme-follow）：标记缺失时按系统深浅铺底，不误判为浅色 ──
	if (!src.includes("if (!dark && !findFrame())")) {
		throw new Error("源码契约：DSH 主题标记缺失时必须回退系统深浅（syncPageTheme）");
	}
	if (!src.includes('[data-dshr-dark="1"]:not([data-dshr-ready="1"]) { background: #141414; }')) {
		throw new Error("源码契约：深色启动 splash 必须铺深色底，防止状态栏 inset 白条");
	}
	// ── 壳直连重试 ──
	{
		const main = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
		if (!main.includes('directTarget = url;') || !main.includes("if (!TextUtils.isEmpty(directTarget))")) {
			throw new Error("源码契约：直连重试必须回到原直连地址，不得误连 FRP 配置组");
		}
		// ── R7（T53）：SW 脚本请求必须按**路径精确匹配**，不得再用子串判定 ──
		// 原来是 `url.contains(SW_SCRIPT_PATH)`：任何路径里含有这段文字的请求都会被当成
		// SW 脚本供给（/plugins/x/__dsh_remote__/sw.js、/__dsh_remote__/sw.js.bak …），
		// 把别的响应体喂给 ServiceWorker 子系统，且日志写着"本地供给"极具误导性。
		//
		// ⚠ 判据必须在**去掉注释后**的代码上做：这段说明文字本身就含 `url.contains(...)`
		// 这个字面量，直接在原文上匹配 ⇒ 契约会被自己的注释触发（我第一版就踩了，当场红）。
		const mainCode = stripJavaComments(main);
		if (/url\s*\.\s*contains\(\s*SW_SCRIPT_PATH\s*\)/.test(mainCode)) {
			throw new Error("源码契约（R7）：不得用 url.contains(SW_SCRIPT_PATH) 判 SW 脚本——必须走 isSwScriptRequest() 的路径精确匹配");
		}
		if (!mainCode.includes("private static boolean isSwScriptRequest(String url)")) {
			throw new Error("源码契约（R7）：缺少 isSwScriptRequest()（SW 脚本请求的路径精确判定）");
		}
		// 判定本体必须真的比 **pathname**（Uri.parse(...).getPath()），不是整串 URL。
		const isSwAt = mainCode.indexOf("private static boolean isSwScriptRequest(String url)");
		const isSw = mainCode.slice(isSwAt, mainCode.indexOf("\n\t}", isSwAt));
		if (!isSw.includes("Uri.parse(url).getPath()")) {
			throw new Error("源码契约（R7）：isSwScriptRequest 必须用 Uri.parse(url).getPath() 取 pathname 比对");
		}
		if (!isSw.includes("SW_SCRIPT_PATH.equals(path)")) {
			throw new Error("源码契约（R7）：isSwScriptRequest 必须对 pathname 做 equals 精确匹配（query 不影响判定）");
		}
		// 调用点必须用它，不能绕回子串判定。
		if (!mainCode.includes("if (isSwScriptRequest(url)) {")) {
			throw new Error("源码契约（R7）：ServiceWorkerClient 的 SW 分支必须调用 isSwScriptRequest(url)");
		}
		// Java 的 catch 必须写两个标识符（类型 + 变量名）。我第一版照 JS 的习惯写了
		// `catch (ignoredParse)`，javac 报「需要<标识符>」——注释里得钉住，别再犯。
		if (/catch\s*\(\s*(?:Throwable|Exception|Error|RuntimeException)\s+/.test(isSw) === false && /catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(isSw)) {
			throw new Error("源码契约（R7）：catch 必须写「类型 + 变量名」两个标识符（`catch (ignoredParse)` 编译不过）");
		}
	}
	// ── 壳深色主题（values-night）──
	{
		const night = join(ROOT, "android/app/src/main/res/values-night/styles.xml");
		if (!existsSync(night)) throw new Error("源码契约：缺少 values-night 深色主题");
	}
	{
		const singleBytes = readFileSync(join(ROOT, "packages/gateway/assets/mobile-web.js"));
		const rawBytes = readFileSync(join(ROOT, "android/app/src/main/res/raw/mobile.js"));
		if (!singleBytes.equals(rawBytes)) {
			throw new Error("源码契约：WEB-02 单一源漂移——res/raw/mobile.js ≠ packages/gateway/assets/mobile-web.js（跑 android/build.ps1 的同步步骤，字节级复制）");
		}
	}
	// ── WEB-04：标准事件分发是首选通道，React 闭包仅作兜底 ──
	if (!src.includes("var dispatched = dispatchNativeClick(button);")) {
		throw new Error("源码契约：WEB-04 dispatchNativeClick 必须是 toggleSidebar 首选点击通道");
	}
	// ── T21 修复 1：hook 发起的侧栏开合前必须先让可编辑元素失焦 ──
	// 用户报告「打开左侧栏会弹虚拟键盘」。根因（scratch/t18/keyboard.md §3）：鲸鱼
	// touchend 里的 event.preventDefault() 连带取消了「点按 → 焦点离开可编辑元素」这条
	// 默认行为，composer 仍持焦；紧接着 dispatchNativeClick 在同一次触摸的用户激活窗口内
	// 派发合成 click，Chromium 遂抬键盘。官方 Collapse sidebar 不弹，正是因为它靠这条被
	// 吃掉的默认行为（真机 A/B：hook 鲸鱼 724/760ms 弹，官方不弹）。
	if (!src.includes("function blurEditableFocus")) {
		throw new Error("源码契约：缺少 blurEditableFocus（打开左侧栏弹虚拟键盘的根因修法）");
	}
	{
		// 判据必须复用 isEditableFocus，不得另写一份（两处漂移就会漏掉 contenteditable）。
		if (!/function blurEditableFocus\(\)[\s\S]{0,400}isEditableFocus\(/.test(src)) {
			throw new Error("源码契约：blurEditableFocus 必须复用 isEditableFocus 判据，不得另写一份");
		}
		// 取 toggleSidebar 的函数体：到下一个同缩进的 function 声明为止。
		const fnStart = src.indexOf("function toggleSidebar() {");
		if (fnStart < 0) throw new Error("源码契约：找不到 toggleSidebar");
		const fnEnd = src.indexOf("\n\tfunction ", fnStart);
		if (fnEnd < 0) throw new Error("源码契约：无法确定 toggleSidebar 函数体边界");
		const body = src.slice(fnStart, fnEnd);
		const blurAt = body.indexOf("blurEditableFocus();");
		if (blurAt < 0) {
			throw new Error("源码契约：toggleSidebar 入口必须调用 blurEditableFocus()（鲸鱼 preventDefault 吃掉了默认失焦 → 弹虚拟键盘）");
		}
		// 必须早于合成 click：落在仍持焦的输入框上的 click 照样会被 Chromium 抬起键盘。
		const clickAt = body.indexOf("dispatchNativeClick(button)");
		if (clickAt >= 0 && blurAt > clickAt) {
			throw new Error("源码契约：blurEditableFocus() 必须早于 dispatchNativeClick(button)，否则合成 click 落在仍持焦的输入框上");
		}
		// 又必须晚于连点护栏：护栏命中时这次调用根本不派发动作，不该顺手收走用户焦点。
		const busyAt = body.indexOf("if (toggleBusy) return true;");
		if (busyAt < 0) throw new Error("源码契约：找不到 toggleSidebar 的 toggleBusy 连点护栏");
		if (blurAt < busyAt) {
			throw new Error("源码契约：blurEditableFocus() 必须晚于 toggleBusy 护栏，否则被护栏 return 掉的空调用也会收走用户焦点");
		}
	}
	// ── T21 修复 2：焦点守卫——只有用户自己点输入框，输入框才允许持焦 ──
	if (!src.includes("function bindFocusGuard") || !src.includes("function revokeStealthFocus")) {
		throw new Error("源码契约：缺少焦点守卫 bindFocusGuard / revokeStealthFocus");
	}
	if (!src.includes("var USER_FOCUS_WINDOW_MS") || !src.includes("var userFocusWindowUntil")) {
		throw new Error("源码契约：缺少「用户主动聚焦」窗口（userFocusWindowUntil）");
	}
	// 三个落指事件都必须捕获阶段登记窗口：少一个就会出现「点了输入框反而被收回」。
	for (const EV of ["touchstart", "pointerdown", "mousedown"]) {
		if (!src.includes(`addEventListener('${EV}', onDown, { capture: true, passive: true });`)) {
			throw new Error(`源码契约：焦点守卫必须在 ${EV} 捕获阶段登记「用户主动聚焦」窗口`);
		}
	}
	{
		// focusin 捕获阶段：窗口内放行、窗口外收回。
		const at = src.indexOf("addEventListener('focusin', function (event) {");
		if (at < 0) throw new Error("源码契约：焦点守卫缺少 focusin 捕获阶段监听");
		const body = src.slice(at, src.indexOf("\n\tfunction ", at));
		if (!body.includes("isEditableFocus(el)")) {
			throw new Error("源码契约：focusin 守卫必须只对可编辑元素生效");
		}
		// T51（R1）：放行判据从「对整篇文档按时间窗放行」收窄成
		// 「只对这次意图的目标元素放行」（inUserFocusWindow）。
		// 旧写法 `if (Date.now() <= userFocusWindowUntil) return;` 就是 T50 §6.1
		// 那个 800ms 外溢反例的放行口，必须已经不在守卫里。
		if (body.includes("Date.now() <= userFocusWindowUntil")) {
			throw new Error("源码契约：focusin 守卫不得再对整篇文档按时间窗放行（T51/R1：那是布防窗口外溢的根因）");
		}
		if (!body.includes("if (inUserFocusWindow(el)) return;")) {
			throw new Error("源码契约：focusin 守卫必须放行「用户主动聚焦」窗口内、且属于该次意图目标元素的聚焦（否则用户点输入框会被收回）");
		}
		if (!body.includes("revokeStealthFocus(el)")) {
			throw new Error("源码契约：focusin 守卫必须在窗口外调用 revokeStealthFocus(el)");
		}
		// T51（R4）：残留兜底必须挂在 focusin 上（浏览器决定 showSoftInput 的那一刻）。
		if (!body.includes("sweepResidualInputMode()")) {
			throw new Error("源码契约：focusin 守卫必须触发 inputmode 残留兜底 sweepResidualInputMode()（T51/R4）");
		}
	}
	if (!src.includes("var FOCUS_REVOKE_MAX") || !/focusRevokeCount > FOCUS_REVOKE_MAX/.test(src)) {
		throw new Error("源码契约：焦点守卫必须有防打环上限（不得无限 blur）");
	}
	if (!src.includes("function focusGuardActive()") || !/!isStrictOff\(\) && !!hookOn/.test(src)) {
		throw new Error("源码契约：焦点守卫只能在 hook 生效档位动作（平板档严格 OFF / 手机横屏不得介入）");
	}
	// ── T51（R1/R2/R4）：布防窗口的生命周期 + 承重行契约 ──
	// 背景：T48 用来实现「键盘不弹」的唯一承重行是 armComposerFocus 里的
	// setAttribute('inputmode','none')。T50 §7.4 变异②证明：**删掉它，
	// pnpm test:mobile 与 pnpm test:device 双双全绿**（grep inputmode scripts/ 零命中）。
	// 下面这组断言就是补那个缺口——删承重行必须变红。
	{
		const bodyOf = (needle) => {
			const at = src.indexOf(needle);
			if (at < 0) throw new Error(`源码契约：找不到 ${needle}`);
			return src.slice(at, src.indexOf("\n\tfunction ", at));
		};
		const arm = bodyOf("function armComposerFocus()");
		// 承重三动作：登记意图窗口（且必须带目标元素）/ 打 inputmode=none / 自抢焦点。
		if (!/markUserFocusIntent\(\s*composer\s*\)/.test(arm)) {
			throw new Error("源码契约：armComposerFocus 必须 markUserFocusIntent(composer) —— 窗口必须绑定目标元素，不能对整篇文档放行（T51/R1）");
		}
		if (!/composer\.setAttribute\(\s*['\"]inputmode['\"]\s*,\s*['\"]none['\"]\s*\)/.test(arm)) {
			throw new Error("源码契约：armComposerFocus 承重行——必须 composer.setAttribute('inputmode','none')，否则官方抢焦点会把软键盘弹起来（T46 NEG-1 / T50 R2）");
		}
		if (!/composer\.focus\(\s*\)/.test(arm)) {
			throw new Error("源码契约：armComposerFocus 必须自己 composer.focus()（让官方那次抢焦点变成空操作）");
		}

		const disarm = bodyOf("function disarmComposerFocus()");
		// 摘防清理路径：属性 + 布防态 + **放行窗口**。
		if (!/removeAttribute\(\s*['\"]inputmode['\"]\s*\)/.test(disarm)) {
			throw new Error("源码契约：disarmComposerFocus 必须 removeAttribute('inputmode')，否则用户点输入框打不了字（T46 实测）");
		}
		if (!disarm.includes("clearUserFocusWindow()")) {
			throw new Error("源码契约：disarmComposerFocus 必须 clearUserFocusWindow() —— 否则布防的 800ms 放行窗口会外溢到面板的下一次交互（T50 §6.1 实测 5/6 命中）");
		}
		if (!disarm.includes("focusArmed = false")) {
			throw new Error("源码契约：disarmComposerFocus 必须复位 focusArmed");
		}

		// 下一次落指：先无条件关窗口，再按这次的意图重开。
		const onDownAt = src.indexOf("var onDown = function (event) {");
		if (onDownAt < 0) throw new Error("源码契约：找不到焦点守卫的 onDown");
		const onDown = src.slice(onDownAt, src.indexOf("addEventListener('touchstart'", onDownAt));
		if (!onDown.includes("clearUserFocusWindow()")) {
			throw new Error("源码契约：onDown 开头必须 clearUserFocusWindow()（下一次落指要收掉上一次窗口）");
		}
		if (!/markUserFocusIntent\(\s*intentEls\s*\)/.test(onDown)) {
			throw new Error("源码契约：onDown 必须 markUserFocusIntent(intentEls) —— 窗口只能对用户这次点的那个输入区放行（T51/R1）");
		}
		// 用户落指分支必须把「落点解析出的可编辑宿主」和「当前 composer」都记进去。
		// 漏掉 composer 的后果是实测过的：官方 Lexical 的真实持焦节点与落点 closest
		// 到的可编辑元素未必互为祖先/后代 ⇒ 开不出窗口 ⇒ 守卫把用户自己的聚焦也收回
		// ⇒ test:device 出现 4 条 SKIP「真实点按后输入框仍未持焦」。
		if (!onDown.includes("editableOwnerOf(target)")) {
			throw new Error("源码契约：onDown 必须用 editableOwnerOf(target) 解析落点宿主（官方 composer 是 Lexical，标准选择器会漏）");
		}
		if (!/intentEls\.push\(composerNow\)/.test(onDown)) {
			throw new Error("源码契约：onDown 的意图集合必须同时包含当前 composer（否则用户真点输入框会丢焦点）");
		}
		if (!onDown.includes("sweepResidualInputMode()")) {
			throw new Error("源码契约：onDown 必须触发 inputmode 残留兜底（浏览器默认聚焦前）");
		}

		// 窗口判据本身：必须同时要求「未过期」与「有目标元素集合」，且双向亲缘。
		const win = bodyOf("function inUserFocusWindow(el)");
		if (!win.includes("userFocusIntentEls")) {
			throw new Error("源码契约：inUserFocusWindow 必须读 userFocusIntentEls");
		}
		if (!win.includes("Date.now() > userFocusWindowUntil")) {
			throw new Error("源码契约：inUserFocusWindow 必须先判窗口是否过期");
		}
		if (!win.includes("inIntentScope(el,")) {
			throw new Error("源码契约：inUserFocusWindow 必须逐个意图元素做亲缘判定");
		}
		const scope = bodyOf("function inIntentScope(el, intentEl)");
		if (!scope.includes("contains(el)")) {
			throw new Error("源码契约：inIntentScope 必须做亲缘判定（目标元素的后代）");
		}
		if (!scope.includes("node === intentEl")) {
			throw new Error("源码契约：inIntentScope 必须做祖先链判定（官方把焦点放到 composer 的包裹层上）");
		}
		// 无目标元素时**不开**窗口：这是 R1 的根因判据。
		const mark = bodyOf("function markUserFocusIntent(target)");
		if (!/if\s*\(\s*!list\.length\s*\)\s*return false;/.test(mark)) {
			throw new Error("源码契约：markUserFocusIntent 必须对解析不出目标元素的调用返回 false（否则就是一个对整篇文档的放行窗口）");
		}
		if (!/userFocusIntentEls\s*=\s*list/.test(mark)) {
			throw new Error("源码契约：markUserFocusIntent 必须记录 userFocusIntentEls");
		}

		// R4 残留兜底：只在非布防态动手，且只清 'none'。
		const sweep = bodyOf("function sweepResidualInputMode()");
		if (!/if\s*\(focusArmed\)\s*return false;/.test(sweep)) {
			throw new Error("源码契约：sweepResidualInputMode 必须在布防态下直接返回，否则会撤掉自己刚布的防");
		}
		if (!/removeAttribute\(\s*['\"]inputmode['\"]\s*\)/.test(sweep)) {
			throw new Error("源码契约：sweepResidualInputMode 必须 removeAttribute('inputmode')");
		}
		if (!sweep.includes("!== 'none'")) {
			throw new Error("源码契约：sweepResidualInputMode 只能清 inputmode=none，别动官方自己写的其它值");
		}
		if (!/attributeFilter:\s*\[\s*['\"]inputmode['\"]\s*\]/.test(src)) {
			throw new Error("源码契约：必须挂 MutationObserver 盯 composer 的 inputmode 属性变化（第三方/摘除失败都要能兜住）");
		}

		// ── 可见性/导航也是窗口生命周期的一部分 ──
		// T53（M5 假牙修复）：原来这两条是**全文件子串**判据 ——
		//   `src.includes("addEventListener('pageshow'")` 被 mobile-web.js 里那个
		//   「恢复自愈」（bfcache 探针）的 pageshow 监听**同样满足**，
		//   而 `onVisibility` 那条正则只要求体内出现 `clearUserFocusWindow()`、
		//   **不要求** `sweepResidualInputMode()`。
		//   ⇒ T52 §8.2 实测：把守卫的 pageshow 处理器整个删掉 / 把 onVisibility 回前台的
		//   sweep 分支删掉，全量套件都 EXIT=0、行为断言 EXIT=0、0 条失败（两处假牙）。
		// 现在改成：在 **bindFocusGuard 函数体内**定位处理器本体，并逐个要求其动作。
		const guardAt = src.indexOf("function bindFocusGuard() {");
		if (guardAt < 0) throw new Error("源码契约：找不到 bindFocusGuard");
		// bindFocusGuard 的收尾大括号是唯一一个「顶格一个 tab」的 `\n\t}\n`
		// （内层块都是两个 tab 起，匹配不到）⇒ 精确切出函数体。
		const guardEnd = src.indexOf("\n\t}\n", guardAt);
		if (guardEnd < 0) throw new Error("源码契约：bindFocusGuard 函数体未闭合");
		const guardBody = src.slice(guardAt, guardEnd);
		if (!guardBody.includes("addEventListener('visibilitychange', onVisibility")) {
			throw new Error("源码契约：焦点守卫必须监听 visibilitychange 并收掉放行窗口");
		}
		const pageshowAt = guardBody.indexOf("window.addEventListener('pageshow'");
		if (pageshowAt < 0) {
			throw new Error(
				"源码契约：焦点守卫（bindFocusGuard 内）必须监听 pageshow 并收掉放行窗口 —— 原来的全文件子串判据被「恢复自愈」监听满足，是个假牙（T52 §8.2 M5：删掉守卫的 pageshow 处理器全量套件仍 EXIT=0）",
			);
		}
		const pageshowHandler = guardBody.slice(pageshowAt, guardBody.indexOf("});", pageshowAt));
		if (!pageshowHandler.includes("clearUserFocusWindow()")) {
			throw new Error("源码契约：pageshow 处理器必须 clearUserFocusWindow()（导航回来时上一次意图的放行窗口不该继续有效）");
		}
		if (!pageshowHandler.includes("sweepResidualInputMode()")) {
			throw new Error("源码契约：pageshow 处理器必须 sweepResidualInputMode()（回到前台看到残留 inputmode=none 要清掉）");
		}
		const onVisAt = guardBody.indexOf("var onVisibility = function");
		if (onVisAt < 0) {
			throw new Error("源码契约：焦点守卫（bindFocusGuard 内）必须有 onVisibility 处理器");
		}
		const onVis = guardBody.slice(onVisAt, guardBody.indexOf("};", onVisAt));
		if (!onVis.includes("clearUserFocusWindow()")) {
			throw new Error("源码契约：onVisibility（切到后台）必须 clearUserFocusWindow()");
		}
		// T53（M6）：原来**没有**这条要求 ⇒ 删掉回前台的残留兜底没人管。
		if (!onVis.includes("sweepResidualInputMode()")) {
			throw new Error(
				"源码契约：onVisibility 切回前台的分支必须 sweepResidualInputMode() —— 原来只要求 clearUserFocusWindow()，删掉 else 分支的残留兜底全量套件仍 EXIT=0（T52 §8.2 M6）",
			);
		}
		if (!/visibilityState\s*===\s*['"]hidden['"]/.test(onVis)) {
			throw new Error("源码契约：onVisibility 必须按 document.visibilityState 分「切后台 / 回前台」两路");
		}
	}
	// ── T21 修复 3：把「效果」上报给原生（T16 缺陷 #3 的配套）──
	if (!src.includes("window.DshRemoteApp.setUiDiag(")) {
		throw new Error("源码契约：缺少 DshRemoteApp.setUiDiag 上报（原生看不见「装了但没生效」）");
	}
	if (!src.includes("typeof window.DshRemoteApp.setUiDiag !== 'function'")) {
		throw new Error("源码契约：setUiDiag 必须 typeof 判空后静默跳过（该桥由原生另一任务实现，缺失不得抛错）");
	}
	if (!src.includes("window.__dshrMobileDiag")) {
		throw new Error("源码契约：缺少 window.__dshrMobileDiag（测试与排查需直读同一份数据）");
	}
	{
		const at = src.indexOf("function collectUiDiag() {");
		if (at < 0) throw new Error("源码契约：找不到 collectUiDiag");
		const body = src.slice(at, src.indexOf("\n\tfunction ", at));
		for (const FIELD of ["device", "on", "rootClass", "ready", "whale", "frame", "strictOff", "ts"]) {
			if (!new RegExp(`\\b${FIELD}:`).test(body)) {
				throw new Error(`源码契约：UI 诊断缺字段 ${FIELD}（device/on/rootClass/ready/whale/frame/strictOff/ts）`);
			}
		}
	}
	// 诊断必须在 boot 收敛与 syncDom 收敛后各报一次，且严格 OFF 档也要报。
	if (!/if \(isStrictOff\(\)\) \{\s*\n\s*reportUiDiag\(\);/.test(src)) {
		throw new Error("源码契约：严格 OFF（平板档）也必须上报 UI 诊断（那时 on=false）");
	}
	if (!/function boot\(\)[\s\S]{0,700}reportUiDiag\(\);/.test(src)) {
		throw new Error("源码契约：boot 收敛后必须上报 UI 诊断");
	}
	if (!/function syncDom\(\)[\s\S]{0,9000}reportUiDiag\(\);\n\t\}/.test(src)) {
		throw new Error("源码契约：syncDom 收敛后必须上报 UI 诊断");
	}
	// T27-D：判重必须排除 ts。载荷带 Date.now()，拿整份 payload 判重永不相等，
	// 去抖会静默退化成「每轮 syncDom 都过桥」（死代码）。
	if (!/function uiDiagDedupeKey\(diag\)/.test(src)
		|| !/k === 'ts' \? undefined : v/.test(src)) {
		throw new Error("源码契约：UI 诊断去抖键必须排除 ts（否则去抖是死代码）");
	}
	if (!/if \(key === lastUiDiagKey\) return false;/.test(src)) {
		throw new Error("源码契约：reportUiDiag 必须用去抖键（不含 ts）判重");
	}
	// 桥是后到的：缺桥时**不得**记判重键，否则桥到位后永远补不上报。
	{
		const at = src.indexOf("function reportUiDiag() {");
		if (at < 0) throw new Error("源码契约：找不到 reportUiDiag");
		const body = src.slice(at, src.indexOf("\n\tfunction ", at));
		const missing = body.slice(body.indexOf("typeof window.DshRemoteApp.setUiDiag"), body.indexOf("} catch (ignoredDiagProbe)"));
		if (!/uiDiagBridgeMissing = true;/.test(missing) || /lastUiDiagKey = key;/.test(missing)) {
			throw new Error("源码契约：JS 桥缺失时不得记判重键（桥后到要能补发一次）");
		}
	}
	// ── WEB-05：抽屉接管接入横向滚动容器豁免 ──
	if (!src.includes("if (isInHorizontallyScrollableContainer(target)) return false;")) {
		throw new Error("源码契约：WEB-05 canStartDrawerTrack 必须接入横向可滚容器豁免");
	}
	// ── WEB-08：手势方向门，且必须早于 setDrawerVisual 接管 ──
	// 用户报告：手机主页面「从右往左滑」会点亮左侧抽屉而不是走官方右栏。
	// 根因是 onDragMove 越过 10px 阈值就 dragging=true + setDrawerVisual(baseX)，
	// 而 setDrawerVisual 首次调用无条件 setSidebarOpen(true) 才夹 x，左滑的负位移被夹成 0。
	{
		const GATE = "if (baseX <= 0 && dx < 0) {";
		if (!src.includes(GATE)) {
			throw new Error("源码契约：WEB-08 缺手势方向门（抽屉关闭时左滑必须放弃接管）");
		}
		// 取 onDragMove 的函数体：到下一个同缩进的 function 声明为止（不做花括号计数，
		// 免得被函数体里的对象/数组字面量带偏），并**剔掉 // 注释行**——
		// 方向门自己的注释里就出现过 "setDrawerVisual(baseX)" 这几个字，
		// 按原文取下标会指向注释而不是真正的接管点，判定会假绿/假红。
		const fnStart = src.indexOf("function onDragMove(clientX, clientY, event) {");
		if (fnStart < 0) throw new Error("源码契约：找不到 onDragMove 函数");
		const fnEnd = src.indexOf("\n\t\tfunction ", fnStart);
		if (fnEnd < 0) throw new Error("源码契约：无法确定 onDragMove 函数体边界");
		const body = src
			.slice(fnStart, fnEnd)
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		const gateAt = body.indexOf(GATE);
		if (gateAt < 0) throw new Error("源码契约：WEB-08 方向门不在 onDragMove 函数体内");
		const dragStart = body.indexOf("dragging = true;");
		const takeOver = body.indexOf("setDrawerVisual(baseX);");
		const pd = body.indexOf("event.preventDefault()");
		if (dragStart < 0 || takeOver < 0) {
			throw new Error("源码契约：WEB-08 校验失败——onDragMove 里找不到 dragging = true; / setDrawerVisual(baseX); 接管点");
		}
		// 方向门必须在 dragging=true / setDrawerVisual(baseX) **之前**：
		// 挪到 setDrawerVisual 之后就已经晚了——那时 setSidebarOpen(true) 早已执行，
		// 左侧栏被点亮且末尾的 preventDefault() 已把官方手势吃掉。
		if (gateAt > dragStart) {
			throw new Error("源码契约：WEB-08 方向门必须早于 dragging = true（否则已进入跟手路径）");
		}
		if (gateAt > takeOver) {
			throw new Error("源码契约：WEB-08 方向门必须早于 setDrawerVisual(baseX)（setSidebarOpen(true) 已执行就来不及了）");
		}
		// 方向门要早于 preventDefault，否则事件仍被吃掉（等于没还手给官方）。
		if (pd < 0 || gateAt > pd) {
			throw new Error("源码契约：WEB-08 方向门必须早于 event.preventDefault()（左滑要把事件还给官方/浏览器）");
		}
		// 方向门必须真的放弃接管：走 resetTrack() 并 return，不能继续跟手。
		if (!/resetTrack\(\);\s*\n\s*return;/.test(body.slice(gateAt, gateAt + 200))) {
			throw new Error("源码契约：WEB-08 方向门必须 resetTrack() 后立即 return（放弃接管）");
		}
	}
	// ── WEB-07：hook 幂等——脚本自带重复执行护栏，注入端按标记幂等 ──
	if (!src.includes("window.__dshRemoteMobileInstalled")) {
		throw new Error("源码契约：WEB-07 缺重复执行护栏 __dshRemoteMobileInstalled（壳内+edge 双注入会叠 hook）");
	}
	{
		const pwaSrc = readFileSync(join(ROOT, "packages/gateway/src/pwa.ts"), "utf8");
		if (!pwaSrc.includes("!text.includes(SW_PATH)") || !pwaSrc.includes('!text.includes("/__dsh_remote__/mobile.js")')) {
			throw new Error("源码契约：WEB-07 主屏/移动注入必须按标记各自幂等（上游已注入或重注入场景不得二次插标签）");
		}
		// 官方宿主自带 manifest（0.1.0-rc.8 → 0.1.5-rc.1 每版都有）：网关不得再提供自有 manifest
		if (!pwaSrc.includes("export function homeScreenHeadTags") || pwaSrc.includes("renderManifest") || pwaSrc.includes("MANIFEST_PATH")) {
			throw new Error("源码契约：manifest 已交给官方宿主，网关只补主屏标记（homeScreenHeadTags）");
		}
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
	// ── 浮层缺陷回归（上下文环浮层被裁 / 更多菜单被搬到屏幕底部）──
	{
		const block = src.match(/\[data-dshr-composer-trailing\] \{[\s\S]{0,500}?'\}/);
		if (!block) {
			throw new Error("源码契约：找不到 [data-dshr-composer-trailing] 规则块");
		}
		// 注释里会出现 "overflow:hidden" 这类字样，先剔掉注释行再看真实声明
		const rule = block[0].split("\n").filter((line) => !line.includes("//")).join("\n");
		if (/overflow:\s*hidden/.test(rule)) {
			throw new Error("源码契约：trailing 集群不得 overflow:hidden——上下文环浮层是它的后代，被裁掉就是「点环没反应」");
		}
		if (!/overflow:\s*visible/.test(rule)) {
			throw new Error("源码契约：trailing 必须显式 overflow:visible（防后续改动又把它裁掉）");
		}
	}
	if (!src.includes("function fixedContainingBlock")) {
		throw new Error("源码契约：缺少 fixedContainingBlock——position:fixed 浮层在带 transform 的会话列里必须换算到包含块坐标系");
	}
	if (!src.includes("Math.round(left - hostLeft)") || !src.includes("Math.round(top - hostTop)")) {
		throw new Error("源码契约：夹浮层必须减去 fixed 包含块原点，否则坐标会被浏览器再加一次祖先偏移");
	}
	if (!src.includes("function setFloatStyle") || !src.includes("if (changed) mark(el, 'data-dshr-float')")) {
		throw new Error("源码契约：夹浮层必须靠 setFloatStyle 的「值未变不写」判定收敛");
	}
	if (!src.includes("result.changed && result.count > 0 && floatPasses < 4")) {
		throw new Error("源码契约：scheduleClampFloats 必须按「确有改动」收敛——每帧重排会让浮层逐帧下漂并白烧 CPU");
	}
	if (!src.includes("return { count: hosts.length, changed: changed }")) {
		throw new Error("源码契约：clampFloatingMenus 必须返回 { count, changed }");
	}
	// ── T24：输入联想浮层（`/`、`@`）必须留在官方锚点上，不得被钳位顶到屏幕顶端 ──
	//
	// 真机复现（scratch/t24/report.md）：官方把命令面板锚在输入卡上沿、留 4px 缝
	// （实测浮层底边 461 / 输入卡顶边 465），而 clampFloatHost 的安全区把输入卡顶边
	// **再减 8px** 当硬下界 → 一条 377px 高的面板每次都被判越界 → 被改写成
	// position:fixed; inset:8px auto auto 16px，浮层从「贴着输入框」跳到安全区顶端
	// （top 84 → 32，高 377 → 425）。原生还没写 --dshr-inset-top 时 pad.top=8，
	// 浮层顶边就是 8px，直接压进状态栏——即用户报的「从屏幕最顶端、溢出状态栏弹出」。
	if (!src.includes("function isInputTriggerPalette")) {
		throw new Error("源码契约：缺少 isInputTriggerPalette——输入联想浮层必须与普通浮层分开判");
	}
	{
		// 判据必须是官方**结构属性**，不得依赖 CSS Module 哈希类名（Z9Jnlq_menu / _surface_ri079_1 随发版会变）
		const pred = src.match(/function isInputTriggerPalette\(node\) \{[\s\S]{0,400}?\n\t\}/);
		if (!pred) throw new Error("源码契约：找不到 isInputTriggerPalette 函数体");
		if (!/hasAttribute\('data-trigger-menu'\)/.test(pred[0])) {
			throw new Error("源码契约：isInputTriggerPalette 必须认官方结构属性 data-trigger-menu");
		}
		if (!/closest\('\[data-trigger-menu\]'\)/.test(pred[0])) {
			throw new Error("源码契约：isInputTriggerPalette 必须覆盖 data-trigger-menu 内部节点（role=listbox 视口、材质层）");
		}
		if (/Z9Jnlq|_surface_ri079|_material_ri079|className\s*===|classList\.contains/.test(pred[0])) {
			throw new Error("源码契约：isInputTriggerPalette 不得依赖 CSS Module 哈希类名（官方发版会变）");
		}
	}
	{
		// 两道闸都要在：根节点收集处不收它 + 真正改写前再拦一次（防将来新增调用路径绕过）
		const roots = src.match(/function looksLikeMenuRoot\(node\) \{[\s\S]{0,1200}?\n\t\}/);
		if (!roots || !/if \(isInputTriggerPalette\(node\)\) return false;/.test(roots[0])) {
			throw new Error("源码契约：looksLikeMenuRoot 必须放行输入联想浮层（内层 [role=listbox] 会命中菜单根判据）");
		}
		const clamp = src.match(/function clampFloatHost\(el\) \{[\s\S]{0,600}?\n\t\tvar pad = viewportPad\(\);/);
		if (!clamp || !/if \(isInputTriggerPalette\(el\)\) return false;/.test(clamp[0])) {
			throw new Error("源码契约：clampFloatHost 改写样式前必须再拦一次输入联想浮层");
		}
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
	if (!java.includes("setTranslationY(-shift)")) {
		throw new Error("源码契约：键盘必须用 translationY 抬起，不得改 WebView 高度");
	}
	if (!java.includes("computeImeShift") || !java.includes("imeFocusRect")) {
		throw new Error("源码契约：键盘平移必须按焦点输入框位置计算，不得整页抬满 IME 高度");
	}
	if (java.includes("rootLayout.setPadding(0, 0, 0, imePx)")) {
		throw new Error("源码契约：不得再用 padding 缩小 WebView（会重排字体）");
	}
	if (!java.includes("SOFT_INPUT_ADJUST_NOTHING")) {
		throw new Error("源码契约：API 30+ 必须 adjustNothing，避免系统改窗口高度");
	}
	if (!java.includes("setStatusBarContrastEnforced(false)") || !java.includes("setNavigationBarContrastEnforced(false)")) {
		throw new Error("源码契约：必须关掉系统栏对比度遮罩，否则小米等机会把状态栏涂成实色白");
	}
	if (!java.includes("dispatchConfigurationChanged")) {
		throw new Error("源码契约：系统切换深浅时必须把 uiMode 派发给 WebView");
	}
	if (!java.includes("FORCE_DARK_OFF") && !java.includes("setAlgorithmicDarkeningAllowed(false)")) {
		throw new Error("源码契约：禁止 WebView 算法反色，交给 DSH 自己的主题");
	}
	if (!java.includes("void setPageDark")) {
		throw new Error("源码契约：缺少 DshRemoteApp.setPageDark");
	}
	if (!java.includes("void setSessionNotice")) {
		throw new Error("源码契约：缺少 DshRemoteApp.setSessionNotice");
	}
	if (!src.includes('[data-dshr-dialog="1"] [data-dshr-main-col]')) {
		throw new Error("源码契约：打开设置时必须压低主会话栏，避免盖住设置");
	}
	if (!src.includes("data-dshr-explorer-details")) {
		throw new Error("源码契约：缺少与 dsh-explorer overlay 的握手 data-dshr-explorer-details");
	}
	if (!src.includes("var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff))")) {
		throw new Error("源码契约：会话/设置表面必须优先 --dsw-alias-bg-base，避免深色页白底浅字");
	}
	if (src.includes("background: var(--dsw-specific-background, #ffffff)")) {
		throw new Error("源码契约：不得把可能不存在的 --dsw-specific-background 直接回落到 #ffffff");
	}
	if (!src.includes("data-ds-dark-theme")) {
		throw new Error("源码契约：必须同步官方 body[data-ds-dark-theme]");
	}
	if (!src.includes("setPageDark")) {
		throw new Error("源码契约：必须把页面深浅告诉原生状态栏 DshRemoteApp.setPageDark");
	}
	if (!src.includes('[data-dshr-dark="1"]')) {
		throw new Error("源码契约：深色页必须设 color-scheme: dark");
	}
	if (!src.includes("data-dshx-overlay")) {
		throw new Error("源码契约：必须侦听 Explorer 的 data-dshx-overlay");
	}
	if (!src.includes(":not([data-dshx-details-col])")) {
		throw new Error("源码契约：隐藏 details 不得误伤 Explorer 的 details 列");
	}
	// ── 手机端四个版面缺陷的回归契约（底部导航栏 / 键盘 / 右侧栏 / 会话头部）──
	if (!/\[data-dshr-main-col\][^']*'[\s\S]{0,240}?padding-bottom: var\(--dshr-inset-bottom/.test(src)) {
		throw new Error("源码契约：会话列必须让出 --dshr-inset-bottom，否则底部导航栏遮住输入底栏与统计");
	}
	if (!src.includes("padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;")) {
		throw new Error("源码契约：缺少底部导航栏让位（--dshr-inset-bottom）");
	}
	if (!src.includes("[data-sidebar-right-panel]") || !src.includes("html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen=\"1\"] #dshr-mobile-whale")) {
		throw new Error("源码契约：官方右侧栏全屏态必须垫出系统栏 inset（[data-sidebar-right-panel]）并收起悬浮控件");
	}
	if (!src.includes("rightPanel.getAttribute('aria-hidden') !== 'true'")) {
		throw new Error("源码契约：返回键必须以 aria-hidden 判定右侧栏展开态，收起后不得再拦截（否则退不到后台）");
	}
	if (!src.includes("button[data-sidebar-right-toggle]")) {
		throw new Error("源码契约：返回键必须走官方 [data-sidebar-right-toggle] 收起右侧栏，不得误点退出全屏");
	}
	if (!src.includes("function imeLiftRect") || !src.includes("el.closest('[data-composer-seat]') || el.closest('[data-composer-card]') || el")) {
		throw new Error("源码契约：键盘抬起必须按整块输入区（[data-composer-seat]）算，只报焦点文本框会让底栏被键盘盖住");
	}
	if (!src.includes("window.DshRemoteApp.imeFocusRect(rect.top, rect.bottom);")) {
		throw new Error("源码契约：imeFocusRect 必须上报 imeLiftRect 的结果");
	}
	if (!src.includes("[data-dshr-agent-team]") || !src.includes("function markTeamAction")) {
		throw new Error("源码契约：缺少 Agent Team 动作标记（挪到页签行右侧）");
	}
	if (!src.includes("[data-dshr-tabs]") || !src.includes("function markSessionTabs")) {
		throw new Error("源码契约：页签行必须按 [role=tablist] 标记 data-dshr-tabs（header 里的 nav 是面包屑标题，不能当页签行）");
	}
	if (src.includes("' [data-dshr-session-header] nav {'")) {
		throw new Error("源码契约：页签行样式不得打在 header nav（0.1.5 那里是会话面包屑标题）上");
	}
	if (!src.includes("content: attr(data-dshr-job-n)") || !src.includes("function markJobIndicator")) {
		throw new Error("源码契约：后台任务触发器必须只留状态点 + 数量（data-dshr-job-n 由 ::after 渲染）");
	}
	if (!src.includes("[data-dshr-job-count-text]") || !src.includes("[data-dshr-job-chevron]")) {
		throw new Error("源码契约：后台任务触发器必须隐藏原句文本与下拉箭头");
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
		throw new Error("源码契约：Android 壳必须用 UA 识别，竖屏不得只看 1024px");
	}
	if (!src.includes("syncViewport")) {
		throw new Error("源码契约：缺少 syncViewport，旋转横竖屏后无法切换 hook");
	}
	if (!src.includes("imeFocusRect") || !src.includes("reportImeFocusToNative")) {
		throw new Error("源码契约：缺少把焦点输入框位置告诉原生的 imeFocusRect");
	}
	if (!src.includes("setSessionNotice") || !src.includes("function isAgentRunning") || !src.includes("readSessionNotice")) {
		throw new Error("源码契约：前台通知必须探测正在运行的会话并交给 setSessionNotice");
	}
	const tunnel = readFileSync(
		join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/TunnelService.java"),
		"utf8",
	);
	if (tunnel.includes("本机") && tunnel.includes("端口直通")) {
		throw new Error("源码契约：前台通知不得再写本机端口直通文案");
	}
	if (!tunnel.includes("CHANNEL_KEEP") || !tunnel.includes("IMPORTANCE_MIN")) {
		throw new Error("源码契约：没有正在运行的会话时必须走静默保活渠道");
	}
	if (!tunnel.includes("CHANNEL_SESSION")) {
		throw new Error("源码契约：正在运行的会话必须走会话进度渠道");
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
	// T51（R2）：headless 下文档默认**没有焦点**，此时 element.focus() 只会改
	// document.activeElement、**不派发 focusin** ⇒ 焦点守卫的监听根本不跑。
	// 打开焦点模拟，行为级断言才测得到真东西。
	try {
		await call("Emulation.setFocusEmulationEnabled", { enabled: true });
	} catch (focusEmuErr) {
		// 老版本 Chrome 没有这个域：让下面的断言自己红，而不是静默跳过。
	}
	const androidReport = await collectSelftest(call);

	// ── T51（R2）：焦点守卫的**行为级**断言（真实页面 + 真实 hook + 真实 focusin）──
	// 必须跑在 390 手机竖屏档：hook 生效（横屏/平板档 hook 严格 OFF，守卫是惰性的，
	// 在那里测等于没测）。
	// 承重行（armComposerFocus 的 setAttribute('inputmode','none')）此前**零覆盖**：
	// T50 §7.4 变异②删掉它，test:mobile 与 test:device 双双全绿。
	// 下面 4 条断言全部是「可观测差异」而不是源码字符串：
	//   f1 布防后 composer 真的挂着 inputmode=none   ← 删承重行 ⇒ 红
	//   f2 布防窗口内，面板搜索框抢焦点被收回           ← 窗口外溢 ⇒ 红（T50 §6.1）
	//   f3 用户真点输入框仍能拿到焦点                   ← 防「修过头把面板/键盘弄没」
	//   f4 非布防态的 inputmode 残留被兜底清掉          ← R4
	//   f5 布防 500ms 定时器把放行窗口一起关掉            ← 窗口生命周期（T50 §6.3 根因）
	async function focusGuardProbe() {
		const evaluated = await call("Runtime.evaluate", {
			expression: `(async function () {
				function mk(tag, attrs, parent) {
					var el = document.createElement(tag);
					for (var k in attrs) el.setAttribute(k, attrs[k]);
					(parent || document.body).appendChild(el);
					return el;
				}
				function down(el) {
					el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
				}
				var out = {};
				var fin = 0;
				document.addEventListener('focusin', function () { fin += 1; }, true);
				// 造一棵最小的「composer 卡片 + 输入区 + 工具条触发器」。
				// 结构必须照抄真页面：触发器在工具条上，与输入区是**兄弟**。
				// （若把触发器塞进 contenteditable 输入区里，isEditablePoint() 会判它
				//  为可编辑落点，就走不到布防分支——那样测的就不是 arm 了。）
				var host = mk('div', { 'data-composer-card': 'true', id: 't51-card' });
				var composer = mk('div', { 'data-composer-input': 'true', 'contenteditable': 'true' }, host);
				composer.textContent = 'dshr';
				var row = mk('div', { 'data-dshr-composer-row': 'true' }, host);
				var trigger = mk('button', { 'data-dshr-composer-model': 'true', 'aria-haspopup': 'menu' }, row);
				trigger.textContent = 'M';
				// 「模型」子面板那类**自带输入框**的弹层：与 composer 无亲缘关系。
				var panel = mk('div', { role: 'listbox', id: 't51-panel' });
				var panelInput = mk('input', { type: 'text', id: 't51-panel-search' }, panel);
				// 中性落点：既不可编辑、也不是触发器 ⇒ 只用来收窗口，不布防。
				var neutral = mk('div', { id: 't51-neutral', tabindex: '-1' });
				function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

				// f1：布防真的打了 inputmode=none（承重行）。
				down(trigger);
				out.armedInputmode = composer.getAttribute('inputmode');

				// f2：布防窗口**之内**（远小于 800ms）让面板搜索框抢焦点，必须被收回。
				panelInput.focus();
				out.panelFocused = document.activeElement === panelInput;
				out.activeAfterPanel = document.activeElement ? document.activeElement.tagName : 'null';

				// f3：用户真点输入框仍能拿到焦点（不许为了不弹键盘把输入也弄没）。
				down(composer);
				composer.focus();
				out.composerFocused = document.activeElement === composer;

				// f4：R4 残留兜底。先用中性落点把窗口关掉，再模拟「第三方/摘除失败」在
				//     composer 身上写上 inputmode=none，然后走**用户真点输入框**那条路
				//     （落指 + 默认聚焦）。属性必须在这一下里被清掉、且焦点必须留住 ——
				//     T50 §5.2 实测：属性真残留时用户点输入框也弹不出键盘（mInputShown=false）。
				down(neutral);
				composer.setAttribute('inputmode', 'none');
				out.residualWritten = composer.getAttribute('inputmode');
				down(composer);
				composer.focus();
				out.residualAfter = composer.getAttribute('inputmode');
				out.residualFocused = document.activeElement === composer;

				// f5：放行窗口的**生命周期**。布防后 500ms 的摘防定时器必须把窗口一起关掉。
				//     取 650ms 这个点：修复后窗口已关（程序化聚焦 composer 会被守卫收回）；
				//     若 disarm 不关窗口，窗口还活到 800ms 且仍以 composer 为目标 ⇒ 放行。
				down(trigger);
				out.reArmInputmode = composer.getAttribute('inputmode');
				neutral.focus();
				await sleep(650);
				out.inputmodeAfterTimer = composer.getAttribute('inputmode');
				composer.focus();
				out.composerFocusAfterTimer = document.activeElement === composer;

				// ── T53：f6–f9 补三处覆盖缺口（每条都有行为判据，见下面各自的注释）──
				// 探针自检：守卫内部认的 composer 是 document.querySelector('[data-composer-input]')，
				// 必须确实是我们造的这棵，否则下面所有 inputmode 判据都读在别的节点上。
				out.probeComposerIsFirst = document.querySelector('[data-composer-input]') === composer;

				// f6：pageshow 必须收掉放行窗口（M5 的行为级牙齿）。
				//     判据是「同一个聚焦动作，前后结果不同」，不是源码字符串：
				//     先用「用户真点输入框」这条路上窗口（意图元素 = composer，自身命中），
				//     窗口内聚焦 composer 必须**放行**；dispatch pageshow 之后做**同一个**动作，
				//     必须变成**被收回**。删掉 pageshow 监听 ⇒ 第二次仍然放行 ⇒ 这条红。
				//     用 persisted:false 派发：源码里「恢复自愈」那个 pageshow 监听带
				//     if (!ev.persisted) return 的早退，persisted:false 只会打到焦点守卫这一个监听，
				//     顺带排除 probeResumeRecovery 的干扰（它有 RESUME_PROBE_DELAY_MS 延时）。
				down(composer);
				composer.focus();
				out.f6AllowedBeforeShow = document.activeElement === composer;
				try {
					window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
					out.f6ShowDispatched = true;
				} catch (ignoredPageShow) { out.f6ShowDispatched = false; }
				composer.blur();
				composer.focus();
				out.f6DeniedAfterShow = document.activeElement !== composer;

				// f7：切回前台必须扫 inputmode 残留（M6 的行为级牙齿）。
				//     ⚠️ 必须先换一棵**没被 MutationObserver 盯上**的 composer：
				//     watchComposerInputMode() 只在 armComposerFocus() 里被调、且 observe 的是
				//     当时那个节点（就是上面这棵）。若不换，观察者会在写属性的微任务里
				//     顺手把活干了 ⇒ 这条断言即使删掉 onVisibility 的 else 分支也会绿
				//     —— 那就是**第二颗假牙**。换树之后残留只能被 visibilitychange 那条路摘掉。
				//     同时 down(neutral) 收窗口 + 撤防（sweepResidualInputMode 在布防态下直接返回，
				//     不撤防的话属性挂着也不会被清，测的就不是兜底了）。
				host.remove();
				var host2 = mk('div', { 'data-composer-card': 'true', id: 't53-card' });
				var composer2 = mk('div', { 'data-composer-input': 'true', 'contenteditable': 'true' }, host2);
				composer2.textContent = 'dshr2';
				out.f7ComposerIsFirst = document.querySelector('[data-composer-input]') === composer2;
				down(neutral);
				composer2.setAttribute('inputmode', 'none');
				await sleep(60);
				// 空等一个宏任务（> 微任务）：观察者若还盯着这棵，这里就该被清干净了。
				out.f7ResidualBefore = composer2.getAttribute('inputmode');
				var visDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
				function setVis(state) {
					try {
						Object.defineProperty(document, 'visibilityState', {
							configurable: true, get: function () { return state; },
						});
					} catch (ignoredVis) { /* 平台不允许覆写：下面判据会红，不会假绿 */ }
				}
				setVis('visible');
				document.dispatchEvent(new Event('visibilitychange'));
				out.f7ResidualAfter = composer2.getAttribute('inputmode');
				// 复位 + 顺手把「切后台」那条路也走一遍（它是 clearUserFocusWindow 的另一半）。
				setVis('hidden');
				document.dispatchEvent(new Event('visibilitychange'));
				out.f7HiddenStillResidual = composer2.getAttribute('inputmode');
				try { delete document.visibilityState; } catch (ignoredDel) { /* 回落 */ }
				if (visDesc) {
					try { Object.defineProperty(Document.prototype, 'visibilityState', visDesc); } catch (ignoredRestore) { /* 原样 */ }
				}
				setVis('visible');

				// f8 / f9：inIntentScope 的**后代**分支与**祖先链**分支。
				//
				// ⚠ 形态选型踩了两次坑，都记在这里（照抄会重犯）：
				//  ① <input> / tabindex=-1 的 div 当「意图元素的后代」—— Chrome 里 contenteditable
				//     宿主会吞掉自己子树内**所有**节点的聚焦（实测 activeElement 原地不动、仍停在
				//     之前的 ctrl 上），focus() 是空操作。嵌套 contenteditable 也不行：焦点只会落到
				//     最外层编辑宿主，focusin 的 target 永远是宿主本身 ⇒ el === intentEl 短路，
				//     压根到不了 contains 分支。⇒ **后代分支靠 contenteditable 宿主不可达。**
				//  ② 树必须挂在 body 上：f7 为躲开 MutationObserver 把 host remove() 了，往已脱离
				//     文档的节点上挂后代，focus() 同样是空操作，症状与「被守卫收回」一模一样。
				//
				// ⇒ 正确形态 = 源码注释里写的那条真实路径：意图元素是**非 contenteditable 的包装层**
				//     （editableOwnerOf 的兜底 closest 认 [data-composer-input]，focusComposerEl() 也
				//     只按这个属性取，所以它不必可编辑），真正可编辑的是它内部的子输入框。官方把焦点
				//     落到「输入区内部的包装层/子输入框」正是 contains 分支存在的唯一理由。
				// 先摘掉 f7 的 host2，让 wrap 成为文档里第一个 [data-composer-input]（否则
				// focusComposerEl() 认的不是 wrap，意图集合里就没有它）。
				host2.remove();
				var host3 = mk('div', { 'data-composer-card': 'true', id: 't53-card3' });
				var wrap = mk('div', { 'data-composer-input': 'true', id: 't53-wrap' }, host3);
				var ta1 = mk('textarea', { id: 't53-ta1' }, wrap);   // 用户这次落的指
				var ta2 = mk('textarea', { id: 't53-ta2' }, wrap);   // 官方随后把焦点挪到的子输入框
				var outside = mk('textarea', { id: 't53-outside' }); // 包装层之外，必须**被拒**
				out.f8WrapIsFirst = document.querySelector('[data-composer-input]') === wrap;

				// f8 判据是**双向差分**（单边判据可能恒真）：窗口开着时，聚焦 wrap 的后代 ta2 必须
				// **放行**；聚焦包装层之外的 outside 必须**被收回**。删掉 contains(el) 那两行 ⇒
				// ta2 也被收回 ⇒ 这条红。
				down(ta1);
				ta2.focus();
				out.f8DescendantAllowed = document.activeElement === ta2;
				out.f8DescendantActive = document.activeElement ? document.activeElement.id : 'null';
				outside.focus();
				out.f8OutsideDenied = document.activeElement !== outside;
				out.f8OutsideActive = document.activeElement ? document.activeElement.id : 'null';

				// f9：inIntentScope 的**祖先链**分支（向上爬 node === intentEl）必须真的兜底。
				//     这一支在正常 DOM 上与 contains 等价（都是问 intentEl 是不是 el 的祖先），
				//     它的存在意义是 **contains 不可用时仍要给出通行证**（官方/框架自造宿主对象、
				//     跨文档包装层，contains 可能抛或不存在；源码里那行正包在 try/catch 里）。
				//     所以做故障注入：让 wrap 针对 ta2 的 contains 必然抛错，contains 分支因此
				//     **必然失效**，此时只有祖先链能救。注入只针对 (ta2) 这一个参数，其它 contains
				//     调用照常委托真实实现 —— 否则会误伤页面上别处对 wrap 的 contains。
				//     把 while 循环里那行 if (node === intentEl) return true; 删掉 ⇒ 收回 ⇒ 这条红。
				down(ta1);
				var realContains = wrap.contains;
				var containsInjected = false;
				try {
					Object.defineProperty(wrap, 'contains', {
						configurable: true,
						value: function (n) {
							if (n === ta2) throw new Error('t53-injected-contains-failure');
							return realContains.call(this, n);
						},
					});
					containsInjected = true;
				} catch (ignoredInject) { containsInjected = false; }
				out.f9ContainsInjected = containsInjected;
				ta2.focus();
				out.f9AncestorWalkAllowed = document.activeElement === ta2;
				out.f9Active = document.activeElement ? document.activeElement.id : 'null';
				try {
					Object.defineProperty(wrap, 'contains', {
						configurable: true, value: realContains, writable: true,
					});
				} catch (ignoredRestoreContains) { /* 留着也不影响收尾 */ }

				host3.remove(); panel.remove(); neutral.remove();
				out.focusinCount = fin;
				out.docHasFocus = document.hasFocus();
				var dg = typeof window.__dshrMobileDiag === 'function' ? window.__dshrMobileDiag() : (window.__dshrMobileDiag || {});
				out.diag = { on: dg.on, strictOff: dg.strictOff, device: dg.device, rootClass: dg.rootClass, mqlPhone: window.matchMedia('(max-width: 980px)').matches };
				return out;
			})()`,
			returnByValue: true,
			awaitPromise: true,
		});
		return evaluated.result && evaluated.result.value;
	}
	const focusProbe = await focusGuardProbe();

	async function viewportProbe() {
		const evaluated = await call("Runtime.evaluate", {
			expression: `(function(){
				var a = window.__dshRemoteAndroidMobile;
				if (a && a.syncViewport) a.syncViewport();
				var root = document.documentElement;
				if (!root.style.getPropertyValue('--dshr-inset-top')) {
					root.style.setProperty('--dshr-inset-top', '36px');
				}
				window.__dshRemoteInsets.set(36, 24);
				var frame = document.querySelector('[data-dshr-frame]') || document.querySelector('.frame');
				var main = document.querySelector('[data-dshr-main-col]');
				var side = document.querySelector('[data-dshr-sidebar-col]') || document.querySelector('.sidebar');
				var guard = document.getElementById('dshr-status-guard');
				var cs = getComputedStyle(root);
				var opened = frame && !frame.hasAttribute('data-sidebar-collapsed');
				return {
					mobile: root.classList.contains('dshr-mobile'),
					official: root.classList.contains('dshr-official-inset'),
					tablet: root.getAttribute('data-dshr-tablet') === '1',
					w: window.innerWidth,
					h: window.innerHeight,
					peek: cs.getPropertyValue('--dshr-drawer-peek').trim(),
					drawer: cs.getPropertyValue('--dshr-drawer-width').trim(),
					opened: !!opened,
					mainLeft: main ? Math.round(main.getBoundingClientRect().left) : -1,
					framePadTop: frame ? getComputedStyle(frame).paddingTop : '',
					sidePadTop: side ? getComputedStyle(side).paddingTop : '',
					mainPadTop: main ? getComputedStyle(main).paddingTop : '',
					mainPadBottom: main ? getComputedStyle(main).paddingBottom : '',
					sidePadBottom: side ? getComputedStyle(side).paddingBottom : '',
					guard: !!guard,
					guardH: guard ? Math.round(guard.getBoundingClientRect().height) : 0
				};
			})()`,
			returnByValue: true,
		});
		return evaluated.result && evaluated.result.value;
	}

	await call("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 800,
		deviceScaleFactor: 2,
		mobile: true,
		screenOrientation: { type: "landscapePrimary", angle: 90 },
	});
	await wait(400);
	const landscapeProbe = await viewportProbe();

	await call("Emulation.setDeviceMetricsOverride", {
		width: 800,
		height: 1280,
		deviceScaleFactor: 2,
		mobile: true,
		screenOrientation: { type: "portraitPrimary", angle: 0 },
	});
	await wait(400);
	const tabletClosed = await viewportProbe();
	await call("Runtime.evaluate", {
		expression: `(function(){
			var frame = document.querySelector('[data-dshr-frame]') || document.querySelector('.frame');
			if (frame) {
				frame.style.width = '100%';
				frame.style.maxWidth = 'none';
				frame.style.margin = '0';
			}
			var a = window.__dshRemoteAndroidMobile;
			if (a && a.syncViewport) a.syncViewport();
			if (a && a.settleDrawer) a.settleDrawer(true);
			return true;
		})()`,
		returnByValue: true,
	});
	await wait(500);
	const tabletOpen = await viewportProbe();
	ws.close();

	const extra = [];
	function extraCheck(name, ok, detail) {
		extra.push({ name, ok: !!ok, detail: detail || "" });
	}
	extraCheck(
		"landscape-no-hook",
		landscapeProbe && landscapeProbe.mobile === false,
		landscapeProbe ? `w=${landscapeProbe.w} h=${landscapeProbe.h} mobile=${landscapeProbe.mobile}` : "no probe",
	);
	extraCheck(
		"landscape-status-inset",
		landscapeProbe && landscapeProbe.official === true
			&& landscapeProbe.framePadTop !== "36px"
			&& landscapeProbe.sidePadTop === "36px"
			&& landscapeProbe.mainPadTop === "36px",
		landscapeProbe ? `official=${landscapeProbe.official} frame=${landscapeProbe.framePadTop} side=${landscapeProbe.sidePadTop} main=${landscapeProbe.mainPadTop}` : "no probe",
	);
	extraCheck(
		"landscape-navigation-inset",
		landscapeProbe && landscapeProbe.mainPadBottom === "24px"
			&& landscapeProbe.sidePadBottom === "24px",
		landscapeProbe ? `main=${landscapeProbe.mainPadBottom} side=${landscapeProbe.sidePadBottom}` : "no probe",
	);
	extraCheck(
		"landscape-status-guard",
		landscapeProbe && landscapeProbe.guard === true && landscapeProbe.guardH >= 30,
		landscapeProbe ? `guard=${landscapeProbe.guard} h=${landscapeProbe.guardH}` : "no probe",
	);
	extraCheck(
		"tablet-portrait-hook",
		tabletClosed && tabletClosed.mobile === true && tabletClosed.tablet === true && tabletClosed.official === false,
		tabletClosed ? `w=${tabletClosed.w} tablet=${tabletClosed.tablet} official=${tabletClosed.official}` : "no probe",
	);
	extraCheck(
		"tablet-drawer-not-fullscreen",
		tabletOpen && tabletOpen.opened && tabletOpen.mainLeft >= 240 && tabletOpen.mainLeft <= 420,
		tabletOpen ? `opened=${tabletOpen.opened} mainLeft=${tabletOpen.mainLeft} drawer=${tabletOpen.drawer}` : "no probe",
	);
	// ── T51（R2/R4）：焦点守卫行为级断言的判定 ──
	extraCheck(
		"focus-arm-sets-inputmode-none",
		focusProbe && focusProbe.armedInputmode === "none",
		focusProbe ? `inputmode=${JSON.stringify(focusProbe.armedInputmode)} diag=${JSON.stringify(focusProbe.diag)}` : "no probe",
	);
	extraCheck(
		"focus-arm-window-not-leaked-to-panel-input",
		focusProbe && focusProbe.panelFocused === false,
		focusProbe ? `panelFocused=${focusProbe.panelFocused} active=${focusProbe.activeAfterPanel} fin=${focusProbe.focusinCount} hasFocus=${focusProbe.docHasFocus}` : "no probe",
	);
	extraCheck(
		"focus-user-tap-still-focuses-composer",
		focusProbe && focusProbe.composerFocused === true,
		focusProbe ? `composerFocused=${focusProbe.composerFocused}` : "no probe",
	);
	extraCheck(
		"focus-residual-inputmode-swept",
		focusProbe && focusProbe.residualWritten === "none" && focusProbe.residualAfter === null
			&& focusProbe.residualFocused === true,
		focusProbe
			? `written=${focusProbe.residualWritten} after=${JSON.stringify(focusProbe.residualAfter)} focused=${focusProbe.residualFocused}`
			: "no probe",
	);
	extraCheck(
		"focus-arm-window-closed-by-disarm-timer",
		focusProbe && focusProbe.composerFocusAfterTimer === false,
		focusProbe
			? `reArm=${JSON.stringify(focusProbe.reArmInputmode)} im@650ms=${JSON.stringify(focusProbe.inputmodeAfterTimer)} composerFocusedAfterTimer=${focusProbe.composerFocusAfterTimer}`
			: "no probe",
	);
	// ── T53：三条新行为级断言（每条都配了变异反证，见 scratch/t53/report.md §1）──
	// 探针自检：守卫认的 composer 必须就是我们造的那棵，否则下面判据读错节点。
	extraCheck(
		"focus-probe-composer-is-first",
		focusProbe && focusProbe.probeComposerIsFirst === true && focusProbe.f7ComposerIsFirst === true,
		focusProbe
			? `probeComposerIsFirst=${focusProbe.probeComposerIsFirst} f7ComposerIsFirst=${focusProbe.f7ComposerIsFirst}`
			: "no probe",
	);
	// f6 —— pagesshow 收窗口（M5）。前后两次是**同一个**聚焦动作，结果必须一放一收。
	extraCheck(
		"focus-window-closed-by-pageshow",
		focusProbe && focusProbe.f6ShowDispatched === true
			&& focusProbe.f6AllowedBeforeShow === true
			&& focusProbe.f6DeniedAfterShow === true,
		focusProbe
			? `dispatched=${focusProbe.f6ShowDispatched} allowedBefore=${focusProbe.f6AllowedBeforeShow} deniedAfter=${focusProbe.f6DeniedAfterShow}`
			: "no probe",
	);
	// f7 —— 回前台扫残留（M6）。f7ResidualBefore 仍为 'none' 是关键：它证明
	//      MutationObserver 没有替 visibilitychange 把活干了（观察者只盯旧那棵树）。
	extraCheck(
		"focus-residual-swept-on-return-to-foreground",
		focusProbe && focusProbe.f7ResidualBefore === "none" && focusProbe.f7ResidualAfter === null,
		focusProbe
			? `before=${JSON.stringify(focusProbe.f7ResidualBefore)} after=${JSON.stringify(focusProbe.f7ResidualAfter)} hiddenPath=${JSON.stringify(focusProbe.f7HiddenStillResidual)}`
			: "no probe",
	);
	// f8 —— inIntentScope 后代分支（contains）真的放行，且包装层之外仍被拒（双向差分）。
	extraCheck(
		"focus-intent-scope-descendant-allowed",
		focusProbe && focusProbe.f8WrapIsFirst === true
			&& focusProbe.f8DescendantAllowed === true
			&& focusProbe.f8OutsideDenied === true,
		focusProbe
			? `wrapIsFirst=${focusProbe.f8WrapIsFirst} descendantAllowed=${focusProbe.f8DescendantAllowed} active=${focusProbe.f8DescendantActive} outsideDenied=${focusProbe.f8OutsideDenied} outsideActive=${focusProbe.f8OutsideActive}`
			: "no probe",
	);
	// f9 —— contains 不可用时祖先链兜底（故障注入）。注入必须真的成功，
	//      否则这条会在「没注入」的前提下假绿。
	extraCheck(
		"focus-intent-scope-ancestor-walk-fallback",
		focusProbe && focusProbe.f9ContainsInjected === true && focusProbe.f9AncestorWalkAllowed === true,
		focusProbe
			? `injected=${focusProbe.f9ContainsInjected} ancestorWalkAllowed=${focusProbe.f9AncestorWalkAllowed} active=${focusProbe.f9Active}`
			: "no probe",
	);

	console.log("  -- Chrome 390 视口 --");
	printChecks(report);
	console.log("  -- Android 壳 UA --");
	printChecks(androidReport);
	console.log("  -- 横屏 / 平板竖屏 --");
	printChecks({ checks: extra });
	const extraOk = extra.every((c) => c.ok);
	if (!report.ok || !androidReport.ok || !extraOk) {
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
