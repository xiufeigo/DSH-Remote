package top.d1studio.dshremote;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * T94「系统栏沉浸」源码契约测试（纯 JVM，不需要模拟器/设备）。
 *
 * <p>判据分三组，都只读 MainActivity.java：
 * <ol>
 *   <li><b>只读取值（零注入）</b>：{@code PAGE_BG_PROBE_JS} 里不得出现任何 DOM/CSS/存储写 API
 *       （setAttribute / appendChild / innerHTML / classList / style. / localStorage / setTimeout …）；
 *       必须用 {@code elementFromPoint} + {@code getComputedStyle} 读，且**返回对象**而不是 JSON 字符串
 *       （字符串会被 evaluateJavascript 再编码一层，{@code new JSONObject(value)} 直接抛）。</li>
 *   <li><b>三条一致 + 回退路径</b>：{@code rootLayout} 用 {@code strip}；窗口状态栏/导航栏也用同一取值；
 *       {@code sessionBarColor()} 在取不到时逐值退回改动前的 {@code dark ? 0xFF141414 : Color.WHITE}。</li>
 *   <li><b>不回归 T80</b>：让位仍写 WebView 的**布局盒**（{@code lp.setMargins(left, top, right, bottom)}），
 *       四向仍来自 {@code readSystemBarInsetsPx()}。</li>
 * </ol>
 *
 * <p>用法：{@code java ... T94ImmersiveTest <MainActivity.java 路径>}
 */
public final class T94ImmersiveTest {

	private static int passed = 0;

	private static void check(boolean cond, String what) {
		if (!cond) throw new AssertionError(what);
		passed++;
		System.out.println("ok " + what);
	}

	private static String read(String path) throws IOException {
		return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
	}

	/** 取出一个 Java 字符串常量字面量（从 `NAME = "` 到该语句结束的 `";`）。 */
	private static String literal(String src, String name) {
		int at = src.indexOf(name);
		if (at < 0) return "";
		int from = src.indexOf('"', at);
		if (from < 0) return "";
		int to = src.indexOf("\";", from);
		return to < 0 ? "" : src.substring(from, to);
	}

	/** 取一个方法体（从 `signature` 后的第一个 `{` 到括号配平处），够用即可。 */
	private static String methodBody(String src, String signature) {
		int at = src.indexOf(signature);
		if (at < 0) return "";
		int open = src.indexOf('{', at);
		if (open < 0) return "";
		int depth = 0;
		for (int i = open; i < src.length(); i++) {
			char c = src.charAt(i);
			if (c == '{') depth++;
			else if (c == '}') {
				depth--;
				if (depth == 0) return src.substring(open, i + 1);
			}
		}
		return "";
	}

	public static void main(String[] args) throws Exception {
		if (args.length < 1) {
			System.err.println("usage: T94ImmersiveTest <MainActivity.java>");
			System.exit(2);
		}
		String src = read(args[0]);
		System.out.println("== T94 immersive source contract： " + args[0]);

		// ── 1. 只读探针 ────────────────────────────────────────────────
		String probe = literal(src, "PAGE_BG_PROBE_JS = ");
		check(probe.length() > 200, "probe literal extracted (len=" + probe.length() + ")");
		String[] writeTokens = {
			"setAttribute", "removeAttribute", "appendChild", "insertBefore", "removeChild",
			"innerHTML", "outerHTML", "classList", "createElement", "createTextNode",
			"document.write", "textContent", "localStorage", "sessionStorage",
			"setTimeout", "setInterval", "addEventListener", "dispatchEvent", "MutationObserver",
			"postMessage", "eval(", "document.cookie", ".style.", "reload(",
		};
		for (String tok : writeTokens) {
			check(probe.indexOf(tok) < 0, "probe never touches write/trace API: " + tok);
		}
		check(probe.contains("elementFromPoint"), "probe samples through elementFromPoint (read-only)");
		check(probe.contains("getComputedStyle"), "probe reads computed background-color (read-only)");
		check(probe.contains("parentElement"), "probe walks ancestors to composite the painted colour");
		check(probe.contains("return {t:t") || probe.contains("return {t:t,"),
			"probe returns an OBJECT literal (not a JSON string: double-encoding would break JSONObject)");
		check(probe.contains("innerHeight"), "probe derives the bottom sample from the viewport height");
		check(probe.contains("data-ds-dark-theme"),
			"probe reads the official dark marker (same first-order signal as the hook's syncPageTheme)");

		// ── 2. 三条一致 + 回退 ────────────────────────────────────────
		check(src.contains("int strip = sessionBarColor(dark);"),
			"applySystemBars takes ONE strip colour from sessionBarColor(dark)");
		String bars = methodBody(src, "private void applySystemBars()");
		check(bars.length() > 500, "applySystemBars body extracted");
		check(bars.contains("rootLayout.setBackgroundColor(session"), "rootLayout is painted with the strip colour");
		check(bars.contains("? strip :"), "rootLayout (and WebView) use `strip`");
		check(bars.contains("setStatusBarColor(strip") || bars.contains("setStatusBarColor(sampled ? strip"),
			"window status bar colour is synced to the same value");
		check(bars.contains("setNavigationBarColor(nav)"), "window navigation bar colour is still applied");
		check(bars.contains("int nav = sampled ? pageBgBottom"), "navigation bar colour comes from the sampled page colour");
		String pick = methodBody(src, "private int sessionBarColor(boolean dark)");
		check(pick.contains("pageBgTop"), "sessionBarColor returns the sampled page colour when available");
		check(pick.contains("0xFF141414") && pick.contains("Color.WHITE"),
			"sessionBarColor falls back value-for-value to the pre-T94 hardcoded colour when no sample");
		check(pick.contains("PAGE_BG_NONE"), "sessionBarColor treats the missing sample as PAGE_BG_NONE");

		// ── 3. 跟随与生命周期 ─────────────────────────────────────────
		check(src.contains("PAGE_BG_POLL_INTERVAL_MS"), "a poll interval constant exists");
		check(src.contains("startPageBgPolling();") && src.contains("stopPageBgPolling();"),
			"poll is started and stopped (onResume / onPause)");
		String onPause = methodBody(src, "protected void onPause()");
		check(onPause.contains("stopPageBgPolling();"), "onPause stops the page-background poll");
		String onResume = methodBody(src, "protected void onResume()");
		check(onResume.contains("startPageBgPolling();") && onResume.contains("requestPageBackground();"),
			"onResume restarts the poll and re-reads once");

		// ── 4. T80 让位不回归 ─────────────────────────────────────────
		String box = methodBody(src, "private void setWebViewInsetsBox(");
		check(box.contains("lp.setMargins(left, top, right, bottom)"),
			"T80: avoidance still lands on the WebView layout box (margins)");
		String apply = methodBody(src, "private void applyDeviceClassInsets()");
		check(apply.contains("readSystemBarInsetsPx()"),
			"T80: the four-way avoidance still consumes readSystemBarInsetsPx()");
		check(apply.indexOf("webView.setPadding(") < 0,
			"T80: no regression to webView.setPadding (proven ineffective in T80)");

		System.out.println("T94 immersive tests passed: " + passed);
	}
}
