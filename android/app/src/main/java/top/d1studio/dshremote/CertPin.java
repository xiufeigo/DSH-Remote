package top.d1studio.dshremote;

import java.util.Locale;

/**
 * 自签证书指纹的【键派生 + 比对判定】纯函数集合。刻意不依赖任何 Android API
 * （连 TextUtils 都不用），因此可以在 JVM 上直接单测（android/tests/CertPinTest.java）。
 *
 * 缺陷背景（T23-A，用户真机实测）：隧道模式下一律连本机回环地址
 * https://127.0.0.1:&lt;端口&gt;，端口首选 18443、被占用时在 16225~16235 里协商。
 * 两个配置档背后是**两台不同的电脑**（两张不同的自签证书），却共用同一个回环端口。
 * 旧实现只按 host:port 存指纹 ⇒ 两个配置档抢同一个键 ⇒ 切档即误报
 * 「证书已变更！」+ 中间人警告（假警报），点「仍要更新信任」还会互相覆盖，
 * 切回另一台再报一次。
 *
 * 修法：指纹同时按【配置档身份】存（cert_prof_&lt;profileId&gt;）。判定分两支：
 * ①**有配置档身份** ⇒ 判据**只**来自该配置档自己的键；该键不存在 ⇒ 走 TOFU
 * 「信任此服务器？」，**绝不**回退地址键。
 * ②**没有配置档身份**（直连 / 局域网节点）⇒ 只认地址键 cert_fp_&lt;host&gt;:&lt;port&gt;
 * （URL 未写端口时另查字面端口的旧键），两处都没有才走 TOFU。
 * 用户点信任时写入的键与判定命中的键同源：有配置档身份就只写配置档键。
 *
 * T27-A（独立对抗复核抓出的反例）：早期版本在 ①里「没有自己的键就回退地址键」。
 * 地址键会被**别的配置档**预置或信任时写入，于是「A 档带指纹、B 档不带」时，
 * B 首次连接读到的是 A 的指纹 → 判 CHANGED → 弹假「证书已变更！」+ 中间人警告。
 * 一句话：**「首次见到某配置档」不等于「地址键为空」**，所以两个信任语境
 * （配置档 / 直连地址）必须彻底分开，互不回退。
 *
 * 兼容性（刻意接受）：升级安装后，存量地址键对**配置档连接**一律被忽略 ⇒
 * 每个配置档**首次**连接会多一次 TOFU（它确实还没有「上次记录」），信任后即按档锁定。
 * 已经写过 cert_prof_ 的配置档不受影响（仍直接放行）。安全判据不因此弱化。
 *
 * 安全性不降：同一配置档内证书真变了仍判 CHANGED（强提示中间人风险）；
 * 直连/局域网节点没有配置档身份，地址键变更同样判 CHANGED；
 * 共享地址键无法掩盖已锁档的变更（配置档连接根本不读它）。
 * 被修掉的只是「两个配置档共用回环端口」造成的假警报。
 */
public final class CertPin {

	/** 配置档维度的锁定键前缀。 */
	public static final String PROFILE_PREFIX = "cert_prof_";
	/** 地址维度的锁定键前缀（存量安装 + 直连/局域网节点）。 */
	public static final String HOST_PREFIX = "cert_fp_";

	/** 判定结果。 */
	public enum Action {
		/** 有记录且一致 → 直接放行。 */
		TRUSTED,
		/** 有记录但不一致 → 必须弹「证书已变更！」并强提示中间人风险。 */
		CHANGED,
		/** 两处都没有记录 → 走 TOFU「信任此服务器？」。 */
		TOFU
	}

	/** 记录命中来源（只用于日志与单测断言，不参与放行判定）。 */
	public enum Source {
		PROFILE, HOST, HOST_LEGACY, NONE
	}

	/** 取指纹的最小接口：生产传 SharedPreferences，测试传 Map 适配器。 */
	public interface Store {
		String get(String key);
	}

	/** 一次判定的全部结论。 */
	public static final class Decision {
		public final Action action;
		/** 命中的已记录指纹（无则空串）。 */
		public final String stored;
		public final Source source;
		/** 展示用 host:port。 */
		public final String label;
		/** 用户点信任后应写入的键（已含前缀）。 */
		public final String key;

		Decision(Action action, String stored, Source source, String label, String key) {
			this.action = action;
			this.stored = stored;
			this.source = source;
			this.label = label;
			this.key = key;
		}

		public boolean changed() {
			return action == Action.CHANGED;
		}

		/** 单行摘要（写进 dshr-perf 日志，便于事后核对判定走了哪条分支）。 */
		public String describe() {
			return "action=" + action + " source=" + source + " key=" + key
				+ " label=" + label + (stored.isEmpty() ? "" : " storedFp=" + abbreviate(stored));
		}
	}

	private CertPin() {
	}

	/** 配置档身份键；profileId 为空返回空串（表示「本次连接不按配置档锁定」）。 */
	public static String profileKey(String profileId) {
		String id = nz(profileId);
		return id.isEmpty() ? "" : PROFILE_PREFIX + id;
	}

	/** 地址键（不含前缀拼接，调用方自己拼 HOST_PREFIX / 返回 key 已含前缀）。 */
	public static String hostKey(String host, int port) {
		return hostLabel(host, port);
	}

	/** 展示与拼接用的 host:port（host 小写：DNS 大小写不敏感，避免同一节点两把键）。 */
	public static String hostLabel(String host, int port) {
		return nz(host).toLowerCase(Locale.US) + ":" + port;
	}

	/**
	 * 核心判定。
	 *
	 * @param profileId 本次连接的配置档 id；直连/局域网节点传空串
	 * @param host      目标主机
	 * @param effectivePort 有效端口（URL 未写端口时为 443/80）
	 * @param rawPort   URL 里字面写的端口，-1 表示未写；仅用于回退查老键
	 * @param actualFp  本次实际拿到的 SHA-256 指纹（小写无冒号）
	 */
	public static Decision verify(Store store, String profileId, String host,
			int effectivePort, int rawPort, String actualFp) {
		Store s = store == null ? NO_STORE : store;
		String label = hostLabel(host, effectivePort);
		String profileKey = profileKey(profileId);
		String hostPrefixed = HOST_PREFIX + label;
		// 写回键与判定同源：有配置档身份就只写配置档键。
		String writeKey = !profileKey.isEmpty() ? profileKey : hostPrefixed;

		// ① 配置档连接：判据只来自该配置档自己的键，绝不回退地址键（T27-A）。
		if (!profileKey.isEmpty()) {
			String own = nz(s.get(profileKey));
			if (own.isEmpty()) {
				// 该档没有自己的锁 = 从未信任过这台服务器 ⇒ 诚实的结论是 TOFU。
				// 回退地址键会读到别的配置档（或直连语境）写下的指纹，
				// 把「首次见到」变成假的 CHANGED + 中间人警告。
				return new Decision(Action.TOFU, "", Source.NONE, label, writeKey);
			}
			Action action = own.equalsIgnoreCase(nz(actualFp)) ? Action.TRUSTED : Action.CHANGED;
			return new Decision(action, own, Source.PROFILE, label, writeKey);
		}

		// ② 非配置档连接（直连 / 局域网节点）：只认地址键。
		String stored = nz(s.get(hostPrefixed));
		Source source = stored.isEmpty() ? Source.NONE : Source.HOST;
		if (source == Source.NONE && rawPort >= 0 && rawPort != effectivePort) {
			String legacy = nz(s.get(HOST_PREFIX + hostLabel(host, rawPort)));
			if (!legacy.isEmpty()) {
				stored = legacy;
				source = Source.HOST_LEGACY;
			}
		}
		if (source == Source.NONE) return new Decision(Action.TOFU, "", Source.NONE, label, writeKey);
		Action action = stored.equalsIgnoreCase(nz(actualFp)) ? Action.TRUSTED : Action.CHANGED;
		return new Decision(action, stored, source, label, writeKey);
	}

	/**
	 * 预置（扫码导入 / 首连前）该写哪些键。
	 * 有配置档身份 ⇒ **只**写配置档键。理由：判定侧已不再回退地址键，写它对本档
	 * 毫无用处；而地址键的读者是**另一个信任语境**（同一 host:port 上的直连/局域网
	 * 节点），预置时写进去等于把这份信任白送出去。没有配置档身份 ⇒ 写地址键。
	 */
	public static String[] seedKeys(String profileId, String host, int port) {
		String profileKey = profileKey(profileId);
		if (profileKey.isEmpty()) return new String[] {HOST_PREFIX + hostLabel(host, port)};
		return new String[] {profileKey};
	}

	/** 规范化指纹：去冒号/空白，只留 hex 字符并转小写；非 64 位返回空串。 */
	public static String normalizeFingerprint(String fp) {
		if (fp == null) return "";
		StringBuilder sb = new StringBuilder(64);
		String lower = fp.toLowerCase(Locale.US);
		for (int i = 0; i < lower.length(); i++) {
			char c = lower.charAt(i);
			boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
			if (hex) sb.append(c);
		}
		return sb.length() == 64 ? sb.toString() : "";
	}

	private static final Store NO_STORE = new Store() {
		@Override
		public String get(String key) {
			return null;
		}
	};

	private static String nz(String s) {
		return s == null ? "" : s.trim();
	}

	private static String abbreviate(String fp) {
		return fp.length() <= 12 ? fp : fp.substring(0, 12) + "…";
	}
}
