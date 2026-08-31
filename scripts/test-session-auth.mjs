#!/usr/bin/env node
/**
 * DSH 0.1.2+ 浏览器会话适配回归测试。
 *
 * 背景：DSH 0.1.2-alpha.1 给 Web 宿主加了启动令牌认证 —— 未认证的
 * `GET /` 返回 401（纯文本），/api 与 WS upgrade 一律要求浏览器会话
 * cookie；cookie 只能由 `GET /?token=<启动令牌>` 交换取得。适配链路：
 *
 *   插件宿主（进程内 connection.authenticatedUrl() 取令牌）
 *     → POST /__dsh_remote__/admin/launch-token（createLaunchTokenDelivery；
 *       P0-2 起请求须携带 secrets adminToken 的 x-dshr-admin-token 头）
 *     → 网关 UpstreamSession 向上游交换 cookie（按 authority 缓存/重铸）
 *     → proxy.ts 注入 Cookie、剥 sec-fetch-site、剥上游 Set-Cookie、401 重铸。
 *
 * 覆盖：
 *   - UpstreamSession：令牌交换/缓存/authority 变化/401 失效重铸/节流/非
 *     dsh-auth cookie 忽略/TLS 上游不注入
 *   - buildUpstreamHeaders：设备 Cookie 剥离 + 会话 Cookie 注入 +
 *     sec-fetch-site 剥离 + Origin/Host 改写
 *   - hasDshFingerprint：0.1.2+ 的 401 指纹（否则端口自动探测失灵）
 *   - createLaunchTokenDelivery：下发成功/重试/放弃/令牌更换
 *   - 集成：真实网关 + 假上游 —— 令牌下发后反代请求携带会话 cookie、
 *     上游 Set-Cookie 不外泄手机端、上游 401 触发重铸后自愈
 *
 * 运行：node --test scripts/test-session-auth.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test, after } from "node:test";
import { buildUpstreamHeaders } from "../packages/gateway/src/proxy.ts";
import { UpstreamSession, DSH_UNAUTHORIZED_MARKER } from "../packages/gateway/src/session.ts";
import { hasDshFingerprint } from "../packages/gateway/src/upstream.ts";
import { createLaunchTokenDelivery } from "../packages/plugin/lib/index.js";
import { requestTls, wsConnect, createTestGateway, waitFor } from "./test-harness.mjs";

// ---------- Part 1：UpstreamSession 单元（fetch 全注入，无真实网络） ----------

/** 可编程假 fetch：按 URL 断言请求形态，返回编排的响应。 */
function fakeFetch(handler) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		return handler(url, init, calls);
	};
	impl.calls = calls;
	return impl;
}

function exchangeResponse(status, setCookie) {
	const headers = new Headers();
	if (setCookie !== undefined) headers.append("set-cookie", setCookie);
	return { status, headers, text: async () => "" };
}

test("session：无令牌时不注入，ensureCookie 记为 no-token", async () => {
	const logs = [];
	const session = new UpstreamSession({ log: (line) => logs.push(line) });
	const upstream = { host: "127.0.0.1", port: 52392 };
	assert.equal(session.cookieHeaderFor(upstream), undefined);
	assert.equal(await session.ensureCookie(upstream), false);
	assert.equal(session.state, "no-token");
	assert.ok(logs.some((line) => line.includes("启动令牌")));
});

test("session：令牌交换成功 → 按 authority 缓存并注入；TLS 上游永不注入", async () => {
	const fetchImpl = fakeFetch((url) => {
		assert.equal(new URL(url).searchParams.get("token"), "tok-1");
		return exchangeResponse(303, "dsh-auth-abc=cookieA; Path=/; HttpOnly; SameSite=Strict");
	});
	const session = new UpstreamSession({ fetchImpl, mintThrottleMs: 0 });
	session.setLaunchToken("tok-1");
	const upstream = { host: "127.0.0.1", port: 52392 };
	assert.equal(await session.ensureCookie(upstream), true);
	assert.equal(session.state, "ready");
	assert.equal(session.cookieHeaderFor(upstream), "dsh-auth-abc=cookieA");
	assert.ok(
		fetchImpl.calls.some((call) => call.url === "http://127.0.0.1:52392/?token=tok-1"),
		"交换 URL 必须精确指向上游 authority",
	);
	// TLS 上游（对端是另一台 PC 网关）：会话由对端负责，绝不注入
	assert.equal(session.cookieHeaderFor({ host: "127.0.0.1", port: 52392, tls: true }), undefined);
	assert.equal(await session.ensureCookie({ host: "127.0.0.1", port: 52392, tls: true }), false);
	// authority 变化（上游端口漂移）：为新 authority 重新交换
	fetchImpl.calls.length = 0;
	assert.equal(await session.ensureCookie({ host: "127.0.0.1", port: 60000 }), true);
	assert.ok(fetchImpl.calls.some((call) => call.url.includes("127.0.0.1:60000")));
	assert.equal(session.cookieHeaderFor({ host: "127.0.0.1", port: 60000 }), "dsh-auth-abc=cookieA");
});

test("session：上游 401（令牌失效）→ failed 不缓存；重发令牌后可恢复", async () => {
	const fetchImpl = fakeFetch((url) => {
		const token = new URL(url).searchParams.get("token");
		if (token === "stale") return exchangeResponse(401);
		return exchangeResponse(303, "dsh-auth-abc=cookieB");
	});
	const session = new UpstreamSession({ fetchImpl, mintThrottleMs: 0 });
	const upstream = { host: "127.0.0.1", port: 52392 };
	session.setLaunchToken("stale");
	assert.equal(await session.ensureCookie(upstream), false);
	assert.equal(session.state, "failed");
	assert.equal(session.cookieHeaderFor(upstream), undefined);
	// 插件重新下发新令牌（DSH 重启场景）→ 重新交换成功
	session.setLaunchToken("fresh");
	assert.equal(await session.ensureCookie(upstream), true);
	assert.equal(session.cookieHeaderFor(upstream), "dsh-auth-abc=cookieB");
});

test("session：非 dsh-auth 的 Set-Cookie 不采纳；空令牌 setToken 忽略", async () => {
	const fetchImpl = fakeFetch(() => exchangeResponse(303, "session_id=x; Path=/; HttpOnly"));
	const session = new UpstreamSession({ fetchImpl, mintThrottleMs: 0 });
	session.setLaunchToken("  ");
	assert.equal(session.hasToken, false);
	session.setLaunchToken("tok");
	assert.equal(await session.ensureCookie({ host: "127.0.0.1", port: 1 }), false);
	assert.equal(session.state, "failed");
	// 同一令牌重复下发是幂等的
	session.setLaunchToken("tok");
	assert.equal(session.hasToken, true);
});

test("session：401 失效重铸（invalidate）绕过节流并恢复", async () => {
	let mode = "ok";
	const fetchImpl = fakeFetch(() => {
		if (mode === "ok") return exchangeResponse(303, "dsh-auth-k=v1");
		return exchangeResponse(401);
	});
	const session = new UpstreamSession({ fetchImpl, mintThrottleMs: 30 });
	const upstream = { host: "127.0.0.1", port: 52392 };
	session.setLaunchToken("tok");
	assert.equal(await session.ensureCookie(upstream), true);
	assert.equal(session.cookieHeaderFor(upstream), "dsh-auth-k=v1");
	const fetchesBefore = fetchImpl.calls.length;
	// 上游开始拒绝（模拟 cookie 突然失效）：invalidate 清缓存并立即强制重铸
	// （绕过节流 —— 即使两次铸造间隔远小于节流窗口）
	mode = "down";
	session.invalidate(upstream);
	assert.equal(session.cookieHeaderFor(upstream), undefined);
	await waitFor("invalidate 触发强制重铸", () => fetchImpl.calls.length > fetchesBefore);
	// 重铸失败（401）→ 仍无 cookie；上游恢复后下一次 ensureCookie（网关补铸路径）恢复
	mode = "ok";
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(await session.ensureCookie(upstream), true);
	assert.equal(session.cookieHeaderFor(upstream), "dsh-auth-k=v1");
});

test("session：令牌更换时在途旧纪元交换结果不写入新纪元（P3-9）", async () => {
	// 可手动放行的 fetch 队列：第 1 次交换挂在途，模拟 DSH 重启换令牌的窗口期
	const pending = [];
	const fetchImpl = fakeFetch(() => new Promise((resolve) => pending.push(resolve)));
	const session = new UpstreamSession({ fetchImpl, mintThrottleMs: 0 });
	const upstream = { host: "127.0.0.1", port: 52392 };
	session.setLaunchToken("tok-old");
	const inflight = session.ensureCookie(upstream);
	// 交换途中令牌更换：缓存与在途表被清空，旧纪元结果必须被丢弃
	session.setLaunchToken("tok-new");
	pending[0](exchangeResponse(303, "dsh-auth-old=stale"));
	assert.equal(await inflight, false, "旧纪元交换不得令 ensureCookie 判定就绪");
	assert.equal(session.cookieHeaderFor(upstream), undefined, "旧纪元 cookie 不得进入新纪元缓存");
	// 新纪元以新令牌重新交换并就绪
	const second = session.ensureCookie(upstream);
	await waitFor("新纪元交换已发出", () => pending.length >= 2);
	assert.match(fetchImpl.calls[1]?.url ?? "", /token=tok-new/, "第二次交换必须携带新令牌");
	pending[1](exchangeResponse(303, "dsh-auth-new=fresh"));
	assert.equal(await second, true);
	assert.equal(session.cookieHeaderFor(upstream), "dsh-auth-new=fresh");
	assert.equal(session.state, "ready");
});

// ---------- Part 2：buildUpstreamHeaders 单元 ----------

test("proxy：设备 Cookie 剥离、会话 Cookie 注入、sec-fetch-site 剥离、寻址头改写", () => {
	const req = {
		headers: {
			host: "my-vps.example:8443",
			origin: "https://my-vps.example:8443",
			referer: "https://my-vps.example:8443/settings",
			cookie: "dr_device=phone-device-token; other=x",
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
			"content-type": "application/json",
		},
	};
	const base = buildUpstreamHeaders(req, { host: "127.0.0.1", port: 52392 });
	assert.equal(base.host, "127.0.0.1:52392");
	assert.equal(base.origin, "http://127.0.0.1:52392");
	assert.equal(base.referer, "http://127.0.0.1:52392/settings");
	assert.equal(base.cookie, undefined, "无会话时不得有 Cookie 头（设备 Cookie 剥离）");
	assert.equal(base["sec-fetch-site"], undefined, "sec-fetch-site 必须剥离");
	assert.equal(base["sec-fetch-mode"], "navigate", "未参与 fence 的头原样保留");
	assert.equal(base["content-type"], "application/json");

	const injected = buildUpstreamHeaders(req, {
		host: "127.0.0.1",
		port: 52392,
		sessionCookie: "dsh-auth-abc=cookieA",
	});
	assert.equal(injected.cookie, "dsh-auth-abc=cookieA", "会话 cookie 必须覆盖注入（设备 Cookie 不外泄）");
});

// ---------- Part 3：hasDshFingerprint 对 0.1.2+ 401 指纹的识别 ----------

async function listenOnce(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("upstream：0.1.2+ 未认证 401（固定文案）算命中指纹；旧版 200 指纹不受影响", async () => {
	const dsh012 = await listenOnce((req, res) => {
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
	});
	try {
		assert.equal(await hasDshFingerprint(dsh012.port), true, "0.1.2+ 的 401 必须识别为 DSH");
	} finally {
		await dsh012.close();
	}

	const other401 = await listenOnce((req, res) => {
		res.writeHead(401).end("unauthorized");
	});
	try {
		assert.equal(await hasDshFingerprint(other401.port), false, "无关服务的 401 不得误判");
	} finally {
		await other401.close();
	}

	const dshLegacy = await listenOnce((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><html><body>__dsh_boot__ ok</body></html>");
	});
	try {
		assert.equal(await hasDshFingerprint(dshLegacy.port), true, "旧版 200 指纹必须继续识别");
	} finally {
		await dshLegacy.close();
	}
	assert.ok(DSH_UNAUTHORIZED_MARKER.length > 0);
});

// ---------- Part 4：createLaunchTokenDelivery 单元 ----------

test("delivery：下发成功；网关未就绪时重试并放弃；令牌更换后重新下发", async () => {
	const sent = [];
	let mode = "down";
	const delivery = createLaunchTokenDelivery({
		port: () => 18443,
		requestAdmin: async (port, path, method, body) => {
			sent.push({ port, path, method, body });
			if (mode === "down") return undefined;
			if (mode === "ok") return { status: 200, body: '{"ok":true}' };
			return { status: 502, body: "nope" };
		},
		retryDelayMs: 1,
		attempts: 3,
	});
	// 网关持续不可达：setToken 触发后台投递，attempts 次后放弃（不抛错）
	delivery.setToken("tok-1");
	assert.equal(delivery.token, "tok-1");
	await waitFor("重试耗尽", () => sent.length >= 3);
	// 恢复后更换令牌（DSH 重启场景）→ 新一轮投递成功，body 携带新令牌
	mode = "ok";
	sent.length = 0;
	delivery.setToken("tok-2");
	await waitFor("delivery", () => sent.some((call) => call.body.includes("tok-2")));
	assert.equal(sent[0].path, "/__dsh_remote__/admin/launch-token");
	assert.equal(sent[0].method, "POST");
	assert.equal(sent[0].port, 18443);
});

// ---------- Part 5：集成 —— 真实网关 + 假上游 ----------

const TOKEN = "e2e-launch-token";
const upstreamSeen = { cookie: undefined, host: undefined, origin: undefined, secFetchSite: undefined, upgradeCookie: undefined };
/** 401 开关：置 true 时上游对所有请求回 401（触发网关 401→invalidate→重铸链路）。 */
const upstreamMode = { unauthorized: false };

const behavior = http.createServer((req, res) => {
	const parsed = new URL(`http://x${req.url ?? "/"}`);
	upstreamSeen.cookie = req.headers.cookie;
	upstreamSeen.host = req.headers.host;
	upstreamSeen.origin = req.headers.origin;
	upstreamSeen.secFetchSite = req.headers["sec-fetch-site"];
	if (upstreamMode.unauthorized) {
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
		return;
	}
	// 令牌交换端点：正确令牌 → 303 + 会话 cookie（模拟 DSH browser-auth）
	if (parsed.pathname === "/" && parsed.searchParams.has("token")) {
		if (parsed.searchParams.get("token") === TOKEN) {
			res.writeHead(303, {
				location: "/",
				"set-cookie": "dsh-auth-e2e=e2eCookieV1; Path=/; HttpOnly; SameSite=Strict",
			});
			res.end();
			return;
		}
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end(`${DSH_UNAUTHORIZED_MARKER}; bad token`);
		return;
	}
	// index：无/错会话 cookie → 401；正确 → 200
	if (parsed.pathname === "/") {
		if (req.headers.cookie !== "dsh-auth-e2e=e2eCookieV1") {
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end(`${DSH_UNAUTHORIZED_MARKER}; no session`);
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end("<!doctype html><html><head><title>e2e</title></head><body>__dsh_boot__ session ok</body></html>");
		return;
	}
	if (parsed.pathname === "/setcookie") {
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"set-cookie": "dsh-auth-e2e=shouldNotReachPhone; Path=/",
		});
		res.end("<!doctype html><html><body>__dsh_boot__ setcookie</body></html>");
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end("<!doctype html><html><body>__dsh_boot__ other</body></html>");
});
behavior.on("upgrade", (req, socket, head) => {
	upstreamSeen.upgradeCookie = req.headers.cookie;
	socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
	if (head.length > 0) socket.write(head);
	socket.pipe(socket);
});
await new Promise((resolve) => behavior.listen(0, "127.0.0.1", resolve));
const upstreamPort = behavior.address().port;

const gw = await createTestGateway({
	label: "session-e2e",
	config: { upstreamPort, listenPort: 0, autoFixUpstreamPort: false },
});
const gwUrl = (path) => `https://127.0.0.1:${String(gw.port)}${path}`;

const { Store } = await import("../packages/gateway/src/store.ts");
const store = await Store.open(gw.home);
// P0-2：admin 门禁密钥（网关子进程 start 时写进 gw.home 的 secrets.json）
const adminToken = (await store.ensureSecrets()).adminToken;
const adminHeaders = { "x-dshr-admin-token": adminToken };
await store.putPendingCode("SESS-TONE", 10);
const paired = await requestTls(gwUrl("/__dsh_remote__/pair"), {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ code: "sess-tone", name: "会话测试机" }),
});
assert.equal(paired.status, 200, `配对应成功：${paired.body}`);
const deviceCookie = /dr_device=([^;]+)/.exec(paired.setCookie)?.[1];
assert.ok(deviceCookie, "配对应签发 dr_device Cookie");
const authHeaders = { cookie: `dr_device=${deviceCookie}` };

after(async () => {
	await gw.destroy();
	await new Promise((resolve) => behavior.close(resolve));
});

test("集成：未下发令牌时，上游按无会话处理（本测试上游对无 cookie 返回 401 透传）", async () => {
	upstreamMode.unauthorized = false;
	const index = await requestTls(gwUrl("/"), { headers: authHeaders });
	assert.equal(index.status, 401, "未注入会话 cookie → 上游 401 原样透传");
	assert.ok(index.body.includes(DSH_UNAUTHORIZED_MARKER));
});

test("集成：admin/status 如实上报会话状态迁移 idle → ready（P2-5 回归）", async () => {
	// P2-5：session.ts 内部字段曾遮蔽同名 getter（TS2300；运行时侥幸读到活值）。
	// 钉桩 admin/status 上报路径：令牌下发前 idle，下发并交换成功后 ready。
	const before = await requestTls(gwUrl("/__dsh_remote__/admin/status"), {
		headers: { ...authHeaders, ...adminHeaders },
	});
	assert.equal(before.status, 200, `admin/status 应可访问：${before.body}`);
	assert.equal(JSON.parse(before.body).upstreamSession, "idle", "令牌下发前会话状态必须是 idle");
});

test("集成：下发令牌后，反代请求携带会话 cookie 且改写寻址头", async () => {
	const posted = await requestTls(gwUrl("/__dsh_remote__/admin/launch-token"), {
		method: "POST",
		headers: { "content-type": "application/json", ...adminHeaders },
		body: JSON.stringify({ token: TOKEN }),
	});
	assert.equal(posted.status, 200, `令牌下发应成功：${posted.body}`);
	await waitFor("会话 cookie 就绪", async () => {
		const status = await requestTls(gwUrl("/__dsh_remote__/admin/status"), {
			headers: { ...authHeaders, ...adminHeaders },
		});
		return status.status === 200 && JSON.parse(status.body).upstreamSession === "ready";
	});
	const index = await requestTls(gwUrl("/"), { headers: authHeaders });
	assert.equal(index.status, 200, `注入会话后 index 应 200：${index.body}`);
	assert.ok(index.body.includes("__dsh_boot__"));
	assert.equal(upstreamSeen.cookie, "dsh-auth-e2e=e2eCookieV1", "上游必须收到网关铸造的会话 cookie");
	assert.equal(upstreamSeen.host, `127.0.0.1:${String(upstreamPort)}`, "Host 必须改写为上游 authority");
	// 手机端跨站标记必须被剥离（/api fence 会拒绝 cross-site）
	const cross = await requestTls(gwUrl("/"), {
		headers: { ...authHeaders, "sec-fetch-site": "cross-site", origin: "https://my-vps.example:8443" },
	});
	assert.equal(cross.status, 200);
	assert.equal(upstreamSeen.secFetchSite, undefined, "sec-fetch-site 不得转发上游");
	assert.equal(upstreamSeen.origin, `http://127.0.0.1:${String(upstreamPort)}`, "Origin 必须改写为上游 authority");
	// 令牌绝不出现在网关响应里
	assert.ok(!index.body.includes(TOKEN), "启动令牌不得泄漏给手机端");
});

test("集成：上游下发的 Set-Cookie 不透传手机端（会话 cookie 不出网关）", async () => {
	const leak = await requestTls(gwUrl("/setcookie"), { headers: authHeaders });
	assert.equal(leak.status, 200);
	assert.equal(leak.setCookie, "", "上游 Set-Cookie 必须剥离，不得下发手机端");
});

test("集成：WS 升级请求同样注入会话 cookie（0.1.2+ upgrade 路径 401/403 与 HTTP 一致）", async () => {
	const handshake = await wsConnect(gwUrl("/api/ws"), { headers: authHeaders });
	handshake.socket.on("error", () => {}); // 测试收尾的连接重置不参与判定
	const text = await handshake.headersText;
	assert.ok(text.includes("101"), `升级应成功：${text.split("\r\n")[0]}`);
	assert.equal(upstreamSeen.upgradeCookie, "dsh-auth-e2e=e2eCookieV1", "升级请求必须携带会话 cookie");
	handshake.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
});

test("集成：上游 401 → 网关重铸会话 cookie → 自愈", async () => {
	upstreamMode.unauthorized = true;
	const denied = await requestTls(gwUrl("/"), { headers: authHeaders });
	assert.equal(denied.status, 401, "上游拒认证期间应 401");
	// 恢复上游；网关 invalidate 后重铸（节流绕过），补铸路径驱动自愈
	upstreamMode.unauthorized = false;
	await waitFor("401 自愈", async () => {
		const again = await requestTls(gwUrl("/"), { headers: authHeaders });
		return again.status === 200;
	}, 15_000);
	assert.equal(upstreamSeen.cookie, "dsh-auth-e2e=e2eCookieV1");
});
