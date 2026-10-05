package top.d1studio.dshremote;

import android.content.Context;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * T78：主界面可见的重连状态横幅（原生覆盖条）。
 *
 * <p><b>为什么是原生 View 而不是页面 DOM</b>：平板档的移动适配 hook 是**严格关闭**的
 * （{@code mobile-web.js} 的 {@code resolveHookEnabled()}：{@code device==='tablet'} ⇒ 任意朝向 OFF），
 * 往页面里注入任何节点都会破坏「平板零痕迹」这条既有契约。原生 {@link TextView} 与 WebView
 * 同级、只在屏幕顶部叠一条，页面 DOM 一个字节都不变 ⇒ 两档走同一条路径、平板档天然零痕迹。
 *
 * <p><b>状态信号</b>：{@link #PROBE_JS} 是一段**只读**脚本，经
 * {@code WebView.evaluateJavascript} 每 {@link #POLL_INTERVAL_MS} 毫秒跑一次。
 * 它与 hook 的 {@code findReconnectStatusElement()}（{@code mobile-web.js} 的
 * {@code RECONNECT_STATUS_RE} / {@code isInteractiveNode()} / {@code isVisible()}）
 * **同源**：元素级、整串锚定、只见「有布局盒」的节点；正则字面量逐字符相同
 * （见 {@link #STATUS_RE_JS}，由单测钉死）。
 * 它**不依赖 hook 是否装上**，所以手机档 / 平板档是同一个真相源，没有第二个判据。
 *
 * <p><b>T86：两条匹配层</b>（缺口①——官方 0.2.0-rc.2 的状态**是按钮**，旧探针按设计看不见它）
 * <ol>
 *   <li><b>层 1（官方按钮）</b>：{@code [data-phase]}&nbsp;且值恰为 {@link #OFFICIAL_PHASE}
 *       （官方 {@code ConnectionIndicator} 的 connecting 分支就是
 *       {@code <button type="button" data-phase="connecting">}，文案在内层 {@code span.label}，
 *       后接 {@code aria-hidden} 的三点 dots）。这一层**不套用**「排除可交互控件」——
 *       否则又回到缺口①。代之以四道闸：可见性、**文案锚定**（整串或去尾点后整串，
 *       或 aria-label 含重连语义）、{@link #COMPOSER_DENY_JS} **显式排除清单**
 *       （发送 / 「+」等 composer 交互件的 aria-label 一律否决）、以及 T90 补上的
 *       {@link #COMPOSER_ROLE_JS} **composer 祖先否决**（与 hook 的
 *       {@code isInsideComposer()} 同算法，收掉 T88 遗留的那处两端差异）。</li>
 *   <li><b>层 2（非交互文案）</b>：T78 的旧路径原样保留（向后兼容）：只扫
 *       {@code div,span,p,…}、排除可交互节点与其后代、整串锚定。T86 额外把
 *       {@code [contenteditable]}（官方 composer 是 Lexical）也纳入排除——
 *       用户把「重新连接中」这五个字打进输入框时不算重连。</li>
 * </ol>
 * 返回值里带 {@code src}（1 = 层 1，2 = 层 2），进 logcat 便于事后对账。
 *
 * <p><b>防抖</b>（缺一不可，全部在这里的 {@link Debouncer} 里，可被 JVM 单测瞬时喂序列验证）：
 * 连续 {@link #SHOW_STREAK} 次为真才显示（≈1.0s），连续 {@link #HIDE_STREAK} 次为假才隐藏（≈1.5s），
 * {@code UNKNOWN}（页面正在导航 / 求值失败）不参与计数。
 *
 * <p>纯逻辑（{@link Debouncer}、{@link #isOnScreen}、{@link #shouldSuppress}）不碰 Android 运行时，
 * 由 {@code android/tests/ReconnectBannerTest.java} 在 JVM 上直接验证。
 */
public final class ReconnectBanner {

	private ReconnectBanner() {
	}

	/** 轮询周期（ms）。500ms 一次只读探针；也天然限制了状态翻转频率。 */
	public static final int POLL_INTERVAL_MS = 500;
	/** 出现防抖：连续 N 次观测到「正在重连」才显示 ⇒ 最短 2×500ms = 1.0s。 */
	public static final int SHOW_STREAK = 2;
	/** 消失防抖：连续 N 次观测到「已恢复」才隐藏 ⇒ 最短 3×500ms = 1.5s。 */
	public static final int HIDE_STREAK = 3;
	/** 横幅文案。官方侧栏那条实际是「重新连接中...」，原生条不复刻省略号。 */
	public static final String TEXT = "重新连接中";
	/** 淡入/淡出时长（ms）。只做 alpha，不做位移（避免与页面 IME 抬页打架）。 */
	public static final int FADE_MS = 150;

	/** 一次探针观测。{@code UNKNOWN} = 本轮读不到页面，不参与计数。 */
	public enum Observed {
		OK,
		RECONNECTING,
		UNKNOWN
	}

	/** 横幅可见性状态机状态。 */
	public enum State {
		HIDDEN,
		SHOWN
	}

	/**
	 * 节流 + 出现/消失防抖。**纯 Java、无 Android 依赖**，单测直接喂序列。
	 */
	public static final class Debouncer {

		private final int showStreak;
		private final int hideStreak;
		private int trues;
		private int falses;
		private State state = State.HIDDEN;

		public Debouncer() {
			this(SHOW_STREAK, HIDE_STREAK);
		}

		/** 供单测注入阈值（负控制用）。 */
		public Debouncer(int showStreak, int hideStreak) {
			this.showStreak = showStreak < 1 ? 1 : showStreak;
			this.hideStreak = hideStreak < 1 ? 1 : hideStreak;
		}

		public State state() {
			return state;
		}

		/** 立即回到初始态（隐藏 + 计数清零）。onPageCommitVisible / 退后台走这里。 */
		public void reset() {
			state = State.HIDDEN;
			trues = 0;
			falses = 0;
		}

		/**
		 * 喂一次观测。
		 *
		 * @return true 表示本次发生了跃迁（调用方据此 show/hide）
		 */
		public boolean feed(Observed observed) {
			if (observed == Observed.UNKNOWN) {
				// 导航期静默：既不显示、也不累计——否则「连续为真」会跨页面错误累加。
				trues = 0;
				falses = 0;
				return false;
			}
			if (observed == Observed.RECONNECTING) {
				falses = 0;
				if (state == State.SHOWN) {
					trues = 0;
					return false;
				}
				trues += 1;
				if (trues >= showStreak) {
					trues = 0;
					state = State.SHOWN;
					return true;
				}
				return false;
			}
			trues = 0;
			if (state == State.HIDDEN) {
				falses = 0;
				return false;
			}
			falses += 1;
			if (falses >= hideStreak) {
				falses = 0;
				state = State.HIDDEN;
				return true;
			}
			return false;
		}
	}

	/**
	 * 官方状态元素是否**真的落在视口里**（CSS 像素语义）。
	 *
	 * <p>⚠️ 不能只看 {@code getClientRects().length > 0}：侧栏用 {@code left:-320px} 收起时
	 * 元素仍有布局盒、仍被判「可见」（T68 §2.6 实测），但用户根本看不见。这里要求矩形与
	 * 视口相交，才等价于「用户已经看得见官方那条」。
	 */
	public static boolean isOnScreen(int x, int y, int w, int h, int viewportW, int viewportH) {
		if (w <= 0 || h <= 0 || viewportW <= 0 || viewportH <= 0) return false;
		return x + w > 0 && x < viewportW && y + h > 0 && y < viewportH;
	}

	/**
	 * T86：横幅**将要占据的带区**高度（px）。缺口②——横幅 {@code GONE} 时
	 * {@code getWidth()/getHeight()} 恒 0，拿它当重叠判据会让「重叠」恒为假 ⇒ 自锁。
	 *
	 * <p>取值优先级：已布局实高 &gt; 按内容 measure 出的自然高 &gt; 兜底常量（≥ 实际高度）。
	 * 兜底刻意取大一点：带区偏大只会让「判成重叠 ⇒ 照常显示」，偏小会误抑制。
	 *
	 * @param laidOutPx  已布局高度（{@code Bar.getHeight()}），未布局时 0
	 * @param measuredPx 按内容测量出的高度，测不出时 0
	 * @param fallbackPx 兜底高度（px）
	 */
	public static int bandHeightPx(int laidOutPx, int measuredPx, int fallbackPx) {
		if (laidOutPx > 0) return laidOutPx;
		if (measuredPx > 0) return measuredPx;
		return fallbackPx > 0 ? fallbackPx : 1;
	}

	/** 兜底带高（dp）：13sp 单行 + 8dp×2 内边距 ≈ 32dp，取 40dp 略大一侧。 */
	public static final int BAND_FALLBACK_DP = 40;

	/**
	 * 官方那条已经可见、且与**横幅带区**不重叠 ⇒ 抑制横幅（同一条信息不显示两遍）。
	 *
	 * <p>T86 改判据对象：参数从「横幅当前 rect」改成「横幅将要占据的带区」
	 * （{@code bandLeft..bandRight} × {@code bandTop..bandTop+bandHeight}，同 rootLayout 坐标 px）。
	 * 未显示时横幅 rect 恒 {@code [0,0,0,0]}，用它判重叠恒为「不重叠」⇒ 只要探针能看见官方那条
	 * 就永远抑制 ⇒ 横幅**第一次显示不出来**（T83 §5 实测的自锁）。
	 *
	 * <p>带区与官方那条**重叠**时不抑制：两条信息落在同一块像素上，抑制横幅等于什么都看不见。
	 */
	public static boolean shouldSuppress(boolean officialOnScreen, int ex, int ey, int ew, int eh,
										 int bandLeft, int bandTop, int bandRight, int bandHeight) {
		if (!officialOnScreen) return false;
		int bandBottom = bandTop + bandHeight;
		boolean overlap = ex < bandRight && ex + ew > bandLeft && ey < bandBottom && ey + eh > bandTop;
		return !overlap;
	}

	/**
	 * 与 hook 的 {@code RECONNECT_STATUS_RE}（{@code packages/gateway/assets/mobile-web.js}）
	 * **逐字符一致**的正则字面量。这是单一真相源：上游换文案时
	 * {@code ReconnectBannerTest} 的「同源」断言先红，而不是横幅静默失效。
	 * 由 {@code android/tests/ReconnectBannerTest.java} 直接与源文件比对（断言 7）。
	 */
	public static final String STATUS_RE_JS =
		"/^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)[\\.\u2026]{0,3}$/i";

	/**
	 * T86：官方 {@code ConnectionIndicator} 处于「正在重连」时的 {@code data-phase} 取值。
	 *
	 * <p>来源：官方产物 {@code dsh-web-frontend/dist/assets/index-*.js} 的 {@code q_()}：
	 * {@code h==="connecting"} 时渲染
	 * {@code <button type="button" data-phase={h} aria-label={restartActionLabel}>}，
	 * 内层 {@code span.label} 是 {@code connectingLabel}（i18n {@code connection.connecting}）
	 * 加 {@code aria-hidden} 的三点 dots。{@code recovered} 分支才是 {@code div role="status"}。
	 */
	public static final String OFFICIAL_PHASE = "connecting";

	/**
	 * T86：composer 交互件的 **aria-label 显式排除清单**（层 1 用）。
	 *
	 * <p>层 1 为了看见官方那个 {@code <button>} 必须放开「排除可交互控件」这条闸，
	 * 于是用这份清单把 composer 上的按钮钉死：发送键与「+」键，**中英两式逐条列全**。
	 * 逐条来源是 hook 自己认这两个键的同一份名单（{@code mobile-web.js} 的
	 * composer 触发器 / 发送键选择器：{@code Send message|发送消息|Send|发送|Submit|提交}
	 * 与 {@code Add files or run commands|添加文件或运行命令|命令|Commands}，
	 * 外加 T76 实测到的中文变体 {@code 添加文件或调用指令|添加文件或运行指令|指令}）——
	 * 上游换文案时这份清单和 hook 的选择器都要一起动，改一处漏一处会立刻在
	 * {@code ReconnectBannerTest} 的负例上显形。
	 * 由 {@code ReconnectBannerTest} 把这份字面量**抽出来跑**（不是只查子串）。
	 */
	public static final String COMPOSER_DENY_JS =
		"/^(?:send message|发送消息|send|发送|submit|提交"
		+ "|add files or run commands|添加文件或运行命令|添加文件或调用指令|添加文件或运行指令|命令|指令|commands)$/i";

	/**
	 * T86：层 1 的 **aria-label 兜底锚**（i18n 容错）。
	 *
	 * <p>官方 connecting 分支的 aria-label 是 {@code connection.restart}
	 * （zh「连接中断，正在重试，点击立即重连」/ en「Reconnecting, reconnect now」），
	 * 两套词典都含「重连 / reconnect」语义。文案锚定万一被渲染细节（CSS 计数器、
	 * {@code ::after} 文案）绕开时，这条兜底仍能认出同一条状态。
	 */
	public static final String ARIA_RE_JS = "/重连|reconnect/i";

	/**
	 * T90：层 1 的 **composer 祖先否决**所用的 role 名单（T88 遗留的那处两端差异的收口）。
	 *
	 * <p>T88 给 hook 的层 1 加了一条 ⑤「composer 祖先否决」（自身或祖先里有
	 * {@code contenteditable}（非 {@code "false"}）或 {@code role=textbox/searchbox/combobox}
	 * ⇒ 否决），而原生 {@code PROBE_JS} 层 1 **没有**这条 —— 两端口径不一致（原生更松）。
	 * T90 把同一条补到原生侧：同一份 role 名单、同一段祖先走法、同一位置（DENY 之后、
	 * 可见性闸之前）。这份字面量与 hook 的 {@code COMPOSER_ROLE_JS} **逐字符相同**，
	 * 由 {@code scripts/test-mobile-chrome.mjs} 抽两端字面量做相等比较钉住。
	 *
	 * <p>在真实页面上这条否决**永不生效**（官方那条指示器住在设置触发行里，
	 * 祖先链上没有 contenteditable / textbox）⇒ 只会让两端更严、不会少报真状态。
	 */
	public static final String COMPOSER_ROLE_JS = "/^(?:textbox|searchbox|combobox)$/";

	/** 探针返回的匹配层：1 = 官方 {@code data-phase="connecting"} 按钮。 */
	public static final int SRC_OFFICIAL_BUTTON = 1;
	/** 探针返回的匹配层：2 = 非交互文案（T78 旧路径）。 */
	public static final int SRC_TEXT = 2;

	/** 层 1 文案长度上限的额外余量：官方 label（≤24）+ 三点。 */
	public static final int PHASE_TEXT_PAD = 8;

	/**
	 * 只读探针。**不写任何 DOM、不改任何全局**（平板档要逐字节零痕迹）。
	 *
	 * <p>层 1（官方按钮，T86 新增）：
	 * <ol>
	 *   <li>扫 {@code [data-phase]}，{@code data-phase} 小写后必须**恰等于**
	 *       {@link #OFFICIAL_PHASE}（{@code disconnected} 不认：「连接异常，刷新重试」不是
	 *       「重新连接中」，横幅文案会错）；</li>
	 *   <li>aria-label 命中 {@link #COMPOSER_DENY_JS} ⇒ 直接否决（显式排除清单）；</li>
	 *   <li>必须有布局盒（{@code getClientRects().length > 0}）；</li>
	 *   <li>文案锚定：取该元素**去掉 {@code aria-hidden="true"} 子树后**的文字
	 *       （官方那条的文案在内层 {@code span.label}，而 {@code span.icon} 与 {@code span.dots}
	 *       都带 {@code aria-hidden="true"} ⇒ 等价于只读 label 的文案，且**不依赖 CSS module
	 *       哈希类名**：官方产物里 label 的类名是 {@code _label_1gwo3_80} 这种）。
	 *       该文字整串命中 {@link #STATUS_RE_JS}，**或**去掉尾部省略号后整串命中，
	 *       **或** aria-label 命中 {@link #ARIA_RE_JS}。三条里任一即可。</li>
	 * </ol>
	 *
	 * <p>层 2（T78 旧路径，向后兼容）：判据与 hook 同源：
	 * <ol>
	 *   <li>只扫 {@code div,span,p,section,li,strong,em,label,h1..h6}（**不查 body**），上限 4000 个；</li>
	 *   <li>排除可交互控件（button/a/input/select/textarea、role=button|link|textbox|… 、onclick、
	 *       {@code [contenteditable]} 及其后代）；</li>
	 *   <li>整串锚定 {@link #STATUS_RE_JS} 且长度 ≤ 24；</li>
	 *   <li>必须有布局盒（{@code getClientRects().length > 0}）。</li>
	 * </ol>
	 * 层 2 先用 {@code textContent} 做**廉价**的候选预筛（前缀 + 长度，不触发布局），
	 * 只对候选（≤64 个）算 {@code innerText}（会强制一次布局）与几何，避免在大会话页上
	 * 每 500ms 对 4000 个节点各做一次 layout flush。
	 *
	 * <p>返回对象（不是 JSON 字符串）：{@code {ok, re, src, x, y, w, h, vw, vh}}，
	 * {@code ok=0} 表示读不到页面（记 UNKNOWN）。
	 *
	 * <p>⚠️ <b>拼接表达式里不许有注释</b>：{@code android/test-reconnect-banner.ps1} 与
	 * {@code scratch/t90/dom-truth.mjs} 都是按"Java 字符串字面量 + 常量名 + '+' 拼接"
	 * **逐 token 求值**把它抽出来在真实/桩 DOM 上跑，`//` 会被当成非法 token 直接抛错。
	 * T90 的 {@code insideComposer}（composer 祖先否决）因此只写代码、解释写在
	 * {@link #COMPOSER_ROLE_JS} 的 javadoc 里。
	 */
	public static final String PROBE_JS =
		"(function(){try{"
		+ "var MAX=24,LIMIT=4000,CAND=64,PAD=" + PHASE_TEXT_PAD + ";"
		+ "var PREFIX=/^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)/i;"
		+ "var FULL=" + STATUS_RE_JS + ";"
		+ "var PHASE='" + OFFICIAL_PHASE + "';"
		+ "var DENY=" + COMPOSER_DENY_JS + ";"
		+ "var ARIA=" + ARIA_RE_JS + ";"
		+ "var CROLE=" + COMPOSER_ROLE_JS + ";"
		+ "function vis(n){return !!(n&&n.nodeType===1&&n.getClientRects&&n.getClientRects().length>0);}"
		+ "function editable(n){"
		+ "try{var a=n.getAttribute('contenteditable');"
		+ "if(a!==null&&a!==undefined&&String(a).toLowerCase()!=='false')return true;"
		+ "}catch(ignoredEditable){}"
		+ "return false;}"
		+ "function insideComposer(n){"
		+ "for(var c=n;c&&c.nodeType===1;c=c.parentElement){"
		+ "try{if(CROLE.test(String(c.getAttribute('role')||'').toLowerCase()))return true;}"
		+ "catch(ignoredComposerRole){}"
		+ "if(editable(c))return true;}"
		+ "return false;}"
		+ "function inter(n){"
		+ "var t=(n.tagName||'').toLowerCase();"
		+ "if(t==='button'||t==='a'||t==='input'||t==='select'||t==='textarea')return true;"
		+ "try{var r=String(n.getAttribute('role')||'').toLowerCase();"
		+ "if(r==='button'||r==='link'||r==='textbox'||r==='searchbox'||r==='combobox'"
		+ "||r==='menuitem'||r==='checkbox'||r==='radio'||r==='switch'||r==='tab'||r==='slider')return true;"
		+ "if(n.hasAttribute('onclick'))return true;"
		+ "if(editable(n))return true;"
		+ "if(n.closest&&n.closest('button,a,[role=\"button\"],[role=\"textbox\"],[onclick],[contenteditable]'))"
		+ "return true;"
		+ "}catch(ignoredInteractive){}"
		+ "return false;}"
		+ "function aria(n){"
		+ "try{return String((n.getAttribute&&n.getAttribute('aria-label'))||'').trim();}"
		+ "catch(ignoredAria){return '';}}"
		+ "function anchor(n){"
		+ "try{var out='',k,c;"
		+ "if(!n||!n.childNodes)return '';"
		+ "for(k=0;k<n.childNodes.length;k++){"
		+ "c=n.childNodes[k];"
		+ "if(c.nodeType===3){out+=String(c.nodeValue||'');continue;}"
		+ "if(c.nodeType!==1)continue;"
		+ "if(String((c.getAttribute&&c.getAttribute('aria-hidden'))||'').toLowerCase()==='true')continue;"
		+ "out+=anchor(c);}"
		+ "return out;"
		+ "}catch(ignoredAnchorText){return '';}}"
		+ "function txt(n){"
		+ "try{return String(n.innerText||n.textContent||'').trim();}"
		+ "catch(ignoredText){return '';}}"
		+ "function rendered(n){"
		+ "try{if(typeof n.innerText==='string')return n.innerText.trim();}catch(ignoredRenderedText){}"
		+ "return txt(n);}"
		+ "function core(s){return String(s).replace(/[\\s\u2026]+$/,'').replace(/\\.{1,3}$/,'').trim();}"
		+ "function hit(n,src){"
		+ "var r=n.getBoundingClientRect();"
		+ "return {ok:1,re:1,src:src,x:r.left,y:r.top,w:r.width,h:r.height,"
		+ "vw:window.innerWidth,vh:window.innerHeight};}"
		+ "var body=document.body;"
		+ "if(!body||typeof body.querySelectorAll!=='function')return {ok:0};"
		+ "var i,el,t,ph;"
		+ "try{ph=body.querySelectorAll('[data-phase]');}catch(ignoredPhaseQuery){ph=[];}"
		+ "for(i=0;i<ph.length&&i<CAND;i++){"
		+ "el=ph[i];"
		+ "try{if(String(el.getAttribute('data-phase')||'').trim().toLowerCase()!==PHASE)continue;}"
		+ "catch(ignoredPhaseAttr){continue;}"
		+ "if(DENY.test(aria(el)))continue;"
		+ "if(insideComposer(el))continue;"
		+ "if(!vis(el))continue;"
		+ "t=anchor(el).trim();"
		+ "if(!t||t.length>MAX+PAD)continue;"
		+ "if(!FULL.test(t)&&!FULL.test(core(t))&&!ARIA.test(aria(el)))continue;"
		+ "return hit(el,1);}"
		+ "var nodes=body.querySelectorAll('div,span,p,section,li,strong,em,label,h1,h2,h3,h4,h5,h6');"
		+ "var n=Math.min(nodes.length,LIMIT),cands=[];"
		+ "for(i=0;i<n&&cands.length<CAND;i++){"
		+ "el=nodes[i];"
		+ "try{t=String(el.textContent||'').trim();}catch(ignoredTextContent){continue;}"
		+ "if(!t||t.length>MAX)continue;"
		+ "if(!PREFIX.test(t))continue;"
		+ "cands.push(el);}"
		+ "for(i=0;i<cands.length;i++){"
		+ "el=cands[i];"
		+ "if(inter(el))continue;"
		+ "t=rendered(el);"
		+ "if(!t||t.length>MAX)continue;"
		+ "if(!FULL.test(t))continue;"
		+ "if(!vis(el))continue;"
		+ "return hit(el,2);}"
		+ "return {ok:1,re:0};"
		+ "}catch(probeFailed){return {ok:0};}})()";

	/**
	 * 覆盖条本体：与 WebView 同级的 {@link TextView}，{@code layout_gravity=top}。
	 *
	 * <p>不聚焦、不点击、不参与无障碍树 ⇒ 不会弹软键盘、不会吃掉页面的触摸与焦点。
	 * 遵守系统栏 insets 由调用方用**平板让位那一套取值**（{@code systemBars|displayCutout|tappableElement}
	 * 的逐方向并集）经 {@link #applySystemBarInsets} 写进来，横幅顶边落在系统栏之下。
	 */
	public static final class Bar extends TextView {

		private final Runnable finishHide = () -> {
			setVisibility(View.GONE);
			setAlpha(1f);
		};

		public Bar(Context context) {
			super(context);
			setText(TEXT);
			setTextColor(Color.WHITE);
			setBackgroundColor(0xFF2B2B2B);
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
			setGravity(Gravity.CENTER);
			setSingleLine(true);
			int p = dp(context, 8);
			setPadding(p, p, p, p);
			setVisibility(View.GONE);
			setAlpha(1f);
			// 显式写死三件套：不可聚焦、不可点击、不用可编辑控件（防回归）。
			setFocusable(false);
			setFocusableInTouchMode(false);
			setClickable(false);
			setLongClickable(false);
			setTextIsSelectable(false);
			setSoundEffectsEnabled(false);
			setHapticFeedbackEnabled(false);
			setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
		}

		private static int dp(Context context, int v) {
			return Math.round(v * context.getResources().getDisplayMetrics().density);
		}

		/** 四向系统栏 inset（px）：作为外边距写进 8dp 内边距之外 ⇒ 顶边不低于系统栏。 */
		public void applySystemBarInsets(int left, int top, int right, int bottom) {
			ViewGroup.LayoutParams raw = getLayoutParams();
			if (!(raw instanceof FrameLayout.LayoutParams)) return;
			FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) raw;
			if (lp.leftMargin == left && lp.topMargin == top
				&& lp.rightMargin == right && lp.bottomMargin == bottom) {
				return;
			}
			lp.leftMargin = left;
			lp.topMargin = top;
			lp.rightMargin = right;
			lp.bottomMargin = bottom;
			setLayoutParams(lp);
		}

		/**
		 * T86：横幅「按内容测量」出的高度（px），已布局时直接给实高；测不出给 0。
		 *
		 * <p>{@code GONE} 的 View 从不参与布局 ⇒ {@code getHeight()} 恒 0，但
		 * {@code measure()} 仍能算出自然高度（单行 13sp + 8dp×2 内边距）。
		 * 带区判定的高度兜底链第一环就靠它，避免用魔法常量。
		 */
		public int measureContentHeight() {
			int h = getHeight();
			if (h > 0) return h;
			int w = getWidth();
			if (w <= 0) {
				int pw = 0;
				ViewGroup.LayoutParams raw = getLayoutParams();
				if (getParent() instanceof View) pw = ((View) getParent()).getWidth();
				int margins = 0;
				if (raw instanceof ViewGroup.MarginLayoutParams) {
					ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) raw;
					margins = m.leftMargin + m.rightMargin;
				}
				w = pw > 0 ? Math.max(0, pw - margins) : 0;
			}
			if (w <= 0) return 0;
			measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.AT_MOST),
				MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
			return getMeasuredHeight();
		}

		/** 显示（150ms 淡入，无位移）。 */
		public void show() {
			removeCallbacks(finishHide);
			animate().cancel();
			if (getVisibility() != View.VISIBLE) {
				setAlpha(0f);
				setVisibility(View.VISIBLE);
			}
			animate().alpha(1f).setDuration(FADE_MS).start();
		}

		/** 隐藏（150ms 淡出后 GONE）。 */
		public void hide() {
			if (getVisibility() != View.VISIBLE) {
				setAlpha(1f);
				return;
			}
			removeCallbacks(finishHide);
			animate().cancel();
			animate().alpha(0f).setDuration(FADE_MS).start();
			postDelayed(finishHide, FADE_MS);
		}

		/** 立即隐藏（无动画）：onPageCommitVisible / 退后台 / 离开会话页用，不留上一页的残留。 */
		public void hideNow() {
			removeCallbacks(finishHide);
			animate().cancel();
			setAlpha(1f);
			setVisibility(View.GONE);
		}
	}
}
