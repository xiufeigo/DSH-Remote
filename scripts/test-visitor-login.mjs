import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../packages/gateway/src/config.ts";
import { hashAccessToken, MAX_VISITOR_KEY_LENGTH, verifyAccessToken, verifyLoginSecret } from "../packages/gateway/src/auth.ts";
import { GatewayServer } from "../packages/gateway/src/server.ts";
import { Store } from "../packages/gateway/src/store.ts";
import { validateConfigPatch } from "../packages/plugin/lib/config-schema.js";
import { makeTempHome, requestTls, startFakeUpstream, wsConnect } from "./test-harness.mjs";

const visitorKey = "custom-visitor-key-for-browser";

async function fixture(overrides = {}) {
	const home = await makeTempHome("dshr-visitor-login-");
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	const secrets = await store.ensureSecrets();
	await store.writeAtomic("state/secrets.json", JSON.stringify({ ...secrets, frpVisitorKey: visitorKey }));
	const config = {
		...structuredClone(DEFAULT_CONFIG), listenPort: 0, upstreamPort: upstream.port, autoFixUpstreamPort: false,
		// 仅测 HTTPS 认证；不启动 frpc，真实双通道另由 smoke:dual:frp 覆盖。
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "entry" }, ...overrides,
	};
	let gateway = new GatewayServer({ store, config, env: {} });
	await gateway.start();
	return {
		store,
		call: (path, options) => requestTls(`https://127.0.0.1:${gateway.actualPort}${path}`, options),
		async upgrade(cookie, status) {
			const ws = wsConnect(`wss://127.0.0.1:${gateway.actualPort}/ws`, { headers: cookie ? { cookie } : {} });
			try { assert.match(await ws.headersText, new RegExp(`^HTTP/1.1 ${status}`)); }
			finally { ws.close(); }
		},
		async rotate(key) {
			await gateway.stop();
			await store.writeAtomic("state/secrets.json", JSON.stringify({ ...await store.ensureSecrets(), frpVisitorKey: key }));
			gateway = new GatewayServer({ store, config, env: {} });
			await gateway.start();
		},
		async close() {
			await gateway.stop();
			await upstream.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

const login = (f, token) => f.call("/__dsh_remote__/login", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "网页访客" }),
});

test("访客密钥与插件长度契约一致，edge Token 保留原上限", () => {
	const key = "k".repeat(MAX_VISITOR_KEY_LENGTH);
	assert.equal(validateConfigPatch({ visitorKey: key }).ok, true);
	assert.equal(verifyLoginSecret(key, hashAccessToken(key)), true);
	assert.equal(verifyAccessToken(key, hashAccessToken(key)), false);
	assert.equal(validateConfigPatch({ visitorKey: `${key}k` }).ok, false);
	assert.equal(verifyLoginSecret(`${key}k`, hashAccessToken(`${key}k`)), false);
	assert.equal(verifyLoginSecret("", hashAccessToken("")), false);
	assert.equal(verifyLoginSecret(visitorKey, undefined), false);
});

test("公网输入自定义访客密钥：页面不泄露密钥，Cookie 同时授权 HTTP/WS，不授权 admin", async () => {
	const f = await fixture();
	try {
		const redirect = await f.call("/chat?thread=abc", { headers: { accept: "text/html" } });
		assert.equal(redirect.status, 302);
		assert.match(redirect.headers.location, /^\/__dsh_remote__\/login\?next=/);
		const page = await f.call(redirect.headers.location);
		assert.equal(page.status, 200);
		assert.match(page.body, /type="password" aria-label="访客密钥"/);
		assert.ok(!page.body.includes(visitorKey));
		assert.equal(page.headers["cache-control"], "no-store");
		assert.equal((await f.call("/api/test")).status, 401);
		await f.upgrade(undefined, 401);
		for (const wrong of ["wrong-key", { key: visitorKey }]) {
			const result = await login(f, wrong);
			assert.equal(result.status, 403);
			assert.match(result.body, /访客密钥无效/);
			assert.equal(result.setCookie, "");
		}
		assert.equal((await f.store.listDevices()).length, 0);
		const result = await login(f, visitorKey);
		assert.equal(result.status, 200);
		assert.match(result.setCookie, /HttpOnly; Secure; SameSite=Lax/);
		const cookie = result.setCookie.split(";")[0];
		assert.match((await f.call("/", { headers: { cookie } })).body, /__dsh_boot__/);
		assert.equal((await f.call("/api/test", { headers: { cookie } })).status, 200);
		await f.upgrade(cookie, 101);
		assert.equal((await f.call("/__dsh_remote__/admin/pair-code", { method: "POST", headers: { cookie } })).status, 403);
		assert.equal((await f.call("/__dsh_remote__/login", { headers: { cookie } })).status, 302);
		const [device] = await f.store.listDevices();
		assert.equal(device.credentialHash, hashAccessToken(visitorKey));
		for (const file of ["state/devices.json", "logs/audit.jsonl"]) {
			assert.ok(!(await readFile(f.store.path(file), "utf8")).includes(visitorKey));
		}
		await f.store.revokeDevice(device.id);
		assert.equal((await f.call("/api/test", { headers: { cookie } })).status, 401);
		await f.upgrade(cookie, 401);
	} finally { await f.close(); }
});

test("改访客密钥并重启后：旧密钥和旧/未绑定 Cookie 失效，新密钥可用", async () => {
	const f = await fixture();
	try {
		const legacy = await f.store.addDevice("历史配对设备");
		const legacyCookie = `dr_device=${legacy.token}`;
		assert.equal((await f.call("/api/test", { headers: { cookie: legacyCookie } })).status, 401);
		const first = await login(f, visitorKey);
		assert.equal(first.status, 200);
		const cookie = first.setCookie.split(";")[0];
		assert.equal((await f.call("/api/test", { headers: { cookie } })).status, 200);
		await f.rotate(visitorKey);
		assert.equal((await f.call("/api/test", { headers: { cookie } })).status, 200, "同密钥重启保留会话");
		await f.store.putPendingCode("ABCD-2345", 10);
		const paired = await f.call("/__dsh_remote__/pair", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "ABCD-2345" }),
		});
		assert.equal(paired.status, 200, "保留 CLI 配对兼容入口");
		const pairedCookie = paired.setCookie.split(";")[0];
		assert.equal((await f.call("/api/test", { headers: { cookie: pairedCookie } })).status, 200);
		const rotatedKey = "new-custom-visitor-key";
		await f.rotate(rotatedKey);
		assert.equal((await f.call("/api/test", { headers: { cookie } })).status, 401);
		assert.equal((await f.call("/api/test", { headers: { cookie: pairedCookie } })).status, 401);
		await f.upgrade(cookie, 401);
		assert.equal((await f.call("/__dsh_remote__/login", { headers: { cookie } })).status, 200);
		assert.equal((await login(f, visitorKey)).status, 403);
		const current = await login(f, rotatedKey);
		assert.equal(current.status, 200);
		const currentCookie = current.setCookie.split(";")[0];
		assert.equal((await f.call("/api/test", { headers: { cookie: currentCookie } })).status, 200);
		await f.upgrade(currentCookie, 101);
	} finally { await f.close(); }
});

test("错误访客密钥触发既有锁定，锁定期间正确密钥也不能登录", async () => {
	const f = await fixture({ pairingFailLockThreshold: 2 });
	try {
		assert.equal((await login(f, "wrong-key")).status, 403);
		assert.equal((await login(f, "wrong-key")).status, 429);
		assert.equal((await login(f, visitorKey)).status, 429);
		assert.equal((await f.store.listDevices()).length, 0);
	} finally { await f.close(); }
});
