package top.d1studio.dshremote;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * T114：{@link PinnedFetch} 的**设备凭据注入**回归（JVM，无模拟器）。
 *
 * <p>为什么要有它：这条修复把「凭据发去哪」和「没凭据时干什么」两件事写进了取数通道，
 * 两者都是安全/稳定性红线，靠人读代码守不住：
 * <ol>
 *   <li><b>同源判据</b>是纯函数，这里逐条钉死（第三方域、后缀攻击、换端口、换 scheme、
 *       用户信息、缺省端口折叠）；</li>
 *   <li><b>顺序</b>必须"先判同源、再取 cookie、最后才决定发不发"——顺序反了就是
 *       先把凭据取出来放在手里，任何后续分支走错都等于泄露；</li>
 *   <li><b>缺凭据失败关闭</b>与 <b>401 不落盘</b>是这次事故的两个后果面，
 *       必须有明确文案 + 明确返回 null（不返回半截数据）；</li>
 *   <li>T60 定下的闸门/上限/超时<b>一个都不许被放宽</b>，这里同时钉住常量值。</li>
 * </ol>
 *
 * <p>运行（与 {@code android/tests/StuckRescueTest.java} 同一套方式：只用 android.jar 当
 * 编译期符号）：
 * <pre>
 *   javac -encoding UTF-8 -cp &lt;android.jar&gt; -d &lt;out&gt; PinnedFetch.java CertPin.java T114CredentialInjectionTest.java
 *   java -cp "&lt;out&gt;;&lt;android.jar&gt;" top.d1studio.dshremote.T114CredentialInjectionTest &lt;repoRoot&gt;
 * </pre>
 * 说明：{@code isSameOriginUrl} 不碰任何 Android API，所以能在这里真跑；证书/HTTP 语义
 * 由 scratch/t114 的动态装置（两个真 HTTPS 服务器，服务端看请求头）覆盖。
 */
public final class T114CredentialInjectionTest {

	private static int checks = 0;
	private static int failed = 0;

	private static void ok(String name, boolean cond, String detail) {
		checks++;
		if (cond) {
			System.out.println("ok   " + name + (detail.isEmpty() ? "" : "  [" + detail + "]"));
		} else {
			failed++;
			System.out.println("FAIL " + name + "  " + detail);
		}
	}

	public static void main(String[] args) throws Exception {
		final Path root = Paths.get(args.length > 0 ? args[0] : ".");
		final Path pf = root.resolve("android/app/src/main/java/top/d1studio/dshremote/PinnedFetch.java");
		final String src = new String(Files.readAllBytes(pf), StandardCharsets.UTF_8);

		// ── ① 同源判据（行为，真跑） ─────────────────────────────────────────
		ok("同源：完全一致 ⇒ true",
			PinnedFetch.isSameOriginUrl("https://127.0.0.1:18443/assets/a.js", "127.0.0.1", 18443), "");
		ok("第三方域 example.com ⇒ false",
			!PinnedFetch.isSameOriginUrl("https://example.com/x.js", "127.0.0.1", 18443), "");
		ok("后缀攻击 127.0.0.1.evil.com ⇒ false",
			!PinnedFetch.isSameOriginUrl("https://127.0.0.1.evil.com/x.js", "127.0.0.1", 18443), "");
		ok("换端口 ⇒ false",
			!PinnedFetch.isSameOriginUrl("https://127.0.0.1:19443/x.js", "127.0.0.1", 18443), "");
		ok("换 scheme（http）⇒ false",
			!PinnedFetch.isSameOriginUrl("http://127.0.0.1:18443/x.js", "127.0.0.1", 18443), "");
		ok("用户信息 https://127.0.0.1:18443@evil.com ⇒ false",
			!PinnedFetch.isSameOriginUrl("https://127.0.0.1:18443@evil.com/x.js", "127.0.0.1", 18443), "");
		ok("host 大小写忽略 ⇒ true",
			PinnedFetch.isSameOriginUrl("https://127.0.0.1:18443/x.js", "127.0.0.1", 18443), "");
		ok("缺省端口按 443 折叠：省略 == 显式 443 ⇒ true",
			PinnedFetch.isSameOriginUrl("https://127.0.0.1/x.js", "127.0.0.1", 443)
				&& PinnedFetch.isSameOriginUrl("https://127.0.0.1:443/x.js", "127.0.0.1", 443), "");
		ok("活动网关 host 为空 / 端口非法 ⇒ false（判不了就不给凭据）",
			!PinnedFetch.isSameOriginUrl("https://127.0.0.1:18443/x.js", "", 18443)
				&& !PinnedFetch.isSameOriginUrl("https://127.0.0.1:18443/x.js", "127.0.0.1", 0), "");
		ok("非法 URL 串 ⇒ false（绝不因为解析失败就放行凭据）",
			!PinnedFetch.isSameOriginUrl("not a url", "127.0.0.1", 18443)
				&& !PinnedFetch.isSameOriginUrl(null, "127.0.0.1", 18443), "");

		// ── ② 顺序契约：先判同源，再取 cookie ───────────────────────────────
		int iSame = src.indexOf("!isSameOriginUrl(url, host, port)");
		int iCookieFor = src.indexOf("String c = cookieFor(url);");
		ok("凭据唯一出口在 get() 内，且先判同源再取 cookie（顺序颠倒 = 凭据先到手）",
			iSame > 0 && iCookieFor > iSame,
			"iSameOrigin=" + iSame + " iCookieFor=" + iCookieFor);
		ok("Cookie 头只在 cookie != null 时设置（null 表示「不该带」，不是「没取到」）",
			src.contains("if (cookie != null) conn.setRequestProperty(\"Cookie\", cookie);"), "");
		ok("全库只允许一处写 Cookie 头",
			src.indexOf("setRequestProperty(\"Cookie\"") == src.lastIndexOf("setRequestProperty(\"Cookie\""), "");
		ok("取 cookie 走 CookieManager（HttpOnly 设备令牌只能从这里拿到）",
			src.contains("CookieManager.getInstance().getCookie(url)"), "");

		// ── ③ 缺凭据失败关闭 + 401 不落盘 ───────────────────────────────────
		ok("缺凭据有明确文案", src.contains("pinnedFetch 无凭据（cookie 空）⇒ 失败关闭"), "");
		int iMissing = src.indexOf("pinnedFetch 无凭据（cookie 空）⇒ 失败关闭");
		int iMissingReturn = src.indexOf("return null;", iMissing);
		ok("缺凭据紧接着 return null（失败关闭，不把未鉴权请求发出去当成功）",
			iMissingReturn > iMissing && iMissingReturn - iMissing < 200, "");
		ok("401 单独一条文案（与事故特征一眼对上身）",
			src.contains("pinnedFetch 401 未鉴权 ⇒ 返回 null（不落盘、不缓存）"), "");
		int i401 = src.indexOf("if (status == 401)");
		int i401Return = src.indexOf("return null;", i401);
		ok("401 分支 return null（调用点拿不到 Result ⇒ StaticDiskCache.put 不可达）",
			i401 > 0 && i401Return > i401, "");
		ok("非 200 判定仍然在返回 Result **之前**",
			src.indexOf("int status = conn.getResponseCode();") < src.indexOf("return new Result(status"), "");

		// ── ④ 调用点契约：拿到 null 就不许落盘 ──────────────────────────────
		final String main = read(root, "android/app/src/main/java/top/d1studio/dshremote/MainActivity.java");
		int cursor = 0, sites = 0, guarded = 0;
		while (true) {
			int i = main.indexOf("PinnedFetch.Result r = PinnedFetch.get(", cursor);
			if (i < 0) break;
			sites++;
			// 两种合法形态：`if (r == null) return;`（落盘通道）与 `if (r != null && r.status > 0)`
			// （救援探针，只判通/不通）。两者都必须在**用结果之前**显式判 null。
			String window = main.substring(i, Math.min(main.length(), i + 400));
			if (window.contains("if (r == null)") || window.contains("r != null")) guarded++;
			cursor = i + 10;
		}
		ok("MainActivity 每个 PinnedFetch 调用点都在用结果前判 null（无 401 落盘通路）",
			sites >= 2 && sites == guarded, "调用点=" + sites + " 带 null 判定=" + guarded);
		ok("StaticDiskCache 只在 r 非 null 的分支里被写入（源码顺序）",
			main.indexOf("StaticDiskCache.put(") > main.indexOf("if (r == null)"), "");

		// ── ⑤ T60 语义一处都不许放宽 ───────────────────────────────────────
		ok("并发闸仍是 Semaphore(3, fair=true)",
			src.contains("private static final int MAX_INFLIGHT = 3;")
				&& src.contains("new Semaphore(MAX_INFLIGHT, true)"), "");
		ok("排队上限仍是 20000ms", src.contains("private static final long QUEUE_WAIT_MS = 20000L;"), "");
		ok("总 deadline 仍是 45000ms", src.contains("private static final long TOTAL_DEADLINE_MS = 45000L;"), "");
		ok("读空闲超时仍是 15000ms", src.contains("private static final int READ_TIMEOUT_MS = 15000;"), "");
		ok("单响应体硬顶仍是 32MB",
			src.contains("MAX_BODY_BYTES = 32L * 1024L * 1024L;"), "");
		ok("证书语义未动：仍只在 CertPin 判定 TRUSTED 时放行",
			src.contains("if (d.action != CertPin.Action.TRUSTED)")
				&& src.contains("CertPin.verify(store, profileId, host, port, port, fp)"), "");
		ok("未新增 Authorization 之类的旁路凭据头（只有 Cookie 一条路）",
			!src.contains("setRequestProperty(\"Authorization\""), "");

		// ── ⑥ 计数归零点（便于真机取证） ───────────────────────────────────
		ok("凭据计数与 T60 四项同一零点（resetStats）",
			src.contains("credAttached.set(0);") && src.contains("credDenied401.set(0);"), "");
		ok("凭据计数被读进结算行（不留事后无法反推的暗数）",
			src.contains("credSummary()") && src.contains("+ \" \" + credSummary() + \" url=\""), "");
		ok("日志绝不打印令牌值（只打名字 + 长度）",
			src.contains("cookieNames(c)") && !src.contains("+ c + \" url=\""), "");

		System.out.println("\nT114 凭据注入回归: " + (checks - failed) + "/" + checks + " 通过");
		if (failed > 0) {
			System.out.println("FAILED " + failed);
			System.exit(1);
		}
		System.out.println("ALL-PASS");
	}

	private static String read(Path root, String rel) throws Exception {
		return new String(Files.readAllBytes(root.resolve(rel)), StandardCharsets.UTF_8);
	}
}
