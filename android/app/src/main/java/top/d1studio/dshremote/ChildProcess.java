package top.d1studio.dshremote;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

/** 拥有明确 PID 的直接子进程；Android 的 destroyForcibly() 不保证发送 SIGKILL。 */
final class ChildProcess {
	private static final long TERMINATE_WAIT_MS = 1500;
	private static final long KILL_WAIT_MS = 1000;
	private static final long EXIT_POLL_MS = 25;
	final int pid;
	final BufferedReader output;
	private final Process process;

	private ChildProcess(Process process, int pid, BufferedReader output) {
		this.process = process;
		this.pid = pid;
		this.output = output;
	}

	static ChildProcess start(String... command) throws IOException {
		// shell 先报告自己的 PID，再原位 exec；参数通过 "$@" 传递，不拼进命令文本。
		ArrayList<String> args = new ArrayList<>(Arrays.asList(
			"/system/bin/sh", "-c", "echo DSHR_PID=$$; exec \"$@\"", "dshr-child"));
		args.addAll(Arrays.asList(command));
		Process process = new ProcessBuilder(args).redirectErrorStream(true).start();
		BufferedReader output = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
		String identity = output.readLine();
		if (identity == null || !identity.matches("DSHR_PID=[1-9][0-9]*")) {
			process.destroy();
			throw new IOException("子进程未返回有效 PID：" + identity);
		}
		return new ChildProcess(process, Integer.parseInt(identity.substring("DSHR_PID=".length())), output);
	}

	boolean isAlive() {
		try { process.exitValue(); return false; }
		catch (IllegalThreadStateException e) { return true; }
	}

	int waitFor() throws InterruptedException { return process.waitFor(); }

	void stop() throws IOException {
		if (isAlive()) signal(OsConstants.SIGTERM);
		if (!awaitExit(TERMINATE_WAIT_MS)) {
			signal(OsConstants.SIGKILL);
			if (!awaitExit(KILL_WAIT_MS)) throw new IOException("子进程强制终止后仍未退出 PID=" + pid);
		}
		output.close();
		process.getOutputStream().close();
		process.getErrorStream().close();
	}

	private void signal(int signal) throws IOException {
		if (!isAlive()) return;
		try { Os.kill(pid, signal); }
		catch (ErrnoException e) {
			// 退出与信号并发时 ESRCH 正常；仍由原 Process 等待并确认回收。
			if (e.errno != OsConstants.ESRCH) throw new IOException("终止子进程失败 PID=" + pid, e);
		}
	}

	private boolean awaitExit(long timeoutMs) {
		long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
		boolean interrupted = Thread.interrupted();
		try {
			while (isAlive()) {
				long remaining = deadline - System.nanoTime();
				if (remaining <= 0) return false;
				try { Thread.sleep(Math.min(EXIT_POLL_MS, Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)))); }
				catch (InterruptedException e) { interrupted = true; }
			}
			return true;
		} finally {
			// 清理必须完成，中断状态交还调用方，不能把取消误当成进程已经退出。
			if (interrupted) Thread.currentThread().interrupt();
		}
	}
}
