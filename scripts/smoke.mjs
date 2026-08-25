#!/usr/bin/env node
/**
 * DSH-Remote 网关冒烟测试（node:test，零外部依赖）。
 *
 * 覆盖：
 *   1. 未认证导航 302 → 配对页；未认证 XHR/API 401
 *   2. 内部资源：health / pair 页 / manifest / icon
 *   3. 一次性配对码：错误码拒绝 → 正确码发 Cookie
 *   4. 认证后反代：上游收到改写后的 Host/Origin，设备 Cookie 不外泄
 *   5. HTML 注入 PWA 标记
 *   6. WebSocket 升级：无 Cookie 拒绝；有 Cookie 字节级双向直通
 *   7. RateLimiter 单元行为 + 连续配对失败锁定
 *   8. frp 适配器：entry/stcp/xtcp 三形态 toml 渲染、访客配置与连接串
 */

import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

// ---------- 测试夹具状态 ----------

const fixture = {
	homeDir: "",
	upstream: /** @type {http.Server | undefined} */ (undefined),
	upstreamPort: 0,
	gateway: undefined,
	gatewayPort: 0,
	deviceCookie: "",
	seenByUpstream: /** @type {Record<string, string | undefined>} */ ({}),
};

/** 假上游：记录寻址头/Cookie 泄露；GET / 返回带 __dsh_boot__ 标记的 HTML；upgrade 原样回声。 */
async function startFakeUpstream() {
	const server = http.createServer((req, res) => {
		fixture.seenByUpstream.host = req.headers.host;
		fixture.seenByUpstream.origin = req.headers.origin;
		fixture.seenByUpstream.cookie = req.headers.cookie;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<!doctype html><html><head><title>fake dsh</title></head><body>__dsh_boot__ ok</body></html>");
	});
	server.on("upgrade", (req, socket, head) => {
		fixture.seenByUpstream.upgradeHost = req.headers.host;
		socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
		if (head.length > 0) socket.write(head);
		socket.pipe(socket); // 原始字节回声：只验证管道保真，不实现 WS 协议
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	fixture.upstream = server;
	fixture.upstreamPort = server.address().port;
	return server;
}

/** 用自签证书场景下的 https.request 封装（rejectUnauthorized:false）。 */
function callGateway(pathname, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: "127.0.0.1",
				port: fixture.gatewayPort,
				path: pathname,
				method,
				headers,
				rejectUnauthorized: false,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks);
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: raw.toString("utf8"),
						raw,
						setCookie: res.headers["set-cookie"]?.join("; ") ?? "",
					});
				});
			},
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

before(async () => {
	fixture.homeDir = await mkdtemp(join(tmpdir(), "dsh-remote-smoke-"));
	process.env.DSH_REMOTE_HOME = fixture.homeDir;

	await startFakeUpstream();

	const [{ Store }, { DEFAULT_CONFIG }, { GatewayServer }] = await Promise.all([
		import("../packages/gateway/src/store.ts"),
		import("../packages/gateway/src/config.ts"),
		import("../packages/gateway/src/server.ts"),
	]);
	const store = await Store.open(fixture.homeDir);
	const config = {
		...DEFAULT_CONFIG,
		upstreamPort: fixture.upstreamPort,
		listenPort: 0, // OS 分配
		pairingFailLockThreshold: 3,
	};
	const gateway = new GatewayServer({ store, config, log: () => {} });
	await gateway.start();
	fixture.gateway = gateway;
	fixture.gatewayPort = gateway.actualPort;
});

after(async () => {
	await fixture.gateway?.stop();
	await new Promise((resolve) => fixture.upstream?.close(resolve));
	await rm(fixture.homeDir, { recursive: true, force: true });
});

// ---------- 1. 认证门 ----------

test("未认证导航重定向到配对页", async () => {
	// 浏览器导航必带 Accept: text/html
	const response = await callGateway("/", { headers: { accept: "text/html,application/xhtml+xml" } });
	assert.equal(response.status, 302);
	assert.match(response.headers.location ?? "", /^\/__dsh_remote__\/pair/);
});

test("未认证 API/XHR 返回 401 JSON", async () => {
	const response = await callGateway("/api/session/list", { headers: { accept: "application/json" } });
	assert.equal(response.status, 401);
	assert.match(response.body, /unpaired-device/);
});

// ---------- 2. 内部资源 ----------

test("health 探针可用", async () => {
	const response = await callGateway("/__dsh_remote__/health");
	assert.equal(response.status, 200);
	assert.equal(JSON.parse(response.body).ok, true);
});

test("manifest 与图标可获取", async () => {
	const manifest = await callGateway("/__dsh_remote__/manifest.webmanifest");
	assert.equal(manifest.status, 200);
	const parsed = JSON.parse(manifest.body);
	assert.equal(parsed.name, "DSH Remote");
	assert.ok(parsed.icons.some((icon) => icon.src.endsWith("icon-192.png")), "manifest 应引用 PNG 图标");
	const icon = await callGateway("/__dsh_remote__/icon.svg");
	assert.equal(icon.status, 200);
	assert.match(icon.body, /<svg/);
	const brand = await callGateway("/__dsh_remote__/brand.svg");
	assert.equal(brand.status, 200);
	assert.equal(brand.headers["content-type"], "image/svg+xml");
	assert.match(brand.body, /<svg/);
});

test("PNG 图标：魔数、尺寸与解码完整性", async () => {
	for (const [path, size] of [["/__dsh_remote__/icon-192.png", 192], ["/__dsh_remote__/icon-512.png", 512]]) {
		const response = await callGateway(path);
		assert.equal(response.status, 200);
		const buf = response.raw;
		// PNG 签名
		assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		// IHDR 尺寸
		assert.equal(buf.readUInt32BE(16), size);
		assert.equal(buf.readUInt32BE(20), size);
		assert.equal(buf.readUInt8(24), 8);  // bit depth
		assert.equal(buf.readUInt8(25), 6);  // RGBA
	}
});

test("管理端点拒绝非回环来源（模拟头不可绕过，仅回环判定）——本机可访问", async () => {
	const status = await callGateway("/__dsh_remote__/admin/status");
	assert.equal(status.status, 200);
	assert.match(status.body, /certFingerprint/);
});

test("配对页 next 参数防 XSS：注入载荷被清洗、正常路径保留", async () => {
	const evil = encodeURIComponent("/';alert(1);//");
	const evilResponse = await callGateway(`/__dsh_remote__/pair?next=${evil}`);
	assert.equal(evilResponse.status, 200);
	assert.ok(!evilResponse.body.includes("alert(1)"), "注入载荷不得出现在页面中");
	// 非法协议形态也被清洗为 "/"
	const proto = await callGateway(`/__dsh_remote__/pair?next=${encodeURIComponent("//evil.example")}`);
	assert.ok(proto.body.includes('location.href="/"'), "双斜线外链应回退为根路径");
	const legit = await callGateway(`/__dsh_remote__/pair?next=${encodeURIComponent("/sessions?tab=all")}`);
	assert.match(legit.body, /location\.href="\/sessions\?tab=all"/);
});

test("Android WebView 获得移动配对页，不改变配对协议", async () => {
	const response = await callGateway("/__dsh_remote__/pair", {
		headers: { "user-agent": "Mozilla/5.0 DSHRemoteAndroid/1" },
	});
	assert.equal(response.status, 200);
	assert.match(response.body, /配对这台设备/);
	assert.match(response.body, /__dsh_remote__\/brand\.svg/);
	assert.ok(!response.body.includes('class="card"'), "移动配对页不应回退为旧卡片布局");
	assert.match(response.body, /location\.href="\/"/);
});

// ---------- 3. 配对流程 ----------

test("错误配对码被拒绝并计数", async () => {
	const response = await callGateway("/__dsh_remote__/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: "0000-0000", name: "测试机" }),
	});
	assert.equal(response.status, 403);
});

test("正确一次性配对码签发设备 Cookie", async () => {
	const store = await import("../packages/gateway/src/store.ts").then((mod) => mod.Store.open(fixture.homeDir));
	await store.putPendingCode("ABCD-EFGH", 10);
	const response = await callGateway("/__dsh_remote__/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: "abcd-efgh", name: "冒烟手机" }),
	});
	assert.equal(response.status, 200);
	const cookie = /dr_device=([^;]+)/.exec(response.setCookie)?.[1];
	assert.ok(cookie, "应下发 dr_device Cookie");
	assert.match(response.setCookie, /HttpOnly/i);
	fixture.deviceCookie = `dr_device=${cookie}`;
});

test("同一配对码不可复用", async () => {
	const response = await callGateway("/__dsh_remote__/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: "ABCD-EFGH", name: "再来一次" }),
	});
	assert.equal(response.status, 403);
});

// ---------- 4. 反向代理 ----------

test("认证后请求代理到上游：Host 改写、Cookie 剥离、HTML 注入", async () => {
	const response = await callGateway("/", {
		headers: { cookie: fixture.deviceCookie, origin: "https://vps.example:8443", accept: "text/html" },
	});
	assert.equal(response.status, 200);
	assert.match(response.body, /__dsh_boot__/);
	assert.match(response.body, /manifest\.webmanifest/, "应注入 PWA manifest 引用");
	// 上游看到的 Host 必须是回环形态（信任栅栏）
	assert.equal(fixture.seenByUpstream.host, `127.0.0.1:${String(fixture.upstreamPort)}`);
	assert.equal(fixture.seenByUpstream.origin, `http://127.0.0.1:${String(fixture.upstreamPort)}`);
	assert.equal(fixture.seenByUpstream.cookie, undefined, "设备 Cookie 不得外泄给上游");
});

// ---------- 5. WebSocket 直通 ----------

test("WS 升级：无 Cookie 被拒；有 Cookie 字节级双向透传", async () => {
	// 无 Cookie → 401 后断开
	const rejected = await new Promise((resolve) => {
		const socket = tls.connect({
			host: "127.0.0.1",
			port: fixture.gatewayPort,
			rejectUnauthorized: false,
		}, () => {
			socket.write("GET /ws HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: aAA=\r\nsec-websocket-version: 13\r\n\r\n");
		});
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			resolve(data);
			socket.destroy();
		});
		socket.on("error", () => resolve(data));
	});
	assert.match(rejected, /^HTTP\/1\.1 401/);

	// 有 Cookie → 101 + 原始字节回声
	const echoed = await new Promise((resolve, reject) => {
		const socket = tls.connect({
			host: "127.0.0.1",
			port: fixture.gatewayPort,
			rejectUnauthorized: false,
		}, () => {
			socket.write([
				"GET /ws HTTP/1.1",
				`cookie: ${fixture.deviceCookie}`,
				"upgrade: websocket",
				"connection: Upgrade",
				"sec-websocket-key: aAA=",
				"sec-websocket-version: 13",
				"\r\n",
			].join("\r\n"));
		});
		const payload = Buffer.from([0x81, 0x85, 0x11, 0x22, 0x33, 0x44, 0xde, 0xad, 0xbe, 0xef]);
		let received = [];
		let got101 = false;
		socket.on("data", (chunk) => {
			if (!got101) {
				received.push(chunk);
				const text = Buffer.concat(received).toString("latin1");
				if (!text.includes("\r\n\r\n")) return;
				got101 = true;
				assert.match(text, /^HTTP\/1\.1 101/);
				assert.equal(fixture.seenByUpstream.upgradeHost, `127.0.0.1:${String(fixture.upstreamPort)}`);
				socket.write(payload);
				return;
			}
			if (chunk.equals(payload)) {
				resolve(true);
				socket.destroy();
			}
		});
		socket.on("error", reject);
		setTimeout(() => reject(new Error("WS 回声超时")), 4000);
	});
	assert.ok(echoed);
});

// ---------- 6. RateLimiter 单元 ----------

test("RateLimiter：窗口限流与失败锁定", async () => {
	const { RateLimiter } = await import("../packages/gateway/src/auth.ts");
	const limiter = new RateLimiter(3, 2, 15);
	for (let i = 0; i < 3; i += 1) assert.equal(limiter.allow("ip-a"), true, `第${String(i + 1)}个请求应放行`);
	assert.equal(limiter.allow("ip-a"), false, "超出窗口应拒绝");
	assert.equal(limiter.allow("ip-b"), true, "不同 IP 不受影响");

	assert.equal(limiter.notePairFail("ip-c"), true);
	assert.equal(limiter.notePairFail("ip-c"), false, "达到阈值应锁定");
	assert.equal(limiter.isLocked("ip-c"), true);
	assert.equal(limiter.allow("ip-c"), false, "锁定期间全部拒绝");
});

// ---------- 7. 配对失败锁定（放最后，会锁住回环 IP） ----------

test("连续配对失败触发临时锁定", async () => {
	const body = JSON.stringify({ code: "ZZZZ-ZZZZ", name: "攻击者" });
	let lastStatus = 0;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const response = await callGateway("/__dsh_remote__/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		lastStatus = response.status;
		if (response.status === 429) break;
	}
	assert.equal(lastStatus, 429, "第 3 次失败后应返回 429 锁定");
});

// ---------- 8. frp 适配器渲染（纯函数，放最后避免干扰上面的 HTTP 用例编号） ----------

test("renderFrpcToml：entry 形态保持 tcp + remotePort", async () => {
	const { renderFrpcToml } = await import("../packages/gateway/src/frp.ts");
	const toml = renderFrpcToml({
		serverAddr: "v.example", serverPort: 7000, authToken: "tok",
		localPort: 18443, remotePort: 8443, mode: "entry", secretKey: "sk",
	});
	assert.match(toml, /type = "tcp"/);
	assert.match(toml, /remotePort = 8443/);
	assert.ok(!toml.includes("secretKey"), "entry 形态不应出现访客密钥");
});

test("renderFrpcToml：stcp/xtcp 形态带 secretKey 且无 remotePort", async () => {
	const { renderFrpcToml, normalizeFrpMode } = await import("../packages/gateway/src/frp.ts");
	const stcp = renderFrpcToml({
		serverAddr: "v.example", serverPort: 7000, authToken: "tok",
		localPort: 18443, remotePort: 9999, mode: "stcp", secretKey: "sk-1",
	});
	assert.match(stcp, /type = "stcp"/);
	assert.match(stcp, /secretKey = "sk-1"/);
	assert.ok(!stcp.includes("remotePort"), "stcp 不应监听任何 VPS 端口");
	assert.equal((stcp.match(/\[\[proxies\]\]/g) || []).length, 1);

	const xtcp = renderFrpcToml({
		serverAddr: "v.example", serverPort: 7000, authToken: "tok",
		localPort: 18443, remotePort: 9999, mode: "xtcp", secretKey: "sk-1",
	});
	assert.match(xtcp, /type = "xtcp"/);
	assert.match(xtcp, /type = "stcp"/, "xtcp 服务端必须同时挂 stcp 供 fallback");
	assert.match(xtcp, /name = "dsh-remote-stcp"/);
	assert.match(xtcp, /secretKey = "sk-1"/);
	assert.ok(!xtcp.includes("remotePort"), "xtcp 不应监听任何 VPS 端口");
	assert.equal((xtcp.match(/\[\[proxies\]\]/g) || []).length, 2);
	assert.equal(normalizeFrpMode("xtcp"), "xtcp");
	assert.equal(normalizeFrpMode("tcp"), "entry", "未知形态回落 entry");
	assert.equal(normalizeFrpMode(undefined), "entry");
});

test("renderVisitorToml：访客配置与 proxy 通过 serverName+secretKey 关联", async () => {
	const { renderVisitorToml } = await import("../packages/gateway/src/frp.ts");
	const toml = renderVisitorToml({
		serverAddr: "v.example", serverPort: 7000, authToken: "tok",
		mode: "xtcp", secretKey: "sk-1", bindPort: 18443,
	});
	assert.match(toml, /\[\[visitors\]\]/);
	assert.match(toml, /type = "xtcp"/);
	assert.match(toml, /type = "stcp"/);
	assert.match(toml, /serverName = "dsh-remote"/);
	assert.match(toml, /serverName = "dsh-remote-stcp"/);
	assert.match(toml, /bindAddr = "127\.0\.0\.1"/);
	assert.match(toml, /bindPort = 18443/);
	assert.match(toml, /bindPort = -1/);
	assert.match(toml, /fallbackTo = "dsh-remote-stcp-visitor"/);
	assert.match(toml, /fallbackTimeoutMs = 5000/);
	assert.match(toml, /auth\.token = "tok"/, "visitor 也要登录 frps");
});

test("visitorKeyAdmits：仅启用的 stcp/xtcp 跳过配对", async () => {
	const { visitorKeyAdmits } = await import("../packages/gateway/src/auth.ts");
	const { DEFAULT_CONFIG } = await import("../packages/gateway/src/config.ts");
	assert.equal(visitorKeyAdmits(DEFAULT_CONFIG), false);
	assert.equal(visitorKeyAdmits({
		...DEFAULT_CONFIG,
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "entry" },
	}), false);
	assert.equal(visitorKeyAdmits({
		...DEFAULT_CONFIG,
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "xtcp" },
	}), true);
	assert.equal(visitorKeyAdmits({
		...DEFAULT_CONFIG,
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "stcp" },
	}), true);
	assert.equal(visitorKeyAdmits({
		...DEFAULT_CONFIG,
		frp: { ...DEFAULT_CONFIG.frp, enabled: false, mode: "xtcp" },
	}), false);
});

test("xtcp 形态未配对即可访问上游（访客密钥即准入）", async () => {
	const { Store } = await import("../packages/gateway/src/store.ts");
	const { DEFAULT_CONFIG } = await import("../packages/gateway/src/config.ts");
	const { GatewayServer } = await import("../packages/gateway/src/server.ts");
	const homeDir = await mkdtemp(join(tmpdir(), "dshr-xtcp-"));
	const store = await Store.open(homeDir);
	const gateway = new GatewayServer({
		store,
		config: {
			...DEFAULT_CONFIG,
			upstreamPort: fixture.upstreamPort,
			listenPort: 0,
			frp: { ...DEFAULT_CONFIG.frp, enabled: true, serverAddr: "127.0.0.1", mode: "xtcp" },
		},
		log: () => {},
	});
	await gateway.start();
	try {
		const port = gateway.actualPort;
		const response = await new Promise((resolve, reject) => {
			const req = https.request({
				host: "127.0.0.1", port, path: "/", method: "GET",
				headers: { accept: "text/html" }, rejectUnauthorized: false,
			}, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({
					status: res.statusCode,
					location: res.headers.location ?? "",
					body: Buffer.concat(chunks).toString("utf8"),
				}));
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(response.status, 200, "不应再 302 到配对页");
		assert.equal(response.location, "");
		assert.match(response.body, /__dsh_boot__/);
	} finally {
		await gateway.stop();
		await rm(homeDir, { recursive: true, force: true });
	}
});

test("visitorConnectionString：参数齐全、指纹归一化、URL 编码安全", async () => {
	const { visitorConnectionString } = await import("../packages/gateway/src/frp.ts");
	const link = visitorConnectionString({
		mode: "xtcp", serverAddr: "v.example", serverPort: 7000,
		secretKey: "s k", authToken: "t&o", bindPort: 18443,
		fingerprint: "AB:CD:EF",
	});
	assert.match(link, /^dsh-remote:\/\/visitor\?/);
	const url = new URL(link.replace(/^dsh-remote:/, "https:"));
	assert.equal(url.searchParams.get("mode"), "xtcp");
	assert.equal(url.searchParams.get("server"), "v.example");
	assert.equal(url.searchParams.get("cport"), "7000");
	assert.equal(url.searchParams.get("bport"), "18443");
	assert.equal(url.searchParams.get("fp"), "abcdef", "指纹应去冒号并小写");
	assert.equal(url.searchParams.get("token"), "t&o", "特殊字符应被编码且可还原");
});
