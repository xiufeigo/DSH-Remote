#!/usr/bin/env node
/**
 * 阶段 0/1 修复回归测试（t10 · docs/review-fix-plan.md §5）。
 *
 * 覆盖（均为审查修复的行为级钉桩，防止未来改动悄悄回退）：
 *   - SEC-01  配对码并发核销恰好一次成功（进程级互斥闸）
 *   - GW-02   RateLimiter 窗口限流 / 失败锁定 / 桶上限淘汰 / 锁定桶保留
 *   - GW-03   clientIp 信任矩阵（伪造直连不采信、回环最左跳、::ffff 归一、
 *             默认不信任）+ t13 受信 CIDR（命中/未命中/精确 IP/非法条目容错）
 *   - GW-05   302 Location 剥权为相对路径（外部地址不重写）
 *   - GW-06   上游收到 accept-encoding: identity
 *   - GW-12   注入路径剥离 CSP 双头；直通路径保留上游 CSP
 *   - GW-16   声明长度 > 2MB 的 HTML 流式直通（不注入、正文完整）
 *   - GW-14   请求体超 64KB → 413（不再裸 destroy）
 *   - SEC-02/GW-15 畸形 JSON → 400（不再 500）
 *   - WEB-01  sw.js 内部路由：免认证 200 + service-worker-allowed + no-cache
 *   - WEB-02  mobile.js 静态资源 200 + ETag + javascript 类型
 *
 * 运行：pnpm test:fixes（网关经 harness createTestGateway 以真实 CLI 子进程拉起，
 * 走完整启动链路：配置合并 → 环境变量剥离 → 单实例锁 → 监听）。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test, after } from "node:test";
import { requestTls, createTestGateway, makeTempHome } from "./test-harness.mjs";

// ---------- 单元夹具：行为可编排的假上游 ----------

const seen = { acceptEncodings: [], cookies: [] };
const behavior = http.createServer((req, res) => {
	seen.acceptEncodings.push(req.headers["accept-encoding"] ?? null);
	seen.cookies.push(req.headers.cookie ?? null);
	const url = req.url ?? "";
	if (url.startsWith("/redir")) {
		// 绝对 Location 指回自己 → 网关必须剥成相对路径（GW-05）
		res.writeHead(302, { location: `http://127.0.0.1:${String(serverPort)}/dest?x=1` });
		res.end("");
		return;
	}
	if (url.startsWith("/ext-redir")) {
		// 外部绝对地址：不得被重写（GW-05 边界）
		res.writeHead(302, { location: "https://external.example/y" });
		res.end("");
		return;
	}
	if (url.startsWith("/csp")) {
		// 小于注入上限的 HTML：会走注入路径，CSP 必须被剥离、其他头保留（GW-12）
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": "frame-ancestors 'none'",
			"content-security-policy-report-only": "default-src 'self'",
			"x-upstream-marker": "kept",
		});
		res.end("<!doctype html><html><head><title>csp</title></head><body>__dsh_boot__ csp</body></html>");
		return;
	}
	if (url.startsWith("/big")) {
		// 声明长度 3MB > 2MB 注入上限：整条直通（GW-16），CSP 保留
		const body = "x".repeat(3 * 1024 * 1024);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": String(Buffer.byteLength(body)),
			"content-security-policy": "passthrough-must-keep",
		});
		res.end(body);
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end("<!doctype html><html><head><title>fx</title></head><body>__dsh_boot__ fx</body></html>");
});
await new Promise((resolve) => behavior.listen(0, "127.0.0.1", resolve));
const serverPort = behavior.address().port;

// ---------- 真实网关子进程（desktop 角色，默认配置 + 行为上游） ----------

const gw = await createTestGateway({
	label: "regression",
	config: { upstreamPort: serverPort, listenPort: 0 },
});
const gwUrl = (path) => `https://127.0.0.1:${String(gw.port)}${path}`;

const { Store } = await import("../packages/gateway/src/store.ts");
const store = await Store.open(gw.home);
await store.putPendingCode("REGS-TONE", 10);
const paired = await requestTls(gwUrl("/__dsh_remote__/pair"), {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ code: "regs-tone", name: "回归测试机" }),
});
assert.equal(paired.status, 200, `配对应成功：${paired.body}`);
const cookie = /dr_device=([^;]+)/.exec(paired.setCookie)?.[1];
assert.ok(cookie, "配对应签发 dr_device Cookie");
const authHeaders = { cookie: `dr_device=${cookie}` };

after(async () => {
	await gw.destroy();
	await new Promise((resolve) => behavior.close(resolve));
});

// ---------- SEC-01 / GW-02 / GW-03：内存级钉桩 ----------

test("SEC-01：并发核销同一配对码恰好一个成功，队列不因失败断裂", async () => {
	const home = await makeTempHome("dshr-reg-sec01-");
	const st = await Store.open(home);
	await st.putPendingCode("ABCD-EFGH", 5);
	const results = await Promise.all(Array.from({ length: 10 }, () => st.consumePendingCode("ABCD-EFGH")));
	assert.equal(results.filter(Boolean).length, 1, "10 路并发消费必须恰好 1 路成功");
	// 消费失败/码不存在不得断裂互斥队列
	assert.equal(await st.consumePendingCode("0000-0000"), false);
	await st.putPendingCode("ABCD-EFGH", 5);
	assert.equal(await st.consumePendingCode("ABCD-EFGH"), true, "队列在失败后仍可正常签发/核销");
});

test("GW-02：窗口限流、失败锁定、容量淘汰与锁定桶保留", async () => {
	const { RateLimiter } = await import("../packages/gateway/src/auth.ts");
	const limiter = new RateLimiter(5, 2, 15);
	try {
		for (let i = 0; i < 5; i++) assert.ok(limiter.allow("9.9.9.1"), `第 ${String(i + 1)} 次应放行`);
		assert.ok(!limiter.allow("9.9.9.1"), "第 6 次应限流");
		assert.ok(limiter.notePairFail("9.9.9.2"), "1 次失败未达阈值");
		assert.ok(!limiter.notePairFail("9.9.9.2"), "2 次失败应锁定");
		assert.ok(limiter.isLocked("9.9.9.2"), "锁定状态可查询");
		assert.ok(!limiter.allow("9.9.9.2"), "锁定期内 allow 必须拒绝");
		// 容量灌满：超限后桶数封顶、锁定桶不被淘汰
		for (let i = 0; i < RateLimiter.MAX_BUCKETS + 800; i++) limiter.allow(`10.${String((i >> 8) & 0xff)}.${String(i & 0xff)}.${String(i % 7 + 1)}`);
		assert.ok(limiter.size <= RateLimiter.MAX_BUCKETS, `桶数 ${String(limiter.size)} 必须封顶于 ${String(RateLimiter.MAX_BUCKETS)}`);
		assert.ok(limiter.isLocked("9.9.9.2"), "锁定中的桶不得被容量淘汰");
	} finally {
		limiter.stop();
	}
});

test("GW-03/t13：clientIp 信任矩阵（回环 + 受信 CIDR + 归一化 + 容错）", async () => {
	const { clientIp } = await import("../packages/gateway/src/auth.ts");
	const reqMock = (remote, xff) => ({
		socket: { remoteAddress: remote },
		headers: xff === undefined ? {} : { "x-forwarded-for": xff },
	});
	const cfg = (auth) => ({ auth });
	// 缺省与未开启：一律 socket 地址
	assert.equal(clientIp(reqMock("127.0.0.1", "203.0.113.7")), "127.0.0.1");
	assert.equal(clientIp(reqMock("127.0.0.1", "203.0.113.7"), cfg({})), "127.0.0.1");
	// 外部直连伪造 XFF：不采信
	assert.equal(clientIp(reqMock("203.0.113.9", "1.1.1.1"), cfg({ trustProxyXff: true })), "203.0.113.9");
	// 回环 + 开启：取最左跳；::ffff: 回环同理
	assert.equal(clientIp(reqMock("127.0.0.1", "203.0.113.7, 10.0.0.1"), cfg({ trustProxyXff: true })), "203.0.113.7");
	assert.equal(clientIp(reqMock("::ffff:127.0.0.1", "8.8.8.8"), cfg({ trustProxyXff: true })), "8.8.8.8");
	// 输出归一化：外部 ::ffff 映射去前缀
	assert.equal(clientIp(reqMock("::ffff:203.0.113.9")), "203.0.113.9");
	// t13：compose 容器网段命中 CIDR → 采信
	assert.equal(clientIp(reqMock("172.18.0.2", "203.0.113.5"), cfg({ trustProxyXff: true, trustProxyCidrs: ["172.16.0.0/12"] })), "203.0.113.5");
	// t13：网段不命中 → 不采信
	assert.equal(clientIp(reqMock("192.168.1.5", "203.0.113.5"), cfg({ trustProxyXff: true, trustProxyCidrs: ["172.16.0.0/12"] })), "192.168.1.5");
	// t13：纯 IP 精确匹配（无 / 按 /32）
	assert.equal(clientIp(reqMock("10.1.2.3", "203.0.113.6"), cfg({ trustProxyXff: true, trustProxyCidrs: ["10.1.2.3"] })), "203.0.113.6");
	// t13：非法条目（坏前缀/坏地址）忽略、不崩、不采信
	assert.equal(clientIp(reqMock("10.1.2.3", "203.0.113.6"), cfg({ trustProxyXff: true, trustProxyCidrs: ["not-an-ip/99", "10.1.2.3/33"] })), "10.1.2.3");
	// t13：未开 trustProxyXff 时 CIDR 不参与判定
	assert.equal(clientIp(reqMock("172.18.0.2", "203.0.113.5"), cfg({ trustProxyCidrs: ["172.16.0.0/12"] })), "172.18.0.2");
});

// ---------- 行为级：真实子进程网关 + 反代路径 ----------

test("WEB-01：sw.js 免认证 200，scope/no-cache/nosniff 头齐全", async () => {
	const r = await requestTls(gwUrl("/__dsh_remote__/sw.js"));
	assert.equal(r.status, 200);
	assert.match(String(r.headers["content-type"]), /javascript/);
	assert.equal(r.headers["service-worker-allowed"], "/");
	assert.match(String(r.headers["cache-control"]), /no-cache/);
	assert.equal(r.headers["x-content-type-options"], "nosniff");
});

test("SEC-02/GW-15：配对端点畸形 JSON 回 400（不再 500）", async () => {
	const r = await requestTls(gwUrl("/__dsh_remote__/pair"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{{{bad json",
	});
	assert.equal(r.status, 400);
	assert.match(r.body, /invalid-json|json/i);
});

test("GW-14：请求体超 64KB 回标准 413", async () => {
	const r = await requestTls(gwUrl("/__dsh_remote__/pair"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: "ABCD-EFGH", filler: "x".repeat(70 * 1024) }),
	});
	assert.equal(r.status, 413);
});

test("GW-05：302 绝对 Location（上游 authority）剥为相对路径，外部地址不动", async () => {
	const r = await requestTls(gwUrl("/redir"), { headers: authHeaders });
	assert.equal(r.status, 302);
	assert.equal(r.headers.location, "/dest?x=1", "上游自身 authority 必须剥离");
	const ext = await requestTls(gwUrl("/ext-redir"), { headers: authHeaders });
	assert.equal(ext.headers.location, "https://external.example/y", "外部绝对地址不得被改写");
});

test("GW-12 + GW-06：注入路径剥 CSP 双头并保留其他上游头；上游收到 identity", async () => {
	seen.acceptEncodings.length = 0;
	const r = await requestTls(gwUrl("/csp"), { headers: { ...authHeaders, accept: "text/html" } });
	assert.equal(r.status, 200);
	assert.match(r.body, /manifest\.webmanifest/, "小 HTML 应走注入路径");
	assert.equal(r.headers["content-security-policy"], undefined, "注入路径必须剥 CSP");
	assert.equal(r.headers["content-security-policy-report-only"], undefined, "report-only 同剥");
	assert.equal(r.headers["x-upstream-marker"], "kept", "非 CSP 头不得误伤");
	assert.ok(seen.acceptEncodings.includes("identity"), "上游必须收到 accept-encoding: identity");
});

test("GW-16：>2MB 声明长度的 HTML 流式直通（正文完整、不注入、CSP 保留）", async () => {
	const r = await requestTls(gwUrl("/big"), { headers: { ...authHeaders, accept: "text/html" } });
	assert.equal(r.status, 200);
	assert.equal(r.raw.length, 3 * 1024 * 1024, "3MB 正文必须字节完整");
	assert.equal(r.headers["content-security-policy"], "passthrough-must-keep", "直通路径保留上游 CSP");
	assert.ok(!r.body.includes("manifest.webmanifest"), "直通路径不得注入");
});

test("WEB-02：mobile.js 静态资源 200 + ETag + javascript 类型", async () => {
	const r = await requestTls(gwUrl("/__dsh_remote__/mobile.js"), { headers: authHeaders });
	assert.equal(r.status, 200);
	assert.match(String(r.headers["content-type"]), /javascript/);
	assert.ok(String(r.headers.etag ?? "").length > 0, "mobile.js 必须带 ETag");
});

test("安全边界：设备 Cookie 不外泄上游", async () => {
	seen.cookies.length = 0;
	await requestTls(gwUrl("/csp"), { headers: { ...authHeaders, accept: "text/html" } });
	assert.ok(seen.cookies.every((c) => c === null), "上游任何请求都不得收到设备 Cookie");
});

test("P0-2：admin 门禁要求 secrets 管理密钥——缺失/错误 403，正确 200", async () => {
	const { adminToken } = await store.ensureSecrets();
	const ok = await requestTls(gwUrl("/__dsh_remote__/admin/status"), {
		headers: { "x-dshr-admin-token": adminToken },
	});
	assert.equal(ok.status, 200);
	assert.match(ok.body, /certFingerprint/);
	const none = await requestTls(gwUrl("/__dsh_remote__/admin/status"));
	assert.equal(none.status, 403, "无密钥头必须 403（同机反代转发的公网流量同样没有密钥）");
	const wrong = await requestTls(gwUrl("/__dsh_remote__/admin/status"), {
		headers: { "x-dshr-admin-token": "wrong-secret" },
	});
	assert.equal(wrong.status, 403, "错误密钥必须 403");
	// 攻击原语封死：公网侧（无密钥）不得铸造配对码（曾可经此绕过全部认证门）
	const mint = await requestTls(gwUrl("/__dsh_remote__/admin/pair-code"), { method: "POST" });
	assert.equal(mint.status, 403, "无密钥不得铸造配对码");
});

console.log("fix-regressions：阶段 0/1 修复行为钉桩已就绪");
