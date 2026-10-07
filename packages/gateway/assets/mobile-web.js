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
 *   - 设备档位（schema v2）：原生在注入前写 window.__DSHR_MOBILE__.device
 *     （'phone' | 'tablet' | 'auto'，缺省 'auto'）。'tablet' 任意朝向都走官方
 *     DSH 桌面布局（本脚本在 OFF 态逐项拆除自身痕迹，见 teardownHookTraces）；
 *     'phone' 竖屏启用、横屏 OFF；'auto' 完全等价于本文件改动前的既有行为，
 *     web/edge 路径逐字节不变。档位只由原生判定，JS 侧不看视口宽度（WEB-02）。
 *   - 运行时切换：window.__dshrSetDevice(mode) 幂等重算，hook 未装完时先落
 *     配置、装完后按最新值生效（不抛错），供原生 onConfigurationChanged 调用。
 *   - 平板档唯一例外（T97，用户明确授权「平板允许有 hook 改动」）：平板档**只**
 *     多挂一个事件监听器——左上角官方品牌区（鲸鱼 + 「deepseek HARNESS」）
 *     **长按 600ms = 打开 App 连接设置页**，**单击仍是官方原本的「新建会话」**；
 *     该特性不写任何 DOM（节点 / 属性 / 类名 / 样式规则零新增），其余平板档能力
 *     仍全部关闭（含 window.WebSocket 包装）。详见 syncBrandLongPress 一段。
 *   - 平板档第二处例外（T101，用户明确授权「允许最小 hook」）**已删除**：
 *     原来多 2 条 CSS 规则（官方会话主区 28px 圆角面板 + 官方 frame 铺左侧栏底色）。
 *     用户实测否决：「主 session 左上/左下那个圆角跟左侧栏直线对不上」——官方桌面布局
 *     的主区列本来就是直角，圆角是我们自己加的装饰，不是原生。两条规则整段删除，
 *     平板档绘制回到官方原生（见 MOBILE_CSS 里「T101 平板档圆角已删除」一段）。
 *     剩下那组让位规则与四个 inset 变量是 T115 的，不动。
 *   - 平板档第三处例外（T115，用户口径「系统栏走安卓原生透明 + 页面自己让位」）：
 *     平板档的系统栏让位从「原生给 WebView 留外边距」改为「**页面自己让位**」。
 *     轨迹增量仍然只有两样，且都在既有载体里：
 *       ① <html> 上四个 CSS 自定义属性 `--dshr-inset-top/-bottom/-left/-right`
 *          （由原生 __dshRemoteInsets.set 写入；手机档本来就是这么用的，语义逐字同源）；
 *       ② <style data-dshr-mobile-css> 里多一组以同一个平板作用域
 *          `html:not(.dshr-mobile):not(.dshr-official-inset)` 开头的规则，让官方三列
 *          自己把内容让开系统栏（背景画进 padding）。**不新增 DOM 节点 / 类名 /
 *          data-dshr-* 属性**，元素锚点仍走官方结构属性（单层 :has()）。
 *     为什么必须改：原生留外边距时，系统栏后面那一圈只剩父容器**一种**底色，而平板官方
 *     布局贴边那一行本来就是**两色**（左栏 --dsw-specific-sidebar-fill / 面板
 *     --dsw-alias-bg-base）⇒ 单色带必然在面板那一侧留一道硬缝（T115 实测 2560 宽里
 *     1919 px = 75.0% 与页面差 ΔRGB=(6,5,4)）。让页面自己画这两条带，ΔRGB=0 是构造性的。
 *     T97 的事件监听器、T115 的四个变量与一组规则就是平板档的**全部** hook 痕迹
 *     （T101 的 2 条圆角规则已删，见下）。
 *   - 手机档「长按 = 进 App 连接设置页」的两处入口（T103，用户口径「进连接设置只保留
 *     长按这一条路」，取消返回键入口由 T102 完成）：
 *     ① **悬浮鲸鱼长按**（既有 650ms 行为，T103 补两处防误触：长按触发后那次
 *        合成 click 被吞，不再顺带给抽屉做 toggle（改前实测会顺带把侧栏打开）；
 *        多指（第二根手指落在任何地方）即刻取消长按 —— 后者用**手势进行中的临时**
 *        document 守卫实现，常态监听器数量不变）；
 *     ② **左上角品牌区长按 600ms**：T97 那段代码的档位闸由「只平板档」放宽为
 *        「平板档 + 手机档（hook 启用态）」，复用**同一个** document touchstart
 *        监听器，不新增监听器、不写 DOM、阈值/取消条件/click 抑制逐字未改；
 *        手机横屏与 auto 档照旧一个监听器都不挂。
 *
 * 设计目标：不依赖服务器端是否安装 dsh-remote-plugin。手机连接任何官方 DSH Web
 * （装或不装插件）都由本脚本完成移动适配：
 *   1. 按上述平台规则启用 hook；宽视口/横屏（按平台）去掉适配类，走官方 DSH
 *      桌面布局
 *   2. 桌面端收起后的 56px rail 压到 0，用左上角悬浮鲸鱼打开侧栏
 *      （不把官方按钮拖到顶栏，避免官方 Harness 布局在窄屏错位）；
 *   3. 用户直接点击官方按钮产生可信事件；展开侧栏时采用 Kimi App 式
 *      「侧栏静止垫底、会话栏圆角浮层滑开」：主会话卡高度不变、只向右平移，
 *      圆角/阴影随位移全程渐变；中间列可跟手拖动，松手后吸附开/关；
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
 *   8. 手机宽度下主屏幕右划打开左侧栏（会话卡高度不变、圆角平移滑出，
 *      静止垫底的侧栏被揭示）；左划打开右抽屉（官方文件栏卡片从右缘滑入）；
 *      点侧栏里的会话后自动收起，直接露出对话，不必再点遮罩或鲸鱼；
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
 *  15. 官方右侧栏（0.1.3+ 文件树/文档预览，[data-sidebar-right-panel]）在手机档
 *      （<768px 官方 fullscreen 态）重构为「右抽屉卡片」：与左抽屉镜像的 Kimi 式
 *      交互——面板 = 盖在主会话卡**上方**的圆角卡片（右锚、宽 100%-52px、左缘
 *      圆角），左滑从右缘跟手滑入、右滑跟手关闭，左缘 52px 遮罩点按关闭；
 *      面板自己垫出 --dshr-inset-top/-bottom，标题行不顶状态栏、底部不压导航栏；
 *      卡片态期间收起悬浮鲸鱼。宽屏（≥768px push/docked）不吃卡片态，官方原样。
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
// T56（治本）：document-start 注入时 <html> 可能还不存在。
//
// 旧形态把幂等守卫 `window.__dshRemoteMobileInstalled = true` 放在 IIFE **第一行**、
// 无条件置位，而第一处写 DOM 的语句（样式挂载 ~(document.head || document.documentElement)
// .appendChild）位于其后约 800 行。一旦注入落在这 800 行的空档里而 documentElement 仍是 null，
// 那一行就抛「TypeError: Cannot read properties of null (reading 'appendChild')」，
// 整段初始化在**守卫已置位**的状态下夭折 ⇒ 本文档此后每一次注入都是空操作，hook 永远装不上。
// 原生症状：重连/会话内导航后界面退回官方桌面布局、悬浮鲸鱼消失，重连不愈，杀 App 重开才恢复。
//
// 治本：**守卫不再无条件置位**。<html> 未就绪时不置守卫、不往下走任何一行 DOM 代码，
// 只挂一个「一次性重启」——就绪后由 relaunch 重新进入同一个**具名函数表达式**
// （函数名在自己的作用域内可见，因此正文可以原地重入）：
//   - DOMContentLoaded：真实文档里 documentElement 为 null 时它必然还没触发，信号可靠；
//   - 有界轮询兜底：万一该文档不触发 DOMContentLoaded，24s 内仍要自愈，不要静默丢失 hook。
// 下面 4300 行正文**一行未改、执行顺序完全不变**（只挪进了具名函数表达式），
// 所以 hook 的既有行为——手机档全部能力、平板档零痕迹、T42/T47/T48/T51 的键盘与手势语义——不变。
//
// 幂等性由两道闸保证：
//   ① 已装上（__dshRemoteMobileInstalled）→ 直接 return；
//   ② 尚未就绪时的重复 document-start 注入 → 由 __dshRemoteMobilePending 去重，
//      只会续上同一个重启，不会排第二份；重启真正执行时 ① 会把后来的重启挡掉。
// 另外「就绪后才到的注入」不等任何重启，直接就地装上（late 注入路径照旧）。
(function dshRemoteMobileBoot() {
	'use strict';
	// ── T90 自检状态（**必须在第一行之前**赋值）────────────────────────────────
	// `installWsStateWatch()` 是本函数体的第一件事（见下面那次调用），它要用到这三个值：
	//   · WS_WATCH_KEY      自检全局键（只读快照，不参与任何业务判断）；
	//   · WS_CONNECT_GRACE_MS CONNECTING 允许时长：socket 已构造、迟迟没 open，超过它才按"断"算；
	//   · WS_CLOSE_GRACE_MS  T112：**已 OPEN** 的 socket 关掉之后的宽限期（会话切换 / 页面内
	//     导航 / SW 更新都会让页面自己重建 socket，新 socket 在宽限内 open 就不该算断）；
	//   · wsWatchState      观测状态（closure 里的活引用；`window.__dshrWsWatch` 指向它）。
	// （`var` 提升只提升声明不提升赋值，所以不能把赋值留在下面那段里。）
	//
	// T112 取值依据（本轮"频繁重连"修复，原始真值见 scratch/t112/report.md）：
	//   · 2000 → 8000：真机 + 中转链路上一次 TCP+WSS 握手超过 2s 并不稀奇，而 2s 判"断"
	//     会把它报成断线；8s 与"卡住自救升级"的节奏（T96：nudge → 12s 重载）相容。
	//     放宽**不会**漏掉真断线：连不上时 TCP 失败必然紧跟 close/error（close 宽限那条管着），
	//     这里兜的是"对端收下 SYN 却不回 handshake"的半死链路，8s 足够早。
	var WS_WATCH_KEY = '__dshrWsWatch';
	var WS_CONNECT_GRACE_MS = 8000;
	var WS_CLOSE_GRACE_MS = 1500;
	var wsWatchState = null;
	// 包装标记：挂在**包装器自己**上，供 pending 重启后的第二次进来"认领"同一个状态对象。
	// 用 `Symbol.for` 而不是字符串属性：`Object.getOwnPropertyNames(WebSocket)` 是**可枚举的
	// 面**（第三方脚本/自检会拿它比对），多两个自有属性就是透传上的可见偏差；符号属性
	// 不进 getOwnPropertyNames ⇒ 自有属性集合与原生**逐条相同**（T90 真值台有断言）。
	// 老引擎没有 Symbol 时回落到字符串属性（仍能工作，只是多两个自有键）。
	var WS_WATCH_MARK = null;
	try {
		WS_WATCH_MARK = (typeof Symbol === 'function' && typeof Symbol.for === 'function')
			? Symbol.for('dshr.wsWatch.state') : null;
	} catch (ignoredWsSymbol) { WS_WATCH_MARK = null; }

	// T90：**连接态信号源**（UI 无关）必须在最早一步装上，且必须在下面这条
	// pending 早退**之前** —— 文档还没给出 <html> 时本函数会先返回、等
	// DOMContentLoaded 再进来，而 app 的 WebSocket 有可能在那之后、本次
	// 重启之前就被建出来（T27-B 的"半装"窗口同理）。函数声明提升保证可用；
	// 它只读 window、不依赖本文后面才赋值的任何变量。平板档在里面直接跳过。
	installWsStateWatch();
	if (window.__dshRemoteMobileInstalled) return;
	if (document.documentElement) {
		window.__dshRemoteMobilePending = false;
		window.__dshRemoteMobileInstalled = true;
	} else {
		if (window.__dshRemoteMobilePending) return;
		window.__dshRemoteMobilePending = true;
		var relaunch = function () {
			if (window.__dshRemoteMobilePending !== true) return;
			window.__dshRemoteMobilePending = false;
			dshRemoteMobileBoot();
		};
		document.addEventListener('DOMContentLoaded', relaunch, { once: true });
		// 24s 上限（1500 × 16ms）：到点仍未给出 <html> 的，多半是非 HTML 文档或文档已被丢弃。
		// 此时放弃等待并清掉 pending，让**下一次**原生注入从头再来，而不是留一个永转的定时器。
		var pendingTries = 0;
		var pendingPoll = function () {
			if (window.__dshRemoteMobilePending !== true) return;
			// 单条不重排的轮询：最多 1500 × 16ms ≈ 24s。每 tick 只判一次「<html> 到了没」，
			// 到了（或到上限）就 relaunch；relaunch 内部才可能重新武装，因此最坏情况是
			// 每 24s 多挂一个一次性监听，不会无界增长。
			if (pendingTries < 1500 && !document.documentElement) {
				pendingTries += 1;
				window.setTimeout(pendingPoll, 16);
				return;
			}
			relaunch();
		};
		window.setTimeout(pendingPoll, 16);
		return;
	}

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
		// ── T91：卡片圆角半径（唯一源） ──
		// 20px 的依据是**官方自己同一族表面的实测值**（真机 getComputedStyle 扫全页非零圆角，
		// 真值见 report §1）：整宽会话卡 `geFEbW_entry`（364×67）= **20px**、
		// 输入卡 `uV2eYG_card`（373×110）= 28px、小图标按钮 8~12px。
		// 取 20px ⇒ 主卡与抽屉右缘跟官方「整宽卡片」同值：不比官方更方，也不大过
		// 官方大卡（28px）。16px 偏保守、两张卡的交界缺口几乎看不出来；
		// 24~28px 时 2R=48~56px 的缺口会在顶端把抽屉右缘咬掉一大块。
		// 与改动前的 18px 只差 2px ⇒ 打开终态的观感连续，不是换了一套皮肤。
		'  --dshr-card-r: 20px;',
		// ── T105：`--dshr-seam` 与它的 frame::after 暗底**整块删除** ──
		// T91 铺那层暗底，是因为它把抽屉右缘也做成了圆角：两张同色圆角卡在交界处对拼，
		// 两条圆弧之间的缺口若还是同一个灰就看不出来，于是用一层暗色去"描出缝"。
		// 但用户明确否掉了这个形态（"各自是各自的圆角矩形"）：现在接缝处**只有卡片自己的圆角**
		// （抽屉是被压在下面的整块背景），缺口里露出的就该是抽屉底色本身，
		// 留着暗底反而会在卡片左上角外侧画出一块多余的深色。故 token 与伪元素一起删。
		'  color-scheme: light dark;',
		'  -webkit-text-size-adjust: 100%;',
		'  text-size-adjust: 100%;',
		'}',
		// 表面色必须走官方会随深浅切换的 token。`--dsw-specific-background` 在
		// DSH 里经常不存在，写成它的 fallback 会把设置页钉死成白底，深色字就看不见。
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"] { color-scheme: dark; }',
		'html.' + ROOT_CLASS + '[data-dshr-dark="0"] { color-scheme: light; }',
		// DSH 主题标记出现前（启动 splash / 插件加载）按系统深浅铺底，
		// 否则系统深色下状态栏 inset 区域会闪出一条白底。
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"]:not([data-dshr-ready="1"]) { background: #141414; }',
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"]:not([data-dshr-ready="1"]) body { background: #141414; }',
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
		'html.dshr-official-inset[data-dshr-dark="1"]:not([data-dshr-ready="1"]) [data-dshr-sidebar-col],',
		'html.dshr-official-inset[data-dshr-dark="1"]:not([data-dshr-ready="1"]) [data-dshr-main-col],',
		'html.dshr-official-inset[data-dshr-dark="1"]:not([data-dshr-ready="1"]) [data-dshx-details-col] {',
		'  background: #141414 !important;',
		'}',
		'html.dshr-official-inset[data-dshr-dark="1"] [data-dshr-main-col],',
		'html.dshr-official-inset[data-dshr-dark="1"] [data-dshx-details-col] {',
		'  background: var(--dsw-alias-bg-base, #111318) !important;',
		'}',
		// 横屏保留桌面布局，但系统导航栏仍须避让；各列背景延伸至透明导航栏后。
		'html.dshr-official-inset [data-dshr-sidebar-col],',
		'html.dshr-official-inset [data-dshr-main-col],',
		'html.dshr-official-inset [data-dshx-details-col] {',
		'  box-sizing: border-box !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'}',
		'html.dshr-official-inset:not([data-dshr-ready="1"]) body {',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'}',
		// ── T101 平板档圆角**已删除**（用户口径：「主 session 左上/左下那个圆角跟左侧栏
		// 直线对不上」）──
		// 删掉的是 T101 加的那 2 条规则：
		//   ① `div:has(> [data-shell-overlay])` 铺左侧栏底色；
		//   ② `div:has(> [data-slot="main"])` 的 28px 圆角 + corner-shape + overflow 钉死。
		// 两条是设计上的一对（① 负责给 ② 的圆角缺口垫同色），② 没了 ① 就没有留下的理由，
		// 一起删 = 平板档绘制彻底回到官方原生（官方桌面布局的主区列本来就是直角，圆角是
		// 我们借官方面板 token 装饰出来的，不是原生做法）。
		// 探针侧无影响：T94 的 x=2 取色读的是列本身的颜色，frame 底色只在列盖不住的缝里才可见，
		// 稳态三列铺满时 frame 根本不露面；T115 的让位 padding 与列底色规则一字未动。
		// ── T115：平板档系统栏让位（用户口径「系统栏走安卓原生透明 + 页面自己让位」）──────
		// 契约变更（与 T101 同源授权）：平板档由「原生给 WebView 让位」改为「**页面自己让位**」。
		// 原生侧 T115 起把 WebView 四向外边距恒写 0（覆盖全窗）、把系统栏四向 inset（CSS px）
		// 写进 <html> 的 --dshr-inset-*；这里让**三列自己**把内容让开系统栏。
		//
		// 为什么让的是「列」而不是「frame」：系统栏后面那一圈现在由**页面自己画**，
		// 而带该是什么颜色取决于它压在哪一列上——左侧栏是 --dsw-specific-sidebar-fill，
		// 会话面板是 --dsw-alias-bg-base，两色不同。所以四向 padding 必须落在**列**上
		// （列自带背景 ⇒ 背景画进 padding、一直铺到 y=0 / y=100%），而不是落在 frame 上
		// （frame 只有一种底色，垫在它身上必然让某一边露出异色）。
		// box-sizing: border-box 是硬要求：三列的官方高度是 100%，不加它 padding 会把列撑高。
		//
		// 作用域仍是 `html:not(.dshr-mobile):not(.dshr-official-inset)`（恰好等于 deviceMode==='tablet'），
		// 规则住在**既有的** <style data-dshr-mobile-css> 里 ⇒ 不新增 DOM 节点 / 类名 /
		// data-dshr-* 属性；元素锚点全部走官方结构属性（单层 :has()），不碰 CSS module 哈希类名。
		// 值语义与手机档逐字同源：var(--dshr-inset-*, env(safe-area-inset-*, 0px))。
		// T126：右栏列加第二锚点 `div:has(> [data-sidebar-right-panel])` —— 官方 docked
		// 右栏的列直接子节点不一定带 `data-slot="rightbar"`（以面板自身属性为准才是稳定的；
		// 左栏/主列沿用 data-slot 锚点，那两列经用户实测让位正常，不动）。
		// 两条候选命中同一 div 时声明逐字相同 ⇒ 幂等，不存在双重 padding。
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-slot="sidebar"]),',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-slot="main"]),',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-slot="rightbar"]),',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-sidebar-right-panel]) {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'  padding-left: var(--dshr-inset-left, env(safe-area-inset-left, 0px)) !important;',
		'  padding-right: var(--dshr-inset-right, env(safe-area-inset-right, 0px)) !important;',
		'}',
		// 会话面板列官方自己的 background 是 transparent（白底在更深的子节点上）⇒ 只垫 padding
		// 会把 frame 的侧栏底色透出来，形成一条新的异色带。这里显式给列铺上和「面板同源」的
		// 官方 token（与手机档 [data-dshr-main-col] 用的是同一个），padding 区因此也是面板色。
		// 右侧栏列同源（手机档 [data-sidebar-right-panel] 用的也是这个 token）。
		// T126：与上一组 padding 规则同理，右栏列背景补第二锚点。
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-slot="main"]),',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-slot="rightbar"]),',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) div:has(> [data-sidebar-right-panel]) {',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'}',
		// 深色档不另写规则（与 T101 同口径）：--dsw-alias-bg-base / --dsw-specific-sidebar-fill
		// 都由官方主题定义在 body 上并随深浅切换，上面那条 !important 取的就是同一个 token。
		// 也不能用 html[data-dshr-dark] —— 平板档走 teardownHookTraces，那个属性会被摘掉。
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
		// 平板档同样要垫：syncDom 在严格 OFF 下直接返回（无 data-dshr-* 标记），
		// 所以平板这条走纯结构选择器（官方自己的 =fullscreen 值，不依赖任何 hook 标记）；
		// 背景走同一个官方 token，深浅色由 token 自己跟随（平板不挂 data-dshr-dark）。
		'html.dshr-official-inset [data-sidebar-right-panel="fullscreen"],',
		'html.' + ROOT_CLASS + ' [data-sidebar-right-panel="fullscreen"],',
		'html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset) [data-sidebar-right-panel="fullscreen"],',
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] [data-sidebar-right-panel] {',
		'  box-sizing: border-box !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  padding-bottom: var(--dshr-inset-bottom, env(safe-area-inset-bottom, 0px)) !important;',
		'  background: var(--dsw-alias-bg-base, var(--dsw-specific-background, #ffffff)) !important;',
		'}',
		'html.' + ROOT_CLASS + '[data-dshr-dark="1"] [data-sidebar-right-panel] {',
		'  background: var(--dsw-alias-bg-base, #111318) !important;',
		'}',
		// 右侧栏卡片态时收起悬浮鲸鱼（它在左上角，会压在左缘细条上）。
		// 遮罩与拖动手柄**不再**一起藏：T130 起它们是右抽屉的关闭细条与交界指示
		// （见下方 data-dshr-ropen 两条规则）。
		'html.' + ROOT_CLASS + '[data-dshr-rightbar-fullscreen="1"] #dshr-mobile-whale {',
		'  display: none !important;',
		'}',		// 兜底：结构探测暂时失败（frame 未标记）时，body 自身让出状态栏，
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
		// ── T105：抽屉**不再有右缘圆角**，也没有任何裁剪 ──
		// T91 在这里给了抽屉右缘 20px 圆角 + `clip-path: inset(inset-top 0 0 0 round 0 R R 0)`。
		// 真机像素证据（scratch/t105/shots/t105-hold-base-hold.png）：接缝处于是变成
		// **两张圆角卡对拼**——抽屉右缘一条弧、卡片左缘一条弧，中间还夹着一条暗缝，
		// 正是用户说的"各自是各自的圆角矩形"。
		// 用户要的是「主会话 = 一张圆角卡片浮在官方左侧栏**之上**」⇒ 抽屉还原成
		// 「被压在下面的整块背景」：背景铺满自己的盒子（顶到 y=0，与官方原生侧栏同形），
		// 右缘是**直线**，圆角只属于卡片那一张。故 border-radius 与 clip-path 一起删。
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
		'  border-radius: var(--dshr-card-r, 20px) !important;',
		'  box-shadow: -14px 0 36px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04) !important;',
		'  overflow: hidden !important;',
		// T82：这里原来有 margin-top/bottom: 8px。它把**展开态**的会话浮层整体下推 8px，
		// 而 header 也在这张卡片里 ⇒ 打开抽屉时 header.y 从 54 跳到 62，松开后**不回落**。
		// 真值见 scratch/t82/report.md §B。删掉即可，不要用 translateY(8px) 反向补偿——
		// 那只是把 header 一起推下去，位移还在，只是换了来源。
		// max-height 同步从 calc(100% - 16px) 提到 100%：原来那 16px 就是给上下 margin 让位的，
		// margin 没了还留着会让卡片底部空出 16px。
		//
		// ── T105：终态卡片背景同样铺到 y=0（与拖动期 p=1 的算式**逐字一致**，交接零台阶） ──
		// margin-top = −inset、padding-top = +inset、max-height = 100% + inset
		// —— 把 `--dshr-card-p` 取 1 代进拖动块那三条，就是这三个值（真机交接台阶真值见 §4.1）。
		'  margin-top: calc(-1 * var(--dshr-inset-top, env(safe-area-inset-top, 0px))) !important;',
		'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;',
		'  max-height: calc(100% + var(--dshr-inset-top, env(safe-area-inset-top, 0px))) !important;',
		'}',
		'@media (prefers-reduced-motion: reduce) {',
		'  html.' + ROOT_CLASS + ' [data-dshr-main-col] { transition: none !important; }',
		'}',
		// 跟手拖动：用 --dshr-drawer-x / --dshr-drawer-p 驱动，关掉过渡。
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-frame] {',
		'  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f6)) !important;',
		'  overflow: hidden !important;',
		'}',
		// T125-fix（特异度）：第一选择器必须带上 [data-dshr-frame] 上下文。
		// 稳态展开规则 `html.dshr-mobile [data-dshr-frame]:not([data-sidebar-collapsed])
		// [data-dshr-sidebar-col]` 是 (0,4,1) 且写了 `transform: none`；拖动起手即
		// setSidebarOpen(true)（frame 展开），若拖动规则只是 (0,3,1)，稳态的 none
		// 会赢，抽屉真机上永远静止（只有主卡动）——测试 fixture 里因 frame 保持收起、
		// 第二选择器 (0,5,1) 命中才显得正常，这正是 .14 漏网的原因。
		// 补上 frame 上下文后同为 (0,4,1)，本块源码顺序在后 ⇒ 拖动期跟手生效；
		// dragging 属性一摘即回稳态，交接不变。
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] [data-dshr-frame] [data-dshr-sidebar-col],',
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
		// Kimi 式（T130 重写）：抽屉**静止垫底**——侧栏从拖动第一帧起就完整铺在
		// 底层（拖动起手即官方展开，见 setDrawerVisual），主卡向右平移把它**揭示**出来。
		// 此前 T125 的「抽屉 1:1 跟手滑入」（translateX(x - width)）已废弃：
		// 用户口径是「主页像一块盖在侧栏上的圆角卡片向右滑出，露出被盖住的侧栏」，
		// 侧栏自己不动。稳态展开规则同样是 transform:none，交接零台阶。
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
		// T91：圆角与阴影**跟手**——两者都由 --dshr-card-p（0..1，hook 每帧按位移写、
		// 见 setDrawerVisual）驱动。改动前的缺陷（真机真值见 report §2）：这里写死 18px +
		// 写死阴影 ⇒ 指针刚落下（x=0、手指还没动）主卡就已经是「整张圆角卡」，
		// 与关闭态的 0 圆角之间是一次**跳变**，观感上「一按下去就变成卡片」，
		// 而不是用户要的「跟着手指圆角平移过来」。
		// p=0 ⇒ 圆角 0、阴影 0（与关闭态逐像素一致，交接无台阶）；
		// p=1 ⇒ 圆角 var(--dshr-card-r)、阴影与打开终态逐字一致（交接无跳变）。
		'  border-radius: calc(var(--dshr-card-p, 0) * var(--dshr-card-r, 20px)) !important;',
		'  box-shadow: calc(var(--dshr-card-p, 0) * -14px) 0 calc(var(--dshr-card-p, 0) * 36px) rgba(0, 0, 0, calc(var(--dshr-card-p, 0) * 0.18)),',
		'    0 0 0 1px rgba(0, 0, 0, calc(var(--dshr-card-p, 0) * 0.04)) !important;',
		// ── T105：卡片背景（含圆角）铺到屏幕最顶 y=0，**内容仍让开状态栏** ──
		// 做法：margin-top 负向抵消、padding-top 等量补齐，两者都由同一个 p 缩放 ⇒
		//   边框盒顶 = inset − p·inset（p=1 时 = 0）；内容盒顶 = inset − p·inset + p·inset = inset。
		//   ⇒ 背景/圆角顶到 y=0，而**页面内容一个像素都不动**（仍从 --dshr-inset-top 起）。
		// 为什么不用"另铺一层底色"：圆角属于**卡片自己的边框盒**，只有让边框盒真的顶到 0，
		//   圆弧才画在屏幕顶边上；外部色块只能补一块方角，反而在卡片圆角处露馅。
		// 为什么不动 frame 的 padding-top：那是抽屉盒顶(y=0)、状态栏让位与
		//   `dshr-official-inset`（官方横屏）三方共同依赖的既有结构。
		// 键盘抬页是 applyImeLift() 的 `--dshr-ime` + translateY，另一个属性、另一条通道，
		//   与这里的 margin/padding 互不相干（§3.3）；右栏/平板档不吃这条规则（档位闸）。
		'  margin-top: calc(-1 * var(--dshr-card-p, 0) * var(--dshr-inset-top, env(safe-area-inset-top, 0px))) !important;',
		'  padding-top: calc(var(--dshr-card-p, 0) * var(--dshr-inset-top, env(safe-area-inset-top, 0px))) !important;',
		// 拖动期钉住几何（半径/阴影都不参与布局，只重绘；offsetHeight 不变 ⇒
		// 既有 fixture 断言 drag-keeps-layout-and-shadow 的「不重排」语义保持不变）。
		// T82：跟手态也不许带 8px 上/下 margin（否则手指一按下去 header 就跳 8px，
		// 与展开态那处的下移同帧发生，观感上就是"拖动一开始整块往下掉"）。
		// T105：max-height 必须跟着 +p·inset，否则它会把这个"长高了 p·inset"的边框盒
		// 又按 grid 区高度(100%)夹回去 ⇒ 卡片底边离屏底差 46px。
		// （拉伸项高度 = grid 区高 − margin 和 = (H−inset) + p·inset。）
		'  max-height: calc(100% + var(--dshr-card-p, 0) * var(--dshr-inset-top, env(safe-area-inset-top, 0px))) !important;',
		'  overflow: hidden !important;',
		'}',
		// ── T105：拖动期抽屉**不再有右缘圆角 / 不再裁剪**（删 T91 那两条规则） ──
		//
		// T91 当年为了"让抽屉右缘的圆角在跟手期看得见"，先给抽屉右缘加跟手圆角
		// （`border-*-right-radius: calc(--dshr-card-p × --dshr-card-r)`），再用
		// `clip-path: inset(… calc(max(0px, 100% - var(--dshr-drawer-x))) …)` 把抽屉的
		// 可绘制右缘钉到主卡左缘。两条一起删，因为：
		//   1) 目标观感变了（用户原话"各自是各自的圆角矩形"被否掉）——
		//      接缝处只能有**卡片自己**的圆角，抽屉右缘必须是直线；
		//   2) 抽屉宽度本来就等于 360.19（= --dshr-drawer-width），跟手期主卡只是
		//      浮在它上面，右缘被不透明卡片盖住的部分**本来就看不见**，
		//      不需要把自己的右缘"拉"到卡片左缘去；
		//   3) 于是抽屉回到"整块背景"语义：不裁剪、不圆角、不参与任何跟手动画
		//      （只由 z-index:10 待在卡片 z-index:20 下面）。
		// 真机像素真值（抽屉侧右缘在多条 y 上恒为同一条 x）见 report §4.2。
		// T82：鲸鱼不再被拖动闸藏掉。它自己读 --dshr-drawer-x 跟手（见下方 #dshr-mobile-whale），
		// 与主列共用同一对 transition ⇒ 同帧同缓动交接。
		// 但必须让它 pointer-events:none：实测遮罩占 x 359.4–411.4，鲸鱼 z-index 900
		// 会压在遮罩上吞掉 42px 宽的「点遮罩关抽屉」点击（鲸鱼跟着滑到右边后正好落在这条带里）。
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] #dshr-mobile-whale,',
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] #dshr-mobile-whale {',
		'  pointer-events: none !important;',
		'}',
		// 跟手期间关掉过渡：位移必须与手指 1:1。
		// T105：这条原来只写 transition:none；现在把 transform 与 !important 一起并到
		// `#dshr-mobile-whale` 基规则之后那条同名规则里（见下），避免两条分散、便于对照。
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
		// T82：鲸鱼改用**与主列同一个变量**驱动位移，并共用同一对 transition。
		//
		// 改前的结构性根因：鲸鱼是 position:fixed; left:10px，既不读 --dshr-drawer-x、
		// 也没有 transform ⇒ 它和抽屉位移完全解耦，位移只能靠"显示/隐藏"来表达，
		// 于是 hook 里两条互不知情的规则（拖动闸 + 展开闸，都是 display:none !important）
		// 在拖动第 1 帧、手指还没动时就把鲸鱼抹掉了（三次重复一致，见 report §B）。
		// 现在它与主列读同一个变量 ⇒ 同一帧同一缓动交接，不存在"一个先动一个后动"。
		//
		// ⚠ T105 修正：上面这条只用 `--dshr-drawer-x`（**拖动期**变量）是**不完整**的。
		// `--dshr-drawer-x` 只在 data-dshr-dragging=1 期间存在，松手落位时
		// `clearDrawerVisual()`（:3893 附近）会 removeProperty ⇒ 鲸鱼瞬间回落到回退值 0，
		// 而主列由展开态规则（`translateX(var(--dshr-drawer-width))`）落在 360.19。
		// 真机逐帧真值（scratch/t105/ev/perframe-base-full.json）：拖动期 164 帧
		// `whale.x − (10 + mainX)` **恒 0**，松手后 0.34s 内单调退化到 **−360.19**
		// —— 正是用户说的"鲸鱼会飘"（卡片往右落位、鲸鱼同时横扫 360px 飞回左侧）。
		// 修法：**展开态（非拖动）**补一条同源位移，读 JS 每帧解析出来的 px 变量
		// `--dshr-drawer-shift`（= 主列终态 translateX 的解析值，见 syncDrawerMetrics），
		// 缓动与时长与主列逐字相同 ⇒ 同帧同缓动落位。
		// 拖动期两条规则同时命中，故下面那条带 !important 的拖动规则排在后面压住它。
		'  transform: translateX(var(--dshr-drawer-x, 0px));',
		'  transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1);',
		'  will-change: transform;',
		'}',
		'#dshr-mobile-whale svg { display: block; width: 27px; height: 20px; }',
		// T105：展开终态 —— 鲸鱼跟着**主列**（不是抽屉）停在卡片左上角，
		// 与卡片保持恒定相对位置（卡片内 10px）。`--dshr-drawer-shift` 一定是 px
		// （不能复用 --dshr-drawer-width：手机档它是 calc(100% - 52px)，而 translateX 的
		// 百分比对**元素自身**宽度解析 —— 鲸鱼只有 48px 宽，会算成 −4px）。
		'html.' + ROOT_CLASS + '[data-dshr-expanded="1"] #dshr-mobile-whale {',
		'  transform: translateX(var(--dshr-drawer-shift, 0px));',
		'}',
		// 拖动期：位移必须与手指 1:1（读拖动变量本身），且压住上面的展开态规则
		// （两条特异度相同 0-1-3-1，全靠这条的 !important + 源码顺序）。
		'html.' + ROOT_CLASS + '[data-dshr-dragging="1"] #dshr-mobile-whale {',
		'  transition: none !important;',
		'  transform: translateX(var(--dshr-drawer-x, 0px)) !important;',
		'}',
		// T82 产品最终形态（用户拍板）：鲸鱼**跟着抽屉一路滑到右边并停住**，不淡出、不隐藏。
		// 因此这里从"仅 expanded=0 显示"放宽为"ready 即显示"。
		// 安全性：三条隐藏规则（rightbar-fullscreen / explorer-details / dialog）都带
		// !important，而本条不带 ⇒ 它们仍然压得住本条，不因放宽而误显示。
		'html.' + ROOT_CLASS + '[data-dshr-ready="1"] #dshr-mobile-whale { display: block; }',
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
		// ── T130：右抽屉卡片（Kimi 式镜像）；T131：全宽覆盖 ──
		//
		// 官方右栏在手机档（<768px）打开即 fullscreen（position:fixed;inset:0 盖住一切），
		// 用户口径「右栏太僵硬」。这里把它重构为与左抽屉镜像的 Kimi 式卡片交互：
		//   面板 = 盖在主会话卡**上方**的圆角卡片——右锚定、左缘圆角 + 左缘投影，
		//   左滑从右缘跟手滑入、右滑跟手关闭。
		// T131（实机口径「无法完全覆盖主屏幕」）：宽度由 100%−52px 改为 **100vw 全宽**——
		//   右栏是内容型文件面板，旧官方全屏的覆盖体感保留；左缘不再留细条
		//   （data-dshr-ropen 的遮罩/拖柄两条规则随之删除），关闭走右滑 / 面板自身按钮 /
		//   返回键桥。全宽落位时左缘圆角在屏外不可见，跟手滑入中途可见，观感不变。
		// 卡片形态完全锚在**官方属性**上（[data-sidebar-right-panel="fullscreen"]
		//   + [data-sidebar-right-open]），无 JS 参与也在位；JS 只经 --dshr-rx 驱动位移：
		//   0 = 全开、W（= 100vw）= 全藏。缺省 0px ⇒ 官方按钮打开时面板即在终态，
		//   transition 负责从上次位置（或屏外）滑入。
		// 宽屏（≥768px）官方 push/docked 态面板属性值不是 fullscreen，天然不命中本规则。
		// 面板 fixed 定位 + 自带 z-index:850 ⇒ 不再需要 T82 那套「抬承载列 z-index/transform」
		//   （data-dshr-rightbar-col 与 --dshr-rightbar-z 一并删除）；
		//   T85 的 width 裁剪窗打开动画也删除（打开方向现在是从右缘跟手滑入）。
		// touch-action:pan-y：文件树竖滚走原生（touchcancel 自然解除手势），横滑留给我们。
		// T135：手势关闭的「交接窗」（data-dshr-rclosing）也要命中同一条卡片规则。
		// 官方真正的收起动画**不在面板上**，而在内层 [data-dockkit-host=dock] /
		// [data-dockkit-empty] / [data-dockkit-divider]（官方 CSS 原文：
		//   transform: translateX(var(--dsh-sidebar-width)); visibility: hidden;
		//   transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out),
		//               visibility 0s linear var(--ds-transition-duration-slow)
		// open 态反过来：transform:none; visibility:visible; transition: transform …）。
		// 而 hook 的卡片位移加在**面板**上、以官方 open 属性为闸 ⇒ 手势补间到 rx=max
		// 后兑现官方收起时，属性一消失这条规则整条失效（面板从屏外右瞬回屏内 x=0），
		// 官方内层随即从 tx=0 **可见地**滑到 tx=100vw、0.3s 后才 visibility:hidden
		// ⇒ 用户看到「关闭落位后又自己弹回来再关上」（逐帧实测可见窗口 1109→1376ms，
		// 见 scratch/t135/lead-replay-timeline.mjs）。交接窗期间让面板继续停在屏外。
		'html.' + ROOT_CLASS + '[data-dshr-rclosing="1"] [data-sidebar-right-panel="fullscreen"],',
		'html.' + ROOT_CLASS + ' [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open] {',
		'  position: fixed !important;',
		'  top: 0 !important;',
		'  right: 0 !important;',
		'  bottom: 0 !important;',
		'  left: auto !important;',
		'  width: 100vw !important;',
		'  min-width: 0 !important;',
		'  max-width: 100vw !important;',
		'  box-sizing: border-box !important;',
		'  border-radius: var(--dshr-card-r, 20px) 0 0 var(--dshr-card-r, 20px) !important;',
		'  box-shadow: -14px 0 36px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04) !important;',
		'  transform: translateX(var(--dshr-rx, 0px)) !important;',
		'  transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1) !important;',
		'  will-change: transform;',
		'  visibility: visible !important;',
		'  opacity: 1 !important;',
		'  pointer-events: auto !important;',
		'  touch-action: pan-y !important;',
		'  overflow: hidden !important;',
		'  z-index: 850 !important;',
		'}',
		// 跟手期：位移必须与手指 1:1，关掉过渡（与左抽屉 data-dshr-dragging 同义）。
		'html.' + ROOT_CLASS + '[data-dshr-rdrag="1"] [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open] {',
		'  transition: none !important;',
		'}',
		// T135：交接窗内压掉官方内层的收起过渡 —— 官方收起一步到位（内容直接 translate+hidden），
		// 不再产生第二次可见位移。只作用于面板内层三个 dockkit 节点，窗口极短
		// （官方状态一落地即撤窗，见 syncDom），面板此刻已在屏外。
		'html.' + ROOT_CLASS + '[data-dshr-rclosing="1"] [data-sidebar-right-panel="fullscreen"] [data-dockkit-host],',
		'html.' + ROOT_CLASS + '[data-dshr-rclosing="1"] [data-sidebar-right-panel="fullscreen"] [data-dockkit-empty],',
		'html.' + ROOT_CLASS + '[data-dshr-rclosing="1"] [data-sidebar-right-panel="fullscreen"] [data-dockkit-divider] {',
		'  transition: none !important;',
		'}',
		// 右抽屉卡片态期间收起悬浮鲸鱼（全宽面板会盖到左上角；双保险：
		// data-dshr-rightbar-fullscreen 那条依赖官方 frame 属性，这条只依赖
		// hook 自己的 ropen 镜像）。data-dshr-ropen 由 syncDom 按
		// 「官方 open 且面板为 fullscreen 卡片态」镜像，push/docked 态不置位。
		'html.' + ROOT_CLASS + '[data-dshr-ropen="1"] #dshr-mobile-whale {',
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
		// 绝不 overflow:hidden：上下文环的浮层（.JObwrW_panel，position:absolute；
		// bottom: calc(100% + 8px)）就在这一行的子节点里，裁剪会把整块面板吃掉——
		// 手机端点环"没反应"就是这个裁剪。不裁剪也不会盖住 +/权限：模型按钮自己
		// min-width:0 + 省略号，其余子按钮 flex:0 0 auto，宽度不会溢出。
		'  overflow: visible !important;',
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
	// T56：不再裸调 appendChild。走到这里时 <html> 已由启动闸门保证存在，但 document
	// 仍可能在解析途中被整体换掉（documentElement 变回 null）——那正是本 bug 的成因类别。
	// 这里做能力检查：挂不上就把 style 留在 pendingStyle，等 <head> 出现时补挂，绝不抛。
	var pendingStyle = null;
	function flushStyle() {
		if (pendingStyle === null) return true;
		var mount = document.head || document.documentElement;
		if (!mount) return false;
		mount.appendChild(pendingStyle);
		pendingStyle = null;
		return true;
	}
	if (document.querySelector('style[data-dshr-mobile-css]') === null) {
		var style = document.createElement('style');
		style.setAttribute('data-dshr-mobile-css', '');
		style.textContent = MOBILE_CSS;
		pendingStyle = style;
		if (!flushStyle()) {
			// 只有真挂不上才多挂一个一次性监听；正常路径零额外监听。
			document.addEventListener('DOMContentLoaded', flushStyle, { once: true });
		}
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
		// 严格 OFF（平板档）：键盘占位由原生平移负责，页面一律不写行内变量
		//（clearImeLift 会写 --dshr-ime，那本身就是痕迹）。
		if (isStrictOff()) {
			lastImeVvHeight = -1;
			document.documentElement.removeAttribute('data-dshr-ime');
			document.documentElement.style.removeProperty('--dshr-ime');
			document.documentElement.style.removeProperty('--dshr-vv-height');
			return;
		}
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
	 * T21 修复 1：把当前可编辑元素的焦点收回（判据复用 isEditableFocus，不另写一份）。
	 * 没有可编辑元素持焦时零成本返回 false。
	 */
	function blurEditableFocus() {
		var el = document.activeElement;
		if (!isEditableFocus(el)) return false;
		try {
			el.blur();
		} catch (ignoredBlur) { /* 节点已卸载：focus 已被浏览器自行清掉 */ }
		return true;
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

	// ── T21 修复 2：焦点守卫（用户口径：只有用户自己点输入框，输入框才允许持焦）──
	//
	// 现象：任何非「用户主动点击输入框」造成的聚焦都会抬起虚拟键盘。切会话后官方重渲染
	// 会把 composer 重新聚焦 → 手机档 931ms 弹键盘（T18 K-3/K-4）。T18 已证明这是**官方
	// 行为**（平板档 hook 关闭、纯官方 UI，929ms 照样弹），用户已拍板要压掉，属有意偏离
	// 官方桌面行为，不是 bug 修复的副作用。
	//
	// 机制：
	//   1) touchstart / pointerdown / mousedown 三个**捕获阶段**监听器：事件落点落在
	//      可编辑元素内 → 记一个「用户主动聚焦」时间戳（USER_FOCUS_WINDOW_MS 窗口）。
	//      三个都监听是因为 WebView/Chrome 的落指→聚焦顺序在这几种输入下不完全一致。
	//   2) focusin 捕获阶段：目标是可编辑元素、且**不在**窗口内 → 当场 blur()。
	//
	// 不破坏的场景：
	//   - 用户点输入框：touchstart/pointerdown/mousedown 的默认动作（聚焦）发生在事件
	//     派发**之后**，而窗口在这之前就记好了 ⇒ 这次聚焦一定在窗口内，键盘照常弹。
	//   - 用户连续操作输入框：每次落指都刷新窗口。
	//   - 用户点输入框后官方自己再 focus 一次（同元素、窗口内）：放行。
	//   - 正在输入/发送后官方保持焦点：那期间没有新的 focusin（焦点没变），守卫不动作。
	// 防打环：同一元素在 FOCUS_REVOKE_SPAN_MS 内最多收回 FOCUS_REVOKE_MAX 次，超限就
	// 放手并计数（最坏退回改动前行为），绝不无限 blur。
	//
	// T42 修订（根因修复）：上面这条「超限就放手」正是本缺陷的成因——官方打开快捷指令
	// 面板时会在 17ms 内对同一个 composer 连续抢 3 次焦点（AVD 5594 实测），前两次被收回，
	// 第 3 次撞上 FOCUS_REVOKE_MAX=2 就被**放过**，焦点粘住、软键盘弹起。
	// 改成：超限不再放过，而是把该元素转入**粘性抑制**——只要判定过「这次聚焦不是用户
	// 手势造成的」，就持续收回，直到用户真的点了它为止（见 bindFocusGuard 的 onDown）。
	// 绝对安全阀仍在，只是阈值抬高到远高于官方真实抢占次数的量级（FOCUS_STICKY_MAX），
	// 病态场景下依然会放手并计数，不会无限 blur。
	//
	// 生效范围：只在 hook 真正生效的档位工作。平板档（严格 OFF，契约 3.5 零痕迹）与
	// 手机横屏（hook OFF、官方桌面布局）一律不动作——本任务不碰这两个档。
	// T48：命令面板的「布防 → 抢焦点」形态。
	//
	// 为什么必须单独一条路：官方命令面板（「+」菜单）的**打开与 composer 持焦同步耦合**
	// （T42 运行时 A/B 实测：收回焦点 → 面板不开），所以 T42 的粘性抑制会把它打没，
	// 冷启动第一次点「+」无响应。T46 又复验了「延迟收回」在 16/50/150/300ms 四档下
	// **全都**开不出面板（面板开不开是同步耦合，不是焦点维持时长）⇒ 只能走下面这条。
	//
	// 形态（纯 hook，不动原生）：
	//   1. 用户落指在 composer 卡片里的**非可编辑触发器**（「+」、模型、访问模式…）：
	//      放行这次聚焦 + 给 composer 打 inputmode="none" + **我们自己立刻 focus()**；
	//   2. 官方随后打开面板时再抢焦点：焦点没变 ⇒ 无新 focusin ⇒ 无新 showSoftInput ⇒ 键盘不弹；
	//   3. 面板渲染完（~500ms）或下一次用户手势就摘掉 inputmode ⇒ 用户之后点输入框时属性本是 null，
	//      走完全干净的原生聚焦路径（解除路径由官方重渲染天然提供，§6 实测）。
	//
	// 与 T42 粘性抑制的共存边界（**本改动最要紧的一条**）：
	//   - 布防只发生在「composer 卡片内的非可编辑触发器」上，且**不**进入粘性抑制
	//     （进站即 clearFocusSticky），否则刚抢到的焦点会被自己收回去、面板照样打不开；
	//   - 会话切换 / 左侧栏 / 鲸鱼抽屉等「非用户手势造成的聚焦」**不**在布防范围内，
	//     仍由 T42 的粘性抑制收回，键盘照常不弹 ⇒ 产品口径不变。
	//
	// 为什么 `inputmode="none"` 而不是别的：T46 实测 `contenteditable=true` 的元素支持
	// inputmode，Chromium/Android WebView 会因此**不向 IME 请求 showSoftInput**，
	// 同时 DOM 焦点原封不动留在 composer 上 —— 正是官方命令面板要的那个焦点。
	var FOCUS_ARM_MS = 1000;
	// 往上找 composer 卡片时的深度封顶。冷启动时 hook 的标记可能还没打上，
	// 没有这道封顶就会一路走到 <body>，让整页（鲸鱼、侧边栏、消息气泡）都变成布防范围。
	var FOCUS_ARM_HOST_MAX_DEPTH = 8;
	var focusArmTimer = 0;
	var focusArmEl = null;
	var focusArmed = false;
	var focusArmUntil = 0;
	var USER_FOCUS_WINDOW_MS = 800;
	var FOCUS_REVOKE_MAX = 2;
	var FOCUS_REVOKE_SPAN_MS = 1200;
	var FOCUS_STICKY_MAX = 12;
	var FOCUS_STICKY_SPAN_MS = 5000;
	var userFocusWindowUntil = 0;
	// T51（R1）：放行窗口的**目标元素**。旧实现里窗口是「对整个文档放行」，
	// 于是「＋」那一下 markUserFocusIntent() 撑开的 800ms 通行证会外溢到面板的
	// 下一次交互：用户 1 秒内点「模型」⇒ 子面板的 input.EhuiKa_search 抢到焦点 ⇒
	// 守卫按设计放行 ⇒ 键盘弹（T50 §6.1 实测 5/6 命中，间隔阈值 800ms 精确吻合
	// USER_FOCUS_WINDOW_MS）。现在窗口只对**这次意图指向的那个元素**生效。
	var userFocusIntentEls = null;
	var focusRevokeEl = null;
	var focusRevokeCount = 0;
	var focusRevokeSince = 0;
	var focusGuardStats = { revoked: 0, capped: 0, sticky: 0, armed: 0, disarmed: 0, residualSwept: 0, sendExcluded: 0, armSkippedHeldFocus: 0, armRepeatSameGesture: 0, armNewGesture: 0, disarmSkippedSameGesture: 0, imeMuted: 0, imeReleased: 0 };
	// ── T76：手势身份与「同手势幂等」（阻断②的真凶就在这四个状态变量上）──────
	//
	// 一次真实点按会触发**三个**「落指」事件，而 bindFocusGuard 的 onDown 同时绑在
	// touchstart / pointerdown / mousedown 上；onDown 开头又**无条件**
	// `if (focusArmed) disarmComposerFocus()`。于是 touchstart 那一下刚布上的防，
	// 会被 pointerdown 摘掉；等 mousedown 想补布防时，armComposerFocus() 的 T69 早退
	// （composerHoldsFocus() 为真 —— 焦点正是上一次 arm 抢的）直接 return false，
	// 不再打 inputmode。终态：inputmode=null + composer 持焦 ⇒ 浏览器按节点重新向
	// IME 请求 showSoftInput ⇒ **冷态点「+」又弹键盘**（rc.2.5 → rc.2.6 回退，实测 2/2）。
	//
	// 【手势怎么划？—— 这条是本段最要紧的实测结论，AVD 5604 / pixel_8a / SDK 35，
	//  真 `adb shell input tap` 一次点按的原始事件序列，见 scratch/t76/timeline-after.json】
	//     pointerdown(pid=2) → touchstart(tid=0) → pointerup(pid=2) → touchend(tid=0)
	//                        → focusin → mousedown → mouseup → click(pid=2)
	// 三个落指跨约 20ms，而**抬手事件夹在 touchstart 与 mousedown 之间**。
	// ⇒ **绝对不能拿 pointerup / touchend 划分手势**：那会把同一次点按的兼容 mousedown
	//   误判成新手势，它开头的 disarm 就会摘掉 pointerdown 刚布的防（正是原缺陷本身）。
	//   （第一版就是按抬手划分的，被自己的探针当场抓出来：inputmode 在 mousedown 前 0.3ms 被摘。）
	// ⇒ 手势的**唯一可靠终止信号是 click**：一次点按恰好一次 click，且必在所有落指之后。
	//   再加两道兜底：单次手势最多 3 个落指（实测就是 3）、以及 FOCUS_ARM_MS 超时。
	//   这三道里任何一道触发都会正确收口；click 丢了也不会让 inputmode 长期残留
	//   （第一道保障仍是 disarmComposerFocus 自己的 500ms 定时器）。
	var FOCUS_MAX_DOWNS_PER_GESTURE = 3;
	var focusGestureOpen = false;   // 当前手势是否还没收尾
	var focusGestureDowns = 0;      // 本手势已落的指数
	var focusGestureArmed = false;  // 本手势是否已做过布防决策（含早退）
	var focusGestureOpenedAt = 0;   // 本手势开始时刻（超时兜底用）
	var focusGuardBound = false;
	// 粘性抑制的登记处。键用「稳定签名」而不是节点引用：官方 composer 会被重渲染换掉
	// 节点实例，只按节点认，换节点后的继续抢焦点就漏了（实测 3 连抢是同一节点，但重渲染
	// 之后未必）。节点弱引用只作为签名取不到时的兜底。
	var focusStickyKeys = Object.create(null);
	var focusStickyCounts = Object.create(null);
	var focusStickySince = Object.create(null);
	var focusStickyNodes = typeof WeakSet === 'function' ? new WeakSet() : null;

	/**
	 * T48：算「打开命令面板/弹层的非可编辑触发器」的选择器。
	 * 用官方 aria-label（中英都列）而不是只靠 hook 自己打的 data-dshr-* 标记 ——
	 * 那些标记由 syncComposerChrome 写，冷启动第一次点「+」时可能还没写上。
	 */
	var COMPOSER_TRIGGER_SELECTOR = [
		'button[aria-label="Add files or run commands"]',
		'button[aria-label="添加文件或运行命令"]',
		'button[aria-label="添加文件或调用指令"]',
		'button[aria-label="添加文件或运行指令"]',
		'button[aria-label="命令"]',
		'button[aria-label="指令"]',
		'button[aria-label="Commands"]',
		'[data-dshr-composer-add]',
		'[data-dshr-composer-model]',
		'[data-dshr-composer-access]',
		'[data-dshr-composer-trailing]'
	].join(', ');

	/**
	 * T69：**发送**按钮的识别。发送**不是**"打开命令面板的触发器"，它走的是"把草稿
	 * 交给会话"的语义 —— 布防对它没有任何用处，只会造成伤害（见 isPanelTriggerPoint
	 * 与 armComposerFocus 的注释）。所以这里给它一份**独立的**名单，并让
	 * isPanelTriggerPoint() 第一件事就是排除它。
	 *
	 * 为什么不能只从 COMPOSER_TRIGGER_SELECTOR 里删掉 `[data-dshr-composer-send]`：
	 * isPanelTriggerPoint() 的**兜底分支**（composer 卡片内任意可交互控件）会把发送按钮
	 * 重新判成触发器 —— AVD 实测该兜底分支让 40 个元素命中，其中就包括发送按钮本身
	 * 以及它内部的 svg/path（它们各自 closest('button') 都回到发送按钮）。
	 * ⇒ 排除必须发生在兜底分支**之前**，且要覆盖"落在发送按钮内部任意后代"的情况。
	 *
	 * 名单同时列了 hook 自己的标记与官方 aria-label（中英），冷启动时 hook 标记可能还没
	 * 写上，不能只靠标记。
	 */
	var COMPOSER_SEND_SELECTOR = [
		'[data-dshr-composer-send]',
		'button[aria-label="Send message"]',
		'button[aria-label="发送消息"]',
		'button[aria-label="Send"]',
		'button[aria-label="发送"]',
		'button[aria-label="Submit"]',
		'button[aria-label="提交"]'
	].join(', ');

	/**
	 * T48：已经打开的官方面板/弹层。落在这些容器里的落指**一律不布防** ——
	 * 官方把命令面板挂在 composer 卡片内部，不排除的话面板条目会被误判成触发器。
	 * AVD 实测：布防会让「模型」子面板里的搜索框 input.EhuiKa_search 抢到焦点、
	 * 把软键盘弹起来（见 t48-report §5）。
	 */
	var OPEN_PANEL_SELECTOR = '[role="listbox"], [role="dialog"], [role="menu"]';

	/**
	 * 落点是否在可编辑元素内：自身可编辑（判据复用 isEditableFocus），
	 * 或祖先里有可编辑元素（contenteditable 的后代节点、包裹层等）。
	 */
	function isEditablePoint(target) {
		if (isEditableFocus(target)) return true;
		if (!isElement(target) || !target.closest) return false;
		return !!target.closest('input, textarea, select, [contenteditable]');
	}

	/**
	 * 用户在可编辑元素上落指 → 开一个「主动聚焦」窗口。
	 *
	 * T51（R1）：窗口**必须带目标元素**。`target` 缺省（或解析不出元素）时不开窗口
	 * （返回 false）—— 一个「对整个文档放行」的窗口就是 T50 §6.1 那个反例本身。
	 * `target` 可以是一个元素，也可以是一组元素（见 onDown 的用户落指分支）。
	 */
	function markUserFocusIntent(target) {
		var list = [];
		var add = function (el) {
			if (isElement(el) && list.indexOf(el) === -1) list.push(el);
		};
		if (isElement(target)) add(target);
		else if (target && typeof target.length === 'number') {
			for (var i = 0; i < target.length; i++) add(target[i]);
		}
		if (!list.length) return false;
		userFocusWindowUntil = Date.now() + USER_FOCUS_WINDOW_MS;
		userFocusIntentEls = list;
		return true;
	}

	/**
	 * T51（R1）：关掉放行窗口。生命周期必须收干净 —— 见 disarmComposerFocus /
	 * onDown / visibilitychange / pageshow 的调用点。
	 *
	 * T135：浮层手势窗口同生共死（它是同一张「这次落指是用户意图」的通行证）。
	 */
	function clearUserFocusWindow() {
		userFocusWindowUntil = 0;
		userFocusIntentEls = null;
		panelFocusUntil = 0;
	}

	// ── T135：浮层内手势的聚焦通行证 + IME 压制 ─────────────────────────────
	//
	// 现象（真机 + 真页面实测）：点「模型」行 ⇒ 官方子面板（模型列表 + 搜索框）
	// **立刻整个消失**，模型永远选不到。根因不在 click（实测 click 送达、目标仍在文档里、
	// `defaultPrevented=false`），而在官方子面板打开时会**自动聚焦它自己的搜索框**
	// （input[role="searchbox"][aria-label="搜索模型…"]），而本守卫把这次聚焦判成
	// 「非用户手势造成的偷焦点」并 `el.blur()`；官方浮层以「焦点离开浮层」为准判定 dismiss
	// ⇒ 实测 blur 后 **1.6ms** 菜单 + 刚渲染的模型列表 + 外点遮罩整块卸载，列表一帧都没画。
	//
	// 为什么不能只是「给浮层开窗口放行」：那样搜索框会拿到真焦点 ⇒ Android 按用户手势
	// 请求 showSoftInput ⇒ 键盘盖住刚打开的模型列表（T48 §5 的原始诉求，A 病换 B 病）。
	// 所以这里**放行焦点、但压住 IME**：
	//   1. 手势起点落在浮层里 ⇒ 开一张**只对「浮层内元素」生效**的窗口；
	//   2. 窗口内、落在浮层内的可编辑元素被聚焦 ⇒ 不 blur，只打 inputmode="none"
	//      （复用 T46/T48 已验证的机制：Chromium 因此不向 IME 请求 showSoftInput）；
	//   3. 用户之后真去点输入框（onDown 的可编辑分支）⇒ 撤掉压制并**还原原值**。
	//
	// 范围严格性（别把它读成「整页放行」）：
	//   - 窗口只在「落点本身在浮层/已打开浮层内」时开；点 composer 上的「+」/模型触发器
	//     **不开** ⇒ T48 §5「命令面板子面板搜索框抢焦点弹键盘」的防护原样保留；
	//   - 放行的对象必须是**浮层内**的可编辑元素（floatingLayerOf 判真）；浮层关闭时
	//     官方把焦点还回 composer 那种「偷焦点」仍会被正常收回（T42 语义不变）。
	var IME_MUTE_ATTR = 'data-dshr-imemute';
	var panelFocusUntil = 0;

	/**
	 * 落点/焦点所在的最近「浮层宿主」。
	 * 复用既有 isFloatingHost 判据（fixed/absolute + 可见 + 非布局壳 + 不吃满视口），
	 * **不靠 role**：官方浮层容器的 role 会在 menu / group 之间切换，靠 role 会漏；
	 * 也不能只认 hook 自己的标记 —— 标记由 syncDom 写，而官方这次自动聚焦发生在
	 * 子面板挂载后 ~10ms 内，syncDom（50ms 合并）可能还没跑。
	 */
	function floatingLayerOf(node) {
		var el = node;
		var depth = 0;
		while (isElement(el) && el !== document.body && el !== document.documentElement && depth < FOCUS_ARM_HOST_MAX_DEPTH) {
			if (isFloatingHost(el)) return el;
			el = el.parentElement;
			depth += 1;
		}
		return null;
	}

	/** 落点是否在**已经打开的官方浮层**里（role 名单 + 浮层宿主兜底，两条互补）。 */
	function isInsideOpenPanel(node) {
		if (!isElement(node) || !node.closest) return false;
		try {
			if (node.closest(OPEN_PANEL_SELECTOR)) return true;
		} catch (ignoredPanelSel) { /* 选择器异常则走浮层兜底 */ }
		return !!floatingLayerOf(node);
	}

	/** 用户在浮层内落指 ⇒ 开窗口（只对「浮层内元素」生效）。 */
	function markPanelFocusIntent() {
		panelFocusUntil = Date.now() + USER_FOCUS_WINDOW_MS;
		return true;
	}

	/** 窗口内、且焦点落在浮层里的可编辑元素 ⇒ 放行（不 blur）。 */
	function inPanelFocusWindow(el) {
		if (!panelFocusUntil || Date.now() > panelFocusUntil) return false;
		if (!isElement(el) || !isEditableFocus(el)) return false;
		return !!floatingLayerOf(el);
	}

	/**
	 * 压住 IME：打 inputmode="none"，并把**原值**记在 data-dshr-imemute 上（还原用）。
	 * 只写自己那两个属性，结构上不可能吞事件。
	 */
	function mutePanelIme(el) {
		if (!isElement(el)) return false;
		try {
			if (el.getAttribute(IME_MUTE_ATTR) === null) {
				var prev = el.getAttribute('inputmode');
				el.setAttribute(IME_MUTE_ATTR, prev === null ? '' : prev);
			}
			el.setAttribute('inputmode', 'none');
			focusGuardStats.imeMuted += 1;
			return true;
		} catch (ignoredMute) { return false; }
	}

	/**
	 * 撤掉全部 IME 压制并**还原原值**（不吞掉官方自己写的 inputmode）。
	 * 调用点：用户主动点输入框（onDown 可编辑分支）、拆卸痕迹（teardownHookTraces）。
	 */
	function releasePanelIme() {
		var list = null;
		try { list = document.querySelectorAll('[' + IME_MUTE_ATTR + ']'); } catch (ignoredMuteList) { return 0; }
		var n = 0;
		for (var i = 0; i < list.length; i++) {
			var el = list[i];
			try {
				var prev = el.getAttribute(IME_MUTE_ATTR);
				if (prev === '') el.removeAttribute('inputmode');
				else el.setAttribute('inputmode', prev);
				el.removeAttribute(IME_MUTE_ATTR);
				n += 1;
			} catch (ignoredRelease) { /* 节点已卸载 */ }
		}
		if (n) focusGuardStats.imeReleased += n;
		return n;
	}

	/** 目标元素是否落在这一次意图的亲缘范围内（自身 / 后代 / 祖先链）。 */
	function inIntentScope(el, intentEl) {
		if (el === intentEl) return true;
		try {
			if (intentEl.contains && intentEl.contains(el)) return true;
		} catch (ignoredContains) { /* 节点已卸载 */ }
		var node = el;
		var depth = 0;
		while (isElement(node) && node !== document.body && depth < FOCUS_ARM_HOST_MAX_DEPTH) {
			if (node === intentEl) return true;
			node = node.parentElement;
			depth += 1;
		}
		return false;
	}

	/**
	 * T51（R1）：这次聚焦是否落在「用户刚才那一下意图」的目标范围里。
	 *
	 * 范围 = 每个目标元素自身 + 后代 + 祖先（深度封顶 FOCUS_ARM_HOST_MAX_DEPTH）。
	 * 双向包含都收，因为两种官方行为都得放行：
	 *   - 官方把焦点放回输入区**内部**的包装层/子输入框（后代）；
	 *   - 官方把焦点放到 composer 的**包裹层/卡片**上（祖先，见 isPanelTriggerPoint 的爬卡逻辑）。
	 *
	 * 「模型」子面板的 input.EhuiKa_search 与 composer 既无祖先也无后代关系
	 * （它是 composer 卡片里的另一棵兄弟子树）⇒ 不在窗口内 ⇒ 被守卫正常收回。
	 */
	function inUserFocusWindow(el) {
		if (!isElement(el) || !userFocusIntentEls) return false;
		if (Date.now() > userFocusWindowUntil) return false;
		for (var i = 0; i < userFocusIntentEls.length; i++) {
			if (inIntentScope(el, userFocusIntentEls[i])) return true;
		}
		return false;
	}

	/**
	 * T51：落点对应的可编辑宿主。
	 *
	 * 不能只靠 `closest('input, textarea, select, [contenteditable]')`：官方 composer
	 * 是 Lexical，真实持焦的节点可能是 `contenteditable="plaintext-only"` 的深层子节点、
	 * 或带 `data-lexical-editor` / `data-composer-input` 的包装层，标准选择器会漏。
	 * 漏掉的后果实测过（test:device 106 条里 4 条 SKIP，原因「真实点按后输入框仍未持焦」）：
	 * 拿不到 owner ⇒ 开不出窗口 ⇒ 守卫把用户自己那一下聚焦也收回了。
	 * 所以再兜一层：沿祖先链找第一个 isEditableFocus 认得的元素。
	 */
	function editableOwnerOf(node) {
		if (!isElement(node)) return null;
		if (isEditableFocus(node)) return node;
		if (node.closest) {
			var m = node.closest('input, textarea, select, [contenteditable], [data-composer-input], [data-lexical-editor]');
			if (m) return m;
		}
		var p = node.parentElement;
		var depth = 0;
		while (isElement(p) && p !== document.body && depth < FOCUS_ARM_HOST_MAX_DEPTH) {
			if (isEditableFocus(p)) return p;
			p = p.parentElement;
			depth += 1;
		}
		return null;
	}

	/**
	 * T51（R4）：`inputmode="none"` 残留兜底。
	 *
	 * T50 §5.2 实测：属性只要**真的**留在 composer 上，用户点输入框也弹不出键盘
	 * （mInputShown=false）。hook 自己造不出这个状态（focusArmed 与属性同生共死），
	 * 但「官方/第三方给 composer 写 inputmode」或「摘除被节流」都能造成它，
	 * 而当时**没有任何东西在守**。这里加一道：非布防态下，一旦发现 composer
	 * 身上挂着 `none`，立刻摘掉。
	 *
	 * 只在 `!focusArmed` 时动手 —— 否则会把自己刚布的防当场撤掉。
	 */
	function sweepResidualInputMode() {
		if (focusArmed) return false;
		var composer = focusComposerEl();
		if (!isElement(composer)) return false;
		var mode = null;
		try {
			mode = composer.getAttribute('inputmode');
		} catch (ignoredGet) { return false; }
		// T50 §5.2 模拟的残留值就是 'none'。别的值（text / numeric …）是官方自己写的，
		// 不归我们管，只清 'none'。
		if (!mode || String(mode).toLowerCase() !== 'none') return false;
		try {
			composer.removeAttribute('inputmode');
			if (focusGuardStats.residualSwept !== undefined) focusGuardStats.residualSwept += 1;
		} catch (ignoredRm) { return false; }
		return true;
	}

	// T51（R4）：盯住 composer 的 inputmode 属性变化。第三方/官方写、或摘除被节流，
	// 都会走到这里；观察者回调是微任务，浏览器按节点上的 inputmode 决定
	// showSoftInput 之前基本能摘掉。composer 节点被换掉时重新挂。
	var inputModeWatcher = null;
	var inputModeWatchEl = null;
	function watchComposerInputMode() {
		var composer = focusComposerEl();
		if (!isElement(composer) || composer === inputModeWatchEl) return;
		if (inputModeWatcher) {
			try { inputModeWatcher.disconnect(); } catch (ignoredDisc) { /* 已断开 */ }
			inputModeWatcher = null;
			inputModeWatchEl = null;
		}
		if (typeof MutationObserver !== 'function') return;
		try {
			inputModeWatcher = new MutationObserver(function () { sweepResidualInputMode(); });
			inputModeWatcher.observe(composer, { attributes: true, attributeFilter: ['inputmode'] });
			inputModeWatchEl = composer;
		} catch (ignoredObserve) { inputModeWatcher = null; }
	}

	// ── T48：布防 / 摘防 ──

	/**
	 * composer 输入元素。官方命令面板要的就是这个元素上的焦点。
	 * T125：页面可能同时存在多个 composer（主会话 + 新建任务 dialog）：
	 * 优先返回当前持焦的那个，其次返回可见的第一个，避免永远只取 DOM 第一个
	 * 导致新建任务页的模型/加号走错 composer（inputmode 打错节点、卡片查找走错）。
	 */
	function focusComposerEl() {
		try {
			var active = document.activeElement;
			if (isElement(active)) {
				if (active.hasAttribute && (active.hasAttribute('data-composer-input') || active.hasAttribute('data-lexical-editor'))) return active;
				if (active.closest) {
					var owned = active.closest('[data-composer-input], [data-lexical-editor]');
					if (owned) return owned;
				}
			}
		} catch (ignoredActive) { /* 回落到全局查找 */ }
		var list = null;
		try {
			list = document.querySelectorAll('[data-composer-input]');
		} catch (ignoredQsa) { list = null; }
		if (!list || !list.length) return document.querySelector('[data-composer-input]');
		for (var i = 0; i < list.length; i++) {
			try {
				if (isVisible(list[i])) return list[i];
			} catch (ignoredVis) { /* 继续找下一个 */ }
		}
		return list[0];
	}

	/**
	 * 落点是不是**发送**按钮（含它内部的 svg/path 等任意后代）。
	 *
	 * T69：发送按钮和「+」这类面板触发器是**两种完全不同的语义**。布防（arm）的全部
	 * 作用是「让官方随后那次抢焦点变成空操作」—— 只对"官方会打开面板、并且面板要求
	 * composer 持焦"这件事有意义。发送不打开任何面板，抢焦点对它只有坏处。
	 */
	function isComposerSendPoint(target) {
		if (!isElement(target) || !target.closest) return false;
		if (target.closest(COMPOSER_SEND_SELECTOR)) return true;
		// 兜底：composer 卡片内的 type="submit" 按钮（官方某些形态用提交按钮发消息）。
		var submit = target.closest('button[type="submit"]');
		if (!submit) return false;
		var composer = focusComposerEl();
		if (!composer) return false;
		var card = composer.parentElement;
		var depth = 0;
		while (isElement(card) && card !== document.body && depth < FOCUS_ARM_HOST_MAX_DEPTH) {
			if (card.contains(submit)) return true;
			card = card.parentElement;
			depth += 1;
		}
		return false;
	}

	/**
	 * T125：落点是不是**模型选择器**（含其内部 svg/span 等后代）。
	 * 模型菜单与「+」命令面板语义不同：它不需要 composer 持焦也能打开，
	 * 而 arm 里的 composer.focus() 会在触摸序列中搬焦点、吞掉模型按钮的 click
	 * （与 T69 发送按钮同因）。因此模型走“只压 IME、不抢焦点”形态。
	 */
	function isModelTriggerPoint(target) {
		if (!isElement(target) || !target.closest) return false;
		try {
			if (target.closest('[data-dshr-composer-model]')) return true;
		} catch (ignoredModelMark) { /* 选择器异常则走官方名单 */ }
		var labelled = null;
		try {
			labelled = target.closest('button[aria-haspopup="menu"], button[aria-haspopup="dialog"], button[aria-haspopup="listbox"]');
		} catch (ignoredPopup) { labelled = null; }
		if (!labelled) return false;
		// 排除掉 +/权限（它们有自己的标记与 aria-label），剩下的 popup 按钮即模型。
		try {
			if (labelled.hasAttribute('data-dshr-composer-add')) return false;
			if (labelled.hasAttribute('data-dshr-composer-access')) return false;
		} catch (ignoredAttr) { /* 无属性则继续按名单判 */ }
		return true;
	}

	/**
	 * 落点算不算「会打开命令面板/弹层的那类非可编辑触发器」。
	 *
	 * 判据用**官方 aria-label**（中英都列）而不是 hook 自己打的标记：
	 * hook 标记（data-dshr-composer-add 等）由 syncComposerChrome 写，
	 * 冷启动第一次点「+」时它可能还没写上，用它会漏掉最关键的那一次。
	 * 其次再兜一层：落点位于 composer 卡片内、且是可交互控件（按钮/菜单项等）。
	 *
	 * T69：**发送按钮必须在这里第一个被排除**（见 isComposerSendPoint）。
	 * 删除 `[data-dshr-composer-send]` 出 COMPOSER_TRIGGER_SELECTOR 是不够的 ——
	 * 下面的兜底分支会把它（连同其内部 svg/path）重新判成触发器。
	 */
	function isPanelTriggerPoint(target) {
		if (!isElement(target) || !target.closest) return false;
		// **最先**排除发送。真机症状：键盘弹着时点发送，消息发不出去、键盘又弹出来。
		// 根因就是这里原先把发送判成触发器 ⇒ armComposerFocus() 抢焦点 + 搅 inputmode。
		if (isComposerSendPoint(target)) {
			focusGuardStats.sendExcluded += 1;
			return false;
		}
		// **先**排除「已经打开的面板/弹层里的条目」，再谈布防。
		// 官方把命令面板挂在 composer 卡片内部，所以这些条目同样落在 composer 卡片里；
		// 一旦对它们布防，就会顺手 markUserFocusIntent() 撑开守卫的放行窗口，
		// 于是面板**下游**自己的输入框（例如「模型」子面板里的搜索框
		// input.EhuiKa_search）就能抢到焦点并把软键盘弹起来 —— 正是本任务要消灭的
		// 那类「非用户点输入框造成的聚焦」。AVD 实测（t48-report §5）就是这个坑。
		// 面板条目本身不需要布防：面板此刻已经开着，composer 的焦点早就到位。
		// ⇒ 排除掉，维持 T42 对它们的原有行为。
		if (target.closest(OPEN_PANEL_SELECTOR)) return false;
		if (target.closest(COMPOSER_TRIGGER_SELECTOR)) return true;
		// 兜底：composer 卡片内的可交互控件。
		// 用 contains 而不是 closest(元素) —— closest 只接受**字符串**选择器，
		// 传元素会被转成 "[object HTMLDivElement]" 这种非法选择器并抛 SyntaxError。
		if (!target.closest('button, [role="button"], [role="menuitem"], [role="option"]')) return false;
		var composer = focusComposerEl();
		if (!composer) return false;
		var card = composer.parentElement;
		var depth = 0;
		while (isElement(card) && card !== document.body && depth < FOCUS_ARM_HOST_MAX_DEPTH) {
			if (card.contains(target)) return true;
			card = card.parentElement;
			depth += 1;
		}
		return false;
	}

	/**
	 * composer（含其内部节点）此刻是否已经持有 DOM 焦点。
	 */
	function composerHoldsFocus() {
		var composer = focusComposerEl();
		if (!isElement(composer)) return false;
		var active = document.activeElement;
		if (!active) return false;
		if (active === composer) return true;
		try {
			return !!(composer.contains && composer.contains(active));
		} catch (ignoredContains) { return false; }
	}

	/**
	 * 布防：打 inputmode="none" + 自己把焦点抢过来。
	 *
	 * 顺序要点：markUserFocusIntent() 必须在 focus() **之前** ——
	 * 否则守卫自己的 focusin 监听会在我们抢到焦点的同一刻把它收回去，
	 * 那就退回 T42 的行为（面板开不出来）。
	 *
	 * T51（R1）：窗口现在**只对 composer 这一棵树**放行（见 inUserFocusWindow），
	 * 不再是对整个文档放行。面板里那些自带输入框的子面板（模型搜索框）与 composer
	 * 无亲缘关系 ⇒ 拿不到这张通行证 ⇒ T50 §6.1 的键盘弹出被根除。
	 *
	 * ── 不变量（本函数**绝不做**的事，T69 加断言守住）──
	 *   1. **绝不 preventDefault / 绝不掉点击**：这里只做「打属性」+「标注意图」+
	 *      「补焦点」三类无副作用动作；三个落指监听器也全是 `{passive:true}`，
	 *      结构上就不可能取消事件。AVD 实测整条发送路径 `defaultPrevented` 恒为 false。
	 *   2. **绝不抢已经持焦的输入区**：见下面的 composerHoldsFocus() 早退。
	 */
	function armComposerFocus(skipFocus) {
		var composer = focusComposerEl();
		if (!isElement(composer)) return false;
		// T69：composer 已经持焦时**不布防**。
		//
		// 布防存在的唯一理由是「让官方随后那次抢焦点变成空操作」（焦点没变 ⇒ 无新
		// focusin ⇒ 无新 showSoftInput）。composer 本来就持焦 ⇒ 这个目的**已经达成**，
		// 此时再布防只剩净损失：
		//   - 把 inputmode="none" 塞到用户正在用的输入区上，500ms 后又摘掉；
		//     摘的那一刻 composer 仍持焦 ⇒ 浏览器重新向 IME 请求 showSoftInput
		//     ⇒ 真机症状「点发送后键盘又弹出来」；
		//   - 下面的 composer.focus() 会把 DOM 焦点从用户点的目标上搬走。
		//     在一次触摸序列进行到一半搬焦点，正是 WebView 可能不再为原目标合成 click
		//     的条件 ⇒ 真机症状「消息发不出去」（AVD 34/x86_64 上仍合成了，1/1 发出，
		//     但真机小米 15 上没有）。
		// 早退同时也让 composer.focus() 不再可能成为"吞点击"的那一步。
		//
		// T69 + T125（持焦仍需压键盘）：composer 已经持焦时**不抢焦点、但仍压住 IME**。
		//
		// 原 T69 直接 return false（零布防）：理由是“焦点没变 ⇒ 无新 focusin ⇒ 无新
		// showSoftInput，目的已达成”。但真机上已有文字（composer 持焦、键盘被返回键藏起）
		// 后点「+」仍弹键盘：官方打开面板时的重申焦点/IME restartInput 不需要新的
		// focusin 也能把键盘拉起来，此时 inputmode 上无压制 ⇒ 必弹。
		// 修法：持焦时跳过 composer.focus()（避免触摸序列中搬焦点吞掉触发器的 click，
		// 也是模型按钮“点不开”的同因），但仍打 inputmode="none" + 开放行窗口 +
		// 走同样的定时摘防。摘防后若仍持焦的极小重弹风险，远小于面板打开瞬间必弹。
		//
		// 仍要清掉粘性抑制：理由同下（T48 原始死结），clearFocusSticky 无副作用。
		if (composerHoldsFocus()) {
			clearFocusSticky(composer);
			if (focusArmEl && focusArmEl !== composer) disarmComposerFocus();
			watchComposerInputMode();
			markUserFocusIntent(composer);
			try {
				composer.setAttribute('inputmode', 'none');
			} catch (ignoredArmHeld) { /* 节点已卸载 */ }
			focusArmed = true;
			focusArmEl = composer;
			focusArmUntil = Date.now() + FOCUS_ARM_MS;
			if (focusArmTimer) clearTimeout(focusArmTimer);
			focusArmTimer = setTimeout(function () {
				focusArmTimer = 0;
				disarmComposerFocus();
			}, FOCUS_ARM_MS);
			focusGuardStats.armSkippedHeldFocus += 1;
			focusGuardStats.armed += 1;
			return true;
		}
		// 兜底：官方换节点实例时旧属性会跟着旧节点走，这里确保布防落在当前节点上。
		if (focusArmEl && focusArmEl !== composer) disarmComposerFocus();
		// T51：换节点 ⇒ 观察者跟着换。
		watchComposerInputMode();
		markUserFocusIntent(composer);
		try {
			composer.setAttribute('inputmode', 'none');
		} catch (ignoredArm) { /* 节点已卸载 */ }
		focusArmed = true;
		focusArmEl = composer;
		focusArmUntil = Date.now() + FOCUS_ARM_MS;
		// 自己先拿焦点：官方随后那次抢焦点就成了空操作 ⇒ 无新 focusin ⇒ 无新 showSoftInput。
		//
		// ⚠️ 负控制实测（T48 §7）：**这一步在当前实测范围内是冗余的**。
		// 删掉它之后，面板照样 3/3 打开、键盘照样 0/3 弹（NEG-2）——
		// 因为 markUserFocusIntent() 已经把官方那次抢焦点放行了，而 inputmode 也还在节点上。
		// 真正承重的是另外两步：意图窗口（没有它面板开不开，T46 §1 R1）与 inputmode（没有它键盘弹，NEG-1）。
		// **仍然保留这一步**：它是「官方抢焦点变成空操作」这件事不依赖 800ms 窗口时序的唯一兜底，
		// 且实测零副作用（删掉它行为不变）。改动前请重跑 NEG-2，别凭直觉删。
		//
		// T125：模型选择器跳过这一步（skipFocus）：模型菜单不需要 composer 持焦，
		// 而触摸序列中搬焦点会吞掉模型按钮的 click（与 T69 发送同因、不输入也改不了）。
		// 只压 inputmode + 开窗口，菜单打开不受影响，子面板搜索框仍由 focusin 守卫正常收回。
		if (skipFocus !== true) {
			try {
				composer.focus();
			} catch (ignoredFocus) { /* 节点已卸载 */ }
		}
		if (focusArmTimer) clearTimeout(focusArmTimer);
		focusArmTimer = setTimeout(function () {
			focusArmTimer = 0;
			disarmComposerFocus();
		}, FOCUS_ARM_MS);
		focusGuardStats.armed += 1;
		return true;
	}

	/**
	 * 摘防。四条路都会走到这里，保证 inputmode **不会**长期留在 composer 上
	 * （T46 实测：留着的话用户点输入框也不弹键盘）：
	 *   1. 面板渲染完（~500ms 定时）；
	 *   2. 下一次用户手势（onDown 开头无条件先摘一次）；
	 *   3. 节点被官方换掉（arm 时发现旧节点不是当前节点）；
	 *   4. T51：页面可见性/导航（visibilitychange / pageshow），见 bindFocusGuard。
	 *
	 * T51（R1）：这里**同时关掉放行窗口**。旧实现只摘 inputmode、不动
	 * userFocusWindowUntil，于是「＋」撑开的 800ms 通行证活过了 500ms 定时器，
	 * 外溢到面板的下一次交互 —— 这就是 T50 §6 那个反例的根因。T50 §6.6 的修法建议
	 * 正是这一句；本轮还额外把窗口收窄到「目标元素」（inUserFocusWindow），
	 * 两道一起上：窗口既不外溢、也不覆盖无关元素。
	 */
	function disarmComposerFocus() {
		if (focusArmTimer) {
			clearTimeout(focusArmTimer);
			focusArmTimer = 0;
		}
		if (focusArmEl && isElement(focusArmEl)) {
			try {
				focusArmEl.removeAttribute('inputmode');
			} catch (ignoredDisarm) { /* 节点已卸载 */ }
		}
		focusArmEl = null;
		if (focusArmed) focusGuardStats.disarmed += 1;
		focusArmed = false;
		focusArmUntil = 0;
		// T51（R1）：通行证与布防同生共死。
		clearUserFocusWindow();
	}

	/**
	 * 可编辑元素的「稳定签名」：同一个输入区即使被重渲染换掉节点实例，签名不变。
	 * 只用稳定标记（data-composer-input / data-lexical-editor）+ 标签/角色/contenteditable
	 * + 前两个 class，不掺绝对位置或节点引用。
	 */
	function focusIdentity(el) {
		if (!isElement(el)) return '';
		var tag = (el.tagName || '').toLowerCase();
		var role = el.getAttribute('role') || '';
		var ceAttr = el.getAttribute('contenteditable') || '';
		var stable = el.getAttribute('data-composer-input') || el.getAttribute('data-lexical-editor') || '';
		var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
		return tag + '|' + role + '|' + ceAttr + '|' + stable + '|' + cls;
	}

	function isFocusSticky(el) {
		if (!isElement(el)) return false;
		if (focusStickyNodes && focusStickyNodes.has(el)) return true;
		var key = focusIdentity(el);
		return !!key && focusStickyKeys[key] === true;
	}

	function markFocusSticky(el) {
		if (focusStickyNodes) focusStickyNodes.add(el);
		var key = focusIdentity(el);
		if (!key) return;
		focusStickyKeys[key] = true;
		focusStickyCounts[key] = 0;
		focusStickySince[key] = Date.now();
	}

	function clearFocusSticky(el) {
		if (focusStickyNodes && isElement(el)) focusStickyNodes.delete(el);
		var key = focusIdentity(el);
		if (!key) return;
		delete focusStickyKeys[key];
		delete focusStickyCounts[key];
		delete focusStickySince[key];
	}

	/**
	 * 粘性抑制的绝对安全阀：同一签名在 FOCUS_STICKY_SPAN_MS 内被收回超过
	 * FOCUS_STICKY_MAX 次就放手（最坏退回改动前行为）并计数，绝不无限 blur。
	 * 正常路径远达不到：官方打开快捷指令面板只抢 3 次，阈值为 12。
	 */
	function withinStickyBudget(el) {
		var key = focusIdentity(el);
		if (!key) return true;
		var now = Date.now();
		if (!(key in focusStickySince) || now - focusStickySince[key] > FOCUS_STICKY_SPAN_MS) {
			focusStickySince[key] = now;
			focusStickyCounts[key] = 0;
		}
		focusStickyCounts[key] += 1;
		if (focusStickyCounts[key] > FOCUS_STICKY_MAX) {
			focusGuardStats.capped += 1;
			clearFocusSticky(el);
			return false;
		}
		return true;
	}

	/**
	 * 收回非用户主动的聚焦。返回 true = 已收回，false = 绝对安全阀放手。
	 */
	function revokeStealthFocus(el) {
		var now = Date.now();
		// 已在粘性抑制中：不再因为计数而放手，持续收回（这正是 T42 要修的行为）。
		if (isFocusSticky(el)) {
			if (!withinStickyBudget(el)) return false;
			try {
				el.blur();
			} catch (ignoredBlur) { /* 节点已卸载 */ }
			focusGuardStats.revoked += 1;
			focusGuardStats.sticky += 1;
			return true;
		}
		if (el === focusRevokeEl && now - focusRevokeSince < FOCUS_REVOKE_SPAN_MS) {
			focusRevokeCount += 1;
			if (focusRevokeCount > FOCUS_REVOKE_MAX) {
				// T42：不再放手，转粘性抑制（旧的 return false 就是本缺陷的根因）。
				focusGuardStats.capped += 1;
				markFocusSticky(el);
				try {
					el.blur();
				} catch (ignoredBlur) { /* 节点已卸载 */ }
				focusGuardStats.revoked += 1;
				focusGuardStats.sticky += 1;
				return true;
			}
		} else {
			focusRevokeEl = el;
			focusRevokeCount = 1;
			focusRevokeSince = now;
		}
		try {
			el.blur();
		} catch (ignoredBlur) { /* 节点已卸载 */ }
		focusGuardStats.revoked += 1;
		return true;
	}

	function focusGuardActive() {
		return !isStrictOff() && !!hookOn;
	}

	function bindFocusGuard() {
		if (focusGuardBound) return;
		focusGuardBound = true;
		var onDown = function (event) {
			if (!focusGuardActive()) return;
			var target = event.target;
			// ── T76：先算「这一次落指是不是新手势」──────────────────────────────
			// 三道收口条件，任何一道成立都表示「上一次手势已经结束」：
			//   ① 上一次 click 已经把手势收了（正常路径，一次点按一次 click）；
			//   ② 本手势的落指已达 FOCUS_MAX_DOWNS_PER_GESTURE（实测真值就是 3：
			//      pointerdown + touchstart + mousedown），再来一个必是新手势；
			//   ③ 上一次手势开始已超过 FOCUS_ARM_MS（click 丢失时的兜底）。
			if (focusGestureOpen && Date.now() - focusGestureOpenedAt >= FOCUS_ARM_MS) {
				focusGestureOpen = false;
			}
			if (focusGestureOpen && focusGestureDowns >= FOCUS_MAX_DOWNS_PER_GESTURE) {
				focusGestureOpen = false;
			}
			var newDown = !focusGestureOpen;
			if (newDown) {
				focusGestureOpen = true;
				focusGestureDowns = 0;
				focusGestureOpenedAt = Date.now();
				focusGestureArmed = false;
				focusGuardStats.armNewGesture += 1;
			}
			focusGestureDowns += 1;
			// T51（R1）：**新**的一次落指先把放行窗口关掉。
			// 旧实现不分新手势同手势，于是「＋」那一下在 pointerdown 撑开的窗口会被
			// 同一手势的 touchstart / mousedown 清掉 —— T48 的承重步骤之一
			// （T46 §1 R1：窗口没了，面板开不出来）被自己撤。
			// 关掉之后，下面 armComposerFocus() / markUserFocusIntent(owner) 会
			// 按**这次**落指的意图重新开一个（且只对这次的目标元素生效）。
			// 之所以要限定「新手势」：要防的本来就是**用户接下来在面板里的另一下**，
			// 而同手势的后续落指与第一次是同一次用户意图。
			if (newDown) clearUserFocusWindow();
			// T48：任何一次**新**落指都先无条件摘一次防。
			// 这是「inputmode 不得长期留在 composer 上」的第二道保障（第一道是 500ms 定时）：
			// 用户落指在输入框上时，属性必须在浏览器默认聚焦动作发生**之前**就没了，
			// 否则这次真实点击也会被 inputmode=none 压住、键盘不弹（T46 实测）。
			// ⚠️ T76：必须限定新手势。同一手势里摘自己刚布的防，正是阻断②的根因。
			if (focusArmed && newDown) {
				disarmComposerFocus();
			} else if (focusArmed) {
				focusGuardStats.disarmSkippedSameGesture += 1;
			}
			// T51（R4）：非布防态下若 composer 身上还挂着 inputmode=none（第三方写的、
			// 或摘除被节流），在浏览器按节点决定 showSoftInput 之前先摘掉。
			sweepResidualInputMode();
			if (!isEditablePoint(target)) {
				// T135：落点在**已经打开的官方浮层**里（模型菜单/命令面板及其子面板）⇒
				// 开「浮层内手势」窗口（只对浮层内元素生效）。官方会在这类浮层内部自行
				// 搬焦点（点「模型」行 ⇒ 子面板搜索框自动聚焦），收回就会让浮层 dismiss。
				if (isInsideOpenPanel(target)) markPanelFocusIntent();
				// T48：落指在「会打开命令面板/弹层」的非可编辑触发器上（「+」这类）
				//   => 走布防形态：打 inputmode="none" + 我们自己抢焦点。
				// 这样官方随后打开面板时那次抢焦点是**空操作**（焦点没变），
				// 既不会无新 focusin 触发 showSoftInput，也不会被粘性抑制收回去。
				// **不能**在这里 clearFocusSticky：粘性抑制是给「非用户手势造成的聚焦」用的，
				// 而这条落指确实是用户手势，放行窗口（markUserFocusIntent）已经足够。
				//
				// T69：isPanelTriggerPoint() 第一件事就是排除「发送」⇒ 点发送永远走不到
				// 这里，布防的抢焦点与 inputmode 搅动不会发生在发送路径上。
				// T125：模型走“只压 IME、不抢焦点”（见 isModelTriggerPoint），避免吞 click。
				if (isPanelTriggerPoint(target)) {
					// T76：同手势内布防**只做一次**。第二、三次（touchstart / mousedown）
					// 直接跳过 —— 此时防要么还挂着（什么都不用做），要么被别的路摘了
					//（新落指/超时那两条会先把 focusGestureOpen 清掉，自然落到新手势分支）。
					if (!focusGestureArmed) {
						focusGestureArmed = true;
						armComposerFocus(isModelTriggerPoint(target));
					} else {
						focusGuardStats.armRepeatSameGesture += 1;
					}
				}
				return;
			}
			// T51（R1）：窗口记「用户这次点的那个输入区」，而不是对整页放行。
			// 用户点 A 之后 800ms 内官方若把焦点抢到 B 输入框，B 拿不到通行证 ⇒ 被收回。
			//
			// 目标取**两个**：落点解析出的可编辑宿主 + 当前 composer。
			// 官方 composer 是 Lexical，真实持焦节点与落点 closest 到的那个可编辑元素
			// 未必互为祖先/后代（实测：漏掉时 test:device 有 4 条 SKIP，
			// 原因「真实点按后输入框仍未持焦」）。两个都记上就覆盖了官方
			// 「把焦点落到真实输入节点」和「落点本身是输入节点」两种形态。
			// 仍然安全：面板子输入框与 composer 无亲缘关系，拿不到这张通行证。
			var intentEls = [editableOwnerOf(target)];
			var composerNow = focusComposerEl();
			if (isElement(composerNow)) intentEls.push(composerNow);
			markUserFocusIntent(intentEls);
			// T135：用户**主动点了输入框** ⇒ 之前为浮层压住的 IME 要撤掉（并还原原值），
			// 否则会退化成 T50 §5.2 那种「属性留在节点上、点了也弹不出键盘」的残留态。
			releasePanelIme();
			// 用户真的落指在这个输入区上 => 解除它的粘性抑制，这次聚焦与后续键盘照常。
			// 落点可能是可编辑元素本身，也可能是它内部的子节点，两处都要清。
			if (isElement(target)) clearFocusSticky(target);
			if (isElement(target) && target.closest) {
				var owner = target.closest('input, textarea, select, [contenteditable]');
				if (owner) clearFocusSticky(owner);
			}
		};
		document.addEventListener('touchstart', onDown, { capture: true, passive: true });
		document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
		document.addEventListener('mousedown', onDown, { capture: true, passive: true });
		// T76：手势收尾。全 passive：只写自己那几个布尔量，结构上不可能吞任何事件。
		//
		// **用 click，不用 pointerup/touchend** —— 这是上面的实测结论：
		// 兼容 mousedown 是在 pointerup/touchend **之后**才发的（实测 +411ms vs +395ms），
		// 按抬手划分手势会把同一次点按的 mousedown 误判成新手势，原缺陷原样复发。
		// pointercancel 也收口：系统手势取消后不会再有兼容 mousedown，收了是对的。
		var onGestureEnd = function () {
			focusGestureOpen = false;
			focusGestureArmed = false;
		};
		document.addEventListener('click', onGestureEnd, { capture: true, passive: true });
		document.addEventListener('pointercancel', onGestureEnd, { capture: true, passive: true });
		document.addEventListener('touchcancel', onGestureEnd, { capture: true, passive: true });
		document.addEventListener('focusin', function (event) {
			if (!focusGuardActive()) return;
			var el = event.target;
			// T51（R4）：聚焦发生的这一刻就是浏览器按节点上的 inputmode 决定
			// 要不要 showSoftInput 的那一刻，所以残留兜底挂在这里。
			sweepResidualInputMode();
			if (!isEditableFocus(el)) return;
			// T51（R1）：窗口只对「这次意图的目标元素及其亲缘」放行，不再对整篇文档放行。
			if (inUserFocusWindow(el)) return;
			// T135：用户手指正在浮层里 ⇒ 官方在浮层内部自己搬焦点（模型子面板自动聚焦
			// 搜索框）不是「偷焦点」，收回去会让官方浮层 dismiss（模型改不了的根因）。
			// 放行焦点但压住 IME：菜单活着、键盘不弹。
			if (inPanelFocusWindow(el)) {
				mutePanelIme(el);
				return;
			}
			revokeStealthFocus(el);
		}, { capture: true });
		// T51（R1）：可见性/导航也是窗口生命周期的一部分。
		// 切走再切回来、或发生同文档导航，之前的通行证不该继续有效；
		// 同时 R4 的残留兜底要在「切回来看到输入框」时被触发一次。
		var onVisibility = function () {
			if (document.visibilityState === 'hidden') {
				clearUserFocusWindow();
				if (focusArmed) disarmComposerFocus();
			} else {
				sweepResidualInputMode();
			}
		};
		document.addEventListener('visibilitychange', onVisibility, { capture: true });
		window.addEventListener('pageshow', function () {
			clearUserFocusWindow();
			sweepResidualInputMode();
		}, { capture: true });
	}

	// ── T21 修复 3：把「效果」上报给原生（诊断用）──
	//
	// T16 缺陷 #3：hook 只在 IIFE 顶部就置 window.__dshRemoteMobileInstalled（早于任何
	// DOM 同步），原生注入自检读的就是这个变量 ⇒「装上了但没收敛」（无鲸鱼 / 无 frame /
	// 无 data-dshr-ready）这种半吊子状态对原生**完全不可见**，也不会补注。
	// 这里在 boot 完成 / syncDom 收敛后把真实状态过一遍 JS 桥，原生日志里就能一眼分清
	// 「没装上」与「装上了但没生效」。严格 OFF（平板档）也要报，那时 on=false。
	//
	// DshRemoteApp.setUiDiag 由原生侧另一个任务实现；缺失时 typeof 判空、静默跳过，
	// 绝不能因此抛错（旧 WebView 也没有这套桥）。
	// 判重存的是**判重键**（不含 ts），不是整份 payload：载荷里带 Date.now()，
	// 拿它判重会永不相等，去抖就成了空转（每轮 syncDom 都过桥）。
	var lastUiDiagKey = null;
	var uiDiagBridgeMissing = false;
	// T112（S1）：断开持续态里"按电平重推"的次数（只读证据；健康稳态恒 0）。
	var uiDiagLevelPushes = 0;

	// T31-3/T31-4 的共享状态。**必须在这里声明**：collectUiDiag（第 ~1180 行）
	// 会读 lastDisconnectAt，而它在 IIFE 顶部的 reportUiDiag() 调用点之前就被求值。
	var RESUME_PROBE_DELAY_MS = 1200;
	// T82：二次确认延后 2000→400ms。改前实测：断开后要等满 2s 才走到"确实断开"，
	// 而这一轮的诉求是"不再等 30 秒"——把确认窗口压到 400ms 是这条时间线最短的一段。
	var RESUME_MIN_INTERVAL_MS = 8000;
	// T38-2 新增的两道防风暴闸：二次确认的延后时长，以及单页面生命周期的硬上限。
	// T82：15s→8s、3→6。
	// T112b：**6 → 2**。依据是 T110 的决定性 A/B（`scratch/t110/report.md` §8.4 ①，同一装置、
	//   链路始终健康、只做一次前后台切换）：上限 6 时 rc.2.7/rc.2.8 各推 6 次、
	//   **6 次全是真的掐断**（≈50s 内连掉 6 次）；上限 2 把最坏窗口从 6×(0.4s 确认 + 8s 间隔)
	//   ≈ 50.4s 压到 2×8.4s ≈ 17s。核心理由不是"少推几次"，而是：**这条路径上任何一次多推
	//   都是用户可见的掉线**（推 = 掐断在用 socket），所以上限必须按"最坏情况用户能忍几次"
	//   来定，而不是按"退避梯子的同量级"来定（T82 那套核算的前提在 T110 里已被证否）。
	//   配合下面 requestUpstreamReconnect 的按来源分流（只有 WS 观测到的真 close 才允许掐断），
	//   上限 2 只是**第二道**兜底：分流负责"不该掐的绝不掐"，上限负责"该掐的也别一直掐"。
	var RESUME_CONFIRM_DELAY_MS = 400;
	var RESUME_MAX_NUDGES = 2;
	// T82：断开持续态的巡检步长。健康时这个 tick 只做一次判据读取就返回（零开销）。
	var RESUME_DOWN_TICK_MS = 1000;
	// ── T95：回前台"主动探活" + 回前台首次推不等间隔 ──
	//
	// 真值依据（`scratch/t95/report.md §1`，全部是我自己装置上的原始真值）：
	//   ① 后台期间 JS 被**整体冻结**（250ms 采样器单拍空档 47755ms、rAF 105→106）；
	//   ② 但冻结本身不会卡：后台 240s + 期间**干净断线**，回前台 **864ms 自愈、nudge 0 次**
	//      （客户端每次重连都新建 socket，不依赖定时器）⇒ 候选①只是共因；
	//   ③ 真正"几分钟不恢复"的是**握手挂死**：mux 载体（`dsh-api-gateway/lib/client.js:507,602-613`）
	//      **没有握手超时**，一次挂死的 `new WebSocket()` 把 `keepAlive` 永久占住、上层 loop 停在
	//      `await failed`，只在每次尝试发 `connecting` ⇒ 页面永远"重新连接中"，而我们的 nudge
	//      作用在**上层 generation**、够不到它（装置复现 §1.6：横幅 25/25 可见、nudge 6 次后
	//      `cap-reached`、190s 不恢复）；
	//   ④ 断开态下客户端自己空转一轮约 **20s**（`generationReadyTimeoutMs=15000` + 退避），
	//      而 nudge 能把"服务端已回来 → 第一次重连"压到 ~0.7s（T90 实测 5496ms→681ms）
	//      ⇒ **断开态下越早推越好**；
	//   ⑤ 可回前台的"首次推"会被 `RESUME_MIN_INTERVAL_MS=8000` 压住（离开前刚推过就最多干等 8s）；
	//   ⑥ **半开**（socket 早死、`close` 事件永不到）时判据说"健康"、一次都不推；而实测
	//      mux 健康空闲 75s 内**收 0 帧 / 发 0 帧**（§1.8）⇒ **不能**用"静默"当半开判据，
	//      只能回前台**主动探活**一次。
	//
	// 风控边界（T112 之后）：
	//   · 主动探活只在"回前台 + 后台待够 RESUME_VERIFY_MIN_HIDDEN_MS"时才发；
	//   · 一次回前台最多 **2 个**请求（主探 + 确认探），**都不是常开**；
	//   · 主探 3s 硬超时（取值不变），确认探 6s；
	//   · **连续两次失败才判"传输层已死"**（T112，见下），一次失败只记账、不动作；
	//   · "跳过间隔"只给回前台这 5s 窗口（自到期，不长期放宽）；
	//   · 上限 6 次 / 8s 间隔 / 二次确认三道具在。
	//
	// T112 改动依据（半开装置上的原始真值见 report §1/§5）：
	//   改前：**一次** 3s 超时就直接写 60s "传输层已死"闩锁 + 立刻推一次 nudge
	//   （`requestUpstreamReconnect()` ⇒ 派发 offline→online ⇒ 客户端 **abort 当前连接并新建**）。
	//   真机刚从深休眠/换网回来时，第一次 TLS/TCP 往返超 3s 并不罕见 ⇒ 一次超时 =
	//   60s 假"正在重连" + **自造一次真重连**。这正是用户报的"频繁重连 / 发消息要等"。
	//   现在：① 主探失败只记账并排一次**确认探**（间隔 400ms，沿用既有二次确认语义）；
	//         ② 确认探超时放宽到 6s（专门吸收"刚回前台链路还没热"的那一段）；
	//         ③ **两次都失败**才判死 ⇒ 才写信任闩锁、才推 nudge（"信任期只授予确认过的判定"）；
	//         ④ 信任期 60s → 20s：即使仍有残余误判，用户可见窗口从 60s 收到 20s；且 20s 之后
	//            若链路真死，WS 层（close 宽限 / CONNECTING 宽限）会独立把判据重新置真，不会漏。
	//   半开发现时延代价（真值见 §5）：最坏 3 + 0.4 + 6 = 9.4s（改前 3s）；确认探**快速失败**
	//   （连接被拒/网络变更）时 ≈ 3.4s，与改前同级。
	var RESUME_VERIFY_MIN_HIDDEN_MS = 20000;   // 只有"后台待够久"才探活 ⇒ 健康前台零请求
	var RESUME_VERIFY_TIMEOUT_MS = 3000;       // 探活硬超时：超过即认为传输层已死
	var RESUME_VERIFY_CONFIRM_DELAY_MS = 400;  // T112：主探失败 → 确认探之间的间隔（二次确认语义）
	var RESUME_VERIFY_CONFIRM_TIMEOUT_MS = 6000; // T112：**确认探**的超时（更宽容）
	var RESUME_VERIFY_CONFIRM_FAILS = 2;       // T112：连续失败 2 次才判"传输层已死"
	var RESUME_VERIFY_TRUST_MS = 20000;        // 一次"传输层已死"判定的有效期（期间判据恒"断"）
	var RESUME_BYPASS_WINDOW_MS = 5000;        // 回前台这条路径允许"跳过最小间隔"的时间窗
	var RESUME_HARD_MIN_GAP_MS = 1500;         // 任何两次推之间的**硬地板**（回前台窗口也不能破）
	var resumeHiddenSince = 0;                 // 进入 hidden 的时刻（0 = 已回前台/从未隐藏）
	var resumeBypassUntil = 0;                 // >now 时，推 nudge 不受 RESUME_MIN_INTERVAL_MS 约束
	var resumeVerifyDownAt = 0;                // 主动探活判定"传输层已死"的时刻（0 = 未判定）
	var resumeVerifyResult = 'never';          // 'never'/'ok'/'timeout'/'error'/'fail-1'（已失败一次，等确认探）
	var resumeVerifyRunning = false;           // 探活进行中（防重入）
	var resumeVerifyAt = 0;                    // 最近一次探活发起时刻
	// T112：连续失败计数 + 确认探的排程（判断"传输层已死"要**两次**独立失败）。
	var resumeVerifyFailCount = 0;
	var resumeVerifyFailAt = 0;
	var resumeVerifyRetryTimer = 0;
	var resumeVerifyProbeCount = 0;            // 本次页面生命周期内发出的探活请求总数（只读证据）
	// "这一拍是回前台进来的"意图位。**不用形参**：`scripts/test-resume-recovery.mjs`
	// 逐字匹配 `function probeResumeRecovery()`，形参会让那条契约变红（不许改那个脚本）。
	var resumeFromResumeIntent = false;
	// T38-2：断开闩锁。resumeDownSince = 第一次观测到"确实断开"的时刻（0 = 未断开）；
	// resumeNudgeArmed = 是否允许推。推过一次后必须先观测到恢复才重新武装。
	var resumeDownSince = 0;
	var resumeDownConfirmScheduled = false;
	var resumeNudgeArmed = true;
	var resumeNudgeCount = 0;
	var resumeLastNudgeAt = 0;
	var resumeLastProbeAt = 0;
	var resumeLastProbeResult = 'never';
	// T82：断开持续态巡检定时器句柄（0 = 未装）。只在观测到断开时装上，恢复即卸，健康时零开销。
	var resumeDownTick = 0;
	// T82：最近一次实际用了哪一层入口（'connection-reconnect' / 'network-transition'）。
	var resumeLastNudgeResult = 'never';
	/** 本次页面生命周期内第一次观测到"确实断开"的时刻；0 = 从未断线。 */
	var lastDisconnectAt = 0;

	// ── T38-2：结构化"是否真的断开"判据（替换 T31 的裸 reconnect 扫全页 innerText）──
	//
	// T31 的写法：/重新连接|正在重连|重连中|reconnect/i.test(document.body.innerText)。
	// 问题出在最后那个 `reconnect`（还带 /i，且不锚定任何结构）：英文界面里的
	// "Reconnecting"、一个叫 "Reconnect" 的按钮、文件名、甚至终端输出里出现该词，
	// 整页都算命中 ⇒ 连接健康也会被判成"正在断线"，回前台就反复推。
	//
	// 现在的判据（两条同时成立才算"确实断开"）：
	//   (1) **元素级 + 整串锚定**：存在一个可见元素，它**整段文字就是**重连状态
	//       （正则 ^...$ 全匹配，且长度 ≤ RESUME_STATUS_MAX_LEN）。
	//       散文、代码块、文件名、日志行永远匹配不上 —— 这就是"不靠宽泛子串"。
	//   (2) **排除可交互控件**：button / a / input / [role=button] / [onclick] 及其后代
	//       一律不算。「Reconnect 按钮」是让人去点的，不是"正在重连"的状态。
	// 另有第三道闸在 probeResumeRecovery 里：单次观测不动作，要隔
	// RESUME_CONFIRM_DELAY_MS 二次确认（见那里的说明）。
	//
	// 文案只保留 DSH 真实出现过的整串（0.1.5-rc.1 实测是「重新连接中...」），
	// 裸 reconnect 已从判据里彻底移除。
	var RECONNECT_STATUS_RE = /^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)[\.…]{0,3}$/i;
	var RESUME_STATUS_MAX_LEN = 24;
	var RESUME_STATUS_SCAN_LIMIT = 4000;

	// ── T88：层 1 —— 官方 `<button data-phase="connecting">`（与原生 ReconnectBanner.PROBE_JS 同源）──
	//
	// 官方 0.2.0-rc.2 的「重新连接中」渲染成这个（`dsh-web-frontend/dist` 里 `q_()` 的 connecting
	// 分支，逐字对着产物读出来的）：
	//   <button type="button" data-phase="connecting" aria-label="连接中断，正在重试，点击立即重连">
	//     <span class="_icon_1gwo3_69" aria-hidden="true">…</span>
	//     <span class="_label_1gwo3_80">重新连接中<span class="_dots_1gwo3_84" aria-hidden="true">…</span></span>
	//   </button>
	//
	// 而层 2（下面的老路径）整条建在「排除可交互控件**及其后代**」上 ⇒ 这条永远被跳过：
	// 内层 `span.label` 本身不是 button，但 `closest('button,a,[role="button"],[onclick]')`
	// 命中的是它那个 `<button>` 祖先 ⇒ 直接 continue。⇒ 真实页面上
	// findReconnectStatusElement() **恒为 null**（T87 实测：29s 真实断线、60 帧 500ms 采样 0 命中）。
	// 后果是三条路径一起失灵：
	//   ① probeResumeRecovery() 第一行 `reconnecting` 恒 false ⇒ 直接走健康分支（闩锁复位 + 卸巡检）
	//      ⇒ T82 的 400ms/8s/6 次与 1s 巡检**一次都不会跑**（整套自愈成了死代码）；
	//   ② resumeRecoveryState().reconnecting 恒 false；
	//   ③ collectUiDiag().wsState 恒 'ok' —— App 设置页那行诊断对"正在重连"说谎。
	//
	// 层 1 是**定向例外**：只认官方这一条结构，**刻意不**放宽 isInteractiveNode()
	// （放宽会把发送键 /「+」/ composer 一起放进来 —— 误报比漏报糟得多）。
	// 四条判据与原生 PROBE_JS 层 1 **逐条同源**：
	//   ① 扫 `[data-phase]`（上限 64），值 trim + toLowerCase 后**恰等于** connecting
	//      （disconnected 不认：那条的文案是「连接异常，刷新重试」，认它就说错话）；
	//   ② aria-label 命中 composer 排除清单（发送键 /「+」键，中英两式逐条列全）⇒ 直接否决；
	//   ③ getClientRects().length > 0（有布局盒）；只挡 display:none / 未挂载 ——
	//      侧栏用 left:-320px 收起时仍有盒，与原生 isOnScreen 的分工保持一致；
	//   ④ 文案锚定：取该元素**去掉 aria-hidden="true" 子树后**的文字（官方那条的 icon 与三点 dots
	//      都带 aria-hidden ⇒ 等价于只读 label 文案，且**不依赖 CSS module 哈希类名**：
	//      label 的类名是 `_label_1gwo3_80` 这种），整串命中 / 去尾句点后整串命中 / aria 命中
	//      「重连|reconnect」—— 三取一。
	//   ⑤ composer 祖先否决：官方那条的祖先链上没有 contenteditable / role=textbox
	//      ⇒ 真实页面上这条永不生效；它挡的是"composer 里手打文案 + 带 data-phase 的标记面"
	//      这种组合（见 isInsideComposer）。
	//
	// **两端不漂移的机制**（不是靠人记）：下面三个字面量与 ReconnectBanner 的三个 Java 常量
	// **逐字符相同**（含顺序、`$` 与 `/i`），并且 `scripts/test-mobile-chrome.mjs` 里有一条断言
	// **同时读这两个文件**、抽出双方字面量做相等比较 ⇒ 任何一端被单独改动，`pnpm test:mobile`
	// 立刻变红（原生侧另有 `ReconnectBannerTest` 把同一份字面量抽出来真跑正/负例）。
	var OFFICIAL_PHASE = 'connecting';
	var RESUME_PHASE_SCAN_LIMIT = 64;
	var RESUME_PHASE_TEXT_PAD = 8;
	// 与原生 `ReconnectBanner.COMPOSER_DENY_JS` 逐字符相同。
	var COMPOSER_DENY_RE = /^(?:send message|发送消息|send|发送|submit|提交|add files or run commands|添加文件或运行命令|添加文件或调用指令|添加文件或运行指令|命令|指令|commands)$/i;
	// 与原生 `ReconnectBanner.ARIA_RE_JS` 逐字符相同。
	var RECONNECT_ARIA_RE = /重连|reconnect/i;
	// 与原生 `ReconnectBanner.COMPOSER_ROLE_JS` 逐字符相同（T90：把 T88 遗留的那处
	// 两端差异收口 —— 层 1 的 ⑤ composer 祖先否决现在两端**同一条名单、同一段走法**）。
	var COMPOSER_ROLE_RE = /^(?:textbox|searchbox|combobox)$/;

	/** 层 1 专用：aria-label（trim 后）。与原生 PROBE_JS 的 `aria(n)` 同义。 */
	function ariaLabelOf(node) {
		try {
			return String((node.getAttribute && node.getAttribute('aria-label')) || '').trim();
		} catch (ignoredAriaLabel) {
			return '';
		}
	}

	/**
	 * 层 1 专用：该元素**去掉 aria-hidden="true" 子树后**的文字。
	 * 只累加文本节点、整棵 aria-hidden 子树跳过 —— 与原生 PROBE_JS 的 `anchor(n)` 同算法。
	 * 用递归而不是 innerText 的理由：官方 label 与三点 dots 是兄弟，innerText 会把 dots 一起读进来，
	 * 而 dots 的 `aria-hidden="true"` 正是"这不是文案、别锚定它"的官方声明。
	 */
	function anchoredText(node) {
		var out = '';
		try {
			if (!node || !node.childNodes) return '';
			for (var i = 0; i < node.childNodes.length; i++) {
				var child = node.childNodes[i];
				if (child.nodeType === 3) { out += String(child.nodeValue || ''); continue; }
				if (child.nodeType !== 1) continue;
				if (String((child.getAttribute && child.getAttribute('aria-hidden')) || '').toLowerCase() === 'true') continue;
				out += anchoredText(child);
			}
		} catch (ignoredAnchoredText) { return out; }
		return out;
	}

	/** 层 1 专用：去掉尾部空白/省略号与 1–3 个句点再 trim。与原生 PROBE_JS 的 `core(s)` 同义。 */
	function coreStatusText(text) {
		return String(text)
			.replace(/[\s\u2026]+$/, '')
			.replace(/\.{1,3}$/, '')
			.trim();
	}

	/**
	 * 层 1 的**例外边界**（T88 实测出来的补丁）：
	 * 豁免只给官方那条**自己**（它就是一个 `<button>`），不给"被 composer 包住"的情形。
	 *
	 * 官方那条住在 settings 触发行（`SettingsRoot` 的 `triggerRow`）里，祖先链上没有
	 * contenteditable / role=textbox ⇒ 这条否决在**真实页面上永不生效**。
	 * 它挡的是"用户在 composer 里手打一句「重新连接中」，而某个标记面又恰好带了
	 * data-phase"这类组合：改前那条（层 2）会因为 composer 自身/后代不是 button 而误报，
	 * 改后层 1 也会认 —— 所以这里必须显式否决。
	 *
	 * ⚠️ T88 曾与原生 `PROBE_JS` 层 1 有**一处**差别（原生没有这条否决、更松）。
	 * T90 把同一条补进原生侧（`ReconnectBanner.PROBE_JS` 的 `insideComposer`，用同一份
	 * role 字面量 {@link COMPOSER_ROLE_RE}）⇒ **两端同算法、同名单、同位置**，
	 * `scripts/test-mobile-chrome.mjs` 抽两端字面量做逐字符比较，`scratch/t90/dom-truth.mjs`
	 * 用**同一批 42 条夹具**在同一页里跑两端判据逐条比对结论。
	 */
	function isInsideComposer(node) {
		try {
			var cur = node;
			while (cur && cur.nodeType === 1) {
				var role = String(cur.getAttribute('role') || '').toLowerCase();
				if (role && COMPOSER_ROLE_RE.test(role)) return true;
				if (isEditableNode(cur)) return true;
				cur = cur.parentElement;
			}
		} catch (ignoredComposerAncestor) { return false; }
		return false;
	}

	/**
	 * T88 层 1：官方 `[data-phase="connecting"]` 那条；找不到返回 null。
	 * 逐条判据见上方注释（① 恰等于 connecting ② 排除清单 ③ 有布局盒 ④ 文案锚定三取一
	 * ⑤ composer 祖先否决）。
	 */
	function findOfficialReconnectButton() {
		if (!document.body || typeof document.body.querySelectorAll !== 'function') return null;
		var nodes;
		try { nodes = document.body.querySelectorAll('[data-phase]'); } catch (ignoredPhaseQuery) { return null; }
		var n = nodes && nodes.length ? nodes.length : 0;
		if (n > RESUME_PHASE_SCAN_LIMIT) n = RESUME_PHASE_SCAN_LIMIT;
		for (var i = 0; i < n; i++) {
			var el = nodes[i];
			var phase = '';
			try { phase = String(el.getAttribute('data-phase') || '').trim().toLowerCase(); } catch (ignoredPhaseAttr) { continue; }
			if (phase !== OFFICIAL_PHASE) continue;
			var aria = ariaLabelOf(el);
			if (COMPOSER_DENY_RE.test(aria)) continue;
			if (isInsideComposer(el)) continue;
			if (!isVisible(el)) continue;
			var text = anchoredText(el).trim();
			if (!text || text.length > RESUME_STATUS_MAX_LEN + RESUME_PHASE_TEXT_PAD) continue;
			if (!RECONNECT_STATUS_RE.test(text)
				&& !RECONNECT_STATUS_RE.test(coreStatusText(text))
				&& !RECONNECT_ARIA_RE.test(aria)) continue;
			return el;
		}
		return null;
	}

	/** 与原生 PROBE_JS 的 `editable(n)` 同义：contenteditable 存在且不是 "false"。 */
	function isEditableNode(node) {
		try {
			var value = node.getAttribute('contenteditable');
			if (value === null || value === undefined) return false;
			return String(value).toLowerCase() !== 'false';
		} catch (ignoredEditableAttr) { return false; }
	}

	/**
	 * 可交互控件不算"状态"：按钮/链接是让人去点的；输入控件里的文字是**用户自己打的**。
	 *
	 * T88：这份排除名单与原生 PROBE_JS 的 `inter(n)` **逐条对齐**（补齐 T86 给原生加的
	 * `role=textbox|searchbox|combobox|menuitem|checkbox|radio|switch|tab|slider`、
	 * `[contenteditable]` 本体与 `closest` 里的 `[role="textbox"],[contenteditable]`）。
	 * 这是**收紧**（能匹配上的元素只会变少）、不是放宽：官方 composer 就是一个
	 * `div[contenteditable][role=textbox]`，用户在里打一句「重新连接中」不该让整页被判成
	 * "正在重连"——层 2 的整串锚定挡不住它，只有这份名单能挡（T86 在原生侧就是这么钉的，
	 * 两边名单不一致会立刻在 `scratch/t88/dom-truth.mjs` 的 composer 负例上显形）。
	 */
	function isInteractiveNode(node) {
		if (!isElement(node)) return true;
		var tag = (node.tagName || '').toLowerCase();
		if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
		try {
			var role = String(node.getAttribute('role') || '').toLowerCase();
			if (role === 'button' || role === 'link' || role === 'textbox' || role === 'searchbox'
				|| role === 'combobox' || role === 'menuitem' || role === 'checkbox' || role === 'radio'
				|| role === 'switch' || role === 'tab' || role === 'slider') return true;
			if (node.hasAttribute('onclick')) return true;
			if (isEditableNode(node)) return true;
			if (node.closest) {
				if (node.closest('button,a,[role="button"],[role="textbox"],[onclick],[contenteditable]')) return true;
			}
		} catch (ignoredInteractive) {}
		return false;
	}

	/**
	 * 找出「正在重连」的那个元素，并报出**是哪一层**认出来的；找不到返回 src=0。
	 * 分层与原生 PROBE_JS 一致：层 1（官方按钮）优先，层 2 兜底。
	 * src 只给测试/排查用（不并进 collectUiDiag：那个载荷的字段集被 test:device 逐字钉住）。
	 */
	function findReconnectStatusDetail() {
		var official = findOfficialReconnectButton();
		if (official) return { src: 1, el: official };
		var legacy = findTextReconnectStatusElement();
		if (legacy) return { src: 2, el: legacy };
		return { src: 0, el: null };
	}

	/**
	 * 找出「正在重连」的那个元素；找不到返回 null。**只有两层**：
	 *   层 1（T88）：官方 `<button data-phase="connecting">` —— 定向例外，见上方注释；
	 *   层 2（T38-2）：非交互元素里"整段文字就是重连状态"的那条（判据原样未动）。
	 * 层 1 命中即返回：官方那条比"页面上随便一段文案"更可信，优先级同原生 PROBE_JS。
	 */
	function findReconnectStatusElement() {
		return findReconnectStatusDetail().el;
	}

	/**
	 * 层 2（T38-2 老路径，判据不变，向后兼容）：找出「整段文字就是重连状态」的可见、非交互元素。
	 *
	 * 刻意**不查 document.body**：body 是所有文本的并集，一旦匹配就退化成
	 * T31 那种"整页扫子串"，正是要消灭的误触发来源。
	 */
	function findTextReconnectStatusElement() {
		if (!document.body || typeof document.body.querySelectorAll !== 'function') return null;
		var nodes = document.body.querySelectorAll('div,span,p,section,li,strong,em,label,h1,h2,h3,h4,h5,h6');
		var n = nodes.length;
		if (n > RESUME_STATUS_SCAN_LIMIT) n = RESUME_STATUS_SCAN_LIMIT;
		for (var i = 0; i < n; i++) {
			var el = nodes[i];
			if (isInteractiveNode(el)) continue;
			var text = '';
			try { text = (el.innerText || el.textContent || '').trim(); } catch (ignoredStatusText) { continue; }
			if (!text || text.length > RESUME_STATUS_MAX_LEN) continue;
			if (!RECONNECT_STATUS_RE.test(text)) continue;
			if (!isVisible(el)) continue;
			return el;
		}
		return null;
	}

	function collectUiDiag() {
		var root = document.documentElement;
		// T31-4：把连接状态并进同一份诊断载荷 —— 用户远程（手机不接电脑）时
		// 只需看 App 设置页这一行就知道"是不是真的在掉线、上次什么时候掉的"。
		// T38-2：判据换成 findReconnectStatusElement()（元素级 + 整串锚定 + 排除可交互控件），
		// 与 probeResumeRecovery 走**同一个**函数 —— 诊断行不再可能和实际动作口径不一致。
		// T88：该函数现在有两层（层 1 = 官方 `[data-phase="connecting"]`），诊断行因此能在
		// **真实页面**上如实报出 reconnecting（改前层 1 缺失 ⇒ 这里恒 'ok'）。
		// wsState 取值只有三个，且全部可产出：
		//   reconnecting   此刻确实处于断开态；
		//   ok-recovered   曾经断过、现在已恢复（lastDisconnectAt > 0）；
		//   ok             本次页面生命周期内一次都没断过。
		// （T31 注释里写过的 never-seen 从来不可能出现，已删除。）
		// lastDisconnectAt 为 0 表示本次页面生命周期内没有观测到断线。
		var reconnecting = false;
		try {
			// T90：判据 = 层 1/层 2 的 DOM 文案（T88）**或** WS 观测（T90）。
			// rail（左栏收起）时官方那条指示器根本不渲染 ⇒ 只有 WS 这一条能如实报出
			// "正在重连"；wide 布局下 DOM 那条更精确，两者任一为真即为真。
			reconnecting = isConnectionDown();
		} catch (ignoredDiagText) {}
		return {
			device: deviceMode,
			on: !!hookOn,
			rootClass: root.className || '',
			ready: root.getAttribute('data-dshr-ready') === '1',
			whale: isVisible(document.getElementById('dshr-mobile-whale')),
			frame: !!findFrame(),
			strictOff: isStrictOff(),
			wsState: reconnecting ? 'reconnecting' : (lastDisconnectAt > 0 ? 'ok-recovered' : 'ok'),
			lastDisconnectAt: lastDisconnectAt || 0,
			ts: Date.now(),
		};
	}

	/**
	 * 去抖键：整份载荷去掉 **ts** 后的序列化结果。
	 * 时间戳每毫秒都变，带上它判重永不相等 ⇒ 旧实现（拿整份 payload 判重）的去抖是死代码。
	 * 用 replacer 而不是手拼字段列表：以后新增诊断字段自动参与判重，不会漏。
	 */
	function uiDiagDedupeKey(diag) {
		return JSON.stringify(diag, function (k, v) {
			return k === 'ts' ? undefined : v;
		});
	}

	function reportUiDiag() {
		var payload, key;
		try {
			var diag = collectUiDiag();
			payload = JSON.stringify(diag);
			key = uiDiagDedupeKey(diag);
		} catch (ignoredDiagJson) {
			return false;
		}
		// 去抖：syncDom 由 MutationObserver 驱动（50ms 合并），收敛期会连跑很多次。
		// 状态字段（device/on/rootClass/ready/whale/frame/strictOff）没变就不该再过桥。
		if (key === lastUiDiagKey) return false;
		try {
			if (!window.DshRemoteApp || typeof window.DshRemoteApp.setUiDiag !== 'function') {
				// 桥不存在：**不记判重键**——桥是后到的，记了就再也不会补发。
				// 每轮只做一次 typeof 判空（无序列化开销），桥一到就补发。
				uiDiagBridgeMissing = true;
				return false;
			}
		} catch (ignoredDiagProbe) {
			return false;
		}
		lastUiDiagKey = key;
		if (uiDiagBridgeMissing) uiDiagBridgeMissing = false;
		try {
			window.DshRemoteApp.setUiDiag(payload);
		} catch (ignoredDiagBridge) { /* 无 JS 桥时原生按既有自检兜底 */ }
		return true;
	}
	// 供测试与排查直接读同一份数据（不经过桥）。
	window.__dshrMobileDiag = function () {
		return collectUiDiag();
	};

	/**
	 * T112（S1）：把**当前**连接态原样重推一次 —— 绕过去抖键，但推完仍然更新去抖键。
	 *
	 * 为什么必须有它：`wsState` 在原生侧是**电平闩锁**（`MainActivity.hookConnState` 只在
	 * `setUiDiag` 到达时改变，`handleReconnectProbe` 每 500ms 把它 OR 进观测），而
	 * `reportUiDiag()` 状态不变就不推 ⇒ 只要出现过一次 `reconnecting`，除非 hook 再发生
	 * 一次**翻转**，原生就永远认为"正在重连"，`HIDE_STREAK=3` 永远凑不满（横幅钉死）。
	 *
	 * 调用点只有一处：断开持续态的 1s 巡检（`ensureResumeDownTick`）—— 只在**判为断**时
	 * 每拍重推一次电平，恢复的那一拍推一次真实态。健康稳态**零调用**、零定时器。
	 * 成本：1 次 `JSON.stringify(collectUiDiag())` + 1 次桥调用 / 秒，只在断开期间。
	 */
	function reportUiDiagLevel() {
		var diag, payload, key;
		try {
			diag = collectUiDiag();
			payload = JSON.stringify(diag);
			key = uiDiagDedupeKey(diag);
		} catch (ignoredLevelJson) { return false; }
		// 记账在**桥判空之前**：这个计数器要回答的是"断开态里电平重推**被调用**了几次"，
		// 而不是"过桥成功了几次" —— 真值台上没有原生桥（headless Chrome），
		// 记账若放在桥判空之后，机制在真值台上就永远读不到（M2 变异将无法反证）。
		uiDiagLevelPushes += 1;
		try {
			if (!window.DshRemoteApp || typeof window.DshRemoteApp.setUiDiag !== 'function') {
				uiDiagBridgeMissing = true;
				return false;
			}
		} catch (ignoredLevelProbe) { return false; }
		lastUiDiagKey = key;
		if (uiDiagBridgeMissing) uiDiagBridgeMissing = false;
		try {
			window.DshRemoteApp.setUiDiag(payload);
		} catch (ignoredLevelBridge) { return false; }
		return true;
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

	/**
	 * T105：把「主列展开终态的 translateX 解析值」算成 px 写到 `--dshr-drawer-shift`。
	 *
	 * 为什么需要它：主列的终态位移是 `translateX(var(--dshr-drawer-width))`，手机档那个
	 * token 是 `calc(100% - 52px)` —— 这个 100% 对**主列自身宽度**解析（= 视口宽，实测 412.19）。
	 * 鲸鱼只有 48px 宽，若直接复用同一 token，百分比会按 48px 解析（48 − 52 = **−4px**），
	 * 于是「跟手 0 漂移、松手飞回左边」。所以鲸鱼必须读一个**已经是 px** 的值。
	 * 平板档 drawer 分支本身就写 px（`drawer + 'px'`），直接照抄即可。
	 *
	 * 复用既有的 `drawerPeekPx()`（:3763，从 `--dshr-drawer-peek` 读数值、缺省 52），
	 * **不另起同名函数**（同作用域重名会靠声明顺序覆盖，是个地雷）。
	 *
	 * 只在 resize / 档位重算 / 手势起手 / 落位前计算（不进任何每帧热路径）。
	 */
	function syncDrawerShift() {
		var root = document.documentElement;
		if (root.getAttribute('data-dshr-tablet') === '1') {
			root.style.setProperty('--dshr-drawer-shift', root.style.getPropertyValue('--dshr-drawer-width') || '0px');
			return;
		}
		var frame = findFrame();
		var main = frame ? findMainCol(frame) : null;
		var w = 0;
		try { w = main ? main.getBoundingClientRect().width : 0; } catch (ignoredW) { w = 0; }
		if (!w) w = window.innerWidth || 390;
		root.style.setProperty('--dshr-drawer-shift', Math.max(0, w - drawerPeekPx()) + 'px');
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
		syncDrawerShift();
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

	// ── 设备档位（schema v2，见文件头） ──
	// 原生在注入 mobile.js 之前写 window.__DSHR_MOBILE__.device；缺省 'auto'。
	// 档位只由原生判定（sw ≥ 600 ⇒ tablet），本脚本不得用视口宽度反推（WEB-02）。
	var DEVICE_MODES = ['phone', 'tablet', 'auto'];
	var deviceMode = 'auto';
	try {
		var injectedDevice = window.__DSHR_MOBILE__ ? window.__DSHR_MOBILE__.device : null;
		var parsedDevice = normalizeDeviceMode(injectedDevice);
		if (parsedDevice) deviceMode = parsedDevice;
	} catch (ignoredDevice) { /* 缺省 'auto' */ }

	function normalizeDeviceMode(value) {
		if (typeof value !== 'string') return null;
		var mode = value.trim().toLowerCase();
		return DEVICE_MODES.indexOf(mode) >= 0 ? mode : null;
	}

	/**
	 * 启用矩阵（契约 3.4）。三条分支各自等价于一种既有行为：
	 *   - 'tablet'：任意朝向 OFF。T115 起平板档的系统栏让位**由页面自己承担**
	 *     （原生把 WebView 外边距恒写 0 + 四向 inset 写进 --dshr-inset-*，见文件头
	 *     「平板档第三处例外」），页面仍走 teardownHookTraces 的严格 OFF：
	 *     不装观察器、不标 DOM，只保留那批 CSS 与四个 inset 变量。
	 *   - 'phone' ：竖屏 ON（现有全部移动适配），横屏 OFF（维持现状：官方布局 +
	 *     dshr-official-inset 让出状态栏，G3/D1「维持现状」）。
	 *   - 'auto'  ：完全等价于本文件改动前的既有行为——壳内只看竖屏，web 端只看
	 *     视口宽度 ≤ 断点，逐字节不变。
	 */
	function resolveHookEnabled(portrait) {
		if (deviceMode === 'tablet') return false;
		if (deviceMode === 'phone') return portrait;
		if (isAndroidShell()) return portrait;
		return !!mql.matches;
	}

	// 严格 OFF 只属于 'tablet' 档：T115 起页面要自己让位，因此它在 <html> 上**保留**
	// 四个 --dshr-inset-* 变量（那是让位的输入），其余一切照旧回到零痕迹状态。
	// 'phone' 横屏与 'auto' 仍走既有 OFF 分支。
	function isStrictOff() {
		return deviceMode === 'tablet';
	}

	// hook 当前启用态。__dshrSetDevice 与 applyWidthScope 共用，保证同值零副作用。
	var hookOn = false;

	/**
	 * 严格 OFF 拆除（契约 3.5）。平板档下 hook 必须在 <html> 与 body 上不留可见
	 * 痕迹：根类、data-dshr-* 标记、注入节点、写在官方节点上的标记与行内样式
	 * 全部还原，官方交互（侧栏/设置/输入/浮动选框）不受任何影响。
	 *
	 * 惰性无效、按契约允许保留的注入物见交付报告：
	 *   1. head 里的 <style data-dshr-mobile-css>——除四个 hook 自有节点的裸 ID
	 *      规则外，全部规则都以 html.dshr-mobile / html.dshr-official-inset 开头，
	 *      这两个类已被移除，故无一条规则命中官方 DOM；那四个裸 ID 规则的宿主
	 *      节点本函数已从 DOM 删除，规则同样无宿主。
	 *      ⚠ T101 的那 2 条平板档圆角规则**已删除**（用户否决圆角装饰，见 MOBILE_CSS 里
	 *      「T101 平板档圆角已删除」一段）——上面「无一条规则命中官方 DOM」这句话在平板档
	 *      重新逐字成立，唯一的例外只剩下面 T115 这一组。
	 *      ⚠ T115 起再有**一组例外**：以同一作用域开头的平板档让位规则（三列 padding 四向
	 *      + 会话面板列的底色）。它同样是「改绘制/布局、不写节点/属性/类名」。
	 *      另外 <html> 上的四个 --dshr-inset-* 变量本函数**刻意不摘**——平板档正靠它们让位，
	 *      摘掉就等于把让位一起摘掉（换回 phone 档时 set() 会重写同一批变量，不留脏值）。
	 *   2. MutationObserver——严格 OFF 下根本不安装（它会在 <html> 上写
	 *      data-dshr-observer，本身就是痕迹）；syncDom() 亦在入口早退，切回
	 *      phone 档时由 recomputeDeviceScope 补装。
	 *   3. meta viewport 的 viewport-fit=cover / interactive-widget——脚本顶层一次性
	 *      写入，非档位相关，契约 3.6 要求手机模式 edge-to-edge 机制不变。
	 */
	function teardownHookTraces() {
		var root = document.documentElement;
		// 1) <html>：根类 + 全部 data-dshr-* 标记 + 本脚本写过的行内变量。
		root.classList.remove(ROOT_CLASS);
		root.classList.remove('dshr-official-inset');
		removeHookAttributes(root);
		root.style.removeProperty('--dshr-drawer-width');
		root.style.removeProperty('--dshr-drawer-peek');
		root.style.removeProperty('--dshr-drawer-shift');
		root.style.removeProperty('--dshr-rx');
		root.style.removeProperty('--dshr-ime');
		root.style.removeProperty('--dshr-vv-height');
		// 2) hook 创建的节点：悬浮鲸鱼、抽屉遮罩、状态栏挡板、drag handle。
		for (var n = 0; n < HOOK_NODE_IDS.length; n++) {
			var own = document.getElementById(HOOK_NODE_IDS[n]);
			if (own && own.parentNode) own.parentNode.removeChild(own);
		}
		// 3) 打在官方节点上的标记与行内样式（全部由本脚本写入，可安全还原）。
		resetFloatHosts();
		clearDrawerVisual();
		clearRightVisual(false);
		// T135：IME 压制痕迹（inputmode=none + data-dshr-imemute）一并还原。
		releasePanelIme();
		unmarkAll();
		// 4) 丢弃深浅色缓存：否则切回 phone 档时 syncPageTheme 会因「值没变」
		//    早退，data-dshr-dark 补不回来，状态就与首次装上不一致了。
		lastPageDark = null;
	}
	var HOOK_NODE_IDS = [
		'dshr-mobile-whale',
		'dshr-mobile-drawer-mask',
		'dshr-status-guard',
		'dshr-drawer-handle',
	];

	function removeHookAttributes(node) {
		if (!node || node.nodeType !== 1) return;
		var names = [];
		var attrs = node.attributes;
		for (var i = 0; i < attrs.length; i++) names.push(attrs[i].name);
		for (var j = 0; j < names.length; j++) {
			if (names[j].indexOf('data-dshr-') === 0) node.removeAttribute(names[j]);
		}
	}

	/** 还原 clampFloatHost 改写过的行内样式（position/left/top/... 全是本脚本写的）。 */
	function resetFloatHosts() {
		if (!document.querySelectorAll) return;
		var props = ['position', 'left', 'top', 'right', 'bottom', 'width', 'max-width',
			'max-height', 'min-width', 'transform', 'margin', 'box-sizing'];
		var hosts = document.querySelectorAll('[data-dshr-float]');
		for (var i = 0; i < hosts.length; i++) {
			for (var p = 0; p < props.length; p++) hosts[i].style.removeProperty(props[p]);
		}
	}

	/** 清掉标记台账：只删本脚本自己加的属性，不碰官方原生属性。 */
	function unmarkAll() {
		if (!marked) return;
		for (var i = 0; i < marked.length; i++) {
			var entry = marked[i];
			if (entry[0] && entry[0].removeAttribute) entry[0].removeAttribute(entry[1]);
		}
		marked = [];
		// markJobIndicator 的数量属性不走 mark()，单独清一次。
		if (!document.querySelectorAll) return;
		var jobs = document.querySelectorAll('[data-dshr-job-n]');
		for (var j = 0; j < jobs.length; j++) jobs[j].removeAttribute('data-dshr-job-n');
	}

	function applyWidthScope() {
		var tablet = isTabletViewport();
		var portrait = isPortraitViewport();
		var on = resolveHookEnabled(portrait);
		hookOn = on;
		// T90：连接态观测跟着 hook 启用态走 —— 严格 OFF（平板）与关闭态一律还原
		// `window.WebSocket`（零痕迹不只 DOM），启用态安装（幂等）。必须放在下面那条
		// strictOff 早退**之前**，否则切到平板档时构造器还原不掉。
		syncWsStateWatch(on && !isStrictOff());
		// T97/T103：档位闸（T103 起手机档也挂）。**只**由 brandLongPressWanted() 决定：
		// 平板档（严格 OFF）与手机档（hook 启用态 = 竖屏）挂；手机横屏 / auto 档
		// **一个监听器都不挂** ⇒ 那些档位的既有鲸鱼、抽屉拖动、右栏、焦点守卫零影响。
		// 同样必须放在下面那条 strictOff 早退**之前**，否则切到平板档时监听挂不上、
		// 切走时也摘不掉。
		syncBrandLongPress(brandLongPressWanted());
		var root = document.documentElement;
		if (!on && isStrictOff()) {
			// 平板档：官方布局零改动，直接走拆除路径（不写 dshr-official-inset）。
			teardownHookTraces();
			return;
		}
		root.classList[on ? 'add' : 'remove'](ROOT_CLASS);
		root.classList[on ? 'remove' : 'add']('dshr-official-inset');
		if (on && tablet) root.setAttribute('data-dshr-tablet', '1');
		else root.removeAttribute('data-dshr-tablet');
		if (on) syncDrawerMetrics();
		else {
			root.style.removeProperty('--dshr-drawer-width');
			root.style.removeProperty('--dshr-drawer-peek');
			// T105：鲸鱼展开态位移变量同属这一族，摘 hook 时一起清干净
			// （否则平板档零痕迹契约的 `documentElement 行内样式一致` 断言会红）。
			root.style.removeProperty('--dshr-drawer-shift');
		}
		applyImeLift();
		reportImeFocusToNative();
		// T21 修复 3：档位/朝向每次重算都上报一次收敛状态（严格 OFF 时 on=false，
		// 平板档同样要报——那正是「装了但没生效」最需要看见的档）。
		reportUiDiag();
	}

	// ── 运行时档位切换 API（契约 3.3） ──
	// 必须挂在脚本顶层：原生 onConfigurationChanged 可能在本脚本装完前就调用。
	// 装完前只落配置（供 applyWidthScope 首次计算用），装完后立即按最新值重算。
	window.__dshrSetDevice = function (mode) {
		var next = normalizeDeviceMode(mode);
		if (!next) return false;
		if (next === deviceMode) return false;
		deviceMode = next;
		if (typeof recomputeDeviceScope === 'function') recomputeDeviceScope();
		return true;
	};
	var recomputeDeviceScope = null;
	if (mql.addEventListener) mql.addEventListener('change', applyWidthScope);
	else if (mql.addListener) mql.addListener(applyWidthScope);
	if (portraitMql) {
		if (portraitMql.addEventListener) portraitMql.addEventListener('change', applyWidthScope);
		else if (portraitMql.addListener) portraitMql.addListener(applyWidthScope);
	}
	applyWidthScope();
	bindImeLift();
	bindFocusGuard();

	// ── 原生 inset 变量（MainActivity 在页面加载/焦点变化/让位重算时调用） ──
	// T115：**平板档也写**。改前这里是 `if (isStrictOff()) return;` —— 平板档一个变量都不写，
	// 因为那时让位由原生容器（WebView 外边距）承担。T115 起用户口径是「系统栏走安卓原生透明 +
	// 页面自己让位」：WebView 覆盖全窗，页面必须自己把内容让开系统栏，因此平板档**必须**拿到
	// 这四个值。这与 T101 的「最小 hook」契约同源放宽：新增痕迹只有 <html> 上四个 CSS 自定义
	// 属性（--dshr-inset-*），仍然**不新增 DOM 节点 / 类名 / data-dshr-* 属性**，
	// 消费它们的 CSS 也仍写在既有的 <style data-dshr-mobile-css> 里。
	// 左右两向是 T115 新增（挖孔 / 横屏三键导航）；旧调用方只传两个参数时左右按 0 处理。
	var lastInsetTop = 0;
	var lastInsetBottom = 0;
	var lastInsetLeft = 0;
	var lastInsetRight = 0;
	window.__dshRemoteInsets = {
		set: function (topPx, bottomPx, leftPx, rightPx) {
			var top = Number(topPx);
			var bottom = Number(bottomPx);
			var left = Number(leftPx);
			var right = Number(rightPx);
			if (isNaN(top)) top = 0;
			if (isNaN(bottom)) bottom = 0;
			if (isNaN(left)) left = 0;
			if (isNaN(right)) right = 0;
			lastInsetTop = top;
			lastInsetBottom = bottom;
			lastInsetLeft = left;
			lastInsetRight = right;
			var rootStyle = document.documentElement.style;
			rootStyle.setProperty('--dshr-inset-top', top + 'px');
			rootStyle.setProperty('--dshr-inset-bottom', bottom + 'px');
			rootStyle.setProperty('--dshr-inset-left', left + 'px');
			rootStyle.setProperty('--dshr-inset-right', right + 'px');
			if (isStrictOff()) return;
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
		// T21 修复 1：hook 发起的侧栏开合前，先把焦点收回可编辑元素。
		//
		// 根因（scratch/t18/keyboard.md §3，真实 AVD 两次复现）：鲸鱼 touchend 里的
		// event.preventDefault()（压重复 click 用）会连带取消「点按按钮 → 焦点离开当前
		// 可编辑元素」这条**默认行为**，composer 因而在动作后仍持焦；紧接着下面第 N 行的
		// dispatchNativeClick 在**同一次真实触摸的用户激活窗口内**派发合成 click，
		// Chromium 看到「可编辑元素仍持焦 + 刚发生用户手势」遂抬起虚拟键盘。
		// 同设备同粘滞态三路对照：hook 鲸鱼弹（724ms / 760ms）、官方 Collapse sidebar 不弹
		// （composer 失焦）、滚动不弹 —— 官方按钮靠的就是这条被吃掉的默认行为。
		//
		// 放在「确实要派发合成 click」之前：一处覆盖鲸鱼 touchend / click、官方开关兜底
		// 重试、flushPendingSidebar 的重放等全部入口；连点护栏命中（toggleBusy）与
		// 找不到官方开关（!button）这两条不派发动作的路径不受影响。
		//
		// 影响面：只在「IME 本来就收起」时才需要动作——此时用户看不到光标，视觉无变化；
		// 用户正输入时点鲸鱼，焦点本来也会被官方侧栏切换带走（T18 K-7-4/K-7-6：平板档
		// 官方 Collapse/Open sidebar 同样让 composer 失焦），故与官方桌面行为一致。
		var frame = findFrame();
		var before = frame ? frame.hasAttribute('data-sidebar-collapsed') : null;
		var button = findToggleControl();
		if (!button) return false;
		blurEditableFocus();
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

	// ── WEB-09 官方右侧栏（[data-sidebar-right-panel]，文件树/预览面板）──
	// 判据与返回键桥（closeSidebarIfExpanded）逐字一致：以展开标记为准，不看显示模式。
	// 关闭态下面板虽然「已挂载」（display:flex、rect 铺满、pointer-events:none），
	// 所以「已挂载」不能当「已打开」用——必须同时看 data-sidebar-right-open 与 aria-hidden。
	function findRightbarPanel() {
		return document.querySelector('[data-sidebar-right-panel]');
	}

	function isRightbarOpen() {
		var panel = findRightbarPanel();
		if (!panel || !panel.hasAttribute('data-sidebar-right-open')) return false;
		return panel.getAttribute('aria-hidden') !== 'true';
	}

	/**
	 * 打开官方右侧栏。
	 * 官方唯一入口是面板内那颗 button[data-sidebar-right-toggle]
	 * （官方源码：onClick: () => actions.toggleExpanded(sessionId)）——app.asar 内
	 * `swipe` 零命中，官方没有任何手势能开右栏（见 scratch/t11/report.md §3）。
	 * 关闭态下那颗按钮 rect 在视口外（412px 视口里 x≈790，pointer-events:none），
	 * 因此 **坐标派发不可用**：实测 CDP 真实鼠标点击打不开（recon §4 方法 C），
	 * 而派发合成 MouseEvent 事件流（WEB-04 既有通道，绕过命中测试直接进 React 委托）能开。
	 * 沿用返回键桥同一条通道与同一颗按钮，开/关可逆（实测 4 连点往返）。
	 * 返回是否真的把意图派发出去了；调用方不再据此判断成功与否——React 提交是异步的。
	 */
	function openOfficialRightbar() {
		var panel = findRightbarPanel();
		if (!panel) return false;
		var toggle = panel.querySelector('button[data-sidebar-right-toggle]');
		if (!toggle || toggle.disabled) return false;
		if (!dispatchNativeClick(toggle)) toggle.click();
		return true;
	}

	/**
	 * 关闭官方右侧栏——与 openOfficialRightbar 完全对称：同一颗官方折叠按钮
	 * （panel 内 button[data-sidebar-right-toggle]，官方实现只有 onClick →
	 * actions.toggleExpanded），同一条 dispatchNativeClick 通道，所以开/关可逆。
	 * T47 补它是因为**官方右栏没有 swipe-to-close**：app.asar 右栏模块字节区间
	 * touchstart/touchmove/touchend/swipe 全部零命中（scratch/t43/diagnosis.md §6），
	 * 右滑关闭只能由本 hook 提供。
	 * 返回是否真的把意图派发出去了（调用方不要再据此判断成功与否：React 异步提交）。
	 */
	function closeOfficialRightbar() {
		var panel = findRightbarPanel();
		if (!panel) return false;
		var toggle = panel.querySelector('button[data-sidebar-right-toggle]');
		if (!toggle || toggle.disabled) return false;
		if (!dispatchNativeClick(toggle)) toggle.click();
		return true;
	}

	// ── T130：右抽屉桥 —— 官方状态机 + 意图队列 ─────────────────────────
	//
	// setRightbarOpen 是「右栏状态真的要被改写」的唯一收口（手势 settle / considerSwipe
	// 轻扫 / 遮罩点按都汇到这里），与左侧 setSidebarOpen 完全同构：
	//   - rightToggleBusy（官方折叠提交中）时意图入队 pendingRightbarOpen，落地后重放；
	//   - 按钮 disabled（官方还在提交上一次翻转）⇒ 意图入队 + 300ms 后重放——
	//     杜绝 T82 那类失同步（close 撞上 disabled 返回 false，右栏永远留在打开态）；
	//   - 状态翻转一律由 syncDom 的属性观察者落地（rightIntentState 匹配即解 busy）；
	//     看门狗只兜「派发真的丢了」，绝不按固定节奏补拍（T134，见下）。
	// 兑现仍然只有 dispatchNativeClick/click() 这一条官方通道，绝不自己改写官方 open 状态。
	var rightToggleBusy = false;
	var pendingRightbarOpen = null;
	// T133：在途 toggle 的目标态。syncDom 一见到官方状态与它一致就立刻解除 busy
	// （观察者驱动，不必等盲窗），随后 flushPendingRightbar 串联下一个意图。
	var rightIntentState = null;

	function flushPendingRightbar() {
		if (pendingRightbarOpen === null) return;
		var want = pendingRightbarOpen;
		pendingRightbarOpen = null;
		if (isRightbarOpen() !== want) setRightbarOpen(want);
	}

	function setRightbarOpen(open) {
		open = !!open;
		// T135：意图是「打开」时立刻撤交接窗——否则面板会一直停在屏外右不动。
		if (open) document.documentElement.removeAttribute('data-dshr-rclosing');
		if (rightToggleBusy) { pendingRightbarOpen = open; return true; }
		if (isRightbarOpen() === open) {
			pendingRightbarOpen = null;
			// T135：官方已是关闭态 ⇒ 交接窗无事可等（它等的就是这一刻），当场撤掉。
			// 不撤的话，若这一轮之后再没有 DOM 变更触发 syncDom，面板会一直停在屏外。
			if (!open) document.documentElement.removeAttribute('data-dshr-rclosing');
			return true;
		}
		var panel = findRightbarPanel();
		var toggle = panel ? panel.querySelector('button[data-sidebar-right-toggle]') : null;
		if (!toggle) return false;
		if (toggle.disabled) {
			pendingRightbarOpen = open;
			window.setTimeout(flushPendingRightbar, 300);
			return true;
		}
		rightToggleBusy = true;
		rightIntentState = open;
		var before = isRightbarOpen();
		var retriesLeft = 1;
		if (!dispatchNativeClick(toggle)) toggle.click();
		// T134：看门狗只兜「派发真的丢了」，绝不按固定节奏补拍。
		// rc.2.18/2.19 的形态是「650ms 没翻转就补拍第二颗 toggle」——真机上官方
		// React 提交只是**慢**（没丢）：第一颗随后落地开了、补拍那颗又把它关掉、
		// 收敛重试再打开——用户看到的就是「右侧栏被打开两遍/动画触发两次」
		//（rc.2.19 实机报告；只有手势路径，官方按钮不经过这里）。
		// 现在：翻转一律由 syncDom 的属性观察者收口；1200ms 仍停旧态才按「派发丢失」
		// 补一次（窗口远超实测提交时延 ~90–800ms）；2400ms 还不翻就放弃这次意图——
		// 宁可少动作一次留给用户下一笔手势，绝不制造「开→关→开」乒乓。
		var watchdog = function () {
			if (!rightToggleBusy) return;   // 观察者已收口
			if (isRightbarOpen() !== before) {
				// 观察者漏网时的兜底收口（语义与观察者路径逐字一致）。
				rightToggleBusy = false;
				rightIntentState = null;
				// T135：状态已落地 ⇒ 交接窗的关门条件满足（与 syncDom 同一判据）。
				if (!isRightbarOpen()) document.documentElement.removeAttribute('data-dshr-rclosing');
				flushPendingRightbar();
				return;
			}
			if (retriesLeft > 0) {
				retriesLeft -= 1;
				var panel2 = findRightbarPanel();
				var toggle2 = panel2 ? panel2.querySelector('button[data-sidebar-right-toggle]') : null;
				if (toggle2 && !toggle2.disabled) dispatchTap(toggle2);
				window.setTimeout(watchdog, 1200);
				return;
			}
			// 放弃：停在官方当前态，清 busy 让后续手势照常工作；跟手痕迹一并清掉，
			// 面板如实停在官方状态对应的位置（不留「官方开着但视觉上被拖走」的假态）。
			rightToggleBusy = false;
			rightIntentState = null;
			// T135：放弃这次意图 ⇒ 交接窗必须一并撤掉，否则面板会停在屏外右不动。
			document.documentElement.removeAttribute('data-dshr-rclosing');
			clearRightVisual(false);
			flushPendingRightbar();
		};
		window.setTimeout(watchdog, 1200);
		return true;
	}

	/**
	 * 右抽屉卡片态闸：只有手机档窄视口（<768px，官方 fullscreen 态）才把右栏当卡片抽屉；
	 * 宽屏官方 push/docked 态不做卡片（CSS 侧由面板属性值天然闸掉，这里是手势侧闸）。
	 * 同时要求官方折叠按钮存在（兑现通道存在），否则左滑整笔 no-op、事件原样放行。
	 */
	function canOpenRightCard() {
		if ((window.innerWidth || 0) >= 768) return false;
		var panel = findRightbarPanel();
		if (!panel) return false;
		return !!panel.querySelector('button[data-sidebar-right-toggle]');
	}

	/**
	 * 右栏当前是否处于「卡片抽屉开」态：官方 open 且面板为 fullscreen 卡片态。
	 * push/docked（宽屏停靠）不算——手势引擎的右开态分支只认这一条，
	 * 与 syncDom 的 data-dshr-ropen 镜像同口径。
	 */
	function isRightCardOpen() {
		var panel = findRightbarPanel();
		if (!panel || panel.getAttribute('data-sidebar-right-panel') !== 'fullscreen') return false;
		return isRightbarOpen();
	}

	// ── T130：右抽屉跟手视觉层 ─────────────────────────────────────────
	//
	// 与左抽屉 setDrawerVisual 同构：拖动期只写一个自定义属性 --dshr-rx 驱动 transform
	// （只走合成器、不触发布局），rAF 节流；官方状态兑现走 setRightbarOpen。
	// rx ∈ [0, max]：0 = 全开（卡片贴右缘），max = 全藏（卡片退到右屏外）。
	var rightVisual = null;
	var rightRaf = 0;
	var rightNextX = 0;
	var rightSettleAnim = 0;

	/** 右卡位移上限 = 卡片宽度（T131 起 = 视口全宽，不再减左缘细条）。 */
	function rightCardMax() {
		return Math.max(80, window.innerWidth || 390);
	}

	function setRightVisual(x) {
		if (!rightVisual) {
			rightVisual = { max: rightCardMax(), x: 0 };
			document.documentElement.setAttribute('data-dshr-rdrag', '1');
		}
		var max = rightVisual.max;
		x = Math.max(0, Math.min(max, x));
		rightVisual.x = x;
		document.documentElement.style.setProperty('--dshr-rx', Math.round(x) + 'px');
		return { x: x, p: max > 0 ? 1 - x / max : 0, max: max };
	}

	/** rAF 节流：一帧最多写一次属性（touchmove 可以每帧来好几次）。 */
	function queueRightVisual(x) {
		rightNextX = x;
		if (rightRaf) return;
		rightRaf = window.requestAnimationFrame(function () {
			rightRaf = 0;
			if (rightVisual) setRightVisual(rightNextX);
		});
	}

	/**
	 * 摘掉跟手痕迹。keepShift=true 时保留 --dshr-rx 的当前值：
	 * 关闭落位后官方收起是异步提交的，滞留的 rx=max 让面板停在屏外；等 syncDom 见到
	 * 官方 closed 后统一清理（否则属性一摘 transform 回落 0，面板会往回跳一帧）。
	 */
	function clearRightVisual(keepShift) {
		if (rightSettleAnim) { window.cancelAnimationFrame(rightSettleAnim); rightSettleAnim = 0; }
		if (rightRaf) { window.cancelAnimationFrame(rightRaf); rightRaf = 0; }
		rightVisual = null;
		document.documentElement.removeAttribute('data-dshr-rdrag');
		if (!keepShift) document.documentElement.style.removeProperty('--dshr-rx');
	}

	/** 与 animateMainTo 同款 rAF 补间（340ms ease-out，reduced-motion 直落）。 */
	function animateRightTo(x, done) {
		if (rightSettleAnim) window.cancelAnimationFrame(rightSettleAnim);
		rightSettleAnim = 0;
		if (rightRaf) { window.cancelAnimationFrame(rightRaf); rightRaf = 0; }
		var state = rightVisual;
		if (!state) { done(); return; }
		var from = state.x;
		if (Math.abs(x - from) < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setRightVisual(x);
			done();
			return;
		}
		var start = 0;
		var duration = 340;
		rightSettleAnim = window.requestAnimationFrame(function step(ts) {
			if (rightVisual !== state) { rightSettleAnim = 0; return; }
			if (!start) start = ts;
			var t = Math.min(1, (ts - start) / duration);
			// 与官方 0.34s cubic-bezier(0.32,0.72,0,1) 近似的 ease-out。
			var eased = 1 - Math.pow(1 - t, 3);
			setRightVisual(from + (x - from) * eased);
			if (t < 1) rightSettleAnim = window.requestAnimationFrame(step);
			else { rightSettleAnim = 0; done(); }
		});
	}

	/**
	 * 右抽屉落位（与 settleDrawer 镜像）：
	 *   开：补间 rx→0，到位摘跟手痕迹（CSS 缺省 0px 接管，交接零台阶）；
	 *   关：补间 rx→max，到位才兑现官方收起（面板全程可见地滑出右缘）；
	 *       --dshr-rx 与 data-dshr-rdrag 留到 syncDom 见官方 closed 后清理，防回跳帧。
	 */
	function settleRight(wantOpen) {
		if (!rightVisual && !wantOpen && isRightbarOpen()) setRightVisual(0);
		var state = rightVisual;
		if (!state) return setRightbarOpen(!!wantOpen);
		if (wantOpen) {
			if (!isRightbarOpen()) setRightbarOpen(true);
			animateRightTo(0, function () {
				clearRightVisual(false);
				setRightbarOpen(true);
			});
			return true;
		}
		animateRightTo(state.max, function () {
			rightVisual = null;
			document.documentElement.removeAttribute('data-dshr-rdrag');
			// T135：本笔是**手势**关闭——此刻 rx 已补间到 max（面板停在屏外右），
			// 从这里到「官方 closed 落地」之间的整段就是交接窗：期间面板必须继续停在
			// 屏外、官方内层的收起过渡必须被压掉，否则会重播一次可见的「弹回来再关上」。
			document.documentElement.setAttribute('data-dshr-rclosing', '1');
			if (!setRightbarOpen(false)) document.documentElement.removeAttribute('data-dshr-rclosing');
		});
		return true;
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
		// T105：这条路是"抽屉状态真的要被改写为 open"的唯一收口（手势 settle /
		// 官方折叠按钮 / 右栏兜底都汇到这里）⇒ 在改写前刷一次鲸鱼的终态位移，
		// 保证它读到的 px 与主列这一帧的真实宽度一致（一次布局读，非每帧）。
		if (open) syncDrawerShift();
		// 官方 React 提交可能晚于手指松开；即使 DOM 仍是旧状态也要记住最终意图。
		if (toggleBusy) {
			pendingSidebarOpen = open;
			return true;
		}
		if (isSidebarOpen() === open) {
			pendingSidebarOpen = null;
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

	var drawerVisual = null;
	var drawerRaf = 0;
	var drawerNextX = 0;

	// T91：圆角「成形位移」= 一个半径的量。依据：圆角是**卡片的属性**，不是位移的比例——
	// 卡片一旦从屏幕边缘分离出来就该是完整圆角（参考图里卡片本身就是刚性的，只是平移过去；
	// 用户明确否掉了缩放）。但 x=0 时若直接给满半径就是跳变（改前缺陷：真机真值
	// x=7px 就已经是 18px 圆角，见 report §2），所以取「半径不能超过卡片自身的分离量」
	// 这条几何约束做斜坡：r(x) = min(x, R)。x>=20px 起就是完整圆角，之后半径恒定、
	// 只跟随平移 ⇒ 观感上正是用户要的「圆角平移过去」。
	var CARD_RADIUS_PX = 20;

	function setDrawerVisual(x) {
		if (!drawerVisual) {
			var frame = findFrame();
			drawerVisual = { max: drawerMaxShift(), main: frame ? findMainCol(frame) : null, wasOpen: isSidebarOpen() };
			// 先锁住跟手样式，再请求官方渲染 wide 内容；不能只把 rail 拉宽。
			document.documentElement.setAttribute('data-dshr-dragging', '1');
			// T82：**实测推翻了"把这次官方打开挪到落位阶段"的方案**，所以它留在这里。
			//
			// 改前设想：拖动期只用 hook 自己的 CSS 点亮侧栏，把 setSidebarOpen(true)
			// 挪到 settleDrawer 的 wantOpen 分支，好让热路径只剩 transform/opacity。
			// 实测（scratch/t82/b-content-signature.json，真实 DSH 0.2.0-rc.2 页面）：
			//   仅靠 hook CSS 点亮：侧栏列确实被拉宽到 360px，但**可见文本 0 个**、
			//                      只有 5 个 svg/按钮 ⇒ 用户拖出来的是一条"被拉宽的图标 rail"；
			//   官方打开态：        同一列可见文本 28 个字符、8 按钮 / 10 svg ⇒ 完整会话列表。
			// 也就是说"拖动期只靠 CSS 点亮"会让**整个拖动过程**都看不到会话列表，
			// 直到落位才"啪"地补上内容 —— 比原来的跟手更不可接受。
			// 既有 fixture 断言 drag-shows-wide-sidebar（scripts/fixtures/mobile-selftest.html:732）
			// 钉的正是这条语义，它也确实是**有判别力**的守卫，因此不改断言、改回本实现。
			//
			// 那"最长帧永远落在 expanded 0→1"怎么修？见下面 [data-dshr-main-col] 的
			// margin 说明：那一帧的重排来自 margin/max-height 的 0.34s 过渡（margin 参与布局），
			// 本轮把两处 8px margin 删掉后该帧不再做整列布局，真机帧率真值见 report §B。
			setSidebarOpen(true);
			// T105：手上这笔手势一定会走"松手落位"，而落位后鲸鱼读的是
			// `--dshr-drawer-shift`（主列终态位移的 px 值）。这里在**起手**（每笔手势一次、
			// 不在每帧热路径上）刷一次，保证它与这一帧的主列宽度一致。
			syncDrawerShift();
		}
		var max = drawerVisual.max;
		x = Math.max(0, Math.min(max, x));
		var p = max > 0 ? x / max : 0;
		// T82：变量改写到 <html>。原本只写主列，是为了少让一棵子树继承失效；
		// 但鲸鱼必须读**同一个变量**才能与主列同帧同缓动交接（见 report §B），
		// 所以写到共同祖先上。消费方只有 [data-dshr-main-col] 与 #dshr-mobile-whale。
		document.documentElement.style.setProperty('--dshr-drawer-x', Math.round(x) + 'px');
		// T91：圆角/阴影跟手量（0..1，无单位，供 CSS calc 相乘）。
		// 与 --dshr-drawer-x 同帧同源写入 ⇒ 半径、阴影、位移三者永远在同一帧上一致，
		// 不会出现「位移到了、圆角还停在上一帧」的跳动。
		// 取整到 1/1000：避免把 0.30000000000000004 这类浮点串写进行内样式
		// （行内属性逐字变化会让 CSS 变量消费者每帧重算，真机上无益）。
		// T125（Kimi 化）：圆角走全行程渐变 cardP=x/max（此前为 min(1,x/20)，20px 即满）。
		// 全程渐变更“果冻”、与 Kimi 同味；终态 p=1 时仍是完整 --dshr-card-r，交接零台阶。
		var cardP = max > 0 ? x / max : 0;
		if (cardP < 0) cardP = 0;
		if (cardP > 1) cardP = 1;
		document.documentElement.style.setProperty('--dshr-card-p', String(Math.round(cardP * 1000) / 1000));
		return { x: x, p: p, max: max };
	}

	function queueDrawerVisual(x) {
		drawerNextX = x;
		if (drawerRaf) return;
		drawerRaf = window.requestAnimationFrame(function () {
			drawerRaf = 0;
			if (drawerVisual) setDrawerVisual(drawerNextX);
		});
	}

	function clearDrawerVisual(keepState) {
		if (settleAnim) window.cancelAnimationFrame(settleAnim);
		settleAnim = 0;
		if (drawerRaf) window.cancelAnimationFrame(drawerRaf);
		drawerRaf = 0;
		var previous = drawerVisual;
		drawerVisual = null;
		var root = document.documentElement;
		root.removeAttribute('data-dshr-dragging');
		// T82：变量统一写在 <html> 上（见 setDrawerVisual），清理也只清这一处。
		root.style.removeProperty('--dshr-drawer-x');
		// T91：跟手圆角量同一处写入、同一处清理（残留会让下一次进入跟手态时
		// 第一帧先按旧半径画一下，观感就是「拖动开始时圆角闪一下」）。
		root.style.removeProperty('--dshr-card-p');
		if (previous && !keepState) setSidebarOpen(previous.wasOpen);
	}

	// 关闭时先保持官方 wide 内容不变，只移动主卡片。
	// 落位后再切换 rail，避免侧栏重排/入场动画与回位动画重叠。
	// 这是对渲染时序的优化；实际帧率仍需真机性能采样确认。
	var settleAnim = 0;
	function animateMainTo(x, done) {
		if (settleAnim) window.cancelAnimationFrame(settleAnim);
		settleAnim = 0;
		if (drawerRaf) window.cancelAnimationFrame(drawerRaf);
		drawerRaf = 0;
		var state = drawerVisual;
		if (!state || !state.main) {
			done();
			return;
		}
		// T82：起点读 <html>（变量已统一写到那里）。
		var from = parseFloat(document.documentElement.style.getPropertyValue('--dshr-drawer-x')) || 0;
		if (Math.abs(x - from) < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setDrawerVisual(x);
			done();
			return;
		}
		var start = 0;
		// T125（Kimi 化）：关闭补间与展开同为 0.34s，与主列 CSS 的
		// cubic-bezier(0.32,0.72,0,1) 同节奏（此前 220ms 偏急）。
		var duration = 340;
		var step = function (ts) {
			if (drawerVisual !== state) {
				settleAnim = 0;
				return;
			}
			if (!start) start = ts;
			var t = Math.min(1, (ts - start) / duration);
			// 与官方 0.34s cubic-bezier(0.32,0.72,0,1) 近似的 ease-out。
			var eased = 1 - Math.pow(1 - t, 3);
			setDrawerVisual(from + (x - from) * eased);
			if (t < 1) {
				settleAnim = window.requestAnimationFrame(step);
			} else {
				settleAnim = 0;
				done();
			}
		};
		settleAnim = window.requestAnimationFrame(step);
	}

	function settleDrawer(wantOpen) {
		if (!drawerVisual && !wantOpen && isSidebarOpen()) setDrawerVisual(drawerMaxShift());
		var state = drawerVisual;
		if (!state) return setSidebarOpen(!!wantOpen);
		if (wantOpen) {
			// 展开落位：去掉跟手样式，让官方 transform 接管，目标态已展开。
			// T105：落位前再刷一次鲸鱼的终态位移（一次布局读，不在每帧路径上）——
			// 官方折叠按钮那条路径不经过 setDrawerVisual，只有这里能保证
			// `--dshr-drawer-shift` 与"这一帧主列真实的 px 宽度"一致。
			syncDrawerShift();
			var result = setSidebarOpen(true);
			clearDrawerVisual(true);
			return result;
		}
		// 关闭：先补间回 0，卡片盖满后再切官方收起，rail 重排被卡片挡住。
		animateMainTo(0, function () {
			var closing = drawerVisual;
			drawerVisual = null;
			if (settleAnim) { window.cancelAnimationFrame(settleAnim); settleAnim = 0; }
			if (drawerRaf) { window.cancelAnimationFrame(drawerRaf); drawerRaf = 0; }
			// T112b（V1 P2-2，1 帧观感修正）：**这一帧**必须先把鲸鱼的"展开终态位移"归零。
			//
			// 真值（两台设备、同一套逐帧判据 `|whaleX − (10 + mainX)|`）：
			//   · V1 真机（`scratch/v1/pf-drawer-close.json` t=427549）：`dr=null, ex='1'`，漂移 **+42.97px**；
			//   · 我的装置（`scratch/t112b/exp-drawer-close-new.json`）：同一个交接帧漂移 **+111.73px**
			//     （峰值的绝对值取决于该帧多长，机制相同）。
			// 机制：`data-dshr-dragging` 在这一行被摘掉，而 `setSidebarOpen(false)` 是**异步**提交
			// （官方 React），于是有 1–2 帧同时满足「拖动规则已失效」+「`data-dshr-expanded` 还是 1」
			// ⇒ 鲸鱼回落到展开态规则 `translateX(var(--dshr-drawer-shift))`，而那个变量此刻是
			// **360px**（展开态的解析值）⇒ 它带着 0.34s 的 transition 朝右飞，下一帧 expanded=0
			// 再把它拽回来（观感：鲸鱼抖一下）。
			// 修法：关闭落位的终态里，主列终态位移**本来就是 0**（rail 态 translateX=0），
			// 所以这里把它显式写 0 —— 交接帧的目标就是 10px（鲸鱼该在的位置），不再有"朝 360 飞"。
			// 安全性：**任何**打开路径都会先 `setSidebarOpen(true)`，而它第一件事就是
			// `syncDrawerShift()`（:3788）重算成正确的 px 值 ⇒ 这条归零不可能污染打开态。
			document.documentElement.style.setProperty('--dshr-drawer-shift', '0px');
			document.documentElement.removeAttribute('data-dshr-dragging');
			document.documentElement.style.removeProperty('--dshr-drawer-x');
			document.documentElement.style.removeProperty('--dshr-card-p');
			setSidebarOpen(false);
		});
		return true;
	}

	/**
	 * 主屏幕右划打开左侧栏；展开后在侧栏或右侧浮层细条上左划关闭；
	 * 关闭态左划打开右抽屉（官方文件栏卡片）；右开态右划关闭、左划 no-op（E5 基线）。
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
		if (isRightbarOpen()) {
			if (dx > 0) return settleRight(false);
			return false;
		}
		if (dx > 0 && !isSidebarOpen() && !inSidebar && !onMask && !isIgnoredSwipeTarget(target)) {
			return settleDrawer(true);
		}
		if (dx < 0 && isSidebarOpen() && (inSidebar || onMask || inMain || x0 < window.innerWidth * 0.92)) {
			return settleDrawer(false);
		}
		if (dx < 0 && !isSidebarOpen() && !inSidebar && !onMask && !isIgnoredSwipeTarget(target)) {
			// 左划开右抽屉：与手势路径同一条卡片通道（从右缘滑入）。
			if (!canOpenRightCard()) return false;
			setRightVisual(rightCardMax());
			return settleRight(true);
		}
		return false;
	}

	function canStartDrawerTrack(target, x0) {
		if (!isMobileMode() || isDrawerLocked() || toggleBusy) return false;
		// WEB-09 守卫：官方右栏打开时（<768px 官方把它铺成 position:absolute;inset:0 全屏，
		// 盖住整个视口）**不要**再武装左抽屉手势。
		// 实测存在真实缺陷：右栏全屏时触点命中的是面板内部节点，左抽屉本身是收起的，
		// 于是下面「关闭态」那一支的豁免全不命中（既不在侧栏、也不在遮罩、
		// 也不是 isIgnoredSwipeTarget 目标、不在横向滚动容器内），canStartDrawerTrack
		// 返回 true → 在面板上右滑会把**左抽屉**点亮展开（recon §2：expanded=1、
		// 官方列宽 360px），而此刻鲸鱼与遮罩都被 data-dshr-rightbar-fullscreen 隐藏，
		// 用户连一个像素的反馈都看不到。右栏打开期间左抽屉手势必须彻底不武装；
		// 右栏自己也不需要手势（官方只有按钮入口）。
		if (isRightbarOpen()) return false;
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
		var baseRx = 0;
		var lastX = 0;
		var lastT = 0;
		var velocity = 0;
		var startTarget = null;
		// T130（Kimi 双抽屉）：方向门确认后，本笔手势服务哪一侧抽屉。
		// 'left' = 主卡跟手（开/关左抽屉）；'right' = 右栏卡片跟手（开/关右抽屉）；
		// null = 未定向（还在 10px 死区里）。
		var axis = null;

		function resetTrack() {
			tracking = false;
			dragging = false;
			axis = null;
			startTarget = null;
			velocity = 0;
			activePointer = null;
		}

		var activePointer = null;

		function onDragStart(clientX, clientY, target, pointerId) {
			if (!isMobileMode() || isDrawerLocked() || toggleBusy || rightToggleBusy) {
				resetTrack();
				return false;
			}
			if (!isElement(target)) {
				resetTrack();
				return false;
			}
			// 接管进行中的落位补间：旧补间不能继续覆盖新手势。
			if (settleAnim) window.cancelAnimationFrame(settleAnim);
			settleAnim = 0;
			if (rightSettleAnim) window.cancelAnimationFrame(rightSettleAnim);
			rightSettleAnim = 0;
			if (isRightCardOpen()) {
				// 右抽屉开着：只武装「关右栏」——起点在面板上或左缘细条遮罩上，
				// 输入类目标与横向可滚容器豁免（与左抽屉同规则）。
				// 两抽屉互斥：左抽屉手势在此期间彻底不武装（WEB-09 守卫语义不变）。
				// push/docked 态（宽屏）不走这里：isRightCardOpen 只认 fullscreen 卡片态，
				// push 开态落到下面 canStartDrawerTrack 的 isRightbarOpen 守卫（照旧不武装）。
				var panel = findRightbarPanel();
				var onPanel = !!(panel && panel.contains(target));
				var onMaskNow = target.id === 'dshr-mobile-drawer-mask';
				if (!onPanel && !onMaskNow) {
					resetTrack();
					return false;
				}
				if (isIgnoredSwipeTarget(target) || isInHorizontallyScrollableContainer(target)) {
					resetTrack();
					return false;
				}
			} else if (!canStartDrawerTrack(target, clientX)) {
				resetTrack();
				return false;
			}
			tracking = true;
			dragging = false;
			axis = null;
			startX = clientX;
			startY = clientY;
			lastX = startX;
			lastT = Date.now();
			velocity = 0;
			startTarget = target;
			activePointer = pointerId == null ? 'touch' : pointerId;
			baseX = drawerVisual && drawerVisual.main
				? parseFloat(document.documentElement.style.getPropertyValue('--dshr-drawer-x')) || 0
				: isSidebarOpen() ? drawerMaxShift() : 0;
			baseRx = rightVisual ? rightVisual.x : (isRightbarOpen() ? 0 : rightCardMax());
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
				// T130 方向门（Kimi 双抽屉）：按当前抽屉态 + 位移方向给本笔手势定向。
				// 定向失败 = 整笔 no-op——resetTrack 原样归还事件：不 preventDefault、
				// 不写任何抽屉样式、不碰官方状态。WEB-08「关闭态左滑不点亮左抽屉」
				// 由这里的分支结构保证：左滑只会走向右抽屉，永远碰不到 setDrawerVisual；
				// 右开态左滑（E5 基线）与「右栏不可用时左滑」同样是 no-op。
				if (isRightCardOpen()) {
					if (dx <= 0) {
						resetTrack();
						return;
					}
					axis = 'right';
				} else if (isSidebarOpen()) {
					axis = 'left';
				} else if (dx > 0) {
					axis = 'left';
				} else {
					// 左滑开右抽屉：先确认官方卡片通道可用，不可用整笔 no-op。
					// 方向确认这一刻就兑现官方打开（与左抽屉起手即 setSidebarOpen(true)
					// 同节奏）：面板随即以卡片形态出现在右缘，--dshr-rx 跟手驱动。
					if (!canOpenRightCard()) {
						resetTrack();
						return;
					}
					if (!setRightbarOpen(true)) {
						resetTrack();
						return;
					}
					axis = 'right';
				}
				dragging = true;
				if (axis === 'left') setDrawerVisual(baseX);
				else setRightVisual(baseRx);
			}
			var now = Date.now();
			var dt = Math.max(1, now - lastT);
			velocity = (clientX - lastX) / dt;
			lastX = clientX;
			lastT = now;
			if (axis === 'left') queueDrawerVisual(baseX + dx);
			else queueRightVisual(baseRx + dx);
			if (event && event.cancelable) event.preventDefault();
		}

		function onDragEnd(clientX, clientY) {
			if (!tracking) return;
			var endX = clientX;
			var endY = clientY;
			var wasDragging = dragging;
			var axisUsed = axis;
			var start = startTarget;
			var leftOpen = isSidebarOpen();
			var rightOpen = isRightbarOpen();
			var releaseVelocity = Date.now() - lastT < 100 ? velocity : 0;
			resetTrack();
			if (wasDragging && axisUsed === 'left') {
				var shift = baseX + (endX - startX);
				var visual = setDrawerVisual(shift);
				// T132：开/关阀值不对称——开 35%（跟手一小段就认）、关 50%。
				// 此前关也是 35%（要拖过 65% 才关）：真机上自然减速松手极难过线，
				// 面板/主卡被弹回打开态，用户看到的就是「跟着我手收回去，
				// 然后立刻自己又触发一次」（rc.2.17/2.18 两次实机报告的现象）。
				// baseX 大（起手已开）= 关闭拖动 → 50%；baseX 小（起手关）= 打开拖动 → 35%。
				var wantOpen = visual.p >= (baseX >= drawerMaxShift() / 2 ? 0.5 : 0.35);
				if (Math.abs(releaseVelocity) > 0.45) wantOpen = releaseVelocity > 0;
				settleDrawer(wantOpen);
				return;
			}
			if (wasDragging && axisUsed === 'right') {
				var rx = baseRx + (endX - startX);
				var rvisual = setRightVisual(rx);
				// T132：右抽屉同款不对称阀值。baseRx 小（起手已开）= 关闭拖动 → 50%；
				// baseRx 大（起手关）= 打开拖动 → 35%。速度门照旧：快甩按方向直落。
				var wantRight = rvisual.p >= (baseRx <= rightCardMax() / 2 ? 0.5 : 0.35);
				// 右抽屉镜像：向左的速度 = 打开方向。
				if (Math.abs(releaseVelocity) > 0.45) wantRight = releaseVelocity < 0;
				settleRight(wantRight);
				return;
			}
			// 非拖动点按：左开点主卡/右缘细条关左抽屉；右开点左缘细条关右抽屉（补间滑出）。
			if (leftOpen && isElement(start)) {
				var frame = findFrame();
				var main = frame ? findMainCol(frame) : null;
				var inMain = !!(main && main.contains(start));
				var onMask = start.id === 'dshr-mobile-drawer-mask';
				if (inMain || onMask) {
					settleDrawer(false);
					return;
				}
			}
			if (rightOpen && isElement(start) && start.id === 'dshr-mobile-drawer-mask') {
				settleRight(false);
				return;
			}
			considerSwipe(startX, startY, endX, endY, start);
		}

		function onDragCancel() {
			if (!tracking) return;
			var wasDragging = dragging;
			var axisUsed = axis;
			resetTrack();
			if (!wasDragging) {
				clearDrawerVisual();
				clearRightVisual(false);
				return;
			}
			// 触摸被系统/滚动接管：回到「官方当前状态」，不做兑现。
			if (axisUsed === 'left') settleDrawer(drawerVisual ? drawerVisual.wasOpen : isSidebarOpen());
			else if (axisUsed === 'right') settleRight(isRightbarOpen());
		}

		// Android WebView 的 PointerEvent 会在页面滚动时 pointercancel，右滑打开侧栏被吞掉。
		// 抽屉手势始终走 touch；一旦判定为横向拖动就 preventDefault。
		document.addEventListener('touchstart', function (event) {
			if (event.touches && event.touches.length !== 1) {
				onDragCancel();
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
			var endX = touch ? touch.clientX : lastX;
			var endY = touch ? touch.clientY : startY;
			onDragEnd(endX, endY);
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

	/**
	 * 输入联想浮层（`/`、`@` 触发的命令/技能/文件/目标面板）。
	 *
	 * 判据只用官方**结构属性** `data-trigger-menu`（以及「在它里面」这件事），
	 * 不碰 `Z9Jnlq_menu` / `_surface_ri079_1` 这类 CSS Module 哈希类名——哈希随官方发版会变。
	 * 官方自己在 `conversation.input.overlay` 槽里挂它，内层是 `[role="listbox"]`，
	 * 所以原来它**确实**会被 collectMenuRoots 收进钳位集合（listbox 命中 looksLikeMenuRoot）。
	 *
	 * 为什么必须放行（2026-10-02 真机复现，见 scratch/t24/report.md）：
	 * 官方锚点是「贴在输入卡上沿、留 4px 缝」，实测底边 461 / 输入卡顶边 465（对照臂 447 / 451）。
	 * 而 clampFloatHost 的安全区把输入卡顶边**再减 8px** 当硬下界，于是
	 *   rect.bottom(461) <= bottomLimit(465-8=457) + 0.5 → 不成立
	 * 一条 377px 高的命令面板每次都被判成「越界」，于是被改写成
	 *   position:fixed; inset:8px auto auto 16px; max-height:bottomLimit-pad.top
	 * 结果浮层从「贴着输入框」跳到**安全区顶端**（实测 top 84 → 32，高 377 → 425），
	 * 正是用户报的「不是从输入框弹出，而是从屏幕最顶端、且溢出状态栏那一侧开始」；
	 * 原生还没写入 --dshr-inset-top 时 pad.top=8，浮层顶边就是 8px，直接压进状态栏。
	 *
	 * 对照臂（同一页面、同一视口、**不注入**）实测官方位置 top=84 / bottom=447，
	 * 本身就在安全视口内 → 锚点归官方，本脚本不碰它。
	 */
	function isInputTriggerPalette(node) {
		if (!isElement(node)) return false;
		if (node.hasAttribute('data-trigger-menu')) return true;
		return !!node.closest('[data-trigger-menu]');
	}

	function looksLikeMenuRoot(node) {
		if (!isElement(node) || isLayoutChrome(node)) return false;
		if (isInputTriggerPalette(node)) return false;
		if (node.getAttribute('aria-hidden') === 'true') return false;
		if (node.getAttribute('data-state') === 'closed') return false;
		var role = (node.getAttribute('role') || '').toLowerCase();
		if (role === 'menu' || role === 'listbox' || role === 'tree') return true;
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

	/**
	 * position:fixed 的包含块（除视口外的另一种可能）。
	 *
	 * transform / perspective / filter / backdrop-filter / will-change:transform /
	 * contain:layout|paint 的祖先会成为 fixed 后代的包含块——此时写进 style 的
	 * left/top 是相对该祖先的边框盒，而不是视口。本脚本自己就给
	 * [data-dshr-main-col] 挂了 transform + will-change（抽屉滑动必需），所以
	 * 手机端几乎所有浮层都落在这种"内部包含块"里。
	 */
	function fixedContainingBlock(el) {
		var node = el.parentElement;
		while (node && node !== document.body && node !== document.documentElement) {
			var cs = null;
			try { cs = window.getComputedStyle(node); } catch (ignoredCb) { return null; }
			if (!cs) return null;
			var willChange = String(cs.willChange || '');
			if (cs.transform !== 'none'
				|| cs.perspective !== 'none'
				|| cs.filter !== 'none'
				|| String(cs.backdropFilter || 'none') !== 'none'
				|| willChange.indexOf('transform') >= 0
				|| /layout|paint|strict|content/.test(String(cs.contain || ''))) {
				return node;
			}
			node = node.parentElement;
		}
		return null;
	}

	/** 写 !important 样式；值没变就不写（收敛判定靠它）。 */
	function setFloatStyle(el, prop, value) {
		if (el.style.getPropertyValue(prop) === value) return false;
		el.style.setProperty(prop, value, 'important');
		return true;
	}

	/**
	 * 把浮层夹进安全视口。返回是否真的改动了样式（用于收敛，见 scheduleClampFloats）。
	 *
	 * 两条关键约束（手机端"更多"菜单飘到输入卡上方就是踩了这两条）：
	 *  1. 已经整体落在安全视口内的浮层一律不碰——官方自己的锚点定位本来是对的；
	 *  2. 需要夹时才改成 position:fixed，此时坐标必须换算到 fixed 包含块的坐标系
	 *     （祖先里的 transform 会被浏览器再加一次），否则浮层每帧往下漂一截。
	 */
	function clampFloatHost(el) {
		if (!isMobileMode() || !isElement(el) || !isVisible(el) || isLayoutChrome(el)) return false;
		// 输入联想浮层不归本脚本夹（见 isInputTriggerPalette 的实测记录）：
		// 官方锚点本来就贴着输入卡且在安全视口内，这里只会把它顶到屏幕顶端。
		if (isInputTriggerPalette(el)) return false;
		var pad = viewportPad();
		var vw = window.innerWidth || document.documentElement.clientWidth || 390;
		var vh = window.innerHeight || document.documentElement.clientHeight || 844;
		var bottomLimit = vh - pad.bottom;
		// T125：页面可能有多个 composer（主会话 + 新建任务 dialog）：取与浮层同 dialog
		// 的那一个，找不到再取可见 composer 里 top 最大的（最靠近键盘的当前输入），
		// 避免永远用 DOM 第一个导致新建任务页的菜单被错误地钳到主会话输入框上方。
		var composer = null;
		try {
			var dialogHost = el.closest ? el.closest('[role="dialog"]') : null;
			if (dialogHost) composer = dialogHost.querySelector('[data-composer-card]');
			if (!composer) {
				var cards = document.querySelectorAll('[data-composer-card]');
				var bestTop = -1;
				for (var ci = 0; ci < cards.length; ci++) {
					if (!isVisible(cards[ci])) continue;
					var cr = cards[ci].getBoundingClientRect();
					if (cr.top > bestTop) { bestTop = cr.top; composer = cards[ci]; }
				}
				if (!composer && cards.length) composer = cards[0];
			}
		} catch (ignoredComposerPick) {
			composer = document.querySelector('[data-composer-card]');
		}
		if (isElement(composer) && isVisible(composer)) {
			var composerRect = composer.getBoundingClientRect();
			if (composerRect.top > 96) bottomLimit = Math.min(bottomLimit, composerRect.top - 8);
		}
		var rect = el.getBoundingClientRect();
		if (rect.width <= 1 || rect.height <= 1) return false;
		// 约束 1：本来就在安全区内，交给官方定位，绝不改写。
		if (rect.left >= pad.left - 0.5 && rect.top >= pad.top - 0.5
			&& rect.right <= vw - pad.right + 0.5 && rect.bottom <= bottomLimit + 0.5) {
			return false;
		}
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
		// 约束 2：换算到 fixed 包含块的坐标系。
		var host = fixedContainingBlock(el);
		var hostLeft = 0;
		var hostTop = 0;
		if (host) {
			var hostRect = host.getBoundingClientRect();
			hostLeft = hostRect.left;
			hostTop = hostRect.top;
		}
		var changed = false;
		if (setFloatStyle(el, 'position', 'fixed')) changed = true;
		if (setFloatStyle(el, 'left', Math.round(left - hostLeft) + 'px')) changed = true;
		if (setFloatStyle(el, 'top', Math.round(top - hostTop) + 'px')) changed = true;
		if (setFloatStyle(el, 'right', 'auto')) changed = true;
		if (setFloatStyle(el, 'bottom', 'auto')) changed = true;
		if (setFloatStyle(el, 'width', Math.round(width) + 'px')) changed = true;
		if (setFloatStyle(el, 'max-width', Math.round(maxW) + 'px')) changed = true;
		if (setFloatStyle(el, 'max-height', Math.round(maxH) + 'px')) changed = true;
		if (setFloatStyle(el, 'min-width', '0')) changed = true;
		if (setFloatStyle(el, 'transform', 'none')) changed = true;
		if (setFloatStyle(el, 'margin', '0px')) changed = true;
		if (setFloatStyle(el, 'box-sizing', 'border-box')) changed = true;
		if (changed) mark(el, 'data-dshr-float');
		return changed;
	}

	/** 夹一轮所有浮层，返回 { count, changed }——changed 为假表示已经收敛。 */
	function clampFloatingMenus() {
		if (!isMobileMode()) return { count: 0, changed: false };
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
		var changed = false;
		for (var h = 0; h < hosts.length; h++) {
			if (clampFloatHost(hosts[h])) changed = true;
		}
		return { count: hosts.length, changed: changed };
	}

	/**
	 * 夹浮动选框。只在"这一轮确实改动了样式"时再排下一轮收敛；一旦收敛立即停手。
	 * 旧实现只要页面上还有浮层就每帧重排——配合包含块偏移会让浮层逐帧向下漂，
	 * 停在输入卡上方；同时空转 rAF 也白烧 CPU/电量。
	 */
	var floatRaf = 0;
	var floatPasses = 0;
	function scheduleClampFloats() {
		if (floatRaf) return;
		floatRaf = window.requestAnimationFrame(function () {
			floatRaf = 0;
			var result = clampFloatingMenus();
			if (result.changed && result.count > 0 && floatPasses < 4) {
				floatPasses++;
				scheduleClampFloats();
				return;
			}
			floatPasses = 0;
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
			/**
			 * T103：长按既然已经进了 App 连接设置页，**这一次手势后面那记 click 必须吞掉**。
			 *
			 * 实测真值（`scratch/t103/ev/p03-diag.json`：真机 WebView + CDP 触摸 + 临时探针）：
			 *   touchstart@34ms → 650ms 定时器触发（设置页弹出）→ touchend@868ms → **click@872ms**
			 *   （isTrusted=true / detail=1，落在鲸鱼上、未被 preventDefault）。
			 * 也就是说只靠 touchend 里那句 `!longPressFired` 不 toggle 是**不够**的：click handler
			 * 里 `suppressClickUntil` 当时仍是 0 ⇒ 又 toggleSidebar() 一次 ⇒ 抽屉 collapsed
			 * true→false（实测：长按进设置页的同时把侧栏也打开了）。800ms 窗口与短按路径同值、
			 * 同一变量；click handler 对窗口内**每一次** click 都吞（T97 的教训：一次长按可能
			 * 跟来两次 click）。本函数不新增任何监听器、不写任何 DOM。
			 *
			 * 两个置位点：长按触发那一刻（覆盖没有 touchend 的 contextmenu 路径）与 touchend
			 * （覆盖「按住远超 800ms 才抬手」——那时窗口早已过期）。
			 */
			function armClickSuppress() {
				suppressClickUntil = Date.now() + 800;
			}
			// T103：多指防线的**文档级**临时守卫（只在长按在案期间挂，抬手/取消即摘）。
			// 为什么必须是文档级：实测（`scratch/t103/ev/v02-diagmulti.json`）第二根手指
			// 落在鲸鱼**之外**的另一棵子树时，`touchstart` 的 event.target 是那个元素 ——
			// 挂在鲸鱼自己身上的 handler **根本收不到这一次**，于是 650ms 定时器照旧触发、
			// 设置页照样弹出（改前实测：两指按住 1.1s ⇒ 设置页出现，
			// 见 `scratch/t103/ev/phone-whale-prepatch-multi.json`）。
			// 常态监听器数量**一个都不增加**（本守卫在长按立案时挂、抬手/取消/触发即摘，
			// 与 T97 的 `brandGuards` 同一套「手势进行中的临时守卫」做法）。
			var multiGuard = null;
			function guardMultiTouch() {
				if (multiGuard) return;
				multiGuard = function (event) {
					if (event.touches && event.touches.length > 1) cancelLongPress();
				};
				document.addEventListener('touchstart', multiGuard, { passive: true, capture: true });
			}
			function unguardMultiTouch() {
				if (!multiGuard) return;
				try { document.removeEventListener('touchstart', multiGuard, { capture: true }); } catch (ignoredMultiUnbind) {}
				multiGuard = null;
			}
			whale.addEventListener('contextmenu', function (event) {
				event.preventDefault();
				cancelLongPress();
				unguardMultiTouch();
				longPressFired = true;
				armClickSuppress();
				openAppSettings();
			});
			whale.addEventListener('touchstart', function (event) {
				var touch = event.touches && event.touches[0];
				// T103：多指不立案（与 T97 品牌区同一条口径）。第二根手指**落在鲸鱼上**时
				// 这一次 handler 就会看到 touches.length===2 ⇒ 立即取消（落在别处的情形由
				// 上面那个文档级 multiGuard 兜住）。**只**关掉长按立案，不动短按那条既有
				// 路径（touchend 里的 toggle 判据一字未改）。
				if (!event.touches || event.touches.length !== 1) {
					cancelLongPress();
					unguardMultiTouch();
					return;
				}
				touchStartX = touch ? touch.clientX : 0;
				touchStartY = touch ? touch.clientY : 0;
				touchMoved = false;
				longPressFired = false;
				cancelLongPress();
				guardMultiTouch();
				longPress = window.setTimeout(function () {
					longPress = null;
					longPressFired = true;
					unguardMultiTouch();
					armClickSuppress();
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
					unguardMultiTouch();
				}
			}, { passive: true });
			whale.addEventListener('touchcancel', function () {
				touchMoved = true;
				cancelLongPress();
				unguardMultiTouch();
			}, { passive: true });
			whale.addEventListener('touchend', function (event) {
				var shouldToggle = !longPressFired && !touchMoved;
				// T103：长按路径（含「按住远超 800ms 才抬手」）把窗口推到抬手那一刻，
				// 保证紧随其后的那记 click 被吞；短按路径照旧在下面用同一个变量抑制。
				if (longPressFired) armClickSuppress();
				cancelLongPress();
				unguardMultiTouch();
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

	// ── T97：平板档「左上角品牌区长按 = 打开 App 连接设置页」 ──────────────────
	//
	// 需求（用户原话）：平板档把左上角「鲸鱼图标 + deepseek HARNESS 文字」那片区域，
	// 由「单击 = 新会话」**另加**一条「长按 = 呼出 App 连接设置页」；单击行为原样保留。
	//
	// 契约变更：此前「平板档 hook 严格 OFF、页面零痕迹」是硬契约；本次用户明确授权
	// 平板档可以挂 hook。痕迹仍压到**最小**——
	//   · **不新增任何 DOM 节点 / 属性 / 类名 / 样式规则**（本段代码一行 DOM 都不写）；
	//   · 常态下**只挂一个事件监听器**（`document` 上的 touchstart，注册表里的一行，
	//     不出现在 DOM 里，也不出现在 outerHTML / 节点数 / data-dshr-* 计数里）；
	//   · 其余平板档能力（`window.WebSocket` 包装、悬浮鲸鱼、抽屉视觉、IM 标记、
	//     主题标记…）**一律保持关闭**：本段不碰 `window`、不进 teardownHookTraces
	//     的还原清单，T90 的「平板档可逆还原」逐条不变。
	// 全部痕迹清单（本特性在平板档新增的一切）在交付报告里逐条列出：只有那**一个**
	// 事件监听器（+ 手势进行中的临时守卫，手势结束即摘）。
	//
	// 目标元素锚定（**不依赖 CSS module 哈希类名**，只用官方结构/语义）：
	//   `[data-slot="sidebar"] [data-window-drag="true"] > button` 里的**第一个**按钮。
	// 实测（1280×800 官方布局，原始 DOM 见 scratch/t97/recon-brand.json）：
	//   <button type="button" class="hHd-Xa_brand hHd-Xa_wide" aria-label="新建会话"
	//           aria-keyshortcuts="Control+Alt+N"> rect=(16,24,216×24)，内含 2 个
	//   <svg>（鲸鱼 + 「deepseek HARNESS」文字标记），innerText 为空。
	// 同一行里的第二个按钮是「收起侧边栏」（Control+Alt+B），落到本判据就是 false；
	// 工作区树顶部那个大「新会话」按钮的父节点没有 data-window-drag，同样 false。
	// 单击它的既有行为实测 = **新建会话**（见 scratch/t97/recon-session.json：
	// 点前会话列表只有已存在的 T97 probe session，点后新增一行「新会话」且主区切回
	// 空会话落地页「探索未至之境」）。
	//
	// 阈值 600ms（BRAND_LONG_PRESS_MS）：Android 系统
	// `ViewConfiguration.getLongPressTimeout()` 为 500ms，取 600ms 在系统长按判定之上
	// 留一档余量（手慢一点的单击不会被吞成设置页），又落在 500–800ms 的通行长按区间内。
	// **刻意不动**手机档悬浮鲸鱼的既有 650ms —— 那是本脚本自加按钮、单击有语义
	// （toggle 抽屉），改阈值等于改已验收的手势；T103 只给它补了 click 抑制
	// （见 ensureFloatingControls 的 armClickSuppress），阈值一字未动。
	//
	// ── T103：本段从**平板档专属**放宽到「平板档 + 手机档」 ──────────────────────
	// 用户口径：进连接设置页只保留长按这一条路。T102 取消「返回键进设置页」之后，
	// 手机档在「抽屉展开」这个状态下**一个入口都没有**（悬浮鲸鱼那时是
	// `pointer-events:none !important`，点不到；品牌区又没挂监听）。
	// 真值依据：手机档抽屉展开时品牌区锚点命中且几何与平板档同构
	// （T102 `ev/p16-phone-longpress.json`：rect=[16,70,216×24]、aria="New session"），
	// 而当时长按它**不进设置页**（hasResumeButton=false）。
	// 实现代价 = **同一个** `document` touchstart 监听器（本来平板档就挂了这一个），
	// **不新增**第二个监听器、不写 DOM、不改阈值/取消条件/click 抑制逻辑一行。
	// 另外：手机档抽屉展开时那片区域正好压在悬浮鲸鱼的几何位置上（鲸鱼此时
	// pointer-events:none ⇒ 触摸落在品牌按钮上）⇒ 「左上角那一块长按 = 设置页」
	// 在抽屉开/关两种状态下语义一致。
	//
	// 误触防线（逐条对应实测，见 scratch/t97/report.md §3）：
	//   ① 位移 > BRAND_MOVE_TOLERANCE_PX(10px) ⇒ 取消（与手机档鲸鱼同阈值）；
	//   ② 滚动/拖动：touchmove 走取消路径，且三个 touch 监听全是 `{passive:true}`、
	//      **从不调用 preventDefault** ⇒ 不参与、不阻断页面滚动与惯性；
	//   ③ 多指：`touches.length !== 1` ⇒ 不立案，并取消在案手势；
	//   ④ 长按触发后**吞掉随后那次 click**（见 brandOnClickCapture）：否则会同时
	//      「打开新会话 + 打开设置页」——这是本任务最容易出错的一处；
	//   ⑤ 目标找不到 / 桥缺失 ⇒ 静默降级（isBrandAreaButton 返回 false 即不立案；
	//      openAppSettings 自带 typeof 判空与 try/catch），全程不抛错、不写页面。
	/** T97：长按判定阈值（ms）。 */
	var BRAND_LONG_PRESS_MS = 600;
	/** T97：手指位移容差（px）。 */
	var BRAND_MOVE_TOLERANCE_PX = 10;
	/** T97：长按触发后吞 click 的窗口（ms）。 */
	var BRAND_CLICK_SUPPRESS_MS = 1500;
	/** T97：常态唯一监听器是否已挂。 */
	var brandTouchStartBound = false;
	/** T97：在案手势（null = 无）。 */
	var brandPress = null;
	/** T97：长按已触发 ⇒ 该时刻之前落到品牌区的那次 click 要吞掉。 */
	var brandSuppressClickUntil = 0;
	/** T97：手势进行中挂的临时守卫（entries=[[type,fn,opts],…]，手势结束即摘）。 */
	var brandGuards = null;

	/**
	 * T97：档位闸（T103 放宽）。
	 *
	 * T103 之前：只在平板档（严格 OFF = `device==='tablet'`）挂 —— 手机档一个监听器都不挂。
	 * T103 起：**手机档也挂**，理由是真机真值（见交付报告 §1）：
	 *   · 手机档会话页「长按左上角品牌区」在 T102 后**完全不触发**（T102 §3.2 P6 已证），
	 *     而抽屉**展开**时那片区域正是用户看得见的唯一入口 —— 悬浮鲸鱼此时是
	 *     `pointer-events:none !important`（MOBILE_CSS 的 `[data-dshr-expanded="1"]` 规则），
	 *     点不到，于是「抽屉开着」这个状态下手机档没有任何进设置页的手势入口。
	 *   · 品牌区这个锚点手机档**命中得了**：T102 `ev/p16-phone-longpress.json` 实测
	 *     `[data-slot="sidebar"] [data-window-drag="true"] > button` 在手机档抽屉展开时
	 *     rect=[16,70,216×24]、aria="New session"，与平板档同构。
	 * 闸门写成「严格 OFF **或** 手机档 + hook 启用态」，**刻意不含 `auto`**：
	 * `auto` 的契约是「等价于本文件改动前的既有行为」，T97 之前 auto 就没有这条监听。
	 * 手机横屏（`hookOn=false`）同样不挂 ⇒ 该档位连监听器都不存在。
	 */
	function brandLongPressWanted() {
		return isStrictOff() || (deviceMode === 'phone' && hookOn === true);
	}

	/**
	 * T97：判一个元素是不是「左上角品牌区」那个官方按钮。
	 * 只认官方结构：父行带 `data-window-drag="true"`（官方窗口拖动区），且自己是该行
	 * **第一个** button —— 同一行里第二个是「收起侧边栏」，这里自然为 false。
	 * 不读 aria-label 文本（会被 i18n 改），不读任何 CSS module 哈希类名。
	 */
	function isBrandAreaButton(el) {
		if (!el || el.nodeType !== 1 || el.tagName !== 'BUTTON') return false;
		var row = el.parentElement;
		if (!row || row.getAttribute('data-window-drag') !== 'true') return false;
		if (row.querySelector('button') !== el) return false;
		var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
		return !!(r && r.width > 0 && r.height > 0);
	}

	/** T97：从事件目标往上找品牌按钮（touch 可能落在里面的 <svg>/<span> 上）。 */
	function brandAreaFromTarget(target) {
		var node = target;
		for (var i = 0; node && node.nodeType === 1 && i < 8; i++) {
			if (isBrandAreaButton(node)) return node;
			node = node.parentNode;
		}
		return null;
	}

	/** T97：取消在案手势（有定时器就清掉）。 */
	function brandCancelPress() {
		if (brandPress && brandPress.timer) window.clearTimeout(brandPress.timer);
		brandPress = null;
	}

	/**
	 * T97：摘掉临时守卫。
	 * @param keepClickGuard true = 只摘 touch* 三个，click 守卫留到抑制窗口结束
	 *        （长按路径必须留：那一次 click 正是要吞的对象）。
	 */
	function brandUnbindGuards(keepClickGuard) {
		var g = brandGuards;
		if (!g) return;
		if (keepClickGuard) {
			var kept = [];
			for (var i = 0; i < g.entries.length; i++) {
				var e = g.entries[i];
				if (e[0] === 'touchmove' || e[0] === 'touchend' || e[0] === 'touchcancel') {
					try { document.removeEventListener(e[0], e[1], e[2]); } catch (ignoredBrandUnbindA) {}
				} else {
					kept.push(e);
				}
			}
			g.entries = kept;
			if (!g.timer) {
				g.timer = window.setTimeout(function () { brandUnbindGuards(false); }, BRAND_CLICK_SUPPRESS_MS + 200);
			}
			return;
		}
		brandGuards = null;
		if (g.timer) window.clearTimeout(g.timer);
		for (var j = 0; j < g.entries.length; j++) {
			try { document.removeEventListener(g.entries[j][0], g.entries[j][1], g.entries[j][2]); } catch (ignoredBrandUnbindB) {}
		}
	}

	/** T97：长按触发 —— 记账、开抑制窗口、调原生桥。任何一步都不写 DOM。 */
	function brandFireLongPress() {
		if (!brandPress) return;
		brandPress.timer = 0;
		brandPress.fired = true;
		brandSuppressClickUntil = Date.now() + BRAND_CLICK_SUPPRESS_MS;
		openAppSettings();
	}

	/** T97：本次手势的临时守卫（手势结束即摘，故常态只剩 touchstart 一个）。 */
	function brandBindGuards() {
		if (brandGuards) return;
		var entries = [
			['touchmove', brandOnMove, { passive: true }],
			['touchend', brandOnEnd, { passive: true }],
			['touchcancel', brandOnCancel, { passive: true }],
			// click 用**捕获**：React 18 把合成事件挂在 root 容器上，document 捕获阶段
			// 先于它，stopPropagation 才拦得住官方那记「新建会话」。
			['click', brandOnClickCapture, { capture: true }],
		];
		brandGuards = { entries: entries, timer: 0 };
		for (var i = 0; i < entries.length; i++) {
			try { document.addEventListener(entries[i][0], entries[i][1], entries[i][2]); } catch (ignoredBrandBindGuard) {}
		}
	}

	/** T97：手指移出容差 ⇒ 取消（滚动/拖动不得触发）。 */
	function brandOnMove(event) {
		if (!brandPress) return;
		var touches = event.touches;
		if (!touches || touches.length !== 1) { brandCancelPress(); return; }
		var t = touches[0];
		if (Math.abs(t.clientX - brandPress.x) > BRAND_MOVE_TOLERANCE_PX ||
			Math.abs(t.clientY - brandPress.y) > BRAND_MOVE_TOLERANCE_PX) {
			brandCancelPress();
		}
	}

	/** T97：抬手。未触发长按 ⇒ 这是普通单击，守卫全摘，click 照常落到官方 handler。 */
	function brandOnEnd() {
		var pressed = brandPress;
		if (!pressed) { brandUnbindGuards(false); return; }
		var fired = pressed.fired;
		brandCancelPress();
		brandUnbindGuards(fired);
	}

	/** T97：touchcancel ⇒ 当作未触发处理（不吞 click 之外的一切都不做）。 */
	function brandOnCancel() {
		brandCancelPress();
		brandUnbindGuards(false);
	}

	/**
	 * T97：**click 抑制**。长按已经调过 openSettings，这一次 click 绝不能再落到官方
	 * handler 上——否则「打开新会话」与「打开设置页」同时发生。
	 * React 18 的合成事件挂在 root 容器（本页是 `#root`）上，document 捕获阶段的
	 * stopPropagation 足以让事件到不了那里；<button type="button"> 没有默认动作，
	 * preventDefault 只是保险，且与滚动无关（滚动在 touchmove 上，本函数不碰）。
	 *
	 * ⚠ 窗口内**吞掉每一次**落在品牌区的 click，而不是「吞一次就收工」：
	 * 实测（scratch/t97/diag-suppress.mjs）一次长按之后可能跟着**两**次 click
	 * （合成 click 与 touch-derived click 各一次），只吞第一次的话第二次照样会把
	 * 新会话打开。所以匹配后**不清零**窗口、`brandUnbindGuards(true)` 只摘触摸类守卫、
	 * 把 click 守卫留到窗口自然到期。
	 */
	function brandOnClickCapture(event) {
		if (Date.now() >= brandSuppressClickUntil) return;
		if (!brandAreaFromTarget(event.target)) return;
		try { event.stopPropagation(); } catch (ignoredBrandStop) {}
		try { event.preventDefault(); } catch (ignoredBrandPrevent) {}
		brandUnbindGuards(true);
	}

	/** T97：常态唯一监听器的本体（任何一步出错都不得影响页面）。 */
	function brandOnTouchStart(event) {
		try {
			if (!brandLongPressWanted()) return;
			var touches = event.touches;
			// 多指：不立案；在案的一并取消（多指不得触发长按）。
			if (!touches || touches.length !== 1) { brandCancelPress(); brandUnbindGuards(false); return; }
			if (brandPress) return;
			if (!brandAreaFromTarget(event.target)) return;
			var t = touches[0];
			brandPress = { x: t.clientX, y: t.clientY, fired: false, timer: 0 };
			brandBindGuards();
			brandPress.timer = window.setTimeout(brandFireLongPress, BRAND_LONG_PRESS_MS);
		} catch (ignoredBrandStart) {
			brandCancelPress();
		}
	}

	/**
	 * T97/T103：按档位同步（`applyWidthScope` 唯一的调用点，幂等）。
	 * 生效档位（平板档严格 OFF + 手机档 hook 启用态）⇒ 挂上**唯一**那个 `touchstart`
	 * 监听（capture 阶段，保证官方若在 touchstart 上 stopPropagation 也拦不住我们）；
	 * 其余档位（手机横屏 / auto）⇒ 一个不留地摘掉。
	 */
	function syncBrandLongPress(enabled) {
		if (enabled) {
			if (brandTouchStartBound) return;
			try {
				document.addEventListener('touchstart', brandOnTouchStart, { passive: true, capture: true });
				brandTouchStartBound = true;
			} catch (ignoredBrandBindStart) {
				brandTouchStartBound = false;
			}
			return;
		}
		if (!brandTouchStartBound) return;
		try { document.removeEventListener('touchstart', brandOnTouchStart, { capture: true }); } catch (ignoredBrandUnbindStart) {}
		brandTouchStartBound = false;
		brandCancelPress();
		brandUnbindGuards(false);
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
	// PERF-04：通知节流——token 流期间 MutationObserver 高频触发，旧 180ms
	// debounce 下每次都要全量 querySelectorAll(div,p)+getComputedStyle 扫描，
	// 还经 bridge 唤醒原生。为省电：debounce 提到 1000ms，且 running 未翻转时
	// 两次上报至少间隔 2000ms；running 翻转（开始/结束）立即上报不延迟。
	// 后台时 WebView.onPause/pauseTimers 已停 JS，这里是前台流式场景的补充。
	var lastNoticeAt = 0;
	var lastNoticeRunning = false;
	var NOTICE_DEBOUNCE_MS = 1000;
	var NOTICE_MIN_INTERVAL_MS = 2000;
	// REVIEW-03：max-delay 防饿死——debounce 被持续 mutation 重置时，最多延迟
	// NOTICE_MIN_INTERVAL_MS 必报一次；min-interval 提前返回时若 key 已变，
	// 补一个区间边界定时器，不丢最后一次变化。
	var noticeScheduledAt = 0;
	var lastFlipCheckAt = 0;
	function reportSessionNotice() {
		noticeTimer = 0;
		var running = isAgentRunning();
		var now = Date.now ? Date.now() : 0;
		if (running === lastNoticeRunning && now - lastNoticeAt < NOTICE_MIN_INTERVAL_MS) {
			var probe = null;
			try { probe = collectSessionNotice(); } catch (ignoredProbe) { return; }
			var probeKey = (probe.running ? '1' : '0') + '\n' + probe.title + '\n' + probe.text;
			if (probeKey !== lastNoticeKey && !noticeTimer) {
				noticeTimer = window.setTimeout(function () {
					noticeTimer = 0;
					reportSessionNotice();
				}, NOTICE_MIN_INTERVAL_MS - (now - lastNoticeAt));
			}
			return;
		}
		var notice = collectSessionNotice();
		var key = (notice.running ? '1' : '0') + '\n' + notice.title + '\n' + notice.text;
		if (key === lastNoticeKey) {
			lastNoticeRunning = notice.running;
			return;
		}
		lastNoticeKey = key;
		lastNoticeAt = now;
		lastNoticeRunning = notice.running;
		try {
			if (window.DshRemoteApp && typeof window.DshRemoteApp.setSessionNotice === 'function') {
				window.DshRemoteApp.setSessionNotice(notice.title, notice.text, notice.running);
			}
		} catch (ignoredNotice) {}
	}

	function scheduleSessionNotice() {
		var nowMs = Date.now ? Date.now() : 0;
		// running 翻转立即上报（开始生成/结束的感知不能等 1s）。
		// 翻转检查本身也是 querySelectorAll，最多 500ms 查一次，免得节流反被检查吃掉。
		if (nowMs - lastFlipCheckAt >= 500) {
			lastFlipCheckAt = nowMs;
			try {
				var runningNow = isAgentRunning();
				if (runningNow !== lastNoticeRunning) {
					if (noticeTimer) window.clearTimeout(noticeTimer);
					noticeTimer = 0;
					reportSessionNotice();
					return;
				}
			} catch (ignoredFlip) {}
		}
		// 已有 pending 且距排程不足一个区间：不再重置，保证 max-delay。
		if (noticeTimer && nowMs - noticeScheduledAt < NOTICE_MIN_INTERVAL_MS) return;
		if (noticeTimer) window.clearTimeout(noticeTimer);
		noticeScheduledAt = nowMs;
		noticeTimer = window.setTimeout(function () {
			noticeTimer = 0;
			reportSessionNotice();
		}, NOTICE_DEBOUNCE_MS);
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
			if (label === '命令' || label === 'Commands' || label === '指令'
				|| label === 'Add files or run commands' || label === '添加文件或运行命令'
				|| label === '添加文件或调用指令' || label === '添加文件或运行指令') mark(buttons[j], 'data-dshr-composer-add');
			if (label.indexOf('访问模式') === 0 || label.indexOf('Access mode') === 0) {
				markAccessChrome(buttons[j]);
			}
		}
		if (isElement(row)) {
			var modelButtons = row.querySelectorAll('button[aria-haspopup="menu"], button[aria-haspopup="dialog"], button[aria-haspopup="listbox"]');
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
		// 严格 OFF（平板档）：观察器保留但立即返回——契约 3.5 允许的「早退的
		// observer」。这里必须早于任何标记/建节点动作，否则会重新留下痕迹。
		if (isStrictOff()) return;
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
			// 官方右侧栏全屏（0.1.3+ 的文件树/文档预览）时收起本脚本的悬浮鲸鱼。
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

		// ── T130：右抽屉卡片态镜像 + 跟手痕迹卫生 ──
		// data-dshr-ropen = 「官方 open 且面板为 fullscreen 卡片态」（push/docked 不置位），
		// 供遮罩换边 / drag handle 镜像两条 CSS 规则用。
		var rPanelNow = findRightbarPanel();
		var rOpenNow = isRightbarOpen();
		var rCardNow = !!(rPanelNow && rPanelNow.getAttribute('data-sidebar-right-panel') === 'fullscreen');
		root.setAttribute('data-dshr-ropen', rOpenNow && rCardNow ? '1' : '0');
		// T133：官方状态一旦与在途 toggle 的目标态一致，立刻解除 busy（观察者驱动，
		// 比 650ms 盲窗快），并串联队列里的下一个意图。这让「手势落位 + 返回键桥」
		// 这类同帧双击在第一颗 toggle 落地后立刻变回可派发，但队列里的同一意图
		// 会被 flushPendingRightbar 的等态检查吞掉，不会产生第二颗 toggle。
		if (rightToggleBusy && rightIntentState !== null && rOpenNow === rightIntentState) {
			rightToggleBusy = false;
			rightIntentState = null;
			flushPendingRightbar();
		}
		if (!rOpenNow) {
			// 官方已收起（含 settleRight 关闭落位后的异步收敛、官方按钮直收）：
			// 清掉右抽屉全部跟手痕迹。此时面板已被官方隐藏，清 --dshr-rx 无可见跳变。
			// T135：**先撤交接窗、再清 --dshr-rx**。撤窗这一刻卡片规则不再命中 ⇒ 面板
			// 回到官方关闭几何（屏外）；随后清 rx 不会带着 .34s 过渡把面板从屏外拉回来。
			root.removeAttribute('data-dshr-rclosing');
			clearRightVisual(false);
		} else if (!rightVisual && !rightSettleAnim && !root.style.getPropertyValue('--dshr-rx')) {
			// 非手势路径打开（官方按钮 / 返回桥外）：确保停在全开设定位
			// （--dshr-rx 缺省即 0px，这里显式写一次只是让语义自解释）。
			root.style.setProperty('--dshr-rx', '0px');
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
		// T21 修复 3：本轮同步收敛后上报一次（值不变时 reportUiDiag 自身会去抖）。
		reportUiDiag();
	}

	var lastPageDark = null;
	function syncPageTheme() {
		// 插件加载前没有主题标记不等于浅色；此时使用系统主题。
		// 会话 frame 出现后，以 DSH 的实际选择为准（包括用户手选浅色）。
		var dark = !!(document.body && document.body.hasAttribute('data-ds-dark-theme'));
		if (!dark && !findFrame()) {
			try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (ignored) {}
		}
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
	// DIAG-30s：首屏 React 水合是 mutation 风暴，每批全量 syncDom 会把主线程
	// 打满（querySelectorAll 全文档）。合并到 50ms 一次；不用 rAF——后台页
	// rAF 不触发，会连带拖住 running 翻转通知。直接调用处（boot/resize/桥）
	// 仍走同步 syncDom，不受影响。
	var syncQueued = false;
	function scheduleSyncDom() {
		// 严格 OFF（平板档，契约 3.5）：不得再排程任何同步定时器。观察器在
		// 档位切换后仍然挂着（见 startObserver：拆除不 disconnect，切回 phone 档
		// 才复用），若无条件起 50ms 定时器，平板档每次官方 DOM 变更都会白白唤醒
		// 一次主线程，而 syncDom() 必然在入口早退——纯浪费，与省电目标相悖。
		// 早退放在 syncQueued 之前，保证平板档不把标志位卡在 true，导致切回
		// phone 档后第一帧的真实同步被 scheduleSyncDom 的去重逻辑吞掉。
		if (isStrictOff()) return;
		if (syncQueued) return;
		syncQueued = true;
		window.setTimeout(function () {
			syncQueued = false;
			syncDom();
		}, 50);
	}
	function startObserver() {
		if (observer !== null) {
			// 观察器本身还装着，但严格 OFF 的拆除已抹掉 data-dshr-observer；
			// 切回 phone 档时必须补回，否则与「首次装上」的状态不可逆。
			if (!isStrictOff()) document.documentElement.setAttribute('data-dshr-observer', '1');
			return true;
		}
		// 严格 OFF 不装观察器：它会在 <html> 上写 data-dshr-observer，本身就是痕迹。
		// 切回 phone 档时由 recomputeDeviceScope 补装。
		if (isStrictOff()) return false;
		if (typeof MutationObserver === 'undefined' || !document.body) return false;
		observer = new MutationObserver(scheduleSyncDom);
		// T135：右栏开合落到 `data-sidebar-right-open`（+ `aria-hidden`）上。两者原先**不在**
		// 过滤名单里，右栏属性翻转能否被及时同步，全靠官方那次提交**恰好**带了 childList
		// 变更 —— 一旦某次提交只有属性变化，syncDom 就要等下一次任意 DOM 变更才跑：
		//   · rightToggleBusy 迟迟不解 ⇒ 1200ms 看门狗按「派发丢失」补发第二颗 toggle
		//     （右栏被开两遍 / 动画两次的另一条独立链路）；
		//   · 交接窗（data-dshr-rclosing）迟迟不撤。
		// 这两条属性都只在面板开合时翻转，加进名单的代价可忽略。
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: [
				'data-sidebar-collapsed',
				'data-dshx-overlay',
				'data-rightbar-fullscreen',
				'data-sidebar-right-open',
				'aria-hidden',
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
		// 平板档：官方 DOM 探针与 hook 无关，不做有界重试（否则白烧 12s 定时器）。
		// 但状态仍要报给原生（on=false），否则「平板档装上了没生效」在原生侧不可见。
		if (isStrictOff()) {
			reportUiDiag();
			return;
		}
		var observing = startObserver();
		syncDom();
		// boot 收敛判定之后补报一次：syncDom 里那次发生在 data-dshr-ready 落位之前，
		// 这里才是「ready=1」的真值（同步时序上 ready 可能被同一轮末尾的标记改掉）。
		reportUiDiag();
		var ready = document.documentElement.getAttribute('data-dshr-ready') === '1';
		if (ready && observing) return;
		if (bootTicks < 40) {
			bootTicks += 1;
			window.setTimeout(boot, 300);
		}
	}
	// 运行时切回 phone 档时补装观察器并按最新 DOM 重算（契约 3.3 的立即生效）。
	recomputeDeviceScope = function () {
		applyWidthScope();
		if (!hookOn) return;
		// T115：原生 inset 现在**无论哪个档位都当场写**（见 __dshRemoteInsets.set），
		// 这里补写只是「切档后按最后一次收到的值重算一遍」的兜底，保证可逆。
		var rootStyle = document.documentElement.style;
		rootStyle.setProperty('--dshr-inset-top', lastInsetTop + 'px');
		rootStyle.setProperty('--dshr-inset-bottom', lastInsetBottom + 'px');
		rootStyle.setProperty('--dshr-inset-left', lastInsetLeft + 'px');
		rootStyle.setProperty('--dshr-inset-right', lastInsetRight + 'px');
		startObserver();
		syncDom();
	};
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

	// ══════════════════════════════════════════════════════════════════════════
	// T90：连接态信号源 —— **UI 无关**的「app 自己那条 WebSocket 现在活着吗」
	// ══════════════════════════════════════════════════════════════════════════
	//
	// 为什么需要它（T88 §E.4 / T87 §5.3 实测）：官方那条「重新连接中」指示器的渲染
	// 条件是 `state: wide && …`（`wide = !collapsed`，dsh-client-ui-settings-general），
	// **左栏收起（56px rail）时它根本不渲染** —— rail 是用户平时的主界面状态，
	// 45s 真断线窗口里 `[data-phase="connecting"]` 0 帧、hook 判据 0 命中、
	// `nudges=0`、`lastDisconnectAt=0`（同轮展开侧栏后 +134ms 立刻出现 268 帧）。
	// ⇒ 只靠"页面里那段文案"的判据在 rail 下**没有可判对象**，原生横幅同源同限。
	//
	// 选型：先找现成的页面侧信号，**没有**才包装 `window.WebSocket`。
	//   · `__DSH_CONNECTION_RECOVERY__` 是**服务端注入的重连参数**（dsh-client-connection
	//     的 `resolveConnectionConfig`：backoffBaseMs/backoffFactor/backoffMaxMs/
	//     generationReadyWarnMs/generationReadyTimeoutMs），**不随断线变化**；
	//   · `__DSH_BOOT__` / `__DSH_BOOT_READY__` 是 boot 载荷与就绪 promise，
	//     `__ModuleLoader__` 只有 mode/pendingQueue/load/create（T82 §C 逐键扫过），
	//     其余 `__DSH_*` 全是数据类配置 ⇒ 没有一个带连接态/重连计数。
	//   （这一条不是"读源码猜的"：`scratch/t90/signal-scan.mjs` 在真机上把 window 上
	//     **全部** DSH 相关全局在"断线前/断线中/恢复后"三拍逐一快照做差分，
	//     证明没有任何一个键随断线变化；原始 JSON 见 `scratch/t90/signals.json`。）
	//
	// 包装器纪律（**绝不能影响 app 自己的连接与重连**）：
	//   1. 只加 `open`/`close` 监听，**不调用 socket 上的任何方法**、不改它的属性；
	//   2. 构造用 `Reflect.construct(native, arguments, new.target)` —— 参数数组、
	//      原型（`WebSocket.prototype` **原对象**）、静态量（CONNECTING/OPEN/CLOSING/CLOSED）、
	//      `instanceof` 语义全部原样透传；不带 `new` 调用时抛与浏览器**逐字相同**的 TypeError；
	//   3. 支持多 socket（app 每次重连都新建一条）：只要有一条 OPEN 就判健康；
	//   4. 装上后再被注入时**不会二次包装**（`__dshrWsWatchWrapped` 标记 + 幂等闸）；
	//   5. 平板档（`device==='tablet'`，hook 严格 OFF）**一个字节都不碰**：
	//      不安装、不写全局；切换到平板档时 `uninstallWsStateWatch()` 把
	//      `window.WebSocket` 还原成原生构造器并删掉自检全局。
	//
	// 判据（`wsWatchDown()`）逐条（**T112 重写**，改前只有①②③且都没有宽限）：
	//   ① 有**同类**（与页面同源）socket 处于 OPEN            ⇒ 健康（有活口即健康）；
	//   ② 一条**曾经 OPEN 过**的同类 socket 关了、且此刻没有别的活口 ⇒ **WS_CLOSE_GRACE_MS
	//      宽限**后判"断"（不再是"close 后 0ms 就算断"）；
	//   ③ 有同类 socket 已构造但迟迟没 OPEN，超过 WS_CONNECT_GRACE_MS ⇒ **断**
	//      （覆盖"页面加载时就连不上、一直在重连"：TCP 直接失败会走 ②，
	//        半死链路上长期 CONNECTING 由 ③ 兜住）；
	//   ④ 还没见过任何同类 socket（app 还没建）⇒ 未知 ⇒ **不算断**（宁可漏报不误报）。
	//   ⇒ 冷启首连那 0–8s 恒为假，不会把"正在建立首连"误报成断线。
	//
	// T112 三条修正（每一条都对着本轮"稳定链路被判成断开"的真值，见 report §1）：
	//   · **只认同类 socket**（S10）：改前包装器包住页面里**所有** `new WebSocket`，
	//     任何一条别的 socket 关闭都会把全局 `closeSeen` 置真、并且把 `openNow` **减到 0**
	//     （`openNow` 是"open 事件数 − close 事件数"，不是"当前活着的 socket 数"）⇒
	//     别家连接一关就误报主连接断开，而且此后主连接**不再产生 open 事件**，
	//     这个假"断"会**钉死到页面重建**为止（这正是用户报的"频繁重连"里最毒的一条）。
	//     现在非同源 socket 只旁观计数（`bystanders`），一个判据字段都不碰。
	//   · **每条 socket 自己记 open 过没有**：没 open 过的 socket 关闭**不减** `openNow`
	//     （它从来不是活口），只把"正在连"的起点保住。
	//   · **close 有宽限**（S3）：新 socket 在宽限内 open ⇒ 不算断。
	// 宽限带来的"判据变真"延迟由 `wsWatchRecheck()` 的一次性截止定时器补上（不是轮询）。

	// 注意：`WS_WATCH_KEY` / `WS_CONNECT_GRACE_MS` / `wsWatchState` 三个 var 与下面这一组
	// 函数**分开**：它们必须在本函数体**第一行**（`installWsStateWatch()` 那次最早的调用）
	// 之前就完成赋值，故声明在文件顶部那段 "T90 自检状态" 里（见 dshRemoteMobileBoot 开头）。
	/** 注入档位是不是平板（严格 OFF）。注入早于本脚本，故最早那一步就能判。 */
	function wsWatchInjectedTablet() {
		try {
			var cfg = window.__DSHR_MOBILE__;
			var dev = cfg && typeof cfg.device === 'string' ? cfg.device.trim().toLowerCase() : '';
			return dev === 'tablet';
		} catch (ignoredWsWatchDevice) { return false; }
	}

	/**
	 * T112：这条 socket 是不是"页面自己那条"（host 与页面一致）。
	 * 判据只认同源 socket；不同源的一律只旁观（S10）。
	 * 解析失败 ⇒ 保守判成同源（宁可照旧观测，也不因为一条解析不出来的 URL 丢掉真信号）。
	 */
	function wsWatchSameOrigin(url) {
		try {
			var u = new URL(String(url), window.location.href);
			return u.host === window.location.host;
		} catch (ignoredWsOrigin) { return true; }
	}

	/** T90：连接态是否"断"。**只读、无副作用**，不依赖任何 UI 文案。 */
	function wsWatchDown() {
		var s = wsWatchState;
		if (!s || !s.installed) return false;
		if (s.openNow > 0) return false;
		var now = Date.now();
		// T116（P0·用着用着显示重连）：交接窗抑制 —— 新 socket 正在 8s 宽限内建链时，
		// 不许用“老 socket 已关 1.5s”报断。改前 close 分支优先，老 socket 关后 1.5s
		// 即报断（即使新 socket 还在正常握手），随后 nudge 掐断这次握手 = 自造一次真重连。
		// 中转链路上一次 TCP+WSS 握手超 1.5s 并不稀奇，8s 才是双方承认的建链宽限。
		if (s.pendingSince > 0 && now - s.pendingSince < WS_CONNECT_GRACE_MS) return false;
		// ② 曾经 OPEN 过的同类 socket 关了、且没有别的活口：给一个宽限期（S3）。
		if (s.closeAt > 0 && now - s.closeAt >= WS_CLOSE_GRACE_MS) return true;
		// ③ 有同类 socket 构造出来了却迟迟没 open：超过 CONNECTING 宽限即断（S4）。
		if (s.pendingSince > 0 && now - s.pendingSince >= WS_CONNECT_GRACE_MS) return true;
		return false;
	}

	/**
	 * T90：**两端唯一**的连接态判据。
	 * 层 1/层 2 的 DOM 文案（T88）**或** WS 观测（T90）任一为真 ⇒ 处于断开态。
	 * 顺序与语义：DOM 先（它在 wide 布局下更精确、也兼容官方将来换实现），
	 * WS 兜底（rail 下 DOM 恒 null 时的唯一信号）。
	 */
	function isConnectionDown() {
		var el = null;
		try { el = findReconnectStatusElement(); } catch (ignoredConnDownText) { el = null; }
		if (el) return true;
		// T95：回前台探活判定"传输层已死"（半开：`open`/`close` 事件都不会来，
		// wsWatchDown() 恒 false）⇒ 判据必须认它，否则页面把"表面连着、实际已死"当健康，
		// 一次 nudge 都不推、原生自救层也看不到真相。有效期 RESUME_VERIFY_TRUST_MS，
		// 新 socket 真打开时在 wsWatchEvent() 里当场撤销。
		// T116（P0·误判自证）：有活口（openNow>0）时忽略 trust —— 双探失败时那条
		// 健康 socket 还开着，没有新 open 事件来撤销 trust，trust 会压住活链 20s；
		// 其间 hook 按电平每秒重推、原生 OR 进判据，随后 nudge 掐断这条活链 =
		// “探活误判 → 自造一次真重连”。活口是事实，探活只是推测，事实优先。
		// 门控前置、老字面量原样保留（源码契约逐字匹配下面那一行）。
		try {
			var live = wsWatchState;
			if (live && live.installed && live.openNow > 0) return wsWatchDown();
		} catch (ignoredTrustLive) { /* 取不到活口信息就按旧语义走 trust 那一行 */ }
		if (resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS) return true;
		return wsWatchDown();
	}

	/**
	 * T112b：把"这一次判据是被哪一层认出来的"算成**一个**取值，供 nudge 的动作分流用。
	 * 取值与 `resumeRecoveryState().wsSrc` **同口径**（同一段表达式，只是抽成函数避免两处漂移）：
	 *   1 = 官方 `<button data-phase="connecting">` / 2 = 老文案路径（两者都是 **DOM 渲染**）
	 *   3 = WS 观测（`open`/`close` 事件，**事实**）/ 4 = 只有回前台探活命中 / 0 = 健康。
	 *
	 * 为什么要分"渲染"与"事实"：DOM 文案只是页面对状态的**渲染**（它可能还没被清掉、
	 * 也可能是别人渲染的），而 WS 的 close 事件是浏览器给出的**事实**。只有事实才值得
	 * 用"掐断在用连接"这种动作去修（见 requestUpstreamReconnect 的 T112b 段）。
	 */
	function connectionDownSource() {
		var detail = findReconnectStatusDetail();
		if (detail.src > 0) return detail.src;
		var wsDown = false;
		try { wsDown = wsWatchDown(); } catch (ignoredSrcWs) { wsDown = false; }
		if (wsDown) return 3;
		// T116：与 isConnectionDown() 同口径 —— 有活口时 trust 不计入来源（见上），
		// 否则 nudge 分流会把“活链 + 误判 trust”当成来源 4 去 online-only，
		// 而判据侧却报断，两边口径漂移。门控前置、老字面量原样保留。
		try {
			var liveSrc = wsWatchState;
			if (liveSrc && liveSrc.installed && liveSrc.openNow > 0) return 0;
		} catch (ignoredSrcLive) { /* 取不到就按旧语义走 trust 那一行 */ }
		if (resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS) return 4;
		return 0;
	}

	/** 重算判据；**只有翻转**才通知（稳态零动作）。宽限到期由 wsWatchRecheck 负责再调一次。 */
	function wsWatchNotifyEdge() {
		var s = wsWatchState;
		if (!s) return false;
		var down = wsWatchDown();
		var flipped = down !== s.lastDown;
		s.lastDown = down;
		if (!flipped) return false;
		try {
			if (typeof s.notify === 'function') s.notify(down);
		} catch (ignoredWsWatchNotify) { /* 通知失败绝不影响 socket 自身 */ }
		return true;
	}

	/** 观测到一次 socket 生命周期事件：更新计数（判据翻转交给 wsWatchNotifyEdge）。 */
	function wsWatchEvent(rec, opened, ev) {
		var s = wsWatchState;
		if (!s || !rec || rec.bystander) return;
		if (opened) {
			if (rec.opened) return;      // 同一条 socket 重复派发 open 不重复计数
			rec.opened = true;
			s.openNow += 1;
			s.pendingSince = 0;
			s.closeAt = 0;
			s.closeSeen = false;
			// T95：新 socket 真开了 ⇒ 撤销"传输层已死"的判定（探活的结论只活到链路自己给出证据）。
			resumeVerifyDownAt = 0;
			resumeVerifyResult = 'ok';
			resumeVerifyFailCount = 0;
			cancelResumeVerifyRetry();
			// T112（S1）：撤销探活判定本身会改变 isConnectionDown()（而 wsWatchDown() 可能
			// 一直没变）⇒ 这次相变不会从"翻转"通道出去，这里补一次上桥（去抖键变了才真推）。
			try { reportUiDiag(); } catch (ignoredWsOpenDiag) { /* 上报失败不影响判据 */ }
		} else if (rec.opened) {
			if (s.openNow > 0) s.openNow -= 1;
			if (s.openNow === 0) { s.closeAt = Date.now(); s.closeSeen = true; }
		} else {
			// 从来没 OPEN 过的 socket 关了：它**从来不是活口** ⇒ 绝不动 openNow（改前会把它
			// 减成 0 ⇒ 健康链路上一次无关的失败尝试就误报断开，S10）。
			s.closeSeen = true;
			if (s.pendingSince === 0) s.pendingSince = Date.now();
		}
		if (!opened) {
			// T112b：把 CloseEvent 的三个**事实**字段记下来（改前只记 `lastEvent='close'`）。
			// 为什么是这三个：`code`/`reason`/`wasClean` 是浏览器给出的唯一"这次关闭是谁干的、
			// 干净不干净"的权威信息 —— 1006（异常关闭，`wasClean=false`）与正常关闭（1000/1001）
			// 正是"隧道/网络抖动"与"对端正常收缩"的分水岭。**纯记账**：
			// 不参与任何判据、不排定时器、不碰 DOM、不新增监听器（用的就是既有的这条 close 监听）。
			var code = 0, reason = '', wasClean = null;
			try {
				if (ev) {
					if (typeof ev.code === 'number') code = ev.code;
					if (typeof ev.reason === 'string') reason = ev.reason.slice(0, 80);
					if (typeof ev.wasClean === 'boolean') wasClean = ev.wasClean;
				}
			} catch (ignoredCloseDetail) { /* 取不到就保持 0/''/null，绝不抛 */ }
			s.lastCloseCode = code;
			s.lastCloseReason = reason;
			s.lastCloseClean = wasClean;
			s.lastCloseAt = Date.now();
			s.lastCloseOpened = !!rec.opened;     // 这次关的是"曾 OPEN 过"的还是"从没连上"的
			s.lastCloseUrl = String(rec.url || '').slice(0, 200);
			if (wasClean === false || code === 1006) s.closeAbnormalCount += 1;
			else if (code > 0) s.closeCleanCount += 1;
		}
		s.eventCount += 1;
		s.lastEvent = opened ? 'open' : 'close';
		s.lastEventAt = Date.now();
	}

	/** 包一条 socket：只挂监听。 */
	function wsWatchSocket(socket) {
		var s = wsWatchState;
		if (!s || !socket) return;
		var url = '';
		try { url = String(socket.url || ''); } catch (ignoredWsWatchUrl) {}
		s.lastUrl = url.slice(0, 200);
		// 每条 socket 一份自己的记录：**是否 OPEN 过** + 是否同类（S10）+ 自己的 URL（T112b 记账用）。
		var rec = { opened: false, bystander: !wsWatchSameOrigin(url), url: url.slice(0, 200) };
		if (rec.bystander) {
			s.bystanders += 1;
			s.lastBystanderUrl = url.slice(0, 200);
			return;
		}
		s.sockets += 1;
		// T116（P0·重叠交接）：新 socket 在老 socket 还没关时就建出来是常态
		// （页面主动重建），此时 openNow>0。改前只在 openNow===0 时记 pending，
		// 于是这条新链没有宽限 —— 老链一关、1.5s 后即报断（即使新链还在正常握手）。
		// 改后同类新链一律记 pending（open 分支会清零，健康稳态零影响）。
		if (s.pendingSince === 0) s.pendingSince = Date.now();
		wsWatchRecheck();
		try {
			socket.addEventListener('open', function () { wsWatchEvent(rec, true); wsWatchRecheck(); wsWatchNotifyEdge(); });
			// T112b：把 CloseEvent 本体透传给记账（用的就是这条既有监听器，不新增监听器数量）。
			socket.addEventListener('close', function (ev) { wsWatchEvent(rec, false, ev); wsWatchRecheck(); wsWatchNotifyEdge(); });
			// error 不单独判"断"：Chromium 里失败路径必然紧跟 close，重复计数会让
			// openNow/closeSeen 失衡（T90 实测：只认 open/close，真机 45s 断线窗口内
			// 事件序列恒为 close→(重连)→open）。
			socket.addEventListener('error', function () { s.errors += 1; });
		} catch (ignoredWsWatchListen) {
			try { socket.onclose = function (ev) { wsWatchEvent(rec, false, ev); wsWatchRecheck(); wsWatchNotifyEdge(); }; } catch (ignoredWsWatchOnClose) {}
		}
	}

	/**
	 * T90：安装观测（幂等）。**极其保守**：任何一步不如预期都原样退出、不安装。
	 * @returns true 表示 `window.WebSocket` 现在确实是本脚本的透传包装器
	 */
	function installWsStateWatch() {
		if (wsWatchState && wsWatchState.installed) return true;
		// 平板档（hook 严格 OFF）：连构造器都不换 —— 零痕迹是硬契约，不只是"不写 DOM"。
		if (wsWatchInjectedTablet()) return false;
		var nativeCtor = null;
		try { nativeCtor = window.WebSocket; } catch (ignoredWsWatchCtor) { nativeCtor = null; }
		if (typeof nativeCtor !== 'function') return false;
		// 已经被本脚本包装过（pending 重启后的第二次进来 / 同一文档里的重复注入）：
		// **认领同一个状态对象**而不是叠第二层包装。这一步不能省：重启是一次新的
		// 函数调用、closure 变量全新，不认领的话后面所有判据都会读到自己那个 null。
		try {
			var adopted = WS_WATCH_MARK ? nativeCtor[WS_WATCH_MARK] : nativeCtor.__dshrWsWatchState;
			if (adopted) { wsWatchState = adopted; return true; }
		} catch (ignoredWsWatchMark) {}

		var state = {
			installed: false,
			reason: '',
			native: nativeCtor,
			wrapped: null,
			openNow: 0,
			closeSeen: false,
			connectSince: 0,
			// T112 新增（旧字段名保留：closeSeen / connectSince 继续作为只读自检的等价别名）：
			//   closeAt       —— 最近的"已 OPEN 的同类 socket 关了且无活口"的时刻（0 = 无）
			//   pendingSince  —— 最早的"已构造但尚未 OPEN"的同类 socket 的时刻（0 = 无）
			//   bystanders    —— 被**排除在判据之外**的非同源 socket 数（S10，只旁观）
			closeAt: 0,
			pendingSince: 0,
			bystanders: 0,
			lastBystanderUrl: '',
			recheckTimer: 0,
			recheckDue: 0,
			sockets: 0,
			errors: 0,
			eventCount: 0,
			lastEvent: '',
			lastEventAt: 0,
			lastUrl: '',
			// T112b：最近一次 close 的事实字段 + 干净/异常关闭计数（纯只读证据）。
			lastCloseCode: 0,
			lastCloseReason: '',
			lastCloseClean: null,
			lastCloseAt: 0,
			lastCloseOpened: false,
			lastCloseUrl: '',
			closeCleanCount: 0,
			closeAbnormalCount: 0,
			lastDown: false,
			notify: null,
		};

		var Wrapped = function (url, protocols) {
			// 不带 new 调用：与浏览器**逐字相同**的 TypeError（语义透传的一部分）。
			if (typeof new.target !== 'function') {
				throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator, "
					+ "this DOM object constructor cannot be called as a function.");
			}
			var args = Array.prototype.slice.call(arguments);
			var socket = Reflect.construct(nativeCtor, args, new.target);
			try { wsWatchSocket(socket); } catch (ignoredWsWatchWrap) { /* 观测失败绝不牵连 socket */ }
			return socket;
		};
		// 原型：**同一个对象**（不是复制）⇒ `sock instanceof WebSocket`、
		// `WebSocket.prototype.send.call(sock)` 等语义与原生逐字一致。
		Wrapped.prototype = nativeCtor.prototype;
		// 静态量/自有属性整份透传（CONNECTING/OPEN/CLOSING/CLOSED、name、length…）。
		var names = [];
		try { names = Object.getOwnPropertyNames(nativeCtor); } catch (ignoredWsWatchNames) { names = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']; }
		for (var i = 0; i < names.length; i++) {
			var key = names[i];
			if (key === 'prototype') continue;
			try {
				Object.defineProperty(Wrapped, key, Object.getOwnPropertyDescriptor(nativeCtor, key));
			} catch (ignoredWsWatchProp) { /* 个别属性不可复制不影响构造透传 */ }
		}
		// 认领标记（符号优先，见 WS_WATCH_MARK 的说明）：重启后第二次进来靠它
		// 取回同一个状态对象，而不是叠第二层包装。
		try {
			if (WS_WATCH_MARK) Object.defineProperty(Wrapped, WS_WATCH_MARK, { value: state });
			else Object.defineProperty(Wrapped, '__dshrWsWatchState', { value: state });
		} catch (ignoredWsWatchStateMark) {}

		state.wrapped = Wrapped;
		wsWatchState = state;
		try {
			window.WebSocket = Wrapped;
		} catch (ignoredWsWatchAssign) { /* 下面统一判定 */ }
		if (window.WebSocket !== Wrapped) {
			// 赋不上（属性被冻结/被别的脚本锁住）⇒ **不假装成功**：如实记账，判据恒 false。
			state.installed = false;
			state.reason = 'assign-failed';
			wsWatchState = null;
			return false;
		}
		state.installed = true;
		state.reason = 'installed';
		// 只读自检入口（测试/排查/真机证据用）。它**只读**：没有任何写页面、写 DOM、
		// 发请求的方法；业务判据不经过它（判据是 isConnectionDown/wsWatchDown）。
		state.down = wsWatchDown;
		state.stats = function () {
			return {
				installed: state.installed, reason: state.reason,
				sockets: state.sockets, errors: state.errors, openNow: state.openNow,
				closeSeen: state.closeAt > 0, connectSince: state.pendingSince,
				events: state.eventCount, lastEvent: state.lastEvent, lastEventAt: state.lastEventAt,
				url: state.lastUrl, down: state.down(),
				// T112 新增只读字段（判据真值 + 反证用）：
				closeAt: state.closeAt, closeGraceMs: WS_CLOSE_GRACE_MS,
				pendingSince: state.pendingSince, connectGraceMs: WS_CONNECT_GRACE_MS,
				bystanders: state.bystanders, lastBystanderUrl: state.lastBystanderUrl,
				recheckArmed: state.recheckTimer !== 0,
				// T112b 新增只读字段：最近一次 close 的三个事实字段 + 干净/异常计数。
				lastCloseCode: state.lastCloseCode, lastCloseReason: state.lastCloseReason,
				lastCloseClean: state.lastCloseClean, lastCloseAt: state.lastCloseAt,
				lastCloseOpened: state.lastCloseOpened, lastCloseUrl: state.lastCloseUrl,
				closeClean: state.closeCleanCount, closeAbnormal: state.closeAbnormalCount,
			};
		};
		try { window[WS_WATCH_KEY] = state; } catch (ignoredWsWatchGlobal) { /* 自检入口写不上不影响观测 */ }
		return true;
	}

	/**
	 * T90：还原（平板档 / hook 关闭态）。把 `window.WebSocket` 换回原生构造器，
	 * 并删掉自检全局 —— 这两件是"严格 OFF 零痕迹"在 window 层面的全部内容。
	 */
	function uninstallWsStateWatch() {
		var s = wsWatchState;
		if (!s) return false;
		try { if (window.WebSocket === s.wrapped) window.WebSocket = s.native; } catch (ignoredWsRestore) {}
		try { delete window[WS_WATCH_KEY]; } catch (ignoredWsDelete) { try { window[WS_WATCH_KEY] = undefined; } catch (ignoredWsDelete2) {} }
		s.installed = false;
		s.reason = 'uninstalled';
		s.notify = null;
		wsWatchCancelRecheck();
		return true;
	}

	/**
	 * T90：按 hook 启用态同步观测（`applyWidthScope` 唯一的调用点）。
	 * 关闭态（含平板严格 OFF）⇒ 还原；启用态 ⇒ 安装（幂等）。
	 */
	function syncWsStateWatch(enabled) {
		if (enabled) {
			try { installWsStateWatch(); } catch (ignoredWsSyncInstall) { /* 失败即不安装，判据恒 false */ }
			return;
		}
		uninstallWsStateWatch();
	}

	/**
	 * T90：登记"连接态翻转"的唯一回调（接进既有上报/自愈入口，见文件末尾的注册点）。
	 * 只登记一次就够了：状态对象的生存期跨越 pending 重启（第二次进来是**认领**同一个对象）。
	 */
	function wsWatchSetNotify(fn) {
		if (!wsWatchState) return false;
		wsWatchState.notify = fn;
		return true;
	}

	// ── T112：宽限到期的一次性截止定时器（**不是轮询**）──────────────────────────────
	//
	// 为什么需要它：判据从"close 后 0ms 就算断"改成"宽限期满才算断"之后，"变真"这件事
	// 不再由事件触发，而是由**时间**触发。没有它，一次真实的 close 会永远停在"宽限中"，
	// 原生与自救层都看不到断线。所以这里排一个一次性定时器，到点重算一次判据并通知。
	//
	// 成本边界（可证明极小）：
	//   · 只在"有 close 且无活口"或"有 socket 尚未 open"时武装；一条 socket **open** 就
	//     立刻撤销 ⇒ **健康稳态零定时器**（与 T90/T82 的"健康零开销"契约一致，真值见 report §6）；
	//   · 到点后重算：仍未到判"断"条件（宽限内又来了新 socket）就顺延，不空转；
	//   · 定义在观测块**之外**（观测块"只能被动监听、不引入定时器"的既有契约（见
	//     `scripts/test-mobile-chrome.mjs` 的 T90 段）不破）：块内只**调用**它，不定义它。
	function wsWatchCancelRecheck() {
		var s = wsWatchState;
		if (!s || !s.recheckTimer) return;
		try { window.clearTimeout(s.recheckTimer); } catch (ignoredRecheckClear) {}
		s.recheckTimer = 0;
		s.recheckDue = 0;
	}

	/** 按当前状态算出"下一次判据可能翻转"的截止点并武装/更新一次性定时器。 */
	function wsWatchRecheck() {
		var s = wsWatchState;
		if (!s || !s.installed || s.openNow > 0 || (!s.closeAt && !s.pendingSince)) {
			wsWatchCancelRecheck();
			return;
		}
		var due = 0;
		if (s.closeAt > 0) due = s.closeAt + WS_CLOSE_GRACE_MS;
		if (s.pendingSince > 0) {
			var cd = s.pendingSince + WS_CONNECT_GRACE_MS;
			if (!due || cd < due) due = cd;
		}
		if (!due) { wsWatchCancelRecheck(); return; }
		if (s.recheckTimer && s.recheckDue === due) return;   // 同一个截止点，不重排
		wsWatchCancelRecheck();
		s.recheckDue = due;
		s.recheckTimer = window.setTimeout(function () {
			var st = wsWatchState;
			if (!st) return;
			st.recheckTimer = 0;
			st.recheckDue = 0;
			wsWatchNotifyEdge();
			wsWatchRecheck();      // 仍未到判"断"条件（宽限内又来了新 socket）⇒ 顺延
		}, Math.max(20, due - Date.now() + 20));
	}

	// ── T31-3 / T38-2：切后台 / 锁屏回来时，若连接**确实**断了就立刻恢复 ──
	//
	// 问题：MainActivity.onResume 只恢复定时器、不重连；DSH 客户端的重连退避是
	// setTimeout 驱动的（client.js 退避 500ms→10s 封顶），一旦 onPause 的
	// pauseTimers 真的冻住了计时器，回前台就得先干等剩余退避。
	//
	// 为什么选「页面侧 visibilitychange + 派发 online 事件」而不是原生 reload：
	//   1. 不动原生，不碰 resumeLiveSession 契约，不会整页重载丢会话/输入；
	//   2. DSH 客户端本就监听 window 的 online/offline 来触发 setNetworkAvailable，
	//      派发 online 等于「清零退避 + 立即重连」，是它自己提供的幂等入口；
	//   3. 纯 JS，桌面浏览器打开同一页面也能受益（不限于 App）。
	//
	// 触发时机（不变）：
	//   - 只有 document.visibilityState 变成 visible 才看；
	//   - 延后 RESUME_PROBE_DELAY_MS 再判：回前台瞬间 DOM 可能还没恢复。
	//
	// T38-2 收口：把 T31 的「裸 reconnect 扫全页 innerText」换成结构化判据。
	// 判据本体在 findReconnectStatusElement()（见 IIFE 顶部，此处不重复）：
	// **层 1**（T88）= 官方 `<button data-phase="connecting">`（定向例外，不受"排除可交互控件"限制），
	// **层 2**（T38-2）= 非交互元素的整串文案锚定。这里再加四道防重连风暴的闸：
	//   1. **二次确认**：单次观测只上闩不动作，延后 RESUME_CONFIRM_DELAY_MS 再确认一次，
	//      两次都为真才推 ⇒ 闪一下的状态文案、一次性巧合都活不过这一关；
	//   2. **武装位**：T82 起语义修正为「距上次推送已过最小间隔、且仍处于断开态」才重武装
	//      （改前是"必须先观测到恢复"，复位点却只在健康分支 ⇒ 一次断开只推 1 次，
	//      间隔/上限两道闸全是死代码，见 probeResumeRecovery 里的说明）；
	//   3. **最小间隔**：RESUME_MIN_INTERVAL_MS 内不重复推；
	//   4. **硬上限**：单页面生命周期最多 RESUME_MAX_NUDGES 次。
	//
	// T82 触发时机扩展：除既有的回前台（visibilitychange/pageshow）外，新增
	// **断开持续态 1s 巡检**（ensureResumeDownTick）——这是修「断着不自愈」的关键。
	//
	// ⚠️ 2026-10-05 实测更正（原始真值 scratch/t87/report.md §1、scratch/t90/report.md
	//    §12.3）：早先这里写的「上游退避梯子跑完（attempt≥6）会**永久停泊**」**已被证否**。
	//    本机可达的两个 DSH 运行时（npm `@deepseek-ai/dsh@0.2.0-rc.2` 真正下发给浏览器的
	//    bundle、桌面 `app.asar` 的全量字节扫描）里 `isFinalBackoffTier` 出现 **0 次**：
	//    `attempt` 无上限、`backoffCap(attempt)=min(backoffMaxMs, base*factor^(attempt-1))`，
	//    单跳等待上限 **10s**（半开区间 [cap/2, cap)，即 5–10s 随机），**不存在"梯子跑完"这一档**，
	//    因此也没有"跑完就永久停泊"可以被解除。任务书里的"等 30 秒"是**多次退避叠加 + 服务端
	//    一直没恢复**累积出来的观感，不是某一档的固定等待。
	// 没有停泊机制，这条巡检为什么还留：真实断线里页面可能正睡在某一跳退避上、而服务端早就
	// 回来了，巡检的价值就是把这段空窗压到 <1s（实测 5496ms → 681ms，scratch/t90/report.md §4.4）。
	// 定时器只在观测到断开时装上、恢复/到顶即卸 ⇒ 健康时零开销。
	//
	// 会话/草稿安全：动作只有 requestUpstreamReconnect()（上游 reconnect()，或
	// offline→online 瞬态对）。不 reload、不碰 document.cookie、不导航 ⇒
	// 会话与未发送的草稿都不受影响。**禁止 Page.reload**。
	// （常量与计数器声明在 IIFE 顶部，见 lastUiDiagKey 附近。）

	/**
	 * T82：找到上游 connection 服务句柄（如果页面侧够得到的话）。
	 *
	 * 上游 `dsh-client-connection` 的 `installConnection()` 产出一个 handle，
	 * 上面的 `reconnect()` 走 `owner.controller.reconnect()`（lib/client.js:1424），
	 * 效果是把 `attempt` 归零并要求**立即**重连 —— 这是最理想的一级。
	 *
	 * 但 handle 只经 `ctx.provide("connection", handle)` 暴露给 **Cordis 插件树**，
	 * 而本 hook 是壳 App 注入的普通脚本。2026-10-05 在真实 DSH 0.2.0-rc.2 页面上实测
	 * （scratch/t82/report.md §C、scratch/t82/live-reconnect-probe.json）：
	 *   · window 上只有 `__ModuleLoader__`（mode:"live"，自有键仅 mode/pendingQueue/load/create，
	 *     **没有** loader/ctx/env）与数据类 `__DSH_*` 全局；
	 *   · 全部 DSH 相关全局里没有任何对象带 `reconnect`；
	 *   · React fiber 树遍历 533 个 fiber，没有任何 Cordis Context。
	 *   ⇒ 纯注入脚本拿不到它。这一级因此**今天恒为 null**，保留它是为了宿主将来
	 *     把服务暴露出来时能自动升到最优实现（探到就用，行为只变好不变坏）。
	 */
	function findUpstreamConnectionHandle() {
		var candidate = null;
		try { candidate = typeof window !== 'undefined' ? window.__DSH_CONNECTION__ : null; } catch (ignoredConn) { candidate = null; }
		if (!candidate || typeof candidate.reconnect !== 'function') return null;
		// 结构判据（与 lib/client.js:1403-1476 的 handle 形状逐条对应）：
		// 只认真正那个 handle，避免误调同名方法。
		if (!candidate.state || typeof candidate.state.getSnapshot !== 'function') return null;
		if (!candidate.generation || typeof candidate.generation.getSnapshot !== 'function') return null;
		if (!candidate.rpc) return null;
		return candidate;
	}

	/**
	 * T82：请求上游重连。分层入口，返回实际用了哪一层（写进诊断）。
	 *
	 * 第 1 层：上游 `connection.reconnect()` —— 0ms 立即生效（对照组实测）。
	 * 第 2 层：`offline` → `online` 瞬态对 —— **当前真正生效的那一层**。
	 *
	 * 为什么第 2 层不是"派发 online"那种空操作（这是本轮修的核心）：
	 * 上游 `watchBrowserNetwork()`（lib/client.js:1342-1359）只把浏览器的
	 * online/offline 转成 `controller.setNetworkAvailable(bool)`，而它是：
	 *     setNetworkAvailable(available) {
	 *       if (this.networkAvailable === available) return;   // ← 幂等短路
	 *       this.networkAvailable = available;
	 *       this.attempt = 0;                                  // ← 退避进度清零，回最陡的一跳
	 *       this.immediateRetry = false;
	 *       ...
	 *       this.current?.abort(NETWORK_STATE_CHANGED);
	 *       this.retryDelay?.abort(NETWORK_STATE_CHANGED);     // ← 把正在睡的退避当场掐断
	 *     }
	 * 页面健康时 `networkAvailable` 本来就是 true，所以单独派发 `online` 命中的是
	 * **第一行的短路**（父任务实测重试数 6→6，确认是空操作）。
	 * 而 `offline` → `online` 是一次真实的 `true→false→true` 翻转，两行短路都不成立：
	 *   · `attempt = 0` ⇒ 退避进度清零，回到最陡的一跳 ⇒ 下一次尝试立刻就走；
	 *     **不是**"解除永久停泊"——本机运行时没有 `isFinalBackoffTier`、`attempt` 无上限、
	 *     单跳上限 10s（5–10s 随机），该机制已被证否，见上方 T82 段的实测更正；
	 *   · `current/retryDelay.abort()` ⇒ 正在睡的那个退避**立刻**被掐断，不再干等。
	 * 两者合起来对用户可见的结论与 `reconnect()` 同级：不再干等当前这一跳退避
	 * （"等 30 秒"是多次退避 + 服务端一直没恢复的累积，不是某一档的固定等待）。
	 * 差别只在"起步晚一个 backoffDelay(1)"（宿主默认 backoffBaseMs=500 ⇒ 250–500ms）。
	 *
	 * 会话/草稿安全：不 reload、不碰 cookie、不导航 ⇒ 会话与未发送的草稿不受影响。
	 * 禁止 Page.reload。
	 *
	 * ── T112b：按"判据来源"分流（这是 T110 给出的最小修法）────────────────────────
	 * T110 的原始真值（`scratch/t110/report.md` §8.4 ①，链路**始终健康**、只做一次前后台切换）：
	 *   rc.2.5/rc.2.6（动作只有 `online`）⇒ 派发 `offline` **0** 次、**真掐断 0 次**；
	 *   rc.2.7/rc.2.8（动作是 `offline`→`online`）⇒ 派发 `offline` **6** 次、**真掐断 6 次**。
	 * ⇒ 差别只在动作：`offline` 那一下会让上游 `setNetworkAvailable(false)` 真的
	 *   `current.abort(NETWORK_STATE_CHANGED)`。**一次误报 = 一次用户可见掉线**。
	 *
	 * 分流规则（唯一一条）：**只有 `wsSrc === 3`（WS 观测到真 close）才允许派 `offline`**；
	 * 来源是 DOM 文案（1/2）或探活（4）时**一律退回 `online`-only** —— 那条路是幂等短路
	 * （健康时 `networkAvailable` 本来就是 true ⇒ `setNetworkAvailable(true)` 第一行 return），
	 * 所以**一定无害**，同时仍然保留"若真有睡着的退避，`online` 也能让客户端重算网络态"的兜底。
	 *
	 * 为什么这条能修 T110 那两个 arm（判据为真但链路健康）：
	 *   · S4（注入可见非交互"重新连接中" + 一次前后台切换）的来源是 **2（DOM 文案）** ⇒ online-only；
	 *   · S2（`/health` 首字节 4.5s 超时）的来源是 **4（探活）** ⇒ online-only。
	 * ⚠️ 代价（明说）：来源 4 的**真半开**因此在 hook 这一层不再"掐断重建"，只推 `online`；
	 *   半开的重建改由原生自救层（`StuckRescue` 的受控重载）与"两次失败才判死 + 20s 信任期"
	 *   之后的真实 close 兜住；探活结论照旧喂给诊断与原生（真值见 report §3）。
	 */
	function requestUpstreamReconnect() {
		var handle = findUpstreamConnectionHandle();
		if (handle) {
			try {
				handle.reconnect();
				return 'connection-reconnect';
			} catch (ignoredReconnect) { /* 落到下一层 */ }
		}
		// T112b 分流闸：非"WS 观测到真 close"的来源一律只用 `online`（幂等短路 = 无害）。
		var src = connectionDownSource();
		if (src !== 3) {
			// 只推 online：上游 `setNetworkAvailable(true)` 第一行幂等短路 ⇒ **不掐断任何 socket**。
			window.dispatchEvent(new Event('online'));
			return 'network-transition-online-only';
		}
		// 瞬态对必须**同任务**内完成：中间不插入 await/setTimeout，
		// 免得用户看到（或被其它逻辑观测到）一个假的"离线"中间态。
		window.dispatchEvent(new Event('offline'));
		window.dispatchEvent(new Event('online'));
		return 'network-transition';
	}

	function stopResumeDownTick() {
		if (!resumeDownTick) return;
		window.clearInterval(resumeDownTick);
		resumeDownTick = 0;
	}

	/**
	 * T82：断开持续态巡检。装上之后每 RESUME_DOWN_TICK_MS 探一次；
	 * 一旦恢复（或到达上限）立刻卸掉 —— 健康时**零开销**（没有定时器）。
	 *
	 * T112（S1）：这一拍顺便把"当前连接态"**按电平重推**给原生（`reportUiDiagLevel`），
	 * 因为原生那份是电平闩锁、没有周期刷新时一次假判会被钉死（见 reportUiDiagLevel 的说明）。
	 * 定时器仍然只存在于断开期间；恢复的那一拍推一次**真实态**（去抖键变了 ⇒ 必推）再卸表。
	 */
	function ensureResumeDownTick() {
		if (resumeDownTick) return;
		resumeDownTick = window.setInterval(function () {
			if (document.visibilityState !== 'visible') return;
			var stillDown = false;
			try { stillDown = isConnectionDown(); } catch (ignoredTickDown) { stillDown = false; }
			if (stillDown) {
				try { reportUiDiagLevel(); } catch (ignoredTickLevel) { /* 上报失败不影响自愈 */ }
				probeResumeRecovery();
				return;
			}
			// 恢复：先如实推一次（wsState 已变 ⇒ 判重键不同 ⇒ 一定过桥），再走既有入口卸表。
			try { reportUiDiag(); } catch (ignoredTickUp) { /* 上报失败不影响自愈 */ }
			probeResumeRecovery();
		}, RESUME_DOWN_TICK_MS);
	}

	function resumeRecoveryState() {
		// T88：判据一次算完，顺便报出是哪一层认出来的（1 = 官方按钮 / 2 = 老文案路径 / 0 = 健康）。
		// 真机自证要用它："页面里到底跑的是新判据还是旧 APK 里的旧 hook" 靠这个字段分辨。
		// T90：`reconnecting` 升级为**两端合并**判据（DOM 文案 OR WS 观测），
		// `reconnectSrc` 语义不变（DOM 层），新增 `wsSrc` 报出合并后的来源：
		//   1 = 官方按钮 / 2 = 文案 / **3 = 只有 WS 观测命中（rail 下的唯一信号）** / 0 = 健康。
		// `ws*` 四个字段是 WS 观测的只读快照（真机证据用，业务判据不读它们）。
		var detail = findReconnectStatusDetail();
		var wsDown = false;
		var ws = wsWatchState;
		try { wsDown = wsWatchDown(); } catch (ignoredWsStateDown) { wsDown = false; }
		// T116：与 isConnectionDown() 同口径 —— trust 在有活口时不计（见上）。
		// 这里不能直接调 isConnectionDown()（那会重算 DOM，两次 DOM 求值可能不一致），
		// 所以把同一段门控 inline 一份。
		var trustDown = false;
		try {
			if (resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS) {
				trustDown = !(ws && ws.installed && ws.openNow > 0);
			}
		} catch (ignoredStateTrust) { trustDown = false; }
		return {
			installed: true,
			nudges: resumeNudgeCount,
			lastNudgeAt: resumeLastNudgeAt,
			lastProbeAt: resumeLastProbeAt,
			lastProbe: resumeLastProbeResult,
			lastDisconnectAt: lastDisconnectAt,
			// T95：与 isConnectionDown() **同口径**（补上"探活判定传输层已死"这一路）。
			// 改前只写 `detail.el !== null || wsDown` ⇒ 半开场景下 collectUiDiag().wsState 说
			// "reconnecting"（横幅出来了）而这里说 false，两边自相矛盾（我在装置上实测到，
			// 见 scratch/t95/logs/resume-fix-after.log）。判据只能有一个。
			// T116：trustDown 已含“有活口则忽略”门控（见上），与 isConnectionDown() 同口径。
			reconnecting: detail.el !== null || wsDown || trustDown,
			reconnectSrc: detail.src,
			// wsSrc 语义不变（DOM 层优先，其次 WS 观测，再次探活）+ 语义仍为"哪一层认出来的"：
			//   1 = 官方按钮 / 2 = 文案 / 3 = WS 观测 / **4 = 只有回前台探活命中** / 0 = 健康。
			// T112b：改由 connectionDownSource() 统一算（**同一个**取值也被 nudge 的动作分流读，
			// 两处必须是同一口径 ⇒ 抽成一个函数，见那里的说明）。
			wsSrc: connectionDownSource(),
			wsSeen: !!(ws && ws.installed),
			wsDown: wsDown,
			wsEvents: ws ? ws.eventCount : 0,
			wsLastEvent: ws ? ws.lastEvent : '',
			// T112b：最近一次 **同类 socket 的 close** 的三个事实字段（改前只记 lastEvent='close'，
			// 丢掉了一半信息）。这是把"隧道抖动"（1006/未干净关闭）与"对端正常收缩"
			// 分开的唯一钥匙；纯只读，不参与任何判据/定时器/nudge。
			lastCloseCode: ws ? ws.lastCloseCode : 0,
			lastCloseReason: ws ? ws.lastCloseReason : '',
			lastCloseClean: ws ? ws.lastCloseClean : null,
			lastCloseAt: ws ? ws.lastCloseAt : 0,
			closeClean: ws ? ws.closeCleanCount : 0,
			closeAbnormal: ws ? ws.closeAbnormalCount : 0,
			downSince: resumeDownSince,
			armed: resumeNudgeArmed,
			maxNudges: RESUME_MAX_NUDGES,
			minIntervalMs: RESUME_MIN_INTERVAL_MS,
			confirmDelayMs: RESUME_CONFIRM_DELAY_MS,
			ticking: resumeDownTick !== 0,
			nudgeEntry: resumeLastNudgeResult,
			vis: document.visibilityState,
			// T95：回前台主动探活的只读快照（业务判据读 isConnectionDown()，这里只为证据/排查）。
			verifyDown: resumeVerifyDownAt > 0 && Date.now() - resumeVerifyDownAt <= RESUME_VERIFY_TRUST_MS,
			verifyResult: resumeVerifyResult,
			verifyAt: resumeVerifyAt,
			// T112 只读证据：连续失败计数 / 探活请求总数 / 按电平重推次数（健康稳态恒 0）。
			verifyFails: resumeVerifyFailCount,
			verifyProbes: resumeVerifyProbeCount,
			verifyRetryArmed: resumeVerifyRetryTimer !== 0,
			levelPushes: uiDiagLevelPushes,
			hiddenSince: resumeHiddenSince,
			bypassUntil: resumeBypassUntil,
		};
	}

	/**
	 * T95：回前台**主动探活** —— 用一次同源、绕缓存的 GET 判断"传输层还通不通"。
	 *
	 * 为什么要它：`wsWatchDown()` 只看 `open`/`close` 事件；**半开**（对端已死但 TCP 没发 FIN、
	 * Chromium 也收不到 close）时它恒判健康，页面就把"表面连着、实际已死"当正常，
	 * 一次 nudge 都不推、原生自救层也看不到真相（真值：`scratch/t95/report.md §1.8`：
	 * 健康空闲期 mux 75s 内零帧 ⇒ 不能用"静默"当半开判据，只能主动发一次探活）。
	 *
	 * 探针选型的依据：
	 *   · 打 `/__dsh_remote__/health`（网关**本地**端点，不依赖上游 DSH）⇒ 探的是"隧道/垫片
	 *     这条传输链路"，而不是"上游 DSH 会话状态"，语义与"连接能不能重连"一致；
	 *   · `cache:'no-store'` + 唯一 query ⇒ 绕开 App 自带 SW 的磁盘缓存，免得命中缓存得到假"活"；
	 *   · 3s 硬超时（AbortController）：断链上请求会挂住，超时即判"传输层已死"。
	 *
	 * 成本边界：**只**在"回前台 + 后台待够 RESUME_VERIFY_MIN_HIDDEN_MS"时调用一次
	 * （调用点见 probeResumeRecovery 的 fromResume 分支）⇒ 健康前台零请求、无定时器。
	 * 判定为死时会立刻走断开分支（推一次 nudge 逼客户端新建 socket = 修半开），
	 * 并把真相经既有 `reportUiDiag()` 通道喂给原生自救层。
	 */
	/** T112：撤销排程中的"确认探"（新 socket 真开了 / hook 关闭时调用，不留尾巴）。 */
	function cancelResumeVerifyRetry() {
		if (!resumeVerifyRetryTimer) return false;
		try { window.clearTimeout(resumeVerifyRetryTimer); } catch (ignoredVerifyRetryClear) {}
		resumeVerifyRetryTimer = 0;
		return true;
	}

	function verifyResumeTransport() {
		if (resumeVerifyRunning) return false;
		resumeVerifyRunning = true;
		resumeVerifyAt = Date.now();
		resumeVerifyProbeCount += 1;
		var settled = false;
		// 第一次探活（failCount === 0）用 RESUME_VERIFY_TIMEOUT_MS；确认探（已有失败记录）
		// 用更宽容的 RESUME_VERIFY_CONFIRM_TIMEOUT_MS。
		var timeoutMs = resumeVerifyFailCount > 0 ? RESUME_VERIFY_CONFIRM_TIMEOUT_MS : RESUME_VERIFY_TIMEOUT_MS;
		var finish = function (alive, why) {
			if (settled) return;
			settled = true;
			resumeVerifyRunning = false;
			resumeVerifyResult = why;
			if (alive) {
				// 活 ⇒ 撤销一切（含此前那次失败的记账）：一次失败不是证据。
				resumeVerifyDownAt = 0;
				resumeVerifyFailCount = 0;
				resumeVerifyFailAt = 0;
				return;
			}
			// T112（S2）：单次失败**不判死**、不写信任闩锁、**不推 nudge**。
			resumeVerifyFailCount += 1;
			resumeVerifyFailAt = Date.now();
			if (resumeVerifyFailCount < RESUME_VERIFY_CONFIRM_FAILS) {
				resumeVerifyResult = why + '-1';
				// 排一次确认探：间隔沿用既有的 400ms 二次确认语义（同任务不插 await）。
				cancelResumeVerifyRetry();
				resumeVerifyRetryTimer = window.setTimeout(function () {
					resumeVerifyRetryTimer = 0;
					try { verifyResumeTransport(); } catch (ignoredVerifyRetry) { /* 失败即当没探过 */ }
				}, RESUME_VERIFY_CONFIRM_DELAY_MS);
				return;
			}
			// 连续两次独立失败 ⇒ **确认判死**：只有到这里才写信任闩锁、才推 nudge。
			resumeVerifyDownAt = Date.now();
			// 判定为死 = 刚知道断开 ⇒ 重开 5s 窗口，让紧跟的这一推也不被 8s 间隔压住。
			resumeBypassUntil = Date.now() + RESUME_BYPASS_WINDOW_MS;
			try { reportUiDiag(); } catch (ignoredVerifyDiag) { /* 上报失败不影响判据 */ }
			// 立刻按"断开"走一遍既有入口：二次确认 → 推 nudge（掐断睡着的退避 + 新建 socket）。
			try { probeResumeRecovery(); } catch (ignoredVerifyProbe) { /* 探活失败不影响判据 */ }
		};
		try {
			var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
			var timer = window.setTimeout(function () {
				try { if (ctl) ctl.abort(); } catch (ignoredVerifyAbort) { /* abort 失败也要落地结论 */ }
				finish(false, 'timeout');
			}, timeoutMs);
			var url = location.origin + '/__dsh_remote__/health?__dshr_probe=' + String(Date.now());
			window.fetch(url, {
				method: 'GET',
				cache: 'no-store',
				credentials: 'same-origin',
				signal: ctl ? ctl.signal : undefined,
			}).then(function () {
				window.clearTimeout(timer);
				finish(true, 'ok');
			}, function () {
				window.clearTimeout(timer);
				finish(false, 'error');
			});
		} catch (ignoredVerifyFetch) {
			finish(false, 'error');
		}
		return true;
	}

	/**
	 * 探测并（必要时）推一把。返回是否真的推了。测试与原生都可直接调。
	 *
	 * 健康 ⇒ 立刻返回 false，是本函数的第一件事（"不误触发"的结构性保证）。
	 *
	 * @param 无 —— T95 用意图位 `resumeFromResumeIntent` 区分"回前台进来的那一拍"
	 *   （visibilitychange / pageshow 先置位再调用），原因是 `scripts/test-resume-recovery.mjs`
	 *   逐字匹配 `function probeResumeRecovery()`，加形参会让那条既有契约变红。
	 *   为真时做两件**只对回前台**的事：①后台待够久就主动探活一次（半开被判出来）；
	 *   ②开一个 5s 自到期窗口，让这一趟的首次推不受 RESUME_MIN_INTERVAL_MS 约束
	 *   （离开前刚推过时，否则首次推最多干等 8s）。健康态开销仍为零。
	 */
	function probeResumeRecovery() {
		resumeLastProbeAt = Date.now();
		var fromResume = resumeFromResumeIntent === true;
		resumeFromResumeIntent = false;   // 一次性：读走即清，后续 tick/通知都不会误当回前台
		if (fromResume) {
			resumeBypassUntil = resumeLastProbeAt + RESUME_BYPASS_WINDOW_MS;
			var hiddenMs = resumeHiddenSince > 0 ? (resumeLastProbeAt - resumeHiddenSince) : 0;
			resumeHiddenSince = 0;
			// 只在"后台待够久"时探活：短切换（键盘/权限弹窗）不产生任何请求。
			if (hiddenMs >= RESUME_VERIFY_MIN_HIDDEN_MS) verifyResumeTransport();
		}
		// T90：判据升级为 isConnectionDown() = 层 1/层 2 的 DOM 文案 **或** WS 观测。
		// 为什么必须升级：rail（左栏收起，用户平时的状态）下官方那条指示器不渲染
		// （T88 §E.4 实测 45s 断线窗口 0 帧）⇒ 只认文案时这里恒 false、直接走健康分支，
		// nudge 永不推。变量名与下面那道健康闸的写法**必须保留**（`scripts/test-resume-recovery.mjs`
		// 的源码契约逐字匹配 `if (!reconnecting)`）。
		var reconnecting = isConnectionDown();
		// 健康路径必须第一件事就返回 false：这是"不误触发"的结构性保证。
		// 顺带把断开闩锁复位、武装复位、并卸掉巡检定时器（健康时零开销）。
		if (!reconnecting) {
			resumeDownSince = 0;
			resumeDownConfirmScheduled = false;
			resumeNudgeArmed = true;
			resumeLastProbeResult = 'healthy';
			stopResumeDownTick();
			return false;
		}
		// 观察器挂上：断开期间才有定时器，恢复即卸。
		ensureResumeDownTick();
		// 第一次观测到"确实断开"：只上闩 + 记录断线起点（供远程自查），并安排二次确认
		if (resumeDownSince === 0) {
			resumeDownSince = Date.now();
			if (lastDisconnectAt === 0) lastDisconnectAt = resumeDownSince;
			resumeLastProbeResult = 'down-seen';
			if (!resumeDownConfirmScheduled) {
				resumeDownConfirmScheduled = true;
				window.setTimeout(function () {
					resumeDownConfirmScheduled = false;
					probeResumeRecovery();
				}, RESUME_CONFIRM_DELAY_MS);
			}
			return false;
		}
		// 走到这里 = 二次确认通过，确实处于断开态。逐道闸检查，任何一道不过都不推。
		if (lastDisconnectAt === 0) lastDisconnectAt = Date.now();
		// T95：回前台这条路径那 5s 窗口内允许跳过"最小间隔"这一道闸。
		// **没有**放宽任何硬边界：`RESUME_MIN_INTERVAL_MS`/`RESUME_MAX_NUDGES` 取值一字未改、
		// 二次确认仍在上面、窗口推过一次即关（见下面的 `resumeBypassUntil = 0`），
		// 并且另加一道 `RESUME_HARD_MIN_GAP_MS` **硬地板** —— 任何两次推之间不得短于它。
		// （DOM 真值台实测到过漏洞：一次"迟到/重复的回前台意图"会把窗口重新打开，于是第二次推
		//   只隔 450ms 就出去了。硬地板把这条堵死，同时不影响"回前台首次不等 8s"。）
		// 依据（§1.5/§1.6）：回前台"首次推"否则会被 8s 间隔压住，而断开态下越早推越好。
		var sinceLastNudge = resumeLastNudgeAt > 0 ? (Date.now() - resumeLastNudgeAt) : Number.POSITIVE_INFINITY;
		var bypassInterval = resumeBypassUntil > 0 && Date.now() <= resumeBypassUntil
			&& sinceLastNudge >= RESUME_HARD_MIN_GAP_MS;
		if (resumeNudgeCount >= RESUME_MAX_NUDGES) {
			resumeLastProbeResult = 'cap-reached';
			stopResumeDownTick();
			return false;
		}
		// T82：武装位语义修正。
		//
		// 改前是"推过一次就 disarmed，必须先观测到恢复才重新武装"，而复位点在
		// `if (!reconnecting)` 分支里 —— 断开期间**永不复位** ⇒ 一次断开只推 1 次，
		// RESUME_MIN_INTERVAL_MS / RESUME_MAX_NUDGES 实际上都是**死代码**
		// （这正是"断着不自愈"在 hook 这一侧的成因；上游并不存在 isFinalBackoffTier /
		//   永久停泊这一层，见上方 T82 段的实测更正）。
		// 现在改成：**距上次推送已过最小间隔、且仍处于断开态**就重新武装。
		// 防风暴边界不变（上限 6 次 + 间隔 8s 的硬闸仍在下面逐条检查）；
		// 健康时仍然由上面的 `!reconnecting` 分支复位。
		if (!resumeNudgeArmed) {
			if (bypassInterval || (resumeLastNudgeAt > 0 && Date.now() - resumeLastNudgeAt >= RESUME_MIN_INTERVAL_MS)) {
				resumeNudgeArmed = true;   // 断开持续 + 间隔已到（或回前台窗口内）⇒ 重武装，下一拍可再推
			} else {
				resumeLastProbeResult = 'down-confirmed-disarmed';
				return false;
			}
		}
		if (!bypassInterval && resumeLastNudgeAt > 0 && Date.now() - resumeLastNudgeAt < RESUME_MIN_INTERVAL_MS) {
			resumeLastProbeResult = 'rate-limited';
			return false;
		}
		try {
			resumeLastNudgeResult = requestUpstreamReconnect();
			resumeNudgeCount += 1;
			resumeLastNudgeAt = Date.now();
			// T95：窗口用掉即关（推过一次就回到 8s 硬间隔，防风暴语义与改前逐字相同）。
			resumeBypassUntil = 0;
			// 重新起算：若仍断开，下一次要走完二次确认（保留二次确认这道闸）。
			resumeDownSince = Date.now();
			resumeNudgeArmed = false;
			resumeLastProbeResult = 'nudged';
			reportUiDiag();
			return true;
		} catch (ignoredDispatch) {
			resumeLastProbeResult = 'dispatch-failed';
			return false;
		}
	}

	if (document.addEventListener) {
		document.addEventListener('visibilitychange', function () {
			// T95：记下"进入后台"的时刻 —— 回前台时用它决定要不要主动探活
			// （后台待够 RESUME_VERIFY_MIN_HIDDEN_MS 才发那一次探活请求）。
			if (document.visibilityState !== 'visible') { resumeHiddenSince = Date.now(); return; }
			window.setTimeout(function () { resumeFromResumeIntent = true; probeResumeRecovery(); }, RESUME_PROBE_DELAY_MS);
		}, { passive: true });
		window.addEventListener('pageshow', function (ev) {
			// bfcache 恢复：从后台标签页回前台同样走一次
			if (!ev || !ev.persisted) return;
			window.setTimeout(function () { resumeFromResumeIntent = true; probeResumeRecovery(); }, RESUME_PROBE_DELAY_MS);
		}, { passive: true });
	}

	// ── 壳 App 返回键桥接（与既有 MainActivity 契约保持一致） ──
	// T90：连接态**变化**的两件事（只在 WS 观测真的翻转时进这里，稳态零动作）：
	//   ① `reportUiDiag()` —— 把新状态经**既有 JS 桥**（`DshRemoteApp.setUiDiag`）推给原生。
	//      wsState 本来就在那份载荷里；原生侧拿它当横幅的第二个数据源（rail 下 DOM 探针
	//      什么都探不到，这是原生唯一能知道"正在重连"的通道）。去抖键含 wsState，
	//      所以状态一变就必推一次、不变不推。
	//   ② 安排一次 `probeResumeRecovery()` —— 与"回前台那一次"**同一个**入口，
	//      四道闸（二次确认 / 武装位 / 8s 最小间隔 / 上限 6）一个字都没放宽。
	//      断线延后 RESUME_PROBE_DELAY_MS（避开重连抖动），恢复不延后（尽快卸巡检）。
	wsWatchSetNotify(function (down) {
		try { reportUiDiag(); } catch (ignoredWsNotifyDiag) { /* 上报失败不影响自愈 */ }
		try {
			window.setTimeout(probeResumeRecovery, down ? RESUME_PROBE_DELAY_MS : 0);
		} catch (ignoredWsNotifyProbe) { /* 定时器失败不影响判据 */ }
	});

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
			// 官方文件右侧栏：<768px 自动全屏，宽屏可为 push 或手动全屏。
			// 以展开标记而非显示模式判断；只收起面板，保留文件标签和路由。
			var rightPanel = document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]');
			if (rightPanel && rightPanel.getAttribute('aria-hidden') !== 'true') {
				// T133：与手势/轻扫同一条 setRightbarOpen 意图队列（此前直接
				// closeOfficialRightbar）。实机反例（rc.2.18 用户录屏）：用户右滑
				// 收右栏，手指进右缘系统返回手势区 ⇒ 系统返回键桥与手势落位
				// **同帧各派发一次 toggle**——第一次关上了，第二次又把它打开，
				// 录屏里就是「关完后面板自己再从右缘滑回来」。
				// 走队列后：在途关闭进行中时这里只把意图入队（同一目标态），
				// 不再产生第二颗 toggle；消费返回的语义逐字不变。
				setRightbarOpen(false);
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
		// T130：右抽屉测试桥（与左抽屉三个桥镜像）。
		setRightDrag: function (progress) {
			var p = Math.max(0, Math.min(1, Number(progress) || 0));
			return setRightVisual((1 - p) * rightCardMax());
		},
		clearRightDrag: function () { clearRightVisual(false); },
		settleRight: settleRight,
		syncNow: syncDom,
		syncViewport: function () {
			applyWidthScope();
			syncDom();
		},
		clampFloatingMenus: clampFloatingMenus,
		applyImeLift: applyImeLift,
		readSessionNotice: collectSessionNotice,
		imeLiftRect: imeLiftRect,
		// T31-3：回前台恢复的自检入口（原生与测试都读它，不做任何动作）
		resumeRecoveryState: resumeRecoveryState,
		probeResumeRecovery: probeResumeRecovery,
		// T90：**只读**连接态快照（字符串，取值与 collectUiDiag().wsState 逐字相同）。
		// 原生在 onResume 补一次（后台期间 pauseTimers 可能冻住页面侧的事件派发，
		// 推来的状态可能陈旧）；正常路径全靠上面的**推送**，这条不是 500ms 轮询。
		wsStateNow: function () {
			if (isConnectionDown()) return 'reconnecting';
			return lastDisconnectAt > 0 ? 'ok-recovered' : 'ok';
		},
		// T82：重连入口分层自检（测试用；返回值就是实际用的那一层）
		requestUpstreamReconnect: requestUpstreamReconnect,
		// T130：右抽屉跟手层的只读快照（测试采样用，不做任何动作）
		rightbarVisualState: function () {
			return {
				tracking: rightVisual !== null,
				mode: rightVisual ? (isRightbarOpen() ? 'close' : 'open') : null,
				active: rightVisual !== null,
				opening: rightVisual ? !isRightbarOpen() : null,
				x: rightVisual ? rightVisual.x : null,
				max: rightVisual ? rightVisual.max : null,
				col: !!findRightbarPanel(),
			};
		},
	};
})();
