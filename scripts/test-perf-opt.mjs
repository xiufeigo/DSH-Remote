#!/usr/bin/env node
/**
 * PERF-01/PERF-02 回归测试（审查 REVIEW-01/REVIEW-02 落地）。
 *
 * 背景：网关反代曾一刀切 `accept-encoding: identity`（GW-06），静态大包在
 * 手机隧道上裸奔；SW 是网络优先，冷启动每次全量拉。本轮改为选择性压缩 +
 * 网关侧即时压缩 + SWR，审查要求补测试缺口。
 *
 * 覆盖：
 *   - wantsHtmlIdentity：导航/目录/.html/Accept 判定，POST/接口不强制 identity
 *   - acceptedEncodings/selectGatewayEncoding：q 值解析（`br;q=0` 不得选中）
 *   - shouldGatewayCompress：静态文本压、/api/SSE/已压/非 200/无客户端编码不压
 *   - proxyHttp 端到端（假上游 + 真 proxyHttp）：JS 网关 gzip 下发且 etag 已剥、
 *     br 优先、无编码客户端拿 identity、HTML 注入且 identity、压缩 HTML 解压
 *     后注入、未知编码原样直通、/api JSON 不压、HEAD 无 body、上游收到的
 *     accept-encoding 符合预期（导航 identity / 静态透传）
 *   - renderServiceWorker：缓存 v2、白名单与导航/API 隔离、归一化 key、
 *     真回源、no-cache 不进缓存
 *
 * 运行：node --test scripts/test-perf-opt.mjs（需 node>=24 类型剥离，与
 * test-session-auth.mjs 一致；本机 node20 跑可用 bun 代替验证）。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import test from "node:test";
import zlib from "node:zlib";
import {
	acceptedEncodings,
	buildUpstreamHeaders,
	isApiPath,
	pathnameOf,
	proxyHttp,
	selectGatewayEncoding,
	shouldGatewayCompress,
	wantsHtmlIdentity,
} from "../packages/gateway/src/proxy.ts";
import { renderServiceWorker } from "../packages/gateway/src/pwa.ts";

/** 构造最小假 IncomingMessage 形态（纯函数入参用）。 */
function fakeReq({ method = "GET", url = "/", headers = {} } = {}) {
	return { method, url, headers };
}

// ---------- Part 1：wantsHtmlIdentity ----------

test("wantsHtmlIdentity：导航强制 identity，静态/接口不强制", () => {
	assert.equal(wantsHtmlIdentity(fakeReq({ url: "/" })), true);
	assert.equal(wantsHtmlIdentity(fakeReq({ url: "/foo/" })), true);
	assert.equal(wantsHtmlIdentity(fakeReq({ url: "/index.html" })), true);
	assert.equal(
		wantsHtmlIdentity(fakeReq({ url: "/session/123", headers: { accept: "text/html,application/xhtml+xml" } })),
		true,
	);
	assert.equal(
		wantsHtmlIdentity(fakeReq({ url: "/assets/app-abc.js", headers: { accept: "*/*" } })),
		false,
	);
	assert.equal(wantsHtmlIdentity(fakeReq({ url: "/api/", headers: { accept: "application/json" } })), false);
	assert.equal(
		wantsHtmlIdentity(fakeReq({ method: "POST", url: "/", headers: { accept: "text/html" } })),
		false,
	);
});

// ---------- Part 2：编码选择（含 q 值） ----------

test("selectGatewayEncoding：br 优先，q=0 不选中，无声明返回 undefined", () => {
	assert.equal(selectGatewayEncoding("gzip, deflate, br"), "br");
	assert.equal(selectGatewayEncoding("gzip"), "gzip");
	assert.equal(selectGatewayEncoding("gzip, br;q=0"), "gzip");
	assert.equal(selectGatewayEncoding("br;q=0, gzip;q=0"), undefined);
	assert.equal(selectGatewayEncoding(undefined), undefined);
	assert.equal(selectGatewayEncoding("identity"), undefined);
	assert.equal(acceptedEncodings("br;q=0").has("br"), false);
	assert.equal(acceptedEncodings("GZip; q=0.5").has("gzip"), true);
});

// ---------- Part 3：shouldGatewayCompress ----------

test("shouldGatewayCompress：只压静态文本，非静态/流式/已压不碰", () => {
	const js = fakeReq({ url: "/assets/app.js", headers: { "accept-encoding": "gzip, deflate, br" } });
	assert.equal(shouldGatewayCompress(js, 200, { "content-type": "application/javascript" }), true);
	assert.equal(
		shouldGatewayCompress(js, 200, { "content-type": "text/css; charset=utf-8" }),
		true,
	);
	assert.equal(shouldGatewayCompress(js, 200, { "content-type": "font/woff2" }), false);
	assert.equal(shouldGatewayCompress(js, 200, { "content-type": "image/png" }), false);
	assert.equal(
		shouldGatewayCompress(
			fakeReq({ url: "/api/history", headers: { "accept-encoding": "gzip" } }),
			200,
			{ "content-type": "application/json" },
		),
		false,
	);
	assert.equal(
		shouldGatewayCompress(js, 200, { "content-type": "text/event-stream" }),
		false,
	);
	assert.equal(
		shouldGatewayCompress(js, 200, { "content-type": "application/javascript", "content-encoding": "gzip" }),
		false,
	);
	assert.equal(shouldGatewayCompress(js, 304, { "content-type": "application/javascript" }), false);
	assert.equal(
		shouldGatewayCompress(
			fakeReq({ method: "POST", url: "/assets/app.js", headers: { "accept-encoding": "gzip" } }),
			200,
			{ "content-type": "application/javascript" },
		),
		false,
	);
	assert.equal(
		shouldGatewayCompress(fakeReq({ url: "/assets/app.js", headers: {} }), 200, {
			"content-type": "application/javascript",
		}),
		false,
	);
});

// ---------- Part 4：buildUpstreamHeaders 透传语义 ----------

test("buildUpstreamHeaders：导航 identity，无编码客户端不冒充压缩", () => {
	const nav = buildUpstreamHeaders(
		fakeReq({ url: "/", headers: { accept: "text/html", "accept-encoding": "gzip, br" } }),
		{ host: "127.0.0.1", port: 9999 },
	);
	assert.equal(nav["accept-encoding"], "identity");

	const js = buildUpstreamHeaders(
		fakeReq({ url: "/a.js", headers: { "accept-encoding": "gzip, deflate, br" } }),
		{ host: "127.0.0.1", port: 9999 },
	);
	assert.equal(js["accept-encoding"], "gzip, deflate, br");

	const plain = buildUpstreamHeaders(fakeReq({ url: "/a.js", headers: {} }), { host: "127.0.0.1", port: 9999 });
	assert.equal(plain["accept-encoding"], "identity");
});

// ---------- Part 5：proxyHttp 端到端 ----------

const JS_BODY = `console.log("dsh-remote perf test");\n`.repeat(2000);
const HTML_PAGE = "<!doctype html><html><head><title>t</title></head><body>hello</body></html>";

/** 假上游：记录各路径收到的 accept-encoding，分路径返回编排响应。 */
async function startPerfUpstream() {
	const seen = {};
	const server = http.createServer((req, res) => {
		const url = String(req.url ?? "/").split("?", 1)[0];
		seen[url] = String(req.headers["accept-encoding"] ?? "");
		if (url === "/app.js") {
			res.writeHead(200, {
				"content-type": "application/javascript; charset=utf-8",
				"content-length": String(Buffer.byteLength(JS_BODY)),
				etag: '"upstream-etag"',
			});
			res.end(JS_BODY);
		} else if (url === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"html-etag"' });
			res.end(HTML_PAGE);
		} else if (url === "/gzipped.html") {
			const gz = zlib.gzipSync(Buffer.from(HTML_PAGE, "utf8"));
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
			res.end(gz);
		} else if (url === "/zstd.html") {
			// 网关不认识的编码：必须原样直通，不得删头解码
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "zstd" });
			res.end("ZSTD-BYTES");
		} else if (url === "/api/data") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		} else if (url === "/api/page") {
			// 接口即使回 HTML 也不注入（与 wantsHtmlIdentity 的 /api 排除一致）
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("APIHTML");
		} else if (url === "/vary.js") {
			// 上游自带 Vary：网关压缩必须追加而非覆盖
			res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", vary: "Origin" });
			res.end(JS_BODY);
		} else if (url === "/cap.html") {
			// 压缩体小（走缓冲），解后超 2MB 上限：回退原压缩字节直通
			const big = "A".repeat(2_300_000);
			const gz = zlib.gzipSync(Buffer.from(big, "utf8"));
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-encoding": "gzip",
				"content-length": String(gz.length),
			});
			res.end(gz);
		} else if (url === "/big-chunked.html") {
			// 分块、无长度声明、压缩标记、总量超限：overflow 回退必须恢复编码头
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
			const chunk = randomBytes(256 * 1024);
			for (let i = 0; i < 10; i++) res.write(chunk);
			res.end();
		} else {
			res.writeHead(404).end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port, seen };
}

/** 在本机起一个 proxyHttp 前端，返回基地址。 */
async function startProxyFront(upstream) {
	const server = http.createServer((req, res) => {
		proxyHttp(req, res, upstream, (body) => Buffer.concat([body, Buffer.from("<!--injected-->")]));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, base: `http://127.0.0.1:${String(server.address().port)}` };
}

function getRaw(base, path, headers = {}, method = "GET") {
	return new Promise((resolve, reject) => {
		const req = http.request(base + path, { method, headers }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("proxyHttp：JS 网关 gzip 下发、内容正确、etag 已剥、vary 已加", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		const r = await getRaw(front.base, "/app.js", { "accept-encoding": "gzip" });
		assert.equal(r.status, 200);
		assert.equal(r.headers["content-encoding"], "gzip");
		assert.equal(r.headers["etag"], undefined);
		assert.match(String(r.headers["vary"] ?? ""), /accept-encoding/i);
		assert.equal(zlib.gunzipSync(r.raw).toString("utf8"), JS_BODY);
		// 上游收到的是客户端编码透传（回环省不省无所谓，关键是不断言 identity）
		assert.equal(upstream.seen["/app.js"], "gzip");
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("proxyHttp：br 优先、无编码客户端拿 identity", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		const br = await getRaw(front.base, "/app.js", { "accept-encoding": "gzip, deflate, br" });
		assert.equal(br.headers["content-encoding"], "br");
		assert.equal(zlib.brotliDecompressSync(br.raw).toString("utf8"), JS_BODY);

		const plain = await getRaw(front.base, "/app.js", {});
		assert.equal(plain.headers["content-encoding"], undefined);
		assert.equal(plain.raw.toString("utf8"), JS_BODY);
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("proxyHttp：HTML 注入且 identity，下游收到的就是注入后长度", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		const r = await getRaw(front.base, "/", { accept: "text/html", "accept-encoding": "gzip, br" });
		assert.equal(r.status, 200);
		assert.equal(r.headers["content-encoding"], undefined);
		assert.equal(r.headers["etag"], undefined);
		const text = r.raw.toString("utf8");
		assert.ok(text.includes("hello") && text.endsWith("<!--injected-->"));
		assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(text));
		assert.equal(upstream.seen["/"], "identity");
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("proxyHttp：压缩 HTML 解压后注入，未知编码原样直通", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		const gz = await getRaw(front.base, "/gzipped.html", { "accept-encoding": "gzip" });
		assert.equal(gz.headers["content-encoding"], undefined);
		assert.ok(gz.raw.toString("utf8").endsWith("<!--injected-->"));

		const zstd = await getRaw(front.base, "/zstd.html", { "accept-encoding": "gzip" });
		assert.equal(zstd.headers["content-encoding"], "zstd");
		assert.equal(zstd.raw.toString("utf8"), "ZSTD-BYTES");
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("proxyHttp：/api JSON 不压、HEAD 无 body", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		const api = await getRaw(front.base, "/api/data", { "accept-encoding": "gzip, br" });
		assert.equal(api.headers["content-encoding"], undefined);
		assert.deepEqual(JSON.parse(api.raw.toString("utf8")), { ok: true });

		// /api 即使回 HTML 也不注入
		const apiHtml = await getRaw(front.base, "/api/page", { accept: "text/html" });
		assert.equal(apiHtml.raw.toString("utf8"), "APIHTML");

		const head = await getRaw(front.base, "/", { accept: "text/html" }, "HEAD");
		assert.equal(head.status, 200);
		assert.equal(head.raw.length, 0);
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("proxyHttp：上游 Vary 追加、解后超限回退、超限分块恢复编码", async () => {
	const upstream = await startPerfUpstream();
	const front = await startProxyFront({ host: "127.0.0.1", port: upstream.port });
	try {
		// 上游自带 Vary: Origin → 追加 Accept-Encoding 而非覆盖
		const vary = await getRaw(front.base, "/vary.js", { "accept-encoding": "gzip" });
		assert.equal(vary.headers["content-encoding"], "gzip");
		assert.match(String(vary.headers["vary"] ?? ""), /origin/i);
		assert.match(String(vary.headers["vary"] ?? ""), /accept-encoding/i);
		assert.equal(zlib.gunzipSync(vary.raw).toString("utf8"), JS_BODY);

		// 压缩体小但解后 2.3MB 超限：回退原压缩字节直通（不注入、不炸内存）
		const cap = await getRaw(front.base, "/cap.html", { "accept-encoding": "gzip" });
		assert.equal(cap.headers["content-encoding"], "gzip");
		assert.equal(zlib.gunzipSync(cap.raw).length, 2_300_000);
		assert.ok(!cap.raw.toString("utf8").includes("<!--injected-->"));

		// chunked 压缩标记总量超限：overflow 回退恢复 content-encoding
		const big = await getRaw(front.base, "/big-chunked.html", { "accept-encoding": "gzip" });
		assert.equal(big.headers["content-encoding"], "gzip");
		assert.equal(big.raw.length, 256 * 1024 * 10);
	} finally {
		front.server.close();
		upstream.server.close();
	}
});

test("wantsHtmlIdentity：HEAD 走 identity；selectGatewayEncoding 认 x-gzip 与裸 *", () => {
	assert.equal(
		wantsHtmlIdentity(fakeReq({ method: "HEAD", url: "/", headers: { accept: "text/html" } })),
		true,
	);
	assert.equal(selectGatewayEncoding("x-gzip"), "gzip");
	assert.equal(selectGatewayEncoding("*"), "gzip");
	assert.equal(selectGatewayEncoding("*;q=0"), undefined);
	assert.equal(isApiPath(pathnameOf("/api/data?x=1")), true);
	assert.equal(isApiPath(pathnameOf("/api")), true);
	assert.equal(isApiPath(pathnameOf("/apis")), false);
});

// ---------- Part 6：Service Worker 语义 ----------

test("renderServiceWorker：v2 缓存、隔离与 SWR 语义齐全", () => {
	const sw = renderServiceWorker();
	assert.ok(sw.includes("dsh-remote-static-v2"));
	assert.ok(!sw.includes("dsh-remote-static-v1"));
	// 动态面永不拦截
	assert.ok(sw.includes('url.pathname.indexOf("/api/") === 0'));
	assert.ok(sw.includes('url.pathname.indexOf("/__dsh_remote__/") === 0'));
	assert.ok(sw.includes('request.mode === "navigate"'));
	// REVIEW-02 落地：归一化 key、真回源、no-cache 不进缓存、兜底回退网络
	assert.ok(sw.includes("url.origin + url.pathname"));
	assert.ok(sw.includes('cache: "no-cache"'));
	assert.ok(sw.includes("no-store|private|no-cache"));
	assert.ok(sw.includes("event.waitUntil"));
	assert.ok(sw.includes(".catch(function () { return fetch(request); })"));
});
