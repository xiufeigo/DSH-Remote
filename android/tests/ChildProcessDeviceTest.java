package top.d1studio.dshremote;

import android.system.Os;
import android.system.OsConstants;
import java.util.concurrent.TimeUnit;

/** 必须在 Android 上跑：桌面 JVM 的 destroyForcibly() 与 Android 行为不同。 */
public final class ChildProcessDeviceTest {
	public static void main(String[] args) throws Exception {
		String literal = "spaces ; $() stay literal";
		ChildProcess echo = ChildProcess.start("/system/bin/sh", "-c", "printf '%s\\n' \"$1\"", "fixture", literal);
		if (!literal.equals(echo.output.readLine()) || echo.waitFor() != 0) throw new AssertionError("exec 参数未原样保留");
		echo.stop();
		System.out.println("PASS exec preserves arguments and output after PID handshake");
		checkStop(false, false);
		checkStop(true, false);
		checkStop(true, true);
	}

	private static void checkStop(boolean frozen, boolean interrupted) throws Exception {
		ChildProcess child = ChildProcess.start("/system/bin/sleep", "60");
		try {
			if (frozen) {
				Os.kill(child.pid, OsConstants.SIGSTOP);
				awaitStopped(child.pid);
			}
			if (interrupted) Thread.currentThread().interrupt();
			long start = System.nanoTime();
			child.stop();
			long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
			if (child.isAlive() || elapsed > 2800) throw new AssertionError("子进程停止失败 elapsed=" + elapsed);
			if (frozen && elapsed < 1400) throw new AssertionError("冻结故障未保持到强制终止阶段 elapsed=" + elapsed);
			if (Thread.currentThread().isInterrupted() != interrupted) throw new AssertionError("中断状态未保留");
			Thread.interrupted();
			child.stop();
			System.out.println("PASS stop frozen=" + frozen + " interrupted=" + interrupted + " elapsed=" + elapsed + "ms; idempotent cleanup");
		} finally {
			Thread.interrupted();
			if (child.isAlive()) Os.kill(child.pid, OsConstants.SIGKILL);
		}
	}

	private static void awaitStopped(int pid) throws Exception {
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
		while (System.nanoTime() < deadline) {
			try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader("/proc/" + pid + "/status"))) {
				String line;
				while ((line = reader.readLine()) != null) if (line.startsWith("State:") && line.contains("T")) return;
			}
			Thread.sleep(5);
		}
		throw new AssertionError("子进程未进入 SIGSTOP 状态");
	}
}
