package top.d1studio.dshremote;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;

/** 真正调用生产 fetch 流程，传输装置可控地阻塞/滴流；不把测试传输当作真机网络测量。 */
public final class FetchRequestTest {
	private static Connection next;
	private static int checks;
	private static void check(boolean value, String label) {
		if (!value) throw new AssertionError(label);
		checks++;
		System.out.println("ok " + label);
	}
	private static long elapsed(long start) { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start); }

	private static final class Connection extends HttpsURLConnection {
		int bodyReads;
		boolean blockRead;
		boolean bodyClosed;
		byte[] payload;
		String encoding;
		long connectDelay;
		long headerDelay;
		final CountDownLatch reading = new CountDownLatch(1);
		final CountDownLatch disconnected = new CountDownLatch(1);
		Connection() throws Exception { super(new URL("https://localhost/__dsh_remote__/health")); }
		@Override public void connect() throws IOException { pause(connectDelay); }
		@Override public int getResponseCode() throws IOException { pause(headerDelay); return 200; }
		@Override public InputStream getInputStream() {
			bodyReads++;
			return new InputStream() {
				int offset;
				@Override public int read() throws IOException {
					reading.countDown();
					if (blockRead) {
						// 模拟只响应连接断开、忽略线程中断的阻塞网络流。
						while (disconnected.getCount() != 0) {
							try { disconnected.await(); } catch (InterruptedException ignored) {}
						}
						throw new IOException("disconnected");
					}
					if (payload != null) return offset == payload.length ? -1 : payload[offset++] & 255;
					pause(30); return 'x';
				}
				@Override public int read(byte[] b, int off, int len) throws IOException {
					int value = read();
					if (value < 0) return -1;
					b[off] = (byte) value; return 1;
				}
				@Override public void close() { bodyClosed = true; }
			};
		}
		@Override public String getContentEncoding() { return encoding; }
		@Override public void disconnect() { disconnected.countDown(); }
		@Override public boolean usingProxy() { return false; }
		@Override public String getCipherSuite() { return "fixture"; }
		@Override public Certificate[] getLocalCertificates() { return null; }
		@Override public Certificate[] getServerCertificates() { return null; }
		private static void pause(long ms) throws IOException {
			try { Thread.sleep(ms); }
			catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("cancelled", e); }
		}
	}

	public static void main(String[] args) throws Exception {
		URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
			@Override protected URLConnection openConnection(URL url) { return next; }
		});
		Field gateField = PinnedFetch.class.getDeclaredField("GATE");
		gateField.setAccessible(true);
		Semaphore gate = (Semaphore) gateField.get(null);
		Method fetch = PinnedFetch.class.getDeclaredMethod("fetch", String.class, String.class, int.class,
			String.class, CertPin.Store.class, String.class, FetchRequest.class, boolean.class);
		fetch.setAccessible(true);
		String url = "https://localhost/__dsh_remote__/health";

		// 三个资源名额全部被占时，救援仍能立即得到响应头，且不读正文。
		gate.acquire(3);
		next = new Connection();
		PinnedFetch.Result probe = PinnedFetch.probe(url, "localhost", 443, "", key -> "", new FetchRequest(2000));
		check(probe != null && probe.status == 200 && next.bodyReads == 0, "救援绕开下载队列且不下载正文");
		check(gate.availablePermits() == 0, "救援不借用或多归还资源名额");

		FetchRequest queued = new FetchRequest(2000);
		AtomicReference<Throwable> failure = new AtomicReference<>();
		Thread waiter = new Thread(() -> {
			try { fetch.invoke(null, url, "localhost", 443, "", (CertPin.Store) key -> "", "test", queued, false); }
			catch (Throwable e) { failure.set(e); }
		});
		waiter.start();
		long start = System.nanoTime();
		while (!gate.hasQueuedThreads() && elapsed(start) < 1000) Thread.sleep(5);
		check(gate.hasQueuedThreads(), "装置确实进入资源排队");
		queued.cancel();
		waiter.join(1000);
		check(!waiter.isAlive() && failure.get() == null, "取消能中断许可排队");
		check(gate.availablePermits() == 0, "排队取消不多归还名额");
		gate.release(3);

		// 握手、响应头已经花掉的时间不能在正文阶段重新获得。
		next = new Connection(); next.connectDelay = 130; next.headerDelay = 130;
		start = System.nanoTime();
		Object result = fetch.invoke(null, url, "localhost", 443, "", (CertPin.Store) key -> "", "test", new FetchRequest(500), false);
		long duration = elapsed(start);
		Thread.interrupted(); // 本用例由截止定时器中断测试线程。
		check(result == null && duration >= 400 && duration < 850, "滴流正文按整个请求的 500ms 截止，实测 " + duration + "ms");
		check(gate.availablePermits() == 3, "失败后归还全部下载名额");
		check(next.disconnected.await(1, TimeUnit.SECONDS), "截止后断开传输");
		check(next.bodyClosed, "读取异常时仍关闭响应流");

		next = new Connection(); next.blockRead = true;
		start = System.nanoTime();
		result = fetch.invoke(null, url, "localhost", 443, "", (CertPin.Store) key -> "", "test", new FetchRequest(300), false);
		duration = elapsed(start);
		Thread.interrupted();
		check(result == null && duration < 1000 && next.bodyClosed, "截止时间断开忽略中断的阻塞 read，实测 " + duration + "ms");

		next = new Connection(); next.blockRead = true;
		FetchRequest active = new FetchRequest(2000);
		Thread reader = new Thread(() -> {
			try { fetch.invoke(null, url, "localhost", 443, "", (CertPin.Store) key -> "", "test", active, false); }
			catch (Throwable e) { failure.set(e); }
		});
		reader.start();
		check(next.reading.await(1, TimeUnit.SECONDS), "装置确实阻塞在正文读取");
		start = System.nanoTime(); active.cancel();
		check(elapsed(start) < 100, "取消调用不在调用线程等待断开");
		reader.join(1000);
		check(!reader.isAlive() && failure.get() == null && gate.availablePermits() == 3, "主动取消阻塞读取后退出并归还名额");

		byte[] plain = "压缩资源正文".getBytes(java.nio.charset.StandardCharsets.UTF_8);
		for (boolean raw : new boolean[] { false, true }) {
			java.io.ByteArrayOutputStream compressed = new java.io.ByteArrayOutputStream();
			java.util.zip.Deflater deflater = new java.util.zip.Deflater(6, raw);
			try (java.util.zip.DeflaterOutputStream out = new java.util.zip.DeflaterOutputStream(compressed, deflater)) { out.write(plain); }
			finally { deflater.end(); }
			next = new Connection(); next.payload = compressed.toByteArray(); next.encoding = "deflate";
			PinnedFetch.Result decoded = (PinnedFetch.Result) fetch.invoke(null, url, "localhost", 443, "", (CertPin.Store) key -> "", "test", new FetchRequest(2000), false);
			check(decoded != null && java.util.Arrays.equals(decoded.body, plain) && next.bodyClosed, "deflate " + (raw ? "裸流" : "zlib") + " 正确解码并关闭");
		}

		FetchRequest completed = new FetchRequest(100);
		completed.begin(); completed.close();
		Thread.sleep(180);
		check(!Thread.currentThread().isInterrupted(), "已完成请求不会被旧定时器再次中断");
		FetchRequest cancelled = new FetchRequest(1000);
		cancelled.cancel();
		boolean rejected = false;
		try { cancelled.begin(); } catch (IOException expected) { rejected = true; }
		check(rejected, "开始前取消的请求不得进入网络阶段");
		System.out.println("Fetch lifecycle tests passed: " + checks);
	}
}
