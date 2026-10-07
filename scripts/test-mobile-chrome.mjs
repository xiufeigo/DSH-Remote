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
// T56：hook 缺席页（同 fixture 摘掉自带的那行 <script src=mobile.js>），由 server 现场合成。
const NO_HOOK_FIXTURE = "/scripts/fixtures/mobile-selftest-noinject.html";
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
		const arm = bodyOf("function armComposerFocus(");
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
	// ── T88：hook 侧「层 1」（官方 `<button data-phase="connecting">`）的源码契约 + 两端同源 ──
	//
	// 为什么必须有这一块：layer 1 是把原生 `ReconnectBanner.PROBE_JS` 的层 1 判据**移植**过来的，
	// 两边必须只有一份口径。T86 的教训就是两端名单本来就不一致（原生层 2 多排除 contenteditable，
	// hook 层 2 没排除 ⇒ 同一个 composer 两端结论相反）。这里**同时读两个文件**、把双方字面量
	// 抽出来做相等比较 ⇒ 任何一端被单独改动，`pnpm test:mobile` 立刻变红。
	// （原生侧另有 `ReconnectBannerTest` 把同一份字面量抽出来真跑正/负例。）
	{
		const at = src.indexOf("function findOfficialReconnectButton() {");
		if (at < 0) {
			throw new Error(
				"源码契约：缺少层 1 的 findOfficialReconnectButton —— 官方那条 `<button data-phase=\"connecting\">` 会被「排除可交互控件」整条挡掉，findReconnectStatusElement() 在真实页面上恒 null（T87 实测 0/528 命中）",
			);
		}
		const body = src.slice(at, src.indexOf("\n\t/** ", at));
		for (const [needle, why] of [
			["if (phase !== OFFICIAL_PHASE) continue;", "必须「恰等于」connecting（前缀扩展 connecting-extra 不得命中）"],
			["if (COMPOSER_DENY_RE.test(aria)) continue;", "必须有 composer 排除清单否决（发送键/「+」键即使带 data-phase 也不得命中）"],
			["if (isInsideComposer(el)) continue;", "必须有 composer 祖先否决（contenteditable / role=textbox）"],
			["if (!isVisible(el)) continue;", "必须有可见性闸（无布局盒不算）"],
			["anchoredText(el)", "文案必须取「去掉 aria-hidden 子树后」的文字（不依赖 CSS module 哈希类名）"],
		]) {
			if (!body.includes(needle)) throw new Error(`源码契约：层 1 ${why}（缺 ${needle}）`);
		}
		if (!/RECONNECT_STATUS_RE\.test\(coreStatusText\(text\)\)/.test(body) || !/RECONNECT_ARIA_RE\.test\(aria\)/.test(body)) {
			throw new Error("源码契约：层 1 的文案锚定必须「整串 / 去尾句点 / aria-label」三取一");
		}
		if (!/var official = findOfficialReconnectButton\(\);\s*\n\s*if \(official\) return \{ src: 1, el: official \};/.test(src)) {
			throw new Error("源码契约：findReconnectStatusElement 必须先走层 1（官方那条优先于层 2 的任意文案）");
		}
		if (!src.includes("function findTextReconnectStatusElement()") || !src.includes("if (isInteractiveNode(el)) continue;")) {
			throw new Error("源码契约：层 2（非按钮文案路径，T38-2 老判据）必须保留，且仍排除可交互控件");
		}
		if (!src.includes("[role=\"textbox\"],[onclick],[contenteditable]")) {
			throw new Error(
				"源码契约：层 2 的排除名单必须与原生 PROBE_JS 的 inter() 对齐（含 role=textbox / contenteditable）——否则 composer 里手打的「重新连接中」会被判成重连",
			);
		}
		// 两端同源：从 ReconnectBanner.java 抽同一份字面量逐字符比对
		const banner = join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/ReconnectBanner.java");
		if (!existsSync(banner)) throw new Error("源码契约：找不到 ReconnectBanner.java（层 1 判据的原生端）");
		const java = readFileSync(banner, "utf8");
		const javaLiteral = (decl) => {
			const i = java.indexOf(decl);
			if (i < 0) throw new Error(`两端同源：ReconnectBanner.java 里找不到 ${decl}`);
			const seg = java.slice(i, java.indexOf(";", i));
			const parts = [...seg.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
			if (parts.length === 0) throw new Error(`两端同源：${decl} 里没抽到字符串字面量`);
			return parts.join("");
		};
		const hookLiteral = (name) => {
			const m = new RegExp(`var ${name} = (/[^\\n]*?/[a-z]*);`).exec(src);
			if (!m) throw new Error(`两端同源：hook 里找不到 ${name} 的正则字面量`);
			return m[1];
		};
		const hookString = (name) => {
			const m = new RegExp(`var ${name} = '([^']*)';`).exec(src);
			if (!m) throw new Error(`两端同源：hook 里找不到 ${name} 的字符串字面量`);
			return m[1];
		};
		for (const [name, jv, hv] of [
			["OFFICIAL_PHASE", javaLiteral("String OFFICIAL_PHASE ="), hookString("OFFICIAL_PHASE")],
			["COMPOSER_DENY_JS", javaLiteral("String COMPOSER_DENY_JS ="), hookLiteral("COMPOSER_DENY_RE")],
			["ARIA_RE_JS", javaLiteral("String ARIA_RE_JS ="), hookLiteral("RECONNECT_ARIA_RE")],
			// T90：收口 T88 遗留的两端口径差异 —— 层 1 的 ⑤ composer 祖先否决，
			// 两端现在用**同一份 role 字面量**（hook 的 COMPOSER_ROLE_RE / 原生的 COMPOSER_ROLE_JS）。
			["COMPOSER_ROLE_JS", javaLiteral("String COMPOSER_ROLE_JS ="), hookLiteral("COMPOSER_ROLE_RE")],
		]) {
			if (jv !== hv) {
				throw new Error(`两端同源：${name} 漂移了 —— ReconnectBanner.java=${jv} 而 hook=${hv}（改一端必须同时改另一端）`);
			}
		}
		// 原生侧必须**真的用**这条否决（不只是声明一个常量）：层 1 循环里要有 insideComposer 闸，
		// 且它必须排在 DENY 之后、可见性闸之前（与 hook 的 ⑤ 同位置）。
		{
			const tier1 = java.slice(java.indexOf("querySelectorAll('[data-phase]')"), java.indexOf("return hit(el,1);}"));
			const atDeny = tier1.indexOf("if(DENY.test(aria(el)))continue;");
			const atComposer = tier1.indexOf("if(insideComposer(el))continue;");
			const atVis = tier1.indexOf("if(!vis(el))continue;");
			if (atComposer < 0) {
				throw new Error("两端同源：原生 PROBE_JS 层 1 缺 composer 祖先否决（T88 遗留差异没被收口）");
			}
			if (!(atDeny >= 0 && atDeny < atComposer && atComposer < atVis)) {
				throw new Error(`两端同源：原生层 1 的否决顺序必须与 hook 一致（DENY → composer → vis），实测 ${String(atDeny)}/${String(atComposer)}/${String(atVis)}`);
			}
		}
	}
	// ── T90：UI 无关的连接态信号源（包装 window.WebSocket）+ 两处接线 ──
	//
	// 为什么必须有这一块：T88 把官方那条「重新连接中」认出来了，但官方**只在左栏展开
	// （wide）时才渲染它**（dsh-client-ui-settings-general：`state: wide && …`）⇒
	// 左栏收起（56px rail，用户平时的状态）时页面上没有任何可判对象，hook 恒判健康、
	// nudge 永不推、原生横幅也无从显示。T90 换掉判据源（WebSocket 观测），这块把
	// **"信号源必须存在" + "判据必须真的接上它" + "包装器必须是完整透传"** 钉死。
	{
		for (const [needle, why] of [
			["function installWsStateWatch() {", "必须有 WebSocket 观测的安装函数"],
			["function wsWatchDown() {", "必须有 UI 无关的断开判据"],
			["function isConnectionDown() {", "必须有合并判据（DOM 文案 OR WS 观测）"],
			["Reflect.construct(nativeCtor, args, new.target)", "构造必须完整透传（参数/原型/new.target）"],
			["Wrapped.prototype = nativeCtor.prototype;", "prototype 必须是原生**同一个对象**（instanceof 语义）"],
			["if (typeof new.target !== 'function') {", "不带 new 调用必须走与浏览器相同的 TypeError 路径"],
			["if (wsWatchInjectedTablet()) return false;", "平板档（严格 OFF）不得安装观测"],
			["function uninstallWsStateWatch() {", "关闭态/平板档必须能还原 window.WebSocket"],
			["wsStateNow: function () {", "必须有给原生 onResume 补读的**只读**入口"],
		]) {
			if (!src.includes(needle)) throw new Error(`源码契约：T90 ${why}（缺 ${needle}）`);
		}
		// 安装点必须在 pending 早退**之前**：否则文档还没给出 <html> 时先返回、
		// 等 DOMContentLoaded 才装，而 app 的 socket 可能在微任务里就建好了（漏观测）。
		const atInstall = src.indexOf("\tinstallWsStateWatch();");
		const atGuard = src.indexOf("if (window.__dshRemoteMobileInstalled) return;");
		if (!(atInstall > 0 && atInstall < atGuard)) {
			throw new Error("源码契约：T90 观测安装必须早于 __dshRemoteMobileInstalled 幂等闸（pending 路径会漏掉 app 的首条 socket）");
		}
		// 常量必须在最早那次调用之前赋值（否则 wsWatchDown 读到的宽限期是 undefined）。
		// T112：两个宽限的取值都是本轮重新定的（CONNECTING 2000→8000、新增 close 宽限 1500），
		// 断言跟着改字面量，但"必须在最早那次 installWsStateWatch() 之前赋值"这条**不放宽**。
		const atConst = src.indexOf("var WS_CONNECT_GRACE_MS = 8000;");
		const atConstClose = src.indexOf("var WS_CLOSE_GRACE_MS = 1500;");
		if (!(atConst > 0 && atConst < atInstall)) {
			throw new Error("源码契约：T90 WS_CONNECT_GRACE_MS 必须在 installWsStateWatch() 那次最早调用之前赋值（var 提升不提升赋值）");
		}
		if (!(atConstClose > 0 && atConstClose < atInstall)) {
			throw new Error("源码契约：T112 WS_CLOSE_GRACE_MS 必须在 installWsStateWatch() 那次最早调用之前赋值");
		}
		// 判据接线：probeResumeRecovery 与 collectUiDiag 都必须换成 isConnectionDown()，
		// **不得**再只认 DOM 文案 —— 这正是 rail 盲区（T88 §E.4）的成因。
		const probeAt = src.indexOf("function probeResumeRecovery() {");
		const probeBody = src.slice(probeAt, src.indexOf("\n\tfunction ", probeAt));
		if (!probeBody.includes("var reconnecting = isConnectionDown();")) {
			throw new Error("源码契约：T90 probeResumeRecovery 的判据必须是 isConnectionDown()（rail 下 DOM 恒 null ⇒ 只认文案就永不推 nudge）");
		}
		if (!probeBody.includes("if (!reconnecting)")) {
			throw new Error("源码契约：T90 健康闸写法必须保留（test-resume-recovery.mjs 逐字匹配 if (!reconnecting)）");
		}
		if (probeBody.includes("findReconnectStatusElement() !== null")) {
			throw new Error("源码契约：T90 probeResumeRecovery 不得回退成只认 DOM 文案（rail 盲区回归）");
		}
		const diagAt = src.indexOf("function collectUiDiag() {");
		const diagBody = src.slice(diagAt, src.indexOf("\n\tfunction ", diagAt));
		if (!diagBody.includes("reconnecting = isConnectionDown();")) {
			throw new Error("源码契约：T90 collectUiDiag().wsState 必须走同一条合并判据（否则诊断行在 rail 下继续说谎）");
		}
		// 翻转回调：必须接进**既有**上报通道与既有自愈入口（不新增定时器）。
		if (!src.includes("wsWatchSetNotify(function (down) {")) {
			throw new Error("源码契约：T90 连接态翻转必须有登记回调");
		}
		const notifyAt = src.indexOf("wsWatchSetNotify(function (down) {");
		const notifyBody = src.slice(notifyAt, src.indexOf("\n\t}", notifyAt));
		if (!notifyBody.includes("reportUiDiag()") || !notifyBody.includes("probeResumeRecovery")) {
			throw new Error("源码契约：T90 翻转回调必须同时接 reportUiDiag（桥上报）与 probeResumeRecovery（既有自愈入口）");
		}
		// 观测本身**不得**引入定时器/轮询/网络请求：健康态零开销的结构性保证。
		const watchStart = src.indexOf("function installWsStateWatch() {");
		const watchEnd = src.indexOf("function syncWsStateWatch(enabled) {");
		const watchBlock = src.slice(watchStart, watchEnd);
		for (const forbidden of ["setInterval", "fetch(", "XMLHttpRequest", "MutationObserver"]) {
			if (watchBlock.includes(forbidden)) {
				throw new Error(`源码契约：T90 观测块不得出现 ${forbidden}（观测必须是被动监听，不是轮询）`);
			}
		}
		// 两处"必须保留"的风暴边界（T82/T88 成果不得回退）。
		// T112b：`RESUME_MAX_NUDGES` 的**取值**由本任务重定为 2（依据 T110 §8.4 ①：上限 6 时
		// 同一误报下真掐断 6 次 ≈ 50s 连掉 6 次）。**钉住的是取值本身**，不是随便一个 ≤ 6 的数：
		// 改回 6 这条断言立刻红（变异 M3 的反证点）。
		for (const keep of ["var RESUME_MAX_NUDGES = 2;", "RESUME_MIN_INTERVAL_MS = 8000", "RESUME_CONFIRM_DELAY_MS"]) {
			if (!src.includes(keep)) throw new Error(`源码契约：T90/T112b 不得回退风暴边界（缺 ${keep}）`);
		}
		// T112b：nudge 动作必须按**来源**分流 —— 只有 wsSrc===3（WS 观测到真 close）才允许
		// `offline`→`online`（那一对会让上游真的 abort 在用 socket = 用户可见掉线）；
		// DOM 文案（1/2）与探活（4）退回 online-only（幂等短路 ⇒ 无害）。依据 T110 §8.4 ①。
		// 钉住两件事：① 分流那道闸在 requestUpstreamReconnect 里、且用 connectionDownSource()；
		// ② 两个分支的返回值（`-online-only` 与 `network-transition`）都存在 ⇒ 去掉分流必红。
		{
			const fnAt = src.indexOf("function requestUpstreamReconnect() {");
			if (fnAt < 0) throw new Error("源码契约：T112b 找不到 requestUpstreamReconnect");
			const fnEnd = src.indexOf("\n\tfunction ", fnAt);
			const body = src.slice(fnAt, fnEnd > 0 ? fnEnd : fnAt + 2000);
			if (!body.includes("var src = connectionDownSource();")) {
				throw new Error("源码契约：T112b nudge 动作必须按来源分流（缺 connectionDownSource() 读取）");
			}
			if (!body.includes("if (src !== 3) {")) {
				throw new Error("源码契约：T112b 只有 wsSrc===3（WS 观测到真 close）才允许掐断连接");
			}
			if (!body.includes("return 'network-transition-online-only';") || !body.includes("return 'network-transition';")) {
				throw new Error("源码契约：T112b 分流的两条分支必须都保留（online-only / 掐断对）");
			}
			// 分流闸必须**早于** offline 派发：否则等于没分流（offline 先出去，连接已被掐）。
			const gateAt = body.indexOf("if (src !== 3) {");
			const offlineAt = body.indexOf("window.dispatchEvent(new Event('offline'));");
			if (!(offlineAt > gateAt)) {
				throw new Error("源码契约：T112b 分流闸必须早于 offline 派发（晚于它就等于没分流）");
			}
			// 同一口径：resumeRecoveryState().wsSrc 与分流读的必须是**同一个**函数。
			if (!src.includes("wsSrc: connectionDownSource(),")) {
				throw new Error("源码契约：T112b resumeRecoveryState().wsSrc 必须与分流同口径（同一个 connectionDownSource()）");
			}
			// 分流闸读的那个函数必须**没丢层**：③4 = 只有探活命中（T95 那条断言的新落点）。
			const srcFnAt = src.indexOf("function connectionDownSource() {");
			if (srcFnAt < 0) throw new Error("源码契约：T112b 缺少 connectionDownSource()");
			const srcFnEnd = src.indexOf("\n\tfunction ", srcFnAt);
			const srcBody = src.slice(srcFnAt, srcFnEnd > 0 ? srcFnEnd : srcFnAt + 1200);
			for (const [needle, why] of [
				["if (detail.src > 0) return detail.src;", "DOM 层（1/2）必须仍然优先报出"],
				["if (wsDown) return 3;", "WS 观测层（3）"],
				["if (resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS) return 4;", "只有探活命中这一层（4）"],
				["return 0;", "健康"],
			]) {
				if (!srcBody.includes(needle)) throw new Error(`源码契约：T112b connectionDownSource 缺 ${why}（${needle}）`);
			}
		}
		// T112b：close 的三个事实字段必须被记账（改前只记 lastEvent='close'，丢掉一半信息）。
		{
			const at = src.indexOf("function wsWatchEvent(rec, opened, ev) {");
			if (at < 0) throw new Error("源码契约：T112b wsWatchEvent 必须接收 CloseEvent（第三个形参 ev）");
			const end = src.indexOf("function wsWatchSocket(socket) {");
			const body = src.slice(at, end > 0 ? end : at + 4000);
			for (const [needle, why] of [
				["if (typeof ev.code === 'number') code = ev.code;", "必须记 CloseEvent.code"],
				["if (typeof ev.reason === 'string') reason = ev.reason.slice(0, 80);", "必须记 CloseEvent.reason（截断）"],
				["if (typeof ev.wasClean === 'boolean') wasClean = ev.wasClean;", "必须记 CloseEvent.wasClean"],
				["s.lastCloseCode = code;", "只读诊断字段 lastCloseCode"],
				["s.closeAbnormalCount += 1;", "干净/异常关闭必须分桶计数"],
			]) {
				if (!body.includes(needle)) throw new Error(`源码契约：T112b close 记账缺 ${why}（${needle}）`);
			}
			// 记账不得新增监听器：close 监听器仍然只有**两条**（addEventListener + onclose 兜底）。
			const watchStart = src.indexOf("function wsWatchSocket(socket) {");
			const watchEnd = src.indexOf("function installWsStateWatch() {");
			const watchBlock = src.slice(watchStart, watchEnd);
			const closeListeners = (watchBlock.match(/addEventListener\('close'/g) || []).length;
			const openListeners = (watchBlock.match(/addEventListener\('open'/g) || []).length;
			if (closeListeners !== 1 || openListeners !== 1) {
				throw new Error(`源码契约：T112b/常态监听器数量不许增加（close=${String(closeListeners)} open=${String(openListeners)}，各应为 1）`);
			}
		}
		// 原生侧：横幅的数据源必须是"hook 上报 OR DOM 探针"两路，且 hook 那路不覆盖 UNKNOWN。
		const main = readFileSync(join(ROOT, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java"), "utf8");
		for (const [needle, why] of [
			["private volatile String hookConnState = null;", "必须有一个 hook 上报连接态的字段（横幅的第二个数据源）"],
			["hookConnState = parseUiDiagWsState(json);", "必须从**既有** setUiDiag 载荷里取 wsState（不新增桥方法）"],
			["private static String parseUiDiagWsState(String json) {", "必须有只认三个已知取值的解析器"],
			["refreshHookConnState();", "onResume 必须补读一次（后台期间 pauseTimers 会冻住页面事件）"],
			["\"hook=reconnecting\"", "探针日志必须能区分「这条是 hook 那一路判的」"],
		]) {
			if (!main.includes(needle)) throw new Error(`源码契约：T90 原生侧 ${why}（缺 ${needle}）`);
		}
		const hprAt = main.indexOf("private void handleReconnectProbe(String value) {");
		const hprBody = main.slice(hprAt, main.indexOf("\n\t}", hprAt));
		if (!hprBody.includes("\"reconnecting\".equals(hookConnState)")) {
			throw new Error("源码契约：T90 handleReconnectProbe 必须 OR hook 上报的连接态（否则 rail 下横幅永不出现）");
		}
		const pageStart = main.slice(main.indexOf("public void onPageStarted(WebView view, String url, Bitmap favicon) {"));
		if (!pageStart.slice(0, 800).includes("hookConnState = null;")) {
			throw new Error("源码契约：T90 新文档必须重置 hook 上报的连接态（页面级数据源，不许跨页带）");
		}
	}
	// ── T95：回前台"主动探活"（半开）+ 回前台首次推不等间隔 ──
	//
	// 真值依据（scratch/t95/report.md §1）：后台期 JS 整体冻结（单拍空档 47755ms）但冻结本身不会卡
	// （干净断线回前台 864ms 自愈、nudge 0 次）；真正会卡住的是**半开**（`close` 永不到 ⇒
	// wsWatchDown() 恒健康 ⇒ 一次都不推），而 mux 健康空闲期本来就零帧（75s 收 0 帧）
	// ⇒ 不能用"静默"当判据，只能回前台主动发一次探活。这块把"探活必须存在、必须只在回前台
	// 且后台待够久时发、必须绕缓存、必须认到判据里、且不得放宽任何硬边界"逐条钉死。
	{
		// ① 探活本体必须在 WS 观测块**之外**（观测块只许被动监听，上面 T90 那条断言管着）。
		const watchStartAt = src.indexOf("function installWsStateWatch() {");
		const watchEndAt = src.indexOf("function syncWsStateWatch(enabled) {");
		const watchBlockT95 = src.slice(watchStartAt, watchEndAt);
		const verifyAt = src.indexOf("function verifyResumeTransport() {");
		if (!(verifyAt > watchEndAt)) {
			throw new Error("源码契约：T95 主动探活必须定义在 WS 观测块之外（观测块只能被动监听）");
		}
		if (watchBlockT95.includes("verifyResumeTransport")) {
			throw new Error("源码契约：T95 探活不得出现在 WS 观测块内（观测块零网络请求）");
		}
		// ② 只在"回前台 + 后台待够久"时才发 ⇒ 健康前台零请求。
		for (const [needle, why] of [
			["var RESUME_VERIFY_MIN_HIDDEN_MS = 20000;", "后台待够多久才允许探活（健康前台零请求的闸）"],
			["var RESUME_VERIFY_TIMEOUT_MS = 3000;", "探活硬超时"],
			["function verifyResumeTransport() {", "探活本体"],
			["if (hiddenMs >= RESUME_VERIFY_MIN_HIDDEN_MS) verifyResumeTransport();", "探活必须被后台时长闸住"],
			["resumeHiddenSince = Date.now(); return;", "隐藏时必须记录进入后台的时刻"],
			["'/__dsh_remote__/health?__dshr_probe='", "探活必须打网关**本地**端点（探传输链路，不探上游会话）"],
			["cache: 'no-store',", "探活必须绕缓存（否则命中 SW 磁盘缓存会得到假“活”）"],
			["resumeFromResumeIntent = true;", "回前台意图位（不用形参，理由见下）"],
			["var fromResume = resumeFromResumeIntent === true;", "意图位必须在 probeResumeRecovery 里读走"],
			["if (resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS) return true;", "探活结论必须并进 isConnectionDown()（否则半开仍判健康）"],
			["resumeVerifyDownAt = 0;", "新 socket 打开必须撤销探活结论"],
			["var bypassInterval = resumeBypassUntil > 0 && Date.now() <= resumeBypassUntil", "回前台跳过间隔必须走**自到期窗口**"],
			["resumeBypassUntil = resumeBypassUntil + 0;", "占位（不会命中）"],
		]) {
			if (why.startsWith("占位")) continue;
			if (!src.includes(needle)) throw new Error(`源码契约：T95 ${why}（缺 ${needle}）`);
		}
		// ③ 不得用形参：`scripts/test-resume-recovery.mjs` 逐字匹配 `function probeResumeRecovery()`。
		if (!src.includes("function probeResumeRecovery() {")) {
			throw new Error("源码契约：T95 不得给 probeResumeRecovery 加形参（test-resume-recovery.mjs 逐字匹配零参签名）");
		}
		if (src.includes("probeResumeRecovery(true)")) {
			throw new Error("源码契约：T95 回前台必须通过意图位进入（不得出现 probeResumeRecovery(true)）");
		}
		// ④ 硬边界逐字不动 + 窗口推过一次即关（防风暴语义与改前相同）。
		// T112b：`RESUME_MAX_NUDGES` 由本任务 6→2（同上，钉住取值）。
		for (const keep of ["RESUME_MIN_INTERVAL_MS = 8000", "var RESUME_MAX_NUDGES = 2;", "RESUME_CONFIRM_DELAY_MS = 400",
			"if (bypassInterval || (resumeLastNudgeAt > 0 && Date.now() - resumeLastNudgeAt >= RESUME_MIN_INTERVAL_MS)) {",
			"resumeBypassUntil = 0;",
			// T95：跳过间隔的窗口还额外被"硬地板"压着 —— DOM 真值台实测到过"迟到/重复的回前台意图
			// 把窗口重新打开 ⇒ 第二次推只隔 450ms"的漏洞，地板把它堵死（且不影响首次不等 8s）。
			"var RESUME_HARD_MIN_GAP_MS = 1500;",
			"&& sinceLastNudge >= RESUME_HARD_MIN_GAP_MS;"]) {
			if (!src.includes(keep)) throw new Error(`源码契约：T95 不得放宽既有风暴边界（缺 ${keep}）`);
		}
		const nudgeAt = src.indexOf("resumeLastNudgeResult = requestUpstreamReconnect();");
		if (!(nudgeAt > 0 && src.slice(nudgeAt, nudgeAt + 400).includes("resumeBypassUntil = 0;"))) {
			throw new Error("源码契约：T95 跳过间隔的窗口必须在推过一次后立刻关闭");
		}
		// ⑤ 探活结论必须是只读诊断可见的（真机自证用），且 `reconnecting` 必须与
		// `isConnectionDown()` **同口径** —— 我在装置上实测到过"collectUiDiag 说 reconnecting
		// 而 resumeRecoveryState 说 false"的自相矛盾（横幅出来了、诊断字段说没事）。
		for (const field of ["verifyDown:", "verifyResult:", "verifyAt:", "hiddenSince:", "bypassUntil:"]) {
			if (!src.includes(field)) throw new Error(`源码契约：T95 resumeRecoveryState 缺少只读诊断字段 ${field}`);
		}
		// T116：上一行的内联 trust 改为 trustDown 门控变量 —— 有活口（openNow>0）时
		// trust 不计，与 isConnectionDown() 的新口径一致（活口是事实、探活只是推测）。
		// 钉两件事：① reconnecting 仍含 trust 这一路（换了载体，不许丢）；② trustDown
		// 的计算里必须有活口门控（否则与 isConnectionDown() 漂移，诊断快照说谎）。
		if (!src.includes("reconnecting: detail.el !== null || wsDown || trustDown,")) {
			throw new Error("源码契约：T95 resumeRecoveryState().reconnecting 必须与 isConnectionDown() 同口径（含探活那一路，T116 起走 trustDown 门控变量）");
		}
		if (!src.includes("trustDown = !(ws && ws.installed && ws.openNow > 0);")) {
			throw new Error("源码契约：T116 trustDown 必须含活口门控（有活口时 trust 不计，否则诊断快照与 isConnectionDown() 漂移）");
		}
		// T112b：这一条的老落点是 resumeRecoveryState 里那串内联三元式；本任务把"哪一层认出来的"
		// 抽成 connectionDownSource()（**同一个**取值同时被 nudge 的分流闸读，两处必须同口径），
		// 所以「4 = 只有探活命中」这一层现在钉在**那个函数体内**（上面的 T112b 段），
		// 这里改为钉"同口径"这件事本身 —— 少了它，两处会各自漂移。
		if (!src.includes("wsSrc: connectionDownSource(),")) {
			throw new Error("源码契约：T95/T112b wsSrc 必须报出「只有探活命中」这一层（4）—— 见 connectionDownSource()");
		}
	}
	// ── WEB-05：抽屉接管接入横向滚动容器豁免 ──
	if (!src.includes("if (isInHorizontallyScrollableContainer(target)) return false;")) {
		throw new Error("源码契约：WEB-05 canStartDrawerTrack 必须接入横向可滚容器豁免");
	}
	// ── WEB-08：手势方向门，且必须早于 setDrawerVisual 接管 ──
	// 用户报告：手机主页面「从右往左滑」会点亮左侧抽屉而不是走官方右栏。
	// T130（Kimi 双抽屉）把方向门重写为「按抽屉态 + 位移方向定向」：
	//   右开态 dx<=0 → 整笔 no-op（E5 基线）；左开态任意横向 → 左抽屉跟手；
	//   双闭 dx>0 → 左抽屉；双闭 dx<0 → 右抽屉（canOpenRightCard 不可用则整笔 no-op）。
	// 左滑从分支结构上永远碰不到 setDrawerVisual ⇒ 点亮左抽屉在原理上不可能。
	{
		const fnStart = src.indexOf("function onDragMove(clientX, clientY, event) {");
		if (fnStart < 0) throw new Error("源码契约：找不到 onDragMove 函数");
		const fnEnd = src.indexOf("\n\t\tfunction ", fnStart);
		if (fnEnd < 0) throw new Error("源码契约：无法确定 onDragMove 函数体边界");
		const body = src
			.slice(fnStart, fnEnd)
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		// ① 定向序列必须都在「未 dragging」分支内，按
		//    「右开态 → 左开态 → 双闭右滑 → 双闭左滑」序，且全部早于 dragging = true。
		const notDragging = body.indexOf("if (!dragging) {");
		const rightNoop = body.indexOf("if (dx <= 0) {");
		const leftOpenArm = body.indexOf("} else if (isSidebarOpen()) {");
		const rightSwipeOpen = body.indexOf("} else if (dx > 0) {");
		const cardGate = body.indexOf("if (!canOpenRightCard()) {");
		const commitOpen = body.indexOf("if (!setRightbarOpen(true)) {");
		const dragStart = body.indexOf("dragging = true;");
		const takeOver = body.indexOf("if (axis === 'left') setDrawerVisual(baseX);");
		const rightTakeOver = body.indexOf("else setRightVisual(baseRx);");
		const pd = body.indexOf("event.preventDefault()");
		const links = [["if (!dragging)", notDragging], ["右开态左滑 no-op 门", rightNoop],
			["左开态武装", leftOpenArm], ["双闭右滑开左", rightSwipeOpen], ["右卡闸", cardGate],
			["右开兑现", commitOpen], ["dragging = true", dragStart], ["左抽屉接管", takeOver],
			["右抽屉接管", rightTakeOver], ["preventDefault", pd]];
		for (const [name, at] of links) {
			if (at < 0) throw new Error(`源码契约：T130 方向门缺环节（${name}）`);
		}
		if (!(notDragging < rightNoop && rightNoop < leftOpenArm && leftOpenArm < rightSwipeOpen
			&& rightSwipeOpen < cardGate && cardGate < commitOpen && commitOpen < dragStart)) {
			throw new Error("源码契约：T130 方向门必须按「右开态 → 左开态 → 双闭右滑 → 双闭左滑」序定向，且全部早于 dragging = true");
		}
		if (dragStart > takeOver || takeOver > pd) {
			throw new Error("源码契约：T130 接管顺序必须是 dragging = true → setDrawerVisual(baseX) → preventDefault（方向门之后才有任何接管与事件吞没）");
		}
		// ② 每个 no-op 出口都必须 resetTrack() 后立即 return（事件原样还给官方/浏览器）：
		//    纵向占优 / 右开态左滑 / 右卡不可用 / 右开兑现失败，共 4 处。
		const gateRegion = body.slice(notDragging, dragStart);
		const noopCount = (gateRegion.match(/resetTrack\(\);\s*\n\s*return;/g) || []).length;
		if (noopCount < 4) {
			throw new Error(`源码契约：T130 方向门 no-op 出口必须 resetTrack() 后立即 return（仅见 ${noopCount}/4）`);
		}
		// ③ 左滑在源码结构上不可能点亮左抽屉：方向门区域内不得出现 setDrawerVisual。
		if (gateRegion.includes("setDrawerVisual")) {
			throw new Error("源码契约：T130 方向门区域内不得出现 setDrawerVisual（左滑点亮左抽屉的根因）");
		}
	}
	// ── WEB-07：hook 幂等——脚本自带重复执行护栏，注入端按标记幂等 ──
	if (!src.includes("window.__dshRemoteMobileInstalled")) {
		throw new Error("源码契约：WEB-07 缺重复执行护栏 __dshRemoteMobileInstalled（壳内+edge 双注入会叠 hook）");
	}
	// ── T56：半装守卫竞态必须治本——守卫不得在第一行无条件置位 ──
	//
	// 根因（mobile-web.js 旧形态）：IIFE 第一行就 `window.__dshRemoteMobileInstalled = true`，
	// 而整份文件第一处写 DOM 的语句是 ~(document.head || document.documentElement).appendChild。
	// 原生在 onPageStarted（document-start）注入，此刻 documentElement 仍可为 null ⇒
	// 抛 appendChild of null，而守卫已置位 ⇒ 本文档此后每次注入都是空操作，hook 永远装不上。
	// 下面 4 条把「治本」的形态钉死：退回旧形态必须逐条变红。
	{
		// C1：入口必须是**具名函数表达式**——靠函数名在自身作用域内可见来实现「原地重入」，
		//    这样 4300 行正文一行不改、执行顺序完全不变（不重排、不缩进、不改语义）。
		const bootFn = src.match(/\(function ([A-Za-z_$][\w$]*)\(\)\s*\{\s*'use strict';/);
		if (!bootFn) {
			throw new Error("源码契约：T56 入口必须是具名函数表达式（document-start 挂起的重启要能原地重入同一份正文）");
		}
		// C2：正文入口处必须有 <html> 就绪闸门，且**守卫置位必须落在闸门之后**。
		//     旧形态是「第一行无条件置位」，这里显式禁止。
		const head = src.slice(0, src.indexOf("var ROOT_CLASS = 'dshr-mobile';"));
		const gateAt = head.indexOf("if (document.documentElement) {");
		const setAt = head.indexOf("window.__dshRemoteMobileInstalled = true;");
		if (gateAt < 0) {
			throw new Error("源码契约：T56 缺 documentElement 就绪闸门（document-start 注入会走到 appendChild of null）");
		}
		if (setAt < 0) {
			throw new Error("源码契约：T56 找不到守卫置位点");
		}
		if (setAt < gateAt) {
			throw new Error("源码契约：T56 守卫置位必须晚于 documentElement 就绪闸门（旧形态是 IIFE 第一行无条件置位，抛了就再也装不上）");
		}
		if (!/if \(window\.__dshRemoteMobileInstalled\) return;/.test(head)) {
			throw new Error("源码契约：T56 幂等闸①（已装上直接 return）缺失");
		}
		if (!/__dshRemoteMobilePending/.test(head)) {
			throw new Error("源码契约：T56 幂等闸②缺失：document-start 窗口内的重复注入会排第二份挂起重启");
		}
		// C3：重入必须真的发生——函数名要在文件里被调用一次，否则挂起后无人重启。
		const bootName = bootFn[1];
		const relaunchAt = src.indexOf(`${bootName}();`);
		if (relaunchAt < 0) {
			throw new Error(`源码契约：T56 就绪后必须重启同一个函数（找不到 ${bootName}() 的重入调用）`);
		}
		// C4：不再裸调 appendChild。旧形态那一行必须消失，否则闸门与它之间仍有
		//     「document 被整体换掉」的窄缝（正是本 bug 的成因类别）。
		if (src.includes("(document.head || document.documentElement).appendChild")) {
			throw new Error("源码契约：T56 不得再裸调 (document.head || document.documentElement).appendChild（必须先做能力检查）");
		}
		if (!src.includes("var mount = document.head || document.documentElement;") || !src.includes("if (!mount) return false;")) {
			throw new Error("源码契约：T56 样式挂载必须先做能力检查并在拿不到挂载点时延后重试");
		}
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
	// ── T135-A：手势关闭右栏的「交接窗」（data-dshr-rclosing）五条机制 ──
	//
	// 背景（真机 + 真页面逐帧实测）：官方右栏的收起/展开过渡在**面板内层**
	// `[data-dockkit-host|empty|divider]` 上（`transform: translateX(--dsh-sidebar-width)`
	// + `visibility: hidden` + `transition: transform .3s …, visibility 0s linear .3s`），
	// 而 hook 的卡片位移加在**面板**上且以官方 `data-sidebar-right-open` 为闸。
	// 手势关闭补间到 `--dshr-rx=max` 后兑现官方收起，官方属性一消失，卡片规则整条失效
	// ⇒ 面板瞬回屏内 x=0，官方内层随即从 tx=0 **可见地**滑到屏外 0.3s 才 hidden
	// ⇒ 用户看到「关完又弹回来再关上」。
	//
	// 下面每条契约都对应一个**行为断言**（scripts/fixtures/mobile-selftest.html 的
	// rdrawer-official-close-no-replay / -no-slide / rdrawer-handoff-window-parks-panel）；
	// 其中③（同一同步块内两条语句的顺序）没有行为判别力——浏览器不会在两条语句之间重算样式
	// ——只能靠源码契约钉住，所以这里必须在场。
	const windowCardSelector =
		"'html.' + ROOT_CLASS + '[data-dshr-rclosing=\"1\"] [data-sidebar-right-panel=\"fullscreen\"],'";
	const openCardSelector =
		"'html.' + ROOT_CLASS + ' [data-sidebar-right-panel=\"fullscreen\"][data-sidebar-right-open] {'";
	const windowCardAt = src.indexOf(windowCardSelector);
	const openCardAt = src.indexOf(openCardSelector);
	if (windowCardAt < 0 || openCardAt < 0 || windowCardAt > openCardAt || openCardAt - windowCardAt > 200) {
		throw new Error(
			"源码契约：右栏卡片规则必须同时命中 [data-dshr-rclosing=\"1\"]（交接窗内面板继续停在屏外），" +
				"否则官方收起落地后到 syncDom 撤窗之间面板会瞬回屏内",
		);
	}
	// ② 交接窗内压掉官方内层的收起过渡：三个 dockkit 节点 + transition:none 必须在同一条规则里。
	const dockHostSel =
		"'html.' + ROOT_CLASS + '[data-dshr-rclosing=\"1\"] [data-sidebar-right-panel=\"fullscreen\"] [data-dockkit-host],'";
	const dockHostAt = src.indexOf(dockHostSel);
	if (dockHostAt < 0) {
		throw new Error("源码契约：交接窗内缺少 dockkit 过渡压制规则（官方内层会可见地滑出 0.3s ⇒ 二次动画）");
	}
	const dockRule = src.slice(dockHostAt, dockHostAt + 600);
	if (
		!dockRule.includes("[data-dockkit-empty],") ||
		!dockRule.includes("[data-dockkit-divider] {") ||
		!/transition:\s*none\s*!important/.test(dockRule)
	) {
		throw new Error("源码契约：dockkit 过渡压制必须覆盖 host/empty/divider 三个节点且落到 transition:none !important");
	}
	// ③ syncDom 见到官方 closed：**先撤交接窗、再清 --dshr-rx**（顺序反了 ⇒ 面板带着 .34s
	// 过渡从屏外滑回；两条语句在同一同步块，行为断言测不到，只有源码契约能钉）。
	const rclosedBranchAt = src.indexOf("if (!rOpenNow) {");
	if (rclosedBranchAt < 0) {
		throw new Error("源码契约：找不到 syncDom 的右栏 closed 分支（if (!rOpenNow)）");
	}
	const rclosedBranch = src.slice(rclosedBranchAt, rclosedBranchAt + 600);
	const rcRemoveAt = rclosedBranch.indexOf("removeAttribute('data-dshr-rclosing')");
	const rcClearAt = rclosedBranch.indexOf("clearRightVisual(false)");
	if (rcRemoveAt < 0 || rcClearAt < 0 || rcRemoveAt > rcClearAt) {
		throw new Error("源码契约：syncDom 见到官方 closed 时必须先撤交接窗、再清 --dshr-rx（顺序反了面板会被 .34s 过渡拉回屏内）");
	}
	// ④ 置位点在 setRightbarOpen(false) 之前：交接窗必须在兑现官方收起**之前**就位，
	// 否则官方提交与撤窗会落在同一个样式重算之前，内层过渡照样跑。
	const settleCloseAt = src.indexOf("animateRightTo(state.max, function () {");
	if (settleCloseAt < 0) {
		throw new Error("源码契约：找不到 settleRight 的关闭补间回调");
	}
	const settleCloseBody = src.slice(settleCloseAt, settleCloseAt + 500);
	const settleWindowAt = settleCloseBody.indexOf("setAttribute('data-dshr-rclosing', '1')");
	const settleOpenAt = settleCloseBody.indexOf("setRightbarOpen(false)");
	if (settleWindowAt < 0 || settleOpenAt < 0 || settleWindowAt > settleOpenAt) {
		throw new Error("源码契约：手势关闭补间到位后必须先置位 data-dshr-rclosing，再 setRightbarOpen(false)");
	}
	// ⑤ 打开意图 / 看门狗放弃路径都要撤窗，否则面板永远停在屏外右（点不开）。
	const openIntentAt = src.indexOf("function setRightbarOpen(open) {");
	const openIntentBody = openIntentAt < 0 ? "" : src.slice(openIntentAt, openIntentAt + 400);
	if (!/if \(open\) document\.documentElement\.removeAttribute\('data-dshr-rclosing'\);/.test(openIntentBody)) {
		throw new Error("源码契约：打开意图（setRightbarOpen(true)）必须先撤交接窗，否则面板会停在屏外右不动");
	}
	// ⑤-b 看门狗「放弃这次意图」路径：撤窗必须在 clearRightVisual(false) 之前，
	// 否则面板会停在屏外右不动（用户手势关不掉也打不开）。
	const giveUpAt = src.indexOf("// 放弃：停在官方当前态");
	const giveUpEnd = giveUpAt < 0 ? -1 : src.indexOf("flushPendingRightbar();", giveUpAt);
	const giveUpBody = giveUpAt < 0 || giveUpEnd < 0 ? "" : src.slice(giveUpAt, giveUpEnd);
	const giveUpRemoveAt = giveUpBody.indexOf("removeAttribute('data-dshr-rclosing')");
	const giveUpClearAt = giveUpBody.indexOf("clearRightVisual(false)");
	if (giveUpRemoveAt < 0 || giveUpClearAt < 0 || giveUpRemoveAt > giveUpClearAt) {
		throw new Error("源码契约：看门狗放弃这次意图时必须先撤交接窗、再 clearRightVisual(false)");
	}
	// ⑤-c MutationObserver：右栏开合属性必须在 attributeFilter 里（否则右栏属性翻转要靠官方提交
	// 恰好带 childList 变更才能及时同步；漏一次 ⇒ busy 不解、看门狗补拍第二颗 toggle / 交接窗滞留）。
	// 锚在 `observer.observe(document.body, {` 上：页面里还有别的 MutationObserver
	//（inputModeWatcher 的 attributeFilter:['inputmode']），不能取第一个 attributeFilter。
	const mainObserverAt = src.indexOf("observer.observe(document.body, {");
	const filterAt = mainObserverAt < 0 ? -1 : src.indexOf("attributeFilter: [", mainObserverAt);
	if (filterAt < 0) {
		throw new Error("源码契约：找不到 MutationObserver 的 attributeFilter");
	}
	const filterBlock = src.slice(filterAt, src.indexOf("]", filterAt) + 1);
	for (const attr of [
		"data-sidebar-collapsed",
		"data-dshx-overlay",
		"data-rightbar-fullscreen",
		"data-sidebar-right-open",
		"aria-hidden",
		"data-ds-dark-theme",
		"role",
		"aria-modal",
		"aria-current",
		"data-state",
		"aria-expanded",
		"aria-label",
	]) {
		if (!filterBlock.includes(`'${attr}'`)) {
			throw new Error(`源码契约：MutationObserver 的 attributeFilter 缺少 ${attr}（右栏开合同步会退化成靠 childList 撞运气）`);
		}
	}
	// ── T135-B：浮层内「自动聚焦」的通行证 + IME 压制 ──
	//
	// 背景（真机 + 真页面实测）：官方「模型」子面板打开时会**自动聚焦它自己的搜索框**
	// `input[role=searchbox][aria-label="搜索模型…"]`；hook 的 focusin 守卫把它判成
	// 「非用户手势偷焦点」并 `el.blur()`，官方按「焦点离开浮层」dismiss ⇒ 菜单 + 刚渲染的
	// 模型列表整块卸载（实测 blur 后 1.6ms），用户「点一下就自己消失、模型永远选不到」。
	//
	// 修法 = 放行焦点但压住 IME：落点在已打开浮层内 ⇒ 开「浮层内手势」窗口；窗口内聚焦
	// 浮层内的可编辑元素 ⇒ **不 blur**，只打 inputmode="none" + data-dshr-imemute（记原值）；
	// 用户主动点输入框 / 拆卸痕迹 ⇒ 撤压制并逐字还原。
	// 对应的行为断言：scripts/fixtures/mobile-selftest.html 的
	// t135b-no-blur-in-float / t135b-ime-muted-in-float / t135b-release-restores-original /
	// t135b-outside-landing-not-passed（真页面口径见 scratch/t135/verify-B/model-guard.mjs）。
	const panelHelpers = ["function floatingLayerOf(node) {", "function isInsideOpenPanel(node) {", "function markPanelFocusIntent() {", "function inPanelFocusWindow(el) {", "function mutePanelIme(el) {", "function releasePanelIme() {"];
	for (const helper of panelHelpers) {
		if (!src.includes(helper)) {
			throw new Error(`源码契约（T135-B）：缺少 ${helper.slice(9, -3)}（浮层内通行证 / IME 压制链路断了）`);
		}
	}
	// ② 落点在已打开浮层内才开窗：markPanelFocusIntent 必须在 onDown 的**非可编辑**分支的
	//    isInsideOpenPanel 判真分支里（点 composer 的「+」/模型触发器不得开窗 ⇒ T48 §5 防护不变）。
	const onDownPanelAt = src.indexOf("if (isInsideOpenPanel(target)) markPanelFocusIntent();");
	if (onDownPanelAt < 0) {
		throw new Error("源码契约（T135-B）：onDown 的非可编辑分支缺少「落点在已打开浮层内 ⇒ markPanelFocusIntent()」");
	}
	const onDownBody = src.slice(Math.max(0, src.indexOf("var onDown = function (event) {")), onDownPanelAt);
	if (!/if \(!isEditablePoint\(target\)\) \{/.test(onDownBody)) {
		throw new Error("源码契约（T135-B）：markPanelFocusIntent 必须落在 onDown 的**非可编辑**分支内（否则点输入框也会开浮层窗口）");
	}
	// ③ 窗口内聚焦浮层内可编辑元素 ⇒ 只压 IME、不 blur：mutePanelIme 必须在
	//    inPanelFocusWindow(el) 判真的分支里，且该分支必须在 revokeStealthFocus 之前 return。
	const muteBranchAt = src.indexOf("if (inPanelFocusWindow(el)) {");
	if (muteBranchAt < 0) {
		throw new Error("源码契约（T135-B）：focusin 守卫缺少 inPanelFocusWindow(el) 分支（官方自动聚焦会被 blur ⇒ 浮层 dismiss）");
	}
	const muteBranch = src.slice(muteBranchAt, muteBranchAt + 220);
	if (!/mutePanelIme\(el\);[\s\S]{0,40}return;/.test(muteBranch)) {
		throw new Error("源码契约（T135-B）：inPanelFocusWindow 分支必须 mutePanelIme(el) 后立刻 return（不得落到 blur）");
	}
	const revokeAt = src.indexOf("revokeStealthFocus(el);", muteBranchAt);
	if (revokeAt < 0 || revokeAt < muteBranchAt) {
		throw new Error("源码契约（T135-B）：找不到 focusin 守卫的 revokeStealthFocus(el) 兜底");
	}
	// ④ 用户主动点输入框（onDown 的可编辑分支）与拆卸痕迹都必须 releasePanelIme()：
	//    少了前者 ⇒ inputmode=none 残留在搜索框上（点不弹键盘）；少了后者 ⇒ 平板档切换后留痕。
	const markUserIntentAt = src.indexOf("markUserFocusIntent(intentEls);");
	if (markUserIntentAt < 0) {
		throw new Error("源码契约（T135-B）：找不到 onDown 可编辑分支的 markUserFocusIntent(intentEls)");
	}
	if (!/markUserFocusIntent\(intentEls\);[\s\S]{0,400}?releasePanelIme\(\);/.test(src.slice(markUserIntentAt, markUserIntentAt + 500))) {
		throw new Error("源码契约（T135-B）：onDown 的可编辑分支必须 releasePanelIme()（用户主动点输入框要撤 IME 压制并还原）");
	}
	if (!/clearRightVisual\(false\);[\s\S]{0,200}?releasePanelIme\(\);/.test(src)) {
		throw new Error("源码契约（T135-B）：teardownHookTraces 必须 releasePanelIme()（零痕迹拆除要还原 inputmode）");
	}
	// ⑤ 窗口生命周期：clearUserFocusWindow 必须同生共死地清 panelFocusUntil，
	//    否则一次导航/可见性切换后浮层窗口还在（放行范围外溢）。
	const clearWindowAt = src.indexOf("function clearUserFocusWindow() {");
	const clearWindowBody = clearWindowAt < 0 ? "" : src.slice(clearWindowAt, clearWindowAt + 240);
	if (!/panelFocusUntil = 0;/.test(clearWindowBody)) {
		throw new Error("源码契约（T135-B）：clearUserFocusWindow 必须一并清 panelFocusUntil（窗口生命周期同生共死）");
	}
	// ⑥ IME 压制必须「记原值 + 撤时逐字还原」：mutePanelIme 写 data-dshr-imemute=原值，
	//    releasePanelIme 按空/非空分别 removeAttribute / setAttribute 原值。
	const muteFnAt = src.indexOf("function mutePanelIme(el) {");
	const releaseFnAt = src.indexOf("function releasePanelIme() {");
	const muteFn = muteFnAt < 0 ? "" : src.slice(muteFnAt, muteFnAt + 600);
	const releaseFn = releaseFnAt < 0 ? "" : src.slice(releaseFnAt, releaseFnAt + 600);
	if (!/getAttribute\(IME_MUTE_ATTR\) === null/.test(muteFn) || !/var prev = el\.getAttribute\('inputmode'\)/.test(muteFn) || !/setAttribute\(IME_MUTE_ATTR, prev === null \? '' : prev\)/.test(muteFn)) {
		throw new Error("源码契约（T135-B）：mutePanelIme 必须把 inputmode 原值记进 data-dshr-imemute 才能还原");
	}
	if (!/var prev = el\.getAttribute\(IME_MUTE_ATTR\)/.test(releaseFn) || !/if \(prev === ''\) el\.removeAttribute\('inputmode'\)/.test(releaseFn) || !/else el\.setAttribute\('inputmode', prev\)/.test(releaseFn) || !/el\.removeAttribute\(IME_MUTE_ATTR\)/.test(releaseFn)) {
		throw new Error("源码契约（T135-B）：releasePanelIme 必须按原值逐字还原（空值删属性、非空写回原值）并摘掉标记");
	}
	// ⑦ 两个谓词必须**语义上真的在场**，不能被改成恒 false / 恒 null（"函数还在、机制已废"）。
	const inPanelFn = src.indexOf("function inPanelFocusWindow(el) {");
	const inPanelBody = inPanelFn < 0 ? "" : src.slice(inPanelFn, inPanelFn + 400);
	const inPanelGuardAt = inPanelBody.indexOf("if (!panelFocusUntil || Date.now() > panelFocusUntil) return false;");
	const inPanelFirstFalse = inPanelBody.indexOf("return false;");
	if (
		inPanelGuardAt < 0 ||
		inPanelFirstFalse < inPanelGuardAt ||
		!/if \(!isElement\(el\) \|\| !isEditableFocus\(el\)\) return false;/.test(inPanelBody) ||
		!/return !!floatingLayerOf\(el\);/.test(inPanelBody)
	) {
		throw new Error("源码契约（T135-B）：inPanelFocusWindow 必须按「窗口未过期 + 可编辑焦点 + 落在浮层内」三条件判真（不得恒 false）");
	}
	const floatFnAt = src.indexOf("function floatingLayerOf(node) {");
	const floatBody = floatFnAt < 0 ? "" : src.slice(floatFnAt, floatFnAt + 520);
	const floatNullAt = floatBody.indexOf("return null;");
	const floatWhileAt = floatBody.indexOf("while (isElement(el)");
	if (
		floatWhileAt < 0 ||
		floatNullAt < 0 ||
		floatNullAt < floatWhileAt ||
		!/if \(isFloatingHost\(el\)\) return el;/.test(floatBody)
	) {
		throw new Error("源码契约（T135-B）：floatingLayerOf 必须沿祖先链找 isFloatingHost 宿主（不得恒 null）");
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
	// T56：hook 缺席页。fixture 自带一行 <script src=".../mobile.js">（那本身就是
	// 「late 注入」的样本），若用它测 document-start，页面里那份 late 注入会把
	// 断言喂饱——测的就不是「只有 document-start 一条路」了，断言没有牙齿。
	// 这里同源同内容、只摘掉那一行，于是页面上**唯一**的装上途径是本测试注入的那一条。
	if (url === NO_HOOK_FIXTURE) {
		const stripped = readFileSync(join(ROOT, ...FIXTURE.split("/").filter(Boolean)), "utf8").replace(
			/[ \t]*<script src="\/android\/app\/src\/main\/res\/raw\/mobile\.js"><\/script>\r?\n?/,
			"",
		);
		if (stripped.includes("/android/app/src/main/res/raw/mobile.js")) {
			res.writeHead(500).end("no-hook fixture strip failed");
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(stripped);
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

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const pageUrl = `http://127.0.0.1:${port}${FIXTURE}`;
const noHookUrl = `http://127.0.0.1:${port}${NO_HOOK_FIXTURE}`;
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
	//   f5 布防 1000ms 定时器把放行窗口一起关掉（T125，此前 500ms） ← 窗口生命周期（T50 §6.3 根因）
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
					// T76：把这一次落指补成一次**完整手势**（收尾一个 click）。
					//
					// 为什么必须补：只派发 pointerdown、既不 pointerup 也不 click，
					// 这条事件流任何真实输入管线都不会产生 —— 真机上一次点按是
					//     pointerdown → touchstart → pointerup → touchend → mousedown → mouseup → click
					// （顺序与实测见 scratch/t76/report.md 2.1 节；注意兼容 mousedown 在抬手之后）。
					// 而 T76 起 hook 用「手势是否收尾」区分新手势/同手势，收尾信号就是 click。
					// 不补 click ⇒ 本探针里 9 次 down 全被算成同一次手势的后续落指，
					// 于是 onDown 里的 clearUserFocusWindow() 不再触发，
					// 那条 focus-arm-window-closed-by-disarm-timer 会因为「窗口还活着」而红 ——
					// 而它要测的是「1000ms 定时器把窗口关掉」，与手势划分毫无关系。
					//
					// 这不是把断言放宽：补 click 后每一步都回到「一次 down = 一次新手势」，
					// f5 那一步照样先 clearUserFocusWindow()，断言测的仍然是
					// 「布防 1000ms 后窗口确实关着 ⇒ 程序化 focus 被收回」。
					// 基线 hook 与 T76 hook 都必须绿（两臂实测见 scratch/t76/report.md 5 节）。
					el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				}
				// T64：造一个「会打开命令面板的非可编辑触发器」。必须是 host 的**兄弟**
				// （放在工具条 row 上），与 f1 的理由相同：塞进输入区会被 isEditablePoint()
				// 判成可编辑落点，就走不到布防分支，测的就不是「选择器往返」了。
				function trigger2() {
					var h = mk('div', { 'data-composer-card': 'true', id: 't64-trg-card' });
					var c = mk('div', { 'data-composer-input': 'true', id: 't64-trg-wrap' }, h);
					c.textContent = 't64trg';
					var r = mk('div', { 'data-dshr-composer-row': 'true' }, h);
					var b = mk('button', { 'data-dshr-composer-model': 'true' }, r);
					b.textContent = 'M';
					return b;
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

				// f5：放行窗口的**生命周期**。布防后 1000ms（T125，此前 500ms）的摘防定时器必须把窗口一起关掉。
				//     取 1200ms 这个点：修复后窗口已关（程序化聚焦 composer 会被守卫收回）；
				//     若 disarm 不关窗口，窗口还活且仍以 composer 为目标 ⇒ 放行。
				down(trigger);
				out.reArmInputmode = composer.getAttribute('inputmode');
				neutral.focus();
				await sleep(1200);
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

				// ── T64：文件选择器往返（选完文件返回**不得**弹键盘）────────────────────
				//
				// 产品口径：只有「用户主动点输入框」才允许弹键盘；选完文件返回不是这种手势。
				// T58 在**发布包**上实测到「选择器返回、芯片出现 ⇒ mInputShown false→true」。
				// T64 在 rc.2.5 真机（debug 包 + CDP + dumpsys）复跑同一链路，
				// 终态 mInputShown=false、芯片正常出现 ⇒ 该跳已符合口径
				// （机制：选择器把页面切后台时 visibilitychange 收掉放行窗口与布防，
				//   见 bindFocusGuard 的 onVisibility；rc.2.5 已含 T51/T52 这两轮收口）。
				//
				// 这里把这条口径钉成**行为断言**，因为它一旦回退，肉眼要连点四层
				// （＋ → File → 系统选择器 → 选文件）才看得见，且极易被误读成"偶发"。
				//
				// f10：模拟一次真实的「选择器往返」—— 页面 hidden 再 visible。
				//      关键判据：回来之后官方那次 focus() **拿不到** inputmode=none 的保护，
				//      也**不在** 800ms 放行窗口内 ⇒ 必须被粘性抑制收回（焦点不落在 composer 上）。
				//      ⚠️ 必须用**没被 MutationObserver 盯上**的新树（同 f7 的理由）：
				//      否则观察者会在写属性的微任务里顺手把活干完，这条就成假牙。
				host3.remove();
				var host4 = mk('div', { 'data-composer-card': 'true', id: 't64-card' });
				var wrap4 = mk('div', { 'data-composer-input': 'true', id: 't64-wrap' }, host4);
				// ⚠️ class 是**承重**的，不是装饰：粘性抑制按 focusIdentity() 的**稳定签名**登记，
				// 而签名 = tag|role|contenteditable|稳定标记|前两个 class。f8/f9 的 ta1/ta2 是
				// 裸 textarea，签名同为 "textarea||||"。若 ta4 也不带 class，它会**继承**
				// f8/f9 留下的粘性抑制 ⇒ 基线探针永远拿不到焦点（假阴性），整条断言永远红。
				// 给一个独有的 class 让签名分离 —— 这也正是官方 composer「被重渲染换掉节点实例
				// 仍认得出来」的那套机制（mobile-web.js:1531 focusIdentity 注释）。
				var ta4 = mk('textarea', { id: 't64-ta', class: 't64field' }, wrap4);
				// ⚠️ 千万别对 wrap4 写 textContent：textContent 赋值会**清空所有子节点**，
				// ta4 会被当场摘出文档 ⇒ focus() 变成空操作 ⇒ f10/f11 判据全部失去意义
				// （第一版就踩了这个：f10 因为「焦点当然拿不到」而假绿，f11 因为同一个原因假红）。
				// 内容写在 ta4 自己身上，与 f8/f9 的 ta1/ta2 形态保持一致。
				ta4.value = 't64';
				out.f10WrapIsFirst = document.querySelector('[data-composer-input]') === wrap4;
				out.f10TaInDoc = document.getElementById('t64-ta') === ta4;
				// ⚠️ 这里**故意没有**「先无手势 focus() 一次当基线」这一步。
				// 守卫的设计就是：focusin 落在可编辑元素上、且不在用户放行窗口内 ⇒ 一律收回
				// （mobile-web.js:1694-1695）。所以「无手势的基线聚焦」在守卫活着时
				// **永远拿不到焦点**——第一版把它当前置，拿到的是假阴性（f10 永远红），
				// 而它证明不了任何事。真正的「这棵树可聚焦」证据是 f11：
				// 同一个元素、同一个时刻，**带手势**就能聚焦。两者构成双向差分。
				// 布防态起步：模拟「点 + 之后面板开着、composer 被打上 inputmode=none」。
				down(trigger2());
				out.f10ArmedInputmode = wrap4.getAttribute('inputmode');
				// 往返：hidden → visible（选择器就是这样一个原生 Activity）。
				setVis('hidden');
				document.dispatchEvent(new Event('visibilitychange'));
				out.f10AfterHideInputmode = wrap4.getAttribute('inputmode');
				setVis('visible');
				document.dispatchEvent(new Event('visibilitychange'));
				await sleep(60);
				out.f10AfterShowInputmode = wrap4.getAttribute('inputmode');
				// 官方在 change 之后抢焦点（这一步在真机上就是"键盘自动弹起"的来源）。
				ta4.focus();
				await sleep(40);
				out.f10OfficialFocusDenied = document.activeElement !== ta4;
				out.f10ActiveAfterReturn = document.activeElement ? document.activeElement.id : 'null';
				// f11：对照 —— 用户**真的**再点一次输入框，必须能拿到焦点（键盘才弹得出来）。
				//      这条是 f10 的反向牙齿：防止"为了不弹键盘把真点击也一起关掉"。
				//      走完整的 pointerdown 路径（onDown 里会 clearFocusSticky + 开放行窗口）。
				down(ta4);
				ta4.focus();
				await sleep(40);
				out.f11UserTapGetsFocus = document.activeElement === ta4;
				out.f11ActiveAfterUserTap = document.activeElement ? document.activeElement.id : 'null';
				setVis('visible');

				host4.remove();
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

	// ── T56：document-start 注入的行为级断言（半装守卫竞态）──
	//
	// 承重场景：原生在 onPageStarted 注入 mobile.js，那一刻 documentElement 可能还不存在。
	// 旧形态（守卫第一行无条件置位 + 裸调 appendChild）在这里必然抛
	// 「Cannot read properties of null (reading 'appendChild')」且**守卫已置位**，
	// 于是 hook 永远装不上 ⇒ 界面退回官方桌面布局、鲸鱼消失。
	//
	// 怎么把这一刻造出来：Page.addScriptToEvaluateOnNewDocument —— 它在**任何**页面脚本
	// 之前、新文档刚建好时执行，此刻 document.readyState === 'loading' 且
	// document.documentElement === null，正是 onPageStarted 的等价时序
	// （Android WebView 上这条命令不执行，T28 已实测过，所以这里用桌面 Chrome 做等价构造）。
	// 注入内容按原生 injectMobileAdaptation 的顺序：先写档位配置，再跑 mobile.js 本体。
	const docStartExceptions = [];
	ws.addEventListener("message", (event) => {
		let msg;
		try {
			msg = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (msg.method === "Runtime.exceptionThrown") {
			docStartExceptions.push(String(msg.params?.exceptionDetails?.exception?.description || "").slice(0, 200));
		} else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
			docStartExceptions.push("log[error] " + String(msg.params.entry.text).slice(0, 200));
		}
	});
	// 注入载荷：与原生一致——档位配置先行，然后 mobile.js 本体。
	// 取「单一源」那份（WEB-02 已断言它与 res/raw 字节级相同）。
	const hookSrc = readFileSync(join(ROOT, "packages/gateway/assets/mobile-web.js"), "utf8");
	const injectedPayload =
		"window.__DSHR_MOBILE__ = Object.assign(window.__DSHR_MOBILE__ || {}, { device: 'phone' });\n" + hookSrc;
	// 故意注册**两份**一模一样的 document-start 载荷：同一次导航里被注入两次，
	// 正是原生 onPageStarted + onPageCommitVisible 连着来的形态。
	// 它同时验证 Pending 去重——两次都撞上 documentElement=null 时只能排一份重启。
	const ids = [];
	for (let i = 0; i < 2; i++) {
		const added = await call("Page.addScriptToEvaluateOnNewDocument", { source: injectedPayload });
		ids.push(added && added.identifier);
	}
	await call("Runtime.enable");
	await call("Log.enable");
	await call("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 2,
		mobile: true,
		screenOrientation: { type: "portraitPrimary", angle: 0 },
	});
	await call("Page.navigate", { url: `${noHookUrl}?t56=docstart` });
	await wait(2500);
	// 兜住：若 hook 压根没装上，fixture 的 waitAndRun 会一直等 `__dshRemoteMobileInstalled`，
	// collectSelftest 就会抛「自测页未写出 window.__dshrSelftest」。
	// 那种情况**正是** T56 要抓的失败——必须变成一条命名的红断言并把后面几条继续跑完，
	// 而不是让整个 harness 抛异常中断（那样拿不到任何可读的判据）。
	const docStartProbe = await collectSelftest(call).catch((err) => ({
		ok: false,
		checks: [],
		error: String((err && err.message) || err),
	}));
	const docStartFacts = await call("Runtime.evaluate", {
		expression: `(function () {
			try {
				var root = document.documentElement;
				var whale = document.querySelector('[data-dshr-float]');
				var diag = null;
				try { diag = typeof window.__dshrMobileDiag === 'function' ? window.__dshrMobileDiag() : null; } catch (e) { diag = 'DIAG_THREW:' + e; }
				return JSON.stringify({
					readyState: document.readyState,
					rootClass: (root && root.className) || '',
					guard: window.__dshRemoteMobileInstalled === true,
					api: typeof window.__dshRemoteAndroidMobile,
					whale: !!whale,
					whaleVisible: whale ? getComputedStyle(whale).display !== 'none' : false,
					styleTag: !!document.querySelector('style[data-dshr-mobile-css]'),
					diagOk: !!diag && typeof diag === 'object',
					diag: diag
				});
			} catch (e) { return JSON.stringify({ evalThrew: String(e) }); }
		})()`,
		returnByValue: true,
	});
	const docStart = docStartFacts.result && docStartFacts.result.value ? JSON.parse(docStartFacts.result.value) : {};

	// 幂等性（硬要求①）：document-start 装上之后，**再**注入一次同一份本体，
	// 必须不产生第二份样式、也不重装（style 标签数仍为 1、__dshrMobileDiag 仍可调）。
	// 幂等性（硬要求①）：document-start 装上之后，**再**注入一次同一份本体，
	// 必须不产生第二份样式、也不重装（style 标签数仍为 1、__dshrMobileDiag 仍可调）。
	// 前置条件也钉上：若 document-start 根本没装上，这条会**假绿**
	// （styleTags=1 只是因为「一直只有 late 注入那一份」），所以要求 before 已是装上态。
	const beforeRepeat = docStart;
	await call("Runtime.evaluate", { expression: hookSrc, returnByValue: true });
	await wait(600);
	const repeatFacts = await call("Runtime.evaluate", {
		expression: `(function () {
			try {
				return JSON.stringify({
					styleTags: document.querySelectorAll('style[data-dshr-mobile-css]').length,
					api: typeof window.__dshRemoteAndroidMobile,
					whaleCount: document.querySelectorAll('[data-dshr-float]').length,
					diagOk: typeof window.__dshrMobileDiag === 'function'
				});
			} catch (e) { return JSON.stringify({ evalThrew: String(e) }); }
		})()`,
		returnByValue: true,
	});
	const repeat = repeatFacts.result && repeatFacts.result.value ? JSON.parse(repeatFacts.result.value) : {};

	// 第二条路径：late 注入（文档就绪后 evaluateJavascript，与原生
	// onPageCommitVisible / onPageFinished / onConfigurationChanged 同一条路）。
	const latePage = await (async () => {
		for (const id of ids) {
			if (id) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
		}
		await call("Page.navigate", { url: `${noHookUrl}?t56=late` });
		await wait(1800);
		const before = await call("Runtime.evaluate", {
			expression: `(function(){try{return JSON.stringify({guard:window.__dshRemoteMobileInstalled===true,api:typeof window.__dshRemoteAndroidMobile});}catch(e){return '{}';}})()`,
			returnByValue: true,
		});
		const b = before.result && before.result.value ? JSON.parse(before.result.value) : {};
		await call("Runtime.evaluate", { expression: injectedPayload, returnByValue: true });
		await wait(1200);
		const after = await call("Runtime.evaluate", {
			expression: `(function(){try{
				var root=document.documentElement;
				return JSON.stringify({guard:window.__dshRemoteMobileInstalled===true,api:typeof window.__dshRemoteAndroidMobile,rootClass:(root&&root.className)||'',whale:!!document.querySelector('[data-dshr-float]'),styleTag:!!document.querySelector('style[data-dshr-mobile-css]'),diagOk:typeof window.__dshrMobileDiag==='function'});
			}catch(e){return '{}';}})()`,
			returnByValue: true,
		});
		return { before: b, after: after.result && after.result.value ? JSON.parse(after.result.value) : {}, ids };
	})();

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
			? `reArm=${JSON.stringify(focusProbe.reArmInputmode)} im@1200ms=${JSON.stringify(focusProbe.inputmodeAfterTimer)} composerFocusedAfterTimer=${focusProbe.composerFocusAfterTimer}`
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

	// ── T64 断言组：文件选择器往返不得弹键盘（产品口径）──
	//
	// 承重行 f10：模拟「点 + → File → 系统选择器 → 选文件 → 返回」这一跳。
	//   选择器是原生 Activity，来回必然触发 visibilitychange；官方在 change 之后
	//   会把焦点抢回 composer —— 真机上那正是软键盘自动弹起的来源。
	//   判据是**焦点**：官方那次 focus() 拿不到焦点 ⇒ 不会有新的 showSoftInput。
	//   依赖的机制：onVisibility 在 hidden 时 clearUserFocusWindow() + disarmComposerFocus()，
	//   所以 800ms 放行窗口与 inputmode=none 布防都不会活过「离开页面」这段。
	//   ⇒ 把 onVisibility 的 hidden 分支删掉 ⇒ 窗口/布防残留 ⇒ f10 变红。
	//
	// ⚠️ 判据是**双向差分**，且 f10 显式依赖 f11：同一个元素 ta4、同一个页面状态下，
	//   「官方无手势抢焦点 ⇒ 被收回」而「用户带手势点 ⇒ 拿到焦点」。
	//   少了 f11 这半个，f10 会退化成「这个元素压根聚焦不了」的同义反复（第一版就踩了：
	//   用无手势 focus() 当基线，而守卫设计上就永远收回它 ⇒ 假阴性）。
	extraCheck(
		"t64-filechooser-return-no-keyboard",
		focusProbe
			&& focusProbe.f10WrapIsFirst === true
			&& focusProbe.f10TaInDoc === true
			// 前置（来自 f11）：证明 ta4 在同一时刻**带手势能聚焦** ⇒ f10 的「被收回」不是空话。
			&& focusProbe.f11UserTapGetsFocus === true
			&& focusProbe.f10ArmedInputmode === "none"
			&& focusProbe.f10AfterHideInputmode === null
			&& focusProbe.f10AfterShowInputmode === null
			&& focusProbe.f10OfficialFocusDenied === true,
		focusProbe
			? `taInDoc=${focusProbe.f10TaInDoc} 同元素带手势可聚焦=${focusProbe.f11UserTapGetsFocus} armed=${JSON.stringify(focusProbe.f10ArmedInputmode)} afterHide=${JSON.stringify(focusProbe.f10AfterHideInputmode)} afterShow=${JSON.stringify(focusProbe.f10AfterShowInputmode)} officialFocusDenied=${focusProbe.f10OfficialFocusDenied} active=${JSON.stringify(focusProbe.f10ActiveAfterReturn)}`
			: "no probe",
	);
	// 反向牙齿 f11：用户**主动点**输入框仍必须能拿到焦点（键盘才弹得出来）。
	//   防止"为了不弹键盘把真点击一起关掉"这种过度修复 —— 那会把 rc.2.5 已有的
	//   「用户点输入框能打字」（T58 §3.c）悄悄弄没。
	extraCheck(
		"t64-user-tap-input-still-focuses",
		focusProbe && focusProbe.f11UserTapGetsFocus === true,
		focusProbe
			? `userTapGetsFocus=${focusProbe.f11UserTapGetsFocus} active=${JSON.stringify(focusProbe.f11ActiveAfterUserTap)}`
			: "no probe",
	);

	// ── T56 断言组（document-start 注入）──
	// 顺序即证据链：先证明场景真的被造出来了（前置），再证明 hook 真的装上了，最后证明没抛。
	extraCheck(
		"t56-docstart-scene-is-real",
		docStart && docStart.readyState === "complete",
		`readyState=${docStart.readyState}（注入时为 loading/documentElement=null，断言在 load 后取）`,
	);
	extraCheck(
		"t56-docstart-no-exception",
		docStartExceptions.length === 0,
		`exceptions=${docStartExceptions.length} ${JSON.stringify(docStartExceptions.slice(0, 3))}`,
	);
	extraCheck(
		"t56-docstart-root-class",
		typeof docStart.rootClass === "string" && docStart.rootClass.indexOf("dshr-mobile") >= 0,
		`rootClass=${JSON.stringify(docStart.rootClass)}`,
	);
	extraCheck(
		"t56-docstart-whale",
		docStart.whale === true && docStart.whaleVisible === true,
		`whale=${docStart.whale} visible=${docStart.whaleVisible}`,
	);
	extraCheck(
		"t56-docstart-style-mounted",
		docStart.styleTag === true,
		`styleTag=${docStart.styleTag}`,
	);
	extraCheck(
		"t56-docstart-api-exported",
		docStart.api === "object",
		`typeof __dshRemoteAndroidMobile=${docStart.api}`,
	);
	extraCheck(
		"t56-docstart-diag-callable",
		docStart.diagOk === true,
		`__dshrMobileDiag()=${JSON.stringify(docStart.diag).slice(0, 220)}`,
	);
	// 幂等性（硬要求①）：document-start 装上后重复注入同一份本体，不得叠第二份。
	extraCheck(
		"t56-idempotent-after-docstart",
		beforeRepeat && beforeRepeat.api === "object" && beforeRepeat.styleTag === true
			&& repeat.styleTags === 1 && repeat.api === "object" && repeat.diagOk === true,
		`beforeInstalled=${!!(beforeRepeat && beforeRepeat.api === "object")} styleTags=${repeat.styleTags} whaleCount=${repeat.whaleCount} api=${repeat.api} diagOk=${repeat.diagOk} (before rootClass=${JSON.stringify(beforeRepeat.rootClass)})`,
	);
	// 第二条路径：late 注入也必须装得上（硬要求②）。
	extraCheck(
		"t56-late-path-installs",
		latePage.before.guard === false
			&& latePage.after.guard === true
			&& latePage.after.api === "object"
			&& typeof latePage.after.rootClass === "string"
			&& latePage.after.rootClass.indexOf("dshr-mobile") >= 0
			&& latePage.after.whale === true
			&& latePage.after.styleTag === true
			&& latePage.after.diagOk === true,
		`before=${JSON.stringify(latePage.before)} after=${JSON.stringify(latePage.after)}`,
	);
	// 行为级：fixture 自测在 document-start 注入下也全绿（版面能力未因推迟启动而丢）。
	extraCheck(
		"t56-docstart-selftest-green",
		docStartProbe && docStartProbe.ok === true,
		docStartProbe
			? docStartProbe.error
				? `自测页没写出结果：${docStartProbe.error}（hook 很可能压根没装上）`
				: `ok=${docStartProbe.ok} checks=${(docStartProbe.checks || []).filter((c) => !c.ok).length} 项红: ${JSON.stringify((docStartProbe.checks || []).filter((c) => !c.ok).map((c) => c.name).slice(0, 6))}`
			: "no report",
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
