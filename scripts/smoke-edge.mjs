/**
 * edge 角色冒烟测试（前置 Token 门禁 / 移动 hook 注入 / frps 配置生成）。
 *
 * 运行：pnpm smoke:edge（node --test scripts/smoke-edge.mjs）
 * 不依赖真实 frp 二进制：visitor/frps 进程链路由 scripts/probe-ws.mjs + 本地全链路自测覆盖。
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test, before, after } from "node:test";
// PLG-03：公共夹具收敛到 scripts/test-harness.mjs（本文件不再复刻请求/WS/假上游实现）。
import { startFakeUpstream, requestTls, wsConnect, makeTempHome } from "./test-harness.mjs";

// ---------- 测试夹具 ----------

const ACCESS_TOKEN = "edge-test-token-123";

const fixture = {
	homeDir: "",
	lockHomeDir: "",
	upstream: /** @type {import("node:http").Server | undefined} */ (undefined),
	upstreamPort: 0,
	closeUpstream: /** @type {(() => Promise<void>) | undefined} */ (undefined),
	gateway: undefined,
	gatewayPort: 0,
	lockGateway: undefined,
	lockPort: 0,
	deviceCookie: "",
	seenByUpstream: /** @type {Record<string, string | undefined>} */ ({}),
};

/** 自签证书场景的网关请求：双实例（gateway/lockGateway）显式传 port，底层走 harness requestTls。 */
function callGateway(port, pathname, options = {}) {
	return requestTls(`https://127.0.0.1:${String(port)}${pathname}`, options);
}

/** 原始 TLS 升级握手，返回服务端先回的响应头文本（验证 401 拒绝）。harness wsConnect 适配。 */
async function rawUpgrade(port, pathname, extraHeaders = "") {
	const ws = wsConnect(`wss://127.0.0.1:${String(port)}${pathname}`, {
		headers: extraHeaders.replace(/(?:\r?\n)+$/, ""), // 归一化尾随换行，避免提前终止头块
		timeoutMs: 2500,
	});
	const text = await ws.headersText;
	ws.close();
	return text;
}

before(async () => {
	fixture.homeDir = await makeTempHome("dsh-remote-edge-");
	fixture.lockHomeDir = await makeTempHome("dsh-remote-edge-lock-");
	process.env.DSH_REMOTE_HOME = fixture.homeDir;

	const upstream = await startFakeUpstream({ seen: fixture.seenByUpstream });
	fixture.upstream = upstream.server;
	fixture.upstreamPort = upstream.port;
	fixture.closeUpstream = upstream.close;

	const [{ Store }, { DEFAULT_CONFIG }, { GatewayServer }] = await Promise.all([
		import("../packages/gateway/src/store.ts"),
		import("../packages/gateway/src/config.ts"),
		import("../packages/gateway/src/server.ts"),
	]);

	const baseConfig = {
		...DEFAULT_CONFIG,
		role: "edge",
		upstreamPort: fixture.upstreamPort,
		listenHost: "127.0.0.1",
		listenPort: 0, // OS 分配
		mobile: { enabled: true, breakpointPx: 900 },
	};

	fixture.gateway = new GatewayServer({
		store: await Store.open(fixture.homeDir),
		config: structuredClone(baseConfig),
		env: { DSHR_ACCESS_TOKEN: ACCESS_TOKEN },
		log: () => {},
	});
	await fixture.gateway.start();
	fixture.gatewayPort = fixture.gateway.actualPort;

	fixture.lockGateway = new GatewayServer({
		store: await Store.open(fixture.lockHomeDir),
		config: { ...structuredClone(baseConfig), pairingFailLockThreshold: 2 },
		env: { DSHR_ACCESS_TOKEN: ACCESS_TOKEN },
		log: () => {},
	});
	await fixture.lockGateway.start();
	fixture.lockPort = fixture.lockGateway.actualPort;
});

after(async () => {
	await fixture.gateway?.stop();
	await fixture.lockGateway?.stop();
	await fixture.closeUpstream?.();
	await rm(fixture.homeDir, { recursive: true, force: true });
	await rm(fixture.lockHomeDir, { recursive: true, force: true });
});

// ---------- 1. 门禁与登录 ----------

test("health 探针无需认证", async () => {
	const r = await callGateway(fixture.gatewayPort, "/__dsh_remote__/health");
	assert.equal(r.status, 200);
	assert.equal(JSON.parse(r.body).ok, true);
});

test("未认证 HTML 导航重定向到 Token 登录页（而非配对页）", async () => {
	const r = await callGateway(fixture.gatewayPort, "/", { headers: { accept: "text/html,application/xhtml+xml" } });
	assert.equal(r.status, 302);
	assert.match(r.headers.location ?? "", /^\/__dsh_remote__\/login\?next=%2F$/);
});

test("未认证 API/XHR 返回 401 JSON", async () => {
	const r = await callGateway(fixture.gatewayPort, "/api/session/list", { headers: { accept: "application/json" } });
	assert.equal(r.status, 401);
	assert.match(r.body, /unpaired-device/);
});

test("登录页可渲染：Token 输入框 + 设备名 + 无明文 Token 泄露", async () => {
	const page = await callGateway(fixture.gatewayPort, "/__dsh_remote__/login", {
		headers: { accept: "text/html" },
	});
	assert.equal(page.status, 200);
	assert.match(page.body, /id="token"/);
	assert.match(page.body, /id="name"/);
	assert.match(page.body, /访问 Token/);
	assert.ok(!page.body.includes(ACCESS_TOKEN), "页面不得包含明文 Token");
});

test("错误 Token 被拒绝", async () => {
	const r = await callGateway(fixture.gatewayPort, "/__dsh_remote__/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: "wrong-token", name: "测试机" }),
	});
	assert.equal(r.status, 403);
});

test("正确 Token 登录：自动配对设备并签发长期 Cookie", async () => {
	const r = await callGateway(fixture.gatewayPort, "/__dsh_remote__/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: ACCESS_TOKEN, name: "测试 iPad" }),
	});
	assert.equal(r.status, 200);
	const cookie = /dr_device=([^;]+)/.exec(r.setCookie)?.[1];
	assert.ok(cookie, "应下发 dr_device Cookie");
	assert.match(r.setCookie, /HttpOnly/i);
	assert.match(r.setCookie, /Secure/i);
	fixture.deviceCookie = `dr_device=${cookie}`;

	const { Store } = await import("../packages/gateway/src/store.ts");
	const devices = (await (await Store.open(fixture.homeDir)).listDevices())
		.filter((device) => device.revokedAt === undefined);
	assert.ok(devices.some((device) => device.name === "测试 iPad"), "Token 登录应自动注册为设备");
});

test("空 Token 提交同样拒绝（不泄露门禁是否存在差异）", async () => {
	const r = await callGateway(fixture.gatewayPort, "/__dsh_remote__/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: "", name: "" }),
	});
	assert.equal(r.status, 403);
});

test("连续错误 Token 触发 IP 锁定，正确 Token 也被拒（独立实例）", async () => {
	const post = (token) => callGateway(fixture.lockPort, "/__dsh_remote__/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
	assert.equal((await post("bad-one")).status, 403);
	const locked = await post("bad-two");
	assert.equal(locked.status, 429, "达到阈值后应锁定");
	const correctAfterLock = await post(ACCESS_TOKEN);
	assert.equal(correctAfterLock.status, 429, "锁定期内正确 Token 也应被拒");
});

// ---------- 2. 认证后的行为 ----------

test("已登录访问登录页直接回跳目标路径", async () => {
	const r = await callGateway(fixture.gatewayPort, `/__dsh_remote__/login?next=${encodeURIComponent("/sessions")}`, {
		headers: { accept: "text/html", cookie: fixture.deviceCookie },
	});
	assert.equal(r.status, 302);
	assert.equal(r.headers.location, "/sessions");
});

test("mobile.js 需认证；带 Cookie 可获取且支持 ETag 304", async () => {
	const denied = await callGateway(fixture.gatewayPort, "/__dsh_remote__/mobile.js");
	assert.equal(denied.status, 401);

	const ok = await callGateway(fixture.gatewayPort, "/__dsh_remote__/mobile.js", {
		headers: { cookie: fixture.deviceCookie },
	});
	assert.equal(ok.status, 200);
	assert.match(ok.headers["content-type"] ?? "", /text\/javascript/);
	assert.match(ok.body, /__DSHR_MOBILE__/, "脚本应读取网关注入的断点变量");
	assert.match(ok.body, /dshr-mobile/, "脚本应包含移动 hook 根类名");

	const cached = await callGateway(fixture.gatewayPort, "/__dsh_remote__/mobile.js", {
		headers: { cookie: fixture.deviceCookie, "if-none-match": ok.headers.etag },
	});
	assert.equal(cached.status, 304);
});

test("认证后反代上游：注入主屏标记+移动 hook+viewport 兜底，设备 Cookie 不外泄", async () => {
	const r = await callGateway(fixture.gatewayPort, "/", {
		headers: { accept: "text/html", cookie: fixture.deviceCookie },
	});
	assert.equal(r.status, 200);
	assert.match(r.body, /__dsh_remote__\/sw\.js/, "主屏标记（SW 注册）仍要注入");
	assert.ok(!r.body.includes("/__dsh_remote__/manifest.webmanifest"), "不得再注入自有 manifest（官方宿主提供）");
	assert.match(r.body, /<script src="\/__dsh_remote__\/mobile\.js" defer><\/script>/, "移动 hook 标记必须注入");
	assert.match(r.body, /window\.__DSHR_MOBILE__=\{breakpoint:900\}/, "断点以内联变量下发");
	assert.match(r.body, /name="viewport"/, "上游缺 viewport 时应兜底注入");
	assert.match(r.body, /__dsh_boot__/, "上游正文原样保留");
	assert.ok(!fixture.seenByUpstream.cookie?.includes("dr_device"), "设备 Cookie 不得透传上游");
	assert.equal(fixture.seenByUpstream.host, `127.0.0.1:${String(fixture.upstreamPort)}`, "Host 应改写为上游回环形态");
});

test("WS 升级未认证被 401 拒绝", async () => {
	const text = await rawUpgrade(fixture.gatewayPort, "/ws");
	assert.match(text, /^HTTP\/1\.1 401/);
});

test("WS 升级带有效 Cookie 直通上游", async () => {
	const text = await rawUpgrade(fixture.gatewayPort, "/ws", `cookie: ${fixture.deviceCookie}\r\n`);
	assert.match(text, /^HTTP\/1\.1 101/);
	assert.ok(fixture.seenByUpstream.upgradeHost?.startsWith("127.0.0.1:"), "升级请求 Host 应改写为上游");
});

// ---------- 3. 配置与生成器（纯函数） ----------

test("renderFrpsToml：控制口/令牌/TLS 强制/allowPorts/dashboard 本机", async () => {
	const { renderFrpsToml } = await import("../packages/gateway/src/frp.ts");
	const toml = renderFrpsToml({
		bindAddr: "0.0.0.0",
		bindPort: 7000,
		authToken: 'tok"en',
		allowPorts: [{ start: 18400, end: 18500 }],
	});
	assert.match(toml, /bindAddr = "0\.0\.0\.0"/);
	assert.match(toml, /bindPort = 7000/);
	assert.match(toml, /auth\.token = "tok\\"en"/, "引号必须转义");
	assert.match(toml, /transport\.tls\.force = true/);
	assert.match(toml, /\{ start = 18400, end = 18500 \}/);
	assert.match(toml, /webServer\.addr = "127\.0\.0\.1"/);
	const empty = renderFrpsToml({ bindAddr: "0.0.0.0", bindPort: 7000, authToken: "x" });
	assert.ok(!empty.includes("allowPorts"), "无 allowPorts 时不得输出空数组");
});

test("applyEnvOverrides：env 覆盖 config.json，非法值忽略", async () => {
	const { applyEnvOverrides, parseAllowPorts, DEFAULT_CONFIG } = await import("../packages/gateway/src/config.ts");
	const patched = applyEnvOverrides(structuredClone(DEFAULT_CONFIG), {
		DSHR_ROLE: "edge",
		DSHR_LISTEN_HOST: "0.0.0.0",
		DSHR_UPSTREAM_PORT: "12345",
		DSHR_MOBILE_ENABLED: "false",
		DSHR_MOBILE_BREAKPOINT: "1200",
		DSHR_TRUST_PROXY_XFF: "true",
		DSHR_FRP_ROLE: "frps",
		DSHR_FRP_SERVER_ADDR: " 203.0.113.7 ",
		DSHR_VISITOR_BIND_PORT: "28443",
		DSHR_EDGE_CONSUME: "entry-port",
		DSHR_FRPS_ALLOW_PORTS: "18400-18500,8443",
		DSHR_UPSTREAM_PORT_INVALID: "not-a-port",
	});
	assert.equal(patched.role, "edge");
	assert.equal(patched.listenHost, "0.0.0.0");
	assert.equal(patched.upstreamPort, 12345);
	assert.deepEqual(patched.mobile, { enabled: false, breakpointPx: 1200 });
	assert.equal(patched.auth?.trustProxyXff, true);
	assert.equal(patched.frp.edge, "frps");
	assert.equal(patched.frp.serverAddr, "203.0.113.7");
	assert.equal(patched.frp.visitorBindPort, 28443);
	assert.equal(patched.frp.edgeConsume, "entry-port");
	assert.deepEqual(patched.frp.allowPorts, [{ start: 18400, end: 18500 }, { start: 8443, end: 8443 }]);
	// 原配置对象不被污染
	assert.equal(DEFAULT_CONFIG.role, undefined);

	assert.deepEqual(parseAllowPorts(" 7000 "), [{ start: 7000, end: 7000 }]);
	assert.equal(parseAllowPorts("bad"), undefined);
	assert.equal(parseAllowPorts(undefined), undefined);
});

test("edge 断点与注入开关缺省值；desktop 角色永不注入", async () => {
	const { mobileInjectionEnabled, mobileBreakpointPx, effectiveEdgeFrpRole, normalizeEdgeFrpRole, DEFAULT_CONFIG } =
		await import("../packages/gateway/src/config.ts");
	assert.equal(mobileInjectionEnabled({ ...DEFAULT_CONFIG, role: "edge" }), true);
	assert.equal(mobileInjectionEnabled({ ...DEFAULT_CONFIG }), false);
	assert.equal(mobileBreakpointPx({ ...DEFAULT_CONFIG, role: "edge" }), 980);
	assert.equal(mobileBreakpointPx({ ...DEFAULT_CONFIG, role: "edge", mobile: { breakpointPx: 42 } }), 980, "过小断点回落缺省");
	assert.equal(effectiveEdgeFrpRole(DEFAULT_CONFIG), "off");
	assert.equal(normalizeEdgeFrpRole("nonsense"), "off");
});

test("verifyAccessToken：恒时比较、拒绝畸形哈希", async () => {
	const { verifyAccessToken, hashAccessToken } = await import("../packages/gateway/src/auth.ts");
	const hash = hashAccessToken(ACCESS_TOKEN);
	assert.equal(hash.length, 64);
	assert.equal(verifyAccessToken(ACCESS_TOKEN, hash), true);
	assert.equal(verifyAccessToken("wrong", hash), false);
	assert.equal(verifyAccessToken("", hash), false);
	assert.equal(verifyAccessToken(ACCESS_TOKEN, undefined), false);
	assert.equal(verifyAccessToken(ACCESS_TOKEN, "short"), false);
});

test("双网关链路：上游已注入主屏标记时 edge 仍补移动 hook 块（幂等按标记独立）", async () => {
	const { makeHtmlInjector } = await import("../packages/gateway/src/pwa.ts");
	const edgeInject = makeHtmlInjector({ mobile: { enabled: true, breakpointPx: 900 } });
	// 模拟 PC 网关已注入过主屏标记的页面
	const pcInjected = makeHtmlInjector()(
		Buffer.from("<!doctype html><html><head><title>pc</title></head><body>__dsh_boot__</body></html>"),
	).toString();
	assert.match(pcInjected, /__dsh_remote__\/sw\.js/);

	const twice = edgeInject(Buffer.from(pcInjected)).toString();
	assert.match(twice, /__DSHR_MOBILE__/, "已有主屏标记也不得跳过移动 hook 注入");
	assert.ok(twice.split("/__dsh_remote__/sw.js").length - 1 === 1, "主屏标记不得重复注入");
	assert.match(twice, /name="viewport"/);

	// 完全无标记的页面：一次注入齐主屏标记 + 移动 hook + viewport
	const once = edgeInject(Buffer.from("<html><head></head></html>")).toString();
	assert.match(once, /__dsh_remote__\/sw\.js/);
	assert.match(once, /mobile\.js/);
	// 幂等：二次注入不重复
	const re = edgeInject(Buffer.from(once)).toString();
	assert.deepEqual(re, once);
});

test("effectiveUpstreamTls：edge+隧道推断 HTTPS，显式配置优先", async () => {
	const { effectiveUpstreamTls, DEFAULT_CONFIG } = await import("../packages/gateway/src/config.ts");
	assert.equal(effectiveUpstreamTls(DEFAULT_CONFIG), false, "desktop 缺省明文");
	const edgeVisitor = { ...structuredClone(DEFAULT_CONFIG), role: "edge", frp: { ...DEFAULT_CONFIG.frp, edge: "visitor" } };
	assert.equal(effectiveUpstreamTls(edgeVisitor), true, "隧道对端是 PC 网关（HTTPS）应推断为 TLS");
	const edgeOff = { ...structuredClone(DEFAULT_CONFIG), role: "edge", frp: { ...DEFAULT_CONFIG.frp, edge: "off" } };
	assert.equal(effectiveUpstreamTls(edgeOff), false, "直连形态缺省明文");
	const explicit = { ...structuredClone(edgeVisitor), upstreamTls: false };
	assert.equal(effectiveUpstreamTls(explicit), false, "显式配置覆盖推断");
});
