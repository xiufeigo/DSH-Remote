package top.d1studio.dshremote;

import java.io.InterruptedIOException;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLSocketFactory;

/** 一次请求的单调时钟截止时间与取消句柄；排队、握手、响应头、正文共用同一预算。 */
final class FetchRequest implements AutoCloseable {
	private static final ScheduledThreadPoolExecutor TIMER = new ScheduledThreadPoolExecutor(1, r -> {
		Thread thread = new Thread(r, "fetch-deadline");
		thread.setDaemon(true);
		return thread;
	});
	static { TIMER.setRemoveOnCancelPolicy(true); }
	// 最多三个资源下载和一个串行救援请求；关闭等待不再无界创建线程。
	private static final int MAX_CLOSE_WORKERS = 4;
	private static final java.util.concurrent.ExecutorService CLOSER = Executors.newFixedThreadPool(MAX_CLOSE_WORKERS, r -> {
		Thread thread = new Thread(r, "fetch-disconnect");
		thread.setDaemon(true);
		return thread;
	});

	private final long deadlineNanos;
	private boolean cancelled;
	private boolean finished;
	private Thread worker;
	private HttpURLConnection connection;
	private Socket transport;
	private ScheduledFuture<?> timeout;

	FetchRequest(long timeoutMs) {
		if (timeoutMs <= 0) throw new IllegalArgumentException("请求超时必须大于零");
		deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
	}

	synchronized void begin() throws InterruptedIOException {
		check();
		if (worker != null || finished) throw new IllegalStateException("请求句柄只能使用一次");
		worker = Thread.currentThread();
		timeout = TIMER.schedule(this::cancel, remainingMillis(), TimeUnit.MILLISECONDS);
	}

	synchronized void attach(HttpURLConnection next) throws InterruptedIOException {
		check();
		connection = next;
	}

	private Socket track(Socket socket) throws IOException {
		try {
			synchronized (this) {
				check();
				transport = socket;
			}
			return socket;
		} catch (IOException e) {
			try { socket.close(); } catch (IOException closeError) { e.addSuppressed(closeError); }
			throw e;
		}
	}

	/** 直接持有 TLS 下层套接字，取消不能等 HttpsURLConnection 的响应流锁。 */
	SSLSocketFactory socketFactory(SSLSocketFactory delegate) {
		return new SSLSocketFactory() {
			@Override public String[] getDefaultCipherSuites() { return delegate.getDefaultCipherSuites(); }
			@Override public String[] getSupportedCipherSuites() { return delegate.getSupportedCipherSuites(); }
			@Override public Socket createSocket(Socket socket, String host, int port, boolean autoClose) throws IOException {
				track(socket);
				return delegate.createSocket(socket, host, port, autoClose);
			}
			@Override public Socket createSocket() throws IOException { return track(delegate.createSocket()); }
			@Override public Socket createSocket(String host, int port) throws IOException { return track(delegate.createSocket(host, port)); }
			@Override public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
				return track(delegate.createSocket(host, port, local, localPort));
			}
			@Override public Socket createSocket(InetAddress host, int port) throws IOException { return track(delegate.createSocket(host, port)); }
			@Override public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
				return track(delegate.createSocket(host, port, local, localPort));
			}
		};
	}

	synchronized int remainingMillis() throws InterruptedIOException {
		check();
		long remaining = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
		return (int) Math.max(1, Math.min(Integer.MAX_VALUE, remaining));
	}

	synchronized void check() throws InterruptedIOException {
		if (System.nanoTime() >= deadlineNanos) throw new SocketTimeoutException("请求超过总截止时间");
		if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("请求已取消");
	}

	void cancel() {
		HttpURLConnection current;
		Socket socket;
		synchronized (this) {
			if (finished || cancelled) return;
			cancelled = true;
			if (worker != null) worker.interrupt();
			current = connection;
			socket = transport;
		}
		if (socket != null) {
			CLOSER.execute(() -> {
				try { socket.close(); }
				catch (IOException e) { throw new java.io.UncheckedIOException("取消请求时关闭套接字失败", e); }
			});
		} else if (current != null) {
			// 尚未进入 TLS 时还没有套接字；连接建立后 track() 会拒绝已经取消的请求。
			CLOSER.execute(current::disconnect);
		}
	}

	@Override public synchronized void close() {
		finished = true;
		connection = null;
		transport = null;
		worker = null;
		if (timeout != null) timeout.cancel(false);
	}
}
