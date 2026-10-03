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
		if (!body.includes("if (Date.now() <= userFocusWindowUntil) return;")) {
			throw new Error("源码契约：focusin 守卫必须放行「用户主动聚焦」窗口内的聚焦（否则用户点输入框会被收回）");
		}
		if (!body.includes("revokeStealthFocus(el)")) {
			throw new Error("源码契约：focusin 守卫必须在窗口外调用 revokeStealthFocus(el)");
		}
	}
	if (!src.includes("var FOCUS_REVOKE_MAX") || !/focusRevokeCount > FOCUS_REVOKE_MAX/.test(src)) {
		throw new Error("源码契约：焦点守卫必须有防打环上限（不得无限 blur）");
	}
	if (!src.includes("function focusGuardActive()") || !/!isStrictOff\(\) && !!hookOn/.test(src)) {
		throw new Error("源码契约：焦点守卫只能在 hook 生效档位动作（平板档严格 OFF / 手机横屏不得介入）");
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
	const androidReport = await collectSelftest(call);

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
