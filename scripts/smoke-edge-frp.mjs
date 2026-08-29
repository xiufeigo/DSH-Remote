/**
 * edge 全链路冒烟（需要本机 frp 二进制；缺失时整体跳过）。
 *
 * 拓扑（单机模拟 VPS + 家里 PC）：
 *   假上游 DSH(http) ← PC 网关(role=desktop, 托管 frpc/stcp 注册)
 *       → 本机 frps(edge 网关托管) ← edge 内部 visitor ← 浏览器请求(Token 登录)
 *
 * 运行：pnpm smoke:edge:frp
 */

import assert from "node:assert/strict";
import { access, constants, copyFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
// PLG-03：公共夹具收敛到 scripts/test-harness.mjs。
import { startFakeUpstream, requestTls, waitFor, makeTempHome } from "./test-harness.mjs";

const VENDOR_SRC = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh-remote", "vendor", "frp");

async function haveBinaries() {
	for (const name of ["frpc.exe", "frps.exe", "frpc", "frps"]) {
		try {
			await access(join(VENDOR_SRC, name), constants.X_OK);
			return true;
		} catch {
			// 继续找
		}
	}
	return false;
}

if (!(await haveBinaries())) {
	console.log("smoke-edge-frp：未找到本机 frp 二进制（~/.dsh-remote/vendor/frp），跳过全链路测试");
	process.exit(0);
}

const fixture = {
	edgeHome: "",
	pcHome: "",
	fakeDsh: /** @type {import("node:http").Server | undefined} */ (undefined),
	fakeDshPort: 0,
	closeFakeDsh: /** @type {(() => Promise<void>) | undefined} */ (undefined),
	controlPort: 31700 + Math.floor(Math.random() * 3000),
	gateway: undefined,
	pcGateway: undefined,
	gatewayPort: 0,
	cookie: "",
};

const AUTH_TOKEN = `tok-${Math.random().toString(36).slice(2, 12)}`;
const VISITOR_KEY = `vis-${Math.random().toString(36).slice(2, 12)}`;
const TUNNEL_NAME = "dsh-edge-smoke";

async function writeSecrets(home) {
	await mkdir(join(home, "state"), { recursive: true });
	await writeFile(
		join(home, "state", "secrets.json"),
		`${JSON.stringify({ frpAuthToken: AUTH_TOKEN, frpVisitorKey: VISITOR_KEY }, null, "\t")}\n`,
		"utf8",
	);
}

function call(pathname, options = {}) {
	return requestTls(`https://127.0.0.1:${String(fixture.gatewayPort)}${pathname}`, options);
}

// ---------- 搭建 ----------

fixture.edgeHome = await makeTempHome("dshr-chain-edge-");
fixture.pcHome = await makeTempHome("dshr-chain-pc-");
await writeSecrets(fixture.edgeHome);
await writeSecrets(fixture.pcHome);

// 复制二进制到 edge home 的约定位置
await mkdir(join(fixture.edgeHome, "vendor", "frp"), { recursive: true });
for (const name of ["frpc.exe", "frps.exe", "frpc", "frps"]) {
	try {
		await access(join(VENDOR_SRC, name), constants.X_OK);
		await copyFile(join(VENDOR_SRC, name), join(fixture.edgeHome, "vendor", "frp", name));
	} catch {
		// 该名字不存在则跳过
	}
}

// 假上游 DSH Web GUI（模拟 PC 上跑着的 DSH）
{
	const upstream = await startFakeUpstream({
		page: "<!doctype html><html><head><title>chain dsh</title></head><body>__dsh_boot__ chain</body></html>",
	});
	fixture.fakeDsh = upstream.server;
	fixture.fakeDshPort = upstream.port;
	fixture.closeFakeDsh = upstream.close;
}

const [{ Store }, { DEFAULT_CONFIG }, { GatewayServer }] = await Promise.all([
	import("../packages/gateway/src/store.ts"),
	import("../packages/gateway/src/config.ts"),
	import("../packages/gateway/src/server.ts"),
]);

// edge 网关（模拟服务器容器）：自带 frps + 内部 visitor 回环消费
fixture.gateway = new GatewayServer({
	store: await Store.open(fixture.edgeHome),
	config: {
		...structuredClone(DEFAULT_CONFIG),
		role: "edge",
		listenHost: "127.0.0.1",
		listenPort: 0,
		upstreamPort: fixture.fakeDshPort,
		mobile: { enabled: true, breakpointPx: 900 },
		frp: {
			...DEFAULT_CONFIG.frp,
			enabled: false,
			edge: "frps",
			serverPort: fixture.controlPort,
			name: TUNNEL_NAME,
			visitorBindPort: 28440 + Math.floor(Math.random() * 500),
			authToken: AUTH_TOKEN,
		},
	},
	env: { DSHR_ACCESS_TOKEN: AUTH_TOKEN },
	log: (line) => console.log(`[edge] ${line}`),
});
await fixture.gateway.start();
fixture.gatewayPort = fixture.gateway.actualPort;

// PC 网关（模拟家里电脑）：desktop 角色，托管 frpc 以 stcp 形态注册进 edge 的 frps
fixture.pcGateway = new GatewayServer({
	store: await Store.open(fixture.pcHome),
	config: {
		...structuredClone(DEFAULT_CONFIG),
		listenHost: "127.0.0.1",
		listenPort: 0,
		upstreamPort: fixture.fakeDshPort,
		autoFixUpstreamPort: false,
		frp: {
			...DEFAULT_CONFIG.frp,
			enabled: true,
			serverAddr: "127.0.0.1",
			serverPort: fixture.controlPort,
			mode: "stcp",
			name: TUNNEL_NAME,
			binaryPath: join(VENDOR_SRC, process.platform === "win32" ? "frpc.exe" : "frpc"),
		},
	},
	log: (line) => console.log(`[pc] ${line}`),
});
await fixture.pcGateway.start();

try {
	// ---------- 断言 ----------

	await waitFor("edge health", async () => (await call("/__dsh_remote__/health")).status === 200);

	// 等隧道打通：visitor 绑定口出现监听后，经整条链路拿 health 已在上方；
	// 这里验证登录 + 经隧道的反代。
	let loginRes;
	await waitFor("登录页可达", async () => {
		loginRes = await call("/__dsh_remote__/login");
		return loginRes.status === 200;
	});
	assert.match(loginRes.body, /访问 Token/);

	const submit = await call("/__dsh_remote__/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: AUTH_TOKEN, name: "链路测试机" }),
	});
	assert.equal(submit.status, 200, `Token 登录应成功：${submit.body}`);
	fixture.cookie = `dr_device=${/dr_device=([^;]+)/.exec(submit.setCookie)?.[1]}`;

	// 等隧道真正打通（frpc 注册 + visitor 就绪需要数秒），期间 502 属预期
	let proxied;
	await waitFor("经隧道的反代可达", async () => {
		proxied = await call("/", { headers: { accept: "text/html", cookie: fixture.cookie } });
		return proxied.status === 200;
	});
	console.log("--- 实际响应体 ---");
	console.log(proxied.body);
	assert.match(proxied.body, /__dsh_boot__ chain/, "上游正文应原样返回（跨 frps 隧道）");
	assert.match(proxied.body, /manifest\.webmanifest/, "PWA 标记应注入");
	assert.match(proxied.body, /<script src="\/__dsh_remote__\/mobile\.js" defer><\/script>/, "移动 hook 标记应注入");

	const mobileJs = await call("/__dsh_remote__/mobile.js", { headers: { cookie: fixture.cookie } });
	assert.equal(mobileJs.status, 200);

	console.log("\nedge 全链路（frps + 内部 visitor + PC stcp 注册 + Token 门禁 + 注入）✅");

	await fixture.gateway.stop();
	await fixture.pcGateway.stop();
	await fixture.closeFakeDsh?.();
	await rm(fixture.edgeHome, { recursive: true, force: true });
	await rm(fixture.pcHome, { recursive: true, force: true });
	process.exit(0);
} catch (error) {
	console.error(String(error));
	try {
		await fixture.gateway?.stop();
		await fixture.pcGateway?.stop();
		await fixture.closeFakeDsh?.();
		await rm(fixture.edgeHome, { recursive: true, force: true });
		await rm(fixture.pcHome, { recursive: true, force: true });
	} catch {
		// 尽力清理
	}
	process.exit(1);
}
