package top.d1studio.dshremote;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * 返回键源码契约测试（纯 JVM，不需要模拟器/设备）。
 * 文件与类名沿用 T99 的名字（改动面最小），判据在 <b>T102</b> 之后钉的是**新语义**：
 * 「先关官方弹层/右栏 → 没有可关的 ⇒ 退到后台」，**不再**进 App 连接设置页。
 *
 * <p>判据四组，都只读 {@code MainActivity.java}：
 * <ol>
 *   <li><b>平板档分支存在且形状正确</b>：{@code handleAppBack()} 的 WEB 分支里，
 *       <b>先</b>按 {@code isTabletClass()} 分叉，平板档先跑只读探针
 *       {@code TABLET_BACK_OVERLAY_PROBE_JS}，拿到 {@code none} 才直接
 *       {@code finishWebBack()}（T102 起 = 会话根退后台），否则退回既有桥。**关键负例**：
 *       桥的字面量不得出现在平板判据<b>之前</b>（那正是 T99 之前"先关左抽屉"的形状）。</li>
 *   <li><b>探针只读且不看左抽屉</b>：探针里不得出现任何写/事件 API；也不得出现
 *       {@code isSidebarOpen} / {@code data-sidebar-collapsed} 等左抽屉判据
 *       —— 平板档返回键**连问都不问**左抽屉。</li>
 *   <li><b>右栏语义不许退</b>（T43/T47）：探针必须按官方右栏的展开标记
 *       （{@code [data-sidebar-right-panel]} + {@code data-sidebar-right-open} + {@code aria-hidden}）
 *       与模态弹框（{@code [role="dialog"][aria-modal="true"]}）判定，桥那条通道仍被调用；
 *       桥的 JS 字面量与 T99 之前**逐字相同**（收弹层通道一字未改）。</li>
 *   <li><b>T102 新语义 + 不回归 T94/T96</b>：{@code finishWebBack()} 末尾是
 *       {@code moveTaskToBack(true)} 且**不**调用 {@code showConnectionSettings()}；
 *       {@code settingsViaBackKey} 字段与其置位/清零/消费点**全部删除**（无死代码）；
 *       设置页文案**只有一句**、不再承诺系统返回键；{@code showConnectionSettings()} 本身
 *       仍在（它还有别的调用点，不许被误删）；T94（{@code PAGE_BG_PROBE_JS} /
 *       {@code dshr-immersive}）与 T96（{@code StuckRescue} / {@code handleReconnectProbe} /
 *       {@code RELOAD_ARM_TIMEOUT_MS}）的标记仍在。</li>
 * </ol>
 *
 * <p>行为臂（探针在 DOM 桩上真跑）见 {@code android/tests/t99-probe-dom-stub.mjs}
 * 与 {@code android/test-backkey.ps1} 臂②。
 *
 * <p>用法：{@code java ... T99BackKeyTest <MainActivity.java 路径>}
 */
public final class T99BackKeyTest {

	private static int passed = 0;

	private static void check(boolean cond, String what) {
		if (!cond) throw new AssertionError(what);
		passed++;
		System.out.println("ok " + what);
	}

	private static String read(String path) throws IOException {
		return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
	}

	/** 取一个方法体（从 `signature` 后的第一个 `{` 到括号配平处）。 */
	private static String methodBody(String src, String signature) {
		return blockAfter(src, signature, '{', '}');
	}

	/** 取 `signature` 之后第一个 `open` 配平到对应 `close` 的整段（含两端）。 */
	private static String blockAfter(String src, String signature, char open, char close) {
		int at = src.indexOf(signature);
		if (at < 0) return "";
		int from = src.indexOf(open, at);
		if (from < 0) return "";
		int depth = 0;
		for (int i = from; i < src.length(); i++) {
			char c = src.charAt(i);
			if (c == open) depth++;
			else if (c == close) {
				depth--;
				if (depth == 0) return src.substring(from, i + 1);
			}
		}
		return "";
	}

	/**
	 * 把一个 Java **字符串拼接表达式**（{@code NAME = "a" + "b";}）还原成它的运行期取值。
	 * 只处理本文件用到的形态：双引号字面量 + {@code \"} 转义 + {@code +} 连接。
	 * 语句边界靠"**字符串外的**第一个分号"定（不能直接 indexOf(";")：JS 片段里全是分号）。
	 * 取不到返回 ""（调用方按"缺"处理 ⇒ 变红，不会假绿）。
	 */
	private static String stringConcat(String src, String name) {
		int at = src.indexOf(name);
		if (at < 0) return "";
		int i = src.indexOf('"', at);
		if (i < 0) return "";
		StringBuilder out = new StringBuilder();
		boolean inString = false;
		for (; i < src.length(); i++) {
			char c = src.charAt(i);
			if (!inString) {
				if (c == '"') inString = true;
				else if (c == ';') break; // 语句结束（此时不在字符串里）
				continue;
			}
			if (c == '\\' && i + 1 < src.length()) {
				out.append(src.charAt(i + 1));
				i++;
				continue;
			}
			if (c == '"') {
				inString = false;
				continue;
			}
			out.append(c);
		}
		return out.toString();
	}

	public static void main(String[] args) throws Exception {
		if (args.length < 1) {
			System.err.println("usage: T99BackKeyTest <MainActivity.java>");
			System.exit(2);
		}
		String src = read(args[0]);
		System.out.println("== T99 back-key source contract： " + args[0]);

		// ── 1. 平板档分支的形状 ───────────────────────────────────────────
		String back = methodBody(src, "private void handleAppBack()");
		check(back.length() > 400, "handleAppBack() 方法体抠出（len=" + back.length() + "）");

		int webAt = back.indexOf("uiState == UiState.WEB && webView != null");
		check(webAt > 0, "WEB 分支存在（返回键进会话页的唯一入口）");
		String web = back.substring(webAt);

		int tabletAt = web.indexOf("if (isTabletClass())");
		int bridgeAt = web.indexOf("window.__dshRemoteAndroidMobile");
		check(tabletAt > 0, "WEB 分支里有 isTabletClass() 分叉（平板档单独一条路径）");
		check(bridgeAt < 0 || bridgeAt > tabletAt,
			"平板判据之前没有无条件调桥（若桥字面量出现在 isTabletClass() 之前 ⇒ 变红：那正是"
				+ "T99 之前\"先关左抽屉\"的形状）");

		String tabletBlock = blockAfter(web, "if (isTabletClass())", '{', '}');
		check(tabletBlock.length() > 100, "平板档分支整体抠出（len=" + tabletBlock.length() + "）");
		int probeAt = tabletBlock.indexOf("TABLET_BACK_OVERLAY_PROBE_JS");
		int finishAt = tabletBlock.indexOf("finishWebBack()");
		int helperAt = tabletBlock.indexOf("closeOverlaysThenFinish()");
		check(tabletBlock.indexOf("evaluateJavascript(") > 0 && probeAt > tabletBlock.indexOf("evaluateJavascript("),
			"平板档分支内评估只读探针 TABLET_BACK_OVERLAY_PROBE_JS");
		check(tabletBlock.indexOf("closeSidebarIfExpanded") < 0,
			"平板档分支不直接调桥（左抽屉在平板档没有任何一次被收的可能）");
		check(finishAt > probeAt, "探针回话之后才有 finishWebBack()");
		check(helperAt > probeAt && helperAt > finishAt,
			"非 none 的回话才走既有桥 closeOverlaysThenFinish()（fail-safe 方向正确）");
		check(tabletBlock.indexOf("value != null && value.contains(\"none\")") > 0,
			"探针回话以 'none' 为唯一放行值");
		check(tabletBlock.indexOf(".equals(\"none\")") < 0,
			"回话是 JSON 字符串 ⇒ 必须 contains 判（equals 恒假 ⇒ 平板档永远进不了设置页）");

		// 平板分支结束之后，仍然是手机档那条**无条件**调桥的老路径。
		String afterTablet = web.substring(web.indexOf(tabletBlock) + tabletBlock.length());
		check(afterTablet.indexOf("closeOverlaysThenFinish();") > 0,
			"平板分支之外仍有 closeOverlaysThenFinish()（手机档路径逐字保留）");
		check(afterTablet.indexOf("closeOverlaysThenFinish();") < afterTablet.indexOf("super.onBackPressed()"),
			"手机档分支仍以 return 收尾（不会掉到 super.onBackPressed 退桌面）");

		// ── 2. 探针只读 + 不看左抽屉 ──────────────────────────────────────
		String probe = stringConcat(src, "TABLET_BACK_OVERLAY_PROBE_JS = ");
		check(probe.length() > 200, "探针字面量还原成功（len=" + probe.length() + "）");
		String[] writeTokens = {
			"setAttribute", "removeAttribute", "appendChild", "insertBefore", "removeChild",
			"innerHTML", "outerHTML", "classList", ".style.", "createElement", "createTextNode",
			"document.write", "textContent", "localStorage", "sessionStorage",
			"setTimeout", "setInterval", "addEventListener", "dispatchEvent", "MutationObserver",
			"postMessage", "eval(", "document.cookie", "reload(", ".click(", "focus(",
		};
		for (String tok : writeTokens) {
			check(probe.indexOf(tok) < 0, "探针从不碰写/事件/存储 API：" + tok);
		}
		check(probe.indexOf("querySelector") >= 0 && probe.indexOf("getAttribute") >= 0,
			"探针只用 querySelector/getAttribute 读官方标记");

		// T99 的核心结构性断言：探针**连问都不问**左抽屉。
		String[] drawerTokens = {
			"isSidebarOpen", "setSidebarOpen", "data-sidebar-collapsed", "sidebarCollapsed",
			"toggleSidebar", "openSidebarIfCollapsed",
		};
		for (String tok : drawerTokens) {
			check(probe.indexOf(tok) < 0, "探针从不读左抽屉判据（平板档返回键不看左抽屉）：" + tok);
		}

		// ── 3. 右栏 / 弹层语义仍在（T43/T47 不许退） ───────────────────────
		check(probe.indexOf("[data-sidebar-right-panel]") >= 0
				&& probe.indexOf("data-sidebar-right-open") >= 0,
			"探针用官方右栏展开标记（[data-sidebar-right-panel]+data-sidebar-right-open）");
		check(probe.indexOf("aria-hidden") >= 0,
			"探针用 aria-hidden 判定右栏真实展开态（与 hook isRightbarOpen 同口径）");
		check(probe.indexOf("[role=\"dialog\"][aria-modal=\"true\"]") >= 0,
			"探针覆盖模态弹框（桥的第 3 个分支，不许因 T99 丢语义）");
		check(probe.indexOf("[data-dshr-sheet-panel]") >= 0,
			"探针覆盖 sheet 面板（桥的第 1 个分支）");
		check(probe.indexOf("data-dshr-explorer-details") >= 0,
			"探针覆盖 Explorer 详情（桥的第 2 个分支）");
		check(probe.indexOf("getClientRects") >= 0,
			"探针可见性口径与 hook isVisible() 一致（getClientRects().length>0）");
		check(probe.indexOf("return 'none'") >= 0 && probe.indexOf("return 'overlay'") >= 0,
			"探针两个正常取值 none / overlay 都在");
		check(probe.indexOf("return 'error'") >= 0 && probe.indexOf("catch") >= 0,
			"探针异常自吞并回 'error'（原生按非 none 处理 ⇒ 退回既有桥）");

		// 桥的 JS 字面量必须逐字不变（手机档 / 平板档+弹层 共用，T43/T47 的通道）。
		String closeBody = methodBody(src, "private void closeOverlaysThenFinish()");
		check(closeBody.length() > 100, "closeOverlaysThenFinish() 方法体抠出");
		check(closeBody.contains(
			"(function(){var bridge=window.__dshRemoteAndroidMobile;"
				+ "return !!(bridge&&bridge.closeSidebarIfExpanded&&bridge.closeSidebarIfExpanded());})()"),
			"桥调用字面量与 T99 之前逐字相同（只搬位置，不改内容）");
		check(closeBody.contains("if (value == null || !value.contains(\"true\")) finishWebBack();"),
			"桥回话判据逐字保留（只有真的关了东西才吞掉返回键）");
		check(closeBody.contains("if (webView == null) return;"),
			"closeOverlaysThenFinish() 有自保空判（抽方法后不引 NPE）");

		// ── 4. T102 新语义（返回键不进设置页）+ 不回归 T94 / T96 ──────────
		check(src.indexOf("PAGE_BG_PROBE_JS") >= 0 && src.indexOf("dshr-immersive") >= 0,
			"T94 标记仍在（沉浸系统栏未被回退）");
		check(src.indexOf("StuckRescue") >= 0 && src.indexOf("handleReconnectProbe") >= 0
				&& src.indexOf("RELOAD_ARM_TIMEOUT_MS") >= 0,
			"T96 标记仍在（卡住自救未被回退）");

		// 4a. 「返回键 → 设置页」这条路必须**彻底消失**（手机档 / 平板档都消失）。
		String finish = methodBody(src, "private void finishWebBack()");
		check(back.indexOf("showConnectionSettings") < 0,
			"handleAppBack() 里没有任何 showConnectionSettings() 调用（返回键不再进设置页）");
		check(finish.length() > 100, "finishWebBack() 方法体抠出");
		check(finish.indexOf("showConnectionSettings") < 0,
			"finishWebBack() 不再调用 showConnectionSettings()（T65/T99 的「会话根进设置页」被本任务取消）");
		check(finish.indexOf("moveTaskToBack(true)") > 0,
			"★ finishWebBack() 末尾改为 moveTaskToBack(true)（会话根 ⇒ 退到后台）");
		check(finish.indexOf("moveTaskToBack(true)") > finish.indexOf("webView.clearHistory()"),
			"退后台在「没有同网关上一页可回」之后（goBack 语义仍在最前面）");
		check(finish.indexOf("isTabletClass()") < 0,
			"finishWebBack() 仍不按档位分叉（T65 的成果不许回退）");

		// 4b. settingsViaBackKey 的**全部**代码痕迹必须清掉（字段 + 置位 + 清零 + 消费），
		//     不留死代码。注释里提到历史名字是允许的（那是改动留痕），所以只钉代码形态。
		check(src.indexOf("private boolean settingsViaBackKey") < 0,
			"settingsViaBackKey 字段已删除（不再是死字段）");
		check(src.indexOf("settingsViaBackKey = ") < 0,
			"settingsViaBackKey 无任何赋值点（置位点与清零点一并删除）");
		check(src.indexOf("if (settingsViaBackKey)") < 0,
			"settingsViaBackKey 无任何消费点（HOME 分支的退后台判据已删）");

		// 4c. 设置页的返回键只剩「回会话」一条（不再有「本次由返回键进来」的分叉）。
		String homeBlock = blockAfter(back, "if (uiState == UiState.HOME)", '{', '}');
		String resumeBlock = blockAfter(homeBlock, "if (canResumeSession)", '{', '}');
		check(resumeBlock.length() > 20 && resumeBlock.indexOf("resumeSession();") > 0,
			"有活会话时设置页返回键 = resumeSession()（既有语义不变）");
		check(resumeBlock.indexOf("moveTaskToBack") < 0,
			"有活会话时设置页返回键不再退后台（D6.1 的死循环判据已随成因消失删除）");

		// 4d. 设置页文案：唯一一句、不再承诺系统返回键、不含已删字段的分叉。
		String settings = methodBody(src, "private void showConnectionSettings()");
		check(settings.indexOf("隧道仍在运行。点上方「返回当前会话」继续，无需重新连接。") >= 0,
			"设置页文案仍是那句「只承诺上方按钮」的原文");
		check(settings.indexOf("或系统返回键") < 0,
			"★ 设置页文案不再承诺系统返回键（T102 文案口径）");
		check(settings.indexOf("settingsViaBackKey") < 0,
			"设置页文案不再按「本次是不是返回键进来的」分两支");

		// 4e. showConnectionSettings() 本身**不许**被误删（它还有别的入口在用）。
		check(settings.length() > 100, "showConnectionSettings() 方法体抠出（功能保留）");
		check(src.indexOf("openSettings()") > 0 && src.indexOf("runOnUiThread(() -> showConnectionSettings());") > 0,
			"showConnectionSettings() 仍有其它入口（AppBridge.openSettings，T102 未动它）");

		System.out.println("\nback-key source contract (T99 shape + T102 semantics): " + passed + " passed, 0 failed");
	}
}
