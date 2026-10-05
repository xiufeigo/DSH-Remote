package top.d1studio.dshremote;

/**
 * 重连状态**探针**与防抖状态机（原生侧；无 Android 运行时依赖）。
 *
 * <p><b>T109：显示层已删除，这个类只剩"采样 + 判据"。</b>
 * 用户口径原话：『把重连横幅去了吧，这样可以少一半的耗电』。删掉的是：
 * <ul>
 *   <li>{@code Bar}（与 WebView 同级、{@code layout_gravity=top} 的原生 {@code TextView} 覆盖条）；</li>
 *   <li>它的出入场 alpha 动画（{@code FADE_MS}）与文案常量 {@code TEXT}；</li>
 *   <li>它与"官方那条是否可见 + 带区是否重叠"的抑制几何
 *       （{@code isOnScreen} / {@code bandHeightPx} / {@code shouldSuppress} / {@code BAND_FALLBACK_DP}）；
 *       没有横幅就无所谓"同一条信息画两遍"。</li>
 * </ul>
 * 保留的是下面这一整块，**一个字都没动**：
 * <ul>
 *   <li>{@link #PROBE_JS}（只读探针：不写 DOM、不改全局、平板档逐字节零痕迹）；</li>
 *   <li>它用到的正则/名单字面量（{@link #STATUS_RE_JS}、{@link #OFFICIAL_PHASE}、
 *       {@link #COMPOSER_DENY_JS}、{@link #ARIA_RE_JS}、{@link #COMPOSER_ROLE_JS}）——
 *       两端同源断言（{@code scripts/test-mobile-chrome.mjs}）按这份字面量逐字符比对，
 *       改一端必须同时改另一端；</li>
 *   <li>{@link #POLL_INTERVAL_MS} 与 {@link Debouncer}（连续 {@link #SHOW_STREAK} 次真 /
 *       连续 {@link #HIDE_STREAK} 次假）。</li>
 * </ul>
 *
 * <p><b>删除后这个防抖器还有什么用</b>（必须在代码里留下答案，否则后来人会把"没人看的
 * 状态机"当死代码删掉）：
 * <ol>
 *   <li>T108 的**自适应节拍**：确认仍在断开态时保持 500ms 快档
 *       （{@code MainActivity.probeIntervalMs()}）；</li>
 *   <li>{@link StuckRescue} 的观测量——"卡住"从发现到动手的时延全靠它。</li>
 * </ol>
 * 也就是说：省掉的是**耗电的显示与动画**，采样这条链一秒都没省。
 *
 * <p>状态呈现改由设置页的只读诊断行负责（{@code MainActivity.reconnectDiagLine()}：
 * hook 连接态 / 上次断线 / 探针拍数 / 最近观测 / 当前节拍）。
 */
public final class ReconnectBanner {

	private ReconnectBanner() {
	}

	/** 轮询周期（ms）。500ms 一次只读探针；也天然限制了状态翻转频率。 */
	public static final int POLL_INTERVAL_MS = 500;
	/** 出现防抖：连续 N 次观测到「正在重连」才算确认（最短 2×500ms = 1.0s）。 */
	public static final int SHOW_STREAK = 2;
	/** 消失防抖：连续 N 次观测到「已恢复」才算解除（最短 3×500ms = 1.5s）。 */
	public static final int HIDE_STREAK = 3;

	/** 一次探针观测。{@code UNKNOWN} = 本轮读不到页面，不参与计数。 */
	public enum Observed {
		OK,
		RECONNECTING,
		UNKNOWN
	}

	/** 防抖状态机状态。T109：不再驱动任何 View，只驱动节拍与自救观测量。 */
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
		 * @return true 表示本次发生了跃迁
		 */
		public boolean feed(Observed observed) {
			if (observed == Observed.UNKNOWN) {
				// 导航期静默：既不确认、也不累计——否则「连续为真」会跨页面错误累加。
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
	 * 与 hook 的 {@code RECONNECT_STATUS_RE}（{@code packages/gateway/assets/mobile-web.js}）
	 * **逐字符一致**的正则字面量。这是单一真相源：上游换文案时
	 * {@code ReconnectBannerTest} 的「同源」断言先红，而不是探针静默失效。
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
	 *       「重新连接中」）；</li>
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
	 *
	 * <p>T109：探针**逐字节未改**（横幅显示层的删除不经过这里）——
	 * 它是 StuckRescue 与 T108 节拍的唯一采样源，也是平板档"零痕迹"那条契约的载体。
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
}
