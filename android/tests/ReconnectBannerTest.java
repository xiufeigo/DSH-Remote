package top.d1studio.dshremote;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * T78：重连横幅状态机与判据的 JVM 行为测试（无模拟器）。
 *
 * <p>钉死四件事：
 * <ol>
 *   <li><b>防抖状态机</b>：连续 {@value top.d1studio.dshremote.ReconnectBanner#SHOW_STREAK} 次真才显示、
 *       连续 {@value top.d1studio.dshremote.ReconnectBanner#HIDE_STREAK} 次假才隐藏；{@code UNKNOWN}
 *       （导航期）不参与计数；{@code reset()} 立即清零。</li>
 *   <li><b>抑制判据</b>：官方那条"可见"必须是**真的在视口里**（侧栏 {@code left:-320px} 收起时
 *       {@code getClientRects().length > 0} 但用户看不见），且不与横幅矩形重叠。</li>
 *   <li><b>探针只读</b>：{@code PROBE_JS} 里不得出现任何写 DOM / 写全局的 API
 *       （平板档零痕迹是硬契约）。</li>
 *   <li><b>文案同源</b>：探针正则与 hook 的 {@code RECONNECT_STATUS_RE}
 *       （{@code packages/gateway/assets/mobile-web.js}）逐字符一致；上游换文案时这条先红。</li>
 * </ol>
 *
 * 用法：{@code java ... ReconnectBannerTest [<仓库根>/packages/gateway/assets/mobile-web.js]}
 * （第 1 个参数缺省时跳过第 4 项，其余照跑。）
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

		// ⑩ 抑制判据：官方可见且不被横幅压住才抑制
		//    横幅矩形 = (0, 24, 411, 30)（状态栏 24px 之下）
		check(ReconnectBanner.shouldSuppress(true, 8, 60, 100, 24, 0, 24, 411, 30),
			"official status on screen and below the banner suppresses it");
		check(!ReconnectBanner.shouldSuppress(false, 8, 60, 100, 24, 0, 24, 411, 30),
			"official status off screen does not suppress");
		check(!ReconnectBanner.shouldSuppress(true, 8, 30, 100, 24, 0, 24, 411, 30),
			"overlapping official status does not suppress (banner would cover it)");
		check(ReconnectBanner.shouldSuppress(true, 0, -50, 100, 24, 0, 24, 411, 30),
			"element straddling the viewport edge but not under the banner still suppresses");

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
