package top.d1studio.dshremote;

import android.content.SharedPreferences;
import android.net.Uri;
import android.text.TextUtils;

import java.util.Locale;

/**
 * 访客隧道配置 —— 与 PC 端网关生成的连接串一一对应：
 *
 *   dsh-remote://visitor?v=1&mode=xtcp&server=1.2.3.4&cport=7000
 *       &name=<隧道名，与电脑端 frp.name 一致>&sk=<访客密钥>&token=<frps登录密钥>&bport=18443&fp=<证书指纹>
 *
 * 字段语义与 packages/gateway/src/frp.ts 的 renderVisitorToml / visitorConnectionString
 * 保持一致，两端任何一侧调整都要同步。
 *
 * <p><b>T104</b>：新增人工二选一的「打洞策略」{@link #strategy}（打洞优先 / 只用中转）。
 * 它**不是**新发明的 toml 写法：两档都只由网关 {@code renderVisitorToml()} 已有的两块拼出来
 * （xtcp 访客 + 它的 fallback stcp 访客 / 纯 stcp 访客），跨端一致性由
 * scratch/t104/cross-end.mjs 逐行对齐（同输入下 App 的 toml 与网关的 toml 除注释外**逐字节相等**）。
 */
public final class VisitorConfig {

	/** T104 策略字面量：打洞优先（默认；与网关 xtcp 访客 + fallback 一致）。 */
	public static final String STRATEGY_P2P = TunnelPath.STRATEGY_P2P;
	/** T104 策略字面量：只用中转（不试打洞）。 */
	public static final String STRATEGY_RELAY = TunnelPath.STRATEGY_RELAY;
	/** T104 电脑端形态：公网入口（不注册任何访客代理 ⇒ 两档都用不上）。 */
	public static final String PC_MODE_ENTRY = "entry";

	public String mode = "xtcp";      // stcp | xtcp
	/**
	 * T104：打洞策略。{@link #STRATEGY_P2P}=先试 P2P（超时 {@link #FALLBACK_TIMEOUT_MS} 毫秒
	 * 打不通自动回退中转，T113 前是 5000）；{@link #STRATEGY_RELAY}=不试打洞，直接走 stcp 中转。
	 */
	public String strategy = STRATEGY_P2P;
	/**
	 * T104：**电脑端**的隧道形态（来自导入链接的 mode 参数：entry/stcp/xtcp；空 = 未知）。
	 * 只用来如实标注「哪一档在你这台电脑上成立」，**不参与 toml 生成**
	 * （toml 只由 {@link #mode} + {@link #strategy} 决定）。
	 */
	public String pcMode = "";
	public String serverAddr = "";    // frps 地址（VPS）
	public int serverPort = 7000;     // frps 控制端口
	public String serverName = "dsh-remote";
	public String secretKey = "";     // 访客密钥（proxy 与 visitor 必须一致）
	public String authToken = "";     // frpc↔frps 登录密钥
	public int bindPort = 18443;      // 与电脑端网关 listenPort 对齐，App 不让用户改
	public String fingerprint = "";   // 网关自签证书 SHA-256（hex 小写无冒号；空 = 退化为 TOFU 确认）

	/**
	 * T31-1：frpc 控制连接心跳（秒）。与网关 renderFrpcToml/renderVisitorToml 的缺省一致；
	 * 写成 ≤0 即不输出这两行（回落 frp 内建默认 30/90）。
	 * 刻意不做用户可见开关：只在访客配置里改，且 App 不让用户编辑这段 toml。
	 */
	public int heartbeatIntervalSec = 25;
	public int heartbeatTimeoutSec = 90;

	/**
	 * T113：xtcp 打洞尝试的**超时预算**（毫秒），即 toml 里的 {@code fallbackTimeoutMs}。
	 *
	 * <p>取值依据（全部来自 T111 的实测，见 scratch/t111/report.md §3.3）：
	 * <ul>
	 *   <li>frp 自己的缺省是 <b>5000</b>。本装置实测：配置 5000 ⇒ 每一次新建 TCP 连接
	 *       稳定付 5057–5162 ms（3 个不同体积资源各 3 次，体积从 76 KB 到 741 KB 耗时不变
	 *       ⇒ 这是定时器不是带宽），而打不通之后回落 stcp 中转本身只要 <b>49–142 ms</b>。
	 *       稳态「点连接 → 可用」14.08 s 里有 <b>10.37 s（73.6%）</b>就是两段 5 s 空等。</li>
	 *   <li><b>800 ms</b>：一次连接的空等 ≈ 800 ms + δ（δ = 观测−配置，实测 57–162 ms，1–3%），
	 *       首屏那 2 条连接合计 ≈ 1.7 s，满足「空等 ≤2 s」的验收线并留余量。</li>
	 *   <li>为什么不再大一档（1000–1200 ms）：空等是**每条新连接**都要付的（frpc 的
	 *       fallbackTimeoutMs 是 per-connection 的 ctx 超时），越大越直接变成用户可见等待；
	 *       而打洞成功后回落成本只有 49–142 ms，压小超时对"打得通"的网络几乎无损。</li>
	 *   <li>为什么敢压到 800 ms：打洞预算 800 ms ≈ 移动网 RTT 60–150 ms 的 5–13 倍往返，
	 *       足够走完「visitor→frps 准备 + frps 回报对端地址 + UDP 探测 + 会话建立」；
	 *       且**打洞能力本身没有被取消**（toml 里 xtcp 访客 + keepTunnelOpen 一字未动）。
	 *       连续失败由 {@link TunnelPath} 的粘性回落兜底，不是靠这一个数硬扛。</li>
	 * </ul>
	 * 跨端一致性：网关 packages/gateway/src/frp.ts 的 renderVisitorToml 必须用同一个值，
	 * 由 scratch/t104/cross-end.mjs 逐行对齐（否则两端生成的 toml 会漂移）。
	 */
	public static final int FALLBACK_TIMEOUT_MS = 800;

	/** 从 dsh-remote://visitor?... 解析；格式不对返回 null。 */
	public static VisitorConfig parse(String link) {
		if (link == null) return null;
		Uri uri;
		try {
			uri = Uri.parse(link.trim());
		} catch (Exception e) {
			return null;
		}
		if (!"dsh-remote".equals(uri.getScheme()) || !"visitor".equals(uri.getHost())) return null;
		VisitorConfig c = new VisitorConfig();
		String v = uri.getQueryParameter("mode");
		if ("stcp".equals(v) || "xtcp".equals(v)) c.mode = v;
		// T104：链接里的 mode 就是**电脑端形态**（visitorConnectionString 写的 normalizeFrpMode）。
		// entry 不进 mode（那会改变 toml 生成），只进 pcMode，供 UI 如实标注/禁用。
		c.pcMode = normalizePcMode(v);
		c.serverAddr = nz(uri.getQueryParameter("server"));
		v = uri.getQueryParameter("cport");
		c.serverPort = parseInt(v, c.serverPort);
		v = uri.getQueryParameter("name");
		if (!TextUtils.isEmpty(v)) c.serverName = v;
		c.secretKey = nz(uri.getQueryParameter("sk"));
		c.authToken = nz(uri.getQueryParameter("token"));
		v = uri.getQueryParameter("bport");
		c.bindPort = ProfileStore.BIND_PORT;
		if (!TextUtils.isEmpty(v)) c.bindPort = parseInt(v, c.bindPort);
		v = uri.getQueryParameter("fp");
		if (!TextUtils.isEmpty(v)) c.fingerprint = v.toLowerCase(Locale.US).replace(":", "");
		return c.isValid() ? c : null;
	}

	public boolean isValid() {
		return serverAddr.length() > 0 && serverPort >= 1 && serverPort <= 65535
			&& serverName.length() > 0 && secretKey.length() > 0 && authToken.length() > 0
			&& bindPort >= 1 && bindPort <= 65535;
	}

	/** 渲染访客侧 frpc.toml —— 与网关 renderVisitorToml 同构。 */
	public String toToml() {
		StringBuilder b = new StringBuilder();
		b.append("# 由 DSH Remote App 自动生成\n");
		b.append("serverAddr = \"").append(serverAddr).append("\"\n");
		b.append("serverPort = ").append(serverPort).append("\n\n");
		b.append("auth.token = \"").append(authToken).append("\"\n");
		b.append("transport.tls.enable = true\n");
		if (heartbeatIntervalSec > 0) {
			b.append("transport.heartbeatInterval = ").append(heartbeatIntervalSec).append("\n");
			// 与网关 resolveFrpHeartbeat 同策略：超时必须严格大于周期，否则抬成周期的 2 倍
			int timeout = heartbeatTimeoutSec > heartbeatIntervalSec ? heartbeatTimeoutSec : heartbeatIntervalSec * 2;
			b.append("transport.heartbeatTimeout = ").append(timeout).append("\n");
		}
		b.append("\n");
		if ("xtcp".equals(mode) && STRATEGY_P2P.equals(strategy)) {
			// ── 打洞优先（默认档）：**逐字保持 T104 之前的样子** ──
			// 网关 xtcp 形态同时注册了 `<名>-stcp`（stcp）与 `<名>`（xtcp）两条代理，
			// 所以访客侧也要两条：先试 xtcp 打洞，{@link #FALLBACK_TIMEOUT_MS} 毫秒不通就
			// fallbackTo 那条 stcp 访客走中转。
			String stcpVisitor = serverName + "-stcp-visitor";
			b.append("[[visitors]]\n");
			b.append("name = \"").append(stcpVisitor).append("\"\n");
			b.append("type = \"stcp\"\n");
			b.append("serverName = \"").append(serverName).append("-stcp\"\n");
			b.append("secretKey = \"").append(secretKey).append("\"\n");
			b.append("bindPort = -1\n\n");
			b.append("[[visitors]]\n");
			b.append("name = \"").append(serverName).append("-visitor\"\n");
			b.append("type = \"xtcp\"\n");
			b.append("serverName = \"").append(serverName).append("\"\n");
			b.append("secretKey = \"").append(secretKey).append("\"\n");
			b.append("bindAddr = \"127.0.0.1\"\n");
			b.append("bindPort = ").append(bindPort).append("\n");
			b.append("keepTunnelOpen = true\n");
			b.append("fallbackTo = \"").append(stcpVisitor).append("\"\n");
			// T113：5000 → FALLBACK_TIMEOUT_MS（缺省 800）。语义与写法一字未新：
			// 仍是同一条 fallbackTo 关系上的同一个 toml 键，只改数值。
			b.append("fallbackTimeoutMs = ").append(FALLBACK_TIMEOUT_MS).append("\n");
			return b.toString();
		}
		if ("xtcp".equals(mode)) {
			// ── 只用中转（电脑端=xtcp）：**不试打洞** ──
			// 一字不新：直接把上面那条 fallback stcp 访客拿来**直接绑真实端口**
			// （-1 → bindPort），没有 xtcp 访客、没有 fallbackTo/keepTunnelOpen
			// ⇒ frpc 里没有任何一条会去打洞的路径。
			// 名字与 serverName 保持与 fallback 访客**逐字相同**（`<名>-stcp-visitor` /
			// `<名>-stcp`）：那是网关侧唯一注册过的 stcp 代理名，自己发明名字会连不上。
			b.append("[[visitors]]\n");
			b.append("name = \"").append(serverName).append("-stcp-visitor\"\n");
			b.append("type = \"stcp\"\n");
			b.append("serverName = \"").append(serverName).append("-stcp\"\n");
			b.append("secretKey = \"").append(secretKey).append("\"\n");
			b.append("bindAddr = \"127.0.0.1\"\n");
			b.append("bindPort = ").append(bindPort).append("\n");
			return b.toString();
		}
		// ── 电脑端=stcp / 策略=只用中转：与 T104 之前**逐字相同**的 stcp 访客 ──
		b.append("[[visitors]]\n");
		b.append("name = \"").append(serverName).append("-visitor\"\n");
		b.append("type = \"stcp\"\n");
		b.append("serverName = \"").append(serverName).append("\"\n");
		b.append("secretKey = \"").append(secretKey).append("\"\n");
		b.append("bindAddr = \"127.0.0.1\"\n");
		b.append("bindPort = ").append(bindPort).append("\n");
		return b.toString();
	}

	/**
	 * T104：本档**实际生效**的策略。电脑端只有 stcp 代理（mode=stcp）时打洞无从谈起
	 * ⇒ 恒为 relay（既有行为逐字不变：那时本来就只写一条 stcp 访客）。
	 */
	public String effectiveStrategy() {
		return "xtcp".equals(mode) && STRATEGY_P2P.equals(strategy) ? STRATEGY_P2P : STRATEGY_RELAY;
	}

	/** 非 relay 即 p2p（存量配置/缺省都落回打洞优先，行为与改前一致）。 */
	public static String normalizeStrategy(String raw) {
		return STRATEGY_RELAY.equals(raw) ? STRATEGY_RELAY : STRATEGY_P2P;
	}

	/** 电脑端形态归一化：只认 entry/stcp/xtcp，其余（含 null）= 未知（空串）。 */
	public static String normalizePcMode(String raw) {
		if ("entry".equals(raw) || "stcp".equals(raw) || "xtcp".equals(raw)) return raw;
		return "";
	}

	// ---------- 持久化 ----------

	private static final String P_MODE = "vp_mode";
	private static final String P_SERVER = "vp_server";
	private static final String P_CPORT = "vp_cport";
	private static final String P_NAME = "vp_name";
	private static final String P_SK = "vp_sk";
	private static final String P_TOKEN = "vp_token";
	private static final String P_BPORT = "vp_bport";
	private static final String P_FP = "vp_fp";
	/** T104：打洞策略 / 电脑端形态（存量键不存在 ⇒ 落回打洞优先 + 未知形态，行为与改前一致）。 */
	private static final String P_STRATEGY = "vp_strategy";
	private static final String P_PCMODE = "vp_pcmode";

	public void save(SharedPreferences p) {
		p.edit()
			.putString(P_MODE, mode)
			.putString(P_SERVER, serverAddr)
			.putInt(P_CPORT, serverPort)
			.putString(P_NAME, serverName)
			.putString(P_SK, secretKey)
			.putString(P_TOKEN, authToken)
			.putInt(P_BPORT, bindPort)
			.putString(P_FP, fingerprint)
			.putString(P_STRATEGY, normalizeStrategy(strategy))
			.putString(P_PCMODE, normalizePcMode(pcMode))
			.apply();
	}

	public void load(SharedPreferences p) {
		mode = p.getString(P_MODE, mode);
		serverAddr = p.getString(P_SERVER, "");
		serverPort = p.getInt(P_CPORT, serverPort);
		serverName = p.getString(P_NAME, serverName);
		secretKey = p.getString(P_SK, "");
		authToken = p.getString(P_TOKEN, "");
		bindPort = p.getInt(P_BPORT, bindPort);
		fingerprint = p.getString(P_FP, "");
		strategy = normalizeStrategy(p.getString(P_STRATEGY, strategy));
		pcMode = normalizePcMode(p.getString(P_PCMODE, pcMode));
	}

	public boolean existsIn(SharedPreferences p) {
		return !TextUtils.isEmpty(p.getString(P_SK, null));
	}

	// ---------- 工具 ----------

	private static String nz(String s) {
		return s == null ? "" : s.trim();
	}

	private static int parseInt(String s, int fallback) {
		try {
			return Integer.parseInt(nz(s));
		} catch (NumberFormatException e) {
			return fallback;
		}
	}
}
