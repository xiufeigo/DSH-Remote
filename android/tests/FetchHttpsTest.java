package top.d1studio.dshremote;

import com.sun.net.httpserver.HttpsServer;
import com.sun.net.httpserver.HttpsConfigurator;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/** 真 HTTPS 传输：响应头返回后正文保持阻塞，客户端必须通过取消释放读取线程。 */
public final class FetchHttpsTest {
	public static void main(String[] args) throws Exception {
		KeyStore keys = KeyStore.getInstance("PKCS12");
		try (InputStream in = Files.newInputStream(Paths.get(args[0]))) { keys.load(in, args[1].toCharArray()); }
		KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
		km.init(keys, args[1].toCharArray());
		SSLContext tls = SSLContext.getInstance("TLS"); tls.init(km.getKeyManagers(), null, null);
		StringBuilder fingerprint = new StringBuilder();
		for (byte b : MessageDigest.getInstance("SHA-256").digest(keys.getCertificate("fixture").getEncoded())) fingerprint.append(String.format("%02x", b));
		HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		server.setHttpsConfigurator(new HttpsConfigurator(tls));
		java.util.concurrent.ExecutorService handlers = Executors.newCachedThreadPool();
		server.setExecutor(handlers);
		CountDownLatch release = new CountDownLatch(1);
		CountDownLatch firstByte = new CountDownLatch(1);
		java.util.concurrent.atomic.AtomicInteger requests = new java.util.concurrent.atomic.AtomicInteger();
		server.createContext("/__dsh_remote__/health", exchange -> {
			try {
				exchange.sendResponseHeaders(200, 0);
				exchange.getResponseBody().write('x'); exchange.getResponseBody().flush();
				if (requests.incrementAndGet() >= 2) firstByte.countDown();
				release.await(20, TimeUnit.SECONDS);
			} catch (InterruptedException e) { Thread.currentThread().interrupt(); }
			finally { exchange.close(); }
		});
		server.start();
		int port = server.getAddress().getPort();
		String url = "https://127.0.0.1:" + port + "/__dsh_remote__/health";
		CertPin.Store pins = key -> fingerprint.toString();
		try {
			PinnedFetch.Result probe = PinnedFetch.probe(url, "127.0.0.1", port, "fixture", pins, new FetchRequest(5000));
			if (probe == null || probe.status != 200 || probe.body.length != 0) throw new AssertionError("HTTPS 响应头探针失败");
			System.out.println("ok real HTTPS probe returns without reading blocked body");
			java.lang.reflect.Method fetch = PinnedFetch.class.getDeclaredMethod("fetch", String.class, String.class, int.class, String.class, CertPin.Store.class, String.class, FetchRequest.class, boolean.class);
			fetch.setAccessible(true);
			FetchRequest request = new FetchRequest(15000);
			AtomicReference<Throwable> error = new AtomicReference<>();
			Thread reader = new Thread(() -> {
				try { fetch.invoke(null, url, "127.0.0.1", port, "fixture", pins, "test", request, false); }
				catch (Throwable e) { error.set(e); }
			});
			reader.setDaemon(true); reader.start();
			if (!firstByte.await(5, TimeUnit.SECONDS)) throw new AssertionError("HTTPS server did not send data");
			Thread.sleep(300);
			long start = System.nanoTime(); request.cancel(); reader.join(2000);
			if (reader.isAlive() || error.get() != null) throw new AssertionError("HTTPS cancel did not release blocked read within 2s", error.get());
			System.out.println("ok real HTTPS blocked read cancelled in " + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) + "ms");
			start = System.nanoTime();
			Object timed = fetch.invoke(null, url, "127.0.0.1", port, "fixture", pins, "test", new FetchRequest(800), false);
			long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
			Thread.interrupted();
			if (timed != null || elapsed > 1600) throw new AssertionError("HTTPS 800ms deadline exceeded: " + elapsed);
			System.out.println("ok real HTTPS blocked body obeys total deadline in " + elapsed + "ms");
		} finally { release.countDown(); server.stop(0); handlers.shutdownNow(); }
	}
}
