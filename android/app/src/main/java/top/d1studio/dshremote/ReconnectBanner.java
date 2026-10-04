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
 * {@code WebView.evaluateJavascript} 每 {@link #POLL_INTERVAL_MS} 毫秒跑一次，
 * 判据与 hook 的 {@code findReconnectStatusElement()}（{@code mobile-web.js} 的
 * {@code RECONNECT_STATUS_RE} / {@code isInteractiveNode()} / {@code isVisible()}）
 * 同源：元素级、整串锚定、排除可交互控件、只见「有布局盒」的节点。
 * 它**不依赖 hook 是否装上**，所以手机档 / 平板档是同一个真相源，没有第二个判据。
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
	 * 官方那条已经可见、且与横幅矩形**不重叠** ⇒ 抑制横幅（同一条信息不显示两遍）。
	 *
	 * <p>不重叠这一条是有意义的：官方文案若正被横幅压住，抑制横幅反而会让用户什么都看不见。
	 * 矩形必须同坐标系（这里都是 rootLayout 坐标，px）。
	 */
	public static boolean shouldSuppress(boolean officialOnScreen, int ex, int ey, int ew, int eh,
										 int bx, int by, int bw, int bh) {
		if (!officialOnScreen) return false;
		boolean overlap = ex < bx + bw && ex + ew > bx && ey < by + bh && ey + eh > by;
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
	 * 只读探针。**不写任何 DOM、不改任何全局**（平板档要逐字节零痕迹）。
	 *
	 * <p>判据与 hook 同源：
	 * <ol>
	 *   <li>只扫 {@code div,span,p,section,li,strong,em,label,h1..h6}（**不查 body**），上限 4000 个；</li>
	 *   <li>排除可交互控件（button/a/input/select/textarea、role=button|link、onclick 及后代）；</li>
	 *   <li>整串锚定 {@link #STATUS_RE_JS} 且长度 ≤ 24；</li>
	 *   <li>必须有布局盒（{@code getClientRects().length > 0}）。</li>
	 * </ol>
	 * 先用 {@code textContent} 做**廉价**的候选预筛（前缀 + 长度，不触发布局），
	 * 只对候选（≤64 个）算 {@code innerText}（会强制一次布局）与几何，避免在大会话页上
	 * 每 500ms 对 4000 个节点各做一次 layout flush。
	 *
	 * <p>返回对象（不是 JSON 字符串）：{@code {ok, re, x, y, w, h, vw, vh}}，
	 * {@code ok=0} 表示读不到页面（记 UNKNOWN）。
	 */
	public static final String PROBE_JS =
		"(function(){try{"
		+ "var MAX=24,LIMIT=4000,CAND=64;"
		+ "var PREFIX=/^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)/i;"
		+ "var FULL=" + STATUS_RE_JS + ";"
		+ "function vis(n){return !!(n&&n.nodeType===1&&n.getClientRects&&n.getClientRects().length>0);}"
		+ "function inter(n){"
		+ "var t=(n.tagName||'').toLowerCase();"
		+ "if(t==='button'||t==='a'||t==='input'||t==='select'||t==='textarea')return true;"
		+ "try{var r=n.getAttribute('role');"
		+ "if(r==='button'||r==='link')return true;"
		+ "if(n.hasAttribute('onclick'))return true;"
		+ "if(n.closest&&n.closest('button,a,[role=\"button\"],[onclick]'))return true;"
		+ "}catch(ignoredInteractive){}"
		+ "return false;}"
		+ "var body=document.body;"
		+ "if(!body||typeof body.querySelectorAll!=='function')return {ok:0};"
		+ "var nodes=body.querySelectorAll('div,span,p,section,li,strong,em,label,h1,h2,h3,h4,h5,h6');"
		+ "var n=Math.min(nodes.length,LIMIT),cands=[],i,el,txt;"
		+ "for(i=0;i<n&&cands.length<CAND;i++){"
		+ "el=nodes[i];"
		+ "try{txt=(el.textContent||'').trim();}catch(ignoredTextContent){continue;}"
		+ "if(!txt||txt.length>MAX)continue;"
		+ "if(!PREFIX.test(txt))continue;"
		+ "cands.push(el);}"
		+ "for(i=0;i<cands.length;i++){"
		+ "el=cands[i];"
		+ "if(inter(el))continue;"
		+ "try{txt=((el.innerText||el.textContent||'')).trim();}catch(ignoredInnerText){continue;}"
		+ "if(!txt||txt.length>MAX)continue;"
		+ "if(!FULL.test(txt))continue;"
		+ "if(!vis(el))continue;"
		+ "var r=el.getBoundingClientRect();"
		+ "return {ok:1,re:1,x:r.left,y:r.top,w:r.width,h:r.height,"
		+ "vw:window.innerWidth,vh:window.innerHeight};}"
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
