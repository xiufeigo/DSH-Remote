package top.d1studio.dshremote;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * T96：{@link StuckRescue} 的 JVM 行为测试（无模拟器）+ MainActivity 接线源码契约。
 *
 * <p>为什么必须有它：这条修复的**全部风险**都在"什么时候敢动手"上——
 * 太早（健康态乱踹、把正在睡的退避打断、把手机档 hook 的自愈抢掉）比不修更糟。
 * 这个类是纯状态机，可以在这里把**时间线**逐毫秒喂进去，把每一道闸钉死；
 * 设备侧真机只跑"确实按这个时间线动了"的终审（见 scratch/t96/report.md §4/§6）。
 *
 * <p>用法：{@code java ... StuckRescueTest <MainActivity.java 路径>}
 */
public final class StuckRescueTest {

	private static int checks = 0;
	private static int failed = 0;

	private static void ok(String name, boolean cond, String detail) {
		checks++;
		if (cond) {
			System.out.println("ok   " + name + (detail.isEmpty() ? "" : "  [" + detail + "]"));
		} else {
			failed++;
			System.out.println("FAIL " + name + "  " + detail);
		}
	}

	private static void eq(String name, Object want, Object got) {
		ok(name, want == null ? got == null : want.equals(got), "want=" + want + " got=" + got);
	}

	public static void main(String[] args) throws Exception {
		// ── ① 健康态：零动作（这是"不误触发"的结构性保证）────────────────────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t = 1_000_000L;
			List<StuckRescue.Action> acts = new ArrayList<>();
			for (int i = 0; i < 100; i++) acts.add(d.observe(StuckRescue.Observed.OK, t += 500, false));
			ok("健康态 100 拍全 NONE（零动作）", acts.stream().allMatch(a -> a == StuckRescue.Action.NONE), acts.toString());
			eq("健康态 nudges=0", 0, d.nudges());
			eq("健康态 reloads=0", 0, d.reloads());
		}

		// ── ② 读不到页面（UNKNOWN）：既不动手、也不累计、也不复位 ────────────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t = 5_000_000L;
			StuckRescue.Action a1 = d.observe(StuckRescue.Observed.UNKNOWN, t, false);
			StuckRescue.Action a2 = d.observe(StuckRescue.Observed.UNKNOWN, t + 60_000, false);
			eq("UNKNOWN ⇒ NONE #1", StuckRescue.Action.NONE, a1);
			eq("UNKNOWN ⇒ NONE #2（不会攒成断开）", StuckRescue.Action.NONE, a2);
			eq("UNKNOWN 不消耗配额", 0, d.nudges());
		}

		// ── ③ 平板档（hookLive=false）：首次观测即温和层动手（回前台首次不等长间隔）──
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t = 10_000_000L;
			d.onForeground();
			eq("平板档 首次观测 ⇒ NUDGE（0ms，不等 8s/12s）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t, false));
			eq("同一拍再来一次仍在 8s 间隔内 ⇒ NONE",
				StuckRescue.Action.NONE, d.observe(StuckRescue.Observed.RECONNECTING, t + 500, false));
		}

		// ── ④ 平板档时间线：0s NUDGE → 8s NUDGE → 12s RELOAD（十几秒内升级）───────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 20_000_000L;
			d.onForeground();
			eq("t+0s ⇒ NUDGE（回前台第一拍立刻动）", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0, false));
			eq("t+7.9s（间隔未满 8s）⇒ NONE", StuckRescue.Action.NONE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 7_900, false));
			eq("t+8s ⇒ NUDGE（温和层第二次）", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 8_000, false));
			eq("t+11.9s ⇒ NONE（温和层配额满、还没到 12s）", StuckRescue.Action.NONE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 11_900, false));
			eq("t+12s ⇒ RELOAD（试过两次温和、仍卡满 12s ⇒ 受控重载）",
				StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 12_000, false));
			eq("重载 1 次后配额用掉 1", 1, d.reloads());
			eq("受控重载后 episode 重新起算（stuckFor 归零，供下一轮从 0 计时）", 0L, d.stuckForMs(t0 + 12_000));
		}

		// ── ⑤ 防风暴：重载配额 2 次 + 60s 间隔；到顶后彻底不动 ────────────────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 30_000_000L;
			d.onForeground();
			eq("①0s NUDGE", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0, false));
			eq("②8s NUDGE", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 8_000, false));
			eq("③12s RELOAD#1", StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 12_000, false));
			// 重载后新文档：episode 重开（模拟 onPageCommitVisible 的通知）
			d.onDocumentChanged();
			eq("④新文档首拍 ⇒ NUDGE（温和层重开，不是又 reload）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 13_000, false));
			StuckRescue.Action at40 = d.observe(StuckRescue.Observed.RECONNECTING, t0 + 40_000, false);
			ok("⑤t+40s 仍卡：间隔未到 ⇒ 绝不是 RELOAD（60s 硬闸）",
				at40 != StuckRescue.Action.RELOAD, "got=" + at40);
			eq("⑥t+71s（距上次重载 59s）⇒ 仍不是 RELOAD",
				StuckRescue.Action.NONE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 71_000, false));
			eq("⑦t+72s（距上次重载 60s）⇒ RELOAD#2",
				StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 72_000, false));
			d.onDocumentChanged();
			// 配额用尽：重载永不再来；温和层次数也被 (MAX_RELOADS+1)×MAX_NUDGES 上界钉住
			boolean neverReload = true;
			int gentle = 0;
			long t = t0 + 73_000;
			for (int i = 0; i < 200; i++) {
				StuckRescue.Action a = d.observe(StuckRescue.Observed.RECONNECTING, t += 3_000, false);
				if (a == StuckRescue.Action.RELOAD) neverReload = false;
				if (a == StuckRescue.Action.NUDGE) gentle += 1;
			}
			ok("⑧配额用尽后 200 拍（10 分钟）绝不重载", neverReload, "reloads=" + d.reloads());
			ok("⑨温和层总数被 (MAX_RELOADS+1)×MAX_NUDGES 上界钉住",
				gentle <= 2 * StuckRescue.MAX_NUDGES, "gentle=" + gentle);
			ok("⑩exhausted() 为真", d.exhausted(), "nudges=" + d.nudges() + " reloads=" + d.reloads());
			// 恢复 ⇒ 复位
			eq("恢复后一拍 ⇒ NONE", StuckRescue.Action.NONE, d.observe(StuckRescue.Observed.OK, t + 500, false));
		}

		// ── ⑥ 手机档（hookLive=true）：温和层让位，升级阈值抬到 25s ──────────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 40_000_000L;
			d.onForeground();
			boolean anyNudge = false;
			for (int i = 0; i <= 48; i++) {
				StuckRescue.Action a = d.observe(StuckRescue.Observed.RECONNECTING, t0 + i * 1_000L, true);
				if (a == StuckRescue.Action.NUDGE) anyNudge = true;
				if (a == StuckRescue.Action.RELOAD) {
					eq("手机档 首次 RELOAD 落在 25s（hook 先跑，原生不抢）", 25_000L, i * 1_000L);
					break;
				}
			}
			ok("手机档 24s 内一次 NUDGE 都不推（不与 hook 自愈重复推进）", !anyNudge, "anyNudge=" + anyNudge);
		}

		// ── ⑦ 回前台**重新起算**：后台 5 分钟不会让回前台第一拍变成重载 ──────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 50_000_000L;
			d.onForeground();
			d.observe(StuckRescue.Observed.RECONNECTING, t0, false);            // NUDGE#1
			d.observe(StuckRescue.Observed.RECONNECTING, t0 + 8_000, false);    // NUDGE#2（配额已满）
			// 用户退后台 5 分钟（期间没有任何探针），回来
			d.onForeground();
			eq("回前台第一拍 ⇒ NUDGE（不是 RELOAD：episode 已重新起算、温和层配额也重开）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 300_000, false));
			eq("回前台 +8s ⇒ NUDGE（温和层第二次）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 308_000, false));
			eq("回前台 +12s ⇒ 才升级 RELOAD（十几秒，不是后台那 5 分钟）",
				StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 312_000, false));
		}

		// ── ⑧ 断开途中读到健康 ⇒ episode 复位（下次断要从头走一遍闸）───────────────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 60_000_000L;
			d.onForeground();
			d.observe(StuckRescue.Observed.RECONNECTING, t0, false);
			d.observe(StuckRescue.Observed.OK, t0 + 1_000, false);
			d.onForeground();
			eq("恢复后再断：第一拍就是 NUDGE（已复位，没有残留计数）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 2_000, false));
			eq("恢复后 reloads 不因 episode 复位而清零（跨文档配额仍在）", 0, d.reloads());
		}

		// ── ⑬ 链路探针说不通 ⇒ 撤回重载意图（配额/间隔回滚，链路回来后第一拍就能动）────
		{
			StuckRescue.Decider d = new StuckRescue.Decider();
			long t0 = 70_000_000L;
			d.onForeground();
			eq("①0s NUDGE", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0, false));
			eq("②8s NUDGE", StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 8_000, false));
			eq("③12s 重载意图（此时原生才去查链路）", StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 12_000, false));
			eq("④意图已消耗 1 次配额", 1, d.reloads());
			ok("⑤reloadedSinceDown 置位", d.reloadedSinceDown(), "");
			d.abortReload();
			eq("⑥撤回后配额回滚成 0（断链期间不白烧）", 0, d.reloads());
			ok("⑦reloadedSinceDown 复位", !d.reloadedSinceDown(), "");
			eq("⑧链路回来后第一拍 ⇒ 立刻 NUDGE（episode 已归零）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 20_000, false));
			eq("⑨链路回来自动走第二轮温和层（+12s 时先补第二次 nudge）",
				StuckRescue.Action.NUDGE, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 32_000, false));
			eq("⑩再下一拍 ⇒ 又能提出重载（没有被 60s 间隔锁死）",
				StuckRescue.Action.RELOAD, d.observe(StuckRescue.Observed.RECONNECTING, t0 + 32_500, false));
		}

		// ── ⑨ 常量口径（写进报告的那几个数字，别被后人悄悄改）─────────────────────
		eq("TIER1_AFTER_MS", 1500, StuckRescue.TIER1_AFTER_MS);
		eq("TIER2_AFTER_MS", 12000, StuckRescue.TIER2_AFTER_MS);
		eq("TIER2_AFTER_HOOK_MS", 25000, StuckRescue.TIER2_AFTER_HOOK_MS);
		eq("MAX_NUDGES", 2, StuckRescue.MAX_NUDGES);
		eq("MAX_RELOADS", 2, StuckRescue.MAX_RELOADS);
		eq("RELOAD_MIN_INTERVAL_MS", 60000, StuckRescue.RELOAD_MIN_INTERVAL_MS);

		// ── ⑩ 温和层脚本：只派事件（禁词表与 PROBE_JS 同一套纪律）─────────────────
		{
			String js = StuckRescue.NUDGE_JS;
			String[] forbidden = {"appendChild", "insertBefore", "setAttribute", "removeAttribute",
				"innerHTML", "classList", "createElement", "document.write", "localStorage",
				"setTimeout", "setInterval", "location", "cookie", "fetch", "reload"};
			for (String f : forbidden) {
				ok("NUDGE_JS 不含禁词 " + f, !js.contains(f), "");
			}
			ok("NUDGE_JS 是 offline→online 瞬态对",
				js.contains("dispatchEvent(new Event('offline'))") && js.contains("dispatchEvent(new Event('online'))"), js);
		}

		// ── ⑪ 纯逻辑：不引 Android 运行时（否则 JVM 臂自己就跑不起来）───────────────
		{
			String selfPath = args.length > 1 ? args[1] : "android/app/src/main/java/top/d1studio/dshremote/StuckRescue.java";
			String src = new String(Files.readAllBytes(Paths.get(selfPath)), StandardCharsets.UTF_8);
			ok("StuckRescue 不 import android.*", !src.contains("import android."), "");
			ok("StuckRescue 不 import 任何类", !src.contains("\nimport "), "");
		}

		// ── ⑫ MainActivity 接线源码契约（探针输入不许被换成"抑制后"的值）───────────
		if (args.length > 0) {
			String main = new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8);
			ok("接线：自救判定吃**原始真相** pageReconnecting",
				main.contains("boolean pageReconnecting = false;")
					&& main.contains("pageReconnecting = true;")
					&& main.contains("runStuckRescue(pageReconnecting, observed);"), "");
			ok("接线：回前台重新起算 stuckRescue.onForeground()",
				main.contains("stuckRescue.onForeground();"), "");
			ok("接线：新文档重开 episode stuckRescue.onDocumentChanged()",
				main.contains("stuckRescue.onDocumentChanged();"), "");
			ok("接线：受控重载拦在会话页上（isSessionUrl + 无主框架失败）",
				main.contains("if (!isSessionUrl(url) || isLocalShellUrl(url)) return;")
					&& main.contains("if (!failedMainFrameUrl.isEmpty()) return;"), "");
			ok("接线：受控重载是 WebView.reload()（不是 loadUrl 换地址）",
				main.contains("webView.reload();"), "");
			ok("接线：hook 在场判据含 hookConnState 非空",
				main.contains("return !isTabletClass() && hookConnState != null;"), "");
			ok("接线：重载意图先走链路探针（startRescueLinkProbe + rescueReloadArmed）",
				main.contains("rescueReloadArmed = true;") && main.contains("startRescueLinkProbe();")
					&& main.contains("private void startRescueLinkProbe()")
					&& main.contains("private void onRescueLinkProbe(boolean ok, int status)"), "");
			ok("接线：链路探针走既有 PinnedFetch（不新开网络栈、继承 pin 与并发闸门）",
				main.contains("PinnedFetch.get(healthUrl, host") && main.contains("/__dsh_remote__/health"), "");
			ok("接线：链路不通时撤回（abortReload）而不是硬重载",
				main.contains("stuckRescue.abortReload();"), "");
			// 反向：受控重载的方法体里**不许**出现换地址/清历史/清存储这类动作
			{
				int at = main.indexOf("private void runStuckReload()");
				String body = at < 0 ? "" : main.substring(at, Math.min(main.length(), at + 2200));
				int end = body.indexOf("\n\tprivate ");
				if (end > 0) body = body.substring(0, end);
				ok("runStuckReload 方法体不含 loadUrl/clearCache/clearHistory/removeItem",
					!body.contains("loadUrl(") && !body.contains("clearCache") && !body.contains("clearHistory")
						&& !body.contains("removeItem"), "");
				ok("runStuckReload 方法体只在会话页上重载",
					body.contains("isSessionUrl(url)") && body.contains("webView.reload()"), "");
				ok("runStuckReload 方法体过了链路闸才动手",
					body.contains("if (!rescueLinkOk)") && body.indexOf("if (!rescueLinkOk)") < body.indexOf("webView.reload()"), "");
			}
		}

		System.out.println("\nStuckRescueTest: " + (checks - failed) + "/" + checks + " passed");
		if (failed > 0) System.exit(1);
	}

	/** 反射护栏：Decider 不许带任何静态状态（否则两个 Activity 会互相干扰）。 */
	@SuppressWarnings("unused")
	private static void assertNoStaticState() {
		for (Method m : StuckRescue.Decider.class.getDeclaredMethods()) {
			if (Modifier.isStatic(m.getModifiers())) throw new IllegalStateException("static method: " + m);
		}
	}
}
