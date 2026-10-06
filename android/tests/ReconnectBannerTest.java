package top.d1studio.dshremote;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Pattern;

/**
 * T78（T86 扩充，T109 去横幅）：重连状态探针与防抖状态机的 JVM 行为测试（无模拟器）。
 *
 * <p>钉死这几件事：
 * <ol>
 *   <li><b>防抖状态机</b>：连续 {@value top.d1studio.dshremote.ReconnectBanner#SHOW_STREAK} 次真才确认、
 *       连续 {@value top.d1studio.dshremote.ReconnectBanner#HIDE_STREAK} 次假才解除；{@code UNKNOWN}
 *       （导航期）不参与计数；{@code reset()} 立即清零。T109 起它不再驱动任何 View，
 *       只驱动 T108 快档节拍与 {@code StuckRescue} 观测量。</li>
 *   <li><b>探针只读</b>：{@code PROBE_JS} 里不得出现任何写 DOM / 写全局的 API
 *       （平板档零痕迹是硬契约）。</li>
 *   <li><b>文案同源</b>：探针正则与 hook 的 {@code RECONNECT_STATUS_RE}
 *       （{@code packages/gateway/assets/mobile-web.js}）逐字符一致；上游换文案时这条先红。</li>
 *   <li><b>T86 缺口①</b>：探针必须有**官方 {@code data-phase="connecting"} 按钮**那一层，
 *       且该层不得套用"排除可交互控件"；探针里的匹配字面量（FULL / DENY / ARIA）会被
 *       抽出来用 Java 正则**真跑**一组正例/负例（官方按钮 = 真；发送 / 「+」/ composer = 假）。</li>
 *   <li><b>T109 去横幅</b>（用户口径原话：「把重连横幅去了吧，这样可以少一半的耗电」）：
 *       显示层必须**整层不存在** —— {@code Bar} / {@code TEXT} / {@code FADE_MS} /
 *       {@code isOnScreen} / {@code bandHeightPx} / {@code BAND_FALLBACK_DP} /
 *       {@code shouldSuppress} 一个都不许回来（反射逐个查，防"偷偷加回来"）；
 *       而**喂 StuckRescue 的那条链必须还在**（探针常量 + 防抖器 + MainActivity 接线），
 *       否则省电省成"没人发现断线"。</li>
 * </ol>
 *
 * <p>⚠️ 判据类（静态白名单 / 本网关协议族 / 陈旧上界）的**行为**臂不在这里，而在
 * {@code android/test-reconnect-banner.ps1} 的「T109 臂 A/B」：那两处是
 * {@code MainActivity} 的方法体，只有把**原文**抠出来配替身 javac 真跑才钉得住
 * （T40 §8 M1/M2：只做字符串断言，删掉关键一行照样全绿）。
 *
 * <p>用法：{@code java ... ReconnectBannerTest [<仓库根>/packages/gateway/assets/mobile-web.js]
 * [<仓库根>/android/app/src/main/java/top/d1studio/dshremote/MainActivity.java]}
 * （参数缺省时跳过对应那项，其余照跑。）
 */
public class ReconnectBannerTest {

	static int checks;

	static void check(boolean ok, String label) {
		if (!ok) throw new AssertionError(label);
		checks++;
		System.out.println("ok " + label);
	}

	private static final ReconnectBanner.Observed F = ReconnectBanner.Observed.OK;
	private static final ReconnectBanner.Observed T = ReconnectBanner.Observed.RECONNECTING;
	private static final ReconnectBanner.Observed U = ReconnectBanner.Observed.UNKNOWN;

	/** 把一串观测喂进去，返回每次 feed 之后的状态。 */
	static ReconnectBanner.State[] feedAll(ReconnectBanner.Debouncer d, ReconnectBanner.Observed... seq) {
		ReconnectBanner.State[] out = new ReconnectBanner.State[seq.length];
		for (int i = 0; i < seq.length; i++) {
			d.feed(seq[i]);
			out[i] = d.state();
		}
		return out;
	}

	/** 取探针里 `var NAME=<字面量>;` 的字面量原文（T86：把探针的字面量抽出来真跑，而不是只查子串）。 */
	static String jsLiteral(String probe, String name) {
		String key = "var " + name + "=";
		int i = probe.indexOf(key);
		if (i < 0) throw new AssertionError("probe has no declaration: " + key);
		int start = i + key.length();
		int end = probe.indexOf(';', start);
		if (end < 0) throw new AssertionError("no ';' after: " + key);
		return probe.substring(start, end);
	}

	/** JS 正则字面量 `/body/flags` ⇒ Java {@link Pattern}（只支持本探针用到的 i/m 两个 flag）。 */
	static Pattern jsRegex(String literal) {
		if (literal.length() < 3 || literal.charAt(0) != '/') {
			throw new AssertionError("not a JS regex literal: " + literal);
		}
		int last = literal.lastIndexOf('/');
		if (last <= 0) throw new AssertionError("not a JS regex literal: " + literal);
		String body = literal.substring(1, last);
		String flags = literal.substring(last + 1);
		int f = 0;
		if (flags.indexOf('i') >= 0) f |= Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
		if (flags.indexOf('m') >= 0) f |= Pattern.MULTILINE;
		return Pattern.compile(body, f);
	}

	/** 取 src 里 from..to 之间的原文（含 from，不含 to）。 */
	static String between(String src, String from, String to) {
		int a = src.indexOf(from);
		if (a < 0) throw new AssertionError("anchor not found: " + from);
		int b = src.indexOf(to, a);
		if (b < 0) throw new AssertionError("end anchor not found after " + from + ": " + to);
		return src.substring(a, b);
	}

	/** 按大括号配平取一个方法体（源码断言用，避免把注释/字符串里的字面量当实现）。 */
	static String javaMethodBody(String src, String signature) {
		int a = src.indexOf(signature);
		if (a < 0) throw new AssertionError("method signature not found: " + signature);
		int b = src.indexOf('{', a);
		if (b < 0) throw new AssertionError("method body not found: " + signature);
		int depth = 0;
		for (int i = b; i < src.length(); i++) {
			char c = src.charAt(i);
			if (c == '{') depth++;
			else if (c == '}') {
				depth--;
				if (depth == 0) return src.substring(b, i + 1);
			}
		}
		throw new AssertionError("unbalanced method body: " + signature);
	}

	/** T109：某个名字在本类（{@code ReconnectBanner}）里是不是**真存在**（字段或方法/嵌套类）。 */
	static boolean declaredInBanner(String name) {
		for (Field f : ReconnectBanner.class.getDeclaredFields()) {
			if (f.getName().equals(name)) return true;
		}
		for (Method m : ReconnectBanner.class.getDeclaredMethods()) {
			if (m.getName().equals(name)) return true;
		}
		for (Class<?> c : ReconnectBanner.class.getDeclaredClasses()) {
			if (c.getSimpleName().equals(name)) return true;
		}
		return false;
	}

	/**
	 * T109：把 Java 源码里的**注释**换成等长空格，返回代码部分。
	 *
	 * <p>为什么必须"等长空格"而不是删掉：后面的结构断言用的是 {@code indexOf} 下标，
	 * 等长替换才能让下标 1:1 可复用（与 {@code scripts/test-device-class.mjs} 的
	 * {@code maskJavaNoise} 同一动机）。
	 *
	 * <p>为什么不许"直接删注释"：这个测试要断言的东西里有几处**只出现在注释里**是对的
	 * ——例如 {@code MainActivity} 的 javadoc 会解释「{@code ReconnectBanner.Bar} 为什么被删」
	 * ——所以"不得再有 X"这一类断言必须打在**代码**上，否则会把解释性注释误判成回归。
	 * 反过来也不能用朴素的 `//` 截断：文件里有大量含 `https://` 的 JS 字符串字面量，
	 * 朴素截断会把半行代码吃掉 ⇒ 假绿。因此这里按"字符串/字符字面量状态机"走。
	 */
	static String stripJavaComments(String src) {
		StringBuilder out = new StringBuilder(src.length());
		int i = 0;
		int n = src.length();
		while (i < n) {
			char c = src.charAt(i);
			char next = i + 1 < n ? src.charAt(i + 1) : '\0';
			if (c == '"' || c == '\'') {
				char quote = c;
				out.append(c);
				i++;
				while (i < n) {
					char d = src.charAt(i);
					if (d == '\\' && i + 1 < n) {
						out.append(d).append(src.charAt(i + 1));
						i += 2;
						continue;
					}
					out.append(d);
					i++;
					if (d == quote) break;
				}
				continue;
			}
			if (c == '/' && next == '/') {
				while (i < n && src.charAt(i) != '\n') {
					out.append(' ');
					i++;
				}
				continue;
			}
			if (c == '/' && next == '*') {
				while (i < n) {
					boolean end = src.charAt(i) == '*' && i + 1 < n && src.charAt(i + 1) == '/';
					if (end) {
						out.append("  ");
						i += 2;
						break;
					}
					out.append(src.charAt(i) == '\n' ? '\n' : ' ');
					i++;
				}
				continue;
			}
			out.append(c);
			i++;
		}
		return out.toString();
	}

	public static void main(String[] args) throws Exception {
		// ① 时间常数（500ms 轮询 / 2 真出 / 3 假收 ⇒ 1.0s 与 1.5s）
		check(ReconnectBanner.POLL_INTERVAL_MS == 500, "poll interval is 500ms");
		check(ReconnectBanner.SHOW_STREAK == 2, "the reconnect state needs 2 consecutive true samples");
		check(ReconnectBanner.HIDE_STREAK == 3, "the healthy state needs 3 consecutive false samples");
		check(ReconnectBanner.SHOW_STREAK * ReconnectBanner.POLL_INTERVAL_MS == 1000,
			"state-confirmation latency floor is 1000ms");
		check(ReconnectBanner.HIDE_STREAK * ReconnectBanner.POLL_INTERVAL_MS == 1500,
			"state-release latency floor is 1500ms");

		// ② 设计文档里的验收序列 [f,f,t,t,f,f,f,f,t]
		ReconnectBanner.Debouncer d = new ReconnectBanner.Debouncer();
		ReconnectBanner.Observed[] seq = {F, F, T, T, F, F, F, F, T};
		ReconnectBanner.State[] st = feedAll(d, seq);
		check(st[0] == ReconnectBanner.State.HIDDEN, "[f] still HIDDEN");
		check(st[1] == ReconnectBanner.State.HIDDEN, "[f] still HIDDEN");
		check(st[2] == ReconnectBanner.State.HIDDEN, "1st true is NOT enough to confirm");
		check(st[3] == ReconnectBanner.State.SHOWN, "2nd consecutive true confirms the reconnecting state");
		check(st[4] == ReconnectBanner.State.SHOWN, "1st false does not release");
		check(st[5] == ReconnectBanner.State.SHOWN, "2nd false does not release");
		check(st[6] == ReconnectBanner.State.HIDDEN, "3rd consecutive false releases");
		check(st[7] == ReconnectBanner.State.HIDDEN, "stays released");
		check(st[8] == ReconnectBanner.State.HIDDEN, "single true after release does not re-confirm");

		// ③ 单次抖动不闪（200ms 抖动 = 1 次真后立刻假）
		ReconnectBanner.Debouncer jitter = new ReconnectBanner.Debouncer();
		feedAll(jitter, T, F, F, F, F, F);
		check(jitter.state() == ReconnectBanner.State.HIDDEN, "one-sample blip never confirms");

		// ④ 「刚连上又断」不闪：已确认时 3 次假才解除；中间的 1 次真把假计数清零（重新数 3 次）
		ReconnectBanner.Debouncer flappy = new ReconnectBanner.Debouncer();
		feedAll(flappy, T, T, F, F, T, F, F);
		check(flappy.state() == ReconnectBanner.State.SHOWN,
			"false-run interrupted by one true does not release (counter restarts)");
		flappy.feed(F);
		check(flappy.state() == ReconnectBanner.State.HIDDEN,
			"three falses after the interruption do release");

		// ⑤ 导航期 UNKNOWN 不推进计数：真/未知/真 不足两次「连续」真
		ReconnectBanner.Debouncer nav = new ReconnectBanner.Debouncer();
		feedAll(nav, T);
		check(nav.state() == ReconnectBanner.State.HIDDEN, "true then UNKNOWN is not enough");
		nav.feed(U);
		nav.feed(T);
		check(nav.state() == ReconnectBanner.State.HIDDEN, "UNKNOWN breaks the run of trues");
		nav.feed(T);
		check(nav.state() == ReconnectBanner.State.SHOWN, "two trues after the gap do confirm");

		// ⑥ onPageCommitVisible ⇒ reset()：立即解除 + 清零
		ReconnectBanner.Debouncer navReset = new ReconnectBanner.Debouncer();
		feedAll(navReset, T, T);
		check(navReset.state() == ReconnectBanner.State.SHOWN, "confirmed before page commit");
		navReset.reset();
		check(navReset.state() == ReconnectBanner.State.HIDDEN, "reset() releases immediately");
		navReset.feed(T);
		check(navReset.state() == ReconnectBanner.State.HIDDEN,
			"reset() also zeroes the streak (one true after commit is not enough)");

		// ⑦ 健康页不常驻：一直健康 ⇒ 恒 HIDDEN（也不会在恢复后残留计数）
		ReconnectBanner.Debouncer healthy = new ReconnectBanner.Debouncer();
		feedAll(healthy, F, F, F, F, F, F, F, F, F, F);
		check(healthy.state() == ReconnectBanner.State.HIDDEN, "healthy page never confirms reconnecting");

		// ⑧ 负控制友好的可注入阈值：1 真即确认 / 1 假即解除（真实实现用默认构造器）
		ReconnectBanner.Debouncer injected = new ReconnectBanner.Debouncer(1, 1);
		injected.feed(T);
		check(injected.state() == ReconnectBanner.State.SHOWN, "injected showStreak=1 confirms on first true");
		injected.feed(F);
		check(injected.state() == ReconnectBanner.State.HIDDEN, "injected hideStreak=1 releases on first false");

		// ⑨ T109：**显示层必须整层不存在**（反射逐个查；"偷偷加回来"立刻变红）
		for (String gone : new String[] {"Bar", "TEXT", "FADE_MS", "isOnScreen", "bandHeightPx",
			"BAND_FALLBACK_DP", "shouldSuppress"}) {
			check(!declaredInBanner(gone),
				"T109 去横幅：ReconnectBanner 里不得再有 " + gone + "（显示层/带区几何整层删除）");
		}
		// 而"采样这条链"必须还在（省电不许省成"没人发现断线"）
		check(declaredInBanner("PROBE_JS") && declaredInBanner("Debouncer")
				&& declaredInBanner("POLL_INTERVAL_MS") && declaredInBanner("SHOW_STREAK")
				&& declaredInBanner("HIDE_STREAK"),
			"T109 去横幅：喂 StuckRescue / T108 节拍的那条链（探针 + 防抖 + 周期）一个都不许少");

		// ⑩ 探针是只读的：不得出现任何写 DOM / 写全局的 API
		String probe = ReconnectBanner.PROBE_JS;
		for (String forbidden : new String[] {
			"appendChild", "insertBefore", "removeChild", "innerHTML", "outerHTML",
			"setAttribute", "removeAttribute", "classList.add", "classList.remove",
			"createElement", "createTextNode", "document.write", "textContent=",
			"style.", ".style", "localStorage", "sessionStorage", "requestAnimationFrame",
			"setTimeout", "setInterval", "addEventListener", "dispatchEvent",
			"MutationObserver", "window.__", "postMessage", "eval("}) {
			check(!probe.contains(forbidden), "probe never touches write/留下痕迹 API: " + forbidden);
		}
		check(probe.contains("getBoundingClientRect()"), "probe reads geometry (read-only)");
		check(probe.contains("body.querySelectorAll('div,span,p,section,li,strong,em,label,h1,h2,h3,h4,h5,h6')"),
			"probe reads through the hook's element list");
		check(probe.contains("innerText"), "probe uses the hook's innerText||textContent rule");
		check(probe.contains("getClientRects"), "probe uses the hook's isVisible() rule");
		check(probe.startsWith("(function(){") && probe.endsWith("})()"),
			"probe is a self-contained IIFE expression");
		check(probe.contains("return {ok:0};"), "probe reports 'unreadable page' instead of throwing");

		// ⑪ 文案同源（断言 7）：探针正则 === hook 的 RECONNECT_STATUS_RE
		check(ReconnectBanner.STATUS_RE_JS.equals(
				"/^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)[\\.\u2026]{0,3}$/i"),
			"STATUS_RE_JS is the hook's regex, character for character");
		check(probe.contains("var FULL=" + ReconnectBanner.STATUS_RE_JS + ";"),
			"probe uses STATUS_RE_JS as its single source");

		// ⑫ T86 缺口①：探针的**匹配字面量**抽出来真跑（不是只查子串）
		//    官方 0.2.0-rc.2 的「重新连接中」是 <button data-phase="connecting">：
		//      · 正例 = 官方那一条（文案 + 三点 dots / 英文 Reconnecting）
		//      · 负例 = 发送按钮 / 「+」按钮 / composer 文本 / disconnected 文案
		check(jsLiteral(probe, "PHASE").equals("'" + ReconnectBanner.OFFICIAL_PHASE + "'"),
			"tier-1 pins data-phase === \"connecting\" (官方 q_() 的 connecting 分支)");
		check(jsLiteral(probe, "DENY").equals(ReconnectBanner.COMPOSER_DENY_JS),
			"tier-1 uses the exported composer denylist literal");
		check(jsLiteral(probe, "ARIA").equals(ReconnectBanner.ARIA_RE_JS),
			"tier-1 uses the exported aria-label fallback anchor");

		Pattern full = jsRegex(jsLiteral(probe, "FULL"));
		Pattern deny = jsRegex(jsLiteral(probe, "DENY"));
		Pattern aria = jsRegex(jsLiteral(probe, "ARIA"));
		check(full.matcher("重新连接中...").matches(),
			"POSITIVE official zh label (text + 3 dots) matches the probe regex");
		check(full.matcher("Reconnecting").matches(),
			"POSITIVE official en label matches (i18n 只带 zh/en 两套词典，两套都覆盖)");
		check(aria.matcher("连接中断，正在重试，点击立即重连").find(),
			"POSITIVE official zh aria-label (connection.restart) matches the fallback anchor");
		check(aria.matcher("Reconnecting, reconnect now").find(),
			"POSITIVE official en aria-label matches the fallback anchor");
		check(!aria.matcher("Send message").find() && !aria.matcher("发送消息").find(),
			"NEGATIVE the fallback anchor does NOT fire on the send button's aria-label");
		check(!aria.matcher("Add files or run commands").find() && !aria.matcher("添加文件或运行命令").find(),
			"NEGATIVE the fallback anchor does NOT fire on the plus button's aria-label");
		check(deny.matcher("Send message").matches(),
			"NEGATIVE send button aria-label (en) is denied");
		check(deny.matcher("发送消息").matches(),
			"NEGATIVE send button aria-label (zh) is denied");
		check(deny.matcher("Add files or run commands").matches(),
			"NEGATIVE plus button aria-label (en) is denied");
		check(deny.matcher("添加文件或运行命令").matches(),
			"NEGATIVE plus button aria-label (zh) is denied");
		check(!deny.matcher("连接中断，正在重试，点击立即重连").matches(),
			"NEGATIVE-of-the-negative: the official indicator's aria-label is not on the denylist");
		check(!full.matcher("重新连接中，请稍候").matches(),
			"NEGATIVE composer-like prose with extra text does not match (整串锚定)");
		check(!full.matcher("连接异常，刷新重试").matches(),
			"NEGATIVE disconnected 文案不匹配（认它就会把「连接异常」说成「正在重连」）");
		check(!full.matcher("正在重新连接中").matches(),
			"NEGATIVE prefix-extended copy does not match (no partial matching)");

		// ⑬ T86：两层的**结构语义**（谁能认、谁必须排除）
		String tier1 = between(probe, "querySelectorAll('[data-phase]')", "return hit(el,1);}");
		check(tier1.contains("if(DENY.test(aria(el)))continue;"),
			"tier-1 applies the explicit composer denylist");
		check(tier1.contains("if(!vis(el))continue;"),
			"tier-1 requires a layout box (getClientRects)");
		check(!tier1.contains("inter("),
			"tier-1 MUST NOT re-apply the interactive-node exclusion (that gate is exactly 缺口①)");
		check(probe.contains("return hit(el," + ReconnectBanner.SRC_OFFICIAL_BUTTON + ");"),
			"tier-1 tags its match with src=" + ReconnectBanner.SRC_OFFICIAL_BUTTON);
		check(probe.contains("t=rendered(el);"),
			"tier-2 用 innerText 为准（渲染后为空的节点不得回退 textContent 里的隐藏文案）");
		String tier2 = between(probe, "querySelectorAll('div,span,p,section,li,strong,em,label", "return hit(el,2);}");
		check(tier2.contains("if(inter(el))continue;"),
			"tier-2 still excludes interactive nodes (backward compatible)");
		String interBody = between(probe, "function inter(n){", "return false;}");
		check(interBody.contains("t==='button'"),
			"tier-2 exclusion still lists button/a/input/select/textarea");
		check(interBody.contains("[contenteditable]"),
			"tier-2 exclusion also covers [contenteditable] (官方 composer 是 Lexical，打字不算重连)");

		// ⑭ T90：层 1 的 ⑤ **composer 祖先否决**（收口 T88 遗留的那处两端差异）。
		//    两端现在同名单、同走法、同位置；hook 侧由 `scripts/test-mobile-chrome.mjs`
		//    抽 COMPOSER_ROLE_RE/COMPOSER_ROLE_JS 做逐字符比较钉住。
		check(probe.contains("var CROLE=" + ReconnectBanner.COMPOSER_ROLE_JS + ";"),
			"tier-1 pins the composer-ancestor role list literal (COMPOSER_ROLE_JS)");
		String compBody = between(probe, "function insideComposer(n){", "return false;}");
		check(compBody.contains("for(var c=n;c&&c.nodeType===1;c=c.parentElement)"),
			"composer veto walks 自身 + 全部祖先（与 hook 的 isInsideComposer 同走法）");
		check(compBody.contains("if(editable(c))return true;"),
			"composer veto covers contenteditable（非 \"false\"）祖先");
		check(compBody.contains("CROLE.test("),
			"composer veto uses the shared role literal（不另写一份名单）");
		check(tier1.contains("if(insideComposer(el))continue;"),
			"tier-1 applies the composer-ancestor veto");
		{
			int atDeny = tier1.indexOf("if(DENY.test(aria(el)))continue;");
			int atComposer = tier1.indexOf("if(insideComposer(el))continue;");
			int atVis = tier1.indexOf("if(!vis(el))continue;");
			check(atDeny >= 0 && atComposer > atDeny && atVis > atComposer,
				"tier-1 gate order matches the hook: DENY → composer → visibility");
			// 负控制：否决必须**在可见性闸之前**且**在 DENY 之后**（顺序反了就等于换了一条判据）。
			check(!(atComposer < atDeny), "composer veto must not run before the aria denylist");
		}
		Pattern crole = jsRegex(ReconnectBanner.COMPOSER_ROLE_JS);
		check(crole.matcher("textbox").matches() && crole.matcher("searchbox").matches()
			&& crole.matcher("combobox").matches(),
			"composer role list covers textbox/searchbox/combobox（两端都先把 role 转小写再测，故字面量不需要 /i）");
		check(compBody.contains("String(c.getAttribute('role')||'').toLowerCase()"),
			"composer veto lowercases the role attribute（与 hook 的 isInsideComposer 同口径）");
		check(ReconnectBanner.COMPOSER_ROLE_JS.indexOf("/i") < 0,
			"composer role literal carries no /i flag（小写化由代码负责，两端一致）");
		check(!crole.matcher("button").matches() && !crole.matcher("textboxish").matches(),
			"composer role list matches exactly（整串锚定：button / textboxish 都不算 composer）");

		// ⑮ T109：MainActivity 侧的**接线契约**（有路径参数时才查）。
		//    "显示层不许回来" + "采样链不许断" + "陈旧上界必须存在且只作用于投票"。
		if (args.length > 1 && args[1] != null && !args[1].isEmpty()) {
			Path mainSrc = Paths.get(args[1]);
			check(Files.isRegularFile(mainSrc), "MainActivity source exists: " + mainSrc);
			String main = new String(Files.readAllBytes(mainSrc), StandardCharsets.UTF_8);
			// 「不得再有 X」这类断言只许打在**代码**上：MainActivity 的 javadoc 里刻意
			// 留着「ReconnectBanner.Bar / dshrReconnectBanner 为什么被删」的解释，
			// 那是文档不是实现（见 stripJavaComments 的注释）。
			String code = stripJavaComments(main);
			// ① 显示层：View / id / show / hide 一处都不许留（代码里）
			for (String gone : new String[] {"ReconnectBanner.Bar", "dshrReconnectBanner",
				"installReconnectBanner", "applyReconnectBannerInsets", "reconnectBanner.show(",
				"reconnectBanner.hide(", "reconnectBanner.getHeight(", "officialStatusDetail",
				"shouldSuppress", "bandHeightPx", "ReconnectBanner.isOnScreen"}) {
				check(!code.contains(gone), "T109 去横幅：MainActivity 代码里不得再有 " + gone);
			}
			check(code.contains("rootLayout.addView(webView"), "T109：根布局仍挂 WebView");
			// ② 采样链：探针仍由探针节拍发起，且仍喂 StuckRescue
			check(main.contains("webView.evaluateJavascript(ReconnectBanner.PROBE_JS, this::handleReconnectProbe)"),
				"T109 去横幅：只读探针仍按节拍发起（采样链未断）");
			String hpr = javaMethodBody(main, "private void handleReconnectProbe(String value)");
			check(hpr.contains("runStuckRescue(pageReconnecting, observed);"),
				"T109 去横幅：探针结果仍喂 StuckRescue（自救不许被省掉）");
			check(hpr.contains("reconnectDebounce.feed(observed);"),
				"T109 去横幅：防抖器仍在推进（T108 快档节拍与自救观测量依赖它）");
			check(!hpr.contains(".show(") && !hpr.contains(".hide("),
				"T109 去横幅：handleReconnectProbe 里不再有任何显示动作");
			// ③ 陈旧上界（S1）：必须存在、必须只作用于"投票"，不得把 hookSelfHealLive 一起抹掉
			check(main.contains("HOOK_CONN_STATE_MAX_AGE_MS"),
				"T109 S1：hook 连接态必须有陈旧上界（一次假 reconnecting 不许永久钉死）");
			check(main.contains("private String freshHookConnState() {"),
				"T109 S1：必须有一个「新鲜度」读法供投票处使用");
			check(hpr.contains("freshHookConnState()"),
				"T109 S1：handleReconnectProbe 的投票必须走新鲜度（否则一次假推送把状态钉死）");
			check(hpr.contains("\"reconnecting\".equals(hookConnState)"),
				"T90 源码契约保留：`\"reconnecting\".equals(hookConnState)` 字面量仍在（test:mobile 逐字查它）");
			String selfHeal = javaMethodBody(main, "private boolean hookSelfHealLive()");
			check(selfHeal.contains("hookConnState != null") && !selfHeal.contains("freshHookConnState"),
				"T109 S1：hookSelfHealLive 问的是「桥装没装过」（历史事实），不得被新鲜度抹掉"
					+ "——否则健康静默 20s 后兜底探针从 5s 掉到 1s，与省电目标相反");
			String interval = javaMethodBody(main, "private long probeIntervalMs()");
			check(interval.contains("freshHookConnState()"),
				"T109 S1：快档节拍也走新鲜度（陈旧的 reconnecting 不许把 500ms 快档一直挂着）");
			// ④ 诊断行：状态必须改由设置页体现（横幅的替代面）
			//
			// ⚠️ T117「谁钉住了谁」：T109 这条臂原来钉的是「**设置页只读诊断行**必须接上」
			// （`main.contains("reconnectDiagLine()")` 那句的真实语义是"状态必须有一个**可见面**"）。
			// T117 按用户要求把设置页那 9 行诊断整块删除（用户原话：「把你之前加的那些测试用的
			// 内容删了吧…比如这串诊断字样」），因此**可见面这一层被移动**：同一份诊断改由
			// logcat 标签 `dshr-diag` 输出（只在值变化时打），进设置页时**无条件**打一份全文快照。
			// ——移动被钉代码的人（T117）在本批同批更新这条断言，并把它改写成对**新落点**的判据，
			// 同时保留"不许只剩删除、必须仍有取回通道"的判别力（见下面四条 + 变异反证）。
			check(main.contains("reconnectDiagLine()") && main.contains("diagSnapshotText()"),
				"T117：诊断内容仍必须被**消费**（reconnectDiagLine → diagSnapshotText → logcat），"
					+ "不许在删 UI 时把信息一起删掉（否则用户侧再没有任何取回通道）");
			check(!code.contains("tvUiDiag") && !code.contains("setText(diagSnapshotText"),
				"T117：设置页**不许**再有诊断控件/上屏（把 tvUiDiag 那行塞回来必红）");
			check(main.contains("private void emitDiagLog(String trigger, boolean userTriggered)")
				&& main.contains("Log.i(DIAG_TAG, "),
				"T117：诊断必须落到 logcat（emitDiagLog + DIAG_TAG），这是删掉屏上那串之后的唯一落点");
			check(main.contains("emitDiagLog(\"settings\", true)"),
				"T117：进设置页必须**无条件**打一份完整快照（用户主动排查时刻，绕过去重与最小间隔闸）");
			// T117 省电契约：无推送通道档的兜底从 1000ms 放宽，且**两档合并**。
			// rc.2.10 按用户口径再放宽到 **60000ms（按分钟计）**：
			// 「兜底探针改成按分钟计吧，然后在后台的时候不触发，只有在前台才会触发探针，这样才是真省电。」
			// 变异反证：把 60000L 改回 5000L/1000L（或把 PROBE_IDLE_HOOK_MS 那套分档塞回来）⇒ 这两条立刻红。
			check(main.contains("private static final long PROBE_IDLE_MS = 60000L"),
				"rc.2.10：健康态兜底探针必须是一档 60000ms（按分钟；改回 1000L/5000L = 本任务要修的耗电点）");
			check(!code.contains("PROBE_IDLE_HOOK_MS"),
				"T117：有/无推送通道的两档必须**合并**（不许留一个没人用的旧档常量，"
					+ "否则 probeIntervalMs 又会按 hookSelfHealLive() 分叉回去）——"
					+ "判据打在剥注释后的代码上：{@code PROBE_IDLE_MS} 的 javadoc 里刻意留了这段说明");
			check(main.contains("return PROBE_IDLE_MS;"),
				"T117：probeIntervalMs 的健康态分支必须**只有**一个兜底周期");
		} else {
			System.out.println("skip MainActivity source comparison (no second path argument)");
		}
		if (args.length > 0 && args[0] != null && !args[0].isEmpty()) {
			Path src = Paths.get(args[0]);
			check(Files.isRegularFile(src), "hook source exists: " + src);
			String hook = new String(Files.readAllBytes(src), StandardCharsets.UTF_8);
			check(hook.contains("var RECONNECT_STATUS_RE = " + ReconnectBanner.STATUS_RE_JS + ";"),
				"hook's RECONNECT_STATUS_RE matches the probe regex character for character");
			check(hook.contains("nodes[i]") || hook.contains("querySelectorAll('div,span,p,section,li,strong,em,label"),
				"hook still scans the same element list the probe scans");
		} else {
			System.out.println("skip hook-source comparison (no path argument)");
		}

		System.out.println("ReconnectBanner tests passed: " + checks);
	}
}
