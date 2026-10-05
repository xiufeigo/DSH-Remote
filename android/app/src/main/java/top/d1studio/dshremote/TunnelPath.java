package top.d1studio.dshremote;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * T104：本次隧道**实际走了哪条路**的判定器（打洞 / 回退中转 / 未试打洞）。
 *
 * <p>用户要的是「人工二选一」+「诊断里说清这次到底走了哪条」。后者最怕编：
 * 「打洞成功」不能靠猜，必须有 frpc 自己的话当依据。本类只做一件事：
 * 从 frpc 的日志行里认出**可辨识的两条判据**，其余一律显示「尚未判定」。
 *
 * <h2>真值来源（frpc 0.61.1，源码 client/visitor/xtcp.go，与打包进 APK 的
 * arm64-v8a/libfrpc.so 同一版本）</h2>
 * <ul>
 *   <li>打洞成功：{@code establishing nat hole connection successful, sid [...]}
 *       —— 这行是 {@code makeNatHole()} 在 UDP 打洞**真的打通**、并把隧道会话
 *       （QUIC/KCP）建在那条打洞连接上之后打的（Info 级，默认日志级别可见）
 *       ⇒ 之后的数据面确实走 P2P。</li>
 *   <li>打洞失败→回退中转：{@code open tunnel error: context deadline exceeded}
 *       —— 只有配了 {@code fallbackTo} 的 xtcp 访客才带 5s 的 ctx 超时
 *       （{@code FallbackTimeoutMs}），超时后走 {@code TransferConn(FallbackTo)}
 *       把这条用户连接整体交给 stcp 访客 ⇒ 这条 Error 行 = 这次回退中转。</li>
 * </ul>
 * 不认的关键字（只是过程，不足以判定）：{@code nathole prepare success}、
 * {@code get natHoleRespMsg}、{@code make hole error}（后者之后仍可能重试成功）。
 *
 * <p><b>无法判定时如实说无法判定</b>：没有上述任何一行就显示「尚未判定」，
 * 绝不把「配置是打洞优先」当成「这次走了打洞」。
 *
 * <p>纯 JVM 逻辑（无 Android 依赖），可在 android/tests/T104StrategyTest.java 里直接单测。
 */
public final class TunnelPath {

	/** 打洞优先（默认档）：先试 P2P，5s 打不通自动回退中转。 */
	public static final String STRATEGY_P2P = "p2p";
	/** 只用中转：不试打洞，frpc 配置里只有一条 stcp 访客。 */
	public static final String STRATEGY_RELAY = "relay";

	/** 本次还没判定（没有数据面连接，或日志里没有判据）。 */
	public static final String PATH_NONE = "none";
	/** 本次打洞成功（数据面走 P2P）。 */
	public static final String PATH_HOLE = "hole";
	/** 本次打洞失败，已回退中转。 */
	public static final String PATH_FALLBACK = "fallback";

	/**
	 * T113：连续打洞失败多少次后**粘住中转**。
	 *
	 * <p>为什么是 2：首屏那一次「点连接 → 可用」实测会开 2 条连接（T111 §3 的两段 5 s 空等
	 * 一一对应），两条都超时即已证明"这个网络打不通洞"（真值来自 frpc 自己的
	 * {@code open tunnel error: context deadline exceeded}），没必要再赌第三条。
	 * 而**一次成功就把计数清零**（见 {@link #observe}）⇒ 打得通的网络永远不会被粘住。
	 */
	public static final int HOLE_FAIL_STREAK_TO_STICK = 2;

	/** 打洞成功判据（frpc 原文，只认这一条：它之后的数据面真的在 P2P 连接上）。 */
	static final String KEY_HOLE_OK = "establishing nat hole connection successful";
	/** 回退判据（frpc 原文）：只有配了 fallbackTo 的 xtcp 访客才会带这个 ctx 超时。 */
	static final String KEY_OPEN_TUNNEL_ERROR = "open tunnel error:";
	static final String KEY_CTX_DEADLINE = "context deadline exceeded";

	private static final Object LOCK = new Object();

	/** 本次 frpc 进程生效的策略（由 FrpcManager.start 写入，即**真正写进 toml 的那一档**）。 */
	private static String strategy = STRATEGY_P2P;
	/** 是否已经启动过隧道（false = 从未 start，诊断行要说"隧道未启动"）。 */
	private static boolean started = false;
	private static String path = PATH_NONE;
	private static long pathAt = 0L;
	private static int holeCount = 0;
	private static int fallbackCount = 0;

	// ───────────────────────── T113：打洞回落粘性 ─────────────────────────
	//
	// 用户在「打不通洞」的网络（公司网/运营商 CGNAT 等）上，每开一条新 TCP 连接都要付一次
	// fallbackTimeoutMs。T113 把超时从 5000 压到 800（见 VisitorConfig.FALLBACK_TIMEOUT_MS），
	// 再补一条**粘性**：连续 HOLE_FAIL_STREAK_TO_STICK 次打洞超时后，下一次起的 frpc 直接用
	// T104 已有的「只用中转」toml（不新发明写法）⇒ 之后 0 空等。
	//
	// 粘性状态的作用域是 (App 进程前台会话 × 网络身份 × 配置组/策略)，判定与清零都在这里：
	//   · 上下文变化（网络切换 / 换配置组 / 用户手动换档）⇒ noteStickyContext 清零；
	//   · 打洞成功 ⇒ 立刻解除（打得通就不该粘）；
	//   · 每次新的隧道启动 ⇒ 连续失败计数从 0 重新计（粘住状态本身保留，否则该功能无处生效：
	//     同一次 frpc 进程内 toml 不可改，粘性唯一能起作用的地方就是"下一次 frpc 启动"）；
	//   · App 进程退出（新的一次前台会话）⇒ 静态状态随之消失 ⇒ 重新试打洞。
	private static boolean stickyRelay = false;
	private static int holeFailStreak = 0;
	private static int stickyActivations = 0;
	private static String stickyContext = "";
	private static String stickyResetReason = "";
	/**
	 * T113：**粘住那一刻**的连续失败次数。
	 *
	 * <p>为什么不直接用 {@link #holeFailStreak} 显示：新隧道启动会把连续计数归零（见 {@link #reset}），
	 * 于是"已粘性回落中转"这句会配上一个"连续 0 次打洞超时"——自相矛盾（设备实测原句：
	 * `已粘性回落中转（连续 0 次打洞超时后不再等…）`）。诊断行必须能说出**当初是几次失败才粘住的**，
	 * 所以粘住时把那个数单独记下来，显示只用这个字段。
	 */
	private static int stickyStreakAtEngage = 0;

	private TunnelPath() {
	}

	/**
	 * 归类一行 frpc 日志。返回 null = 这行不是路径判据（绝大多数行都是）。
	 * 纯函数，不读不改任何状态 —— 单测直接喂原文。
	 */
	public static String classify(String line) {
		if (line == null) return null;
		String lower = line.toLowerCase(Locale.US);
		if (lower.contains(KEY_HOLE_OK)) return PATH_HOLE;
		if (lower.contains(KEY_OPEN_TUNNEL_ERROR) && lower.contains(KEY_CTX_DEADLINE)) return PATH_FALLBACK;
		return null;
	}

	/**
	 * frpc 每次启动（含崩溃自重启）调用：策略换成这一次生效的，判定归零。
	 * 「本次」因此严格等于「当前 frpc 进程生命周期内」，切档重启后上一条判定不会残留。
	 *
	 * <p>T113：新的隧道启动同时把**连续打洞失败计数**归零（新的一次机会），但**保留**粘住状态
	 * —— 见 {@link #stickyRelay()} 的说明：同一次 frpc 进程内 toml 不可改，
	 * 粘性唯一能起作用的地方就是"下一次 frpc 启动"。
	 */
	public static void reset(String nextStrategy) {
		synchronized (LOCK) {
			strategy = STRATEGY_RELAY.equals(nextStrategy) ? STRATEGY_RELAY : STRATEGY_P2P;
			started = true;
			path = PATH_NONE;
			pathAt = 0L;
			holeCount = 0;
			fallbackCount = 0;
			holeFailStreak = 0;
		}
	}

	/** 隧道停止：把判定一起清掉（诊断行要回落到"隧道未启动"，不留上一次的绿/红）。 */
	public static void clear() {
		synchronized (LOCK) {
			started = false;
			path = PATH_NONE;
			pathAt = 0L;
			holeCount = 0;
			fallbackCount = 0;
			// T113：粘住状态**不随停隧道清零** —— 用户"断开→再连接"（同一次前台会话、同一个网络、
			// 同一个配置组）时，上一次已经量出"这个网络打不通洞"，再让用户白等一遍没有意义。
			// 清零只发生在：上下文变化（网络/配置组/策略，noteStickyContext）/ 打洞成功 /
			// App 进程退出（静态状态消失）。诊断行会如实写明"换网络或重开 App 后自动重试打洞"。
			holeFailStreak = 0;
		}
	}

	/** 喂一行 frpc 日志（FrpcManager.pump 的每一行都会经过这里）。 */
	public static void observe(String line) {
		String hit = classify(line);
		if (hit == null) return;
		synchronized (LOCK) {
			path = hit;
			pathAt = System.currentTimeMillis();
			if (PATH_HOLE.equals(hit)) {
				holeCount += 1;
				// T113：打洞真的成功过 ⇒ 解除粘性（这个网络是能打洞的，不该粘在中转上）。
				holeFailStreak = 0;
				stickyStreakAtEngage = 0;
				stickyRelay = false;
			}
			if (PATH_FALLBACK.equals(hit)) {
				fallbackCount += 1;
				holeFailStreak += 1;
				if (holeFailStreak >= HOLE_FAIL_STREAK_TO_STICK && !stickyRelay) {
					stickyRelay = true;
					stickyStreakAtEngage = holeFailStreak;
				}
			}
		}
	}

	/**
	 * T113：把「粘性作用域」告诉判定器 —— 由 TunnelService 在每次隧道启动时传入，
	 * 内容为 {@code 网络身份|配置组 id|用户策略}。三者任一变化即视为换环境 ⇒ 粘性清零，
	 * 重新给打洞一次机会（用户手动换档、换 Wi-Fi/流量、换配置组都走这条）。
	 *
	 * @return true = 这一次调用发生了清零（调用方可据此打一行日志/诊断）
	 */
	public static boolean noteStickyContext(String context) {
		String next = context == null ? "" : context;
		synchronized (LOCK) {
			if (next.equals(stickyContext)) return false;
			boolean changed = !stickyContext.isEmpty();
			stickyContext = next;
			if (changed) {
				stickyRelay = false;
				holeFailStreak = 0;
				stickyStreakAtEngage = 0;
				stickyResetReason = "上下文变化（网络 / 配置组 / 策略）";
			}
			return changed;
		}
	}

	/** T113：本次 frpc 是否确实按「粘性回落中转」写了 toml（由 TunnelService 置位，诊断行据此说真话）。 */
	public static void noteStickyApplied() {
		synchronized (LOCK) {
			if (stickyRelay) stickyActivations += 1;
		}
	}

	/** T113：当前是否处于「已粘住中转」（连续 N 次打洞超时后）。 */
	public static boolean stickyRelay() {
		synchronized (LOCK) {
			return stickyRelay;
		}
	}

	/** T113：当前连续打洞失败次数。 */
	public static int holeFailStreak() {
		synchronized (LOCK) {
			return holeFailStreak;
		}
	}

	/** T113：本进程会话内累计多少次 frpc 启动是按粘性写的纯中转 toml。 */
	public static int stickyActivations() {
		synchronized (LOCK) {
			return stickyActivations;
		}
	}

	/** T113：最近一次清零粘性的原因（诊断行用；未清零过为空串）。 */
	public static String stickyResetReason() {
		synchronized (LOCK) {
			return stickyResetReason;
		}
	}

	/** T113：仅供单测把粘性状态复位（设备侧不调用）。 */
	public static void resetStickyForTest() {
		synchronized (LOCK) {
			stickyRelay = false;
			holeFailStreak = 0;
			stickyStreakAtEngage = 0;
			stickyActivations = 0;
			stickyContext = "";
			stickyResetReason = "";
		}
	}

	public static String strategy() {
		synchronized (LOCK) {
			return strategy;
		}
	}

	public static String path() {
		synchronized (LOCK) {
			return path;
		}
	}

	public static boolean started() {
		synchronized (LOCK) {
			return started;
		}
	}

	public static int holeCount() {
		synchronized (LOCK) {
			return holeCount;
		}
	}

	public static int fallbackCount() {
		synchronized (LOCK) {
			return fallbackCount;
		}
	}

	/** 策略的人话文案（诊断行第一段用）。T113：秒数取自 VisitorConfig.FALLBACK_TIMEOUT_MS，不再写死"5 秒"。 */
	public static String strategyLabel(String value) {
		return STRATEGY_RELAY.equals(value)
			? "只用中转（不试打洞，数据经 VPS）"
			: "打洞优先（先试 P2P，" + fallbackSeconds() + " 秒打不通自动回退中转）";
	}

	/** T113：打洞超时预算的人话（800 → "0.8"，1000 → "1"）。 */
	private static String fallbackSeconds() {
		int ms = VisitorConfig.FALLBACK_TIMEOUT_MS;
		if (ms % 1000 == 0) return String.valueOf(ms / 1000);
		return String.format(Locale.US, "%.1f", ms / 1000.0);
	}

	/** 策略的短文案（与路径判定同行显示时用，避免一行太长）。 */
	public static String strategyShort(String value) {
		return STRATEGY_RELAY.equals(value) ? "只用中转" : "打洞优先";
	}

	/** 本次实际路径的人话文案。无法判定就说无法判定。 */
	public static String pathLabel() {
		String s;
		String p;
		int hole;
		int fallback;
		long at;
		int streak;
		int engageStreak;
		boolean sticky;
		synchronized (LOCK) {
			s = strategy;
			p = path;
			hole = holeCount;
			fallback = fallbackCount;
			at = pathAt;
			streak = holeFailStreak;
			engageStreak = stickyStreakAtEngage;
			sticky = stickyRelay;
		}
		if (!started) return "隧道未启动（无法判定）";
		if (sticky) {
			// T113：这是**本次启动的真实配置结果**（TunnelService 已按粘性写 relay toml），
			// 不是推断：frpc 这次根本没有 xtcp 访客，打洞一次都没试过。
			// 次数用 engageStreak（粘住那一刻的值），不能用被新一轮启动归零的 streak。
			return "未试打洞（T113 粘性回落中转：已连续 " + engageStreak + " 次打洞超时；换网络或重开 App 后自动重试打洞）";
		}
		if (STRATEGY_RELAY.equals(s)) {
			// 配置里根本没有 xtcp 访客 ⇒ 打洞一次都没试过。这是**配置真值**，不是推断。
			return "未试打洞（配置=只用中转，frpc 配置里没有 xtcp 访客）";
		}
		if (PATH_NONE.equals(p)) {
			return "尚未判定（frpc 已启动，但还没有可判定的数据面连接）";
		}
		String latest = PATH_HOLE.equals(p) ? "打洞成功" : "打洞失败已回退中转";
		StringBuilder b = new StringBuilder();
		if (hole > 0) b.append("打洞成功 ×").append(hole);
		if (hole > 0 && fallback > 0) b.append(" · ");
		if (fallback > 0) b.append("回退中转 ×").append(fallback);
		b.append("（最近 ").append(latest).append(" ").append(clock(at)).append("）");
		if (fallback > 0 && streak > 0) {
			// T113：把"再失败几次就会粘住"也说清楚，用户看得到自己处在哪个阶段。
			b.append(" · 连续失败 ").append(streak).append("/").append(HOLE_FAIL_STREAK_TO_STICK);
		}
		return b.toString();
	}

	/**
	 * 连接设置页只读诊断里那一段（一行）：**本次隧道**生效的档位 + frpc 日志判定出来的实际路径。
	 * 判不出来就说判不出来，绝不把「配置是打洞优先」当「这次走了打洞」。
	 *
	 * <p>T113：多一种状态 —— 用户选的是打洞优先，但已经连续多次打洞超时，本次按**粘性**回落
	 * 中转（纯 stcp toml）。这时第一段仍显示用户的档位（不能把用户的设置说成"只用中转"），
	 * 第二段如实说明这次为什么没试打洞、什么时候会重新试。
	 */
	public static String summary() {
		if (!started()) return "本次隧道：未启动（策略与路径都无法判定）";
		boolean sticky;
		int engageStreak;
		int streak;
		synchronized (LOCK) {
			sticky = stickyRelay;
			engageStreak = stickyStreakAtEngage;
			streak = holeFailStreak;
		}
		if (sticky) {
			return "本次隧道：打洞优先 · 已粘性回落中转（连续 " + engageStreak + " 次打洞超时后不再等；换网络或重开 App 自动重试打洞）";
		}
		return "本次隧道：" + strategyShort(strategy()) + " · " + pathLabel();
	}

	private static String clock(long ms) {
		if (ms <= 0L) return "--:--:--";
		return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date(ms));
	}
}
