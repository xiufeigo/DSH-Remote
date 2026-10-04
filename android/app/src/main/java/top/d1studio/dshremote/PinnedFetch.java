package top.d1studio.dshremote;

import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
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
 *
 * <h3>T60：并发闸门、内存/超时上界、可观测</h3>
 * T55 审计确认本通道<b>不会</b>造成 ANR（{@code shouldInterceptRequest} 在后台线程），
 * 但有三处「最坏情况可达」：
 * <ol>
 *   <li><b>零并发控制</b>：并发度 = 同时在飞的 SW 子资源数，App 侧一个闸门都没有。
 *       实测真实首屏 7 并发、人为加压可复现 12 并发，同时解压 14.37 MB、RSS +37.9 MB。</li>
 *   <li><b>响应体无上限且峰值 2×</b>：{@code BAOS.toByteArray()} 必然再复制一份；
 *       单包实测已 9.98 MB 且在长 ⇒ 内存按「并发 × 包体」线性涨。</li>
 *   <li><b>总量无上界</b>：{@code readTimeout} 是<b>每次 read 的空闲超时</b>，
 *       读循环每读一段就重新计时 ⇒ 慢速滴流下单次调用可占住后台线程十几分钟。</li>
 * </ol>
 * 三条分别由 {@link #GATE}（排队不拒绝）、{@link #readBody}（预分配 + 32 MB 硬顶 +
 * 零复制）、{@link #TOTAL_DEADLINE_MS} 解决，指标见 {@link #statsSummary()}。
 * <p>⚠️ 闸门<b>只排队不拒绝</b>的理由见 {@link #GATE} 的注释：这里返回 null
 * 不是「放行走正常网络」，而是让 SW 子系统自己发那个必然死在自签证书上的请求
 * ⇒ 白屏（T49 §2.2 实测）。这条不能被后来的人「优化」掉。
 */
final class PinnedFetch {

	private PinnedFetch() {
	}

	// ---------- T60：并发闸门 / 内存与超时上界 / 可观测 ----------

	/**
	 * T60：同时只允许 {@link #MAX_INFLIGHT} 个响应体在飞。
	 *
	 * <p>取值依据（T55 实测）：真实首屏是 <b>7</b> 并发、同时解压 12.2 MB；人为加压
	 * 可复现 <b>12</b> 并发、14.37 MB 同时驻留，且进程 RSS 峰值从 +40 MB 涨到 +37.9 MB
	 * 量级——<b>与「并发数 × 单包体」线性相关</b>，而单包体已到 9.98 MB 且在长。
	 * 限到 3 把瞬时缓冲从 ~12 MB 压到 ~5 MB。
	 *
	 * <p><b>fair=true（先到先得）</b>是必须的：非公平信号量下，一个 9.98 MB 的大包
	 * 可能把后来到的 30 KB 小资源挤到队尾，小资源是首屏关键路径（CSS），饿死它等于
	 * 把首屏拖到超时。
	 *
	 * <p>⚠️ <b>闸门只能「排队」，不能「拒绝」</b>：T49 §2.2 已证 SW 自己的 fetch()
	 * 在自签证书上必然失败，这里返回 null 会让 SW 子系统自己发那个必然失败的请求 ⇒
	 * {@code net::ERR_FAILED} ⇒ 正是 T49 修掉的白屏。所以 {@link #QUEUE_WAIT_MS}
	 * 取 20 s（远大于实测最慢的 1.5 s）让请求排队等，而不是拿不到许可就放行。
	 */
	private static final int MAX_INFLIGHT = 3;
	private static final Semaphore GATE = new Semaphore(MAX_INFLIGHT, true);

	/** 排队上限。超过则记 {@link #shed} 并返回 null（已知且有界的降级，见类注释）。 */
	private static final long QUEUE_WAIT_MS = 20000L;

	/**
	 * 单次调用的<b>总</b>墙钟预算（含排队）。
	 *
	 * <p>为什么必须总量上界：{@code setReadTimeout} 是<b>每次 read 的空闲超时</b>，
	 * 读循环里每读到一段就重新计时，所以「慢速滴流」下总时长是 N × readTimeout，
	 * <b>理论无上界</b>。45 s 与 {@link #QUEUE_WAIT_MS} 20 s 相加约束住
	 * 「排队 + 传输」这条后台线程被占用的最长时间。
	 */
	private static final long TOTAL_DEADLINE_MS = 45000L;

	/**
	 * 读空闲超时。改前 30 s：既允许一次卡死的连接把线程占住 30 s，
	 * 又在滴流场景下被反复重新计时。改 15 s 后，45 s 总量预算下最多容忍 3 次长停顿。
	 */
	private static final int READ_TIMEOUT_MS = 15000;

	/**
	 * 单响应体硬顶（<b>解压后</b>字节数）。改前 {@code ByteArrayOutputStream}
	 * 无上限增长，等于把上游变成可无限放大的分配源；现在超限即失败并计数。
	 */
	private static final long MAX_BODY_BYTES = 32L * 1024L * 1024L;

	/** 预分配时的下限/上限，避免「Content-Length 说 0 就只给 64 KB」。 */
	private static final int PREALLOC_MIN = 64 * 1024;
	private static final int PREALLOC_CAP = 8 * 1024 * 1024;

	// 计数器：每次 openGateway 归零（见 resetStats），便于「首连 vs 二次进入」对比。
	private static final AtomicInteger inFlight = new AtomicInteger();
	private static final AtomicInteger inFlightPeak = new AtomicInteger();
	private static final AtomicLong queuedWaits = new AtomicLong();
	private static final AtomicLong shed = new AtomicLong();
	private static final AtomicLong bytesTotal = new AtomicLong();

	/** 一轮新连接尝试的零点。openGateway 调用。 */
	static void resetStats() {
		inFlightPeak.set(0);
		queuedWaits.set(0);
		shed.set(0);
		bytesTotal.set(0);
	}

	/** 连接设置页那行只读诊断用的摘要（纯展示，无点击）。 */
	static String statsSummary() {
		return "并发峰值 " + inFlightPeak.get() + "/" + MAX_INFLIGHT
			+ " · 排队 " + queuedWaits.get()
			+ " · 闸门/上限拒绝 " + shed.get()
			+ " · 本次累计 " + fmtBytes(bytesTotal.get());
	}

	private static String fmtBytes(long n) {
		if (n >= 1024L * 1024L) return (n / (1024 * 1024)) + "." + ((n % (1024 * 1024)) / (1024 * 10)) + "MB";
		if (n >= 1024L) return (n / 1024) + "KB";
		return n + "B";
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
		final long t0 = System.currentTimeMillis();
		boolean held = false;
		try {
			// ---- T60 并发闸门：排队，不拒绝 ----
			// tryAcquire 拿不到就等 QUEUE_WAIT_MS；等满仍拿不到才返回 null，
			// 并且必须记账 + 打日志（悄悄降级 = 白屏查不到原因）。
			if (!GATE.tryAcquire(QUEUE_WAIT_MS, TimeUnit.MILLISECONDS)) {
				shed.incrementAndGet();
				Log.w("dshr-perf", "pinnedFetch 排队超时（闸门=" + MAX_INFLIGHT
					+ "，等满 " + QUEUE_WAIT_MS + "ms）→ 不放行 url=" + url);
				return null;
			}
			held = true;
			final int inflightNow = inFlight.incrementAndGet();
			// 峰值只在**刷新峰值的那一刻**打一行：T60 验收要的就是这个数，
			// 事后无法从 ok 行反推（ok 行里的 inflight 是完成时刻的瞬时值）。
			if (inflightNow > inFlightPeak.get()) {
				inFlightPeak.set(inflightNow);
				Log.i("dshr-perf", "pinnedFetch 并发峰值=" + inflightNow + "/" + MAX_INFLIGHT + " url=" + url);
			}
			if (inflightNow > 1) {
				// 真正发生了排队：公平信号量的排队是 FIFO 等，20 s 上限远大于实测 1.5 s。
				queuedWaits.incrementAndGet();
			}
			// 排队占用也算进总量预算，否则「排队 20 s + 传输 45 s」会叠成 65 s。
			final long transportBudgetMs = Math.max(1000L, TOTAL_DEADLINE_MS - (System.currentTimeMillis() - t0));

			URL parsed = new URL(url);
			SSLContext ctx = SSLContext.getInstance("TLS");
			ctx.init(null, new TrustManager[]{pinningTrustManager(store, profileId, host, port, tag)},
				new SecureRandom());
			conn = (HttpsURLConnection) parsed.openConnection();
			conn.setSSLSocketFactory(ctx.getSocketFactory());
			conn.setRequestMethod("GET");
			conn.setConnectTimeout(8000);
			conn.setReadTimeout(READ_TIMEOUT_MS);
			conn.setInstanceFollowRedirects(false);
			conn.setUseCaches(false);
			// 网关会按 accept-encoding 压缩；这里显式声明并**自行解压**，
			// 因为 WebResourceResponse 交出去的是**已解码**的字节。
			// T60：改前声明 "gzip, deflate" 却只解 gzip —— 网关一旦回 deflate，
			// 压缩字节会被当正文喂进 SW 缓存造成内容损坏。现在 deflate 真解。
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
			String enc = encoding == null ? "" : encoding.trim().toLowerCase(Locale.US);
			boolean compressed = enc.contains("gzip") || enc.contains("deflate");
			if (enc.contains("gzip")) {
				in = new GZIPInputStream(in);
			} else if (enc.contains("deflate")) {
				// deflate 有 zlib 包裹（RFC 1950）与裸流（RFC 1951）两种，
				// 嗅探首字节：0x78 / 0x9C / 0x01 等是 zlib 头，否则按裸流解。
				in = new DeflateSniffingStream(in);
			} else if (!enc.isEmpty() && !"identity".equals(enc)) {
				// 声明之外/未知的编码：绝不能把压缩字节当正文交出去。
				// （T60：内容损坏比一次显式失败更难发现——SW 会把垃圾缓存下来。）
				shed.incrementAndGet();
				Log.w("dshr-perf", "pinnedFetch 不支持的 Content-Encoding=" + encoding
					+ "（不把压缩字节当正文）url=" + url);
				return null;
			}
			int declared = conn.getContentLength();
			if (declared > MAX_BODY_BYTES) {
				shed.incrementAndGet();
				Log.w("dshr-perf", "pinnedFetch Content-Length 超上限 declared=" + declared
					+ " cap=" + MAX_BODY_BYTES + " url=" + url);
				return null;
			}
			byte[] body = readBody(in, declared, compressed, transportBudgetMs, url);
			in.close();
			bytesTotal.addAndGet(body.length);
			// 结算行带峰值/排队/拒绝/累计四项 —— 验收的四个指标一次 logcat 读全。
			Log.i("dshr-perf", "pinnedFetch ok bytes=" + body.length + " enc=" + encoding
				+ " peak=" + inFlightPeak.get() + " queued=" + queuedWaits.get()
				+ " shed=" + shed.get() + " total=" + bytesTotal.get() + " url=" + url);
			return new Result(status, conn.getContentType(), conn.getHeaderField("cache-control"), body);
		} catch (Exception e) {
			// 证书未受信 / 网络失败一律不放行。证书那条的具体理由由
			// pinningTrustManager 在抛出前自己打点（见下），这里不吞。
			Log.w("dshr-perf", "pinnedFetch 失败（不放行）：" + e + " url=" + url);
			return null;
		} finally {
			if (held) {
				inFlight.decrementAndGet();
				GATE.release();
			}
			if (conn != null) conn.disconnect();
		}
	}

	/**
	 * T60：把响应体读进一块**预分配**的缓冲，超 {@link #MAX_BODY_BYTES} 即失败。
	 *
	 * <p>改前是 {@code ByteArrayOutputStream(64KB) + toByteArray()}：
	 * ① 无上限增长；② {@code toByteArray()} 必然再复制一份 ⇒ <b>峰值 ≈ 2×</b>。
	 * 这里改成自己管缓冲：{@code declared} 已知就按它开（去掉复制），
	 * 未知就按 1.5 倍增长并**在写满时直接交出底层数组**（同样去掉复制）。
	 *
	 * <p>压缩响应（gzip/deflate）时 {@code Content-Length} 是<b>压缩后</b>长度，
	 * 不能直接拿来开缓冲，因此给 3× 的经验初始值再按需增长——仍然比 64 KB 起步
	 * 少几十次扩容复制。
	 */
	private static byte[] readBody(InputStream in, int declared, boolean compressed,
			long budgetMs, String url) throws IOException {
		// 未压缩时 declared 就是解压后长度，直接开满（后续写满即零复制交出）。
		// 压缩时 declared 只是压缩后长度，给 3× 经验值起步再按需增长。
		long hint = declared > 0 ? (declared * (compressed ? 3L : 1L)) : 0L;
		int cap = (int) Math.max(PREALLOC_MIN, Math.min(PREALLOC_CAP, hint));
		if (cap < 0 || (long) cap > MAX_BODY_BYTES) cap = PREALLOC_MIN;
		byte[] buf = new byte[cap];
		int used = 0;
		long deadline = System.currentTimeMillis() + budgetMs;
		byte[] chunk = new byte[64 * 1024];
		int n;
		while ((n = in.read(chunk)) > 0) {
			// 总量上界：readTimeout 只是空闲超时，慢速滴流下总时长无上界。
			if (System.currentTimeMillis() > deadline) {
				shed.incrementAndGet();
				throw new SocketTimeoutException("pinnedFetch 传输超总量预算 " + budgetMs
					+ "ms（已读 " + used + "B）");
			}
			if (used + n > MAX_BODY_BYTES) {
				shed.incrementAndGet();
				throw new IOException("pinnedFetch 响应体超上限 " + MAX_BODY_BYTES
					+ "B（已读 " + (used + n) + "B）");
			}
			if (used + n > buf.length) {
				int next = (int) Math.max(buf.length + (buf.length >> 1), (long) used + n);
				if (next > MAX_BODY_BYTES) next = (int) MAX_BODY_BYTES;
				byte[] grown = new byte[next];
				System.arraycopy(buf, 0, grown, 0, used);
				buf = grown;
			}
			System.arraycopy(chunk, 0, buf, used, n);
			used += n;
		}
		// 写满时底层数组长度 == 内容长度 ⇒ 直接交出，零复制。
		if (buf.length == used) return buf;
		byte[] exact = new byte[used];
		System.arraycopy(buf, 0, exact, 0, used);
		return exact;
	}

	/**
	 * T60：deflate 流的 zlib/裸流嗅探。
	 * Android 的 {@code InflaterInputStream} 默认按 zlib 包裹解；裸流会抛
	 * {@code ZipException}。这里先看首字节决定用哪种（RFC 1950 的 CMF 低 4 位
	 * 是 8 且 (CMF<<8|FLG) % 31 == 0 ⇒ zlib，否则按裸流）。
	 */
	private static final class DeflateSniffingStream extends InputStream {
		private final InputStream src;
		private final boolean zlibWrapped;
		private InputStream delegate;
		private boolean sniffed;

		DeflateSniffingStream(InputStream src) throws IOException {
			this.src = src;
			this.zlibWrapped = looksZlib(src);
		}

		private static boolean looksZlib(InputStream in) throws IOException {
			in.mark(2);
			int b0 = in.read();
			int b1 = in.read();
			in.reset();
			if (b0 < 0 || b1 < 0) return true;
			if ((b0 & 0x0f) != 8) return false;
			return ((b0 << 8) | b1) % 31 == 0;
		}

		private InputStream out() throws IOException {
			if (delegate == null && sniffed) {
				// nowrap=true 表示按**裸流**（RFC 1951）解；zlib 包裹（RFC 1950）时 nowrap=false。
				delegate = new java.util.zip.InflaterInputStream(src,
					new java.util.zip.Inflater(!zlibWrapped));
			}
			return delegate;
		}

		@Override
		public int read() throws IOException {
			if (!sniffed) sniffed = true;
			return out().read();
		}

		@Override
		public int read(byte[] b, int off, int len) throws IOException {
			if (!sniffed) sniffed = true;
			return out().read(b, off, len);
		}

		@Override
		public int available() throws IOException {
			return sniffed ? out().available() : 0;
		}

		@Override
		public void close() throws IOException {
			src.close();
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
