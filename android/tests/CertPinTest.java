package top.d1studio.dshremote;

import java.util.HashMap;
import java.util.Map;

/**
 * 生产 CertPin 纯函数的 JVM 行为测试（无模拟器）。
 * 覆盖用户真机实测到的假警报链路：两个配置档背后两台不同的 PC（两张不同的自签证书）
 * 共用同一个回环端口 18443。
 */
public class CertPinTest {
    static int checks;

    static void check(boolean ok, String label) {
        if (!ok) throw new AssertionError(label);
        checks++;
        System.out.println("ok " + label);
    }

    /** 64 位 hex，A/B 两台 PC 各一张不同的自签证书。 */
    static String fp(char c) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 64; i++) sb.append(c);
        return sb.toString();
    }

    static final String FP_A = fp('a');
    static final String FP_B = fp('b');
    static final String FP_C = fp('c');
    static final String LOOPBACK = "127.0.0.1";
    static final int PORT = 18443;

    static CertPin.Store store(Map<String, String> disk) {
        return disk::get;
    }

    public static void main(String[] args) {
        // ① 同档同指纹 → 放行
        Map<String, String> pins = new HashMap<>();
        pins.put(CertPin.PROFILE_PREFIX + "prof-A", FP_A);
        CertPin.Decision d = CertPin.verify(store(pins), "prof-A", LOOPBACK, PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TRUSTED, "same profile + same fingerprint is trusted");
        check(d.source == CertPin.Source.PROFILE, "same profile + same fingerprint hits profile key");
        check(d.key.equals("cert_prof_prof-A"), "trust writes back to the profile key");

        // ② 同档异指纹 → 弹「证书已变更！」（安全性不得削弱）
        d = CertPin.verify(store(pins), "prof-A", LOOPBACK, PORT, PORT, FP_B);
        check(d.action == CertPin.Action.CHANGED, "same profile + different fingerprint warns as changed");
        check(d.stored.equals(FP_A), "changed keeps the previously stored fingerprint");
        check(d.changed(), "changed() mirrors action==CHANGED");

        // ③ 异档异指纹 → 放行（用户实测的假警报场景：两个配置档共用回环端口）
        pins.put(CertPin.PROFILE_PREFIX + "prof-B", FP_B);
        d = CertPin.verify(store(pins), "prof-B", LOOPBACK, PORT, PORT, FP_B);
        check(d.action == CertPin.Action.TRUSTED,
            "other profile + its own fingerprint is trusted (no false MITM alarm)");
        d = CertPin.verify(store(pins), "prof-A", LOOPBACK, PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TRUSTED, "switching back to the first profile stays trusted");
        // 同一时刻另一个配置档的指纹仍然不会互相污染：B 档真换证书仍要报警
        d = CertPin.verify(store(pins), "prof-B", LOOPBACK, PORT, PORT, FP_C);
        check(d.action == CertPin.Action.CHANGED, "real certificate change on a profile still warns");

        // ④ 无档（直连/局域网）有 host:port 记录 → 走地址键
        pins.clear();
        pins.put(CertPin.HOST_PREFIX + "192.168.1.8:18443", FP_A);
        d = CertPin.verify(store(pins), "", "192.168.1.8", PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TRUSTED && d.source == CertPin.Source.HOST,
            "no profile + host:port pin uses the host key");
        d = CertPin.verify(store(pins), "", "192.168.1.8", PORT, PORT, FP_B);
        check(d.action == CertPin.Action.CHANGED,
            "direct/LAN node host:port change still warns as changed");
        d = CertPin.verify(store(pins), null, "192.168.1.8", PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TRUSTED, "null profile id is treated as no profile");

        // ⑤ T27-A / T25-S2：A 档带指纹（预置了 cert_prof_A）、B 档自己没带指纹。
        //    B 首次连接必须走 TOFU，**不得**回退到共享地址键拿到 A 的指纹
        //    （那会判 CHANGED → 假的「证书已变更！」+ 中间人警告）。
        pins.clear();
        for (String k : CertPin.seedKeys("prof-A", LOOPBACK, PORT)) pins.put(k, FP_A);
        d = CertPin.verify(store(pins), "prof-B", LOOPBACK, PORT, PORT, FP_B);
        check(d.action == CertPin.Action.TOFU && d.source == CertPin.Source.NONE,
            "T27-A profile without its own pin is TOFU even when another profile seeded one (was CHANGED)");
        check(d.stored.isEmpty(),
            "T27-A no other profile's fingerprint leaks into the stored slot");
        check(d.key.equals("cert_prof_prof-B"),
            "T27-A trusting the new profile writes only its own key");
        // 反向同理（T25-S3）
        pins.clear();
        for (String k : CertPin.seedKeys("prof-B", LOOPBACK, PORT)) pins.put(k, FP_B);
        d = CertPin.verify(store(pins), "prof-A", LOOPBACK, PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TOFU, "T27-A the asymmetry is symmetric (other direction too)");
        // 存量安装：老版本只写过地址键（没有 cert_prof_）→ 该档首次连接走 TOFU
        pins.clear();
        pins.put(CertPin.HOST_PREFIX + "127.0.0.1:18443", FP_A);
        d = CertPin.verify(store(pins), "prof-C", LOOPBACK, 18443, 18443, FP_A);
        check(d.action == CertPin.Action.TOFU,
            "T27-A legacy shared host:port pin is ignored for a profile connect (one extra TOFU)");
        check(d.key.equals("cert_prof_prof-C"),
            "T27-A profile-scoped connect still writes the profile key, not the shared one");
        // 已锁档的配置档不受影响：存量 cert_prof_ 直接放行，不需要多一次 TOFU
        pins.put(CertPin.PROFILE_PREFIX + "prof-D", FP_A);
        check(CertPin.verify(store(pins), "prof-D", LOOPBACK, 18443, 18443, FP_A).action
            == CertPin.Action.TRUSTED, "T27-A a profile that already has its own pin still passes silently");
        // 同一时刻另一个配置档的记录不得被读到或改写
        d = CertPin.verify(store(pins), "prof-B", LOOPBACK, 18443, 18443, FP_B);
        check(d.action == CertPin.Action.TOFU,
            "profile with its own pin and a foreign shared key never reads the shared one");
        // 共享地址键**不得**掩盖已锁档的真变更（T25-S6）
        pins.put(CertPin.PROFILE_PREFIX + "prof-E", FP_A);
        d = CertPin.verify(store(pins), "prof-E", LOOPBACK, 18443, 18443, FP_C);
        check(d.action == CertPin.Action.CHANGED && d.source == CertPin.Source.PROFILE,
            "T25-S6 a shared host pin must not mask a real change on a pinned profile");
        // 直连连接不得借用任何配置档的锁（T25-S5c）
        d = CertPin.verify(store(pins), "", LOOPBACK, PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TRUSTED && d.source == CertPin.Source.HOST,
            "direct connect still uses its own host key, profile pins are invisible to it");
        d = CertPin.verify(store(pins), "", "192.168.1.8", PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TOFU,
            "direct connect cannot borrow a profile-scoped pin (no key of its own → TOFU)");

        // URL 未写端口时回退查字面端口键（老实现的 legacyKey 行为）
        pins.clear();
        pins.put(CertPin.HOST_PREFIX + "edge.example:8443", FP_A);
        d = CertPin.verify(store(pins), "", "edge.example", 443, 8443, FP_A);
        check(d.action == CertPin.Action.TRUSTED && d.source == CertPin.Source.HOST_LEGACY,
            "effective port differs from raw port: raw port key is still consulted");

        // ⑥ 两处都没有 → TOFU
        d = CertPin.verify(store(pins), "prof-new", LOOPBACK, PORT, PORT, FP_A);
        check(d.action == CertPin.Action.TOFU && d.source == CertPin.Source.NONE,
            "no pin anywhere falls back to TOFU");
        check(d.key.equals("cert_prof_prof-new"), "TOFU for a profile writes the profile key");
        d = CertPin.verify(store(pins), "", "brand-new.example", 443, -1, FP_A);
        check(d.action == CertPin.Action.TOFU, "first visit to a direct node is TOFU");
        check(d.key.equals("cert_fp_brand-new.example:443"),
            "TOFU without a profile writes the host:port key with the effective port");
        check(CertPin.verify(null, "prof-x", LOOPBACK, PORT, PORT, FP_A).action == CertPin.Action.TOFU,
            "null store does not crash and yields TOFU");

        // 键派生
        check(CertPin.profileKey("").isEmpty() && CertPin.profileKey(null).isEmpty(),
            "empty profile id has no profile key");
        check(CertPin.profileKey(" prof-A ").equals("cert_prof_prof-A"), "profile id is trimmed");
        check(CertPin.hostLabel("Edge.Example", 443).equals("edge.example:443"),
            "host key is lowercased and port-qualified");
        String[] seeds = CertPin.seedKeys("prof-A", LOOPBACK, PORT);
        check(seeds.length == 1 && seeds[0].equals("cert_prof_prof-A"),
            "T27-A seeding a profile writes ONLY its own key (no trust leak into the shared one)");
        check(CertPin.seedKeys("", LOOPBACK, PORT).length == 1
            && CertPin.seedKeys("", LOOPBACK, PORT)[0].equals("cert_fp_127.0.0.1:18443"),
            "seeding without a profile writes only the host:port key");

        // 指纹规范化（导入链接里的 fp 可能带冒号/大写/噪声）
        check(CertPin.normalizeFingerprint(FP_A.toUpperCase()).equals(FP_A),
            "uppercase fingerprint normalizes to lowercase hex");
        check(CertPin.normalizeFingerprint(FP_A.substring(0, 2) + ":"
            + FP_A.substring(2, 4) + ":" + FP_A.substring(4)).equals(FP_A),
            "colons are stripped before comparison");
        check(CertPin.normalizeFingerprint("zz" + FP_A.substring(2)).isEmpty(),
            "non-hex noise yields no fingerprint (falls back to TOFU)");
        check(CertPin.normalizeFingerprint(FP_A.substring(0, 63)).isEmpty(),
            "short fingerprint rejected");
        check(CertPin.normalizeFingerprint(null).isEmpty(), "null fingerprint is safe");

        // 大小写差异不算变更（存量里可能存过大写）
        pins.clear();
        pins.put(CertPin.PROFILE_PREFIX + "prof-A", FP_A.toUpperCase());
        check(CertPin.verify(store(pins), "prof-A", LOOPBACK, PORT, PORT, FP_A).action
            == CertPin.Action.TRUSTED, "stored uppercase fingerprint still matches lowercase");

        System.out.println("CertPin tests passed: " + checks);
    }
}
