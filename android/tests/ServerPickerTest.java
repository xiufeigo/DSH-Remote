package top.d1studio.dshremote;

import android.content.SharedPreferences;
import java.util.HashMap;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ServerPickerTest {
	private static int checks;
	private static void check(boolean value, String label) {
		if (!value) throw new AssertionError(label);
		checks++;
		System.out.println("ok " + label);
	}

	public static void main(String[] args) throws Exception {
		SharedPreferences prefs = DirectNodesTest.prefs(new HashMap<>());
		ProfileStore.Profile tunnel = new ProfileStore.Profile();
		tunnel.name = "家里 \"主机\"";
		tunnel.serverAddr = "tunnel.example";
		tunnel.authToken = "private-login-token";
		tunnel.secretKey = "private-visitor-secret";
		ProfileStore.upsert(prefs, tunnel);
		ProfileStore.Profile invalid = new ProfileStore.Profile();
		invalid.name = "未完成配置";
		ProfileStore.upsert(prefs, invalid);
		ProfileStore.DirectNode first = DirectNodesTest.node("直连 A", "https://home.example/?token=private-query");
		ProfileStore.DirectNode second = DirectNodesTest.node("直连 B", first.url);
		ProfileStore.upsertDirect(prefs, first);
		ProfileStore.upsertDirect(prefs, second);
		ProfileStore.setActiveId(prefs, tunnel.id);
		prefs.edit().putString(ProfileStore.KEY_DIRECT_ACTIVE, first.id).apply();
		ServerPicker.Current connected = ServerPicker.Current.direct(second);
		JSONObject snapshot = ServerPicker.snapshot(prefs, connected, "home.example");
		JSONArray entries = snapshot.getJSONArray("entries");
		check(entries.length() == 4, "both connection types included from saved configurations");
		check(snapshot.getString("currentName").equals(second.name), "runtime identity wins over persisted last selection");
		check(!entries.getJSONObject(2).getBoolean("current") && entries.getJSONObject(3).getBoolean("current"),
			"duplicate direct URLs still select exactly one saved identity");
		check(!entries.getJSONObject(1).getBoolean("enabled"), "incomplete profile is visible but unavailable");
		check("idle".equals(entries.getJSONObject(0).getString("status")), "saved tunnel that is not the open page stays unconnected");
		check("down".equals(entries.getJSONObject(1).getString("status")), "incomplete profile shows unavailable");
		check("idle".equals(entries.getJSONObject(2).getString("status")), "another direct address stays unconnected");
		check("up".equals(entries.getJSONObject(3).getString("status")), "the open direct page counts as reachable");
		java.util.Map<String, String> reach = new java.util.HashMap<String, String>();
		reach.put(tunnel.id, "down");
		check("down".equals(ServerPicker.snapshot(prefs, connected, "home.example", reach)
			.getJSONArray("entries").getJSONObject(0).getString("status")),
			"tunnel whose remote does not answer is unavailable behind another page");
		reach.put(tunnel.id, "up");
		check("up".equals(ServerPicker.snapshot(prefs, connected, "home.example", reach)
			.getJSONArray("entries").getJSONObject(0).getString("status")),
			"tunnel whose gateway answers is reachable behind another page");
		reach.put(tunnel.id, "down");
		check("down".equals(ServerPicker.snapshot(prefs, ServerPicker.Current.tunnel(tunnel), "127.0.0.1", reach)
			.getJSONArray("entries").getJSONObject(0).getString("status")),
			"the open page turns unavailable when its gateway stops answering");
		reach.put(first.id, "up");
		check("up".equals(ServerPicker.snapshot(prefs, connected, "home.example", reach)
			.getJSONArray("entries").getJSONObject(2).getString("status")),
			"a direct address that answers stays reachable behind another page");
		reach.put(first.id, "down");
		check("down".equals(ServerPicker.snapshot(prefs, connected, "home.example", reach)
			.getJSONArray("entries").getJSONObject(2).getString("status")),
			"a direct address that does not answer is unavailable");
		reach.put(second.id, "down");
		check("down".equals(ServerPicker.snapshot(prefs, connected, "home.example", reach)
			.getJSONArray("entries").getJSONObject(3).getString("status")),
			"the open direct page turns unavailable when its gateway stops answering");
		String json = snapshot.toString();
		check(!json.contains("private-") && !json.contains("authToken") && !json.contains("secretKey") && !json.contains("?token"),
			"page metadata contains no credentials or direct URL query");
		ServerPicker.Current connectedTunnel = ServerPicker.Current.tunnel(tunnel);
		check(ServerPicker.snapshot(prefs, connectedTunnel, "127.0.0.1").getString("currentName").equals(tunnel.name),
			"tunnel name preserves Unicode and quotes");
		tunnel.name = "仅改名";
		check(connectedTunnel.matches(tunnel), "renaming does not reconnect an unchanged tunnel");
		tunnel.secretKey = "new-visitor-secret";
		check(!connectedTunnel.matches(tunnel), "editing tunnel credentials requires a new connection");
		second.url = "https://changed.example/";
		ProfileStore.upsertDirect(prefs, second);
		check(!connected.matches(second), "editing direct URL does not rewrite the running connection snapshot");
		check(!ServerPicker.snapshot(prefs, connected, "home.example").getJSONArray("entries").getJSONObject(3).getBoolean("current"),
			"edited URL is selectable for reconnection, not falsely marked current");
		check(ServerPicker.findDirect(prefs, second.id).id.equals(second.id), "direct target resolved by saved ID");
		ProfileStore.deleteDirect(prefs, second.id);
		check(ServerPicker.findDirect(prefs, second.id) == null, "stale deleted ID is rejected without substituting another server");
		check(ServerPicker.snapshot(prefs, connected, "home.example").getString("currentName").equals("直连 B"),
			"deleting current saved entry does not falsely mark the last selection as connected");
		check(ServerPicker.authorized("cap", "cap", true, true, "https://HOME.example/workspace", "home.example", 443),
			"current tablet session with correct capability and origin is authorized");
		check(ServerPicker.authorized("cap", "cap", true, true, "https://[::1]:18443/", "[::1]", 18443), "IPv6 origin supported");
		check(ServerPicker.authorized("cap", "cap", true, true, "https://[::1]:18443/", "::1", 18443), "Android and Java IPv6 host forms share one origin");
		check(!ServerPicker.authorized("cap", "cap", true, true, "https:/missing-host", "", 443), "missing origin cannot authorize");
		for (String url : new String[]{"https://evil.example", "https://home.example:444", "http://home.example", "bad url"}) {
			check(!ServerPicker.authorized("cap", "cap", true, true, url, "home.example", 443), "reject foreign origin " + url);
		}
		check(!ServerPicker.authorized("old", "cap", true, true, "https://home.example", "home.example", 443), "old capability rejected");
		check(!ServerPicker.authorized("", "", true, true, "https://home.example", "home.example", 443), "empty capability rejected");
		check(ServerPicker.authorized("cap", "cap", false, true, "https://home.example", "home.example", 443), "phone session can switch servers");
		check(!ServerPicker.authorized("cap", "cap", true, false, "https://home.example", "home.example", 443), "connecting or settings state cannot switch");
		check(ServerPicker.sameGateway("https://127.0.0.1:18443/workspace", "https://127.0.0.1:18443/"),
			"same loopback gateway ignores path");
		check(ServerPicker.sameGateway("https://HOME.example/a", "https://home.example/b"),
			"gateway host compare is case-insensitive");
		check(ServerPicker.sameGateway("https://[::1]:18443/pair", "https://[::1]:18443/"),
			"IPv6 gateway identity ignores path");
		check(!ServerPicker.sameGateway("https://127.0.0.1:18443/", "https://127.0.0.1:18444/"),
			"different ports are different gateways");
		check(!ServerPicker.sameGateway("https://a.example/", "https://b.example/"),
			"different hosts are different gateways");
		check(!ServerPicker.sameGateway("http://home.example/", "https://home.example/"),
			"plain http is not the https gateway");
		check(!ServerPicker.sameGateway("https://home.example/", "not a url"),
			"malformed target is not the same gateway");
		JSONObject created = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "tunnel").put("name", "轻凡").put("host", "8.138.19.15")
			.put("port", "7180").put("tunnel", "dsh-remote")
			.put("token", "picker-login-secret").put("sk", "picker-visitor-secret")
			.put("strategy", "p2p"), null);
		check(created.getBoolean("ok") && created.getBoolean("connect"), "new tunnel is saved and should connect");
		JSONObject loaded = ServerPicker.applyEdit(prefs, "load", new JSONObject()
			.put("kind", "tunnel").put("id", created.getString("id")), null);
		check("picker-login-secret".equals(loaded.getString("token"))
			&& "8.138.19.15".equals(loaded.getString("host")), "edit form returns the saved tunnel");
		check(!ServerPicker.snapshot(prefs, null, "127.0.0.1").toString().contains("picker-login-secret"),
			"server list still hides secrets after a menu save");
		ProfileStore.Profile saved = ProfileStore.get(prefs, created.getString("id"));
		ServerPicker.Current live = ServerPicker.Current.tunnel(saved);
		JSONObject renamed = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "tunnel").put("id", saved.id).put("name", "只改显示名")
			.put("host", saved.serverAddr).put("port", String.valueOf(saved.serverPort))
			.put("tunnel", saved.tunnelName).put("token", saved.authToken)
			.put("sk", saved.secretKey).put("strategy", "p2p"), live);
		check(renamed.getBoolean("ok") && !renamed.getBoolean("connect") && live.matches(ProfileStore.get(prefs, saved.id)),
			"renaming from the menu does not reconnect");
		JSONObject rekeyed = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "tunnel").put("id", saved.id).put("name", "只改显示名")
			.put("host", saved.serverAddr).put("port", String.valueOf(saved.serverPort))
			.put("tunnel", saved.tunnelName).put("token", "picker-login-secret")
			.put("sk", "changed-visitor-secret").put("strategy", "relay"), live);
		check(rekeyed.getBoolean("connect") && !live.matches(ProfileStore.get(prefs, saved.id)),
			"changing the visitor secret reconnects the current server");
		JSONObject incomplete = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "tunnel").put("host", "1.2.3.4"), null);
		check(!incomplete.getBoolean("ok"), "incomplete tunnel stays unsaved");
		JSONObject direct = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "direct").put("name", "局域网").put("url", "http://192.168.1.8"), null);
		check(!direct.getBoolean("ok"), "plain http direct node is rejected");
		JSONObject https = ServerPicker.applyEdit(prefs, "save", new JSONObject()
			.put("kind", "direct").put("name", "").put("url", "https://home.example/path"), null);
		check(https.getBoolean("ok") && https.getBoolean("connect"), "new https direct node connects");
		JSONObject removed = ServerPicker.applyEdit(prefs, "delete", new JSONObject()
			.put("kind", "direct").put("id", https.getString("id")), null);
		check(removed.getBoolean("ok") && ServerPicker.findDirect(prefs, https.getString("id")) == null,
			"menu delete removes the direct node");
		System.out.println("Server picker tests passed: " + checks);
	}
}
