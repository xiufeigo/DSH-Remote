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
		String hook = args.length >= 2 ? read(args[1]) : null;
		System.out.println("== T94 immersive source contract： " + args[0]
			+ (hook != null ? " + " + args[1] : ""));

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

		// ── 5. T115：让位改由页面承担（用户口径「系统栏走安卓原生透明 + 页面自己让位」）──
		// 这一组是 T115 新增的：它把「谁钉住了谁」写进断言——
		//   · 上面第 4 组钉「外边距仍是唯一能改布局盒的地方、且四向仍来自 readSystemBarInsetsPx」
		//     （即 T80 的取值本体不许退化）；
		//   · 本组钉「让位动作现在写的是 0 外边距 + 把四向交给页面」，两者缺一即红。
		// 改前那一版（让位落外边距）由 T115 明确废弃：外边距一缩，系统栏后面只剩父容器一种底色，
		// 而平板官方布局贴边那一行是两色 ⇒ 单色带必然在面板那侧留 ΔRGB=(6,5,4) 硬缝。
		check(apply.contains("setWebViewInsetsBox(0, 0, 0, 0)"),
			"T115: the avoidance writes ZERO layout-box margins (WebView covers the whole window)");
		check(apply.contains("writeInsetsToPage(webView"),
			"T115: the avoidance hands the four-way insets to the page (single page write entry)");
		check(apply.indexOf("setWebViewInsetsBox(left") < 0 && apply.indexOf("setWebViewInsetsBox(avoid") < 0,
			"T115: no path writes the four-way insets back onto the layout box (would double-inset)");
		String write = methodBody(src, "private void writeInsetsToPage(");
		check(write.contains("__dshRemoteInsets") && write.contains("s.set("),
			"T115: the page write goes through the existing __dshRemoteInsets.set channel (no new API)");
		check(write.contains("+ top + \",\" + bottom + \",\" + left + \",\" + right + \""),
			"T115: the page write carries all four directions (left/right added for cutout/landscape)");
		// 两个写点必须同源：平板档 applyInsetsToPage 也用 readSystemBarInsetsPx()，
		// 否则「谁后跑谁赢」——实测抓到过 statusBars(24px) 覆盖并集(36px)。
		String insetsToPage = methodBody(src, "private void applyInsetsToPage(");
		check(insetsToPage.contains("if (isTabletClass())") && insetsToPage.contains("readSystemBarInsetsPx()"),
			"T115: applyInsetsToPage uses the SAME source as the avoidance for the tablet class (no race between two writers)");
		check(insetsToPage.contains("getInsets(WindowInsets.Type.statusBars())")
			&& insetsToPage.contains("getInsets(WindowInsets.Type.navigationBars())"),
			"T115: the phone path keeps its verified statusBars/navigationBars source value-for-value");

		// ── 6. T115：系统栏「原生透明」字面一致（含 API 30–34 的形态） ──
		String barsInit = methodBody(src, "private void configureSystemBars()");
		check(barsInit.contains("setNavigationBarColor(Color.TRANSPARENT)"),
			"T115: configureSystemBars no longer paints the shell colour on the navigation bar");
		check(barsInit.indexOf("setNavigationBarColor(shellColor(") < 0,
			"T115: the literal setNavigationBarColor(shell_background) is gone (it contradicted 'native transparent')");
		check(barsInit.contains("setStatusBarColor(Color.TRANSPARENT)"),
			"T115: status bar is native-transparent too");
		check(barsInit.contains("setNavigationBarContrastEnforced(false)")
			&& barsInit.contains("setStatusBarContrastEnforced(false)"),
			"T115: contrast enforcement stays off (kept from before, no scrim over the page)");
		check(bars.contains("if (tabletSession) nav = Color.TRANSPARENT;"),
			"T115: in a tablet session the nav bar is genuinely transparent (page paints the band)");
		check(bars.contains("if (tabletSession) getWindow().setStatusBarColor(Color.TRANSPARENT);"),
			"T115: in a tablet session the status bar is genuinely transparent (page paints the band)");
		check(bars.contains("setSystemBarsAppearance(dark ? 0 : mask, mask)"),
			"T115: the pageDark / setSystemBarsAppearance icon-brightness logic is preserved");

		// ── 7. T115：hook 的平板作用域必须真的消费 --dshr-inset-* ──────────
		// 第 5/6 组只证明原生「把四向交给了页面」；消费者在 hook 里，缺了它页面也不会让位。
		if (hook != null && hook.length() > 1000) {
			check(hook.contains("--dshr-inset-left") && hook.contains("--dshr-inset-right"),
				"T115: hook writes/consumes the left/right inset variables too (cutout / landscape)");
			check(hook.contains("div:has(> [data-slot=\"main\"])"),
				"T115: tablet scope anchors the official columns structurally (single-level :has(), no hashed class)");
			check(hook.contains("'  padding-top: var(--dshr-inset-top, env(safe-area-inset-top, 0px)) !important;'"),
				"T115: the tablet scope pads with the SAME var(...) expression style as the phone scope");
			check(hook.contains("box-sizing: border-box !important;"),
				"T115: column padding is border-box (official columns are height:100% - otherwise they overflow)");
			check(hook.contains("html:not(.' + ROOT_CLASS + '):not(.dshr-official-inset)"),
				"T115: tablet scope selector unchanged in shape (still the minimal-hook carrier)");
			// 严格 OFF 不许再把 inset 变量挡在门外（那正是平板档四个变量为空的原因）
			int setAt = hook.indexOf("window.__dshRemoteInsets = {");
			int topAt = hook.indexOf("--dshr-inset-top", setAt);
			int strictAt = hook.indexOf("if (isStrictOff()) return;", setAt);
			check(setAt > 0 && topAt > setAt && (strictAt < 0 || strictAt > topAt),
				"T115: the strict-OFF early return no longer sits in front of the inset writes (tablet gets the vars)");
		} else {
			check(false, "T115: hook source missing (pass it as the 2nd arg from test-immersive.ps1)");
		}

		System.out.println("T94 immersive tests passed: " + passed);
	}
}
