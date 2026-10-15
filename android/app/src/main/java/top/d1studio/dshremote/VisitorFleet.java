package top.d1studio.dshremote;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 一个 frpc 进程挂同一台 frps 上的全部访客，每台电脑一个固定本地端口。
 * VPS 地址、控制端口或登录密钥不同时拆成各自的进程：frpc 的控制连接只能有一条。
 */
public final class VisitorFleet {

	/** 18443 之后的顺延上界（含）。16225–16235 仍在这段里。 */
	public static final int PORT_MAX = 16324;

	public static final class Group {
		public final String key;
		public final String toml;
		/** 这组里只要还有打洞访客，诊断就按打洞优先记。 */
		public final String strategy;
		public final String fileName;

		Group(String key, String toml, String strategy) {
			this.key = key;
			this.toml = toml;
			this.strategy = strategy;
			this.fileName = "frpc-fleet-" + Integer.toHexString(key.hashCode()) + ".toml";
		}
	}

	private VisitorFleet() {}

	public static boolean legalPort(int port) {
		return port == ProfileStore.BIND_PORT
			|| (port >= ProfileStore.PORT_RANGE_MIN && port <= PORT_MAX);
	}

	/**
	 * 给还没有端口的配置组分配固定端口。已经记下的合法端口保持不动，
	 * 这样正在打开的 127.0.0.1 不会在下次启动时被换掉。
	 *
	 * @param preferredPort 当前这台如果还没端口，优先沿用这个（上次实际绑上的端口）
	 * @return 有没有把新端口写进某个配置组
	 */
	public static boolean assignPorts(List<ProfileStore.Profile> profiles, String activeId, int preferredPort) {
		boolean changed = false;
		List<Integer> used = new ArrayList<>();
		for (ProfileStore.Profile profile : profiles) {
			if (!eligible(profile)) continue;
			// 已记下的合法端口不再用 isBindable 复查：本进程的 frpc 正占着它，
			// 复查会把正在用的端口判成占用并换端口。端口死活交给连接前的 health 探针。
			if (legalPort(profile.bindPort) && !used.contains(profile.bindPort)) {
				used.add(profile.bindPort);
			} else if (profile.bindPort != 0) {
				profile.bindPort = 0;
				changed = true;
			}
		}
		ProfileStore.Profile active = find(profiles, activeId);
		if (active != null && eligible(active) && active.bindPort == 0) {
			int port = pick(used, preferredPort);
			if (port > 0) {
				active.bindPort = port;
				used.add(port);
				changed = true;
			}
		}
		for (ProfileStore.Profile profile : profiles) {
			if (!eligible(profile) || profile.bindPort != 0) continue;
			int port = pick(used, 0);
			if (port < 0) continue;
			profile.bindPort = port;
			used.add(port);
			changed = true;
		}
		return changed;
	}

	/**
	 * @param onlyProfileId 非空时只渲染这一台（退后台收掉其余访客）。空串表示同一 frps 上全部挂上。
	 * @param stickyRelay    连续打洞失败后，本来要打洞的访客这次直接写成中转
	 */
	public static List<Group> build(List<ProfileStore.Profile> profiles, String onlyProfileId, boolean stickyRelay) {
		Map<String, List<ProfileStore.Profile>> byFrps = new LinkedHashMap<>();
		for (ProfileStore.Profile profile : profiles) {
			if (!eligible(profile) || profile.bindPort <= 0) continue;
			if (onlyProfileId != null && onlyProfileId.length() > 0 && !onlyProfileId.equals(profile.id)) continue;
			String key = frpsKey(profile);
			List<ProfileStore.Profile> members = byFrps.get(key);
			if (members == null) {
				members = new ArrayList<>();
				byFrps.put(key, members);
			}
			members.add(profile);
		}
		List<Group> groups = new ArrayList<>();
		for (Map.Entry<String, List<ProfileStore.Profile>> entry : byFrps.entrySet()) {
			groups.add(render(entry.getKey(), entry.getValue(), stickyRelay));
		}
		return groups;
	}

	/**
	 * 只挂当前这台，以及和它同一台 frps（地址、控制端口、登录密钥都相同）的其他服务器。
	 * 当前这台不在列表里时返回空，不把别的中转也拉起来。
	 */
	public static List<Group> buildSameFrps(List<ProfileStore.Profile> profiles, String activeId, boolean stickyRelay) {
		ProfileStore.Profile active = find(profiles, activeId);
		if (active == null || !eligible(active)) return new ArrayList<>();
		String key = frpsKey(active);
		List<ProfileStore.Profile> members = new ArrayList<>();
		for (ProfileStore.Profile profile : profiles) {
			if (eligible(profile) && key.equals(frpsKey(profile))) members.add(profile);
		}
		return build(members, "", stickyRelay);
	}

	private static Group render(String key, List<ProfileStore.Profile> members, boolean stickyRelay) {
		Map<String, Integer> nameCount = new LinkedHashMap<>();
		List<VisitorConfig> configs = new ArrayList<>();
		for (ProfileStore.Profile profile : members) {
			VisitorConfig cfg = profile.toVisitorConfig();
			cfg.bindPort = profile.bindPort;
			if (stickyRelay && VisitorConfig.STRATEGY_P2P.equals(cfg.effectiveStrategy())) {
				cfg.strategy = VisitorConfig.STRATEGY_RELAY;
			}
			configs.add(cfg);
			String name = cfg.serverName;
			Integer seen = nameCount.get(name);
			nameCount.put(name, seen == null ? 1 : seen + 1);
		}
		StringBuilder toml = new StringBuilder();
		configs.get(0).appendHeader(toml);
		Map<String, Integer> emitted = new LinkedHashMap<>();
		boolean anyHole = false;
		for (int i = 0; i < members.size(); i++) {
			VisitorConfig cfg = configs.get(i);
			if (VisitorConfig.STRATEGY_P2P.equals(cfg.effectiveStrategy())) anyHole = true;
			int ordinal = emitted.containsKey(cfg.serverName) ? emitted.get(cfg.serverName) + 1 : 1;
			emitted.put(cfg.serverName, ordinal);
			Integer total = nameCount.get(cfg.serverName);
			String suffix = (total != null && total > 1 && ordinal > 1)
				? nameSuffix(members.get(i).id) : "";
			cfg.appendVisitors(toml, suffix);
		}
		String strategy = anyHole ? VisitorConfig.STRATEGY_P2P : VisitorConfig.STRATEGY_RELAY;
		return new Group(key, toml.toString(), strategy);
	}

	static String frpsKey(ProfileStore.Profile profile) {
		return profile.serverAddr.trim().toLowerCase(Locale.ROOT)
			+ "\n" + profile.serverPort + "\n" + profile.authToken;
	}

	private static String nameSuffix(String profileId) {
		StringBuilder suffix = new StringBuilder("-");
		String id = profileId == null ? "" : profileId;
		for (int i = 0; i < id.length() && suffix.length() < 9; i++) {
			char c = id.charAt(i);
			boolean word = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
			if (word) suffix.append(c);
		}
		if (suffix.length() == 1) suffix.append('x');
		return suffix.toString();
	}

	/**
	 * 只给还没有端口的配置组挑新口，并且要 {@link ProfileStore#isBindable}。
	 * 已经记下的合法端口不走这里，也不在 {@link #assignPorts} 里探测；
	 * 那个口可能正被本进程的 frpc 占着，死活交给连接前的 health 探针。
	 */
	private static int pick(List<Integer> used, int preferred) {
		if (legalPort(preferred) && !used.contains(preferred) && ProfileStore.isBindable(preferred)) return preferred;
		if (!used.contains(ProfileStore.BIND_PORT) && ProfileStore.isBindable(ProfileStore.BIND_PORT)) {
			return ProfileStore.BIND_PORT;
		}
		for (int port = ProfileStore.PORT_RANGE_MIN; port <= PORT_MAX; port++) {
			if (!used.contains(port) && ProfileStore.isBindable(port)) return port;
		}
		return -1;
	}

	private static boolean eligible(ProfileStore.Profile profile) {
		return profile != null && profile.isValid() && !ProfileStore.tunnelUnavailable(profile);
	}

	private static ProfileStore.Profile find(List<ProfileStore.Profile> profiles, String id) {
		if (id == null || id.length() == 0) return null;
		for (ProfileStore.Profile profile : profiles) {
			if (id.equals(profile.id)) return profile;
		}
		return null;
	}
}
