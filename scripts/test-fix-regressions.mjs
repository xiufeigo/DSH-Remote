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
 *   - P1-3   无长度声明（chunked）> 2MB 的 HTML 直通不丢已缓冲前缀
 *   - P0-1   畸形绝对形式请求行不再击杀网关进程（URL 解析入 try）
 *   - P0-2   admin 门禁三重门（回环 + 同源 + secrets 管理密钥）
 *   - P3-10  WS 升级 head > 4KB 回 413（不再裸断连）
 *   - P3-8   POSIX 监听枚举解析器（ss/netstat/lsof）
 *   - GW-14   请求体超 64KB → 413（不再裸 destroy）
 *   - SEC-02/GW-15 畸形 JSON → 400（不再 500）
 *   - WEB-01  sw.js 内部路由：免认证 200 + service-worker-allowed + no-cache
 *   - WEB-02  mobile.js 静态资源 200 + ETag + javascript 类型
 *   - GW-17   逐跳响应头不转发：客户端 connection: close 语义生效
 *   - 0.1.3+ /api 流式 POST（官方原始文件上传）：边收边转、不设体积上限
 *
 * 运行：pnpm test:fixes（网关经 harness createTestGateway 以真实 CLI 子进程拉起，
 * 走完整启动链路：配置合并 → 环境变量剥离 → 单实例锁 → 监听）。
 */

import assert from "node:assert/strict";
import http from "node:http";
import tls from "node:tls";
import { test, after } from "node:test";
import { requestTls, createTestGateway, makeTempHome } from "./test-harness.mjs";

// ---------- 单元夹具：行为可编排的假上游 ----------

const seen = { acceptEncodings: [], cookies: [], upload: {}, signalFirstChunk: null };
const behavior = http.createServer((req, res) => {
	seen.acceptEncodings.push(req.headers["accept-encoding"] ?? null);
	seen.cookies.push(req.headers.cookie ?? null);
	const url = req.url ?? "";
	if (url.startsWith("/api/stream-upload")) {
		// 0.1.3+ 官方原始文件上传：/api 上的 POST + streaming request body
		//（ConnectionFetchRoute.requestBody = 'streaming'）。网关必须边收边转
		//（不得攒完整包再发），且不得对代理请求设体积上限。
		let total = 0;
		let signaled = false;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (!signaled) {
				signaled = true;
				seen.signalFirstChunk?.();
			}
		});
		req.on("end", () => {
			seen.upload = {
				total,
				transferEncoding: req.headers["transfer-encoding"] ?? null,
				contentLength: req.headers["content-length"] ?? null,
			};
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(seen.upload));
		});
		return;
	}
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
	if (url.startsWith("/chunked-big")) {
		// P1-3：无 content-length（chunked）的 3MB HTML —— 缓冲途中超限切直通时
		// 不得丢弃已缓冲前缀（旧实现静默截断：3MB 只送达 1MB）。
		// 前缀必须避开更靠前的 /big（声明长度路径）匹配。
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		const size = 3 * 1024 * 1024;
		const block = Buffer.alloc(64 * 1024, 0x61); // "a"
		for (let written = 0; written < size; written += block.length) {
			res.write(written + block.length <= size ? block : block.subarray(0, size - written));
		}
		res.end();
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
	assert.match(r.body, /__dsh_remote__\/sw\.js/, "小 HTML 应走注入路径");
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
	assert.ok(!r.body.includes("/__dsh_remote__/sw.js"), "直通路径不得注入");
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

// ---------- 本轮（t5）修复回归 ----------

/** 原始 TLS 请求：写入任意字节（可构造 Node https 客户端发不出的请求行），返回首个响应数据块。 */
function rawTlsExchange(port, rawBytes, { timeoutMs = 6_000 } = {}) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
			socket.write(rawBytes);
		});
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("原始 TLS 交换超时"));
		}, timeoutMs);
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			if (data.includes("\r\n")) {
				clearTimeout(timer);
				socket.destroy();
				resolve(data);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

test("P0-1：畸形绝对形式请求行回 4xx 且不击杀网关进程", async () => {
	// RFC 7230 绝对形式 + 越界端口：URL 构造抛 TypeError。旧代码解析在 try 之外
	// → 未处理 rejection → Node ≥15 默认 throw → 网关进程 exit 1（未认证单请求可打死）。
	const raw = await rawTlsExchange(
		gw.port,
		"GET http://x:99999/ HTTP/1.1\r\nhost: x:99999\r\nconnection: close\r\n\r\n",
	);
	assert.match(raw.split("\r\n")[0] ?? "", /^HTTP\/1\.1 4\d\d/, "应回 4xx 而非断连/5xx 之外的异常");
	// 网关必须仍然存活（同一子进程继续服务）
	const health = await requestTls(gwUrl("/__dsh_remote__/health"));
	assert.equal(health.status, 200, "网关不得因畸形请求行死亡");
});

test("P1-3：>2MB 无长度声明（chunked）的 HTML 直通不丢已缓冲前缀", async () => {
	// 注意路由前缀：必须避开 behavior 里更靠前的 /big（声明长度路径）匹配
	const r = await requestTls(gwUrl("/chunked-big"), {
		headers: { ...authHeaders, accept: "text/html" },
		timeoutMs: 30_000,
	});
	assert.equal(r.status, 200);
	assert.equal(r.raw.length, 3 * 1024 * 1024, "chunked 3MB 正文必须字节完整（旧实现静默截断为 1MB）");
	assert.ok(!r.body.includes("/__dsh_remote__/sw.js"), "直通路径不得注入");
	assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
});

test("0.1.3+ 流式 POST：官方原始文件上传边收边转（不缓冲）且无体积上限", async () => {
	// 官方 0.1.3+ 在 /api 上新增 POST + streaming request body 的精确路由
	//（dsh-client-file-upload）。网关必须满足两点：① 请求体边到边转（不能
	// 攒完再发，否则大文件上传会先整包驻留内存）；② 不设聚合体积上限。
	const PART = 2 * 1024 * 1024;
	const chunk1 = Buffer.alloc(PART, 0x41);
	const chunk2 = Buffer.alloc(PART, 0x42);
	let firstChunkResolve;
	const firstChunkSeen = new Promise((resolve) => {
		firstChunkResolve = resolve;
	});
	seen.signalFirstChunk = firstChunkResolve;

	const socket = tls.connect({ host: "127.0.0.1", port: gw.port, rejectUnauthorized: false });
	await new Promise((resolve, reject) => {
		socket.once("secureConnect", resolve);
		socket.once("error", reject);
	});
	let responseText = "";
	const responseDone = new Promise((resolve) => {
		const settle = () => resolve(responseText);
		socket.on("data", (chunk) => {
			responseText += chunk.toString("utf8");
			// 响应体就绪即 settle：不依赖 socket 'end'（上游可能声明 keep-alive，
			// 由 Node 的 keepAliveTimeout 收尾，会白等数秒且与断言无关）
			if (responseText.includes('"total"')) settle();
		});
		socket.on("end", settle);
		socket.on("close", settle);
	});

	socket.write(
		"POST /api/stream-upload HTTP/1.1\r\n" +
			"host: gateway.invalid\r\n" +
			`cookie: dr_device=${cookie}\r\n` +
			"content-type: application/octet-stream\r\n" +
			"transfer-encoding: chunked\r\n" +
			"connection: close\r\n\r\n",
	);
	socket.write(`${chunk1.length.toString(16)}\r\n`);
	socket.write(chunk1);
	socket.write("\r\n");

	// 关键断言：第一段尚未发完（后续还会写 chunk2）时，上游就必须已经收到字节。
	// 旧式「整包缓冲后再转发」的实现在这里会超时失败。
	let timer;
	try {
		await Promise.race([
			firstChunkSeen,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("首块未在请求体发送完成前到达上游：网关疑似缓冲整包后再转发")),
					5_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}

	socket.write(`${chunk2.length.toString(16)}\r\n`);
	socket.write(chunk2);
	socket.write("\r\n0\r\n\r\n");

	const text = await responseDone;
	socket.destroy();
	seen.signalFirstChunk = null;
	assert.match(text, /^HTTP\/1\.1 200/, `上传应成功透传：${text.slice(0, 200)}`);
	assert.equal(seen.upload.total, PART * 2, "4MB 正文必须字节完整送达（网关不得设体积上限或截断）");
	assert.equal(seen.upload.transferEncoding, "chunked", "无 content-length 的请求应以上游可接受的 chunked 形态转发");
});

test("P3-10：WS 升级 head > 4KB 回 413（不再裸断连）", async () => {
	// 认证后、代理前：升级请求头之后紧跟 8KB「head」字节 → 应答 413 而非 RST
	const head = await rawTlsExchange(
		gw.port,
		"GET /api/ws HTTP/1.1\r\n" +
			"host: gateway.invalid\r\n" +
			"upgrade: websocket\r\n" +
			"connection: Upgrade\r\n" +
			"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
			"sec-websocket-version: 13\r\n" +
			`cookie: dr_device=${cookie}\r\n` +
			"\r\n" +
			"0".repeat(8192),
	);
	assert.match(head.split("\r\n")[0] ?? "", /413/, "超限 head 应回 413");
});

test("P3-8：POSIX 监听枚举解析器（ss / netstat / lsof）", async () => {
	const { parsePosixListeners } = await import("../packages/gateway/src/upstream.ts");
	// ss -tlnpH：第 4 列 Local Address:Port；非回环/通配 host 与越界端口过滤
	const ss = parsePosixListeners([
		'LISTEN 0 511 127.0.0.1:52392 0.0.0.0:* users:(("node",pid=1,fd=20))',
		'LISTEN 0 511 *:18443 *:* users:(("dsh-remote",pid=2,fd=18))',
		'LISTEN 0 511 [::1]:52393 [::]:* users:(("node",pid=3,fd=9))',
		'LISTEN 0 511 192.168.1.4:9999 0.0.0.0:* users:(("x",pid=4,fd=9))',
		'LISTEN 0 511 127.0.0.1:99999 0.0.0.0:* users:(("y",pid=5,fd=9))',
		'LISTEN 0 511 127.0.0.1:52392 0.0.0.0:* users:(("dup",pid=6,fd=9))',
	].join("\n"), "ss");
	assert.deepEqual(ss.map((entry) => entry.port), [52392, 18443, 52393], "回环/通配端口去重采纳，其余过滤");
	assert.ok(ss.every((entry) => entry.dshRelated === false), "POSIX 不标注进程（排序优化缺席不影响正确性）");
	// netstat -tlnp：同样取第 4 列
	const netstat = parsePosixListeners([
		"Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program",
		"tcp        0      0 127.0.0.1:52392          0.0.0.0:*               LISTEN      1234/node",
		"tcp6       0      0 ::1:52393                :::*                    LISTEN      1235/node",
	].join("\n"), "netstat");
	assert.deepEqual(netstat.map((entry) => entry.port), [52392, 52393]);
	// lsof -nP -iTCP -sTCP:LISTEN：NAME 为倒数第 2 列
	const lsof = parsePosixListeners([
		"COMMAND   PID USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME",
		"node     1234 user   20u  IPv4  123456      0t0  TCP 127.0.0.1:52392 (LISTEN)",
		"node     1235 user   21u  IPv6  123457      0t0  TCP *:18443 (LISTEN)",
	].join("\n"), "lsof");
	assert.deepEqual(lsof.map((entry) => entry.port), [52392, 18443]);
	// 空输出/全脏行：空表（fail-safe 同旧版行为）
	assert.deepEqual(parsePosixListeners("", "ss"), []);
	assert.deepEqual(parsePosixListeners("garbage line\nanother", "lsof"), []);
});
console.log("fix-regressions：阶段 0/1 修复行为钉桩已就绪");
