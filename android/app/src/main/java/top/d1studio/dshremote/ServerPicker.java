package top.d1studio.dshremote;

import android.content.SharedPreferences;
import java.net.URI;
import java.util.Collections;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** 页面只接收显示元数据；连接配置与当前连接身份始终由原生持有。 */
final class ServerPicker {

	static final String TUNNEL = "tunnel";
	static final String DIRECT = "direct";

	/** 捕获本次连接的配置值；编辑保存的节点不会悄悄改写正在运行的连接。 */
	static final class Current {
		private final String kind, id, key, name;
		private Current(String kind, String id, String key, String name) {
			this.kind = kind; this.id = id; this.key = key; this.name = name;
		}
		static Current tunnel(ProfileStore.Profile profile) {
			return new Current(TUNNEL, profile.id, profileKey(profile), profile.name.isEmpty() ? profile.serverAddr : profile.name);
		}
		static Current direct(ProfileStore.DirectNode node) {
			return new Current(DIRECT, node.id, node.url, node.name.isEmpty() ? URI.create(node.url).getHost() : node.name);
		}
		boolean matches(ProfileStore.Profile profile) {
			return TUNNEL.equals(kind) && id.equals(profile.id) && key.equals(profileKey(profile));
		}
		boolean matches(ProfileStore.DirectNode node) {
			return DIRECT.equals(kind) && id.equals(node.id) && key.equals(node.url);
		}
	}

	private static String profileKey(ProfileStore.Profile profile) {
		JSONObject json = profile.toJson();
		json.remove("name");
		// 本地端口是运行时分配的，不是「这是不是同一台服务器」的身份。
		json.remove("bindPort");
		return json.toString();
	}

	static JSONObject snapshot(SharedPreferences prefs, Current connection,
		String gatewayHost) throws JSONException {
		return snapshot(prefs, connection, gatewayHost, null);
	}

	/**
	 * @param tunnelReachability 探活结果，隧道和直连都用服务器 id 做键。
	 *        {@code up} 握手成功，{@code down} 握不上。没探过的保持未连接。
	 *        正在打开的那一页仍算可连接，除非结果已经是 down。
	 */
	static JSONObject snapshot(SharedPreferences prefs, Current connection,
		String gatewayHost, Map<String, String> tunnelReachability) throws JSONException {
		if (tunnelReachability == null) tunnelReachability = Collections.emptyMap();
		JSONArray entries = new JSONArray();
		String currentName = connection == null ? gatewayHost : connection.name;
		for (ProfileStore.Profile profile : ProfileStore.list(prefs)) {
			boolean current = connection != null && connection.matches(profile);
			String name = profile.name.isEmpty() ? profile.serverAddr : profile.name;
			boolean enabled = profile.isValid() && !ProfileStore.tunnelUnavailable(profile);
			entries.put(entry(TUNNEL, profile.id, name, "隧道 · " + profile.serverAddr,
				enabled, current, availability(enabled, current, tunnelReachability.get(profile.id))));
			if (current) currentName = name;
		}
		for (ProfileStore.DirectNode node : ProfileStore.listDirect(prefs)) {
			boolean current = connection != null && connection.matches(node);
			String host = URI.create(node.url).getHost();
			String name = node.name.isEmpty() ? host : node.name;
			entries.put(entry(DIRECT, node.id, name, "直连 · " + host, true, current,
				availability(true, current, tunnelReachability.get(node.id))));
			if (current) currentName = name;
		}
		return new JSONObject().put("entries", entries).put("currentName", currentName);
	}

	/** up 可连接，idle 还没探过，down 不可用。记住的结果在切到别的页面后还在。 */
	private static String availability(boolean enabled, boolean current, String probed) {
		if (!enabled) return "down";
		if ("down".equals(probed)) return "down";
		if ("up".equals(probed) || current) return "up";
		return "idle";
	}

	private static JSONObject entry(String kind, String id, String name, String detail,
		boolean enabled, boolean current, String status) throws JSONException {
		return new JSONObject().put("kind", kind).put("id", id).put("name", name)
			.put("detail", detail).put("enabled", enabled).put("current", current)
			.put("status", status);
	}

	/** 只认 https 的主机和端口。路径、大小写和 IPv6 括号都不构成另一台机器。 */
	static boolean sameGateway(String pageUrl, String targetUrl) {
		try {
			if (pageUrl == null || targetUrl == null) return false;
			URI page = new URI(pageUrl);
			URI target = new URI(targetUrl);
			if (!"https".equalsIgnoreCase(page.getScheme()) || !"https".equalsIgnoreCase(target.getScheme())) {
				return false;
			}
			if (page.getHost() == null || target.getHost() == null) return false;
			int pagePort = page.getPort() == -1 ? 443 : page.getPort();
			int targetPort = target.getPort() == -1 ? 443 : target.getPort();
			return host(page.getHost()).equalsIgnoreCase(host(target.getHost())) && pagePort == targetPort;
		} catch (java.net.URISyntaxException | NullPointerException error) {
			return false;
		}
	}

	/** 菜单里加载或保存一台服务器。成功时不含多余字段；失败时 {@code error} 给页面显示。 */
	static JSONObject applyEdit(SharedPreferences prefs, String op, JSONObject body,
		Current connection) throws JSONException {
		if (body == null) return error("缺少服务器内容");
		String kind = body.optString("kind", "");
		String id = body.optString("id", "");
		if ("load".equals(op)) return loadForm(prefs, kind, id);
		if ("delete".equals(op)) return deleteSaved(prefs, kind, id);
		if ("save".equals(op)) return saveForm(prefs, body, connection);
		return error("不支持的操作");
	}

	private static JSONObject loadForm(SharedPreferences prefs, String kind, String id) throws JSONException {
		if (TUNNEL.equals(kind)) {
			ProfileStore.Profile profile = ProfileStore.get(prefs, id);
			if (profile == null) return error("服务器已删除");
			return tunnelForm(profile);
		}
		if (DIRECT.equals(kind)) {
			ProfileStore.DirectNode node = findDirect(prefs, id);
			if (node == null) return error("服务器已删除");
			return new JSONObject().put("ok", true).put("kind", DIRECT).put("id", node.id)
				.put("name", node.name).put("url", node.url);
		}
		return error("不支持的服务器类型");
	}

	private static JSONObject tunnelForm(ProfileStore.Profile profile) throws JSONException {
		boolean hole = ProfileStore.p2pAvailable(profile);
		boolean relay = ProfileStore.relayAvailable(profile);
		String note = "";
		if (!hole && relay) note = "这台电脑没有打洞代理，只能走中转。";
		else if (hole && !relay) note = "这台电脑不能只用中转。";
		else if (!hole && !relay) note = "这台电脑没有访客代理，保存后也无法连上。";
		return new JSONObject().put("ok", true).put("kind", TUNNEL).put("id", profile.id)
			.put("name", profile.name).put("host", profile.serverAddr)
			.put("port", String.valueOf(profile.serverPort > 0 ? profile.serverPort : 7000))
			.put("tunnel", profile.tunnelName).put("token", "").put("sk", "")
			.put("strategy", ProfileStore.effectiveStrategy(profile))
			.put("p2pEnabled", hole).put("relayEnabled", relay).put("note", note);
	}

	private static JSONObject saveForm(SharedPreferences prefs, JSONObject body,
		Current connection) throws JSONException {
		String kind = body.optString("kind", "");
		if (TUNNEL.equals(kind)) return saveTunnel(prefs, body, connection);
		if (DIRECT.equals(kind)) return saveDirect(prefs, body, connection);
		return error("不支持的服务器类型");
	}

	private static JSONObject saveTunnel(SharedPreferences prefs, JSONObject body,
		Current connection) throws JSONException {
		String id = body.optString("id", "");
		boolean isNew = id.isEmpty();
		ProfileStore.Profile profile = isNew ? ProfileStore.newProfile() : ProfileStore.get(prefs, id);
		if (profile == null) return error("服务器已删除");
		boolean currentBefore = !isNew && connection != null && connection.matches(profile);
		profile.name = body.optString("name", "").trim();
		profile.serverAddr = body.optString("host", "").trim();
		String portRaw = body.optString("port", "").trim();
		int port = 7000;
		if (!portRaw.isEmpty()) {
			try {
				port = Integer.parseInt(portRaw);
			} catch (NumberFormatException error) {
				return error("控制端口无效");
			}
		}
		if (port < 1 || port > 65535) return error("控制端口无效");
		profile.serverPort = port;
		String tunnel = body.optString("tunnel", "").trim();
		if (!ProfileStore.isValidTunnelNameInput(tunnel)) {
			return error("隧道名须以字母开头，仅含字母数字和 - _，最长 32 位");
		}
		profile.tunnelName = ProfileStore.normalizeTunnelName(tunnel);
		String token = body.optString("token", "").trim();
		String sk = body.optString("sk", "").trim();
		if (!token.isEmpty()) profile.authToken = token;
		if (!sk.isEmpty()) profile.secretKey = sk;
		if (isNew && (profile.authToken.isEmpty() || profile.secretKey.isEmpty())) {
			return error("请填写完整：VPS 地址、控制端口、登录密钥、访客密钥");
		}
		profile.mode = ProfileStore.modeForPcMode(profile.pcMode);
		profile.strategy = ProfileStore.coerceStrategy(profile, body.optString("strategy", ""));
		if (profile.name.isEmpty()) profile.name = profile.serverAddr;
		if (!profile.isValid()) return error("请填写完整：VPS 地址、控制端口、登录密钥、访客密钥");
		ProfileStore.upsert(prefs, profile);
		boolean connect = isNew || (currentBefore && !connection.matches(profile));
		return new JSONObject().put("ok", true).put("connect", connect)
			.put("kind", TUNNEL).put("id", profile.id);
	}

	private static JSONObject saveDirect(SharedPreferences prefs, JSONObject body,
		Current connection) throws JSONException {
		String id = body.optString("id", "");
		boolean isNew = id.isEmpty();
		ProfileStore.DirectNode node = isNew ? new ProfileStore.DirectNode() : findDirect(prefs, id);
		if (node == null) return error("服务器已删除");
		boolean currentBefore = !isNew && connection != null && connection.matches(node);
		node.name = body.optString("name", "").trim();
		node.url = body.optString("url", "").trim();
		if (!node.isValid()) return error("请输入有效的 HTTPS 地址，不要带用户名和密码");
		if (node.name.isEmpty()) node.name = URI.create(node.url).getHost();
		ProfileStore.upsertDirect(prefs, node);
		boolean connect = isNew || (currentBefore && !connection.matches(node));
		return new JSONObject().put("ok", true).put("connect", connect)
			.put("kind", DIRECT).put("id", node.id);
	}

	private static JSONObject deleteSaved(SharedPreferences prefs, String kind, String id) throws JSONException {
		if (id.isEmpty()) return error("还没有保存，无需删除");
		if (TUNNEL.equals(kind)) {
			if (ProfileStore.get(prefs, id) == null) return error("服务器已删除");
			ProfileStore.delete(prefs, id);
			return new JSONObject().put("ok", true).put("connect", false);
		}
		if (DIRECT.equals(kind)) {
			if (findDirect(prefs, id) == null) return error("服务器已删除");
			ProfileStore.deleteDirect(prefs, id);
			return new JSONObject().put("ok", true).put("connect", false);
		}
		return error("不支持的服务器类型");
	}

	private static JSONObject error(String message) throws JSONException {
		return new JSONObject().put("ok", false).put("error", message);
	}

	static ProfileStore.DirectNode findDirect(SharedPreferences prefs, String id) {
		for (ProfileStore.DirectNode node : ProfileStore.listDirect(prefs)) {
			if (node.id.equals(id)) return node;
		}
		return null;
	}

	/**
	 * capability 不交给子框架；再按当前主文档与本轮连接校验，防止导航后的旧页面调用。
	 * 手机和平板都能用服务器菜单。{@code tablet} 只留着兼容原有调用，不再当门槛。
	 */
	static boolean authorized(String capability, String expected, boolean tablet, boolean inSession,
		String pageUrl, String gatewayHost, int gatewayPort) {
		if (!inSession || expected.isEmpty() || !expected.equals(capability)) return false;
		try {
			URI page = new URI(pageUrl);
			int port = page.getPort() == -1 ? 443 : page.getPort();
			return "https".equalsIgnoreCase(page.getScheme())
				&& page.getHost() != null && !gatewayHost.isEmpty()
				&& host(gatewayHost).equalsIgnoreCase(host(page.getHost())) && gatewayPort == port;
		} catch (java.net.URISyntaxException | NullPointerException error) {
			return false;
		}
	}

	private static String host(String value) {
		return value.startsWith("[") && value.endsWith("]") ? value.substring(1, value.length() - 1) : value;
	}
}
