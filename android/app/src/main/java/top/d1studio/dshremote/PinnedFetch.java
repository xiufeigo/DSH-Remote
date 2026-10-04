package top.d1studio.dshremote;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * T49：App 自己的**可信链**取数通道（Service Worker 的子资源专用）。
 *
 * <h3>为什么需要它</h3>
 * WebView 的 Service Worker 由**浏览器进程的 SW 子系统**执行，它发出的 fetch
 * 与它的脚本抓取一样，**拿不到** {@code onReceivedSslError} 的 {@code handler.proceed()}
 * 放行。设备实测（T49，emulator-5596 / WebView 124 / android-35）：
 * <pre>
 *   SW 内 fetch("/favicon.svg")               -> TypeError: Failed to fetch
 *   SW 内 fetch("/assets/index-5SrrfWpU.js")  -> TypeError: Failed to fetch
 *   SW 内 fetch("/__dsh_remote__/sw.js")      -> 200  ← 走 MainActivity 的
 *                                                    ServiceWorkerClient 本地供给，不经网络
 * </pre>
 * ⇒ SW **能**装上（P0-a 已证），但它**永远填不满自己的缓存**；一旦它开始
 * {@code respondWith} 而缓存未命中，页面就 {@code net::ERR_FAILED} 直接白屏。
 *
 * <h3>为什么这条路不削弱证书语义</h3>
 * 它比现状**更严**，不是更松：这里不依赖「先失败再放行」的 {@code proceed()}，
 * 而是握手当场按**已锁定的 SHA-256 指纹**判定（复用纯函数 {@link CertPin}）：
 * <ul>
 *   <li>指纹与已存记录一致（{@code TRUSTED}）→ 放行；</li>
 *   <li>首次见到（{@code TOFU}）或指纹变了（{@code CHANGED}）→ <b>抛
 *       {@link CertificateException}，绝不放行</b>。</li>
 * </ul>
 * 也就是说：本通道**只**复用主框架 TOFU 弹窗**已经**落盘的那把锁。
 * 首次连接仍由既有的 {@code onReceivedSslError} 弹窗裁决；在用户点「信任并继续」
 * 之前，本通道一律拿不到字节。pin / TOFU / 「证书已变更！」三件事的语义与
 * 改动前**逐字节一致**（这也是 T45 §6.2 判定「把自签根装成受信任锚」不推荐、
 * 本任务明令不要那么做的原因——那样 {@code onReceivedSslError} 就不再触发，
 * TOFU 整条链会失效）。
 */
final class PinnedFetch {

	private PinnedFetch() {
	}

	/** 一次成功取回的响应（只保留 SW 用得到的字段）。 */
	static final class Result {
		final int status;
		final String contentType;
		final String cacheControl;
		final byte[] body;

		Result(int status, String contentType, String cacheControl, byte[] body) {
			this.status = status;
			this.contentType = contentType;
			this.cacheControl = cacheControl;
			this.body = body;
		}
	}

	/**
	 * 按已锁定指纹取一个 URL。失败一律返回 null（调用方放行原路径），
	 * 绝不返回半截数据，也绝不吞掉证书问题。
	 *
	 * @param store     指纹存储（生产传 SharedPreferences 适配器）
	 * @param profileId 本次连接的配置档 id；直连/局域网传空串
	 */
	static Result get(String url, String host, int port, String profileId,
			CertPin.Store store, String tag) {
		HttpsURLConnection conn = null;
		try {
			URL parsed = new URL(url);
			SSLContext ctx = SSLContext.getInstance("TLS");
			ctx.init(null, new TrustManager[]{pinningTrustManager(store, profileId, host, port, tag)},
				new SecureRandom());
			conn = (HttpsURLConnection) parsed.openConnection();
			conn.setSSLSocketFactory(ctx.getSocketFactory());
			conn.setRequestMethod("GET");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(30000);
			conn.setInstanceFollowRedirects(false);
			conn.setUseCaches(false);
			// 网关会按 accept-encoding 压缩；这里显式声明支持 br/gzip 并自行解压，
			// 因为 WebResourceResponse 交出去的是**已解码**的字节。
			conn.setRequestProperty("Accept-Encoding", "gzip, deflate");
			conn.setRequestProperty("Accept", "*/*");
			conn.setRequestProperty("User-Agent", "DSHRemoteAndroid/pinned-fetch");
			int status = conn.getResponseCode();
			if (status != 200) {
				Log.i("dshr-perf", "pinnedFetch 非 200 status=" + status + " url=" + url);
				return null;
			}
			String encoding = conn.getContentEncoding();
			InputStream in = conn.getInputStream();
			if (encoding != null && encoding.toLowerCase(Locale.US).contains("gzip")) {
				in = new GZIPInputStream(in);
			}
			ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
			byte[] buf = new byte[64 * 1024];
			int n;
			while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
			in.close();
			byte[] body = out.toByteArray();
			Log.i("dshr-perf", "pinnedFetch ok bytes=" + body.length + " enc=" + encoding
				+ " url=" + url);
			return new Result(status, conn.getContentType(), conn.getHeaderField("cache-control"), body);
		} catch (Exception e) {
			// 证书未受信 / 网络失败一律不放行。证书那条的具体理由由
			// pinningTrustManager 在抛出前自己打点（见下），这里不吞。
			Log.w("dshr-perf", "pinnedFetch 失败（不放行）：" + e + " url=" + url);
			return null;
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	/** 握手当场的指纹判定：只有与已存锁定一致才放行。 */
	private static X509TrustManager pinningTrustManager(final CertPin.Store store,
			final String profileId, final String host, final int port, final String tag) {
		return new X509TrustManager() {
			@Override
			public void checkClientTrusted(X509Certificate[] chain, String authType) {
			}

			@Override
			public X509Certificate[] getAcceptedIssuers() {
				return new X509Certificate[0];
			}

			@Override
			public void checkServerTrusted(X509Certificate[] chain, String authType)
					throws CertificateException {
				if (chain == null || chain.length == 0) {
					throw new CertificateException("pinnedFetch: 空证书链");
				}
				String fp = CertPin.normalizeFingerprint(sha256Hex(chain[0].getEncoded()));
				if (fp.isEmpty()) {
					throw new CertificateException("pinnedFetch: 指纹计算失败");
				}
				CertPin.Decision d = CertPin.verify(store, profileId, host, port, port, fp);
				if (d.action != CertPin.Action.TRUSTED) {
					Log.w("dshr-perf", "pinnedFetch 证书判定未通过（不放行）：" + d.describe());
					throw new CertificateException("pinnedFetch: 证书未受信 " + d.describe());
				}
				Log.i("dshr-perf", "pinnedFetch 证书受信 " + tag + " " + d.describe());
			}
		};
	}

	private static String sha256Hex(byte[] data) {
		try {
			byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
			StringBuilder sb = new StringBuilder(d.length * 2);
			for (byte b : d) sb.append(String.format(Locale.US, "%02x", b));
			return sb.toString();
		} catch (Exception e) {
			return "";
		}
	}
}
