package top.d1studio.dshremote;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

/**
 * T65：首屏静态资源的 **App 私有目录落盘缓存**。
 *
 * <h3>为什么需要它（T62 实测根因）</h3>
 * 首连时页面那 35 个资源（3 个 {@code /plugins/} 大包 + 4 个 {@code /assets/}，合计 ~6 MB）
 * <b>不经过 Service Worker</b>（首屏导航早于 SW 激活），走的是页面自己的网络栈，即
 * {@code MainActivity} 的 {@code WebViewClient}——而改前那个 WebViewClient
 * <b>没有 {@code shouldInterceptRequest}</b>。于是那批字节<b>无处可存</b>：
 * <ul>
 *   <li>SW 没看到 ⇒ 不进 {@code CacheStorage}；</li>
 *   <li>自签证书 ⇒ 不进 HTTP 磁盘缓存（T62 实测 {@code Cache_Data} 仅 32 KB）。</li>
 * </ul>
 * ⇒ 每次全新安装/升级，用户要<b>付两遍</b>这 ~6 MB（第一次纯浪费，第二次才灌进 SW 缓存）。
 * 本类给首屏这条路一个落盘处，让「第二次进入」不再全量重下。
 *
 * <h3>键：完整 URL（含 {@code rev}）</h3>
 * 键 = {@code SHA-256(完整 URL 字符串)}，<b>含 query</b>。这一点不可省：
 * {@code /plugins/} 组合包的 URL 是 {@code /plugins/??…&rev=<内容指纹>}，pathname 恒为
 * {@code /plugins/}，<b>只有 query 里的 {@code rev} 能区分三个不同的包</b>。
 * 键若只取 pathname 或是 {@code origin+pathname}，先落盘的 5 MB 大包会被当成所有
 * {@code /plugins/} 请求的答案，喂给只想要 40 KB 的 {@code __ModuleLoader__.load()}
 * ⇒ <b>白屏</b>（T44 已证、T49 有负控制复现；pwa.ts 注释也把这条列为「必须同批改」的另一半）。
 * <p>键含 {@code rev} 同时让「DSH 升级 ⇒ 资源内容变 ⇒ URL 变 ⇒ 必然取到新资源」天然成立，
 * 不需要额外的失效逻辑，也就不存在「网关换了内容却不换 rev」之外的陈旧窗口。
 *
 * <h3>落盘的是<b>解压后</b>的字节</h3>
 * 取数走 {@link PinnedFetch}，它已经自行解掉 gzip/deflate
 * （{@code PinnedFetch.java:237-250}），本类只负责把<b>已解码</b>的字节写下去。
 * 读回时构造的 {@code WebResourceResponse} <b>不声明任何 {@code content-encoding}</b>
 * ——声明了就是让 WebView 再解一次，喂进去的是垃圾（T60 已把这条路走过一次）。
 *
 * <h3>上限与淘汰：<b>真计量、真执行</b>（T53 教训）</h3>
 * T51 曾写过一句「有 {@code CACHE_MAX_BYTES} 上限」的注释而实现里没有，T53 把它当
 * 「假账」删掉了。T50 §8.1 之所以说 Cache API 查不到条目大小，是因为它在<b>浏览器侧</b>；
 * 本类在 <b>App 侧</b>，条目就是自己写的文件，{@code File.length()} 就是真字节数。
 * 所以这里的上限是<b>逐字节真的在执行</b>的：
 * <ul>
 *   <li>{@link #MAX_TOTAL_BYTES}：每次写入后统计全目录 {@code .bin} 真实长度之和，
 *       超了就按 {@code lastModified} 升序（最久未命中）删到线内；</li>
 *   <li>{@link #MAX_ENTRIES}：条目数上限，同样真删。</li>
 * </ul>
 * 命中时 {@code setLastModified} 刷新 ⇒ 这就是 LRU（不是「插入序」，见
 * {@link #touch} 的注释：Android 6.0+ 才允许写 mtime，而本 App minSdk 24）。
 * 每次淘汰都打一行 {@code dshr-perf}，把<b>删前/删后/删了几条/各省多少字节</b>全部记下来，
 * 这样「上限生效」是可从 logcat 直接验证的，不是注释承诺。
 *
 * <h3>与 SW 缓存的<b>双份占盘</b></h3>
 * 同一批字节会有两份：SW 的 {@code CacheStorage}（浏览器侧，跨进程存活，T62 §2.1 实测）
 * 与本目录（App 侧）。T62 §4.5 实测浏览器侧放大 <b>1.75×</b>（12,960,301 B 解码内容
 * 占盘 22,652 KB）——本目录是<b>解压后的原始字节</b>，放大系数为 1（1.00×）。
 * 两者相加即双份占用，取值与实测见 T65 报告 §3.3。
 */
final class StaticDiskCache {

	private StaticDiskCache() {
	}

	private static final String TAG = "dshr-perf";

	/**
	 * 总字节硬顶（<b>解压后</b>字节，真执行于 {@link #enforceLimits}）。
	 *
	 * <p>取值依据：一份首屏静态 ≈ 12.96 MB（3 个 {@code /plugins/} 11,477,184 B +
	 * 4 个 {@code /assets/} 1,479,483 B + favicon 3,634 B，T62 §2.2 实测）。
	 * 本目录是解压后原始字节 ⇒ 一份 ≈ 12.96 MB。取 48 MB = 约 3.7 份：
	 * 足够留住当前版本 + 上一版本（DSH 升级后旧 rev 条目必然变僵尸，删它们不亏），
	 * 又不会在没有 LRU 的浏览器侧之外再多撑出一份无界增长。
	 */
	static final long MAX_TOTAL_BYTES = 48L * 1024L * 1024L;

	/**
	 * 条目数上限，真执行。{@code /plugins/} 三个包 + {@code /assets/} 四个 = 7 条/轮，
	 * 64 条 ≈ 9 轮，与浏览器侧 {@code pwa.ts} 的 {@code CACHE_MAX_ENTRIES=64} 同量级。
	 */
	static final int MAX_ENTRIES = 64;

	/** 单条硬顶：与 {@code PinnedFetch.MAX_BODY_BYTES} 同值，不让单条把总量吃光。 */
	private static final long MAX_ENTRY_BYTES = 32L * 1024L * 1024L;

	// 计数器：每次 openGateway 由 MainActivity 归零（与 PinnedFetch.resetStats 同点）。
	private static final AtomicLong intercepted = new AtomicLong();
	private static final AtomicLong diskHit = new AtomicLong();
	private static final AtomicLong fetched = new AtomicLong();
	private static final AtomicLong stored = new AtomicLong();
	private static final AtomicLong evicted = new AtomicLong();
	private static final AtomicLong storeFailed = new AtomicLong();
	private static final AtomicLong hitBytes = new AtomicLong();
	private static final AtomicLong fetchBytes = new AtomicLong();

	/** 一轮新连接尝试的零点。MainActivity.openGateway 调用。 */
	static void resetStats() {
		intercepted.set(0);
		diskHit.set(0);
		fetched.set(0);
		stored.set(0);
		evicted.set(0);
		storeFailed.set(0);
		hitBytes.set(0);
		fetchBytes.set(0);
	}

	/** 设置页那行只读诊断用的摘要（纯展示、无点击、不新增控件）。 */
	static String statsSummary() {
		return "落盘缓存 拦 " + intercepted.get() + " · 命中 " + diskHit.get()
			+ " · 取回 " + fetched.get() + " · 淘汰 " + evicted.get()
			+ " · 落盘失败 " + storeFailed.get()
			+ " · 命中/取回字节 " + fmt(hitBytes.get()) + "/" + fmt(fetchBytes.get());
	}

	/** 一次命中的结果。{@code body} 是**解压后**字节。 */
	static final class Hit {
		final byte[] body;
		final String contentType;
		/**
		 * 落盘时**原样**记下的 cache-control。必须存：SW 侧（ServiceWorkerClient 那条路）
		 * 正是靠它决定「no-cache 响应不进自己的缓存」（T49 的原注释）。
		 * 命中时若拿不到它，SW 的缓存判定就会变。
		 */
		final String cacheControl;

		Hit(byte[] body, String contentType, String cacheControl) {
			this.body = body;
			this.contentType = contentType;
			this.cacheControl = cacheControl;
		}
	}

	/**
	 * 查盘。命中返回解压后字节，未命中/任何异常返回 null（调用方走网络再落盘）。
	 *
	 * <p>不抛异常、不吞：读盘失败就当没命中，最坏退回「本次下完再落盘」，
	 * 与改动前完全同构——这正是 T49 在 PinnedFetch 上确立的降级原则
	 * （返回 null ≠ 放行走一条必然失败的路，这里放行的是 WebView 自己的正常网络栈）。
	 */
	static Hit get(File dir, String url) {
		intercepted.incrementAndGet();
		String key = keyOf(url);
		if (key == null) return null;
		File body = bodyFile(dir, key);
		File meta = metaFile(dir, key);
		if (!body.isFile()) return null;
		try {
			long len = body.length();
			if (len <= 0 || len > MAX_ENTRY_BYTES) {
				Log.w(TAG, "落盘缓存 命中但长度异常（按未命中处理）len=" + len + " key=" + key);
				// 半截文件（写盘被打断）：删掉，避免每次都白读一次。
				//noinspection ResultOfMethodCallIgnored
				body.delete();
				//noinspection ResultOfMethodCallIgnored
				meta.delete();
				return null;
			}
			byte[] data = readAll(body, (int) len);
			String ct = "";
			String cc = "";
			if (meta.isFile()) {
				InputStream in = new FileInputStream(meta);
				try {
					// 第 1 行 contentType，第 2 行 cacheControl。
					// 只读前 512 字节：这两个头都很短，够了。
					String txt = new String(readAll(in, 512), "UTF-8");
					int nl = txt.indexOf('\n');
					if (nl >= 0) {
						ct = txt.substring(0, nl).trim();
						cc = txt.substring(nl + 1).trim();
					} else {
						ct = txt.trim();
					}
				} finally {
					in.close();
				}
			}
			touch(body);
			diskHit.incrementAndGet();
			hitBytes.addAndGet(data.length);
			return new Hit(data, ct, cc);
		} catch (Exception e) {
			Log.w(TAG, "落盘缓存 读失败（按未命中处理）：" + e + " key=" + key);
			return null;
		}
	}

	/**
	 * 落盘。<b>先写临时文件再 rename</b> ⇒ 任何时刻磁盘上的 {@code .bin} 要么是上一份
	 * 完整内容，要么是这一份完整内容，<b>不会</b>出现被并发读到的半截。
	 * （首屏有真并发：{@code PinnedFetch} 闸门放行 3 个，而同一 URL 被两个请求同时要
	 * 完全可能；不 rename 就会互相截断。）
	 *
	 * <p>失败**必须可见</p>：吞掉的话用户从此每轮重下 6 MB 而控制台没有任何提示
	 * （T50 §8.1 对浏览器侧同款问题的判词）。
	 */
	static void put(File dir, String url, byte[] body, String contentType, String cacheControl) {
		if (body == null || body.length == 0) return;
		if (body.length > MAX_ENTRY_BYTES) {
			storeFailed.incrementAndGet();
			Log.w(TAG, "落盘缓存 单条超上限，不落盘 bytes=" + body.length
				+ " cap=" + MAX_ENTRY_BYTES + " url=" + url);
			return;
		}
		String key = keyOf(url);
		if (key == null) return;
		try {
			File sub = subDir(dir, key);
			if (!sub.isDirectory() && !sub.mkdirs()) {
				storeFailed.incrementAndGet();
				Log.w(TAG, "落盘缓存 建目录失败 dir=" + sub + " url=" + url);
				return;
			}
			File bodyFile = new File(sub, key + ".bin");
			File tmp = new File(sub, key + ".bin.tmp");
			writeAll(tmp, body);
			//noinspection ResultOfMethodCallIgnored
			if (bodyFile.exists() && !bodyFile.delete()) {
				storeFailed.incrementAndGet();
				Log.w(TAG, "落盘缓存 覆盖旧条目失败（保留旧内容）" + bodyFile.getAbsolutePath());
				return;
			}
			if (!tmp.renameTo(bodyFile)) {
				storeFailed.incrementAndGet();
				Log.w(TAG, "落盘缓存 rename 失败（不落盘）" + tmp.getName() + " -> " + bodyFile.getName());
				//noinspection ResultOfMethodCallIgnored
				tmp.delete();
				return;
			}
			// meta 写失败**不**回滚正文：正文在 + contentType 缺失，最坏是 MIME 猜错，
			// 而把已经下好的 5 MB 删掉换一个 MIME 猜错的更糟。记一笔即可。
			try {
				// 两行：contentType / cacheControl。换行用 \n，读侧按第一个 \n 切。
				String meta = (contentType == null ? "" : contentType)
					+ "\n" + (cacheControl == null ? "" : cacheControl);
				writeAll(new File(sub, key + ".meta"), meta.getBytes("UTF-8"));
			} catch (Exception e) {
				storeFailed.incrementAndGet();
				Log.w(TAG, "落盘缓存 contentType/cacheControl 写入失败（响应头将退化）" + e);
			}
			stored.incrementAndGet();
			enforceLimits(dir, url);
		} catch (Exception e) {
			storeFailed.incrementAndGet();
			Log.w(TAG, "落盘缓存 写入失败（不影响页面，本次只是白下一次）：" + e + " url=" + url);
		}
	}

	/** 记一次「取回并落盘」的字节数，供诊断与验收对照。 */
	static void noteFetched(long bytes) {
		fetched.incrementAndGet();
		fetchBytes.addAndGet(bytes);
	}

	/**
	 * T65：**真**上限。真去 {@code File.length()} 逐条累加，超线就按最久未命中删。
	 *
	 * <p>为什么必须真删：{@code /plugins/} 的 rev 变化会让旧 rev 条目**永远命中不了**
	 * （键含 rev），而没有任何东西会清它们——这正是 T50 §8.1 记录的无上限增长
	 * （「每次上游插件集合变化 +11.5 MB 僵尸」）。浏览器侧 T51 用「按 rev 个数淘汰」
	 * 封住了同样的洞，本目录没有 rev 语义可依赖，<b>只能</b>用字节 + 条目两条真上限。
	 */
	private static void enforceLimits(File dir, String whyUrl) {
		List<File> bodies = new ArrayList<File>();
		long total = 0L;
		File[] subs = dir.listFiles();
		if (subs == null) return;
		for (File s : subs) {
			File[] fs = s.listFiles();
			if (fs == null) continue;
			for (File f : fs) {
				if (!f.getName().endsWith(".bin")) continue;
				bodies.add(f);
				total += f.length();
			}
		}
		boolean overBytes = total > MAX_TOTAL_BYTES;
		boolean overCount = bodies.size() > MAX_ENTRIES;
		if (!overBytes && !overCount) return;

		// 最久未命中先走（命中时 touch 刷过 mtime ⇒ 这就是 LRU，不是插入序）。
		Collections.sort(bodies, new Comparator<File>() {
			@Override
			public int compare(File a, File b) {
				long ta = a.lastModified();
				long tb = b.lastModified();
				return ta < tb ? -1 : (ta > tb ? 1 : 0);
			}
		});
		long before = total;
		int beforeCount = bodies.size();
		int deleted = 0;
		for (int i = 0; i < bodies.size(); i++) {
			if (total <= MAX_TOTAL_BYTES && bodies.size() - deleted <= MAX_ENTRIES) break;
			File victim = bodies.get(i);
			long len = victim.length();
			//noinspection ResultOfMethodCallIgnored
			victim.delete();
			//noinspection ResultOfMethodCallIgnored
			new File(victim.getParentFile(), victim.getName().replace(".bin", ".meta")).delete();
			total -= len;
			deleted++;
		}
		evicted.addAndGet(deleted);
		// 删前/删后/条数/字节全部打出来——「上限生效」要能从 logcat 直接读出来。
		Log.i(TAG, "落盘缓存 淘汰 " + deleted + " 条（触发=" + (overBytes ? "字节" : "条数")
			+ "）字节 " + before + " -> " + total + " / 上限 " + MAX_TOTAL_BYTES
			+ "，条数 " + beforeCount + " -> " + (beforeCount - deleted) + " / 上限 " + MAX_ENTRIES
			+ "，触发于 url=" + whyUrl);
	}

	/**
	 * 刷新 mtime 以维持 LRU。
	 *
	 * <p>⚠️ Android 6.0（API 23）起 {@code File.setLastModified} 被系统**拒绝**
	 * （"Invalid argument"，文件系统不再允许随意写 utime）。本 App minSdk 24，
	 * 即 {@code setLastModified} 一律失败 ⇒ 不能把它当成 LRU 的实现手段。
	 * <b>因此</b>淘汰改用「写入顺序 + {@code lastModified} 升序」的近似：
	 * 新写/被重写的条目 mtime 最新；没被重写过的旧 rev 条目 mtime 最老 ⇒ 仍是最久未用的先走。
	 * 这对本缓存是<b>够的</b>：命中不改字节，所以「命中过但没重写」的条目不会因此变新——
	 * 而那类条目恰恰是<b>当前版本仍在用</b>的。反向风险（旧 rev 僵尸被留得久一点）
	 * 由字节/条数两条硬顶兜住，不会无界。
	 */
	private static void touch(File f) {
		// 刻意不调 setLastModified（见方法注释：API 23+ 必失败）。保留调用点是为了
		// 让「为什么这里没有 touch」在代码里可见，而不是靠记忆。
	}

	// ---------- 内部工具 ----------

	/** 键 = SHA-256(完整 URL 含 query)。绝不用 pathname——见类注释「键」一节。 */
	private static String keyOf(String url) {
		if (url == null || url.isEmpty()) return null;
		try {
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			byte[] d = md.digest(url.getBytes("UTF-8"));
			StringBuilder sb = new StringBuilder(d.length * 2);
			for (byte b : d) sb.append(String.format(Locale.US, "%02x", b));
			return sb.toString();
		} catch (Exception e) {
			return null;
		}
	}

	/** 前 2 位十六进制做一级分桶，避免单个目录堆几百个文件。 */
	private static File subDir(File dir, String key) {
		return new File(dir, key.substring(0, 2));
	}

	private static File bodyFile(File dir, String key) {
		return new File(subDir(dir, key), key + ".bin");
	}

	private static File metaFile(File dir, String key) {
		return new File(subDir(dir, key), key + ".meta");
	}

	private static byte[] readAll(File f, int cap) throws IOException {
		InputStream in = new FileInputStream(f);
		try {
			return readAll(in, cap);
		} finally {
			in.close();
		}
	}

	private static byte[] readAll(InputStream in, int cap) throws IOException {
		ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(64, Math.min(cap, 1 << 20)));
		byte[] chunk = new byte[64 * 1024];
		int n;
		while ((n = in.read(chunk)) > 0) {
			if (bos.size() + n > cap) throw new IOException("落盘缓存 读超出预期长度 cap=" + cap);
			bos.write(chunk, 0, n);
		}
		return bos.toByteArray();
	}

	private static void writeAll(File target, byte[] data) throws IOException {
		FileOutputStream out = new FileOutputStream(target);
		try {
			out.write(data);
			out.flush();
			out.getFD().sync();
		} finally {
			out.close();
		}
	}

	static String fmt(long n) {
		if (n >= 1024L * 1024L) return (n / (1024 * 1024)) + "." + ((n % (1024 * 1024)) / (1024 * 10)) + "MB";
		if (n >= 1024L) return (n / 1024) + "KB";
		return n + "B";
	}
}
