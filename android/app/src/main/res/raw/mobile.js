/**
 * DSH Remote —— 移动端页面适配脚本（WEB-02 单一源）。
 *
 * 本文件是移动适配的唯一源，两条分发路径共用同一份代码：
 *   - edge 网关：<script src="/__dsh_remote__/mobile.js"> 注入上游 HTML
 *     （packages/gateway/assets/mobile-web.js 直接下发）；
 *   - Android 壳：App 在页面加载完成后注入——android/build.ps1 在 aapt 打包前
 *     自动把本文件拷贝覆盖 app/src/main/res/raw/mobile.js，禁止手改 res/raw 副本。
 *
 * 平台差异全部运行时探测（不维护两份代码）：
 *   - 激活条件：Android 壳（UA 含 DSHRemoteAndroid/）沿用安卓端行为——仅竖屏
 *     启用，壳内不看宽度断点（部分机型 layout viewport 虚高），横屏交给官方
 *     DSH 桌面布局；浏览器（edge 注入）沿用 web 行为——只看视口宽度 ≤ 断点，
 *     iPhone 全程 hook，iPad 横屏（≥断点）自然回到官方布局；
 *   - 断点：一律优先读注入变量 window.__DSHR_MOBILE__.breakpoint（edge 网关下发），
 *     缺省按平台回落：Android 壳 1024（安卓端旧缺省）、浏览器 980（web 旧缺省）；
 *   - IME：壳内走原生平移 + interactive-widget=overlays-content，非壳 PWA 走
 *     resizes-content + visualViewport 兜底（isAndroidShell() 判定，原有逻辑）。
 * 其余适配逻辑两端完全一致；原生桥调用在非壳环境本就安全短路
 * （isAndroidShell() 为 false），无需分支。
 *
 * 设计目标：不依赖服务器端是否安装 dsh-remote-plugin。手机连接任何官方 DSH Web
 * （装或不装插件）都由本脚本完成移动适配：
 *   1. 按上述平台规则启用 hook；宽视口/横屏（按平台）去掉适配类，走官方 DSH
 *      桌面布局
 *   2. 桌面端收起后的 56px rail 压到 0，用左上角悬浮鲸鱼打开侧栏
 *      （不把官方按钮拖到顶栏，避免官方 Harness 布局在窄屏错位）；
 *   3. 用户直接点击官方按钮产生可信事件；展开侧栏时采用 DeepSeek App 式
 *      「侧栏在下、会话栏圆角浮层滑开」：中间列可跟手拖动，松手后吸附开/关；
 *      点浮层右侧细条/主会话窗口/遮罩关闭；长按鲸鱼 = 打开 App 连接设置
 *      （优先 DshRemoteApp.openSettings，避免写入 WebView 历史）；
 *      平板竖屏侧栏只划出约 1/3 宽，主会话窗口仍大块可见，不得铺满全屏；
 *   4. 设置弹窗改为全屏页：从设置入口盖住整屏（含侧栏浮层），不再先收起
 *      侧栏再弹设置，避免「闪回会话再打开」的卡顿；
 *   5. 顶部/底部系统栏避让：App 原生把状态栏/导航栏 inset 写入
 *      --dshr-inset-top / --dshr-inset-bottom，页面内容下移让出状态栏，
 *      状态栏透明后颜色与页面背景一致（沉浸模式）；虚拟键盘弹出时，
 *      Android 壳只由原生平移抬起（不改 WebView 高度，避免居中重排
 *      和字体抖动；interactive-widget=overlays-content）；平移量按焦点
 *      输入框位置计算，元素少时不得把输入框顶出屏幕；非壳 PWA 仍用
 *      resizes-content + visualViewport.resize 兜底；
 *   6. 会话头部适配：收起态下会话标题行/页签整体右移，不再被左上角
 *      鲸鱼按钮遮挡；官方「Session log」下载按钮在手机上收成纯图标
 *      （文字剪裁保留给读屏）；
 *   7. 窄屏会话条：只收缩已标记的回复操作行、输入底栏和底部统计；
 *      耗时与统计保持单行。误标父节点时不得裁掉消息正文；
 *   8. 手机宽度下主屏幕右划打开侧栏（会话栏滑成圆角浮层）；点侧栏里的
 *      会话后自动收起，直接露出对话，不必再点遮罩或鲸鱼；
 *   9. 模型 / 权限 / 命令 / 模式等浮动选框（menu、listbox）钳在视口内，
 *      不再向左或向右超出屏幕，过高时内部滚动。
 *  10. 与 dsh-explorer 共存：检测到 frame[data-dshx-overlay] 时让出第三列，
 *      不再把 grid 钉成 0|1fr|0 或把 details 整列 display:none，避免白屏。
 *  11. 深浅色：表面色走 --dsw-alias-bg-base；同步 body[data-ds-dark-theme]
 *      给原生状态栏。WebView 用 DayNight 让「跟随系统」吃到 prefers-color-scheme。
 *  12. 前台通知：探测「停止生成」即智能体正在跑，把会话标题和当前用户
 *      内容交给 DshRemoteApp.setSessionNotice；空闲则 running=false，
 *      原生改走静默渠道，不再展示本机端口直通文案。
 *  13. 底部导航栏避让：会话列（含 Explorer 替换模式的第三列）让出
 *      --dshr-inset-bottom，输入卡底栏与底部统计不被系统手势条/三键导航压住。
 *  14. 键盘抬起按整块输入区：焦点在官方输入卡内时报 [data-composer-seat]
 *      （文本框 + 四键底栏 + 统计）的矩形，而不是只报文本框——否则原生
 *      恰好抬到「文本框底边高于键盘」，底栏与统计仍被键盘盖住。
 *  15. 官方右侧栏（0.1.3+ 文件树/文档预览，[data-sidebar-right-panel]）全屏态
 *      是 position:fixed;inset:0，绝对定位不吃 frame 的 padding：由面板自己
 *      垫出 --dshr-inset-top/-bottom，标题行不再顶进状态栏、底部不压导航栏；
 *      全屏时同时收起悬浮鲸鱼/遮罩/拖动手柄。
 *  16. 会话头部收敛：官方 Agent Team 动作（[data-team-action]）只加标记，
 *      用 CSS 定位到页签行右侧（不搬 React 节点）；后台任务触发器
 *      （aria-label =「N 个后台任务运行中」）只保留状态点 + 数量，数量写进
 *      data-dshr-job-n 由 ::after 渲染，原句文本与下拉箭头隐藏。
 *
 * 健壮性约定（本版本重点加固）：
 *   - 官方 DOM 结构探测带多级回退（overlay 父节点 → 侧栏开关按钮祖先链 →
 *     data-sidebar-collapsed 标记），不同构建的官方 DSH 都能定位 frame；
 *   - frame 一时找不到时，body 兜底 padding 保证内容永不顶进状态栏；
 *   - 注入时机可能早于 React 首帧：启动后有界重试 + MutationObserver 持续同步；
 *   - 脚本幂等（__dshRemoteMobileInstalled），App 会在多个生命周期事件重复注入。
 *
 * 实现约束：只使用官方 DOM 的稳定结构特征（aria-label、role="dialog"、
 * data-sidebar-collapsed 等），不依赖 CSS Module 哈希类名；官方开关按钮只加
 * 标记属性与样式覆盖，不离开原 React 树，body 仅承载后备鲸鱼和透明遮罩。
 */
(function () {
	'use strict';
	if (window.__dshRemoteMobileInstalled) return;
	window.__dshRemoteMobileInstalled = true;

	var ROOT_CLASS = 'dshr-mobile';

	function isAndroidShell() {
		try {
			return /DSHRemoteAndroid\//.test(String(navigator.userAgent || ''));
		} catch (ignoredUa) {
			return false;
		}
	}

	// 官方 FishLogo 矢量（与 DSH 侧栏品牌标记同源，viewBox 0 0 23.16 17.04，
	// fill 用 currentColor 自动适配深浅色主题）。
	var WHALE_SVG =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23.16 17.04" fill="none" aria-hidden="true">' +
		'<path fill="currentColor" d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"/>' +
		'</svg>';

	var MOBILE_CSS = [
		// ── 系统栏避让 ──
		// 首选：官方 frame 下移让出状态栏；状态栏透明后露出 frame 背景（沉浸一致）。
		'html.' + ROOT_CLASS + ' {',
		'  --dshr-drawer-peek: 52px;',
		'  --dshr-drawer-width: calc(100% - 52px);',
		'  --dshr-ime: 0px;',
		'  color-scheme: light dark;',
		'  -webkit-text-size-adjust: 100%;',
		'  text-size-adjust: 100%;',
		'}',
		// 表面色必须走官方会随深浅切换的 token。`--dsw-specific-background` 在
		// DSH 里经常不存在，写成它的 fallback 会把设置页钉死成白底，深色字就看不见。
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"] { color-scheme: dark; }',
		'html.' + ROOT_CLASS + '[data-dshr-dark="0"] { color-scheme: light; }',
		// 官方横屏：不要给整个 frame 垫一层白顶（会跟灰色侧栏错色）。
		// 列自己 padding-top，背景画进 padding，状态栏后面左右颜色才能接上。
		'html.dshr-official-inset {',
		'  background: transparent;',
		'}',
		'html.dshr-official-inset [data-dshr-frame] {',
		'  padding-top: 0 !important;',
		'}',
		'html.dshr-official-inset [data-dshr-sidebar-col] {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'}',
		'html.dshr-official-inset [data-dshr-main-col],',
		'html.dshr-official-inset [data-dshx-details-col] {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'}',
		'html.dshr-official-inset[data-dshr-dark="1"] [data-dshr-sidebar-col] {',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #1b1b1f)) !important;',
		'}',
		'html.dshr-official-inset[data-dshr-dark="1"] [data-dshr-main-col],',
		'html.dshr-official-inset[data-dshr-dark="1"] [data-dshx-details-col] {',
		'  background: var(--dsw-alias-bg-base, #111318) !important;',
		'}',
		'html.dshr-official-inset:not([data-dshr-ready="1"]) body {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'}',
		'#dshr-status-guard {',
		'  display: none;',
		'  position: fixed;',
		'  top: 0;',
		'  left: 0;',
		'  right: 0;',
		'  height: var(--dshr-inset-top, env(safe-area-inset-top, 0px));',
		'  z-index: 2147483000;',
		'  pointer-events: auto;',
		'  touch-action: none;',
		'  background: transparent;',
		'}',
		'html.dshr-official-inset #dshr-status-guard,',
		'html.' + ROOT_CLASS + ' #dshr-status-guard { display: block; }',
		// 平板竖屏：侧栏固定约 1/3 宽，主会话窗口留出可点/可滑的大块区域。
		'html.' + ROOT_CLASS + '[data-dshr-tablet="1"] {',
		'  --dshr-drawer-width: clamp(280px, 32vw, 380px);',
		'  --dshr-drawer-peek: calc(100vw - var(--dshr-drawer-width));',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-ime="1"],',
		'html.' + ROOT_CLASS + '[data-dshr-ime="1"] body {',
		'  height: var(--dshr-vv-height, 100%) !important;',
		'  max-height: var(--dshr-vv-height, 100%) !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-ime="1"] [data-dshr-frame] {',
		'  height: var(--dshr-vv-height, 100%) !important;',
		'  max-height: var(--dshr-vv-height, 100%) !important;',
		'  min-height: 0 !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-frame] {',
		'  box-sizing: border-box;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px));',
		'  grid-template-columns: 0px minmax(0, 1fr) 0px !important;',
		'  overflow: hidden;',
		'}',
		// ── 底部系统导航栏避让（edge-to-edge 沉浸）──
		// 原生把导航栏高度写成 --dshr-inset-bottom；会话列整体让出这一条，
		// 输入卡底栏（+ / 权限 / 模型 / 发送）与底部统计不再被手势条或三键导航压住。
		// 主栏背景本就画进 padding，让位后不会出现异色空条。
		'html.' + ROOT_CLASS + ' [data-dshr-main-col] {',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'}',
		// Explorer 替换模式（第三列让给审查面板）同样让出导航栏。
		'html.' + ROOT_CLASS + ' [data-dshx-details-col] {',
		'  box-sizing: border-box !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'}',
		// ── 官方右侧栏（文件树 / 文档预览）──
		// [data-sidebar-right-panel=fullscreen] 是 position:fixed;inset:0（绝对定位不吃
		// frame 的 padding），面板标题行会直接顶到状态栏上、底部压住导航栏。
		// 面板自己垫出两侧系统栏高度：背景画进 padding，状态栏后面颜色一致。
		// push（停靠）态不垫——那一列在 frame 的 padding 之内，垫了反而多一条空白。
		'html.' + ROOT_CLASS + ' [data-sidebar-right-panel="fullscreen"],',
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] [data-sidebar-right-panel] {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"] [data-sidebar-right-panel] {',
		'  background: var(--dsw-alias-bg-base, #111318) !important;',
		'}',
		// 右侧栏全屏时收起悬浮鲸鱼 / 抽屉遮罩 / 拖动手柄，别压在面板上。
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] #dshr-mobile-whale,',
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] #dshr-mobile-drawer-mask,',
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] #dshr-drawer-handle {',
		'  display: none !important;',
		'}',
		// 兜底：结构探测暂时失败（frame 未标记）时，body 自身让出状态栏，
		// 保证任何官方构建下内容都不会顶进时钟/挖孔区域。
		'html.' + ROOT_CLASS + ':not([data-dshr-ready="1"]) body {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'}',
		// 只藏拖动手柄，不要误伤侧栏列 / Explorer details 列（列本身也可能带 data-side）。
		'html.' + ROOT_CLASS + ' [data-dshr-frame] [data-side="sidebar"]:not([data-dshr-sidebar-col]),',
		'html.' + ROOT_CLASS + ' [data-dshr-frame] [data-side="details"]:not([data-dshx-details-col]) { display: none !important; }',
		// dsh-explorer 窄屏替换模式：把第三列让给审查面板，否则中间列被 Explorer 藏、
		// details 又被上面钉成 0 宽，整页只剩底色（白屏）。
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] [data-dshr-frame] {',
		'  grid-template-columns: 0px 0px minmax(0, 1fr) !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] [data-dshr-main-col],',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] [data-dshr-sidebar-col],',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] #dshr-mobile-whale,',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] #dshr-mobile-drawer-mask {',
		'  display: none !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] [data-dshx-details-col] {',
		'  display: flex !important;',
		'  flex-direction: column !important;',
		'  grid-column: 3 !important;',
		'  width: 100% !important;',
		'  height: 100% !important;',
		'  min-width: 0 !important;',
		'  max-width: none !important;',
		'  visibility: visible !important;',
		'  pointer-events: auto !important;',
		'  overflow: hidden !important;',
		'  position: relative !important;',
		'  transform: none !important;',
		'  z-index: 40 !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] [data-dshx-details-col] .dshx-root {',
		'  display: flex !important;',
		'  flex-direction: column !important;',
		'  width: 100% !important;',
		'  height: 100% !important;',
		'  min-height: 0 !important;',
		'}',
		// 收起态：56px rail 压到 0，但保留 overflow，让官方 React 开关按钮本体
		// 能固定到左上角；列本身 visibility:hidden，只有被标记的按钮恢复可见。
		'html.' + ROOT_CLASS + ' [data-dshr-frame][data-sidebar-collapsed] [data-dshr-sidebar-col] {',
		'  width: 0 !important;',
		'  min-width: 0 !important;',
		'  max-width: 0 !important;',
		'  border-right: 0 !important;',
		'  overflow: hidden !important;',
		'  pointer-events: none !important;',
		'  visibility: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-frame][data-sidebar-collapsed] [data-dshr-sidebar-col] > * {',
		'  overflow: hidden !important;',
		'}',
		// 收起态隐藏官方开关，改由悬浮鲸鱼接管，避免官方按钮与会话标题叠在一起。
		'html.' + ROOT_CLASS + ' [data-dshr-frame][data-sidebar-collapsed] [data-dshr-official-toggle] {',
		'  display: none !important;',
		'}',
		// 设置等模态框可能渲染在侧栏列子树里。列继续隐藏，单独给已标记的
		// fixed overlay 恢复 visibility/pointer-events，避免同时露出 56px rail。
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] [data-dshr-frame][data-sidebar-collapsed] [data-dshr-sidebar-col] {',
		'  pointer-events: auto !important;',
		'  visibility: hidden !important;',
		'}',
		// 展开态：DeepSeek App 式 —— 侧栏铺在底层，中间会话列滑成圆角浮层。
		// grid 列仍为 0（不挤压），侧栏 absolute 铺满左侧；主列 translate 右移。
		'html.' + ROOT_CLASS + ' [data-dshr-frame]:not([data-sidebar-collapsed]) {',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-frame]:not([data-sidebar-collapsed]) [data-dshr-sidebar-col] {',
		'  display: block !important;',
		'  position: absolute !important;',
		'  grid-column: 1 !important;',
		'  top: 0 !important;',
		'  left: 0 !important;',
		'  bottom: 0 !important;',
		'  width: var(--dshr-drawer-width) !important;',
		'  min-width: 0 !important;',
		'  max-width: none !important;',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'  visibility: visible !important;',
		'  opacity: 1 !important;',
		'  overflow: hidden !important;',
		'  pointer-events: auto !important;',
		'  transform: none !important;',
		'  z-index: 10 !important;',
		'  border-right: 0 !important;',
		'  box-shadow: none !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-frame]:not([data-sidebar-collapsed]) [data-dshr-sidebar-col] > * {',
		'  width: 100% !important;',
		'  max-width: none !important;',
		'  height: 100% !important;',
		'  box-sizing: border-box !important;',
		'  visibility: visible !important;',
		'  opacity: 1 !important;',
		'  overflow: hidden !important;',
		'  pointer-events: auto !important;',
		'}',
		// 中间会话列：收起贴合全宽；展开后右移成圆角卡片浮于侧栏之上。
		// 侧栏 absolute 后会脱离 grid 流，主栏若无 grid-column 会掉进 0px 的第一列，
		// 导致 translateX 的 100% 变成 0、整卡挪到 -peek。必须钉在第 2 列。
		// 勿在 translate 多参数里写 var(--x, fallback)，逗号会拆坏函数解析。
		'html.' + ROOT_CLASS + ' [data-dshr-main-col] {',
		'  position: relative !important;',
		'  grid-column: 2 !important;',
		'  z-index: 20 !important;',
		'  min-width: 0 !important;',
		'  width: auto !important;',
		'  box-sizing: border-box !important;',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'  border-radius: 0;',
		'  box-shadow: none;',
		'  transform: translateX(0);',
		'  margin-top: 0;',
		'  margin-bottom: 0;',
		'  touch-action: pan-y;',
		'  transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1),',
		'    border-radius 0.34s cubic-bezier(0.32, 0.72, 0, 1),',
		'    box-shadow 0.34s ease,',
		'    margin 0.34s cubic-bezier(0.32, 0.72, 0, 1);',
		'  will-change: transform;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-frame]:not([data-sidebar-collapsed]) [data-dshr-main-col] {',
		'  transform: translateX(var(--dshr-drawer-width)) !important;',
		'  border-radius: 18px !important;',
		'  box-shadow: -14px 0 36px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04) !important;',
		'  overflow: hidden !important;',
		'  margin-top: 8px !important;',
		'  margin-bottom: 8px !important;',
		'  max-height: calc(100% - 16px) !important;',
		'}',
		'@media (prefers-reduced-motion: reduce) {',
		'  html.' + ROOT_CLASS + ' [data-dshr-main-col] { transition: none !important; }',
		'}',
		// 跟手拖动：用 --dshr-drawer-x / --dshr-drawer-p 驱动，关掉过渡。
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-frame] {',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-sidebar-col],',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-frame][data-sidebar-collapsed] [data-dshr-sidebar-col] {',
		'  display: block !important;',
		'  position: absolute !important;',
		'  grid-column: 1 !important;',
		'  top: 0 !important;',
		'  left: 0 !important;',
		'  bottom: 0 !important;',
		'  width: var(--dshr-drawer-width) !important;',
		'  min-width: 0 !important;',
		'  max-width: none !important;',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'  visibility: visible !important;',
		'  opacity: 1 !important;',
		'  overflow: hidden !important;',
		'  pointer-events: none !important;',
		'  transform: none !important;',
		'  z-index: 10 !important;',
		'  border-right: 0 !important;',
		'  box-shadow: none !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-sidebar-col] > * {',
		'  width: 100% !important;',
		'  height: 100% !important;',
		'  visibility: visible !important;',
		'  opacity: 1 !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-frame] [data-dshr-main-col] {',
		'  transition: none !important;',
		'  transform: translateX(var(--dshr-drawer-x, 0px)) !important;',
		'  border-radius: calc(18px * var(--dshr-drawer-p, 0)) !important;',
		'  box-shadow: -14px 0 36px rgba(0, 0, 0, calc(0.18 * var(--dshr-drawer-p, 0))),',
		'    0 0 0 1px rgba(0, 0, 0, calc(0.04 * var(--dshr-drawer-p, 0))) !important;',
		'  margin-top: calc(8px * var(--dshr-drawer-p, 0)) !important;',
		'  margin-bottom: calc(8px * var(--dshr-drawer-p, 0)) !important;',
		'  max-height: calc(100% - (16px * var(--dshr-drawer-p, 0))) !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] #dshr-mobile-whale { display: none !important; }',
		// 侧栏展开时主会话浮层整卡可跟手拖；禁止浏览器把左滑吃成滚动。
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] [data-dshr-main-col],',
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] #dshr-mobile-drawer-mask {',
		'  touch-action: none;',
		'}',
		// 设置打开：全屏盖住侧栏/会话浮层。设置弹层在侧栏子树里时会被
		// 主栏 z-index:20 的层叠上下文压住，必须把主栏降下去、侧栏抬上来。
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] #dshr-mobile-whale,',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] #dshr-mobile-drawer-mask { display: none !important; }',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] [data-dshr-main-col] {',
		'  visibility: hidden !important;',
		'  pointer-events: none !important;',
		'  z-index: 0 !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] [data-dshr-sidebar-col],',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] [data-dshr-frame][data-sidebar-collapsed] [data-dshr-sidebar-col] {',
		'  z-index: 1300 !important;',
		'  overflow: visible !important;',
		'  width: 100% !important;',
		'  min-width: 0 !important;',
		'  max-width: none !important;',
		'  visibility: visible !important;',
		'  pointer-events: auto !important;',
		'}',
		// ── 悬浮鲸鱼 + 浮层右侧细条遮罩（点按关闭侧栏） ──
		'#dshr-mobile-whale {',
		'  display: none;',
		'  position: fixed;',
		'  top: calc(var(--dshr-inset-top, env(safe-area-inset-top, 0px)) + 5px);',
		'  left: 10px;',
		'  width: 48px;',
		'  height: 48px;',
		'  padding: 9px;',
		'  border: 0;',
		'  border-radius: 10px;',
		'  background: transparent;',
		'  color: var(--dsw-alias-label-primary, #1b1b1f);',
		'  z-index: 900;',
		'  cursor: pointer;',
		'  -webkit-tap-highlight-color: transparent;',
		'}',
		'#dshr-mobile-whale svg { display: block; width: 27px; height: 20px; }',
		'html.' + ROOT_CLASS + '[data-dshr-ready="1"][data-dshr-expanded="0"] #dshr-mobile-whale { display: block; }',
		'#dshr-mobile-drawer-mask {',
		'  display: none;',
		'  position: fixed;',
		'  top: var(--dshr-inset-top, env(safe-area-inset-top, 0px));',
		'  right: 0;',
		'  left: auto;',
		'  bottom: 0;',
		'  width: var(--dshr-drawer-peek);',
		'  z-index: 30;',
		'  border: 0;',
		'  padding: 0;',
		'  background: transparent;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] #dshr-mobile-drawer-mask { display: block; }',
		// ── MD3 抽屉 drag handle：4×32dp 圆头指示条，钉在抽屉与会话浮层交界 ──
		// 纯视觉指示（pointer-events:none，拖动手势由整个会话浮层接管），
		// 仅手机/平板竖屏抽屉展开时可见；跟手拖动、设置全屏、Explorer 替换
		// 模式下隐藏。颜色走官方 label token 自动适配深浅主题。
		'#dshr-drawer-handle {',
		'  display: none;',
		'  position: fixed;',
		'  top: 50%;',
		'  left: var(--dshr-drawer-width);',
		'  transform: translate(-50%, -50%);',
		'  width: 4px;',
		'  height: 32px;',
		'  border-radius: 2px;',
		'  background: var(--dsw-alias-label-primary, #1b1b1f);',
		'  opacity: 0.35;',
		'  z-index: 35;',
		'  pointer-events: none;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] #dshr-drawer-handle { display: block; }',
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] #dshr-drawer-handle,',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] #dshr-drawer-handle,',
		'html.' + ROOT_CLASS + '[data-dshr-explorer-details="1"] #dshr-drawer-handle {',
		'  display: none !important;',
		'}',
		// ── 设置弹窗 → 全屏页（盖住侧栏与会话，带进入动画） ──
		'@keyframes dshr-settings-fade {',
		'  from { opacity: 0; }',
		'  to { opacity: 1; }',
		'}',
		'@keyframes dshr-settings-rise {',
		'  from { transform: translateY(12%); opacity: 0.85; }',
		'  to { transform: translateY(0); opacity: 1; }',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-overlay] {',
		'  position: fixed !important;',
		'  inset: 0 !important;',
		'  z-index: 1200 !important;',
		'  align-items: stretch !important;',
		'  justify-content: stretch !important;',
		'  padding: 0 !important;',
		'  margin: 0 !important;',
		'  box-sizing: border-box !important;',
		'  background: rgba(15, 15, 20, 0.45) !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dialog="1"] [data-dshr-sheet-overlay] {',
		'  visibility: visible !important;',
		'  pointer-events: auto !important;',
		'  z-index: 1400 !important;',
		'  width: 100% !important;',
		'  height: 100% !important;',
		'  animation: dshr-settings-fade 0.2s ease;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-panel] {',
		'  width: 100% !important;',
		'  max-width: none !important;',
		'  height: 100% !important;',
		'  max-height: none !important;',
		'  min-height: 100% !important;',
		'  border-radius: 0 !important;',
		'  flex-direction: column !important;',
		'  z-index: 1201 !important;',
		'  position: relative !important;',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'  animation: dshr-settings-rise 0.28s cubic-bezier(0.32, 0.72, 0, 1);',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-nav] {',
		'  display: flex !important;',
		'  flex-direction: row !important;',
		'  flex-wrap: nowrap;',
		'  align-items: center;',
		'  gap: 8px !important;',
		'  width: 100% !important;',
		'  min-width: 0 !important;',
		'  box-sizing: border-box !important;',
		'  overflow: hidden !important;',
		'  padding: 12px 16px 8px !important;',
		'  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(20, 20, 30, 0.08));',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-nav-title] {',
		'  flex: 0 0 auto;',
		'  padding: 0 4px 0 0 !important;',
		'  font-size: 17px !important;',
		'  line-height: 24px !important;',
		'  white-space: nowrap;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-nav-list] {',
		'  display: flex !important;',
		'  flex-direction: row !important;',
		'  flex: 1 1 0 !important;',
		'  width: 0 !important;',
		'  min-width: 0 !important;',
		'  max-width: 100% !important;',
		'  gap: 4px !important;',
		'  overflow-x: auto !important;',
		'  overflow-y: hidden !important;',
		'  overscroll-behavior-x: contain;',
		'  touch-action: pan-x;',
		'  scrollbar-width: none;',
		'  padding-bottom: 2px;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-nav-list]::-webkit-scrollbar { display: none; }',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-nav-list] > button {',
		'  flex: 0 0 auto;',
		'  height: 48px !important;',
		'  padding: 7px 12px !important;',
		'  white-space: nowrap;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-content] {',
		'  flex-direction: column !important;',
		'  flex: 1 1 auto !important;',
		'  width: 100% !important;',
		'  min-width: 0;',
		'  min-height: 0;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-header] {',
		'  flex: 0 0 auto !important;',
		'  padding: 8px 16px !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-options] {',
		'  flex: 1 1 auto !important;',
		'  width: 100% !important;',
		'  min-width: 0;',
		'  min-height: 0;',
		'  box-sizing: border-box;',
		'  padding: 0 16px max(24px, var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px))) !important;',
		'  overflow-y: auto !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-sheet-options] > * { min-width: 0; max-width: 100%; }',
		// ── 会话头部：为左上角鲸鱼让位，标题行/页签整体右移 ──
		// 官方 header 默认 padding-left 约 20px，固定鲸鱼占据 10~54px；
		// 72px = 鲸鱼右缘 + 间距，避免标题被小鲸鱼挡住。
		'html.' + ROOT_CLASS + ' [data-dshr-frame][data-sidebar-collapsed] header[data-dshr-session-header],',
		'html.' + ROOT_CLASS + ' [data-dshr-frame][data-sidebar-collapsed] header {',
		'  padding-left: 72px !important;',
		'}',
		// ── Session log 按钮：手机端只保留下载图标（MD3 icon button 48×48dp/24dp 图标）──
		'html.' + ROOT_CLASS + ' button[data-dshr-session-log] {',
		'  min-width: 48px !important;',
		'  width: 48px !important;',
		'  max-width: 48px !important;',
		'  min-height: 48px !important;',
		'  height: 48px !important;',
		'  flex: none !important;',
		'  padding: 0 !important;',
		'  gap: 0 !important;',
		'  font-size: 0 !important;',
		'  line-height: 0 !important;',
		'  justify-content: center !important;',
		'  border-radius: 999px !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + ' button[data-dshr-session-log] > :not(svg) {',
		'  position: absolute !important;',
		'  width: 1px !important;',
		'  height: 1px !important;',
		'  margin: -1px !important;',
		'  padding: 0 !important;',
		'  overflow: hidden !important;',
		'  clip: rect(0 0 0 0) !important;',
		'  white-space: nowrap !important;',
		'  border: 0 !important;',
		'}',
		'html.' + ROOT_CLASS + ' button[data-dshr-session-log] svg {',
		'  display: block !important;',
		'  width: 24px !important;',
		'  height: 24px !important;',
		'  flex: none !important;',
		'}',
		// ── 会话头部收敛：Agent Team 挪到页签行右侧 + 后台任务只留状态点与数量 ──
		// 标题行原本挤着 模式 / Agent Team / 后台任务 / Session log，窄屏横向溢出。
		// 这里只做 CSS 定位（绝不搬 React 节点）：给 header 建立定位上下文，
		// 把已标记的 [data-dshr-agent-team] 绝对定位到页签行右侧，
		// 它脱离标题行 flex 流后标题行立刻宽松。
		'html.' + ROOT_CLASS + ' [data-dshr-session-header] {',
		'  position: relative !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-session-header] [data-dshr-agent-team] {',
		'  position: absolute !important;',
		'  top: auto !important;',
		'  right: 12px !important;',
		'  bottom: 3px !important;',
		'  margin: 0 !important;',
		'  z-index: 2 !important;',
		'}',
		// 页签行给右侧 Agent Team 让出宽度，页签多了自己横向滚动，不再撑破头部。
		// 注意：官方 0.1.5 的页签行是 div[role="tablist"]，而 header 里的 <nav>
		// 是会话面包屑标题（不能拿它当页签行，否则标题被垫出 108px 反而更挤）。
		'html.' + ROOT_CLASS + ' [data-dshr-session-header] [data-dshr-tabs] {',
		'  box-sizing: border-box !important;',
		'  padding-right: 108px !important;',
		'  flex-wrap: nowrap !important;',
		'  overflow-x: auto !important;',
		'  overflow-y: hidden !important;',
		'  scrollbar-width: none;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-session-header] [data-dshr-tabs]::-webkit-scrollbar { display: none; }',
		// Agent Team 的弹层默认从控件左缘向右展开，控件挪到右侧后会顶出屏幕；
		// 改成右对齐向左展开，宽度不超视口。
		'html.' + ROOT_CLASS + ' [data-dshr-agent-team] [role="dialog"] {',
		'  left: auto !important;',
		'  right: 0 !important;',
		'  max-width: calc(100vw - 24px) !important;',
		'}',
		// 后台任务触发器：只留状态点（转圈动效）+ 数量。数量写在 data-dshr-job-n 上，
		// 由 ::after 渲染——不动 React 管的文本节点，重渲染不会把整句写回来。
		'html.' + ROOT_CLASS + ' button[data-dshr-job-count] {',
		'  display: inline-flex !important;',
		'  align-items: center !important;',
		'  justify-content: center !important;',
		'  gap: 4px !important;',
		'  min-width: 44px !important;',
		'  min-height: 44px !important;',
		'  padding: 0 4px !important;',
		'  flex: none !important;',
		'}',
		'html.' + ROOT_CLASS + ' button[data-dshr-job-count]::after {',
		'  content: attr(data-dshr-job-n);',
		'  font-size: 12px !important;',
		'  line-height: 18px !important;',
		'  font-variant-numeric: tabular-nums;',
		'}',
		'html.' + ROOT_CLASS + ' button[data-dshr-job-count] [data-dshr-job-count-text],',
		'html.' + ROOT_CLASS + ' button[data-dshr-job-count] [data-dshr-job-chevron] {',
		'  display: none !important;',
		'}',
		// ── 窄屏会话条：只收缩已标记的操作行/输入底栏/统计，不改官方布局变量 ──
		// 回复下的复制 / 点赞 / 分支 + 耗时：只缩小图标与耗时字号。
		// 容器上绝不设 height / overflow / display / gap / flex-wrap：
		// 万一误标到整列聊天，也不能把消息裁成 22px 或挤成一行。
		'html.' + ROOT_CLASS + ' [data-dshr-msg-actions] {',
		'  max-width: 100%;',
		'  min-width: 0;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-msg-actions] > button,',
		'html.' + ROOT_CLASS + ' [data-dshr-msg-actions] button {',
		'  width: 22px !important;',
		'  height: 22px !important;',
		'  min-width: 22px !important;',
		'  padding: 3px !important;',
		'  flex: none !important;',
		'  position: relative !important;',
		'}',
		// MD3 触控目标：视觉保持 22px 图标钮，命中区用透明 ::after 外扩 13px
		// 到 48dp（MD3 允许视觉小于 48dp，交互目标不得小于）。相邻按钮的扩展
		// 命中区在 ±13px 内互叠、按绘制顺序后者优先，中心区不受影响；命中区
		// 无背景无内容，不产生任何视觉溢出。
		'html.' + ROOT_CLASS + ' [data-dshr-msg-actions] button::after {',
		'  content: "";',
		'  position: absolute;',
		'  inset: -13px;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-msg-actions] button svg {',
		'  width: 13px !important;',
		'  height: 13px !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-msg-time] {',
		'  font-size: 11px !important;',
		'  line-height: 22px !important;',
		'  padding: 0 0 0 4px !important;',
		'  white-space: nowrap !important;',
		'  min-width: 0 !important;',
		'  flex: 1 1 0 !important;',
		'  overflow: hidden !important;',
		'  text-overflow: ellipsis !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-msg-time] [aria-hidden="true"] {',
		'  margin: 0 3px !important;',
		'}',
		// 输入框底栏：单行；+ / 权限固定不缩，模型名超长省略，不得盖住左侧按钮。
		'html.' + ROOT_CLASS + ' [data-dshr-composer-row] {',
		'  display: flex !important;',
		'  flex-wrap: nowrap !important;',
		'  align-items: center !important;',
		'  gap: 6px !important;',
		'  min-width: 0 !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-tools] {',
		'  display: flex !important;',
		'  flex: 0 0 auto !important;',
		'  align-items: center !important;',
		'  gap: 6px !important;',
		'  position: relative;',
		'  z-index: 1;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-trailing] {',
		'  display: flex !important;',
		'  flex: 1 1 0% !important;',
		'  align-items: center !important;',
		'  justify-content: flex-end !important;',
		'  gap: 6px !important;',
		'  min-width: 0 !important;',
		'  margin-left: 0 !important;',
		'  overflow: hidden !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-trailing] > button:not([data-dshr-composer-model]) {',
		'  flex: 0 0 auto !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-add] {',
		'  width: 26px !important;',
		'  height: 26px !important;',
		'  flex: 0 0 auto !important;',
		'  position: relative;',
		'  z-index: 1;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-access] {',
		'  display: inline-flex !important;',
		'  align-items: center !important;',
		'  justify-content: center !important;',
		'  width: 26px !important;',
		'  max-width: 26px !important;',
		'  height: 26px !important;',
		'  padding: 0 !important;',
		'  gap: 0 !important;',
		'  flex: 0 0 auto !important;',
		'  overflow: hidden !important;',
		'  position: relative;',
		'  z-index: 1;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-access-label],',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-access-chevron],',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-access] > :last-child:not(:first-child) {',
		'  display: none !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] {',
		'  display: flex !important;',
		'  align-items: center !important;',
		'  flex: 1 1 0% !important;',
		'  min-width: 0 !important;',
		'  max-width: 100% !important;',
		'  height: 26px !important;',
		'  padding: 0 4px 0 6px !important;',
		'  font-size: 12px !important;',
		'  line-height: 18px !important;',
		'  gap: 2px !important;',
		'  overflow: hidden !important;',
		'  white-space: nowrap !important;',
		'  box-sizing: border-box !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] > span:nth-child(2) {',
		'  display: none !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] > div {',
		'  flex: 1 1 0% !important;',
		'  min-width: 0 !important;',
		'  overflow: hidden !important;',
		'  display: flex !important;',
		'  align-items: center !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] span {',
		'  min-width: 0 !important;',
		'  overflow: hidden !important;',
		'  text-overflow: ellipsis !important;',
		'  white-space: nowrap !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] > span:first-child {',
		'  flex: 1 1 0% !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] > svg,',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-model] svg {',
		'  flex: none !important;',
		'  min-width: 12px !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-send] {',
		'  width: 30px !important;',
		'  height: 30px !important;',
		'  transform: none !important;',
		'  flex: none !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-composer-row] button svg {',
		'  width: 14px !important;',
		'  height: 14px !important;',
		'}',
		// 底部会话统计：单行、略缩小；超出横向滑动，不折行。
		'html.' + ROOT_CLASS + ' [data-dshr-stats-line] {',
		'  font-size: 11px !important;',
		'  line-height: 18px !important;',
		'  padding: 4px 12px 8px !important;',
		'  white-space: nowrap !important;',
		'  overflow-x: auto !important;',
		'  overflow-y: hidden !important;',
		'  text-overflow: clip !important;',
		'  text-align: center !important;',
		'  -webkit-overflow-scrolling: touch;',
		'  scrollbar-width: none;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-stats-line]::-webkit-scrollbar { display: none; }',
		'html.' + ROOT_CLASS + ' [data-dshr-stats-line] [aria-hidden="true"] {',
		'  margin: 0 4px !important;',
		'}',
		// ── 浮动选框：模型/权限/命令/模式等 popover 不得超出视口 ──
		'html.' + ROOT_CLASS + ' [data-dshr-float] {',
		'  box-sizing: border-box !important;',
		'  min-width: 0 !important;',
		'  overflow-x: hidden !important;',
		'  overflow-y: auto !important;',
		'  -webkit-overflow-scrolling: touch;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-float] [role="menu"],',
		'html.' + ROOT_CLASS + ' [data-dshr-float] [role="listbox"],',
		'html.' + ROOT_CLASS + ' [data-dshr-float] [role="tree"] {',
		'  box-sizing: border-box !important;',
		'  max-width: 100% !important;',
		'  min-width: 0 !important;',
		'}',
		'html.' + ROOT_CLASS + ' [data-dshr-float] [role="menuitem"],',
		'html.' + ROOT_CLASS + ' [data-dshr-float] [role="option"] {',
		'  max-width: 100%;',
		'  box-sizing: border-box;',
		'}',
	].join('\n');

	// ── 样式注入 ───────────────────────────────────────────────
	if (document.querySelector('style[data-dshr-mobile-css]') === null) {
		var style = document.createElement('style');
		style.setAttribute('data-dshr-mobile-css', '');
		style.textContent = MOBILE_CSS;
		(document.head || document.documentElement).appendChild(style);
	}

	// ── 视口：viewport-fit=cover；Android 壳 overlays-content，键盘占位交给原生 padding ──
	var viewport = document.querySelector('meta[name="viewport"]');
	if (viewport) {
		var content = viewport.getAttribute('content') || 'width=device-width, initial-scale=1';
		if (!/viewport-fit\s*=\s*cover/i.test(content)) {
			content += ', viewport-fit=cover';
		}
		var imeWidget = isAndroidShell() ? 'overlays-content' : 'resizes-content';
		if (!/interactive-widget\s*=/i.test(content)) {
			content += ', interactive-widget=' + imeWidget;
		} else {
			content = content.replace(/interactive-widget\s*=\s*[a-z-]+/i, 'interactive-widget=' + imeWidget);
		}
		viewport.setAttribute('content', content);
	}

	function imeGapPx() {
		if (typeof window.__dshrTestImeGap === 'number') {
			var testGap = Math.round(window.__dshrTestImeGap);
			return testGap >= 48 ? testGap : 0;
		}
		var vv = window.visualViewport;
		if (!vv) return 0;
		var layoutH = window.innerHeight || document.documentElement.clientHeight || 0;
		var gap = Math.round(layoutH - vv.height - (vv.offsetTop || 0));
		return gap >= 48 ? gap : 0;
	}

	function clearImeLift() {
		var root = document.documentElement;
		root.removeAttribute('data-dshr-ime');
		root.style.removeProperty('--dshr-vv-height');
		root.style.setProperty('--dshr-ime', '0px');
	}

	var lastImeVvHeight = -1;
	var imeLiftTimer = 0;

	function applyImeLift() {
		// Android 壳：键盘占位只由原生平移负责，不得锁 html 高度、不得缩小 WebView。
		if (isAndroidShell() || !isMobileMode()) {
			lastImeVvHeight = -1;
			clearImeLift();
			return;
		}
		var gap = imeGapPx();
		if (gap <= 0) {
			lastImeVvHeight = -1;
			clearImeLift();
			return;
		}
		var vv = window.visualViewport;
		var height = typeof window.__dshrTestVvHeight === 'number'
			? Math.round(window.__dshrTestVvHeight)
			: (vv ? Math.round(vv.height) : Math.max(0, (window.innerHeight || 0) - gap));
		if (lastImeVvHeight >= 0 && Math.abs(height - lastImeVvHeight) < 8) return;
		lastImeVvHeight = height;
		var root = document.documentElement;
		root.style.setProperty('--dshr-ime', gap + 'px');
		root.style.setProperty('--dshr-vv-height', height + 'px');
		root.setAttribute('data-dshr-ime', '1');
	}

	function scheduleImeLift() {
		if (imeLiftTimer) return;
		imeLiftTimer = window.setTimeout(function () {
			imeLiftTimer = 0;
			applyImeLift();
		}, 32);
	}

	function isEditableFocus(el) {
		if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
		var tag = (el.tagName || '').toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
		if (el.isContentEditable) return true;
		return false;
	}

	/**
	 * 键盘抬起的目标元素：焦点落在输入卡里时，取整块输入区
	 * （[data-composer-seat] 含底栏与底部统计；退化到 [data-composer-card]）。
	 * 官方输入卡是「文本框在上、四键底栏在下」，只报 textarea 的矩形时原生
	 * 恰好抬到「文本框底边高于键盘」，底栏与统计仍留在键盘后面——用户看到
	 * 的就是「键盘遮住输入框」。按整块输入区算，输入框整体高于键盘。
	 */
	function imeLiftElement(el) {
		if (!isElement(el) || !el.closest) return el;
		return el.closest('[data-composer-seat]') || el.closest('[data-composer-card]') || el;
	}

	/** 供原生 IME 平移与非壳自测复用的目标矩形（CSS px，视口坐标）。 */
	function imeLiftRect(el) {
		var target = imeLiftElement(el);
		if (!isElement(target)) return null;
		var r = target.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom };
	}

	function reportImeFocusToNative() {
		if (!isAndroidShell()) return;
		try {
			if (!window.DshRemoteApp || typeof window.DshRemoteApp.imeFocusRect !== 'function') return;
			var el = document.activeElement;
			if (!isEditableFocus(el)) {
				window.DshRemoteApp.imeFocusRect(-1, -1);
				return;
			}
			var rect = imeLiftRect(el);
			if (!rect) return;
			window.DshRemoteApp.imeFocusRect(rect.top, rect.bottom);
		} catch (ignoredFocus) { /* 无 JS 桥时由原生按当前焦点 View 计算 */ }
	}

	function bindImeLift() {
		if (window.__dshrImeBound) return;
		window.__dshrImeBound = true;
		var onChange = function () {
			reportImeFocusToNative();
			scheduleImeLift();
		};
		var vv = window.visualViewport;
		if (vv && vv.addEventListener) {
			vv.addEventListener('resize', onChange);
			// 故意不听 visualViewport.scroll：打字时 caret 滚进可见区会改 offsetTop，
			// 再锁 html 高度会跟官方空会话页垂直居中互相反馈，造成上下抖动。
		}
		window.addEventListener('resize', onChange);
		window.addEventListener('focusin', onChange);
		window.addEventListener('focusout', function () {
			window.setTimeout(onChange, 80);
		});
	}

	function isPortraitViewport() {
		try {
			if (window.matchMedia) {
				var portraitMq = window.matchMedia('(orientation: portrait)');
				if (portraitMq && typeof portraitMq.matches === 'boolean') return portraitMq.matches;
			}
		} catch (ignoredPortrait) { /* fall through */ }
		return (window.innerHeight || 0) >= (window.innerWidth || 0);
	}

	function isTabletViewport() {
		var w = window.innerWidth || 0;
		var h = window.innerHeight || 0;
		if (Math.min(w, h) >= 600) return true;
		try {
			if (window.matchMedia && window.matchMedia('(min-width: 600px) and (min-height: 600px)').matches) {
				return true;
			}
		} catch (ignoredTablet) { /* ignore */ }
		return false;
	}

	function syncDrawerMetrics() {
		var root = document.documentElement;
		var vw = window.innerWidth || 390;
		if (root.getAttribute('data-dshr-tablet') === '1') {
			var drawer = Math.round(Math.min(380, Math.max(280, vw * 0.32)));
			var peek = Math.max(120, vw - drawer);
			root.style.setProperty('--dshr-drawer-width', drawer + 'px');
			root.style.setProperty('--dshr-drawer-peek', peek + 'px');
		} else {
			root.style.setProperty('--dshr-drawer-peek', '52px');
			root.style.setProperty('--dshr-drawer-width', 'calc(100% - 52px)');
		}
	}

	// ── hook 启用（WEB-02 单一源：同一份脚本、两种平台行为，运行时区分） ──
	// 断点一律优先读注入变量 window.__DSHR_MOBILE__.breakpoint（edge 网关下发）；
	// 缺省按平台回落：Android 壳 1024（安卓端旧缺省）、浏览器 980（web 旧缺省）。
	var breakpoint = isAndroidShell() ? 1024 : 980;
	try {
		var injectedCfg = window.__DSHR_MOBILE__;
		if (injectedCfg && typeof injectedCfg.breakpoint === 'number'
			&& injectedCfg.breakpoint >= 240 && injectedCfg.breakpoint <= 4096) {
			breakpoint = Math.round(injectedCfg.breakpoint);
		}
	} catch (ignoredCfg) { /* 保持缺省断点 */ }
	var mql = window.matchMedia('(max-width: ' + breakpoint + 'px)');
	var portraitMql = null;
	try { portraitMql = window.matchMedia('(orientation: portrait)'); } catch (ignoredO) { portraitMql = null; }
	function applyWidthScope() {
		var tablet = isTabletViewport();
		var portrait = isPortraitViewport();
		var on;
		if (isAndroidShell()) {
			// 安卓端旧行为原式：仅竖屏启用；壳内不看宽度断点（部分机型 layout
			// viewport 虚高），横屏交给官方 DSH 桌面布局。
			on = portrait && (isAndroidShell() || mql.matches);
		} else {
			// web 端旧行为：不看竖横屏，视口宽度 ≤ 断点即启用；
			// iPad 横屏（≥断点）自然回到官方布局。
			on = !!mql.matches;
		}
		var root = document.documentElement;
		root.classList[on ? 'add' : 'remove'](ROOT_CLASS);
		root.classList[on ? 'remove' : 'add']('dshr-official-inset');
		if (on && tablet) root.setAttribute('data-dshr-tablet', '1');
		else root.removeAttribute('data-dshr-tablet');
		if (on) syncDrawerMetrics();
		else {
			root.style.removeProperty('--dshr-drawer-width');
			root.style.removeProperty('--dshr-drawer-peek');
		}
		applyImeLift();
		reportImeFocusToNative();
	}
	if (mql.addEventListener) mql.addEventListener('change', applyWidthScope);
	else if (mql.addListener) mql.addListener(applyWidthScope);
	if (portraitMql) {
		if (portraitMql.addEventListener) portraitMql.addEventListener('change', applyWidthScope);
		else if (portraitMql.addListener) portraitMql.addListener(applyWidthScope);
	}
	applyWidthScope();
	bindImeLift();

	// ── 原生 inset 变量（MainActivity 在页面加载/焦点变化时调用） ──
	window.__dshRemoteInsets = {
		set: function (topPx, bottomPx) {
			var rootStyle = document.documentElement.style;
			rootStyle.setProperty('--dshr-inset-top', Number(topPx) + 'px');
			rootStyle.setProperty('--dshr-inset-bottom', Number(bottomPx) + 'px');
			applyImeLift();
		},
	};

	// ── 官方控件定位（只用稳定结构特征，不依赖哈希类名） ──
	var TOGGLE_SELECTOR = [
		'button[aria-label="打开侧边栏"]',
		'button[aria-label="收起侧边栏"]',
		'button[aria-label="Open sidebar"]',
		'button[aria-label="Collapse sidebar"]',
	].join(',');

	function isElement(node) {
		return !!node && node.nodeType === 1;
	}

	/** display:none / hidden 的节点不算数（官方条件卸载，但防御隐藏弹窗残留）。 */
	function isVisible(node) {
		if (!isElement(node)) return false;
		return node.getClientRects && node.getClientRects().length > 0;
	}

	function looksLikeFrame(node) {
		if (!isElement(node)) return false;
		if (node.hasAttribute('data-dshr-frame')) return true;
		if (node.hasAttribute('data-sidebar-collapsed')) return true;
		var columns = node.style && node.style.gridTemplateColumns;
		if (columns && columns.indexOf('minmax') >= 0) return true;
		try {
			var cs = window.getComputedStyle(node);
			if (cs && cs.display === 'grid' && String(cs.gridTemplateColumns || '').indexOf('minmax') >= 0) {
				return true;
			}
		} catch (ignoredGrid) { /* ignore */ }
		for (var i = 0; i < node.children.length; i++) {
			if (node.children[i].hasAttribute('data-shell-overlay')) return true;
		}
		return false;
	}

	/**
	 * 官方三栏 frame 定位，多级回退：
	 *   0. 已标记的 [data-dshr-frame]（展开态没有 data-sidebar-collapsed 时仍可用）；
	 *   1. 从官方侧栏开关向上找带 inline/computed grid 列/直接 overlay 子节点的祖先；
	 *   2. 收起态标记 [data-sidebar-collapsed] 本身就在 frame 上；
	 *   3. [data-shell-overlay] 的父节点（旧构建回退）。
	 */
	function findFrame() {
		var marked = document.querySelector('[data-dshr-frame]');
		if (isElement(marked)) return marked;
		var toggle = document.querySelector(TOGGLE_SELECTOR);
		if (toggle) {
			var node = toggle.parentElement;
			for (var hop = 0; hop < 7 && node; hop++, node = node.parentElement) {
				if (looksLikeFrame(node)) return node;
			}
		}
		var collapsedFrame = document.querySelector('[data-sidebar-collapsed]');
		if (isElement(collapsedFrame)) return collapsedFrame;
		var overlayLayer = document.querySelector('[data-shell-overlay]');
		if (isElement(overlayLayer) && isElement(overlayLayer.parentElement)) {
			return overlayLayer.parentElement;
		}
		return null;
	}

	/** 侧栏列 = frame 里包含官方开关按钮的直接子节点；回退 firstElementChild。 */
	function findSidebarCol(frame) {
		var toggle = document.querySelector(TOGGLE_SELECTOR);
		if (toggle && frame.contains(toggle)) {
			var node = toggle.parentElement;
			while (node && node.parentElement !== frame) node = node.parentElement;
			if (node && node.parentElement === frame) return node;
		}
		return frame.firstElementChild;
	}

	/**
	 * 中间会话列 = frame 直接子节点中非侧栏、非 details 的那一列。
	 * 优先选含 header / 输入卡的节点，避免误标 details 空列。
	 */
	function findMainCol(frame) {
		if (!isElement(frame)) return null;
		var sidebar = findSidebarCol(frame);
		var kids = frame.children;
		var fallback = null;
		for (var i = 0; i < kids.length; i++) {
			var kid = kids[i];
			if (kid === sidebar) continue;
			var side = (kid.getAttribute('data-side') || '').toLowerCase();
			if (side === 'sidebar' || side === 'details') continue;
			if (kid.querySelector('header, [data-composer-card], [data-composer-seat], textarea')) {
				return kid;
			}
			if (!fallback) fallback = kid;
		}
		return fallback;
	}

	/**
	 * 官方侧栏切换控件定位，两级策略：
	 *   1. aria-label / title 含「侧边栏/sidebar」的按钮（官方 zh/en 文案，
	 *      子串匹配以容忍不同构建的文案差异）；
	 *   2. 结构回退：侧栏根第一行（logoRow）的最后一个按钮就是官方折叠开关
	 *      （窄屏下 logoRow 只有这一个按钮，与 aria 文案无关）。
	 */
	function findToggleControl() {
		var known = document.querySelector('[data-dshr-official-toggle]');
		if (known) return known;
		var candidates = document.querySelectorAll('button[aria-label], button[title]');
		for (var i = 0; i < candidates.length; i++) {
			var candidate = candidates[i];
			if (candidate.id === 'dshr-mobile-whale' || candidate.id === 'dshr-mobile-drawer-mask') continue;
			var label = (candidate.getAttribute('aria-label') || '') + ' ' + (candidate.getAttribute('title') || '');
			if (/侧边栏|sidebar/i.test(label)) return candidate;
		}
		var frame = findFrame();
		if (frame) {
			var column = findSidebarCol(frame);
			var sidebarRoot = column ? column.firstElementChild : null;
			var logoRow = sidebarRoot ? sidebarRoot.firstElementChild : null;
			if (isElement(logoRow)) {
				var buttons = logoRow.querySelectorAll('button');
				// 从最后一个往前找，但跳过会话头部等 header 内的按钮——
				// 结构回退只应命中侧栏自己的折叠开关，绝不能误标
				// Session log 之类的头部操作按钮。
				for (var k = buttons.length - 1; k >= 0; k--) {
					var candidateButton = buttons[k];
					if (candidateButton.closest && candidateButton.closest('header')) continue;
					return candidateButton;
				}
			}
		}
		return null;
	}

	/**
	 * WEB-04：首选标准 DOM 事件分发触发官方按钮——不依赖 React 内部缓存
	 * （__reactProps$/__reactFiber$），React 升级或官方改事件绑定也稳定生效
	 * （React 17+ 委托监听挂在根容器上，冒泡的合成 click 一样会被接住）。
	 * 是否真正生效由调用方用状态验证（sidebarStateChanged）判定；
	 * 本函数返回「派发动作是否完成」——旧 WebView 缺 MouseEvent 构造器时
	 * 返回 false，由上层退回 HTMLElement.click() 等其它通道。
	 */
	function dispatchNativeClick(target) {
		try {
			var rect = target.getBoundingClientRect();
			var opts = {
				bubbles: true,
				cancelable: true,
				view: window,
				button: 0,
				clientX: rect.left + rect.width / 2,
				clientY: rect.top + rect.height / 2,
			};
			target.dispatchEvent(new MouseEvent('click', opts));
			return true;
		} catch (ignoredDispatch) {
			return false;
		}
	}

	/**
	 * WEB-04 兜底通道（标准事件分发未生效时才探测）：React 把当前元素 props
	 * 缓存在 __reactProps$*（兼容回退为 fiber.memoizedProps），直接调用官方
	 * 按钮的 onClick 闭包，走与真人点击完全相同的处理。
	 * eventStub 补齐 nativeEvent/type/坐标/persist 等防御字段，处理器读取
	 * 常见原生字段时不抛错。
	 */
	function invokeReactOnClick(target) {
		var names;
		try {
			names = Object.getOwnPropertyNames(target);
		} catch (ignored) {
			return false;
		}
		var cx = 0;
		var cy = 0;
		try {
			var rect = target.getBoundingClientRect();
			cx = rect.left + rect.width / 2;
			cy = rect.top + rect.height / 2;
		} catch (ignoredRect) { /* 坐标留 0，不影响 onClick 主流程 */ }
		var nativeEvent = null;
		try {
			nativeEvent = new MouseEvent('click', {
				bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy,
			});
		} catch (ignoredNative) {
			nativeEvent = {
				type: 'click', target: target, currentTarget: target,
				bubbles: true, cancelable: true, defaultPrevented: false,
				clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0,
				preventDefault: function () {}, stopPropagation: function () {},
			};
		}
		var eventStub = {
			target: target,
			currentTarget: target,
			type: 'click',
			bubbles: true,
			cancelable: true,
			defaultPrevented: false,
			eventPhase: 2,
			timeStamp: Date.now(),
			nativeEvent: nativeEvent,
			clientX: cx,
			clientY: cy,
			screenX: cx,
			screenY: cy,
			pageX: cx,
			pageY: cy,
			button: 0,
			buttons: 0,
			detail: 1,
			preventDefault: function () {
				this.defaultPrevented = true;
				try { if (this.nativeEvent && this.nativeEvent.preventDefault) this.nativeEvent.preventDefault(); } catch (ignoredPd) {}
			},
			stopPropagation: function () {},
			stopImmediatePropagation: function () {},
			persist: function () {},
			isDefaultPrevented: function () { return !!this.defaultPrevented; },
			isPropagationStopped: function () { return false; },
		};
		for (var i = 0; i < names.length; i++) {
			var key = names[i];
			var props = null;
			if (key.indexOf('__reactProps$') === 0) props = target[key];
			else if (key.indexOf('__reactFiber$') === 0) {
				var fiber = target[key];
				props = fiber && fiber.memoizedProps;
			}
			if (!props || typeof props.onClick !== 'function') continue;
			try {
				props.onClick.call(target, eventStub);
				return true;
			} catch (ignoredClick) {
				// 继续尝试其他 React 缓存或 DOM 事件通道。
			}
		}
		return false;
	}

	/** 完整指针事件序列：兜底 onClick 之外还监听 pointer/mouse 事件的实现。 */
	function dispatchTap(target) {
		var rect = target.getBoundingClientRect();
		var opts = {
			bubbles: true,
			cancelable: true,
			view: window,
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
			button: 0,
		};
		try {
			if (typeof PointerEvent === 'function') {
				target.dispatchEvent(new PointerEvent('pointerdown', opts));
				target.dispatchEvent(new PointerEvent('pointerup', opts));
			}
			target.dispatchEvent(new MouseEvent('mousedown', opts));
			target.dispatchEvent(new MouseEvent('mouseup', opts));
		} catch (ignored) {
			// 旧 WebView 缺构造器时只派发 click。
		}
		target.dispatchEvent(new MouseEvent('click', opts));
	}

	function sidebarStateChanged(before) {
		var frame = findFrame();
		if (!frame) return false;
		if (before === null) return true;
		return frame.hasAttribute('data-sidebar-collapsed') !== before;
	}

	/**
	 * 切换官方侧栏，带状态验证与分层重试：
	 *   1. WEB-04：首选标准 DOM 事件分发（不依赖 React 内部缓存，React 升级/改绑定也稳定）；
	 *   2. 旧 WebView 缺 MouseEvent 构造器时退回 HTMLElement.click()；
	 *   3. 280ms 后状态仍未翻转：再探测 React onClick 缓存，不中就补
	 *      完整 pointer/mouse/click 序列。
	 */
	var toggleBusy = false;
	var pendingSidebarOpen = null;

	function flushPendingSidebar() {
		if (pendingSidebarOpen === null) return;
		var want = pendingSidebarOpen;
		pendingSidebarOpen = null;
		if (isSidebarOpen() !== want) toggleSidebar();
	}

	function toggleSidebar() {
		if (toggleBusy) return true;
		var frame = findFrame();
		var before = frame ? frame.hasAttribute('data-sidebar-collapsed') : null;
		var button = findToggleControl();
		if (!button) return false;
		toggleBusy = true;
		var dispatched = dispatchNativeClick(button);
		if (!dispatched) button.click();
		if (sidebarStateChanged(before)) {
			toggleBusy = false;
			flushPendingSidebar();
			return true;
		}
		window.setTimeout(function () {
			if (sidebarStateChanged(before)) {
				toggleBusy = false;
				flushPendingSidebar();
				return;
			}
			var button2 = findToggleControl();
			if (button2) {
				// 标准分发未生效：探测 React 缓存兜底（可能在 hydration 后才有）；
				// 不中再走完整事件序列。
				var retriedReact = invokeReactOnClick(button2);
				if (!retriedReact) dispatchTap(button2);
			}
			window.setTimeout(function () {
				toggleBusy = false;
				flushPendingSidebar();
			}, 220);
		}, 280);
		return true;
	}

	function isMobileMode() {
		return document.documentElement.classList.contains(ROOT_CLASS);
	}

	function isDialogOpen() {
		return document.documentElement.getAttribute('data-dshr-dialog') === '1';
	}

	function isExplorerDetailsOpen() {
		return document.documentElement.getAttribute('data-dshr-explorer-details') === '1';
	}

	/** 官方设置全屏或 Explorer 右侧栏替换时，不要再抢抽屉手势。 */
	function isDrawerLocked() {
		return isDialogOpen() || isExplorerDetailsOpen();
	}

	function isSidebarOpen() {
		var frame = findFrame();
		return !!(frame && !frame.hasAttribute('data-sidebar-collapsed'));
	}

	/** 定向开/关侧栏；已是目标态时不 toggle，避免连点把抽屉又打开。 */
	function setSidebarOpen(open) {
		open = !!open;
		if (isSidebarOpen() === open) {
			pendingSidebarOpen = null;
			return true;
		}
		if (toggleBusy) {
			pendingSidebarOpen = open;
			return true;
		}
		return toggleSidebar();
	}

	function isIgnoredSwipeTarget(node) {
		if (!isElement(node) || !node.closest) return true;
		if (node.closest('textarea, input, select, [contenteditable="true"]')) return true;
		if (node.closest('[data-composer-card]')) return true;
		if (node.closest('#dshr-mobile-whale')) return true;
		if (node.closest('#dshr-status-guard')) return true;
		if (node.closest('[data-dshr-stats-line]')) return true;
		return false;
	}

	/**
	 * WEB-05：手势起点位于可横向滚动子容器内时放弃抽屉接管。
	 * 匹配条件（任一满足即视为横向可滚动容器）：
	 *   1. closest 匹配 pre / code / table 标签；
	 *   2. 祖先节点 getComputedStyle overflow-x 为 auto 或 scroll，
	 *      且 scrollWidth > clientWidth（实际存在横向溢出内容）。
	 * 返回 true 时调用方应放弃 drawer 手势，让浏览器原生横向滚动生效。
	 */
	function isInHorizontallyScrollableContainer(node) {
		if (!isElement(node) || !node.closest) return false;
		// 快速路径：pre/code/table 天然横向滚动容器
		if (node.closest('pre, code, table')) return true;
		var el = node;
		while (el && el !== document.body && el !== document.documentElement) {
			try {
				var cs = window.getComputedStyle(el);
				var overflowX = cs.overflowX || '';
				if (overflowX === 'auto' || overflowX === 'scroll') {
					if (el.scrollWidth > el.clientWidth) return true;
				}
			} catch (ignoredScroll) { /* ignore */ }
			el = el.parentElement;
		}
		return false;
	}

	function drawerPeekPx() {
		try {
			var raw = window.getComputedStyle(document.documentElement).getPropertyValue('--dshr-drawer-peek');
			var n = parseFloat(raw);
			if (n > 0) return n;
		} catch (ignoredPeek) { /* ignore */ }
		return 52;
	}

	function drawerMaxShift() {
		var frame = findFrame();
		var main = frame ? findMainCol(frame) : null;
		var width = 0;
		if (main) {
			width = main.offsetWidth || 0;
			if (width < 40) {
				try { width = main.getBoundingClientRect().width; } catch (ignoredW) { width = 0; }
			}
		}
		if (width < 40) width = window.innerWidth || 390;
		return Math.max(80, width - drawerPeekPx());
	}

	function setDrawerVisual(x) {
		var max = drawerMaxShift();
		x = Math.max(0, Math.min(max, x));
		var p = max > 0 ? x / max : 0;
		var root = document.documentElement;
		root.setAttribute('data-dshr-dragging', '1');
		root.style.setProperty('--dshr-drawer-x', Math.round(x) + 'px');
		root.style.setProperty('--dshr-drawer-p', String(Math.round(p * 1000) / 1000));
		return { x: x, p: p, max: max };
	}

	function clearDrawerVisual() {
		var root = document.documentElement;
		root.removeAttribute('data-dshr-dragging');
		root.style.removeProperty('--dshr-drawer-x');
		root.style.removeProperty('--dshr-drawer-p');
	}

	function settleDrawer(wantOpen) {
		clearDrawerVisual();
		return setSidebarOpen(!!wantOpen);
	}

	/**
	 * 主屏幕右划打开左侧栏；展开后在侧栏或右侧浮层细条上左划关闭。
	 * 跟手拖动走 touchmove；本函数保留给测试桥与瞬时轻扫兜底。
	 */
	function considerSwipe(x0, y0, x1, y1, target) {
		if (!isMobileMode() || isDrawerLocked()) return false;
		var dx = x1 - x0;
		var dy = y1 - y0;
		if (Math.abs(dx) < 48) return false;
		if (Math.abs(dx) < Math.abs(dy) * 1.4) return false;
		if (Math.abs(dy) > 96) return false;
		var frame = findFrame();
		var sidebar = frame ? findSidebarCol(frame) : null;
		var main = frame ? findMainCol(frame) : null;
		var inSidebar = !!(sidebar && isElement(target) && sidebar.contains(target));
		var inMain = !!(main && isElement(target) && main.contains(target));
		var onMask = isElement(target) && target.id === 'dshr-mobile-drawer-mask';
		if (dx > 0 && !isSidebarOpen() && !inSidebar && !onMask && !isIgnoredSwipeTarget(target)) {
			return settleDrawer(true);
		}
		if (dx < 0 && isSidebarOpen() && (inSidebar || onMask || inMain || x0 < window.innerWidth * 0.92)) {
			return settleDrawer(false);
		}
		return false;
	}

	function canStartDrawerTrack(target, x0) {
		if (!isMobileMode() || isDrawerLocked() || toggleBusy) return false;
		if (!isElement(target)) return false;
		var frame = findFrame();
		if (!frame) return false;
		var sidebar = findSidebarCol(frame);
		var main = findMainCol(frame);
		var inSidebar = !!(sidebar && sidebar.contains(target));
		var onMask = target.id === 'dshr-mobile-drawer-mask';
		if (isSidebarOpen()) {
			return inSidebar || onMask || !!(main && main.contains(target)) || x0 < window.innerWidth * 0.95;
		}
		if (inSidebar || onMask) return false;
		if (isIgnoredSwipeTarget(target)) return false;
		// WEB-05：手势起点在可横向滚动容器（代码块/表格/overflow-x 溢出区）内时
		// 放弃抽屉接管，把横滑还给浏览器原生滚动。
		if (isInHorizontallyScrollableContainer(target)) return false;
		return true;
	}

	function sidebarHasOpenMenu(sidebar) {
		if (!isElement(sidebar)) return false;
		if (sidebar.querySelector('[aria-expanded="true"]')) return true;
		var menus = sidebar.querySelectorAll('[role="menu"], [role="listbox"]');
		for (var i = 0; i < menus.length; i++) {
			if (isVisible(menus[i])) return true;
		}
		return false;
	}

	/**
	 * 侧栏里点「会话行 / 新会话」算导航；图标-only 的更多/折叠/开关不算。
	 * 不依赖 CSS Module 哈希类名。
	 */
	function isSessionNavigationClick(target, sidebar) {
		if (!isElement(target) || !isElement(sidebar) || !sidebar.contains(target)) return false;
		if (target.closest('[data-dshr-official-toggle]')) return false;
		if (target.closest('input, textarea, select, [contenteditable="true"]')) return false;
		var node = target;
		var hit = null;
		while (node && node !== sidebar) {
			if (node.matches && node.matches('a[href], button, [role="button"], [role="link"], [role="listitem"]')) {
				hit = node;
				break;
			}
			node = node.parentElement;
		}
		if (!hit || hit.hasAttribute('data-dshr-official-toggle')) return false;
		var label = ((hit.getAttribute('aria-label') || '') + ' ' + (hit.getAttribute('title') || '')).trim();
		if (/侧边栏|sidebar/i.test(label)) return false;
		var text = (hit.innerText || hit.textContent || '').replace(/\s+/g, ' ').trim();
		var combined = label + ' ' + text;
		if (/新会话|新建会话|新对话|New session|New chat|New thread/i.test(combined)) return true;
		if (/^(设置|Settings|搜索|Search)$/i.test(text) || /^(设置|Settings|搜索|Search)$/i.test(label)) return false;
		var iconOnly = !!hit.querySelector('svg') && text.length < 2;
		var small = false;
		try {
			var rect = hit.getBoundingClientRect();
			small = rect.width > 0 && rect.width <= 44 && rect.height <= 44;
		} catch (ignoredRect) {
			small = false;
		}
		if (iconOnly && small) return false;
		if (hit.getAttribute('aria-haspopup') && text.length < 2) return false;
		return text.length >= 1;
	}

	var lastSessionKey = null;
	function currentSessionKey() {
		var header = document.querySelector('header');
		var title = '';
		if (header) title = (header.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
		var path = '';
		try { path = String(location.pathname || '') + String(location.hash || ''); } catch (ignoredPath) { path = ''; }
		return path + '\n' + title;
	}

	function maybeAutoCloseOnSessionChange() {
		if (!isMobileMode() || isDrawerLocked()) return;
		var key = currentSessionKey();
		var prev = lastSessionKey;
		lastSessionKey = key;
		if (!isSidebarOpen()) return;
		if (prev === null || prev === key) return;
		setSidebarOpen(false);
	}

	var gesturesBound = false;
	function ensureGestures() {
		if (gesturesBound || !document.body) return;
		gesturesBound = true;
		var tracking = false;
		var dragging = false;
		var startX = 0;
		var startY = 0;
		var baseX = 0;
		var lastX = 0;
		var lastT = 0;
		var velocity = 0;
		var startTarget = null;

		function resetTrack() {
			tracking = false;
			dragging = false;
			startTarget = null;
			velocity = 0;
			activePointer = null;
		}

		var activePointer = null;

		function onDragStart(clientX, clientY, target, pointerId) {
			if (!isMobileMode() || isDrawerLocked()) {
				resetTrack();
				return false;
			}
			if (!canStartDrawerTrack(target, clientX)) {
				resetTrack();
				return false;
			}
			tracking = true;
			dragging = false;
			startX = clientX;
			startY = clientY;
			lastX = startX;
			lastT = Date.now();
			velocity = 0;
			startTarget = target;
			activePointer = pointerId == null ? 'touch' : pointerId;
			baseX = isSidebarOpen() ? drawerMaxShift() : 0;
			return true;
		}

		function onDragMove(clientX, clientY, event) {
			if (!tracking) return;
			var dx = clientX - startX;
			var dy = clientY - startY;
			if (!dragging) {
				if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
				if (Math.abs(dx) < Math.abs(dy) * 1.15) {
					resetTrack();
					return;
				}
				dragging = true;
				setDrawerVisual(baseX);
			}
			var now = Date.now();
			var dt = Math.max(1, now - lastT);
			velocity = (clientX - lastX) / dt;
			lastX = clientX;
			lastT = now;
			setDrawerVisual(baseX + dx);
			if (event && event.cancelable) event.preventDefault();
		}

		function onDragEnd(clientX, clientY) {
			if (!tracking) return;
			var endX = clientX;
			var endY = clientY;
			var wasDragging = dragging;
			var start = startTarget;
			var opened = isSidebarOpen();
			resetTrack();
			if (wasDragging) {
				var shift = baseX + (endX - startX);
				var visual = setDrawerVisual(shift);
				var wantOpen = visual.p >= 0.35;
				if (Math.abs(velocity) > 0.45) wantOpen = velocity > 0;
				settleDrawer(wantOpen);
				return;
			}
			if (opened && isElement(start)) {
				var frame = findFrame();
				var main = frame ? findMainCol(frame) : null;
				var inMain = !!(main && main.contains(start));
				var onMask = start.id === 'dshr-mobile-drawer-mask';
				if (inMain || onMask) {
					settleDrawer(false);
					return;
				}
			}
			considerSwipe(startX, startY, endX, endY, start);
		}

		function onDragCancel() {
			if (!tracking) return;
			var opened = isSidebarOpen();
			var wasDragging = dragging;
			resetTrack();
			if (wasDragging) settleDrawer(opened);
			else clearDrawerVisual();
		}

		// Android WebView 的 PointerEvent 会在页面滚动时 pointercancel，右滑打开侧栏被吞掉。
		// 抽屉手势始终走 touch；一旦判定为横向拖动就 preventDefault。
		document.addEventListener('touchstart', function (event) {
			if (event.touches && event.touches.length !== 1) {
				resetTrack();
				return;
			}
			var touch = event.touches && event.touches[0];
			if (!touch) return;
			onDragStart(touch.clientX, touch.clientY, event.target, 'touch');
		}, { capture: true, passive: true });
		document.addEventListener('touchmove', function (event) {
			var touch = event.touches && event.touches[0];
			if (!touch) return;
			onDragMove(touch.clientX, touch.clientY, event);
		}, { capture: true, passive: false });
		document.addEventListener('touchend', function (event) {
			var touch = event.changedTouches && event.changedTouches[0];
			onDragEnd(touch ? touch.clientX : lastX, touch ? touch.clientY : startY);
		}, { capture: true, passive: true });
		document.addEventListener('touchcancel', function () {
			if (!tracking) return;
			var dx = lastX - startX;
			if (dragging || Math.abs(dx) >= 48) onDragEnd(lastX, startY);
			else onDragCancel();
		}, { capture: true, passive: true });

		document.addEventListener('click', function (event) {
			if (!isMobileMode() || isDrawerLocked() || !isSidebarOpen()) return;
			var frame = findFrame();
			var sidebar = frame ? findSidebarCol(frame) : null;
			if (!isSessionNavigationClick(event.target, sidebar)) return;
			window.setTimeout(function () {
				if (sidebarHasOpenMenu(sidebar)) return;
				setSidebarOpen(false);
			}, 60);
		}, true);
	}

	function isLayoutChrome(node) {
		if (!isElement(node)) return true;
		if (node.id === 'dshr-mobile-whale' || node.id === 'dshr-mobile-drawer-mask') return true;
		if (node.id === 'dshr-status-guard' || node.id === 'dshr-drawer-handle') return true;
		if (node.hasAttribute('data-dshr-frame')) return true;
		if (node.hasAttribute('data-dshr-sidebar-col')) return true;
		if (node.hasAttribute('data-dshr-main-col')) return true;
		if (node.hasAttribute('data-dshr-sheet-overlay') || node.hasAttribute('data-dshr-sheet-panel')) return true;
		if (node.hasAttribute('data-composer-card') || node.hasAttribute('data-composer-seat')) return true;
		if (node.tagName === 'HEADER' || node.tagName === 'NAV') return true;
		return false;
	}

	function isFloatingHost(node) {
		if (!isElement(node) || isLayoutChrome(node) || !isVisible(node)) return false;
		var pos = '';
		try { pos = window.getComputedStyle(node).position; } catch (ignoredPos) { return false; }
		if (pos !== 'fixed' && pos !== 'absolute') return false;
		var rect = node.getBoundingClientRect();
		if (rect.width <= 1 || rect.height <= 1) return false;
		if (rect.width >= window.innerWidth - 4 && rect.height >= window.innerHeight - 4) return false;
		return true;
	}

	function looksLikeMenuRoot(node) {
		if (!isElement(node) || isLayoutChrome(node)) return false;
		if (node.getAttribute('aria-hidden') === 'true') return false;
		if (node.getAttribute('data-state') === 'closed') return false;
		var role = (node.getAttribute('role') || '').toLowerCase();
		if (role === 'menu' || role === 'listbox' || role === 'tree') return true;
		if (node.hasAttribute('data-radix-popper-content-wrapper')) return true;
		if (node.hasAttribute('data-radix-menu-content')) return true;
		if (node.hasAttribute('data-radix-select-content')) return true;
		if (node.hasAttribute('data-radix-dropdown-menu-content')) return true;
		if (node.hasAttribute('data-radix-popover-content')) return true;
		if (node.querySelector('[role="menuitem"], [role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]')) {
			return isFloatingHost(node) || isFloatingHost(node.parentElement);
		}
		return false;
	}

	function findFloatHost(node) {
		var el = node;
		var best = null;
		while (el && el !== document.body && el !== document.documentElement) {
			if (isLayoutChrome(el)) return best;
			if (isFloatingHost(el)) best = el;
			el = el.parentElement;
		}
		return best;
	}

	function collectMenuRoots() {
		if (!document.querySelectorAll) return [];
		var selector = [
			'[role="menu"]',
			'[role="listbox"]',
			'[role="tree"]',
			'[data-radix-popper-content-wrapper]',
			'[data-radix-menu-content]',
			'[data-radix-select-content]',
			'[data-radix-dropdown-menu-content]',
			'[data-radix-popover-content]',
		].join(',');
		var nodes = document.querySelectorAll(selector);
		var roots = [];
		for (var i = 0; i < nodes.length; i++) {
			if (!looksLikeMenuRoot(nodes[i]) || !isVisible(nodes[i])) continue;
			roots.push(nodes[i]);
		}
		return roots;
	}

	function viewportPad() {
		var top = 8;
		var right = 8;
		var bottom = 8;
		var left = 8;
		try {
			var cs = window.getComputedStyle(document.documentElement);
			var insetTop = parseFloat(cs.getPropertyValue('--dshr-inset-top')) || 0;
			var insetBottom = parseFloat(cs.getPropertyValue('--dshr-inset-bottom')) || 0;
			var ime = parseFloat(cs.getPropertyValue('--dshr-ime')) || 0;
			if (insetTop > 0) top += insetTop;
			if (insetBottom > 0) bottom += insetBottom;
			if (ime > 0) bottom += ime;
		} catch (ignoredPad) { /* ignore */ }
		return { top: top, right: right, bottom: bottom, left: left };
	}

	function clampFloatHost(el) {
		if (!isMobileMode() || !isElement(el) || !isVisible(el) || isLayoutChrome(el)) return;
		var pad = viewportPad();
		var vw = window.innerWidth || document.documentElement.clientWidth || 390;
		var vh = window.innerHeight || document.documentElement.clientHeight || 844;
		var bottomLimit = vh - pad.bottom;
		var composer = document.querySelector('[data-composer-card]');
		if (isElement(composer) && isVisible(composer)) {
			var composerRect = composer.getBoundingClientRect();
			if (composerRect.top > 96) bottomLimit = Math.min(bottomLimit, composerRect.top - 8);
		}
		var rect = el.getBoundingClientRect();
		if (rect.width <= 1 || rect.height <= 1) return;
		var maxW = Math.max(160, vw - pad.left - pad.right);
		var maxH = Math.max(96, bottomLimit - pad.top);
		var width = Math.min(rect.width, maxW);
		var height = Math.min(rect.height, maxH);
		var left = rect.left;
		var top = rect.top;
		if (left + width > vw - pad.right) left = vw - pad.right - width;
		if (left < pad.left) left = pad.left;
		if (top + height > bottomLimit) top = bottomLimit - height;
		if (top < pad.top) top = pad.top;
		mark(el, 'data-dshr-float');
		el.style.setProperty('position', 'fixed', 'important');
		el.style.setProperty('left', Math.round(left) + 'px', 'important');
		el.style.setProperty('top', Math.round(top) + 'px', 'important');
		el.style.setProperty('right', 'auto', 'important');
		el.style.setProperty('bottom', 'auto', 'important');
		el.style.setProperty('width', Math.round(width) + 'px', 'important');
		el.style.setProperty('max-width', Math.round(maxW) + 'px', 'important');
		el.style.setProperty('max-height', Math.round(maxH) + 'px', 'important');
		el.style.setProperty('min-width', '0', 'important');
		el.style.setProperty('transform', 'none', 'important');
		el.style.setProperty('margin', '0', 'important');
		el.style.setProperty('box-sizing', 'border-box', 'important');
	}

	function clampFloatingMenus() {
		if (!isMobileMode()) return 0;
		var roots = collectMenuRoots();
		var hosts = [];
		var seen = [];
		function pushHost(node) {
			if (!isElement(node)) return;
			for (var s = 0; s < seen.length; s++) {
				if (seen[s] === node) return;
			}
			seen.push(node);
			hosts.push(node);
		}
		for (var i = 0; i < roots.length; i++) {
			var host = findFloatHost(roots[i]);
			if (host) pushHost(host);
			else if (isFloatingHost(roots[i])) pushHost(roots[i]);
		}
		for (var h = 0; h < hosts.length; h++) clampFloatHost(hosts[h]);
		return hosts.length;
	}

	var floatRaf = 0;
	function scheduleClampFloats() {
		if (floatRaf) return;
		floatRaf = window.requestAnimationFrame(function () {
			floatRaf = 0;
			var count = clampFloatingMenus();
			if (count > 0) scheduleClampFloats();
		});
	}

	// ── 悬浮鲸鱼 + 抽屉外点遮罩（挂在 body 上，不在 React 树内） ──
	function ensureFloatingControls() {
		var doc = document;
		if (!doc.body) return;
		var whale = doc.getElementById('dshr-mobile-whale');
		if (!whale) {
			whale = doc.createElement('button');
			whale.id = 'dshr-mobile-whale';
			whale.type = 'button';
			// 标签刻意区别于官方“打开侧边栏”，避免与 TOGGLE_SELECTOR 撞选择器。
			whale.setAttribute('aria-label', '打开 DSH 侧边栏菜单');
			whale.innerHTML = WHALE_SVG;
			var longPress = null;
			var longPressFired = false;
			var touchMoved = false;
			var touchStartX = 0;
			var touchStartY = 0;
			var suppressClickUntil = 0;
			function cancelLongPress() {
				if (longPress !== null) window.clearTimeout(longPress);
				longPress = null;
			}
			whale.addEventListener('contextmenu', function (event) {
				event.preventDefault();
				cancelLongPress();
				longPressFired = true;
				openAppSettings();
			});
			whale.addEventListener('touchstart', function (event) {
				var touch = event.touches && event.touches[0];
				touchStartX = touch ? touch.clientX : 0;
				touchStartY = touch ? touch.clientY : 0;
				touchMoved = false;
				longPressFired = false;
				cancelLongPress();
				longPress = window.setTimeout(function () {
					longPress = null;
					longPressFired = true;
					openAppSettings();
				}, 650);
			}, { passive: true });
			whale.addEventListener('touchmove', function (event) {
				var touch = event.touches && event.touches[0];
				if (!touch) return;
				if (Math.abs(touch.clientX - touchStartX) > 10 ||
					Math.abs(touch.clientY - touchStartY) > 10) {
					touchMoved = true;
					cancelLongPress();
				}
			}, { passive: true });
			whale.addEventListener('touchcancel', function () {
				touchMoved = true;
				cancelLongPress();
			}, { passive: true });
			whale.addEventListener('touchend', function (event) {
				var shouldToggle = !longPressFired && !touchMoved;
				cancelLongPress();
				if (!shouldToggle) return;
				// Android WebView 不一定会在带 touch 监听器的 fixed 按钮后合成 click；
				// 因此短按在 touchend 内直接切换，并抑制可能随后到达的重复 click。
				event.preventDefault();
				suppressClickUntil = Date.now() + 800;
				toggleSidebar();
			}, { passive: false });
			whale.addEventListener('click', function (event) {
				if (Date.now() < suppressClickUntil) {
					event.preventDefault();
					return;
				}
				toggleSidebar();
			});
			doc.body.appendChild(whale);
		}
		var mask = doc.getElementById('dshr-mobile-drawer-mask');
		if (!mask) {
			mask = doc.createElement('button');
			mask.id = 'dshr-mobile-drawer-mask';
			mask.type = 'button';
			mask.setAttribute('aria-label', '关闭侧边栏遮罩');
			mask.addEventListener('click', function () {
				setSidebarOpen(false);
			});
			doc.body.appendChild(mask);
		}
		var guard = doc.getElementById('dshr-status-guard');
		if (!guard) {
			guard = doc.createElement('div');
			guard.id = 'dshr-status-guard';
			guard.setAttribute('aria-hidden', 'true');
			doc.body.appendChild(guard);
		}
		// MD3 抽屉 drag handle：抽屉展开时钉在交界的 4×32dp 指示条
		// （纯视觉、pointer-events:none，样式见 MOBILE_CSS）。
		var drawerHandle = doc.getElementById('dshr-drawer-handle');
		if (!drawerHandle) {
			drawerHandle = doc.createElement('div');
			drawerHandle.id = 'dshr-drawer-handle';
			drawerHandle.setAttribute('aria-hidden', 'true');
			doc.body.appendChild(drawerHandle);
		}
	}

	function openAppSettings() {
		try {
			if (window.DshRemoteApp && typeof window.DshRemoteApp.openSettings === 'function') {
				window.DshRemoteApp.openSettings();
				return;
			}
		} catch (ignoredBridge) { /* 无 JS 接口时走 URL 白名单 */ }
		try {
			window.location.replace('dsh-remote://app/settings');
		} catch (ignoredNav) {
			window.location.href = 'dsh-remote://app/settings';
		}
	}

	// ── DOM 同步：标记 frame / 侧栏列 / 设置 sheet ──
	var marked = [];
	function mark(node, attribute) {
		if (!isElement(node) || node.hasAttribute(attribute)) return;
		node.setAttribute(attribute, '');
		marked.push([node, attribute]);
		// 剪枝：官方节点（如关闭的弹窗）已从文档移除的标记不再保留。
		if (marked.length > 128) {
			marked = marked.filter(function (entry) { return entry[0].isConnected; });
		}
	}

	function keepActiveSettingsTabVisible(navList) {
		if (!isElement(navList)) return;
		var active = navList.querySelector('button[aria-current="true"]');
		if (!isElement(active)) return;
		var listRect = navList.getBoundingClientRect();
		var activeRect = active.getBoundingClientRect();
		var margin = 4;
		if (activeRect.right > listRect.right - margin) {
			navList.scrollLeft += activeRect.right - listRect.right + margin;
		} else if (activeRect.left < listRect.left + margin) {
			navList.scrollLeft -= listRect.left - activeRect.left + margin;
		}
	}

	/**
	 * 会话头部适配（只用结构特征，不依赖 CSS Module 哈希类名）：
	 *   - header 内含 nav（会话面包屑标题）→ data-dshr-session-header，
	 *     收起态下整体右移，为固定在左上角的鲸鱼按钮让位；
	 *   - 文字恰为「Session log」且带图标的按钮 → data-dshr-session-log，
	 *     手机上收成纯图标下载按钮（文字剪裁保留给读屏）。
	 * 本脚本只由壳 App 注入（UA 含 DSHRemoteAndroid），样式限定在
	 * html.dshr-mobile（仅竖屏），桌面浏览器与平板横屏不受影响。
	 */
	function markSessionChrome() {
		var headers = document.querySelectorAll('header');
		for (var i = 0; i < headers.length; i++) {
			if (headers[i].querySelector('nav') === null) continue;
			mark(headers[i], 'data-dshr-session-header');
		}
		var buttons = document.querySelectorAll('button');
		for (var j = 0; j < buttons.length; j++) {
			var button = buttons[j];
			if (!isSessionLogButton(button)) continue;
			if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Session log');
			mark(button, 'data-dshr-session-log');
		}
		markTeamAction();
		markSessionTabs();
		markJobIndicator();
	}

	/**
	 * 会话页签行（对话 / 轨迹）：官方 0.1.5 是 header 里的 div[role="tablist"]，
	 * 老构建是 header 里的 nav（含 role=tab / aria-selected 的按钮）。
	 * 只标记真正的页签行——header 里的 <nav> 在 0.1.5 是会话面包屑标题，
	 * 误标会把标题行垫出 108px 宽度，越改越挤。
	 */
	function markSessionTabs() {
		var rows = document.querySelectorAll('[role="tablist"]');
		for (var i = 0; i < rows.length; i++) {
			if (rows[i].closest && rows[i].closest('[role="dialog"]')) continue;
			mark(rows[i], 'data-dshr-tabs');
		}
		var navs = document.querySelectorAll('[data-dshr-session-header] nav');
		for (var k = 0; k < navs.length; k++) {
			if (navs[k].querySelector('button[role="tab"], button[aria-selected]') === null) continue;
			mark(navs[k], 'data-dshr-tabs');
		}
	}

	/**
	 * 官方 Agent Team 动作（experimental-client-ui-agent-team 的 TeamAction，
	 * 根节点自带稳定数据属性 data-team-action）：只加标记，交给 CSS 定位到
	 * 页签行右侧。节点留在原 React 树里，官方开合逻辑不受影响。
	 */
	function markTeamAction() {
		var host = document.querySelector('[data-team-action]');
		if (isElement(host)) mark(host, 'data-dshr-agent-team');
	}

	/** 后台任务触发器文案：「N 个后台任务运行中」/「N background jobs running」。 */
	var JOB_COUNT_LABEL = /(\d+)\s*(?:个后台任务|background jobs?)/i;

	/**
	 * 后台任务触发器（会话头部动作，aria-label 带数量）：手机上只保留状态点
	 * 与数量。数量写进 data-dshr-job-n 由 CSS ::after 渲染——不改 React 管的
	 * 文本节点，React 重渲染时不会与它争同一个文本；数量变化会改 aria-label
	 * （观察器已监听该属性），届时重新取数。原句文本与下拉箭头标记后由 CSS 隐藏。
	 */
	function markJobIndicator() {
		var buttons = document.querySelectorAll('button[aria-label]');
		for (var i = 0; i < buttons.length; i++) {
			var button = buttons[i];
			var label = (button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
			var match = JOB_COUNT_LABEL.exec(label);
			if (!match) continue;
			mark(button, 'data-dshr-job-count');
			button.setAttribute('data-dshr-job-n', match[1]);
			var kids = button.children;
			for (var k = 0; k < kids.length; k++) {
				var kid = kids[k];
				if (!isElement(kid)) continue;
				var text = (kid.textContent || '').replace(/\s+/g, ' ').trim();
				if (text === label) {
					mark(kid, 'data-dshr-job-count-text');
					continue;
				}
				// 末尾的纯图形子节点是下拉箭头：手机上省掉，只留状态点 + 数量。
				var last = k === kids.length - 1;
				var glyph = kid.tagName === 'svg' || kid.tagName === 'SVG' || kid.querySelector('svg') !== null;
				if (last && glyph && text === '') mark(kid, 'data-dshr-job-chevron');
			}
		}
	}

	function isSessionLogButton(button) {
		if (!isElement(button) || button.querySelector('svg') === null) return false;
		var label = ((button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('title') || '')).trim();
		if (/session\s*log/i.test(label)) return true;
		var spans = button.querySelectorAll('span');
		for (var i = 0; i < spans.length; i++) {
			var text = (spans[i].textContent || '').replace(/\s+/g, ' ').trim();
			if (text === 'Session log') return true;
		}
		var own = (button.textContent || '').replace(/\s+/g, ' ').trim();
		return own === 'Session log' || own.indexOf('Session log') === 0;
	}

	function isCopyActionButton(button) {
		if (!isElement(button) || button.querySelector('svg') === null) return false;
		var label = (button.getAttribute('aria-label') || '').trim();
		return label === '复制' || label === 'Copy' || label === '复制成功' || label === 'Copied';
	}

	function isSendActionButton(button) {
		if (!isElement(button)) return false;
		var label = (button.getAttribute('aria-label') || '').trim();
		return label === '发送消息' || label === 'Send message' || label === '停止生成' || label === 'Stop generating';
	}

	function looksLikeStatsText(text) {
		var compact = String(text || '').replace(/\s+/g, ' ').trim();
		if (compact.length < 6 || compact.length > 480) return false;
		return (/轮/.test(compact) && /步/.test(compact)) || (/turns/i.test(compact) && /steps/i.test(compact));
	}

	function looksLikeTimingText(text) {
		var compact = String(text || '').replace(/\s+/g, ' ').trim();
		if (compact.length < 4) return false;
		return /用时|首 token|tok\/s|Ran for|TTFT/.test(compact);
	}

	function containsMessageBody(node) {
		if (!isElement(node)) return false;
		for (var i = 0; i < node.children.length; i++) {
			var kid = node.children[i];
			if (!isElement(kid) || kid.tagName === 'BUTTON') continue;
			if (kid.querySelector && kid.querySelector(
				'button[aria-label="复制"], button[aria-label="Copy"], button[aria-label="复制成功"], button[aria-label="Copied"]'
			)) continue;
			var text = (kid.textContent || '').replace(/\s+/g, ' ').trim();
			if (!text || looksLikeTimingText(text)) continue;
			if (text.length > 20) return true;
		}
		return false;
	}

	/**
	 * 输入卡底栏：取「不含 textarea」的最高祖先（仍在 card 内）。
	 * 避免把整张输入卡标成 toolbar，从而把输入框和四键挤成一行。
	 */
	function findComposerToolbar(card, send) {
		var node = send.parentElement;
		var best = null;
		while (node && node !== card) {
			if (node.querySelector('textarea')) break;
			best = node;
			node = node.parentElement;
		}
		return best || send.parentElement;
	}

	/**
	 * 从复制图标按钮向上找到整条操作行（复制/点赞/分支 + 耗时）。
	 * 只认 turn-tail 的直接子行，或「仅含这一条复制按钮」的最近祖先；
	 * 禁止把整列聊天或含消息正文的节点标进去。
	 */
	function findMessageActionsRow(copyButton) {
		var turnTail = copyButton.closest ? copyButton.closest('[data-turn-tail]') : null;
		if (isElement(turnTail)) {
			var child = copyButton.parentElement;
			while (child && child.parentElement !== turnTail) child = child.parentElement;
			if (child && child.parentElement === turnTail && !containsMessageBody(child)) return child;
		}
		var node = copyButton.parentElement;
		for (var hop = 0; hop < 5 && isElement(node); hop++, node = node.parentElement) {
			if (node.querySelector('textarea, [data-composer-card], header, nav')) {
				return copyButton.parentElement;
			}
			var copies = node.querySelectorAll(
				'button[aria-label="复制"], button[aria-label="Copy"], button[aria-label="复制成功"], button[aria-label="Copied"]'
			);
			if (copies.length > 1) return copyButton.parentElement;
			var buttons = node.querySelectorAll('button');
			if (buttons.length > 8) return copyButton.parentElement;
			if (containsMessageBody(node)) return copyButton.parentElement;
			var hasLike = !!node.querySelector(
				'button[aria-label="好的回答"], button[aria-label="Good response"], button[aria-label="有问题的回答"], button[aria-label="Bad response"]'
			);
			if (hasLike || looksLikeTimingText(node.textContent || '')) return node;
		}
		return copyButton.parentElement;
	}

	function markTimingSpans(row) {
		if (!isElement(row)) return;
		var spans = row.querySelectorAll('span');
		var best = null;
		var bestLen = 0;
		for (var i = 0; i < spans.length; i++) {
			var span = spans[i];
			if (span.closest('button')) continue;
			var text = (span.textContent || '').replace(/\s+/g, ' ').trim();
			if (!looksLikeTimingText(text)) continue;
			if (text.length > bestLen) {
				best = span;
				bestLen = text.length;
			}
		}
		if (best) mark(best, 'data-dshr-msg-time');
	}

	/**
	 * 窄屏会话条标记（结构特征，不依赖 CSS Module 哈希类名）：
	 *   - 带「复制」图标按钮的回复操作行 → data-dshr-msg-actions / data-dshr-msg-time；
	 *   - 输入卡片底栏（含发送按钮的那一行）→ data-dshr-composer-row，
	 *     权限按钮 → data-dshr-composer-access；
	 *   - 输入卡片下方「N 轮 · M 步 | …」统计 → data-dshr-stats-line。
	 */
	function markChatChrome() {
		var copyButtons = document.querySelectorAll('button[aria-label]');
		for (var i = 0; i < copyButtons.length; i++) {
			var copyButton = copyButtons[i];
			if (!isCopyActionButton(copyButton)) continue;
			if (copyButton.closest && copyButton.closest('[data-composer-card]')) continue;
			var row = findMessageActionsRow(copyButton);
			if (!isElement(row) || containsMessageBody(row)) continue;
			if (row.querySelectorAll(
				'button[aria-label="复制"], button[aria-label="Copy"], button[aria-label="复制成功"], button[aria-label="Copied"]'
			).length > 1) continue;
			mark(row, 'data-dshr-msg-actions');
			markTimingSpans(row);
		}

		var cards = document.querySelectorAll('[data-composer-card]');
		for (var c = 0; c < cards.length; c++) {
			markComposerCard(cards[c]);
		}

		if (document.querySelector('[data-dshr-stats-line]') === null) markStatsLineFallback();
	}

	var TITLE_SKIP = /^(对话|轨迹|子代理|Chat|Trajectory|Sub-?agents?|Session log|标准模式|计划模式|设置)$/i;

	function clipNoticeText(text, max) {
		var t = String(text || '').replace(/\s+/g, ' ').trim();
		if (t.length <= max) return t;
		return t.slice(0, max - 1) + '…';
	}

	function isAgentRunning() {
		var buttons = document.querySelectorAll('button[aria-label], [data-dshr-composer-send]');
		for (var i = 0; i < buttons.length; i++) {
			var label = (buttons[i].getAttribute('aria-label') || '').trim();
			if (label === '停止生成' || label === 'Stop generating') return true;
			if (label === '停止响应' || label === 'Stop responding') return true;
		}
		return false;
	}

	function readSessionTitle() {
		var header = document.querySelector('[data-dshr-session-header]') || document.querySelector('header');
		if (!isElement(header)) return clipNoticeText(document.title, 48);
		var named = header.querySelector('#session-title, [data-dshr-session-title]');
		if (isElement(named)) {
			var namedText = clipNoticeText(named.textContent, 48);
			if (namedText) return namedText;
		}
		var nodes = header.querySelectorAll('div, span, a, p, h1, h2, h3');
		for (var i = 0; i < nodes.length; i++) {
			var el = nodes[i];
			if (el.closest && el.closest('button')) continue;
			if (el.querySelector && el.querySelector('button, svg, nav, textarea, input')) continue;
			var t = clipNoticeText(el.textContent, 48);
			if (!t || t.length < 2 || TITLE_SKIP.test(t)) continue;
			return t;
		}
		return clipNoticeText(document.title, 48);
	}

	function readLastUserPrompt() {
		var main = document.querySelector('[data-dshr-main-col]');
		if (!isElement(main)) return '';
		var nodes = main.querySelectorAll('div, p');
		var last = '';
		for (var i = 0; i < nodes.length; i++) {
			var el = nodes[i];
			if (el.closest && el.closest('[data-composer-card], [data-composer-seat], header, nav, [data-dshr-msg-actions], [data-dshr-stats-line]')) {
				continue;
			}
			if (el.querySelector && el.querySelector('button, textarea, input, nav, header')) continue;
			var style;
			try { style = window.getComputedStyle(el); } catch (ignoredStyle) { continue; }
			var isUser = style.alignSelf === 'flex-end' || style.textAlign === 'right' || el.id === 'user-msg';
			if (!isUser) continue;
			var t = clipNoticeText(el.textContent, 160);
			if (t.length >= 2) last = t;
		}
		return last;
	}

	function collectSessionNotice() {
		var running = isAgentRunning();
		if (!running) return { title: '', text: '', running: false };
		return {
			title: readSessionTitle() || 'DSH 会话',
			text: readLastUserPrompt() || '正在生成…',
			running: true
		};
	}

	var lastNoticeKey = null;
	var noticeTimer = 0;
	function reportSessionNotice() {
		var notice = collectSessionNotice();
		var key = (notice.running ? '1' : '0') + '\n' + notice.title + '\n' + notice.text;
		if (key === lastNoticeKey) return;
		lastNoticeKey = key;
		try {
			if (window.DshRemoteApp && typeof window.DshRemoteApp.setSessionNotice === 'function') {
				window.DshRemoteApp.setSessionNotice(notice.title, notice.text, notice.running);
			}
		} catch (ignoredNotice) {}
	}

	function scheduleSessionNotice() {
		if (noticeTimer) window.clearTimeout(noticeTimer);
		noticeTimer = window.setTimeout(function () {
			noticeTimer = 0;
			reportSessionNotice();
		}, 180);
	}

	function markComposerCard(card) {
		var send = null;
		var buttons = card.querySelectorAll('button[aria-label]');
		for (var i = 0; i < buttons.length; i++) {
			if (isSendActionButton(buttons[i])) {
				send = buttons[i];
				break;
			}
		}
		if (!send) {
			var statsOnly = card.nextElementSibling;
			if (isElement(statsOnly) && looksLikeStatsText(statsOnly.textContent)) markStatsHost(statsOnly);
			return;
		}
		var row = findComposerToolbar(card, send);
		if (isElement(row) && !row.querySelector('textarea')) mark(row, 'data-dshr-composer-row');
		mark(send, 'data-dshr-composer-send');
		for (var j = 0; j < buttons.length; j++) {
			var label = (buttons[j].getAttribute('aria-label') || '').trim();
			if (label === '命令' || label === 'Commands') mark(buttons[j], 'data-dshr-composer-add');
			if (label.indexOf('访问模式') === 0 || label.indexOf('Access mode') === 0) {
				markAccessChrome(buttons[j]);
			}
		}
		if (isElement(row)) {
			var modelButtons = row.querySelectorAll('button[aria-haspopup="menu"]');
			for (var m = 0; m < modelButtons.length; m++) {
				if (modelButtons[m].hasAttribute('data-dshr-composer-access')) continue;
				if (modelButtons[m].hasAttribute('data-dshr-composer-add')) continue;
				mark(modelButtons[m], 'data-dshr-composer-model');
			}
			markComposerClusters(row);
		}
		var statsHost = card.nextElementSibling;
		if (isElement(statsHost) && looksLikeStatsText(statsHost.textContent)) {
			markStatsHost(statsHost);
		}
	}

	function markAccessChrome(btn) {
		if (!isElement(btn)) return;
		mark(btn, 'data-dshr-composer-access');
		var kids = btn.children;
		for (var k = 0; k < kids.length; k++) {
			if (kids[k].tagName !== 'SPAN') continue;
			if (kids[k].querySelector('svg')) continue;
			mark(kids[k], 'data-dshr-composer-access-label');
		}
		var svgs = btn.querySelectorAll('svg');
		if (svgs.length < 2) return;
		var chevron = svgs[svgs.length - 1];
		var wrap = chevron.parentElement;
		if (isElement(wrap) && wrap !== btn && wrap.querySelectorAll('svg').length === 1) {
			mark(wrap, 'data-dshr-composer-access-chevron');
		} else {
			mark(chevron, 'data-dshr-composer-access-chevron');
		}
	}

	function markComposerClusters(row) {
		if (!isElement(row)) return;
		var kids = row.children;
		for (var i = 0; i < kids.length; i++) {
			var kid = kids[i];
			if (!isElement(kid) || kid.tagName === 'BUTTON' || kid.tagName === 'TEXTAREA') continue;
			if (
				kid.hasAttribute('data-dshr-composer-send') ||
				kid.hasAttribute('data-dshr-composer-model') ||
				kid.querySelector('[data-dshr-composer-send], [data-dshr-composer-model]')
			) {
				mark(kid, 'data-dshr-composer-trailing');
			}
			if (
				kid.hasAttribute('data-dshr-composer-add') ||
				kid.hasAttribute('data-dshr-composer-access') ||
				kid.querySelector('[data-dshr-composer-add], [data-dshr-composer-access]')
			) {
				mark(kid, 'data-dshr-composer-tools');
			}
		}
	}

	function markStatsHost(host) {
		if (!isElement(host)) return;
		var inner = host;
		var kids = host.children;
		while (kids.length === 1 && looksLikeStatsText(kids[0].textContent)) {
			inner = kids[0];
			kids = inner.children;
		}
		mark(inner, 'data-dshr-stats-line');
	}

	function markStatsLineFallback() {
		var seat = document.querySelector('[data-composer-card], [data-composer-seat]');
		var root = seat && seat.parentElement ? seat.parentElement : document;
		var nodes = root.querySelectorAll('div');
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			if (node.querySelector('button, textarea, input, nav, header')) continue;
			if (!looksLikeStatsText(node.textContent)) continue;
			if (node.children.length > 12) continue;
			markStatsHost(node);
			return;
		}
	}

	function syncDom() {
		var root = document.documentElement;
		var frame = findFrame();
		if (frame) {
			mark(frame, 'data-dshr-frame');
			var collapsed = frame.hasAttribute('data-sidebar-collapsed');
			if (collapsed) mark(frame, 'data-dshr-collapsed');
			else frame.removeAttribute('data-dshr-collapsed');
			root.setAttribute('data-dshr-ready', '1');
			root.setAttribute('data-dshr-expanded', collapsed ? '0' : '1');
			var sidebarColumn = findSidebarCol(frame);
			mark(sidebarColumn, 'data-dshr-sidebar-col');
			var mainColumn = findMainCol(frame);
			mark(mainColumn, 'data-dshr-main-col');
			var officialToggle = findToggleControl();
			if (officialToggle && sidebarColumn && sidebarColumn.contains(officialToggle)) {
				mark(officialToggle, 'data-dshr-official-toggle');
				root.setAttribute('data-dshr-has-official-toggle', '1');
			} else {
				root.setAttribute('data-dshr-has-official-toggle', '0');
			}
			if (frame.hasAttribute('data-dshx-overlay')) {
				root.setAttribute('data-dshr-explorer-details', '1');
				clearDrawerVisual();
			} else {
				root.removeAttribute('data-dshr-explorer-details');
			}
			// 官方右侧栏全屏（0.1.3+ 的文件树/文档预览）时收起本脚本的悬浮控件。
			if (frame.hasAttribute('data-rightbar-fullscreen')) {
				root.setAttribute('data-dshr-rightbar-fullscreen', '1');
			} else {
				root.removeAttribute('data-dshr-rightbar-fullscreen');
			}
		} else {
			// frame 未找到：保持 body 兜底 padding 生效，内容不顶进状态栏。
			root.removeAttribute('data-dshr-ready');
			root.setAttribute('data-dshr-expanded', '0');
			root.setAttribute('data-dshr-has-official-toggle', '0');
			root.removeAttribute('data-dshr-explorer-details');
			root.removeAttribute('data-dshr-rightbar-fullscreen');
		}

		if (typeof document.querySelectorAll !== 'function') return;
		var dialogOpen = false;
		var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
		for (var i = 0; i < dialogs.length; i++) {
			var dialog = dialogs[i];
			// 只统计当前可见的模态框；隐藏的弹窗残留不得触发"弹窗打开"状态。
			if (!isVisible(dialog)) continue;
			var nav = dialog.querySelector('nav');
			// 设置面板特征：模态框内带 nav，nav 里有一组分区按钮（官方用
			// aria-current 标记当前分区；旧构建可能没有，故只按按钮数量判断）。
			if (!nav) continue;
			var navButtons = nav.querySelectorAll('button');
			if (!navButtons || navButtons.length < 2) continue;
			dialogOpen = true;
			mark(dialog.parentElement, 'data-dshr-sheet-overlay');
			mark(dialog, 'data-dshr-sheet-panel');
			mark(nav, 'data-dshr-sheet-nav');
			var navKids = nav.children;
			var navList = null;
			if (navKids.length >= 2) {
				mark(navKids[0], 'data-dshr-sheet-nav-title');
				navList = navKids[1];
				mark(navList, 'data-dshr-sheet-nav-list');
			} else if (navKids.length === 1) {
				navList = navKids[0];
				mark(navList, 'data-dshr-sheet-nav-list');
			}
			keepActiveSettingsTabVisible(navList);
			var content = nav.nextElementSibling;
			if (content && isElement(content)) {
				mark(content, 'data-dshr-sheet-content');
				if (content.children.length >= 2) {
					mark(content.children[0], 'data-dshr-sheet-header');
					mark(content.children[1], 'data-dshr-sheet-options');
				} else if (content.children.length === 1) {
					mark(content.children[0], 'data-dshr-sheet-options');
				}
			}
		}
		root.setAttribute('data-dshr-dialog', dialogOpen ? '1' : '0');
		if (dialogOpen) clearDrawerVisual();
		// 不在打开设置时收起侧栏：全屏设置页直接盖住浮层，避免先闪回会话。
		markSessionChrome();
		markChatChrome();
		ensureFloatingControls();
		ensureGestures();
		maybeAutoCloseOnSessionChange();
		scheduleClampFloats();
		syncPageTheme();
		scheduleSessionNotice();
	}

	var lastPageDark = null;
	function syncPageTheme() {
		var dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme'));
		if (dark === lastPageDark) return;
		lastPageDark = dark;
		document.documentElement.setAttribute('data-dshr-dark', dark ? '1' : '0');
		try {
			if (window.DshRemoteApp && typeof window.DshRemoteApp.setPageDark === 'function') {
				window.DshRemoteApp.setPageDark(dark);
			}
		} catch (ignoredTheme) {}
	}

	// 注入可能早于 body/React 首帧。观察器必须在 body 出现后补装，不能只在
	// 脚本首次执行时尝试一次；否则初始标记虽能由 boot 补齐，后续展开状态无人同步。
	var observer = null;
	function startObserver() {
		if (observer !== null) return true;
		if (typeof MutationObserver === 'undefined' || !document.body) return false;
		observer = new MutationObserver(syncDom);
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: [
				'data-sidebar-collapsed',
				'data-dshx-overlay',
				'data-rightbar-fullscreen',
				'data-rightbar-open',
				'data-ds-dark-theme',
				'role',
				'aria-modal',
				'aria-current',
				'data-state',
				'aria-expanded',
				'aria-label',
			],
			childList: true,
			subtree: true,
		});
		document.documentElement.setAttribute('data-dshr-observer', '1');
		return true;
	}

	var bootTicks = 0;
	function boot() {
		var observing = startObserver();
		syncDom();
		var ready = document.documentElement.getAttribute('data-dshr-ready') === '1';
		if (ready && observing) return;
		if (bootTicks < 40) {
			bootTicks += 1;
			window.setTimeout(boot, 300);
		}
	}
	boot();
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () {
			startObserver();
			syncDom();
		});
	} else {
		startObserver();
	}
	window.addEventListener('resize', function () {
		applyWidthScope();
		syncDom();
	});
	if (portraitMql) {
		var onOrient = function () {
			applyWidthScope();
			syncDom();
		};
		if (portraitMql.addEventListener) portraitMql.addEventListener('change', onOrient);
		else if (portraitMql.addListener) portraitMql.addListener(onOrient);
	}
	try {
		var themeMq = window.matchMedia('(prefers-color-scheme: dark)');
		var onScheme = function () { window.setTimeout(syncPageTheme, 0); };
		if (themeMq.addEventListener) themeMq.addEventListener('change', onScheme);
		else if (themeMq.addListener) themeMq.addListener(onScheme);
	} catch (ignoredMq) {}

	// ── 壳 App 返回键桥接（与既有 MainActivity 契约保持一致） ──
	window.__dshRemoteAndroidMobile = {
		closeSidebarIfExpanded: function () {
			var sheet = document.querySelector('[data-dshr-sheet-panel]');
			if (sheet && isVisible(sheet)) {
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
				return true;
			}
			if (isExplorerDetailsOpen()) {
				var explorerClose = document.querySelector('.dshx-overlay-close');
				if (explorerClose) {
					explorerClose.click();
					return true;
				}
			}
			var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
			for (var i = 0; i < dialogs.length; i++) {
				if (!isVisible(dialogs[i])) continue;
				// 设置等模态框官方都监听 document 级 Escape。
				document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
				return true;
			}
			if (isSidebarOpen()) return setSidebarOpen(false);
			return false;
		},
		openSidebarIfCollapsed: function () {
			if (!isMobileMode() || isDrawerLocked()) return false;
			if (isSidebarOpen()) return true;
			return setSidebarOpen(true);
		},
		considerSwipe: considerSwipe,
		setDrawerDrag: function (progress) {
			var p = Math.max(0, Math.min(1, Number(progress) || 0));
			return setDrawerVisual(p * drawerMaxShift());
		},
		clearDrawerDrag: clearDrawerVisual,
		settleDrawer: settleDrawer,
		syncNow: syncDom,
		syncViewport: function () {
			applyWidthScope();
			syncDom();
		},
		clampFloatingMenus: clampFloatingMenus,
		applyImeLift: applyImeLift,
		readSessionNotice: collectSessionNotice,
		imeLiftRect: imeLiftRect,
	};
})();
