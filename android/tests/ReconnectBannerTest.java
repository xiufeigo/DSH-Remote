package top.d1studio.dshremote;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Pattern;

/**
 * T78（T86 扩充）：重连横幅状态机与判据的 JVM 行为测试（无模拟器）。
 *
 * <p>钉死这几件事：
 * <ol>
 *   <li><b>防抖状态机</b>：连续 {@value top.d1studio.dshremote.ReconnectBanner#SHOW_STREAK} 次真才显示、
 *       连续 {@value top.d1studio.dshremote.ReconnectBanner#HIDE_STREAK} 次假才隐藏；{@code UNKNOWN}
 *       （导航期）不参与计数；{@code reset()} 立即清零。</li>
 *   <li><b>抑制判据</b>：官方那条"可见"必须是**真的在视口里**（侧栏 {@code left:-320px} 收起时
 *       {@code getClientRects().length > 0} 但用户看不见），且不与**横幅带区**
 *       重叠（T86：判据对象从"横幅当前 rect"改成"横幅将要占据的带区"——前者在横幅未布局时
 *       恒 0×0，会让重叠恒为假而自锁）。</li>
 *   <li><b>探针只读</b>：{@code PROBE_JS} 里不得出现任何写 DOM / 写全局的 API
 *       （平板档零痕迹是硬契约）。</li>
 *   <li><b>文案同源</b>：探针正则与 hook 的 {@code RECONNECT_STATUS_RE}
 *       （{@code packages/gateway/assets/mobile-web.js}）逐字符一致；上游换文案时这条先红。</li>
 *   <li><b>T86 缺口①</b>：探针必须有**官方 {@code data-phase="connecting"} 按钮**那一层，
 *       且该层不得套用"排除可交互控件"；探针里的匹配字面量（FULL / DENY / ARIA）会被
 *       抽出来用 Java 正则**真跑**一组正例/负例（官方按钮 = 真；发送 / 「+」/ composer = 假）。</li>
 *   <li><b>T86 缺口②</b>：{@code bandHeightPx} 的兜底链 + {@code officialStatusDetail}
 *       不再把横幅当前 rect 喂进 {@code shouldSuppress}（有源码路径参数时才查）。</li>
 * </ol>
 *
 * 用法：{@code java ... ReconnectBannerTest [<仓库根>/packages/gateway/assets/mobile-web.js]
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

	public static void main(String[] args) throws Exception {
		// ① 时间常数（500ms 轮询 / 2 真出 / 3 假收 ⇒ 1.0s 与 1.5s）
		check(ReconnectBanner.POLL_INTERVAL_MS == 500, "poll interval is 500ms");
		check(ReconnectBanner.SHOW_STREAK == 2, "show needs 2 consecutive true samples");
		check(ReconnectBanner.HIDE_STREAK == 3, "hide needs 3 consecutive false samples");
		check(ReconnectBanner.SHOW_STREAK * ReconnectBanner.POLL_INTERVAL_MS == 1000,
			"appearance latency floor is 1000ms");
		check(ReconnectBanner.HIDE_STREAK * ReconnectBanner.POLL_INTERVAL_MS == 1500,
			"disappearance latency floor is 1500ms");
		check("重新连接中".equals(ReconnectBanner.TEXT), "banner text is 重新连接中");

		// ② 设计文档里的验收序列 [f,f,t,t,f,f,f,f,t]
		ReconnectBanner.Debouncer d = new ReconnectBanner.Debouncer();
		ReconnectBanner.Observed[] seq = {F, F, T, T, F, F, F, F, T};
		ReconnectBanner.State[] st = feedAll(d, seq);
		check(st[0] == ReconnectBanner.State.HIDDEN, "[f] still hidden");
		check(st[1] == ReconnectBanner.State.HIDDEN, "[f] still hidden");
		check(st[2] == ReconnectBanner.State.HIDDEN, "1st true is NOT enough to show");
		check(st[3] == ReconnectBanner.State.SHOWN, "2nd consecutive true shows the banner");
		check(st[4] == ReconnectBanner.State.SHOWN, "1st false does not hide");
		check(st[5] == ReconnectBanner.State.SHOWN, "2nd false does not hide");
		check(st[6] == ReconnectBanner.State.HIDDEN, "3rd consecutive false hides the banner");
		check(st[7] == ReconnectBanner.State.HIDDEN, "stays hidden");
		check(st[8] == ReconnectBanner.State.HIDDEN, "single true after hide does not re-show");

		// ③ 单次抖动不闪（200ms 抖动 = 1 次真后立刻假）
		ReconnectBanner.Debouncer jitter = new ReconnectBanner.Debouncer();
		feedAll(jitter, T, F, F, F, F, F);
		check(jitter.state() == ReconnectBanner.State.HIDDEN, "one-sample blip never shows the banner");

		// ④ 「刚连上又断」不闪：已显示时 3 次假才隐藏；中间的 1 次真把假计数清零（重新数 3 次）
		ReconnectBanner.Debouncer flappy = new ReconnectBanner.Debouncer();
		feedAll(flappy, T, T, F, F, T, F, F);
		check(flappy.state() == ReconnectBanner.State.SHOWN,
			"false-run interrupted by one true does not hide (counter restarts)");
		flappy.feed(F);
		check(flappy.state() == ReconnectBanner.State.HIDDEN,
			"three falses after the interruption do hide");

		// ⑤ 导航期 UNKNOWN 不推进计数：真/未知/真 不足两次「连续」真
		ReconnectBanner.Debouncer nav = new ReconnectBanner.Debouncer();
		feedAll(nav, T);
		check(nav.state() == ReconnectBanner.State.HIDDEN, "true then UNKNOWN is not enough");
		nav.feed(U);
		nav.feed(T);
		check(nav.state() == ReconnectBanner.State.HIDDEN, "UNKNOWN breaks the run of trues");
		nav.feed(T);
		check(nav.state() == ReconnectBanner.State.SHOWN, "two trues after the gap do show");

		// ⑥ onPageCommitVisible ⇒ reset()：立即隐藏 + 清零
		ReconnectBanner.Debouncer navReset = new ReconnectBanner.Debouncer();
		feedAll(navReset, T, T);
		check(navReset.state() == ReconnectBanner.State.SHOWN, "shown before page commit");
		navReset.reset();
		check(navReset.state() == ReconnectBanner.State.HIDDEN, "reset() hides immediately");
		navReset.feed(T);
		check(navReset.state() == ReconnectBanner.State.HIDDEN,
			"reset() also zeroes the streak (one true after commit is not enough)");

		// ⑦ 断开前不常驻：一直健康 ⇒ 恒隐藏（不显示也不会在恢复后残留计数）
		ReconnectBanner.Debouncer healthy = new ReconnectBanner.Debouncer();
		feedAll(healthy, F, F, F, F, F, F, F, F, F, F);
		check(healthy.state() == ReconnectBanner.State.HIDDEN, "healthy page never shows the banner");

		// ⑧ 负控制友好的可注入阈值：1 真即显示 / 1 假即隐藏（真实实现用默认构造器）
		ReconnectBanner.Debouncer injected = new ReconnectBanner.Debouncer(1, 1);
		injected.feed(T);
		check(injected.state() == ReconnectBanner.State.SHOWN, "injected showStreak=1 shows on first true");
		injected.feed(F);
		check(injected.state() == ReconnectBanner.State.HIDDEN, "injected hideStreak=1 hides on first false");

		// ⑨ 官方可见性判据：必须真的在视口内
		check(ReconnectBanner.isOnScreen(12, 47, 88, 23, 411, 800), "element inside viewport is on screen");
		check(!ReconnectBanner.isOnScreen(-320, 47, 300, 23, 411, 800),
			"sidebar collapsed with left:-320px has layout boxes but is NOT on screen");
		check(!ReconnectBanner.isOnScreen(0, 900, 100, 20, 411, 800), "element below the fold is not on screen");
		check(!ReconnectBanner.isOnScreen(10, 10, 0, 20, 411, 800), "zero-width box is not on screen");
		check(!ReconnectBanner.isOnScreen(10, 10, 20, 20, 0, 0), "no viewport size means not on screen");

		// ⑩ 抑制判据（T86：判据对象 = 横幅**带区**，不是横幅当前 rect）
		//    带区取自 T83 §3 的手机档真值：系统栏底边 128px、横幅实高 92px ⇒ 带区 (0,128,1080,92)。
		//    ① 官方那条「可见且压在带区内」⇒ 不抑制（**首次显示也不自锁**，T86 缺口②的关键一条）
		check(!ReconnectBanner.shouldSuppress(true, 29, 135, 299, 92, 0, 128, 1080, 92),
			"official status inside the banner band does NOT suppress it (no self-lock on first show)");
		//    ② 官方那条「可见且不与带区重叠」（T83 实测 y=337 落在 128–220 之下）⇒ 抑制
		check(ReconnectBanner.shouldSuppress(true, 29, 337, 299, 92, 0, 128, 1080, 92),
			"official status on screen and clear of the band suppresses it");
		//    ③ 官方那条在视口外 / 不可见 ⇒ 不抑制
		check(!ReconnectBanner.shouldSuppress(false, 29, 337, 299, 92, 0, 128, 1080, 92),
			"official status off screen never suppresses the banner");
		//    边界：恰好压在带区底边（ey == bandBottom）算不重叠
		check(ReconnectBanner.shouldSuppress(true, 29, 220, 299, 92, 0, 128, 1080, 92),
			"an element starting exactly at the band bottom is not an overlap");
		check(!ReconnectBanner.shouldSuppress(true, 29, 219, 299, 92, 0, 128, 1080, 92),
			"an element ending one pixel inside the band is an overlap");
		//    负控制（缺口② 的自锁本体）：把**未布局横幅的 0 矩形**当带区输入 ⇒ 恒判「不重叠」⇒ 恒抑制。
		//    这一条把「判据对象必须是带区、不能是横幅当前 rect」钉死在断言里：
		//    谁把实现换回 0 矩形（或让 bandHeightPx 返回 0），①与这条的差就没了。
		check(ReconnectBanner.shouldSuppress(true, 29, 135, 299, 92, 0, 0, 0, 0),
			"negative control: feeding the not-yet-laid-out 0x0 banner rect suppresses forever (the T83 §5 self-lock)");

		// ⑪ 探针是只读的：不得出现任何写 DOM / 写全局的 API
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

		// ⑫ 文案同源（断言 7）：探针正则 === hook 的 RECONNECT_STATUS_RE
		check(ReconnectBanner.STATUS_RE_JS.equals(
				"/^(?:正在重新连接|重新连接中|正在重连中|正在重连|重连中|reconnecting)[\\.\u2026]{0,3}$/i"),
			"STATUS_RE_JS is the hook's regex, character for character");
		check(probe.contains("var FULL=" + ReconnectBanner.STATUS_RE_JS + ";"),
			"probe uses STATUS_RE_JS as its single source");

		// ⑬ T86 缺口②：带区高度（未布局横幅 ⇒ 按内容测量 ⇒ 40dp 兜底，永不返回 0）
		check(ReconnectBanner.bandHeightPx(92, 0, 105) == 92,
			"band height prefers the laid-out banner height");
		check(ReconnectBanner.bandHeightPx(0, 88, 105) == 88,
			"band height falls back to the measured content height before the constant");
		check(ReconnectBanner.bandHeightPx(0, 0, 105) == 105,
			"band height falls back to the fallback constant when nothing measures");
		check(ReconnectBanner.bandHeightPx(0, 0, 0) == 1,
			"band height never returns 0 (a 0-height band would self-lock again)");
		check(ReconnectBanner.BAND_FALLBACK_DP >= 24,
			"fallback band is at least one text line tall");

		// ⑭ T86 缺口①：探针的**匹配字面量**抽出来真跑（不是只查子串）
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
			"NEGATIVE disconnected 文案不匹配（横幅文案是「重新连接中」，认它就会说错话）");
		check(!full.matcher("正在重新连接中").matches(),
			"NEGATIVE prefix-extended copy does not match (no partial matching)");

		// ⑮ T86：两层的**结构语义**（谁能认、谁必须排除）
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

		// ⑰ T90：层 1 的 ⑤ **composer 祖先否决**（收口 T88 遗留的那处两端差异）。
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

		// ⑯ T86 缺口②：MainActivity 侧的判据来源（有路径参数时才查）
		if (args.length > 1 && args[1] != null && !args[1].isEmpty()) {
			Path mainSrc = Paths.get(args[1]);
			check(Files.isRegularFile(mainSrc), "MainActivity source exists: " + mainSrc);
			String main = new String(Files.readAllBytes(mainSrc), StandardCharsets.UTF_8);
			String osd = javaMethodBody(main, "private String officialStatusDetail(JSONObject o)");
			check(osd.contains("readSystemBarInsetsPx()"),
				"MainActivity builds the suppression band from the same system-bar insets as the banner margins");
			check(osd.contains("ReconnectBanner.bandHeightPx("),
				"MainActivity takes the band height from ReconnectBanner.bandHeightPx (not from the live rect)");
			check(!osd.contains("reconnectBanner.getWidth()"),
				"MainActivity no longer feeds the live banner rect (0x0 while GONE) into shouldSuppress");
			String hpr = javaMethodBody(main, "private void handleReconnectProbe(String value)");
			check(hpr.contains("probeLogKey("),
				"handleReconnectProbe 用 probeLogKey 去重（只比观测值会让 SUPPRESS 在现场不可见）");
			String keyFn = javaMethodBody(main,
				"private static String probeLogKey(ReconnectBanner.Observed observed, String detail)");
			check(keyFn.contains("verdict") && keyFn.contains("src="),
				"probeLogKey 把抑制判定与匹配层算进去重键");
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
