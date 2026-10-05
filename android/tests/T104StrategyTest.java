package top.d1studio.dshremote;

import java.util.ArrayList;
import java.util.List;

/**
 * T104：手机端「打洞策略」人工二选一的 JVM 测试 —— 不依赖设备/模拟器，纯源码语义。
 *
 * <p>跑法见 scratch/t104/run-jvm-tests.ps1（用 android.jar 当 classpath：
 * VisitorConfig.toToml() 不碰任何 Android API，只是字符串拼接，所以能真跑真断；
 * Uri/SharedPreferences 只在 parse/save/load 里用，测试不触碰那三条路径）。
 *
 * <p>断言分四组：
 * <ol>
 *   <li><b>逐字回归</b>：打洞优先（xtcp 电脑端）生成的 toml 必须与 T104 之前**逐字节相同**
 *       ——这段字符串是从改动前的 VisitorConfig.toToml() 原样抄下来的，改动不允许漂移一个字符。</li>
 *   <li><b>只用中转</b>：只写一条 stcp 访客；名字/serverName 与网关 xtcp 形态里那条 fallback
 *       访客逐字相同（`&lt;名&gt;-stcp-visitor` / `&lt;名&gt;-stcp`），但绑真实端口；
 *       **不得**出现 xtcp / fallbackTo / keepTunnelOpen / fallbackTimeoutMs。</li>
 *   <li><b>stcp 电脑端</b>：与改前逐字相同（`&lt;名&gt;-visitor` / serverName=`&lt;名&gt;`），
 *       且"打洞优先"在这种电脑端上被收敛成 relay。</li>
 *   <li><b>诊断判据</b>：TunnelPath 只认 frpc 的两条原文，其余一律"尚未判定"。</li>
 * </ol>
 */
public final class T104StrategyTest {

	private static int passed = 0;
	private static final List<String> failures = new ArrayList<>();

	public static void main(String[] args) throws Exception {
		String dumpMode = null;
		for (int i = 0; i < args.length; i++) {
			if ("--dump".equals(args[i]) && i + 1 < args.length) dumpMode = args[i + 1];
		}
		if (dumpMode != null) {
			dumpCases(dumpMode);
			return;
		}

		// ── 1. 打洞优先（xtcp 电脑端）：与改前**逐字相同** ──────────────────────
		String p2pToml = cfg("xtcp", VisitorConfig.STRATEGY_P2P, 18443).toToml();
		check("打洞优先：toml 与 T104 之前逐字节相同（回归钉；唯一有意改动是 T113 的超时数值）",
			P2P_EXPECTED.equals(p2pToml),
			"改后=\n" + p2pToml);
		check("打洞优先：含 fallbackTo 指向 <名>-stcp-visitor", p2pToml.contains("fallbackTo = \"dsh-remote-stcp-visitor\""));
		check("打洞优先：fallbackTimeoutMs = " + VisitorConfig.FALLBACK_TIMEOUT_MS
			+ "（T113：这个**数值**从 5000 压到 800，键名/位置/fallbackTo 关系一字未动）",
			p2pToml.contains("fallbackTimeoutMs = " + VisitorConfig.FALLBACK_TIMEOUT_MS + "\n"));
		check("打洞优先：含 keepTunnelOpen = true", p2pToml.contains("keepTunnelOpen = true\n"));
		check("打洞优先：两条访客（stcp 中转 + xtcp 打洞）",
			countOf(p2pToml, "[[visitors]]") == 2 && p2pToml.contains("type = \"stcp\"\n") && p2pToml.contains("type = \"xtcp\"\n"));

		// ── 2. 只用中转（xtcp 电脑端）：不试打洞 ────────────────────────────────
		String relayToml = cfg("xtcp", VisitorConfig.STRATEGY_RELAY, 18443).toToml();
		check("只用中转：只有一条访客", countOf(relayToml, "[[visitors]]") == 1);
		check("只用中转：访客是 stcp 且名字/serverName 与网关 fallback 那条逐字相同",
			relayToml.contains("name = \"dsh-remote-stcp-visitor\"\n")
				&& relayToml.contains("type = \"stcp\"\n")
				&& relayToml.contains("serverName = \"dsh-remote-stcp\"\n"));
		check("只用中转：绑真实端口（不是 -1）", relayToml.contains("bindPort = 18443\n") && !relayToml.contains("bindPort = -1"));
		check("只用中转：**不得**出现任何打洞痕迹（xtcp / fallbackTo / keepTunnelOpen / fallbackTimeoutMs）",
			!relayToml.contains("xtcp") && !relayToml.contains("fallbackTo")
				&& !relayToml.contains("keepTunnelOpen") && !relayToml.contains("fallbackTimeoutMs"));
		check("只用中转：公共段（serverAddr/auth.token/tls/心跳）与打洞优先逐字相同",
			commonPart(relayToml).equals(commonPart(p2pToml)));

		// ── 3. stcp 电脑端：与改前逐字相同 + 打洞档被收敛成 relay ────────────────
		VisitorConfig stcp = cfg("stcp", VisitorConfig.STRATEGY_P2P, 18443);
		check("stcp 电脑端 + 用户选打洞优先 ⇒ 实际生效档收敛成 relay", VisitorConfig.STRATEGY_RELAY.equals(stcp.effectiveStrategy()));
		check("stcp 电脑端：toml 与改前逐字相同（<名>-visitor / serverName=<名>）", STCP_EXPECTED.equals(stcp.toToml()));
		check("stcp 电脑端 + 只用中转：toml 与 stcp 档逐字相同", STCP_EXPECTED.equals(cfg("stcp", VisitorConfig.STRATEGY_RELAY, 18443).toToml()));

		// 非默认端口（AND-07 端口协商）也要跟着走
		check("只用中转：绑定端口变化时 toml 跟着变（16225）",
			cfg("xtcp", VisitorConfig.STRATEGY_RELAY, 16225).toToml().contains("bindPort = 16225\n"));
		check("打洞优先：绑定端口变化时只改 xtcp 那条（stcp 那条恒 -1）",
			cfg("xtcp", VisitorConfig.STRATEGY_P2P, 16225).toToml().contains("bindPort = -1\n\n")
				&& cfg("xtcp", VisitorConfig.STRATEGY_P2P, 16225).toToml().contains("bindPort = 16225\n"));

		// ── 4. 策略/形态归一化 ────────────────────────────────────────────────
		check("归一化：未知策略值 → p2p（存量配置行为与改前一致）",
			VisitorConfig.STRATEGY_P2P.equals(VisitorConfig.normalizeStrategy(null))
				&& VisitorConfig.STRATEGY_P2P.equals(VisitorConfig.normalizeStrategy("")));
		check("归一化：relay 保持 relay", VisitorConfig.STRATEGY_RELAY.equals(VisitorConfig.normalizeStrategy("relay")));
		check("归一化：电脑端形态只认 entry/stcp/xtcp，其余为空",
			"entry".equals(VisitorConfig.normalizePcMode("entry"))
				&& "stcp".equals(VisitorConfig.normalizePcMode("stcp"))
				&& "xtcp".equals(VisitorConfig.normalizePcMode("xtcp"))
				&& "".equals(VisitorConfig.normalizePcMode("whatever"))
				&& "".equals(VisitorConfig.normalizePcMode(null)));

		// ── 5. 可用性矩阵（UI 的禁用/标注判据，节点级真值）────────────────────────
		check("形态 xtcp：两档都可用", ProfileStore.p2pAvailable(profile("xtcp")) && ProfileStore.relayAvailable(profile("xtcp")));
		check("形态 stcp：打洞优先不可用、只用中转可用",
			!ProfileStore.p2pAvailable(profile("stcp")) && ProfileStore.relayAvailable(profile("stcp")));
		check("形态 entry：两档都不可用（必须如实标注）",
			!ProfileStore.p2pAvailable(profile("entry")) && !ProfileStore.relayAvailable(profile("entry"))
				&& ProfileStore.tunnelUnavailable(profile("entry")));
		check("形态未知（手工填的配置组）：两档都可用（不谎称不可用）",
			ProfileStore.p2pAvailable(profile("")) && ProfileStore.relayAvailable(profile("")));
		check("形态 stcp ⇒ 访客形态必须跟着是 stcp（否则会去找不存在的 xtcp 代理）",
			"stcp".equals(ProfileStore.modeForPcMode("stcp")) && "xtcp".equals(ProfileStore.modeForPcMode("entry"))
				&& "xtcp".equals(ProfileStore.modeForPcMode("xtcp")) && "xtcp".equals(ProfileStore.modeForPcMode("")));
		check("effectiveStrategy：xtcp 形态 + 用户选 p2p ⇒ p2p；用户选 relay ⇒ relay",
			VisitorConfig.STRATEGY_P2P.equals(ProfileStore.effectiveStrategy(profile("xtcp")))
				&& VisitorConfig.STRATEGY_RELAY.equals(ProfileStore.effectiveStrategy(profileRelay("xtcp"))));
		check("effectiveStrategy：stcp 形态 + 用户选 p2p ⇒ 收敛成 relay",
			VisitorConfig.STRATEGY_RELAY.equals(ProfileStore.effectiveStrategy(profile("stcp"))));

		// ⚠ 这两条是设备级验证抓到的真 bug 的回归钉（详见 scratch/t104/report.md §3.2）：
		// 第一版 UI 里写成「p2p 成立就强制回 p2p」，导致 xtcp 电脑端上点「只用中转」被立刻弹回，
		// 人工二选一形同虚设。**成立时必须原样尊重用户的选择**。
		check("收敛只在选中档不成立时发生：xtcp 电脑端 + 用户选 relay ⇒ 必须保持 relay（不许弹回默认）",
			VisitorConfig.STRATEGY_RELAY.equals(ProfileStore.coerceStrategy(profile("xtcp"), VisitorConfig.STRATEGY_RELAY))
				&& VisitorConfig.STRATEGY_RELAY.equals(ProfileStore.effectiveStrategy(profileRelay("xtcp"))));
		check("收敛只在选中档不成立时发生：xtcp 电脑端 + 用户选 p2p ⇒ 保持 p2p",
			VisitorConfig.STRATEGY_P2P.equals(ProfileStore.coerceStrategy(profile("xtcp"), VisitorConfig.STRATEGY_P2P)));
		check("entry 形态：两档都不成立时不偷偷改用户的选择（历史行为逐字保留）",
			VisitorConfig.STRATEGY_P2P.equals(ProfileStore.coerceStrategy(profile("entry"), VisitorConfig.STRATEGY_P2P))
				&& VisitorConfig.STRATEGY_RELAY.equals(ProfileStore.coerceStrategy(profile("entry"), VisitorConfig.STRATEGY_RELAY)));

		// ── 6. TunnelPath：只认 frpc 原文，判不出来就说判不出来 ──────────────────
		TunnelPath.clear();
		check("未启动：摘要说「未启动（无法判定）」而非编一个路径",
			TunnelPath.summary().contains("未启动") && TunnelPath.summary().contains("无法判定"));
		TunnelPath.reset(VisitorConfig.STRATEGY_P2P);
		check("已启动但还没有数据面连接：摘要写「尚未判定」，绝不把配置当事实",
			TunnelPath.summary().contains("尚未判定") && TunnelPath.summary().contains("打洞优先"));
		TunnelPath.observe("[dsh-remote-visitor] nathole prepare success, nat type: EasyNat, behavior: BehaviorNoChange, addresses: [], assistedAddresses: []");
		check("过程行（nathole prepare success）不足以判定打洞成功",
			TunnelPath.PATH_NONE.equals(TunnelPath.path()) && TunnelPath.summary().contains("尚未判定"));
		TunnelPath.observe("[dsh-remote-visitor] establishing nat hole connection successful, sid [abc], remoteAddr [1.2.3.4:5678]");
		check("frpc 报「establishing nat hole connection successful」⇒ 本次打洞成功",
			TunnelPath.PATH_HOLE.equals(TunnelPath.path()) && TunnelPath.summary().contains("打洞成功"));
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: context deadline exceeded");
		check("frpc 报「open tunnel error: context deadline exceeded」⇒ 本次已回退中转（且计数保留打洞成功那次）",
			TunnelPath.PATH_FALLBACK.equals(TunnelPath.path()) && TunnelPath.summary().contains("回退中转")
				&& TunnelPath.holeCount() == 1 && TunnelPath.fallbackCount() == 1);
		TunnelPath.observe("[dsh-remote-visitor] open tunnel error: open tunnel timeout");
		check("没有 fallback 语义的 open tunnel error（无 context deadline）不算回退判据",
			TunnelPath.PATH_FALLBACK.equals(TunnelPath.path()) && TunnelPath.fallbackCount() == 1);
		TunnelPath.reset(VisitorConfig.STRATEGY_RELAY);
		check("切档重启后判定归零：只显示「未试打洞」（不残留上一档的打洞成功）",
			TunnelPath.PATH_NONE.equals(TunnelPath.path()) && TunnelPath.summary().contains("未试打洞")
				&& TunnelPath.holeCount() == 0);
		TunnelPath.clear();
		check("停隧道：回到「未启动」", TunnelPath.summary().contains("未启动"));

		// 大小写不敏感（frp 版本/日志前缀漂移的防守），但**不接受**半截关键字
		check("判据大小写不敏感", TunnelPath.PATH_HOLE.equals(TunnelPath.classify("Establishing NAT Hole Connection Successful")));
		check("半截关键字不放行", TunnelPath.classify("establishing nat hole connection") == null
			&& TunnelPath.classify("open tunnel error: something else") == null
			&& TunnelPath.classify("") == null && TunnelPath.classify(null) == null);

		report();
	}

	// ---------- 夹具 ----------

	/**
	 * 打洞优先（xtcp 电脑端）的 toml —— 改动前 VisitorConfig.toToml() 的原文，逐字抄来这里当钉子。
	 *
	 * <p>T113 披露：这一份里**唯一**被有意改动的就是最后一行 ——
	 * {@code fallbackTimeoutMs = 5000} → {@link VisitorConfig#FALLBACK_TIMEOUT_MS}（800）。
	 * 其余每一行（含 fallbackTo/keepTunnelOpen 关系、字段顺序、空行）仍是改前的逐字原文。
	 * 让它直接引用常量而不是写死数字：这个钉子的价值在"toml 形状不许漂移"，
	 * 数值本身由 T113 有意调整，并由 T113FallbackStickyTest 单独钉住。
	 */
	private static final String P2P_EXPECTED =
		"# 由 DSH Remote App 自动生成\n"
			+ "serverAddr = \"1.2.3.4\"\n"
			+ "serverPort = 7000\n\n"
			+ "auth.token = \"tok\"\n"
			+ "transport.tls.enable = true\n"
			+ "transport.heartbeatInterval = 25\n"
			+ "transport.heartbeatTimeout = 90\n\n"
			+ "[[visitors]]\n"
			+ "name = \"dsh-remote-stcp-visitor\"\n"
			+ "type = \"stcp\"\n"
			+ "serverName = \"dsh-remote-stcp\"\n"
			+ "secretKey = \"sk\"\n"
			+ "bindPort = -1\n\n"
			+ "[[visitors]]\n"
			+ "name = \"dsh-remote-visitor\"\n"
			+ "type = \"xtcp\"\n"
			+ "serverName = \"dsh-remote\"\n"
			+ "secretKey = \"sk\"\n"
			+ "bindAddr = \"127.0.0.1\"\n"
			+ "bindPort = 18443\n"
			+ "keepTunnelOpen = true\n"
			+ "fallbackTo = \"dsh-remote-stcp-visitor\"\n"
			+ "fallbackTimeoutMs = " + VisitorConfig.FALLBACK_TIMEOUT_MS + "\n";

	/** stcp 电脑端的 toml —— 同样是改动前原文。 */
	private static final String STCP_EXPECTED =
		"# 由 DSH Remote App 自动生成\n"
			+ "serverAddr = \"1.2.3.4\"\n"
			+ "serverPort = 7000\n\n"
			+ "auth.token = \"tok\"\n"
			+ "transport.tls.enable = true\n"
			+ "transport.heartbeatInterval = 25\n"
			+ "transport.heartbeatTimeout = 90\n\n"
			+ "[[visitors]]\n"
			+ "name = \"dsh-remote-visitor\"\n"
			+ "type = \"stcp\"\n"
			+ "serverName = \"dsh-remote\"\n"
			+ "secretKey = \"sk\"\n"
			+ "bindAddr = \"127.0.0.1\"\n"
			+ "bindPort = 18443\n";

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

	private static ProfileStore.Profile profile(String pcMode) {
		ProfileStore.Profile p = new ProfileStore.Profile();
		p.pcMode = pcMode;
		p.mode = ProfileStore.modeForPcMode(pcMode);
		p.strategy = VisitorConfig.STRATEGY_P2P;
		return p;
	}

	private static ProfileStore.Profile profileRelay(String pcMode) {
		ProfileStore.Profile p = profile(pcMode);
		p.strategy = VisitorConfig.STRATEGY_RELAY;
		return p;
	}

	/** 心跳行之前的公共段（两档必须逐字相同）。 */
	private static String commonPart(String toml) {
		int at = toml.indexOf("[[visitors]]");
		return at < 0 ? toml : toml.substring(0, at);
	}

	private static int countOf(String haystack, String needle) {
		int count = 0;
		int at = 0;
		while ((at = haystack.indexOf(needle, at)) >= 0) {
			count += 1;
			at += needle.length();
		}
		return count;
	}

	// ---------- 供跨端一致性脚本调用的 toml 打印 ----------

	/**
	 * 跨端一致性断言（scratch/t104/cross-end.mjs）用：把同一组输入下 App 侧生成的 toml
	 * 打成本脚本可解析的格式，交给 Node 侧与网关 renderVisitorToml() 的输出逐行对齐。
	 */
	private static void dumpCases(String which) {
		String[] modes = { "xtcp", "stcp" };
		String[] strategies = { VisitorConfig.STRATEGY_P2P, VisitorConfig.STRATEGY_RELAY };
		for (String mode : modes) {
			for (String strategy : strategies) {
				System.out.println("=== " + mode + "|" + strategy + "|" + which + " ===");
				System.out.print(cfg(mode, strategy, Integer.parseInt(which)).toToml());
				System.out.println("=== end ===");
			}
		}
	}

	// ---------- 断言框架 ----------

	private static void check(String name, boolean ok) {
		check(name, ok, "");
	}

	private static void check(String name, boolean ok, String detail) {
		if (ok) {
			passed += 1;
		} else {
			failures.add(name + (detail.isEmpty() ? "" : "  [" + detail + "]"));
		}
	}

	private static void report() {
		System.out.println("T104StrategyTest：通过 " + passed + " 条，失败 " + failures.size() + " 条");
		for (String f : failures) System.out.println("  未通过：" + f);
		if (!failures.isEmpty()) System.exit(1);
	}
}
