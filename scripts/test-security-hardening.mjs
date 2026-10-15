/**
 * 安全加固：同源门、实例 Cookie、PROXY v2、TOML 转义、限流对已登录放行。
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameOriginAsHost, parseCookies, RateLimiter, deviceCookieName } from "../packages/gateway/src/auth.ts";
import { parseProxyV2 } from "../packages/gateway/src/proxyproto.ts";
import { renderVisitorToml, tomlString, visitorConnectionString } from "../packages/gateway/src/frp.ts";
import { proxyHttp } from "../packages/gateway/src/proxy.ts";
import { DEFAULT_CONFIG } from "../packages/gateway/src/config.ts";
import { PeerDeviceSession } from "../packages/gateway/src/peer-device.ts";
import { GatewayServer } from "../packages/gateway/src/server.ts";
import { Store } from "../packages/gateway/src/store.ts";
import { validateConfigPatch } from "../packages/plugin/lib/config-schema.js";
import plugin, { forwardedGatewayRequest } from "../packages/plugin/lib/index.js";
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const selfsigned = require("selfsigned");
import { deviceCookieHeader, makeTempHome, requestTls, startFakeUpstream, wsConnect } from "./test-harness.mjs";

test("sameOriginAsHost：只认 Origin 的 host:port 与 Host 相同", () => {
	const req = (origin, host) => ({ headers: { origin, host } });
	assert.equal(sameOriginAsHost(req("https://127.0.0.1:18443", "127.0.0.1:18443")), true);
	assert.equal(sameOriginAsHost(req("https://gateway.invalid", "gateway.invalid")), true);
	assert.equal(sameOriginAsHost(req("https://example.com", "example.com:443")), true);
	assert.equal(sameOriginAsHost(req(undefined, "127.0.0.1:18443")), false);
	assert.equal(sameOriginAsHost(req("https://evil.example", "127.0.0.1:18443")), false);
	assert.equal(sameOriginAsHost(req("not a url", "127.0.0.1:18443")), false);
});

test("parseCookies：坏的百分号编码跳过，不抛", () => {
	const map = parseCookies("ok=a%2Fb; bad=%; dr_device_abc=tok");
	assert.equal(map.get("ok"), "a/b");
	assert.equal(map.get("bad"), undefined);
	assert.equal(map.get("dr_device_abc"), "tok");
});

test("短访客密钥被拒，IPv6 主机名可以保存", () => {
	assert.equal(validateConfigPatch({ visitorKey: "k".repeat(15) }).ok, false);
	assert.equal(validateConfigPatch({ visitorKey: "k".repeat(16) }).ok, true);
	assert.equal(validateConfigPatch({ visitorKey: "has\nline-and-more" }).ok, false);
	assert.equal(validateConfigPatch({ frp: { serverAddr: "2001:db8::1" } }).ok, true);
	assert.equal(validateConfigPatch({ frp: { serverAddr: "[2001:db8::1]" } }).ok, true);
	assert.equal(validateConfigPatch({ frp: { serverAddr: "vps\"quote" } }).ok, false);
});

test("RateLimiter.allow 不因锁定返回 false", () => {
	const limiter = new RateLimiter(10, 1, 15);
	assert.equal(limiter.notePairFail("ip"), false);
	assert.equal(limiter.isLocked("ip"), true);
	assert.equal(limiter.allow("ip"), true);
});

test("PROXY v2 取出 IPv4 源地址，坏签名和半包分别拒绝与等待", () => {
	const header = proxyV2("203.0.113.9", 443);
	const parsed = parseProxyV2(header);
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.info.srcAddr, "203.0.113.9");
		assert.equal(parsed.info.srcPort, 443);
		assert.equal(parsed.info.rest.length, 0);
	}
	assert.equal(parseProxyV2(Buffer.from("nope")).ok, false);
	assert.equal(parseProxyV2(header.subarray(0, 10)).needMore, true);

	const local = Buffer.from(header.subarray(0, 16));
	local[12] = 0x20;
	local.writeUInt16BE(0, 14);
	const localParsed = parseProxyV2(local);
	assert.equal(localParsed.ok, true);
	if (localParsed.ok) {
		assert.equal(localParsed.info.srcAddr, "");
		assert.equal(localParsed.info.srcPort, 0);
	}

	const v6 = Buffer.alloc(16 + 36);
	header.copy(v6, 0, 0, 12);
	v6[12] = 0x21;
	v6[13] = 0x21;
	v6.writeUInt16BE(36, 14);
	const groups = [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1];
	groups.forEach((part, index) => v6.writeUInt16BE(part, 16 + index * 2));
	v6.writeUInt16BE(443, 48);
	const v6Parsed = parseProxyV2(v6);
	assert.equal(v6Parsed.ok, true);
	if (v6Parsed.ok) {
		assert.equal(v6Parsed.info.srcAddr, "2001:db8:0:0:0:0:0:1");
		assert.equal(v6Parsed.info.srcPort, 443);
	}

	const short4 = Buffer.alloc(16 + 11);
	header.copy(short4, 0, 0, 14);
	short4.writeUInt16BE(11, 14);
	const short4Parsed = parseProxyV2(short4);
	assert.equal(short4Parsed.ok, false);
	assert.equal(short4Parsed.needMore, undefined);

	const short6 = Buffer.alloc(16 + 35);
	v6.copy(short6, 0, 0, 14);
	short6.writeUInt16BE(35, 14);
	const short6Parsed = parseProxyV2(short6);
	assert.equal(short6Parsed.ok, false);
	assert.equal(short6Parsed.needMore, undefined);
});

test("TOML 字符串转义引号和反斜杠", () => {
	assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
	const toml = renderVisitorToml({
		serverAddr: 'vps"1',
		serverPort: 7000,
		authToken: "tok\\en",
		secretKey: "visitor-key-ok!!",
		serverName: "pc",
		mode: "stcp",
		bindPort: 18443,
		bindAddr: "127.0.0.1",
	});
	assert.match(toml, /serverAddr = "vps\\"1"/);
	assert.match(toml, /auth\.token = "tok\\\\en"/);
	assert.match(toml, /loginFailExit = false/);
	assert.match(toml, /bindAddr = "127.0.0.1"/);
	const link = visitorConnectionString({
		serverAddr: "vps.example",
		serverPort: 7000,
		secretKey: "visitor-key-ok!!",
		authToken: "auth-token-ok!!",
		bindPort: 18443,
		trustedCaFile: "/etc/frp/ca.crt",
		tlsServerName: "frps.example",
	});
	const url = new URL(link.replace(/^dsh-remote:/, "https:"));
	assert.equal(url.searchParams.get("ca"), "/etc/frp/ca.crt");
	assert.equal(url.searchParams.get("sni"), "frps.example");
	const withTls = renderVisitorToml({
		serverAddr: "vps.example",
		serverPort: 7000,
		authToken: "auth-token-ok!!",
		secretKey: "visitor-key-ok!!",
		bindPort: 18443,
		trustedCaFile: "/etc/frp/ca.crt",
		tlsServerName: "frps.example",
	});
	assert.match(withTls, /transport\.tls\.trustedCaFile = "\/etc\/frp\/ca\.crt"/);
	assert.match(withTls, /transport\.tls\.serverName = "frps\.example"/);
});

test("损坏的 secrets.json 不重新生成密钥", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dshr-secrets-"));
	const store = await Store.open(dir);
	const secretsPath = join(dir, "state", "secrets.json");
	await writeFile(secretsPath, "{");
	await assert.rejects(() => store.ensureSecrets(), /已损坏/);
	const backup = (await readFile(secretsPath, "utf8"));
	assert.equal(backup, "{");
	await rm(dir, { recursive: true, force: true });
});

test("桌面隧道要求设备 Cookie，跨站 POST 拒绝，入口口只收 PROXY v2", async () => {
	const home = await makeTempHome("dshr-sec-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			rateLimitPerMinute: 2,
			frp: {
				...DEFAULT_CONFIG.frp,
				enabled: true,
				mode: "xtcp",
				entryEnabled: true,
				remotePort: 18444,
				serverAddr: "127.0.0.1",
			},
		},
	});
	await gateway.start();
	const port = gateway.actualPort;
	const base = `https://127.0.0.1:${String(port)}`;
	try {
		const anon = await requestTls(`${base}/`, { headers: { accept: "text/html" } });
		assert.equal(anon.status, 302);
		assert.match(anon.headers.location ?? "", /\/__dsh_remote__\/login/);

		const secrets = await store.ensureSecrets();
		const login = await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: secrets.frpVisitorKey, name: "安全测试" }),
		});
		assert.equal(login.status, 200, login.body);
		const cookie = deviceCookieHeader(login.setCookie);
		assert.match(cookie, /^dr_device_[0-9a-f]{16}=/);

		const barePost = await requestTls(`${base}/api/echo`, {
			method: "POST",
			headers: { cookie, "content-type": "text/plain" },
			body: "x",
		});
		assert.equal(barePost.status, 403);

		const okPost = await requestTls(`${base}/api/echo`, {
			method: "POST",
			headers: { cookie, origin: `https://127.0.0.1:${String(port)}`, "content-type": "text/plain" },
			body: "x",
		});
		assert.equal(okPost.status, 200);

		const evilPost = await requestTls(`${base}/api/echo`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "content-type": "text/plain" },
			body: "x",
		});
		assert.equal(evilPost.status, 403);

		const entryEvil = await requestViaProxy(gateway.publicEntryPort, "/api/echo", {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "content-type": "text/plain" },
			body: "x",
		});
		assert.match(entryEvil, /^HTTP\/1\.1 403/);

		const noOrigin = wsConnect(`wss://127.0.0.1:${String(port)}/ws`, { headers: { cookie }, origin: false });
		try { assert.match(await noOrigin.headersText, /^HTTP\/1\.1 403/); }
		finally { noOrigin.close(); }
		const evil = wsConnect(`wss://127.0.0.1:${String(port)}/ws`, {
			headers: { cookie, origin: "https://evil.example" },
		});
		try { assert.match(await evil.headersText, /^HTTP\/1\.1 403/); }
		finally { evil.close(); }
		const okWs = wsConnect(`wss://127.0.0.1:${String(port)}/ws`, { headers: { cookie } });
		try { assert.match(await okWs.headersText, /^HTTP\/1\.1 101/); }
		finally { okWs.close(); }

		const entry = gateway.publicEntryPort;
		assert.equal(typeof entry, "number");
		await assert.rejects(requestTls(`https://127.0.0.1:${String(entry)}/__dsh_remote__/health`, { timeoutMs: 1500 }));
		const health = await requestViaProxy(entry, "/__dsh_remote__/health");
		assert.match(health, /^HTTP\/1\.1 200/);
		assert.match(health, /"ok":true/);
		assert.match(health, /"fingerprint":"[0-9A-F]{64}"/);
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("插件设置接口拒绝网关转发头", () => {
	assert.equal(forwardedGatewayRequest({}), false);
	assert.equal(forwardedGatewayRequest({ host: "127.0.0.1:18443" }), false);
	assert.equal(forwardedGatewayRequest({ "x-forwarded-host": "phone.example" }), true);
	assert.equal(forwardedGatewayRequest({ "x-forwarded-proto": "" }), true);
});

test("同一凭据和设备名的登录不新增设备行", async () => {
	const home = await makeTempHome("dshr-reuse-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "stcp", serverAddr: "127.0.0.1" },
		},
	});
	await gateway.start();
	try {
		const key = (await store.ensureSecrets()).frpVisitorKey;
		const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
		let first = "";
		let last = "";
		for (let i = 0; i < 5; i++) {
			const login = await requestTls(`${base}/__dsh_remote__/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: key, name: "Android" }),
			});
			assert.equal(login.status, 200, login.body);
			last = deviceCookieHeader(login.setCookie);
			if (i === 0) first = last;
		}
		const active = (await store.listDevices()).filter((device) => !device.revokedAt);
		assert.equal(active.length, 1);
		assert.equal((await requestTls(`${base}/`, { headers: { cookie: last, accept: "text/html" } })).status, 200);
		assert.equal((await requestTls(`${base}/api/echo`, { headers: { cookie: first } })).status, 401);
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("同一凭据、不同设备名的登录各留一行且都能访问", async () => {
	const home = await makeTempHome("dshr-two-names-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "stcp", serverAddr: "127.0.0.1" },
		},
	});
	await gateway.start();
	try {
		const key = (await store.ensureSecrets()).frpVisitorKey;
		const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
		const cookies = [];
		for (const name of ["Pixel 9a-k3m9q", "sdk_gphone64-p7w2n"]) {
			const login = await requestTls(`${base}/__dsh_remote__/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: key, name }),
			});
			assert.equal(login.status, 200, login.body);
			cookies.push(deviceCookieHeader(login.setCookie));
		}
		const active = (await store.listDevices()).filter((device) => !device.revokedAt);
		assert.equal(active.length, 2);
		assert.deepEqual(active.map((device) => device.name).sort(), ["Pixel 9a-k3m9q", "sdk_gphone64-p7w2n"]);
		for (const cookie of cookies) {
			assert.equal((await requestTls(`${base}/`, { headers: { cookie, accept: "text/html" } })).status, 200);
		}
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("两个实例的设备 Cookie 名不同，配对与登录用同一个后缀", async () => {
	const upstream = await startFakeUpstream();
	const started = [];
	try {
		const cookies = [];
		for (const instanceId of ["0123456789abcdef", "fedcba9876543210"]) {
			const home = await makeTempHome("dshr-inst-");
			const store = await Store.open(home);
			await writeFile(store.path("state", "secrets.json"), `${JSON.stringify({
				frpAuthToken: "auth-token-ok!!",
				frpVisitorKey: "visitor-key-ok!!",
				adminToken: "admin-token-ok!!",
				instanceId,
			})}\n`);
			const gateway = new GatewayServer({
				store,
				log: () => {},
				config: {
					...structuredClone(DEFAULT_CONFIG),
					listenPort: 0,
					upstreamPort: upstream.port,
					autoFixUpstreamPort: false,
					frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "stcp", serverAddr: "127.0.0.1" },
				},
			});
			await gateway.start();
			started.push({ gateway, home });
			const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
			const login = await requestTls(`${base}/__dsh_remote__/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "visitor-key-ok!!", name: "甲" }),
			});
			assert.equal(login.status, 200, login.body);
			await store.putPendingCode("ABCD-2345", 10);
			const paired = await requestTls(`${base}/__dsh_remote__/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: "ABCD-2345", name: "乙" }),
			});
			assert.equal(paired.status, 200, paired.body);
			const loginName = deviceCookieHeader(login.setCookie).split("=", 1)[0];
			const pairName = deviceCookieHeader(paired.setCookie).split("=", 1)[0];
			assert.equal(loginName, deviceCookieName(instanceId));
			assert.equal(pairName, loginName);
			cookies.push(loginName);
		}
		assert.notEqual(cookies[0], cookies[1]);
	} finally {
		for (const item of started) {
			await item.gateway.stop();
			await rm(item.home, { recursive: true, force: true });
		}
		await upstream.close();
	}
});

test("入口限流与主口分开，PROXY 源地址是限流键，锁定不拦已登录", async () => {
	const home = await makeTempHome("dshr-rate-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			rateLimitPerMinute: 2,
			pairingFailLockThreshold: 1,
			frp: {
				...DEFAULT_CONFIG.frp,
				enabled: true,
				mode: "xtcp",
				entryEnabled: true,
				remotePort: 18444,
				serverAddr: "127.0.0.1",
			},
		},
	});
	await gateway.start();
	const port = gateway.actualPort;
	const entry = gateway.publicEntryPort;
	const base = `https://127.0.0.1:${String(port)}`;
	try {
		const key = (await store.ensureSecrets()).frpVisitorKey;
		const login = await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: key, name: "限流" }),
		});
		const cookie = deviceCookieHeader(login.setCookie);
		const first = await requestViaProxy(entry, "/api/echo", { srcIp: "127.0.0.1" });
		const second = await requestViaProxy(entry, "/api/echo", { srcIp: "127.0.0.1" });
		const third = await requestViaProxy(entry, "/api/echo", { srcIp: "127.0.0.1" });
		const other = await requestViaProxy(entry, "/api/echo", { srcIp: "203.0.113.10" });
		assert.match(first, /^HTTP\/1\.1 401/);
		assert.match(second, /^HTTP\/1\.1 401/);
		assert.match(third, /^HTTP\/1\.1 429/);
		assert.match(other, /^HTTP\/1\.1 401/);
		const main = await requestTls(`${base}/api/echo`);
		assert.equal(main.status, 401, "入口口用 127.0.0.1 打满后，主口同一地址仍应是未登录而不是 429");
		assert.equal((await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "wrong-visitor-key", name: "限流" }),
		})).status, 429);
		assert.equal((await requestTls(`${base}/`, { headers: { cookie, accept: "text/html" } })).status, 200);
		for (let i = 0; i < 4; i++) {
			assert.equal(
				(await requestTls(`${base}/`, { headers: { cookie, accept: "text/html" } })).status,
				200,
				"已登录流量打满限流桶后仍应放行",
			);
		}
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("edge 用访客密钥换电脑端设备 Cookie 后再反代", async () => {
	const peerKey = "visitor-key-ok!!";
	const pems = selfsigned.generate([{ name: "commonName", value: "peer" }], { days: 1, keySize: 2048 });
	const seen = [];
	const peer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			if (req.method === "POST" && (req.url ?? "").startsWith("/__dsh_remote__/login")) {
				const token = JSON.parse(body).token;
				if (token !== peerKey) {
					res.writeHead(403).end("{}");
					return;
				}
				res.writeHead(200, {
					"content-type": "application/json",
					"set-cookie": "dr_device_aabbccddeeff0011=peer-token; HttpOnly; Secure; Path=/",
				});
				res.end("{\"ok\":true}");
				return;
			}
			seen.push(String(req.headers.cookie ?? ""));
			if (!String(req.headers.cookie ?? "").includes("peer-token")) {
				res.writeHead(302, { location: "/__dsh_remote__/login?next=%2F" }).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<!doctype html><html><body>__dsh_boot__ chain</body></html>");
		});
	});
	await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
	const peerPort = peer.address().port;
	const home = await makeTempHome("dshr-edge-peer-");
	const store = await Store.open(home);
	await writeFile(store.path("state", "secrets.json"), `${JSON.stringify({
		frpAuthToken: "auth-token-ok!!",
		frpVisitorKey: peerKey,
		adminToken: "admin-token-ok!!",
		instanceId: "abcdef0123456789",
	})}\n`);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		env: { ...process.env, DSHR_ACCESS_TOKEN: "edge-access-token" },
		config: {
			...structuredClone(DEFAULT_CONFIG),
			role: "edge",
			listenPort: 0,
			upstreamPort: 1,
			autoFixUpstreamPort: false,
			frp: { ...DEFAULT_CONFIG.frp, enabled: false, edge: "visitor", visitorBindPort: peerPort },
		},
	});
	await gateway.start();
	try {
		const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
		const login = await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "edge-access-token", name: "浏览器" }),
		});
		assert.equal(login.status, 200, login.body);
		const cookie = deviceCookieHeader(login.setCookie);
		const page = await requestTls(`${base}/`, { headers: { cookie, accept: "text/html" } });
		assert.equal(page.status, 200, page.body.slice(0, 200));
		assert.match(page.body, /__dsh_boot__ chain/);
		assert.ok(seen.some((header) => header.includes("peer-token")));
		assert.ok(seen.every((header) => !header.includes(cookie.split("=")[1])));
	} finally {
		await gateway.stop();
		await new Promise((resolve) => peer.close(resolve));
		await rm(home, { recursive: true, force: true });
	}
});

test("touchDevice 命中缓存时不读设备表", async () => {
	const home = await makeTempHome("dshr-touch-");
	const store = await Store.open(home);
	const { device } = await store.addDevice("Android", "cred-hash");
	await store.listDevices();
	let reads = 0;
	const original = store.readJson.bind(store);
	store.readJson = async (relPath) => {
		if (relPath === "state/devices.json") reads += 1;
		return original(relPath);
	};
	for (let i = 0; i < 400; i++) await store.touchDevice(device.id);
	assert.equal(reads, 0, "60 秒内的 touchDevice 不应再读 devices.json");
	const [cached] = await store.listDevices();
	cached.lastSeenAt = new Date(Date.now() - 120_000).toISOString();
	await store.touchDevice(device.id);
	assert.equal(reads, 1, "超过 60 秒应重新读盘；计数器本身也要能看见这次读取");
	await rm(home, { recursive: true, force: true });
});

test("插件设置路由拒绝带网关转发头的请求", async () => {
	const home = await makeTempHome("dshr-plugin-forward-");
	const previous = process.env.DSH_REMOTE_HOME;
	process.env.DSH_REMOTE_HOME = home;
	await writeFile(join(home, "config.json"), JSON.stringify({ autoStart: false, listenPort: 0 }));
	const routes = new Map();
	plugin.apply({
		get(name) {
			if (name === "webServer") {
				return {
					register(options) {
						routes.set(options.path, options.handler);
						return () => {};
					},
				};
			}
			return undefined;
		},
		effect(setup) {
			setup();
		},
	});
	try {
		const handler = routes.get("/dsh-remote/status");
		assert.equal(typeof handler, "function");
		let status = 0;
		handler({ headers: { "x-forwarded-host": "phone.example" }, method: "GET" }, {
			writeHead(code) {
				status = code;
				return this;
			},
			end() {},
			headersSent: false,
		});
		assert.equal(status, 403);
	} finally {
		if (previous === undefined) delete process.env.DSH_REMOTE_HOME;
		else process.env.DSH_REMOTE_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
});

test("edge 对端拒绝访客密钥后同一把密钥不再重试", async () => {
	let hits = 0;
	const pems = selfsigned.generate([{ name: "commonName", value: "peer" }], { days: 1, keySize: 2048 });
	const peer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
		hits += 1;
		req.resume();
		res.writeHead(403).end();
	});
	await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
	const port = peer.address().port;
	const session = new PeerDeviceSession(() => {});
	try {
		assert.equal(await session.ensure({ host: "127.0.0.1", port }, "wrong-visitor-key"), undefined);
		assert.equal(await session.ensure({ host: "127.0.0.1", port }, "wrong-visitor-key"), undefined);
		assert.equal(hits, 1);
		assert.equal(await session.ensure({ host: "127.0.0.1", port }, "other-visitor-key"), undefined);
		assert.equal(hits, 2);
	} finally {
		await new Promise((resolve) => peer.close(resolve));
	}
});

test("edge 换不到对端设备 Cookie 时 HTTP 和 WebSocket 都回 502", async () => {
	let pageHits = 0;
	const pems = selfsigned.generate([{ name: "commonName", value: "peer" }], { days: 1, keySize: 2048 });
	const peer = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
		req.resume();
		if (req.method === "POST" && (req.url ?? "").startsWith("/__dsh_remote__/login")) {
			res.writeHead(403).end("{}");
			return;
		}
		pageHits += 1;
		res.writeHead(302, { location: "/__dsh_remote__/login?next=%2F" }).end();
	});
	await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
	const peerPort = peer.address().port;
	const home = await makeTempHome("dshr-edge-502-");
	const store = await Store.open(home);
	await writeFile(store.path("state", "secrets.json"), `${JSON.stringify({
		frpAuthToken: "auth-token-ok!!",
		frpVisitorKey: "visitor-key-ok!!",
		adminToken: "admin-token-ok!!",
		instanceId: "abcdef0123456789",
	})}\n`);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		env: { ...process.env, DSHR_ACCESS_TOKEN: "edge-access-token" },
		config: {
			...structuredClone(DEFAULT_CONFIG),
			role: "edge",
			listenPort: 0,
			upstreamPort: 1,
			autoFixUpstreamPort: false,
			frp: { ...DEFAULT_CONFIG.frp, enabled: false, edge: "visitor", visitorBindPort: peerPort },
		},
	});
	await gateway.start();
	try {
		const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
		const login = await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "edge-access-token", name: "浏览器" }),
		});
		assert.equal(login.status, 200, login.body);
		const cookie = deviceCookieHeader(login.setCookie);
		const page = await requestTls(`${base}/`, { headers: { cookie, accept: "text/html" } });
		assert.equal(page.status, 502, page.body.slice(0, 200));
		assert.match(page.body, /对端网关尚未就绪/);
		const ws = wsConnect(`wss://127.0.0.1:${String(gateway.actualPort)}/ws`, { headers: { cookie } });
		try {
			assert.match(await ws.headersText, /^HTTP\/1\.1 502/);
		} finally {
			ws.close();
		}
		assert.equal(pageHits, 0, "502 不能把对端登录跳转透给浏览器");
	} finally {
		await gateway.stop();
		await new Promise((resolve) => peer.close(resolve));
		await rm(home, { recursive: true, force: true });
	}
});

test("对端登录跳转只重放一次，换不到 Cookie 则 502", async () => {
	const seen = [];
	const peer = http.createServer((req, res) => {
		const cookie = String(req.headers.cookie ?? "");
		seen.push(cookie);
		if (!cookie.includes("peer-token")) {
			res.writeHead(302, { location: "/__dsh_remote__/login?next=%2F" }).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/plain" }).end("proxied");
	});
	await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
	const peerPort = peer.address().port;
	const call = (port) => new Promise((resolve, reject) => {
		http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
		}).on("error", reject);
	});
	const renewed = http.createServer((req, res) => {
		proxyHttp(req, res, {
			host: "127.0.0.1",
			port: peerPort,
			sessionCookie: "dr_device_x=old",
			onUnauthorized: () => Promise.resolve("dr_device_aabbccddeeff0011=peer-token"),
		});
	});
	const denied = http.createServer((req, res) => {
		proxyHttp(req, res, {
			host: "127.0.0.1",
			port: peerPort,
			sessionCookie: "dr_device_x=old",
			onUnauthorized: () => Promise.resolve(undefined),
		});
	});
	await new Promise((resolve) => renewed.listen(0, "127.0.0.1", resolve));
	await new Promise((resolve) => denied.listen(0, "127.0.0.1", resolve));
	try {
		const ok = await call(renewed.address().port);
		assert.equal(ok.status, 200);
		assert.equal(ok.body, "proxied");
		assert.deepEqual(seen, ["dr_device_x=old", "dr_device_aabbccddeeff0011=peer-token"]);
		const failed = await call(denied.address().port);
		assert.equal(failed.status, 502);
		assert.match(failed.body, /对端网关登录失败/);
		assert.equal(seen.length, 3, "换不到 Cookie 时不得再重放");
	} finally {
		await Promise.all([renewed, denied, peer].map((server) => new Promise((resolve) => server.close(resolve))));
	}
});

test("缺 instanceId 的旧 secrets 会换 Cookie 名，旧 Cookie 不再有效", async () => {
	const home = await makeTempHome("dshr-migrate-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const legacy = {
		frpAuthToken: "auth-token-ok!!",
		frpVisitorKey: "visitor-key-ok!!",
		adminToken: "admin-token-ok!!",
	};
	await writeFile(store.path("state", "secrets.json"), `${JSON.stringify(legacy)}\n`);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "stcp", serverAddr: "127.0.0.1" },
		},
	});
	await gateway.start();
	try {
		const secrets = JSON.parse(await readFile(store.path("state", "secrets.json"), "utf8"));
		assert.equal(secrets.frpAuthToken, legacy.frpAuthToken);
		assert.equal(secrets.frpVisitorKey, legacy.frpVisitorKey);
		assert.equal(secrets.adminToken, legacy.adminToken);
		assert.match(secrets.instanceId, /^[0-9a-f]{16}$/);
		const base = `https://127.0.0.1:${String(gateway.actualPort)}`;
		const login = await requestTls(`${base}/__dsh_remote__/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: legacy.frpVisitorKey, name: "旧手机" }),
		});
		assert.equal(login.status, 200, login.body);
		const cookie = deviceCookieHeader(login.setCookie);
		assert.match(cookie, new RegExp(`^dr_device_${secrets.instanceId}=`));
		const value = cookie.slice(cookie.indexOf("=") + 1);
		assert.equal((await requestTls(`${base}/api/echo`, { headers: { cookie: `dr_device=${value}` } })).status, 401);
		assert.equal((await requestTls(`${base}/api/echo`, { headers: { cookie } })).status, 200);
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("入口口丢掉 LOCAL 和超长 PROXY 头，半包拼上后仍能进 health", async () => {
	const home = await makeTempHome("dshr-proxy-socket-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const gateway = new GatewayServer({
		store,
		log: () => {},
		config: {
			...structuredClone(DEFAULT_CONFIG),
			listenPort: 0,
			upstreamPort: upstream.port,
			autoFixUpstreamPort: false,
			frp: {
				...DEFAULT_CONFIG.frp,
				enabled: true,
				mode: "entry",
				remotePort: 18444,
				serverAddr: "127.0.0.1",
			},
		},
	});
	await gateway.start();
	const entry = gateway.publicEntryPort;
	const closed = (socket) => new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), 1000);
		socket.once("close", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
	try {
		assert.equal(typeof entry, "number");
		const local = net.connect({ host: "127.0.0.1", port: entry });
		await new Promise((resolve, reject) => {
			local.once("connect", resolve);
			local.once("error", reject);
		});
		const localHead = Buffer.alloc(16);
		Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]).copy(localHead);
		localHead[12] = 0x20;
		local.write(localHead);
		assert.equal(await closed(local), true, "LOCAL 命令没有客户端地址，入口口应断开");

		const huge = net.connect({ host: "127.0.0.1", port: entry });
		await new Promise((resolve, reject) => {
			huge.once("connect", resolve);
			huge.once("error", reject);
		});
		const prefix = Buffer.alloc(16);
		Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]).copy(prefix);
		prefix[12] = 0x21;
		prefix[13] = 0x11;
		prefix.writeUInt16BE(8000, 14);
		huge.write(Buffer.concat([prefix, Buffer.alloc(4082)]));
		assert.equal(await closed(huge), true, "超过 4096 字节仍不完整的 PROXY 头应断开");

		const header = proxyV2("203.0.113.9", 443);
		const raw = net.connect({ host: "127.0.0.1", port: entry });
		await new Promise((resolve, reject) => {
			raw.once("connect", resolve);
			raw.once("error", reject);
		});
		raw.write(header.subarray(0, 10));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(raw.destroyed, false, "PROXY 头被切成两半时要继续等，不能先断开");
		raw.write(header.subarray(10));
		const health = await new Promise((resolve, reject) => {
			const socket = tls.connect({ socket: raw, rejectUnauthorized: false });
			let buf = Buffer.alloc(0);
			socket.once("secureConnect", () => {
				socket.write(`GET /__dsh_remote__/health HTTP/1.1\r\nhost: 127.0.0.1:${String(entry)}\r\nconnection: close\r\n\r\n`);
			});
			socket.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); });
			socket.on("error", reject);
			socket.on("end", () => resolve(buf.toString("utf8")));
		});
		assert.match(health, /^HTTP\/1\.1 200/);
		assert.match(health, /"ok":true/);
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});

function proxyV2(srcIp, srcPort) {
	const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
	const addr = Buffer.alloc(12);
	srcIp.split(".").forEach((part, index) => { addr[index] = Number(part); });
	addr.writeUInt32BE(0x7f000001, 4);
	addr.writeUInt16BE(srcPort, 8);
	addr.writeUInt16BE(1, 10);
	const head = Buffer.alloc(16);
	sig.copy(head);
	head[12] = 0x21;
	head[13] = 0x11;
	head.writeUInt16BE(12, 14);
	return Buffer.concat([head, addr]);
}

function requestViaProxy(port, path, options = {}) {
	const srcIp = options.srcIp ?? "203.0.113.9";
	const method = options.method ?? "GET";
	const headers = options.headers ?? {};
	const body = options.body ?? "";
	return new Promise((resolve, reject) => {
		const raw = net.connect({ host: "127.0.0.1", port });
		raw.once("error", reject);
		raw.once("connect", () => {
			raw.write(proxyV2(srcIp, 443));
			const socket = tls.connect({ socket: raw, rejectUnauthorized: false });
			let buf = Buffer.alloc(0);
			socket.once("secureConnect", () => {
				const lines = [`${method} ${path} HTTP/1.1`, `host: 127.0.0.1:${String(port)}`];
				if (body.length > 0) lines.push(`content-length: ${String(Buffer.byteLength(body))}`);
				for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
				lines.push("connection: close", "", body);
				socket.write(lines.join("\r\n"));
			});
			socket.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); });
			socket.on("error", reject);
			socket.on("end", () => resolve(buf.toString("utf8")));
		});
	});
}
