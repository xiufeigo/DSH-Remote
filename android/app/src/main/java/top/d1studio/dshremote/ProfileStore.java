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
		/** 与电脑端 frp.name 一致，写进 frps 的 proxy 名；不是配置组显示名。 */
		public String tunnelName = DEFAULT_TUNNEL_NAME;

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
			c.fingerprint = "";
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
				o.put("tunnelName", tunnelName);
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
			p.tunnelName = normalizeTunnelName(o.optString("tunnelName", DEFAULT_TUNNEL_NAME));
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
		p.tunnelName = normalizeTunnelName(legacy.serverName);
		upsert(prefs, p);
		setActiveId(prefs, p.id);
	}
}
