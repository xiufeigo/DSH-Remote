package top.d1studio.dshremote;

import java.util.Locale;

/**
 * 隧道就绪等待的纯逻辑：轮询节奏常量 + frpc 就绪日志识别。
 * 无状态、无 Android 依赖，可在 JVM 上直接单测（android/tests/TunnelReadyTest.java）。
 *
 * 缺陷背景（T23-B，用户真机实测「点连接后卡在『正在连接 DSH』很久」）：
 * 改前是 connect 超时 600ms + 固定 sleep 400ms、**无退避**、20s 硬顶
 * （git blame 全部指向 2026-08-25 的 21d2350，从未变过，不是回归）。
 * 回环端口要么秒连要么秒拒（ECONNREFUSED 立即返回），600ms 过度冗余；
 * 固定 400ms 也让「端口刚好在两次 tick 之间就绪」白等一整个周期。
 *
 * 改法只动【节奏】不动【上限】：20s 硬顶保持不变（打洞 fallbackTimeoutMs=5000
 * 更是用户明确要求一个字不许动），只把探测变密、间隔轻微退避，并允许 frpc
 * 的就绪日志提前唤醒一次探测。
 */
public final class TunnelReady {

	/**
	 * 就绪等待硬顶。与改前 MainActivity 里的 TUNNEL_READY_TIMEOUT_MS 同值，
	 * 移到这里只是为了让「上限未变」这件事可被单测钉死。
	 */
	public static final long TUNNEL_READY_TIMEOUT_MS = 20_000L;

	/** 单次回环 connect 超时。回环要么秒连要么秒拒，600ms 是过度冗余。 */
	public static final long PROBE_TIMEOUT_MS = 200L;

	/** 首个 tick 间隔。 */
	public static final long FIRST_DELAY_MS = 100L;
	/** tick 间隔上限（轻微退避的封顶，不再无限加密）。 */
	public static final long MAX_DELAY_MS = 400L;

	/**
	 * frpc 就绪关键字。以本机 frpc 0.61.1 二进制里实测到的真实文案为准
	 * （对 frpc.exe 与打包进 APK 的 arm64-v8a/libfrpc.so 做过字符串核验，两者都含）：
	 *   `[%s] start proxy success`      ← visitor 代理已起，端口应当可连
	 *   `login to server success, get run id [%s]` ← 控制连接已建
	 * 只用来【提前触发一次端口探测】，最终判据仍然是端口能不能连——
	 * 日志可能因 frp 版本/语言变化而漂移，所以它绝不放行任何连接。
	 */
	private static final String[] READY_KEYWORDS = {
		"start proxy success",
		"login to server success"
	};

	private TunnelReady() {
	}

	/**
	 * 第 n 次探测失败后到下一次探测之间的等待时长（轻微退避）。
	 * n=1 → 100ms，n=2 → 200ms，n>=3 → 400ms（封顶）。
	 * 典型就绪时刻 T 的检出滞后从「最坏 1s（600+400）」降到「最坏 600ms（200+400）」。
	 */
	public static long nextDelayMs(int failedAttempts) {
		if (failedAttempts <= 1) return FIRST_DELAY_MS;
		if (failedAttempts == 2) return FIRST_DELAY_MS * 2;
		return MAX_DELAY_MS;
	}

	/** 该行是不是 frpc 的就绪信号。 */
	public static boolean isReadyLine(String line) {
		return readyKeywordOf(line) != null;
	}

	/** 命中的就绪关键字（未命中返回 null），供日志标注用了哪一条。 */
	public static String readyKeywordOf(String line) {
		if (line == null) return null;
		String lower = line.toLowerCase(Locale.US);
		for (String keyword : READY_KEYWORDS) {
			if (lower.contains(keyword)) return keyword;
		}
		return null;
	}

	/** 状态文案用的等待描述，例如「正在等待隧道就绪…（3s / 最多 20s）」。 */
	public static String waitingLabel(long elapsedMs) {
		long capSeconds = TUNNEL_READY_TIMEOUT_MS / 1000L;
		long seconds = Math.max(0, elapsedMs) / 1000L;
		return "正在等待隧道就绪…（" + seconds + "s / 最多 " + capSeconds + "s）";
	}
}
