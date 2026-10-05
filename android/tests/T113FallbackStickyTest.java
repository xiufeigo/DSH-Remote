package top.d1studio.dshremote;

import java.util.ArrayList;
import java.util.List;

/**
 * T113：打洞回落提速 + 粘性回落的 JVM 测试（不依赖设备/模拟器，纯源码语义）。
 *
 * <p>跑法见 scratch/t113/run-jvm-tests.ps1（android.jar 只当 classpath；
 * VisitorConfig.toToml()/TunnelPath 的判定与状态机都不碰 Android API）。
 *
 * <p>断言分五组：
 * <ol>
 *   <li><b>配置级"打洞仍会先试"</b>：打洞优先那一档生成的 toml 仍是
 *       "stcp 中转访客 + xtcp 打洞访客 + keepTunnelOpen + fallbackTo"这一套（一字未新），
 *       只有 {@code fallbackTimeoutMs} 从 5000 变成 800 —— 即**先试打洞这件事没被取消**，
 *       只是把"打不通时空等多久"压下来。</li>
 *   <li><b>只用中转那一档没有打洞痕迹</b>（T104 语义逐字保留，粘性复用的就是这一档）。</li>
 *   <li><b>粘性状态机</b>：连续 N 次失败才粘住；成功即解除；上下文（网络/配置组/策略）变化清零；
 *       停隧道不清零（同一次前台会话内"断开→再连接"不再白等），新隧道启动只把连续计数归零。</li>
 *   <li><b>诊断行真话</b>：粘住时第一段仍说用户的档位（打洞优先）、第二段如实说"已粘性回落中转"；
 *       没粘住时与 T104 逐字相同的文案不改；档位文案里的秒数取自实际超时值（不再是写死的 5 秒）。</li>
 *   <li><b>回退/安全</b>：粘性只可能出现在"用户选打洞优先"这一档；用户显式选「只用中转」时
 *       判定器读到的是 T104 的老文案（"未试打洞（配置=只用中转…）"）。</li>
 * </ol>
 */
public final class T113FallbackStickyTest {

	private static int passed = 0;
	private static final List<String> failures = new ArrayList<>();

	public static void main(String[] args) {
		// ── 1. 配置级：打洞优先仍先试打洞，只是超时值变了 ─────────────────────────
		String p2p = cfg("xtcp", VisitorConfig.STRATEGY_P2P, 18443).toToml();
		check("打洞优先：xtcp 访客仍在（打洞能力没被取消）",
			p2p.contains("type = \"xtcp\"\n") && p2p.contains("serverName = \"dsh-remote\"\n"));
		check("打洞优先：keepTunnelOpen 仍在（打洞成功后可复用，不必每条连接都重建）",
			p2p.contains("keepTunnelOpen = true\n"));
		check("打洞优先：fallbackTo 仍指向那条 stcp 中转访客（打不通能回落）",
			p2p.contains("fallbackTo = \"dsh-remote-stcp-visitor\"\n")
				&& p2p.contains("name = \"dsh-remote-stcp-visitor\"\n"));
		check("打洞优先：fallbackTimeoutMs = " + VisitorConfig.FALLBACK_TIMEOUT_MS
				+ "（取值只由 VisitorConfig.FALLBACK_TIMEOUT_MS 决定）",
			p2p.contains("fallbackTimeoutMs = " + VisitorConfig.FALLBACK_TIMEOUT_MS + "\n"));
		check("打洞优先：超时值已从 frp 缺省的 5000 降下来（T113 的主收益）",
			VisitorConfig.FALLBACK_TIMEOUT_MS > 0 && VisitorConfig.FALLBACK_TIMEOUT_MS < 5000
				&& VisitorConfig.FALLBACK_TIMEOUT_MS >= 500 && VisitorConfig.FALLBACK_TIMEOUT_MS <= 1500);

		// ── 2. 只用中转（粘性复用的就是这一档）：无打洞痕迹 ───────────────────────
		String relay = cfg("xtcp", VisitorConfig.STRATEGY_RELAY, 18443).toToml();
		check("只用中转：**不得**出现任何打洞痕迹（粘性回落复用的就是这一档，不自创新写法）",
			!relay.contains("xtcp") && !relay.contains("fallbackTo")
				&& !relay.contains("keepTunnelOpen") && !relay.contains("fallbackTimeoutMs"));
		check("只用中转：绑真实端口且名字/serverName 与网关 fallback 那条逐字相同",
			relay.contains("bindPort = 18443\n") && relay.contains("name = \"dsh-remote-stcp-visitor\"\n")
				&& relay.contains("serverName = \"dsh-remote-stcp\"\n"));

		// ── 3. 粘性状态机 ────────────────────────────────────────────────────────
		TunnelPath.resetStickyForTest();
		TunnelPath.reset(VisitorConfig.STRATEGY_P2P);
		TunnelPath.noteStickyContext("wlan0=10.0.2.16;|profile-1|p2p");
		check("初始：未粘住，连续失败 0", !TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == 0);
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("第 1 次打洞超时：**不**粘住（给打洞留机会）",
			!TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == 1);
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("连续第 " + TunnelPath.HOLE_FAIL_STREAK_TO_STICK + " 次打洞超时：粘住中转",
			TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == TunnelPath.HOLE_FAIL_STREAK_TO_STICK);
		TunnelPath.observe("[dsh-remote-visitor] establishing nat hole connection successful, sid [abc]");
		check("打洞一旦成功：立刻解除粘性（能打洞的网络不该被粘在中转上）",
			!TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == 0);
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("再连续超时：重新粘住", TunnelPath.stickyRelay());
		TunnelPath.noteStickyApplied();
		check("noteStickyApplied 只在粘住时累计（诊断行/日志据此说真话）", TunnelPath.stickyActivations() == 1);

		// 停隧道：判定清掉，但**粘性不随停隧道清零**（同一次前台会话内断开→再连接不再白等）
		TunnelPath.clear();
		check("停隧道：路径判定回落「未启动」，粘性保留（同一前台会话内不再白等一遍）",
			TunnelPath.summary().contains("未启动") && TunnelPath.stickyRelay());
		TunnelPath.reset(VisitorConfig.STRATEGY_P2P);
		check("新隧道启动：连续失败计数归零，粘性保留（同一次 frpc 进程内 toml 改不了，"
				+ "粘性唯一生效点就是下一次 frpc 启动）",
			TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == 0
				&& TunnelPath.summary().contains("已粘性回落中转"));
		check("诊断行显示的是**粘住那一刻**的失败次数，不是被新一轮启动归零后的 0"
				+ "（设备实测曾出现「已粘性回落中转（连续 0 次…）」的自相矛盾）",
			TunnelPath.summary().contains("连续 " + TunnelPath.HOLE_FAIL_STREAK_TO_STICK + " 次")
				&& !TunnelPath.summary().contains("连续 0 次"));

		// 换网络 ⇒ 清零（真值判据见 TunnelService.networkId()：网卡快照变化即换网络）
		boolean changed = TunnelPath.noteStickyContext("rmnet_data0=10.1.2.3/24;|profile-1|p2p");
		check("网络变化（网卡快照变了）⇒ 粘性清零、重新试打洞",
			changed && !TunnelPath.stickyRelay() && TunnelPath.holeFailStreak() == 0
				&& TunnelPath.stickyResetReason().contains("上下文变化"));
		check("同一网络重复上报不误清（不会把「没变」当「变了」）",
			!TunnelPath.noteStickyContext("rmnet_data0=10.1.2.3/24;|profile-1|p2p"));

		// 换配置组 / 用户手动换档也清零（作用域含 profileId 与档位）
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("（前置）已再次粘住", TunnelPath.stickyRelay());
		check("用户手动换成「只用中转」⇒ 清零（人工二选一必须被尊重）",
			TunnelPath.noteStickyContext("rmnet_data0=10.1.2.3/24;|profile-1|relay") && !TunnelPath.stickyRelay());
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("换配置组 ⇒ 清零", TunnelPath.noteStickyContext("rmnet_data0=10.1.2.3/24;|profile-2|relay")
			&& !TunnelPath.stickyRelay());

		// ── 4. 诊断行真话 ────────────────────────────────────────────────────────
		TunnelPath.resetStickyForTest();
		TunnelPath.reset(VisitorConfig.STRATEGY_P2P);
		TunnelPath.noteStickyContext("wlan0=10.0.2.16;|profile-1|p2p");
		String label = TunnelPath.strategyLabel(VisitorConfig.STRATEGY_P2P);
		check("档位文案里的秒数取自实际超时值（不再写死 5 秒）：" + label,
			label.contains("打洞优先") && label.contains("0.8 秒") && !label.contains("5 秒"));
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		String stickySummary = TunnelPath.summary();
		String stickyPath = TunnelPath.pathLabel();
		check("粘住时第一段仍是**用户的档位**（绝不能把打洞优先说成「只用中转」）：" + stickySummary,
			stickySummary.contains("打洞优先") && stickySummary.contains("已粘性回落中转")
				&& !stickySummary.contains("只用中转"));
		check("粘住时路径如实说「这次没试打洞 + 什么时候重试」：" + stickyPath,
			stickyPath.contains("未试打洞") && stickyPath.contains("换网络或重开 App"));
		check("粘住时也给出连续失败次数（诊断行可核对）",
			stickyPath.contains("连续 " + TunnelPath.HOLE_FAIL_STREAK_TO_STICK + " 次打洞超时"));

		// T104 语义逐字保留：没粘住时的文案
		TunnelPath.clear();
		TunnelPath.resetStickyForTest();
		TunnelPath.reset(VisitorConfig.STRATEGY_RELAY);
		check("用户选「只用中转」（未粘住）⇒ 与 T104 逐字相同的文案",
			TunnelPath.summary().contains("只用中转") && TunnelPath.summary().contains("未试打洞")
				&& TunnelPath.summary().contains("配置=只用中转"));
		TunnelPath.reset(VisitorConfig.STRATEGY_P2P);
		check("打洞优先但还没数据面连接 ⇒ 「尚未判定」（T104 语义不变）",
			TunnelPath.summary().contains("打洞优先") && TunnelPath.summary().contains("尚未判定"));
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("只失败 1 次（未粘住）⇒ 仍显示 T104 的「回退中转 ×1」+ 连续失败进度",
			TunnelPath.summary().contains("回退中转") && TunnelPath.pathLabel().contains("连续失败 1/" + TunnelPath.HOLE_FAIL_STREAK_TO_STICK));
		TunnelPath.clear();
		check("停隧道 ⇒ 回到 T104 的「未启动」（T104 语义不变）", TunnelPath.summary().contains("未启动"));
		TunnelPath.resetStickyForTest();

		report();
	}

	// ---------- 夹具 ----------

	private static VisitorConfig cfg(String mode, String strategy, int bindPort) {
		VisitorConfig c = new VisitorConfig();
		c.mode = mode;
		c.strategy = strategy;
		c.serverAddr = "1.2.3.4";
		c.serverPort = 7000;
		c.serverName = "dsh-remote";
		c.secretKey = "sk";
		c.authToken = "tok";
		c.bindPort = bindPort;
		return c;
	}

	// ---------- 断言框架 ----------

	private static void check(String name, boolean ok) {
		if (ok) {
			passed += 1;
		} else {
			failures.add(name);
			System.out.println("  未通过：" + name);
		}
	}

	private static void report() {
		System.out.println("T113FallbackStickyTest：通过 " + passed + " 条，失败 " + failures.size() + " 条");
		if (!failures.isEmpty()) System.exit(1);
	}
}
