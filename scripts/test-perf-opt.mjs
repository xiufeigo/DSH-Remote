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
 *   - renderServiceWorker：缓存 v3、白名单与导航/API 隔离、完整 URL key、
 *     真回源、no-cache 不进缓存
 *   - T49 SW 行为（vm 里真跑 SW 源码）：三个 /plugins/ 包各存各的、二次零网络、
 *     /plugins/ 关掉 SWR、/assets/ 仍 SWR、动态面与导航不拦截 —— 防白屏的行为级断言
 *
 * 运行：node --test scripts/test-perf-opt.mjs（需 node>=24 类型剥离，与
 * test-session-auth.mjs 一致；本机 node20 跑可用 bun 代替验证）。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
	acceptedEncodings,
	applyImmutableCache,
	buildUpstreamHeaders,
	isApiPath,
	pathnameOf,
	proxyHttp,
	selectGatewayEncoding,
	shouldGatewayCompress,
	wantsHtmlIdentity,
} from "../packages/gateway/src/proxy.ts";
import { renderServiceWorker } from "../packages/gateway/src/pwa.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** APK 内嵌的 SW 脚本（build.ps1 从 pwa.ts 渲染而来，副本禁止手改）。 */
const SW_ASSET_PATH = join(REPO_ROOT, "android/app/src/main/res/raw/dsh_sw.js");
const SERVER_PATH = join(REPO_ROOT, "packages/gateway/src/server.ts");

/** 首个不同的字节偏移（报错信息用：光说"不一致"无法定位）。 */
function firstDiffOffset(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return a.length === b.length ? -1 : n;
}

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

test("applyImmutableCache：只给无缓存头的哈希静态补一年", () => {
	const hashed = { "content-type": "application/javascript" };
	applyImmutableCache(fakeReq({ url: "/assets/index-AbC12345.js" }), 200, hashed);
	assert.equal(hashed["cache-control"], "public, max-age=31536000, immutable");

	const unhashed = { "content-type": "application/javascript" };
	applyImmutableCache(fakeReq({ url: "/assets/app.js" }), 200, unhashed);
	assert.equal(unhashed["cache-control"], undefined);

	const respected = { "content-type": "text/css", "cache-control": "no-cache" };
	applyImmutableCache(fakeReq({ url: "/assets/app-AbC12345.css" }), 200, respected);
	assert.equal(respected["cache-control"], "no-cache");

	const api = { "content-type": "application/json" };
	applyImmutableCache(fakeReq({ url: "/api/x-AbC12345.js" }), 200, api);
	assert.equal(api["cache-control"], undefined);

	const notFound = { "content-type": "application/javascript" };
	applyImmutableCache(fakeReq({ url: "/assets/index-AbC12345.js" }), 404, notFound);
	assert.equal(notFound["cache-control"], undefined);
});

// ---------- Part 6：Service Worker 语义 ----------

test("renderServiceWorker：v3 缓存、隔离与 SWR 语义齐全", () => {
	const sw = renderServiceWorker();
	assert.ok(sw.includes("dsh-remote-static-v3"));
	assert.ok(!sw.includes("dsh-remote-static-v1"));
	assert.ok(!sw.includes("dsh-remote-static-v2"));
	// 动态面永不拦截
	assert.ok(sw.includes('url.pathname.indexOf("/api/") === 0'));
	assert.ok(sw.includes('url.pathname.indexOf("/__dsh_remote__/") === 0'));
	assert.ok(sw.includes('request.mode === "navigate"'));
	// T49：cacheKey 必须是完整 URL（含 rev 指纹），且不得再用 ignoreSearch /
	// origin+pathname 归一化——那会把 /plugins/ 的三个包塌成一个 key。
	assert.ok(sw.includes("var cacheKey = request.url;"));
	assert.ok(sw.includes("cache.match(cacheKey).then("));
	// 注释里可以提到 ignoreSearch（那是要防的坑），但**代码里不得再传它**。
	assert.ok(!/match\([^)]*ignoreSearch/.test(sw), "cache.match 不得再带 ignoreSearch（T49）");
	assert.ok(!sw.includes("url.origin + url.pathname"));
	// T49：/plugins/ 白名单显式放行 + 内容指纹资源不参与 SWR
	assert.ok(sw.includes("function isFingerprinted(pathname)"));
	assert.ok(sw.includes('pathname === "/plugins/"'));
	assert.ok(sw.includes("if (!CACHEABLE.test(url.pathname) && !fingerprinted) return;"));
	assert.ok(sw.includes("if (fingerprinted) {"));
	// 其余语义不变
	assert.ok(sw.includes('cache: "no-cache"'));
	assert.ok(sw.includes("no-store|private|no-cache"));
	assert.ok(sw.includes("event.waitUntil"));
	assert.ok(sw.includes(".catch(function () { return fetch(request); })"));
});

test("R5（T53）：APK 内嵌 dsh_sw.js == 网关渲染产物（SW-02 单一源不漂移）", () => {
	// T52 §3/§18-3 指出 R5 的真缺口：APK 里那份 SW 与网关 `/__dsh_remote__/sw.js`
	// 下发的那份**没有任何断言**在守。构建期两者同源（build.ps1 调 renderServiceWorker()
	// 渲染进 res/raw），但"同源"是**约定**不是**断言** —— 忘了重跑同步、或手工改过
	// res/raw/dsh_sw.js（它明令禁止手改，但没东西拦），就会静默漂移：
	// 手机走 APK 本地供给、桌面走网关下发 ⇒ 同一版本两套 SW 策略。
	//
	// 这条断言把约定变成事实：res/raw/dsh_sw.js 必须与 renderServiceWorker() 的输出
	// **逐字节**相同（不是包含、不是行数一致）。
	// 它在 ci.yml 的 `pnpm test:perf` 里跑 ⇒ 漂移当场红，不会带到发版。
	const rendered = Buffer.from(renderServiceWorker(), "utf8");
	const onDisk = readFileSync(SW_ASSET_PATH);
	assert.equal(
		onDisk.length,
		rendered.length,
		`R5：res/raw/dsh_sw.js 长度 ${onDisk.length} ≠ renderServiceWorker() ${rendered.length}`
			+ ` —— 跑 node android/sync-sw-asset.mjs 重渲染（res/raw 副本禁止手改）`,
	);
	assert.ok(
		onDisk.equals(rendered),
		"R5：res/raw/dsh_sw.js 与 renderServiceWorker() 输出不是逐字节一致"
			+ `（首个不同偏移 ${firstDiffOffset(onDisk, rendered)}）`
			+ " —— APK 会打进旧 SW，手机端与桌面端行为分叉。跑 node android/sync-sw-asset.mjs",
	);
	// 顺带钉住「网关确实按请求渲染」这条性质：它是"桌面端不需要重启也能拿到新 SW"的前提。
	// server.ts 的路由是 `.end(renderServiceWorker())`，**每次请求都调**，没有进程内缓存
	// （与 mobile.ts 的资产缓存不同）⇒ 桌面端的陈旧只可能来自"进程加载的是旧 pwa.ts 代码"。
	assert.ok(
		readFileSync(SERVER_PATH, "utf8").includes(".end(renderServiceWorker())"),
		"网关 /__dsh_remote__/sw.js 路由必须每次请求都 renderServiceWorker()（不得改成进程内缓存）",
	);
});

// ── T49：把 SW 真跑起来，证明「三个 /plugins/ 包各存各的 + 二次不重下」──
//
// 字符串断言证明不了防白屏这件事。这里用 Node vm 造一个最小 Service Worker
// 宿主（self / caches / fetch / URL），把 renderServiceWorker() 的输出真的执行
// 一遍，断言的是**行为**：三个不同 rev 的 /plugins/ 请求各写各的缓存条目、
// 二次进入零网络往返，/assets/ 仍然走 SWR。

/** 起一个最小 SW 宿主：跑 sw 源码，返回 { fire, netCalls, cache, reset }。 */
function makeSwHost(swSource, cacheControl = "public, max-age=31536000, immutable") {
	const store = new Map(); // cacheName -> Map(url -> {body, headers})
	const netCalls = [];
	const pending = [];
	// T51（R6）：让测试能把「写缓存」搞失败（模拟 QuotaExceededError），
	// 并断言失败是**可见**的而不是被 .catch(()=>{}) 静默吞掉。
	const ctl = { putShouldFail: false, consoleWarns: [], postMessages: [] };
	const host = {
		caches: {
			async keys() { return [...store.keys()]; },
			async open(name) {
				if (!store.has(name)) store.set(name, new Map());
				const m = store.get(name);
				return {
					async keys() { return [...m.keys()]; },
					async delete(key) { return m.delete(key); },
					async match(key) {
						if (!m.has(key)) return undefined;
						const hit = m.get(key);
						// 缓存命中返回的对象必须像真 Response 一样带 headers.get()：
						// SW 现在要读它的 cache-control 来判断 immutable。
						return {
							__cached: true, url: key, body: hit.body,
							headers: { get: (k) => (k === "cache-control" ? (hit.cc || null) : null) },
						};
					},
					async put(key, res) {
						if (ctl.putShouldFail) {
							const err = new Error("simulated quota exceeded");
							err.name = "QuotaExceededError";
							throw err;
						}
						m.set(key, {
							body: res.__body,
							cc: res.headers ? res.headers.get("cache-control") : null,
						});
					},
				};
			},
			async delete(name) { return store.delete(name); },
		},
	};
	const self = {
		location: { origin: "https://127.0.0.1:18443" },
		skipWaiting: async () => {},
		clients: { claim: async () => {} },
		postMessage: (msg) => { ctl.postMessages.push(msg); },
		addEventListener: (type, fn) => { pending.push({ type, fn }); },
	};
	const fetchImpl = async (request) => {
		const url = typeof request === "string" ? request : request.url;
		netCalls.push(url);
		return makeResponse(url, cacheControl);
	};
	const fakeConsole = {
		...console,
		warn: (...a) => { ctl.consoleWarns.push(a.map(String).join(" ")); },
		log: (...a) => { ctl.consoleWarns.push(a.map(String).join(" ")); },
	};
	const sandbox = {
		self, caches: host.caches, fetch: fetchImpl,
		URL, Promise, Error, console: fakeConsole,
	};
	// SW 里用的是裸标识符 self / caches / fetch，vm 顶层即是全局。
	createContext(sandbox);
	runInContext(swSource, sandbox);
	const fetchHandler = pending.find((p) => p.type === "fetch").fn;
	return {
		netCalls,
		ctl,
		/** 模拟一次子资源请求，返回该次实际交付的字节体。 */
		async request(url, mode = "no-cors") {
			const request = { url: "https://127.0.0.1:18443" + url, method: "GET", mode, clone() { return this; } };
			let out = { handled: false, body: null, waited: [] };
			const event = {
				request,
				waitUntil: (p) => { out.waited.push(p); return p; },
				respondWith: (p) => { out.handled = true; out.promise = p; },
			};
			fetchHandler(event);
			if (out.promise) {
				// 归一化交付体：网络来的带 __body，缓存命中的走 {body}。
				const res = await out.promise;
				out.response = res;
				out.body = res === undefined ? undefined : (res.__body ?? res.body);
			}
			// T51（R6）：把 waitUntil 链也 await 掉，否则淘汰/写失败来不及发生。
			if (out.waited.length) await Promise.all(out.waited);
			return out;
		},
		/** 缓存里某条目的条数与 URL 列表（防白屏要看的就是这个）。 */
		cacheOf(name) { return store.get(name) ?? new Map(); },
	};
}

/** 假 Response：body 就是 URL 本身，带网关真实的缓存头。 */
function makeResponse(url, cacheControl) {
	return {
		ok: true,
		status: 200,
		url,
		__body: `BODY<${url}>`,
		// SW 读的是 response.headers.get("cache-control")，必须给真形状的 headers。
		headers: { get: (k) => (k === "cache-control" ? cacheControl : null) },
		clone() { return this; },
	};
}

// T45 实测的三个真实包（rev 跨导航逐字节稳定）。
const PLUGIN_URLS = [
	"/plugins/?@dsh-plugin&rev=10ddc612f195",
	"/plugins/?@dsh-plugin-runtime&rev=34b08f499984",
	"/plugins/?@dsh-plugin-ui&rev=997566eab253",
];

test("T49 SW 行为：三个 /plugins/ 包各存各的，二次进入零网络（防白屏）", async () => {
	const host = makeSwHost(renderServiceWorker());

	// 第一轮：三个包全部未命中 ⇒ 应当各取一次网络，并各落一条缓存。
	const first = [];
	for (const u of PLUGIN_URLS) first.push((await host.request(u)).body);
	assert.equal(first.length, 3, "三个包都要有交付体");
	assert.equal(host.netCalls.length, 3, `首轮应恰好 3 次网络，实际 ${host.netCalls.length}`);

	const entries = host.cacheOf("dsh-remote-static-v3");
	assert.equal(entries.size, 3, `/plugins/ 必须落 3 条，塌成 1 条就是白屏那条路`);
	// 每个包拿到的必须是自己那份字节，不是别人的。
	first.forEach((body, i) => {
		assert.equal(body, `BODY<https://127.0.0.1:18443${PLUGIN_URLS[i]}>`);
	});

	// 第二轮：全部命中缓存 ⇒ 零网络往返。
	host.netCalls.length = 0;
	for (const u of PLUGIN_URLS) {
		const r = await host.request(u);
		assert.equal(r.body, `BODY<https://127.0.0.1:18443${u}>`, "命中缓存也必须是对应那个包的字节");
	}
	assert.equal(host.netCalls.length, 0, `二次进入 /plugins/ 不该有任何网络往返，实际 ${host.netCalls.length}`);
});

test("T49 SW 行为：/plugins/ 关掉 SWR（命中后不再后台重验）", async () => {
	const host = makeSwHost(renderServiceWorker());
	await host.request(PLUGIN_URLS[0]);
	host.netCalls.length = 0;
	const r = await host.request(PLUGIN_URLS[0]);
	assert.equal(r.body, `BODY<https://127.0.0.1:18443${PLUGIN_URLS[0]}>`);
	assert.equal(r.waited.length, 0, "内容指纹资源命中后不得排任何 waitUntil（即不后台重验）");
	assert.equal(host.netCalls.length, 0, "内容指纹资源命中后不得再回源");
});

test("T49 SW 行为：/assets/* 带 immutable ⇒ 不再后台重验（回归本轮实测到的浪费）", async () => {
	const host = makeSwHost(renderServiceWorker());
	const asset = "/assets/index-BPHePDI_.js";
	await host.request(asset);            // 未命中 → 取网络并落缓存（带 immutable 头）
	host.netCalls.length = 0;
	const r = await host.request(asset);   // 命中 → 必须直接返回，且**不**排重验
	assert.equal(r.body, `BODY<https://127.0.0.1:18443${asset}>`);
	assert.equal(r.waited.length, 0, "immutable 资源命中后不得再排 waitUntil");
	assert.equal(host.netCalls.length, 0, "immutable 资源命中后不得再回源");
});

test("T49 SW 行为：非 immutable 资源仍走 SWR（不回归原有语义）", async () => {
	// 造一个不带 immutable 的网关（只有 max-age）：SWR 语义必须原样保留。
	const h2 = makeSwHost(renderServiceWorker(), "public, max-age=600");
	const asset = "/assets/index-BPHePDI_.js";
	await h2.request(asset);
	h2.netCalls.length = 0;
	const r = await h2.request(asset);
	assert.equal(r.body, `BODY<https://127.0.0.1:18443${asset}>`, "命中应立刻给缓存体");
	assert.equal(r.waited.length, 1, "非 immutable 命中后仍应排一次后台 revalidate");
	await Promise.all(r.waited);
	assert.equal(h2.netCalls.length, 1, "SWR 应恰好回源一次");
});

test("T49 SW 行为：动态面与导航请求依然完全不拦截（不回归）", async () => {
	const host = makeSwHost(renderServiceWorker());
	for (const [u, mode] of [["/api/session", "cors"], ["/__dsh_remote__/health", "cors"], ["/", "navigate"]]) {
		const r = await host.request(u, mode);
		assert.equal(r.handled, false, `${u}（mode=${mode}）不应被 respondWith 拦截`);
	}
	assert.equal(host.cacheOf("dsh-remote-static-v3").size, 0, "动态面不得留下任何缓存条目");
});

// ── T51（R6）：/plugins/ 缓存必须有上限 + 淘汰，写失败必须可见 ──
//
// T50 §8 的实测：无上限、无 LRU，每次 rev 变更 +11,477,184 B 僵尸；
// 且 `cache.put().catch(()=>{})` 把 QuotaExceededError 静默吞掉
// ⇒ 撑满后「静默退回每轮重下 5.6MB」，控制台无任何提示。
// 下面两条是**行为级**的：真跑 SW 源码，构造多代 rev 与一次配额失败。

test("T51/R6 SW 行为：/plugins/ 超过保留 rev 数后淘汰旧 rev 条目（不无限涨）", async () => {
	const host = makeSwHost(renderServiceWorker());
	// 照真页面造：每次加载三个 /plugins/ 包，**三个 rev 互异**（T50 §2.3 实测）。
	// 造 4 轮 = 12 个 rev，超过 PLUGIN_KEEP_REVS(9) ⇒ 必须开始淘汰。
	const loads = [
		["p1a", "p1b", "p1c"],
		["p2a", "p2b", "p2c"],
		["p3a", "p3b", "p3c"],
		["p4a", "p4b", "p4c"],
	];
	const allRevs = [];
	for (const [i, rev] of loads.flat().entries()) {
		await host.request(`/plugins/?@dsh-plugin-${i}&rev=${rev}`);
		allRevs.push(rev);
	}
	assert.equal(allRevs.length, 12, "4 轮 x3 = 12 个互异 rev");

	const cache = host.cacheOf("dsh-remote-static-v3");
	const keys = [...cache.keys()];
	const keptRevs = [...new Set(keys.map((k) => /rev=([0-9a-z]+)/.exec(k)[1]))];
	assert.equal(keptRevs.length, 9, `只应保留最新 9 个 rev，实际 ${keptRevs.length} 个：${keptRevs.join(",")}`);
	assert.equal(keys.length, 9, `12 条应收敛到 9，实际 ${keys.length}`);
	for (const mustGo of ["p1a", "p1b", "p1c"]) {
		assert.ok(!keptRevs.includes(mustGo), `最旧一轮的 ${mustGo} 必须被淘汰`);
	}
	for (const mustStay of ["p2a", "p3a", "p4c"]) {
		assert.ok(keptRevs.includes(mustStay), `${mustStay} 必须留着`);
	}
	// 最新一轮的三个包必须**同时**在（否则当前页面会缺包）。
	for (const rev of ["p4a", "p4b", "p4c"]) {
		assert.ok(cache.has(`https://127.0.0.1:18443/plugins/?@dsh-plugin-${loads.flat().indexOf(rev)}&rev=${rev}`), `最新一轮的 ${rev} 必须留着`);
	}

	// 被淘汰的那些 rev 本来也命中不了（rev 变了 URL 就变），淘汰不影响正确性：
	// 重新请求旧 rev 应当回源，且必须按自己的 URL 拿回自己的字节（不得串包）。
	host.netCalls.length = 0;
	const old = await host.request("/plugins/?@dsh-plugin-0&rev=p1a");
	assert.equal(old.body, `BODY<https://127.0.0.1:18443/plugins/?@dsh-plugin-0&rev=p1a>`, "旧 rev 必须按自己的 URL 取自己的字节（不得串包）");
	assert.equal(host.netCalls.length, 1, "旧 rev 已淘汰 ⇒ 应回源一次");

	// 淘汰必须**吵出来**（可观测），不能悄悄删。
	assert.ok(
		host.ctl.consoleWarns.some((w) => w.includes("缓存淘汰")),
		`淘汰必须打日志，实际日志：${JSON.stringify(host.ctl.consoleWarns)}`,
	);
});

test("T51/R6 SW 行为：淘汰绝不能删掉当前这一轮正在用的包（T49 白屏防线）", async () => {
	// T50 §2.3 实测：同一次加载的三个 /plugins/ rev **互异**。若把上限写成 2 个 rev
	// （T50 §8.1 字面建议），第一次加载就会删掉三个包里的一个 ⇒ 正是 T49 修的白屏。
	const host = makeSwHost(renderServiceWorker());
	for (const u of PLUGIN_URLS) await host.request(u);
	const cache = host.cacheOf("dsh-remote-static-v3");
	assert.equal(cache.size, 3, "一轮加载的三个包必须全在（三个 rev 互异，任何一个被删都白屏）");
	for (const u of PLUGIN_URLS) {
		assert.ok(cache.has("https://127.0.0.1:18443" + u), `本轮的包必须留着：${u}`);
	}
	// 上限必须显著大于「一轮的 rev 数」，否则这个测试必然翻红。
	const sw = renderServiceWorker();
	const keepRevs = Number(/var PLUGIN_KEEP_REVS = (\d+);/.exec(sw)[1]);
	assert.ok(keepRevs >= 3, `PLUGIN_KEEP_REVS=${keepRevs} 太小，一轮 3 个 rev 会被误删`);
});

test("T51/R6 SW 行为：缓存写入失败（QuotaExceededError）必须可见，不再静默吞掉", async () => {
	const host = makeSwHost(renderServiceWorker());
	host.ctl.putShouldFail = true;
	// 走 /assets/ 的非指纹分支（它以前是 .then(fn, fn) 双双静默）。
	const r = await host.request("/assets/index-BPHePDI_.js");
	// 写失败**不得**影响本次响应：用户仍要拿到字节。
	assert.equal(r.body, `BODY<https://127.0.0.1:18443/assets/index-BPHePDI_.js>`, "写缓存失败不得让资源请求失败");
	assert.equal(host.cacheOf("dsh-remote-static-v3").size, 0, "失败的写不该留下条目");
	assert.ok(
		host.ctl.consoleWarns.some((w) => w.includes("缓存写入失败") && w.includes("QuotaExceededError")),
		`写失败必须 console.warn 且带上错误名，实际：${JSON.stringify(host.ctl.consoleWarns)}`,
	);
	assert.ok(
		host.ctl.postMessages.some((m) => m && m.type === "dshr-cache-write-failed"),
		`写失败还应 postMessage 上报，实际：${JSON.stringify(host.ctl.postMessages)}`,
	);
});

test("T51/R6 SW 行为：/plugins/ 写失败也必须可见（这条以前是 .catch(()=>{})）", async () => {
	const host = makeSwHost(renderServiceWorker());
	host.ctl.putShouldFail = true;
	const r = await host.request(PLUGIN_URLS[0]);
	assert.equal(r.body, `BODY<https://127.0.0.1:18443${PLUGIN_URLS[0]}>`, "写失败不得让 /plugins/ 请求失败");
	assert.ok(
		host.ctl.consoleWarns.some((w) => w.includes("缓存写入失败")),
		`/plugins/ 写失败也必须喊出来，实际：${JSON.stringify(host.ctl.consoleWarns)}`,
	);
});

