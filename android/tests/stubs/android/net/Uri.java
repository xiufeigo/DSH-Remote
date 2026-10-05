package android.net;

/**
 * JVM 测试替身：`android.net.Uri`。
 *
 * <p>为什么需要：`MainActivity.isActiveGatewayUri()` / `effectivePort()` 是**纯字符串判定**
 * （scheme / host / port 三个字段），但它签名上吃 `android.net.Uri`。android.jar 里的实现
 * 全是 `throw new RuntimeException("Stub!")`，没法在 JVM 上真跑；而"只对源码做字符串断言"
 * 又钉不住行为（T40 §8 M1/M2：删掉关键一行照样全绿）。
 *
 * <p>于是按既有做法（`stubs/android/text/TextUtils.java` 同一套路）做一个**只实现被测
 * 判据用到的那几个访问器**的替身，与生产方法体一起 javac 真编译真跑。
 *
 * <p>⚠️ 与 Android 真实实现的两处刻意对齐（否则这臂就成了"模型不是被测对象"）：
 * <ol>
 *   <li>{@code getScheme()} **不做大小写归一**（Android 的 {@code StringUri} 原样返回解析到
 *       的子串；`MainActivity` 里那几处比较也一直是小写字面量，改前改后都一样）；</li>
 *   <li>{@code getPort()} 在没写端口时返回 <b>-1</b>（这是 `effectivePort()` 的判据来源）。</li>
 * </ol>
 * 只支持本臂用到的形态：`scheme://host[:port][/path][?query]`；其余输入按"解析失败"处理
 * （{@code parse} 抛异常），因为被测方法体本来就用 try/catch 兜住解析异常。
 */
public final class Uri {

	private final String scheme;
	private final String host;
	private final int port;

	private Uri(String scheme, String host, int port) {
		this.scheme = scheme;
		this.host = host;
		this.port = port;
	}

	/** `scheme://host[:port][/path…]`；非层级形态（如 `data:…`）按 Android 语义给 host=null。 */
	public static Uri parse(String s) {
		if (s == null) throw new IllegalArgumentException("null uri");
		int sep = s.indexOf("://");
		if (sep <= 0) {
			// 与 Android 对齐：`data:text/plain,hi` 能解析出 scheme，但 host 为 null
			// （`AbstractHierarchicalUri.getHost()` ⇒ null）。被测方法体靠 host 相等判定
			// 自然返回 false —— 这里若抛异常，测的就变成"替身实现"而不是被测判据了。
			int colon = s.indexOf(':');
			if (colon <= 0) throw new IllegalArgumentException("no scheme: " + s);
			return new Uri(s.substring(0, colon), null, -1);
		}
		String scheme = s.substring(0, sep);
		String rest = s.substring(sep + 3);
		int cut = rest.length();
		for (int i = 0; i < rest.length(); i++) {
			char c = rest.charAt(i);
			if (c == '/' || c == '?' || c == '#') { cut = i; break; }
		}
		String authority = rest.substring(0, cut);
		String host = authority;
		int port = -1;
		int colon = authority.lastIndexOf(':');
		if (colon >= 0) {
			host = authority.substring(0, colon);
			String p = authority.substring(colon + 1);
			port = p.isEmpty() ? -1 : Integer.parseInt(p);
		}
		if (host.isEmpty()) host = null;
		return new Uri(scheme, host, port);
	}

	public String getScheme() {
		return scheme;
	}

	public String getHost() {
		return host;
	}

	public int getPort() {
		return port;
	}

	/** 只给 arm 的失败信息用，不参与判据。 */
	public String getPath() {
		return "";
	}

	@Override
	public String toString() {
		return scheme + "://" + host + (port < 0 ? "" : ":" + port);
	}
}
