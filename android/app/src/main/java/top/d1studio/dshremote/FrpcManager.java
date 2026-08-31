package top.d1studio.dshremote;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * frpc visitor 子进程托管：写 toml → exec 打包在 jniLibs 里的 libfrpc.so
 * （安装时被系统解压到 nativeLibraryDir，Android 允许执行该目录，不允许执行 filesDir）。
 *
 * 崩溃自动重启（指数退避至 60s）；日志进 logcat（tag dshr-frpc），保留尾部供「关于」查看。
 * stop() 会等到进程真正退出，避免 18443 仍被旧进程占用、新 visitor 起不来。
 */
public class FrpcManager {

	private static final String TAG = "dshr-frpc";
	private static final int MAX_LOG_LINES = 200;

	private final File workDir;
	private final File binFile;
	private Process process;
	private volatile boolean stopping = false;
	private volatile int startEpoch = 0;
	private Thread watcher;
	private long backoffMs = 1000;
	private final StringBuilder tail = new StringBuilder();

	public FrpcManager(Context context) {
		workDir = context.getFilesDir();
		binFile = new File(context.getApplicationInfo().nativeLibraryDir, "libfrpc.so");
	}

	/** frpc 二进制是否存在（APK 里没打包 libfrpc.so 时给出可读错误）。 */
	public boolean binaryAvailable() {
		return binFile.exists() && binFile.canExecute();
	}

	public synchronized void start(final VisitorConfig cfg) {
		stopLocked();
		stopping = false;
		final int epoch = startEpoch;
		if (!binaryAvailable()) {
			log("frpc 二进制缺失：" + binFile.getAbsolutePath());
			return;
		}
		try {
			File conf = new File(workDir, "frpc-visitor.toml");
			OutputStream os = new FileOutputStream(conf);
			os.write(cfg.toToml().getBytes(StandardCharsets.UTF_8));
			os.close();

			ProcessBuilder pb = new ProcessBuilder(binFile.getAbsolutePath(), "-c", conf.getAbsolutePath());
			pb.redirectErrorStream(true);
			process = pb.start();
			log("frpc 启动：-c " + conf.getName());
			pump(process);
			watch(cfg, epoch);
		} catch (Exception e) {
			log("frpc 启动失败：" + e.getMessage());
		}
	}

	private void pump(final Process p) {
		Thread t = new Thread(() -> {
			InputStream in = p.getInputStream();
			BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
			try {
				String line;
				while ((line = reader.readLine()) != null) {
					log(line);
				}
			} catch (Exception ignored) {
			}
		}, "frpc-log");
		t.setDaemon(true);
		t.start();
	}

	private void watch(final VisitorConfig cfg, final int epoch) {
		final Process p = process;
		if (p == null) return;
		watcher = new Thread(() -> {
			try {
				int code = p.waitFor();
				if (stopping || epoch != startEpoch) return;
				log("frpc 退出 code=" + code + "，" + backoffMs + "ms 后重启");
				Thread.sleep(backoffMs);
				if (stopping || epoch != startEpoch) return;
				backoffMs = Math.min(backoffMs * 2, 60000);
				restartIfCurrent(cfg, epoch);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		}, "frpc-watch");
		watcher.setDaemon(true);
		watcher.start();
	}

	private synchronized void restartIfCurrent(final VisitorConfig cfg, final int epoch) {
		if (stopping || epoch != startEpoch) return;
		start(cfg);
	}

	public synchronized void stop() {
		stopLocked();
	}

	private void stopLocked() {
		stopping = true;
		startEpoch += 1;
		Thread w = watcher;
		watcher = null;
		if (w != null && w != Thread.currentThread()) w.interrupt();
		Process p = process;
		process = null;
		if (p != null) {
			p.destroy();
			waitExit(p, 1500);
			if (isProcessAlive(p) && Build.VERSION.SDK_INT >= 26) {
				p.destroyForcibly();
				waitExit(p, 1000);
			}
		}
		backoffMs = 1000;
	}

	private static boolean isProcessAlive(Process p) {
		if (p == null) return false;
		try {
			p.exitValue();
			return false;
		} catch (IllegalThreadStateException e) {
			return true;
		}
	}

	private static void waitExit(Process p, long timeoutMs) {
		if (p == null) return;
		if (Build.VERSION.SDK_INT >= 26) {
			try {
				p.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			return;
		}
		long deadline = System.currentTimeMillis() + timeoutMs;
		while (System.currentTimeMillis() < deadline) {
			if (!isProcessAlive(p)) return;
			try {
				Thread.sleep(50);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
		}
	}

	/** 尾部日志（调试用）。 */
	public synchronized String tailLog() {
		return tail.toString();
	}

	private void log(String line) {
		Log.i(TAG, line);
		synchronized (tail) {
			tail.append(line).append('\n');
			int extra = tail.length() - MAX_LOG_LINES * 120;
			if (extra > 0) tail.delete(0, extra);
		}
	}

}
