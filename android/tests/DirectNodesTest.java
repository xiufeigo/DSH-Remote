package top.d1studio.dshremote;

import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.*;

/** Executes production ProfileStore against an in-memory preferences adapter and real JSON. */
public class DirectNodesTest {
    static int checks;
    static void check(boolean ok, String label) {
        if (!ok) throw new AssertionError(label);
        checks++;
        System.out.println("ok " + label);
    }
    static SharedPreferences prefs(Map<String, Object> data) {
        Object editor = Proxy.newProxyInstance(DirectNodesTest.class.getClassLoader(),
            new Class[]{SharedPreferences.Editor.class}, (proxy, method, args) -> {
                String n = method.getName();
                if (n.startsWith("put")) { data.put((String) args[0], args[1]); return proxy; }
                if (n.equals("remove")) { data.remove(args[0]); return proxy; }
                if (n.equals("clear")) { data.clear(); return proxy; }
                if (n.equals("apply")) return null;
                if (n.equals("commit")) return true;
                throw new UnsupportedOperationException(n);
            });
        return (SharedPreferences) Proxy.newProxyInstance(DirectNodesTest.class.getClassLoader(),
            new Class[]{SharedPreferences.class}, (proxy, method, args) -> {
                String n = method.getName();
                if (n.equals("edit")) return editor;
                if (n.equals("contains")) return data.containsKey(args[0]);
                if (n.equals("getAll")) return new HashMap<>(data);
                if (n.startsWith("get")) return data.getOrDefault(args[0], args[1]);
                throw new UnsupportedOperationException(n);
            });
    }
    static ProfileStore.DirectNode node(String name, String url) {
        ProfileStore.DirectNode n = new ProfileStore.DirectNode(); n.name = name; n.url = url; return n;
    }
    public static void main(String[] args) {
        Map<String, Object> disk = new HashMap<>();
        SharedPreferences p = prefs(disk);
        p.edit().putString("gateway_url", "https://old.example:18443/").apply();
        ProfileStore.migrateDirect(p);
        check(ProfileStore.listDirect(p).size() == 1, "legacy URL migrated");
        ProfileStore.migrateDirect(p);
        check(ProfileStore.listDirect(p).size() == 1, "migration idempotent");
        String old = ProfileStore.listDirect(p).get(0).id;
        ProfileStore.deleteDirect(p, old);
        ProfileStore.migrateDirect(p);
        check(ProfileStore.listDirect(p).isEmpty(), "deleted legacy node does not resurrect");
        ProfileStore.DirectNode a = node("家里 \"A\"", "https://home.example/path?q=1");
        ProfileStore.DirectNode b = node("公司", "https://192.168.1.8:18443/");
        ProfileStore.upsertDirect(p, a); ProfileStore.upsertDirect(p, b);
        check(!a.id.equals(b.id), "stable unique IDs");
        SharedPreferences reopened = prefs(new HashMap<>(disk));
        check(ProfileStore.listDirect(reopened).size() == 2, "multiple nodes survive persisted JSON reload");
        check(ProfileStore.listDirect(reopened).get(0).name.equals(a.name), "unicode and quotes round trip");
        a.name = "改名"; a.url = "https://new.example/";
        ProfileStore.upsertDirect(p, a);
        check(ProfileStore.listDirect(p).size() == 2 && ProfileStore.listDirect(p).get(0).name.equals("改名"), "edit replaces in place");
        check(ProfileStore.listDirect(p).get(1).id.equals(b.id), "edit preserves other node and order");
        p.edit().putString(ProfileStore.KEY_DIRECT_ACTIVE, b.id).apply();
        ProfileStore.deleteDirect(p, a.id);
        check(p.getString(ProfileStore.KEY_DIRECT_ACTIVE, "").equals(b.id), "delete other preserves selection");
        ProfileStore.deleteDirect(p, b.id);
        check(ProfileStore.listDirect(p).isEmpty() && !p.contains(ProfileStore.KEY_DIRECT_ACTIVE), "delete selected clears selection");
        for (String url : new String[]{"http://example.com", "https://", "https://a:0", "https://a:65536", "https://user:pass@example.com", "https://bad host/"}) {
            check(!node("", url).isValid(), "reject invalid URL " + url);
        }
        check(node("", "https://[::1]:18443/").isValid(), "accept IPv6 LAN URL");
        try { ProfileStore.upsertDirect(p, node("", "bad")); throw new AssertionError("accepted invalid node"); }
        catch (IllegalArgumentException expected) { check(true, "invalid node cannot be saved"); }
        p.edit().putString(ProfileStore.KEY_DIRECT_NODES, "not json").apply();
        check(ProfileStore.listDirect(p).isEmpty(), "malformed JSON does not crash");
        check(!p.contains("vp_profiles") && !p.contains("vp_active_id"), "direct CRUD does not alter FRP preferences");
        System.out.println("Direct node tests passed: " + checks);
    }
}
