package top.d1studio.dshremote;

/**
 * 生产 TunnelReady 纯函数的 JVM 行为测试（无模拟器）。
 * 钉死两件事：①20s 硬顶与打洞相关的任何节奏都没被改动；②就绪关键字以本机
 * frpc 0.61.1 二进制里实测到的真实文案为准。
 */
public class TunnelReadyTest {
    static int checks;

    static void check(boolean ok, String label) {
        if (!ok) throw new AssertionError(label);
        checks++;
        System.out.println("ok " + label);
    }

    public static void main(String[] args) {
        // ① 上限与探测超时
        check(TunnelReady.TUNNEL_READY_TIMEOUT_MS == 20_000L, "20s ready cap unchanged");
        check(TunnelReady.PROBE_TIMEOUT_MS == 200L, "loopback probe timeout 600ms -> 200ms");
        check(TunnelReady.FIRST_DELAY_MS == 100L && TunnelReady.MAX_DELAY_MS == 400L,
            "poll interval 400ms -> 100ms..400ms backoff");

        // ② 退避节奏：100 → 200 → 400 封顶；非正数也安全
        check(TunnelReady.nextDelayMs(0) == 100L, "first delay is 100ms");
        check(TunnelReady.nextDelayMs(1) == 100L, "delay after 1 failure is 100ms");
        check(TunnelReady.nextDelayMs(2) == 200L, "delay after 2 failures is 200ms");
        check(TunnelReady.nextDelayMs(3) == 400L, "delay after 3 failures is 400ms");
        check(TunnelReady.nextDelayMs(99) == 400L, "backoff is capped at 400ms");
        check(TunnelReady.nextDelayMs(-5) == 100L, "negative attempt count is safe");
        // 旧节奏：connect 超时 600ms + 固定 sleep 400ms = 1000ms/tick（无退避）；
        // 新节奏最坏 = 探测 200ms + 间隔封顶 400ms = 600ms/tick。
        final long OLD_TICK_MS = 600L + 400L;
        long newWorstTick = TunnelReady.PROBE_TIMEOUT_MS + TunnelReady.MAX_DELAY_MS;
        check(newWorstTick == 600L, "new worst-case tick is probe 200ms + cap 400ms = 600ms");
        check(newWorstTick < OLD_TICK_MS, "worst-case detection lag is shorter than the old 1000ms tick");
        // 稳态下的平均检出滞后：旧固定 1000ms/tick ⇒ 平均 500ms；新 600ms/tick ⇒ 平均 300ms。
        check((OLD_TICK_MS / 2) - (newWorstTick / 2) == 200L,
            "average detection lag improves by ~200ms per tick");

        // ③ frpc 就绪关键字（frpc 0.61.1 真实文案，frpc.exe 与 libfrpc.so 均已核验）
        check(TunnelReady.isReadyLine("2026-10-03 15:04:05.123456   INFO [xiufeigo-visitor] start proxy success"),
            "start proxy success recognized");
        check(TunnelReady.isReadyLine(
            "2026-10-03 15:04:05.123456   INFO login to server success, get run id [abc123]"),
            "login to server success recognized");
        check(TunnelReady.readyKeywordOf("INFO login to server success").equals("login to server success"),
            "matched keyword is reported back for logging");
        // 不能把「打洞成功」误判成就绪：那时端口还没绑
        check(!TunnelReady.isReadyLine("establishing nat hole connection successful, sid [x], remoteAddr [y]"),
            "nat hole success alone is not treated as ready (port not bound yet)");
        // 常见噪声不得误触发
        for (String noise : new String[] {
            "start error: proxy_id: x, error: port already used",
            "try to connect to peer [1.2.3.4] error: i/o timeout",
            "visitor [xiufeigo-visitor] not found",
            "send heartbeat to server",
            "",
            null}) {
            check(!TunnelReady.isReadyLine(noise), "noise line does not trigger a probe: " + noise);
        }

        // ④ 状态文案
        check(TunnelReady.waitingLabel(0).equals("正在等待隧道就绪…（0s / 最多 20s）"),
            "waiting label at t+0");
        check(TunnelReady.waitingLabel(3_400).equals("正在等待隧道就绪…（3s / 最多 20s）"),
            "waiting label shows elapsed seconds against the 20s cap");
        check(TunnelReady.waitingLabel(-1).equals("正在等待隧道就绪…（0s / 最多 20s）"),
            "negative elapsed is clamped");

        System.out.println("TunnelReady tests passed: " + checks);
    }
}
