package top.d1studio.dshremote;

import java.util.ArrayList;
import java.util.List;

/** 一个 frpc 挂多台访客：端口稳定、同 VPS 合并、不同 VPS 拆开、单台时 toml 与原来逐字相同。 */
public final class VisitorFleetTest {

	private static int passed = 0;
	private static final List<String> failures = new ArrayList<String>();

	public static void main(String[] args) {
		sameTomlAsSingle();
		twoMachinesOneProcess();
		differentFrpsSplits();
		activeOnlyKeepsOne();
		sameFrpsKeepsSiblings();
		portsStayPut();
		preferredPortGoesToActive();
		duplicateNameGetsSuffix();
		duplicatePortReassigned();
		if (!failures.isEmpty()) {
			for (String failure : failures) System.out.println("FAIL " + failure);
			throw new AssertionError(failures.size() + " failed, " + passed + " passed");
		}
		System.out.println("VisitorFleetTest " + passed + " passed");
	}

	private static void sameTomlAsSingle() {
		ProfileStore.Profile profile = machine("a", "vps.example", "pc-a", 0);
		List<ProfileStore.Profile> profiles = list(profile);
		check(VisitorFleet.assignPorts(profiles, "a", 0), "第一台会分到端口");
		check(profile.bindPort == ProfileStore.BIND_PORT, "第一台拿 18443");
		String fleet = VisitorFleet.build(profiles, "", false).get(0).toml;
		check(fleet.equals(profile.toVisitorConfig().toToml()), "只有一台时，合并 toml 与单访客 toml 逐字相同");
	}

	private static void twoMachinesOneProcess() {
		ProfileStore.Profile first = machine("a", "vps.example", "pc-a", 0);
		ProfileStore.Profile second = machine("b", "vps.example", "pc-b", 0);
		List<ProfileStore.Profile> profiles = list(first, second);
		VisitorFleet.assignPorts(profiles, "a", 0);
		check(first.bindPort != second.bindPort, "两台端口不同");
		check(second.bindPort == ProfileStore.PORT_RANGE_MIN, "第二台从 16225 开始");
		List<VisitorFleet.Group> groups = VisitorFleet.build(profiles, "", false);
		check(groups.size() == 1, "同一台 frps 只有一个进程");
		String toml = groups.get(0).toml;
		int headers = count(toml, "serverAddr = ");
		check(headers == 1, "控制连接头只写一次，实际 " + headers);
		check(toml.contains("bindPort = " + first.bindPort + "\n"), "toml 含第一台端口");
		check(toml.contains("bindPort = " + second.bindPort + "\n"), "toml 含第二台端口");
		check(toml.contains("name = \"pc-a-visitor\"\n"), "第一台访客名不变");
		check(toml.contains("name = \"pc-b-visitor\"\n"), "第二台访客名用自己的隧道名");
	}

	private static void differentFrpsSplits() {
		ProfileStore.Profile first = machine("a", "vps-a.example", "pc-a", 18443);
		ProfileStore.Profile second = machine("b", "vps-b.example", "pc-b", 16225);
		List<VisitorFleet.Group> groups = VisitorFleet.build(list(first, second), "", false);
		check(groups.size() == 2, "不同 frps 拆成两个进程");
		check(!groups.get(0).key.equals(groups.get(1).key), "两组的键不同");
	}

	private static void activeOnlyKeepsOne() {
		ProfileStore.Profile first = machine("a", "vps.example", "pc-a", 18443);
		ProfileStore.Profile second = machine("b", "vps.example", "pc-b", 16225);
		List<VisitorFleet.Group> groups = VisitorFleet.build(list(first, second), "b", false);
		check(groups.size() == 1, "只留当前这台时仍是一个进程");
		String toml = groups.get(0).toml;
		check(toml.contains("bindPort = 16225\n"), "留下的是当前这台的端口");
		check(!toml.contains("bindPort = 18443\n"), "另一台的监听端口不在这份 toml 里");
	}

	private static void sameFrpsKeepsSiblings() {
		ProfileStore.Profile first = machine("a", "vps.example", "pc-a", 18443);
		ProfileStore.Profile second = machine("b", "vps.example", "pc-b", 16225);
		ProfileStore.Profile other = machine("c", "other.example", "pc-c", 16226);
		List<VisitorFleet.Group> groups = VisitorFleet.buildSameFrps(list(first, second, other), "a", false);
		check(groups.size() == 1, "同一台中转合成一个进程");
		check(groups.get(0).toml.contains("pc-a") && groups.get(0).toml.contains("pc-b"), "同中转的两台都挂上");
		check(!groups.get(0).toml.contains("pc-c"), "另一台中转不挂");
		List<VisitorFleet.Group> alone = VisitorFleet.buildSameFrps(list(first, second, other), "c", false);
		check(alone.size() == 1 && alone.get(0).toml.contains("pc-c") && !alone.get(0).toml.contains("pc-a"),
			"当前在另一台中转上时，只挂那一台");
		check(VisitorFleet.buildSameFrps(list(first, second), "", false).isEmpty(), "没有当前服务器时不挂");
	}

	private static void portsStayPut() {
		ProfileStore.Profile first = machine("a", "vps.example", "pc-a", 16230);
		ProfileStore.Profile second = machine("b", "vps.example", "pc-b", 16231);
		List<ProfileStore.Profile> profiles = list(first, second);
		check(!VisitorFleet.assignPorts(profiles, "a", 18443), "已经记下的端口不再改");
		check(first.bindPort == 16230 && second.bindPort == 16231, "两次分配结果相同");
	}

	private static void preferredPortGoesToActive() {
		ProfileStore.Profile active = machine("a", "vps.example", "pc-a", 0);
		ProfileStore.Profile other = machine("b", "vps.example", "pc-b", 0);
		VisitorFleet.assignPorts(list(active, other), "a", 16228);
		check(active.bindPort == 16228, "当前这台沿用上次绑上的端口");
		check(other.bindPort == ProfileStore.BIND_PORT, "另一台再拿首选端口");
	}

	private static void duplicateNameGetsSuffix() {
		ProfileStore.Profile first = machine("abc12345", "vps.example", "dsh-remote", 18443);
		ProfileStore.Profile second = machine("def67890", "vps.example", "dsh-remote", 16225);
		String toml = VisitorFleet.build(list(first, second), "", false).get(0).toml;
		check(toml.contains("name = \"dsh-remote-visitor\"\n"), "第一台保持原访客名");
		check(toml.contains("name = \"dsh-remote-visitor-def67890\"\n"), "撞名的第二台只改本地访客名");
		check(count(toml, "serverName = \"dsh-remote\"\n") == 2, "远端代理名两台都保持原样");
	}

	private static void duplicatePortReassigned() {
		ProfileStore.Profile first = machine("a", "vps.example", "pc-a", 18443);
		ProfileStore.Profile second = machine("b", "vps.example", "pc-b", 18443);
		check(VisitorFleet.assignPorts(list(first, second), "a", 0), "撞端口要改掉一台");
		check(first.bindPort == 18443, "先出现的那台留在 18443");
		check(second.bindPort == ProfileStore.PORT_RANGE_MIN, "撞车的那台顺延");
	}

	private static ProfileStore.Profile machine(String id, String host, String tunnel, int port) {
		ProfileStore.Profile profile = new ProfileStore.Profile();
		profile.id = id;
		profile.serverAddr = host;
		profile.serverPort = 7000;
		profile.authToken = "token";
		profile.secretKey = "secret";
		profile.mode = "xtcp";
		profile.strategy = VisitorConfig.STRATEGY_P2P;
		profile.tunnelName = tunnel;
		profile.bindPort = port;
		return profile;
	}

	private static List<ProfileStore.Profile> list(ProfileStore.Profile... profiles) {
		List<ProfileStore.Profile> out = new ArrayList<ProfileStore.Profile>();
		for (ProfileStore.Profile profile : profiles) out.add(profile);
		return out;
	}

	private static int count(String text, String piece) {
		int n = 0;
		int at = 0;
		while (true) {
			int found = text.indexOf(piece, at);
			if (found < 0) return n;
			n += 1;
			at = found + piece.length();
		}
	}

	private static void check(boolean ok, String message) {
		if (ok) passed += 1;
		else failures.add(message);
	}
}
