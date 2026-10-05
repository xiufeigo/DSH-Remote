package top.d1studio.dshremote;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * T104：把**真实 frpc 日志文件**喂给 App 的判定器 {@link TunnelPath}，打印它的结论。
 *
 * <p>跨的是"真值来源"这一步：设备上 T104 的诊断行读的就是这些 frpc 原文
 * （FrpcManager.pump 的每一行 → TunnelPath.observe），所以拿真日志跑一遍就能证明
 * 「打洞成功 / 打洞失败已回退中转 / 未试打洞 / 尚未判定」这四种说法**确实由 frpc 的话推出来**，
 * 不是我们编的。
 *
 * 用法：java ... T104PathFromLog &lt;读入的 frpc 日志&gt; &lt;策略 p2p|relay&gt;
 */
public final class T104PathFromLog {

	public static void main(String[] args) throws Exception {
		if (args.length < 2) {
			System.out.println("usage: T104PathFromLog <logfile> <p2p|relay>");
			System.exit(2);
		}
		String strategy = args[1];
		TunnelPath.reset(strategy);
		int lines = 0;
		try (BufferedReader reader = new BufferedReader(
			new InputStreamReader(Files.newInputStream(Paths.get(args[0])), StandardCharsets.UTF_8))) {
			String line;
			while ((line = reader.readLine()) != null) {
				lines += 1;
				TunnelPath.observe(line);
			}
		}
		System.out.println("日志行数=" + lines
			+ " 判定=" + TunnelPath.path()
			+ " 打洞成功次数=" + TunnelPath.holeCount()
			+ " 回退次数=" + TunnelPath.fallbackCount());
		System.out.println(TunnelPath.summary());
	}
}
