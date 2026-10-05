package top.d1studio.dshremote;

import android.content.SharedPreferences;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Android 端配置组：与电脑插件面板相同的五项
 * （VPS / 控制端口 / 隧道名 / 登录密钥 / 访客密钥）。
 * 本地监听端口首选 18443（与网关 listenPort 对齐），被占用时在
 * 16225~16235 内协商首个空闲端口（AND-07），均无需用户填写。
 */
public final class ProfileStore {

	public static final int BIND_PORT = 18443;
	/** AND-07：首选端口被占用时的回退探测范围（含端点）。 */
	public static final int PORT_RANGE_MIN = 16225;
	public static final int PORT_RANGE_MAX = 16235;
	/** AND-07：本轮隧道实际绑定端口的持久化键（MainActivity/TunnelService 复用探测用）。 */
	public static final String KEY_BOUND_PORT = "tunnel_bound_port";
	/** 与 KEY_BOUND_PORT 成对落盘：当前前台隧道实际服务的配置组 id。复用探测据此判断能否直接复用。 */
	public static final String KEY_TUNNEL_PROFILE = "tunnel_profile_id";
	/**
	 * T104：与 KEY_BOUND_PORT 成对落盘 —— 当前前台隧道**实际生效的打洞策略**。
	 * 复用存活隧道时要比它：策略变了就必须重启隧道（否则"切档"会名不副实，
	 * 用户看到新选项被选中、跑的却还是旧配置）。
	 */
	public static final String KEY_TUNNEL_STRATEGY = "tunnel_strategy";

	public static final String DEFAULT_MODE = "xtcp";
	public static final String DEFAULT_TUNNEL_NAME = "dsh-remote";
	private static final java.util.regex.Pattern TUNNEL_NAME =
		java.util.regex.Pattern.compile("^[A-Za-z][A-Za-z0-9_-]{0,31}$");

	private static final String KEY_PROFILES = "vp_profiles";
	private static final String KEY_ACTIVE = "vp_active_id";
	/** 直连节点列表（名称 + 网关地址），与 FRP 配置组同款卡片交互。 */
	public static final String KEY_DIRECT_NODES = "direct_nodes";
	public static final String KEY_DIRECT_ACTIVE = "direct_active_id";

	public static final class DirectNode {
		public String id = "";
		public String name = "";
		public String url = "";

		public boolean isValid() {
			try {
				java.net.URI uri = new java.net.URI(url);
				return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
					&& uri.getRawUserInfo() == null && (uri.getPort() == -1
						|| (uri.getPort() >= 1 && uri.getPort() <= 65535));
			} catch (Exception ignored) {
				return false;
			}
		}

		JSONObject toJson() {
			JSONObject o = new JSONObject();
			try {
				o.put("id", id);
				o.put("name", name);
				o.put("url", url);
			} catch (Exception ignored) {
			}
			return o;
		}

		static DirectNode fromJson(JSONObject o) {
			DirectNode n = new DirectNode();
			n.id = o.optString("id", "");
			n.name = o.optString("name", "");
			n.url = o.optString("url", "");
			return n;
		}
	}

	public static final class Profile {
		public String id = "";
		public String name = "";
		public String serverAddr = "";
		public int serverPort = 7000;
		public String authToken = "";
		public String secretKey = "";
		public String mode = DEFAULT_MODE;
		/**
		 * T104：打洞策略（每个配置组各自保存）。{@code p2p}=打洞优先（默认，行为与改前逐字相同）；
		 * {@code relay}=只用中转。**是否真正可选由电脑端形态决定**，见
		 * {@link ProfileStore#p2pAvailable} / {@link ProfileStore#relayAvailable}。
		 */
		public String strategy = VisitorConfig.STRATEGY_P2P;
		/**
		 * T104：电脑端隧道形态（导入链接里的 mode：entry/stcp/xtcp；空 = 未知，手工填的配置组没有）。
		 * 只用于 UI 如实标注「哪一档在你这台电脑上成立」，不参与 toml 生成。
		 */
		public String pcMode = "";
		/** 与电脑端 frp.name 一致，写进 frps 的 proxy 名；不是配置组显示名。 */
		public String tunnelName = DEFAULT_TUNNEL_NAME;
		/**
		 * T23-A：网关自签证书 SHA-256（hex 小写无冒号）。
		 *
		 * 改前这个指纹在导入时就被丢掉了：Profile 没有该字段，toVisitorConfig() 写死
		 * fingerprint=""，于是 MainActivity 的「二维码携带的指纹在首连前预置」分支
		 * （cfg.fingerprint.length()==64）永远不成立——**预置是死代码**，每次隧道连接
		 * 必然落到 TOFU「信任此服务器？」。存下来之后，两个配置档各自带着自己那台电脑的
		 * 指纹，按配置档身份锁定（见 CertPin），切档才不会再互相误报。
		 */
		public String fingerprint = "";

		public boolean isValid() {
			return serverAddr.length() > 0
				&& serverPort >= 1 && serverPort <= 65535
				&& authToken.length() > 0
				&& secretKey.length() > 0;
		}

		public VisitorConfig toVisitorConfig() {
			VisitorConfig c = new VisitorConfig();
			c.mode = DEFAULT_MODE.equals(mode) || "stcp".equals(mode) ? mode : DEFAULT_MODE;
			c.serverAddr = serverAddr;
			c.serverPort = serverPort;
			c.serverName = normalizeTunnelName(tunnelName);
			c.secretKey = secretKey;
			c.authToken = authToken;
			c.bindPort = BIND_PORT;
			c.fingerprint = CertPin.normalizeFingerprint(fingerprint);
			// T104：策略原样带过去；"打洞优先在这台电脑上不成立"时由 VisitorConfig.effectiveStrategy()
			// 统一落回 relay（判据只有一处，UI 与 toml 不会各说一套）。
			c.strategy = effectiveStrategy(this);
			c.pcMode = VisitorConfig.normalizePcMode(pcMode);
			return c;
		}

		JSONObject toJson() {
			JSONObject o = new JSONObject();
			try {
				o.put("id", id);
				o.put("name", name);
				o.put("serverAddr", serverAddr);
				o.put("serverPort", serverPort);
				o.put("authToken", authToken);
				o.put("secretKey", secretKey);
				o.put("mode", mode);
				o.put("strategy", VisitorConfig.normalizeStrategy(strategy));
				o.put("pcMode", VisitorConfig.normalizePcMode(pcMode));
				o.put("tunnelName", tunnelName);
				o.put("fingerprint", fingerprint);
			} catch (Exception ignored) {
			}
			return o;
		}

		static Profile fromJson(JSONObject o) {
			Profile p = new Profile();
			p.id = o.optString("id", "");
			p.name = o.optString("name", "");
			p.serverAddr = o.optString("serverAddr", "");
			p.serverPort = o.optInt("serverPort", 7000);
			p.authToken = o.optString("authToken", "");
			p.secretKey = o.optString("secretKey", "");
			String mode = o.optString("mode", DEFAULT_MODE);
			p.mode = "stcp".equals(mode) ? "stcp" : DEFAULT_MODE;
			// T104：存量配置组没有这两个键（optString 兜空）⇒ 落回「打洞优先 + 形态未知」，
			// 与改前行为逐字一致，绝不因为升级而把用户静默切成中转。
			p.strategy = VisitorConfig.normalizeStrategy(o.optString("strategy", ""));
			p.pcMode = VisitorConfig.normalizePcMode(o.optString("pcMode", ""));
			p.tunnelName = normalizeTunnelName(o.optString("tunnelName", DEFAULT_TUNNEL_NAME));
			// 存量配置组没有这个键（optString 兜空），由 toVisitorConfig() 规范化为空串
			// ⇒ 退化到 TOFU，不会拿旧值误判。
			p.fingerprint = CertPin.normalizeFingerprint(o.optString("fingerprint", ""));
			return p;
		}
	}

	private ProfileStore() {}

	public static List<DirectNode> listDirect(SharedPreferences prefs) {
		List<DirectNode> nodes = new ArrayList<>();
		try {
			JSONArray arr = new JSONArray(prefs.getString(KEY_DIRECT_NODES, "[]"));
			for (int i = 0; i < arr.length(); i++) {
				JSONObject value = arr.optJSONObject(i);
				if (value == null) continue;
				DirectNode node = DirectNode.fromJson(value);
				if (!node.id.isEmpty() && node.isValid()) nodes.add(node);
			}
		} catch (Exception ignored) {}
		return nodes;
	}

	private static void saveDirect(SharedPreferences prefs, List<DirectNode> nodes) {
		JSONArray arr = new JSONArray();
		for (DirectNode node : nodes) arr.put(node.toJson());
		prefs.edit().putString(KEY_DIRECT_NODES, arr.toString()).apply();
	}

	public static void upsertDirect(SharedPreferences prefs, DirectNode node) {
		if (!node.isValid()) throw new IllegalArgumentException("无效的 HTTPS 网关地址");
		if (TextUtils.isEmpty(node.id)) node.id = UUID.randomUUID().toString();
		List<DirectNode> nodes = listDirect(prefs);
		for (int i = 0; i < nodes.size(); i++) {
			if (node.id.equals(nodes.get(i).id)) {
				nodes.set(i, node);
				saveDirect(prefs, nodes);
				return;
			}
		}
		nodes.add(node);
		saveDirect(prefs, nodes);
	}

	public static void deleteDirect(SharedPreferences prefs, String id) {
		List<DirectNode> nodes = listDirect(prefs);
		for (int i = nodes.size() - 1; i >= 0; i--) {
			if (id.equals(nodes.get(i).id)) nodes.remove(i);
		}
		saveDirect(prefs, nodes);
		if (id.equals(prefs.getString(KEY_DIRECT_ACTIVE, ""))) {
			prefs.edit().remove(KEY_DIRECT_ACTIVE).apply();
		}
	}

	/** 只迁移一次；用户删空列表后不得把旧地址重新加回来。 */
	public static void migrateDirect(SharedPreferences prefs) {
		if (prefs.contains(KEY_DIRECT_NODES)) return;
		DirectNode node = new DirectNode();
		node.url = prefs.getString("gateway_url", "").trim();
		List<DirectNode> nodes = new ArrayList<>();
		if (node.isValid()) {
			node.id = UUID.randomUUID().toString();
			node.name = "原直连入口";
			nodes.add(node);
		}
		saveDirect(prefs, nodes);
	}

	public static List<Profile> list(SharedPreferences prefs) {
		List<Profile> out = new ArrayList<>();
		String raw = prefs.getString(KEY_PROFILES, "");
		if (TextUtils.isEmpty(raw)) return out;
		try {
			JSONArray arr = new JSONArray(raw);
			for (int i = 0; i < arr.length(); i++) {
				Profile p = Profile.fromJson(arr.getJSONObject(i));
				if (p.id.length() > 0) out.add(p);
			}
		} catch (Exception ignored) {
		}
		return out;
	}

	public static void saveAll(SharedPreferences prefs, List<Profile> profiles) {
		JSONArray arr = new JSONArray();
		for (Profile p : profiles) arr.put(p.toJson());
		prefs.edit().putString(KEY_PROFILES, arr.toString()).apply();
	}

	public static String getActiveId(SharedPreferences prefs) {
		return prefs.getString(KEY_ACTIVE, "");
	}

	public static void setActiveId(SharedPreferences prefs, String id) {
		prefs.edit().putString(KEY_ACTIVE, id == null ? "" : id).apply();
	}

	public static Profile getActive(SharedPreferences prefs) {
		String id = getActiveId(prefs);
		List<Profile> profiles = list(prefs);
		if (!TextUtils.isEmpty(id)) {
			for (Profile p : profiles) {
				if (id.equals(p.id)) return p;
			}
		}
		return profiles.isEmpty() ? null : profiles.get(0);
	}

	public static Profile get(SharedPreferences prefs, String id) {
		if (TextUtils.isEmpty(id)) return null;
		for (Profile p : list(prefs)) {
			if (id.equals(p.id)) return p;
		}
		return null;
	}

	public static void upsert(SharedPreferences prefs, Profile profile) {
		if (profile.id == null || profile.id.length() == 0) {
			profile.id = UUID.randomUUID().toString();
		}
		List<Profile> profiles = list(prefs);
		boolean found = false;
		for (int i = 0; i < profiles.size(); i++) {
			if (profile.id.equals(profiles.get(i).id)) {
				profiles.set(i, profile);
				found = true;
				break;
			}
		}
		if (!found) profiles.add(profile);
		saveAll(prefs, profiles);
		if (TextUtils.isEmpty(getActiveId(prefs))) setActiveId(prefs, profile.id);
	}

	public static void delete(SharedPreferences prefs, String id) {
		List<Profile> profiles = list(prefs);
		for (int i = profiles.size() - 1; i >= 0; i--) {
			if (id.equals(profiles.get(i).id)) profiles.remove(i);
		}
		saveAll(prefs, profiles);
		if (id.equals(getActiveId(prefs))) {
			setActiveId(prefs, profiles.isEmpty() ? "" : profiles.get(0).id);
		}
	}

	// ---------- T104：打洞策略在「这台电脑端形态」下是否成立 ----------
	//
	// 两档的成立条件完全由**电脑端注册了哪条代理**决定（frp 的 visitor 只能消费 serverName
	// 对应的那条 proxy）：
	//   xtcp 形态 → 同时注册 `<名>-stcp`(stcp) 与 `<名>`(xtcp) ⇒ 打洞优先 ✅ / 只用中转 ✅
	//   stcp 形态 → 只注册 `<名>`(stcp)                        ⇒ 打洞优先 ❌ / 只用中转 ✅
	//   entry 形态 → 一条访客代理都没有（公网入口）            ⇒ 两档都 ❌
	// 形态从导入链接的 mode 参数来；手工填的配置组形态未知（""），按 xtcp 保守处理——
	// 宁可让用户点了之后失败时能看到真话（诊断行会说实际路径），也不谎称某档"不可用"。

	/** 打洞优先是否可用：电脑端必须是 xtcp 形态（只有它额外注册了 xtcp 代理）。 */
	public static boolean p2pAvailable(Profile p) {
		if (p == null) return false;
		if (!DEFAULT_MODE.equals(p.mode)) return false; // stcp 档：没有 xtcp 代理
		return !"stcp".equals(VisitorConfig.normalizePcMode(p.pcMode))
			&& !VisitorConfig.PC_MODE_ENTRY.equals(VisitorConfig.normalizePcMode(p.pcMode));
	}

	/** 只用中转是否可用：电脑端必须注册了 stcp 代理（xtcp 的 `<名>-stcp` 或 stcp 的 `<名>`）。 */
	public static boolean relayAvailable(Profile p) {
		if (p == null) return false;
		return !VisitorConfig.PC_MODE_ENTRY.equals(VisitorConfig.normalizePcMode(p.pcMode));
	}

	/** 电脑端是 entry 形态：不注册任何访客代理 ⇒ 两档都用不上（UI 必须如实说清，不许假装能用）。 */
	public static boolean tunnelUnavailable(Profile p) {
		return p != null && VisitorConfig.PC_MODE_ENTRY.equals(VisitorConfig.normalizePcMode(p.pcMode));
	}

	/**
	 * T104：电脑端形态 → 访客 toml 形态。这两者是**绑死的**：
	 * stcp 形态的电脑端只注册了 `<名>`(stcp) 一条代理 ⇒ 访客也必须是 stcp
	 * （xtcp 访客会去找根本不存在的 `<名>`(xtcp) 代理，必然连不上——这正是导入链接里
	 * mode=stcp 时改前的老毛病）。其余形态（xtcp / entry / 未知）沿用历史 xtcp 访客。
	 */
	public static String modeForPcMode(String pcMode) {
		return "stcp".equals(VisitorConfig.normalizePcMode(pcMode)) ? "stcp" : DEFAULT_MODE;
	}

	/**
	 * T104：把用户选的档位收敛成**在这一档上真正成立**的那一档。
	 *
	 * <p>⚠ 只在不成立时收敛，成立时**原样尊重用户的选择** —— 这是 T104 设备级验证抓到的真 bug：
	 * 第一版写成「p2p 成立就强制回 p2p」，结果电脑端是 xtcp（两档都成立）时，用户点「只用中转」
	 * 会被立刻弹回「打洞优先」，**"人工二选一"名存实亡**（截图佐证：scratch/t104/ev/p03b-*.png
	 * 点完仍高亮打洞优先）。收敛的方向必须是"从不成立→成立"，绝不能是"总是回默认"。
	 *
	 * <p>entry 形态两档都不成立：UI 已把两个按钮都禁用并写明理由，这里**不偷偷改**
	 * （保持历史行为：entry 档仍按 mode=xtcp 生成访客配置，与改前逐字相同）。
	 */
	public static String coerceStrategy(Profile p, String selected) {
		String want = VisitorConfig.normalizeStrategy(selected);
		if (p == null || tunnelUnavailable(p)) return want;
		if (VisitorConfig.STRATEGY_P2P.equals(want) && !p2pAvailable(p)) return VisitorConfig.STRATEGY_RELAY;
		if (VisitorConfig.STRATEGY_RELAY.equals(want) && !relayAvailable(p)) return VisitorConfig.STRATEGY_P2P;
		return want;
	}

	/**
	 * T104：本档**实际会写进 toml** 的策略（= 用户选择经可用性收敛后的结果）。
	 * UI 显示的档位与 toml 里那一档必须来自这同一个函数，否则两边会各说一套。
	 */
	public static String effectiveStrategy(Profile p) {
		if (p == null) return VisitorConfig.STRATEGY_P2P;
		return coerceStrategy(p, p.strategy);
	}

	public static String normalizeTunnelName(String raw) {
		if (TextUtils.isEmpty(raw)) return DEFAULT_TUNNEL_NAME;
		String trimmed = raw.trim();
		if (trimmed.length() == 0) return DEFAULT_TUNNEL_NAME;
		return TUNNEL_NAME.matcher(trimmed).matches() ? trimmed : DEFAULT_TUNNEL_NAME;
	}

	public static boolean isValidTunnelNameInput(String raw) {
		if (raw == null) return true;
		String trimmed = raw.trim();
		return trimmed.length() == 0 || TUNNEL_NAME.matcher(trimmed).matches();
	}

	/**
	 * AND-07：端口协商。首选 BIND_PORT；被占用时在
	 * PORT_RANGE_MIN~PORT_RANGE_MAX 内探测首个可绑定端口；全部占用返回 -1。
	 * 探测方式：对 127.0.0.1 真实 bind（与 frpc visitor 的 bindAddr 一致）。
	 * 探测与 frpc 实际 bind 之间仍有极小竞态窗口，由 frpc 崩溃自重启兜底。
	 */
	public static int negotiateBindPort() {
		if (isBindable(BIND_PORT)) return BIND_PORT;
		for (int p = PORT_RANGE_MIN; p <= PORT_RANGE_MAX; p++) {
			if (isBindable(p)) return p;
		}
		return -1;
	}

	private static boolean isBindable(int port) {
		ServerSocket socket = null;
		try {
			socket = new ServerSocket();
			socket.bind(new InetSocketAddress("127.0.0.1", port));
			return true;
		} catch (Exception ignored) {
			return false;
		} finally {
			if (socket != null) {
				try {
					socket.close();
				} catch (IOException ignored) {
				}
			}
		}
	}

	public static Profile newProfile() {
		Profile p = new Profile();
		p.id = UUID.randomUUID().toString();
		p.serverPort = 7000;
		p.mode = DEFAULT_MODE;
		p.tunnelName = DEFAULT_TUNNEL_NAME;
		return p;
	}

	/** 把上一版单条 vp_* 配置迁成一个配置组。 */
	public static void migrateLegacy(SharedPreferences prefs) {
		if (!list(prefs).isEmpty()) return;
		VisitorConfig legacy = new VisitorConfig();
		legacy.load(prefs);
		if (!legacy.isValid()) return;
		Profile p = new Profile();
		p.id = UUID.randomUUID().toString();
		p.name = TextUtils.isEmpty(legacy.serverName) || "dsh-remote".equals(legacy.serverName)
			? legacy.serverAddr
			: legacy.serverName;
		p.serverAddr = legacy.serverAddr;
		p.serverPort = legacy.serverPort;
		p.authToken = legacy.authToken;
		p.secretKey = legacy.secretKey;
		p.mode = "stcp".equals(legacy.mode) ? "stcp" : DEFAULT_MODE;
		// T104：存量单条配置没有策略键 ⇒ 打洞优先（与改前行为逐字一致）；
		// 形态未记录 ⇒ 未知（按 xtcp 保守处理，不谎称某档不可用）。
		p.strategy = VisitorConfig.normalizeStrategy(legacy.strategy);
		p.pcMode = VisitorConfig.normalizePcMode(legacy.pcMode);
		p.tunnelName = normalizeTunnelName(legacy.serverName);
		upsert(prefs, p);
		setActiveId(prefs, p.id);
	}
}
