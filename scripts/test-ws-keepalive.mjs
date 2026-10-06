#!/usr/bin/env node
/**
 * T31-2 回归：网关 → 浏览器侧周期性 WS PING 保活。
 *
 * 覆盖：
 *   帧层  encodePingFrame 字节序列（0x89 / 未掩码 / 空载荷 2 字节）、>125B 拒绝
 *         decodeFrames 往返（含客户端掩码帧解掩）
 *         WsFrameBoundaryTracker：完整帧 / 帧中间 / 跨 chunk 分片 / 126 / 127 /
 *           掩码帧 / RSV 位 / 分片控制帧 → invalid
 *   配置  wsPingIntervalMs 缺省 25_000，0 / false 关闭，1_000 / 600_000 夹取
 *   集成  真实网关子进程 + 真实 raw-WS 上游：开 PING 时周期性收到 0x89，
 *         且**数据帧逐条完整、顺序不乱**（证明没插进 mux 帧中间）；
 *         关 PING 时一条控制帧都没有、数据帧同样完整（负控制）。
 *
 * 运行：node --test scripts/test-ws-keepalive.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { test, after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createTestGateway, requestTls } from "./test-harness.mjs";

const {
	encodePingFrame,
	encodeClientFrame,
	decodeFrames,
	findHttpHeadEnd,
	WsFrameBoundaryTracker,
	OPCODE_PING,
	OPCODE_PONG,
	OPCODE_TEXT,
	OPCODE_BINARY,
} = await import("../packages/gateway/src/wsframe.ts");
const { wsPingIntervalMs, DEFAULT_WS_PING_INTERVAL_MS, applyEnvOverrides, DEFAULT_CONFIG } =
	await import("../packages/gateway/src/config.ts");
const { resolveFrpHeartbeat, DEFAULT_FRP_HEARTBEAT_INTERVAL_SEC, DEFAULT_FRP_HEARTBEAT_TIMEOUT_SEC } =
	await import("../packages/gateway/src/frp.ts");

// ---------- 帧层：编码 ----------

test("T31-2/帧：encodePingFrame 空载荷就是 0x89 0x00（服务端帧不掩码）", () => {
	const frame = encodePingFrame();
	assert.equal(frame.length, 2);
	assert.deepEqual([...frame], [0x89, 0x00]);
	// 掩码位必须是 0：RFC6455 §5.1「服务端发出的帧不得掩码」
	assert.equal(frame[1] & 0x80, 0);
});

test("T31-2/帧：encodePingFrame 带载荷时长度字节等于载荷长、最高位仍为 0", () => {
	const payload = Buffer.from("dshr-keepalive");
	const frame = encodePingFrame(payload);
	assert.equal(frame[0], 0x89);
	assert.equal(frame[1] & 0x80, 0);
	assert.equal(frame[1] & 0x7f, payload.length);
	assert.deepEqual(frame.subarray(2), payload);

	const decoded = decodeFrames(frame);
	assert.equal(decoded.ok, true);
	assert.equal(decoded.frames.length, 1);
	assert.equal(decoded.frames[0].opcode, OPCODE_PING);
	assert.equal(decoded.frames[0].masked, false);
	assert.equal(decoded.frames[0].payload.toString("utf8"), "dshr-keepalive");

	// 空载荷那条：载荷必须真的为空
	const emptyDecoded = decodeFrames(encodePingFrame());
	assert.equal(emptyDecoded.frames[0].payload.length, 0);
});

test("T31-2/帧：PING 载荷 >125B 直接拒绝（控制帧硬约束），不产生截断帧", () => {
	assert.throws(() => encodePingFrame(Buffer.alloc(126)), RangeError);
	assert.equal(encodePingFrame(Buffer.alloc(125)).length, 127);
});

test("T31-2/帧：客户端掩码帧可解码还原（证明代理/对端看到的仍是合法 WS 流）", () => {
	const text = JSON.stringify({ type: "item", streamId: "s-1", value: { type: "projection" } });
	const frame = encodeClientFrame(OPCODE_TEXT, Buffer.from(text));
	assert.equal(frame[1] & 0x80, 0x80, "客户端帧必须带掩码位");
	const decoded = decodeFrames(frame);
	assert.equal(decoded.ok, true);
	assert.equal(decoded.frames[0].masked, true);
	assert.equal(decoded.frames[0].payload.toString("utf8"), text);
	assert.equal(decoded.rest.length, 0);
});

// ---------- 帧层：边界跟踪器 ----------

function trackerAfter(chunks) {
	const t = new WsFrameBoundaryTracker();
	for (const c of chunks) t.push(c);
	return t;
}

test("T31-2/帧：完整帧消费后 atBoundary=true", () => {
	const a = trackerAfter([encodePingFrame()]);
	assert.equal(a.atBoundary, true);
	assert.equal(a.invalid, false);
	assert.equal(a.frames, 1);

	const b = trackerAfter([encodeClientFrame(OPCODE_TEXT, Buffer.from("hello"))]);
	assert.equal(b.atBoundary, true);
	assert.equal(b.frames, 1);
});

test("T31-2/帧：载荷只到一半时 atBoundary=false（绝不能在这里插 PING）", () => {
	const frame = encodeClientFrame(OPCODE_TEXT, Buffer.from("0123456789"));
	const t = trackerAfter([frame.subarray(0, 6)]);
	assert.equal(t.atBoundary, false, "半个帧时必须判定为非边界");
	const t2 = trackerAfter([frame.subarray(0, frame.length)]);
	assert.equal(t2.atBoundary, true);
});

test("T31-2/帧：帧头被 TCP 切成 1 字节 / 2 字节两半，边界判定仍正确", () => {
	const frame = Buffer.concat([encodeClientFrame(OPCODE_TEXT, Buffer.from("x".repeat(200))), encodePingFrame()]);
	// 126 扩展长度路径：头长 8 字节（2 + 2 + 4 mask）
	for (const cut of [1, 2, 3, 5, 8, 9]) {
		const t = trackerAfter([frame.subarray(0, cut), frame.subarray(cut)]);
		assert.equal(t.atBoundary, true, `cut=${String(cut)} 应在帧边界`);
		assert.equal(t.invalid, false, `cut=${String(cut)} 不应判非法`);
		assert.equal(t.frames, 2);
	}
});

test("T31-2/帧：127（64 位长度）路径可用", () => {
	const big = encodeClientFrame(OPCODE_BINARY, Buffer.alloc(70_000, 0x61));
	assert.equal(big[1] & 0x7f, 127);
	const t = trackerAfter([big.subarray(0, 5), big.subarray(5)]);
	assert.equal(t.atBoundary, true);
	assert.equal(t.frames, 1);
});

test("T31-2/帧：RSV 位非零 / 分片的控制帧 → invalid（永久退回纯管道）", () => {
	const rsv = Buffer.from([0xc1, 0x00]); // FIN + RSV1 + text
	assert.equal(trackerAfter([rsv]).invalid, true);

	const fragmentedControl = Buffer.from([0x09, 0x00]); // PING 但 FIN=0 → 非法
	assert.equal(trackerAfter([fragmentedControl]).invalid, true);

	const oversizeControl = Buffer.from([0x89, 0x7e, 0x00, 0x01]); // 控制帧 126 长度 → 非法
	assert.equal(trackerAfter([oversizeControl]).invalid, true);
});

test("T31-2/帧：invalid 之后不再被喂数据影响（保持 invalid，不会误判回边界）", () => {
	const t = trackerAfter([Buffer.from([0xc1, 0x00])]);
	assert.equal(t.invalid, true);
	assert.equal(t.atBoundary, false);
	t.push(encodePingFrame());
	assert.equal(t.invalid, true);
	assert.equal(t.atBoundary, false);
});

test("T31-2/帧：findHttpHeadEnd 能把 101 响应头与后续帧切开", () => {
	const head = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n");
	assert.equal(findHttpHeadEnd(head), head.length - 4);
	const withFrame = Buffer.concat([head, encodePingFrame()]);
	assert.equal(findHttpHeadEnd(withFrame), head.length - 4);
	assert.equal(findHttpHeadEnd(Buffer.from("HTTP/1.1 400 Bad Request\r\n")), -1);
});

// ---------- 配置 ----------

test("T31-2/配置：pingIntervalMs 缺省 25_000；0 / false / 负数关闭；越界夹取", () => {
	assert.equal(DEFAULT_WS_PING_INTERVAL_MS, 25_000);
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG }), 25_000);
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: 0 } }), 0);
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: -1 } }), 0);
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: false } }), 0);
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: 300 } }), 1_000, "下限夹到 1s");
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: 9_999_999 } }), 600_000, "上限夹到 10min");
	assert.equal(wsPingIntervalMs({ ...DEFAULT_CONFIG, ws: { pingIntervalMs: 3_000 } }), 3_000);
});

test("T31-2/配置：DSHR_WS_PING_INTERVAL_MS 可关也可调", () => {
	const off = applyEnvOverrides({ ...DEFAULT_CONFIG }, { DSHR_WS_PING_INTERVAL_MS: "0" });
	assert.equal(wsPingIntervalMs(off), 0);
	const word = applyEnvOverrides({ ...DEFAULT_CONFIG }, { DSHR_WS_PING_INTERVAL_MS: "off" });
	assert.equal(wsPingIntervalMs(word), 0);
	const on = applyEnvOverrides({ ...DEFAULT_CONFIG }, { DSHR_WS_PING_INTERVAL_MS: "5000" });
	assert.equal(wsPingIntervalMs(on), 5_000);
});

test("T31-1/配置：frp 心跳缺省 25/90，可整组关、可逐字段关、超时不大于周期时自动抬", () => {
	assert.equal(DEFAULT_FRP_HEARTBEAT_INTERVAL_SEC, 25);
	assert.equal(DEFAULT_FRP_HEARTBEAT_TIMEOUT_SEC, 90);
	assert.deepEqual(resolveFrpHeartbeat(undefined), { intervalSec: 25, timeoutSec: 90 });
	assert.deepEqual(resolveFrpHeartbeat(false), {});
	assert.deepEqual(resolveFrpHeartbeat({ interval: 0 }), {});
	assert.deepEqual(resolveFrpHeartbeat({ interval: 30, timeout: 0 }), { intervalSec: 30 });
	assert.deepEqual(resolveFrpHeartbeat({ interval: 100, timeout: 50 }), { intervalSec: 100, timeoutSec: 200 });
	assert.deepEqual(resolveFrpHeartbeat({ interval: "垃圾", timeout: null }), { intervalSec: 25, timeoutSec: 90 });
});

// ---------- 集成：真实网关子进程 + 真实 raw-WS 上游 ----------

/**
 * 网关启动时会用 `hasDshFingerprint(GET /)` 校验上游；不匹配就自动漂移到本机真实
 * DSH 端口。所以每个假上游都必须先应答一次带 `__dsh_boot__` 的指纹页。
 */
const FINGERPRINT_BODY = "<!doctype html><html><head><title>fake dsh</title></head><body>__dsh_boot__ fake</body></html>";
function serveFingerprint(reqText, socket) {
	if (/^GET\s+\/\s+HTTP\/1\.[01]/i.test(reqText) && !/^upgrade:/im.test(reqText)) {
		socket.write(
			`HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${String(Buffer.byteLength(FINGERPRINT_BODY))}\r\nconnection: close\r\n\r\n${FINGERPRINT_BODY}`,
		);
		return true;
	}
	return false;
}

/**
 * 起一个最小 WebSocket 上游：解析升级请求 → 回 101 → 之后每 tick 发一条 mux 风格
 * 文本帧。返回的 `received` 记录浏览器侧回给上游的原始字节（应当只有 PONG）。
 */
async function startWsUpstream({ dataIntervalMs, payloadPrefix = "mux" }) {
	const received = [];
	let tick = 0;
	// 只给**已完成握手**的 socket 灌数据：把帧写进握手中的连接会让 101 之前就出现
	// 帧字节，客户端切不出干净的头/帧边界（曾表现为随机的「非法帧头 @0」）。
	const ready = new Set();
	const server = net.createServer((socket) => {
		socket.on("close", () => ready.delete(socket));
		socket.on("error", () => ready.delete(socket));
		let handshaked = false;
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			if (handshaked) {
				received.push(chunk);
				return;
			}
			buf = Buffer.concat([buf, chunk]);
			if (serveFingerprint(buf.toString("latin1"), socket)) {
				socket.end();
				return;
			}
			const end = findHttpHeadEnd(buf);
			if (end < 0) return;
			const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.subarray(0, end).toString("latin1"))?.[1] ?? "";
			const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-5AB0DC85B11F`).digest("base64");
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
				"upgrade: websocket\r\n" +
				"connection: Upgrade\r\n" +
				`sec-websocket-accept: ${accept}\r\n\r\n`,
			);
			handshaked = true;
			ready.add(socket);
			buf = buf.subarray(end + 4);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const timer = setInterval(() => {
		tick += 1;
		// 用"服务端帧"形态发（未掩码），载荷是 mux 风格 JSON
		const payload = Buffer.from(JSON.stringify({ type: "item", streamId: "s", seq: tick, src: payloadPrefix }));
		const frame = Buffer.concat([Buffer.from([0x80 | OPCODE_TEXT, payload.length]), payload]);
		for (const s of ready) {
			if (!s.destroyed) s.write(frame);
		}
	}, dataIntervalMs);
	timer.unref();
	return {
		port: server.address().port,
		received,
		async close() {
			clearInterval(timer);
			for (const s of ready) s.destroy();
			await new Promise((r) => server.close(r));
		},
	};
}

/**
 * 经真实网关做一次 WS 升级，收集 ms 内浏览器侧收到的**全部**字节（含 101 响应头）。
 *
 * 自己起裸 TLS 连接而不是用 harness 的 wsConnect：wsConnect 的握手探测会吃掉
 * 第一批 chunk，而这里必须拿到"从第一个字节起"的完整流才能断言帧序列。
 */
async function collectThroughGateway(gatewayPort, cookie, ms) {
	const socket = tls.connect({ host: "127.0.0.1", port: gatewayPort, rejectUnauthorized: false });
	const chunks = [];
	socket.on("data", (c) => chunks.push(Buffer.from(c)));
	await new Promise((resolve, reject) => {
		socket.once("secureConnect", resolve);
		socket.once("error", reject);
	});
	socket.write(
		"GET /api/remote.mux HTTP/1.1\r\n" +
		"host: gateway.invalid\r\n" +
		"upgrade: websocket\r\n" +
		"connection: Upgrade\r\n" +
		"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"sec-websocket-version: 13\r\n" +
		`cookie: dr_device=${cookie}\r\n` +
		"\r\n",
	);
	await sleep(ms);
	socket.destroy();
	return Buffer.concat(chunks);
}

/** 把浏览器侧收到的字节按 101 头切开并逐帧解码（要求 rest 为空）。 */
function decodeBrowserStream(bytes) {
	assert.ok(bytes.length > 0, "至少应收到 101 响应头");
	const headEnd = findHttpHeadEnd(bytes);
	assert.ok(headEnd >= 0, `应能定位 101 响应头，实际头：${bytes.subarray(0, 64).toString("latin1")}`);
	const statusLine = bytes.subarray(0, headEnd).toString("latin1").split("\r\n")[0] ?? "";
	const stream = bytes.subarray(headEnd + 4);
	const decoded = decodeFrames(stream);
	assert.equal(decoded.ok, true, `帧流必须合法：${decoded.ok ? "" : decoded.error}`);
	assert.equal(decoded.rest.length, 0, `不应残留半帧（rest=${String(decoded.rest.length)}B）`);
	return { statusLine, frames: decoded.frames };
}

const upstream = await startWsUpstream({ dataIntervalMs: 120 });
// 注意：config 层会把间隔夹到 [1s, 10min]，所以这里用 1000 而不是更小的值
const pingGw = await createTestGateway({
	label: "t31-ping",
	config: { upstreamPort: upstream.port, listenPort: 0, ws: { pingIntervalMs: 1000 } },
});
const offGw = await createTestGateway({
	label: "t31-noping",
	config: { upstreamPort: upstream.port, listenPort: 0, ws: { pingIntervalMs: 0 } },
});

after(async () => {
	await pingGw.destroy();
	await offGw.destroy();
	await upstream.close();
});

/** 配对拿到设备 Cookie（与 test-fix-regressions 同路径）。 */
async function pairCookie(gw) {
	const { Store } = await import("../packages/gateway/src/store.ts");
	const store = await Store.open(gw.home);
	await store.putPendingCode("T31KEEP", 10);
	const r = await requestTls(`https://127.0.0.1:${String(gw.port)}/__dsh_remote__/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: "t31keep", name: "t31-keepalive" }),
	});
	assert.equal(r.status, 200, `配对应成功：${r.body}`);
	return /dr_device=([^;]+)/.exec(r.setCookie)?.[1];
}

test("T31-2/集成：开启 PING 时浏览器侧周期性收到 0x89，且 mux 数据帧逐条完整", async () => {
	const cookie = await pairCookie(pingGw);
	const { statusLine, frames } = decodeBrowserStream(await collectThroughGateway(pingGw.port, cookie, 3_500));
	assert.match(statusLine, /^HTTP\/1\.1 101/i, `升级应 101，实际：${statusLine}`);

	const pings = frames.filter((f) => f.opcode === OPCODE_PING);
	const datas = frames.filter((f) => f.opcode === OPCODE_TEXT);
	assert.ok(pings.length >= 2, `3.5s @1s 至少应收到 2 个 PING，实得 ${String(pings.length)}`);
	assert.ok(pings.length <= 6, `不应洪泛（3.5s 最多 4 拍 + 余量），实得 ${String(pings.length)}`);
	for (const p of pings) {
		assert.equal(p.masked, false, "网关发往浏览器的帧不得掩码");
		assert.equal(p.payload.length, 0, "本实现只发空载荷 PING");
	}
	assert.ok(datas.length >= 15, `数据帧应持续流动（~29 条），实得 ${String(datas.length)}`);
	// 关键断言：每条数据帧的载荷都是完整可解析的 mux JSON，seq 连续 ⇒ 没被 PING 插坏
	const seqs = datas.map((d) => JSON.parse(d.payload.toString("utf8")).seq);
	for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, "数据帧 seq 必须连续");
});

test("T31-2/集成（负控制）：关掉 PING 后一条控制帧都没有，数据流同样完好", async () => {
	const cookie = await pairCookie(offGw);
	const { statusLine, frames } = decodeBrowserStream(await collectThroughGateway(offGw.port, cookie, 1_800));
	assert.match(statusLine, /^HTTP\/1\.1 101/i, `升级应 101，实际：${statusLine}`);

	assert.equal(frames.filter((f) => f.opcode === OPCODE_PING).length, 0, "关闭时不得出现任何 PING");
	assert.equal(frames.filter((f) => f.opcode === OPCODE_PONG).length, 0, "关闭时不得出现任何 PONG");
	const datas = frames.filter((f) => f.opcode === OPCODE_TEXT);
	assert.ok(datas.length >= 8, `数据帧应照常流动，实得 ${String(datas.length)}`);
	const seqs = datas.map((d) => JSON.parse(d.payload.toString("utf8")).seq);
	for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, "关 PING 时数据帧也必须完整");
});

test("T121/集成：开 PING 时上游只收到掩码空 PING（除此之外无任何注入字节）", async () => {
	const cookie = await pairCookie(pingGw);
	const before = upstream.received.reduce((n, c) => n + c.length, 0);
	await collectThroughGateway(pingGw.port, cookie, 2_500);
	await sleep(150);
	const after = upstream.received.reduce((n, c) => n + c.length, 0);
	assert.ok(after > before, "上游侧应收到网关注入的上行 PING");
	// 本测试的裸客户端不会自动回 PONG，浏览器侧也不会向上游发任何字节，
	// 所以这段增量里只能是网关的上行 PING，逐帧验。
	// 直接解码增量字节（它们全是完整帧：网关一次 write 一帧）。
	const delta = Buffer.concat(upstream.received).subarray(before);
	const decoded = decodeFrames(delta);
	assert.equal(decoded.ok, true, `上行字节必须是合法 WS 流：${decoded.ok ? "" : decoded.error}`);
	assert.equal(decoded.rest.length, 0, "不应残留半帧");
	assert.ok(decoded.frames.length >= 2, `2.5s @1s 至少 2 个上行 PING，实得 ${String(decoded.frames.length)}`);
	for (const f of decoded.frames) {
		assert.equal(f.opcode, OPCODE_PING, "上游侧只应出现 PING");
		assert.equal(f.masked, true, "网关发往上游的帧必须掩码（RFC6455 §5.1 客户端义务）");
		assert.equal(f.payload.length, 0, "本实现只发空载荷 PING");
	}
});

test("T31-2/集成：上游回非 101 时网关不注入任何控制帧（纯管道兜底）", async () => {
	const httpUpstream = net.createServer((s) => {
		s.on("error", () => {});
		s.on("data", (chunk) => {
			const text = chunk.toString("latin1");
			if (serveFingerprint(text, s)) {
				s.end();
				return;
			}
			// 模拟"上游回了非 101"：任何 Upgrade 请求一律 400
			if (/^GET\s+\/api\//i.test(text)) s.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
		});
	});
	await new Promise((r) => httpUpstream.listen(0, "127.0.0.1", r));
	const gw = await createTestGateway({
		label: "t31-nonws",
		config: { upstreamPort: httpUpstream.address().port, listenPort: 0, ws: { pingIntervalMs: 300 } },
	});
	try {
		const cookie = await pairCookie(gw);
		const { wsConnect } = await import("./test-harness.mjs");
		const conn = wsConnect(`wss://127.0.0.1:${String(gw.port)}/api/remote.mux`, { headers: { cookie: `dr_device=${cookie}` } });
		const head = await conn.headersText;
		const raw = [];
		conn.socket.on("data", (c) => raw.push(c));
		await sleep(1_200);
		conn.close();
		assert.match(head, /^HTTP\/1\.1 400/i, `应原样透传上游状态：${head.split("\r\n")[0] ?? ""}`);
		const bytes = Buffer.concat(raw);
		assert.equal(decodeFrames(bytes).frames.filter((f) => f.opcode === OPCODE_PING).length, 0, "非 101 握手不得注入 PING");
	} finally {
		await gw.destroy();
		await new Promise((r) => httpUpstream.close(r));
	}
});

// ---------- 加分：模拟"中间设备按空闲回收连接" ----------
//
// 运营商 NAT / 企业防火墙 / 负载均衡器都按 TCP 空闲时长回收连接，这是用户那条链路上
// 唯一未被证伪的机制。这里用一个会在空闲 idleMs 后主动掐断连接的 TCP 中继把它模拟出来：
//   - 上游完全静默（不给数据帧），唯一可能的流量就是网关的 PING；
//   - 开 PING → 链路始终有流量 → 连接活下来；
//   - 关 PING → 无人说话 → 到达阈值被回收 → 客户端观察到断开。
// 这样就能证明 PING 不是"装饰"，而是**真的能挡住空闲回收**。

/** 空闲即掐断的 TCP 中继：任一方向 idleMs 内没有字节就把两侧都 destroy。 */
async function startIdleReapingProxy({ targetPort, idleMs }) {
	const state = { reaped: 0, kept: 0 };
	const server = net.createServer((client) => {
		const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
		client.setNoDelay(true);
		upstream.setNoDelay(true);
		let lastActivity = Date.now();
		const touch = () => { lastActivity = Date.now(); };
		client.on("data", (c) => { touch(); upstream.write(c); });
		upstream.on("data", (c) => { touch(); client.write(c); });
		client.on("error", () => client.destroy());
		upstream.on("error", () => { client.destroy(); upstream.destroy(); });
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
		const timer = setInterval(() => {
			if (Date.now() - lastActivity >= idleMs) {
				state.reaped += 1;
				clearInterval(timer);
				client.destroy();
				upstream.destroy();
			}
		}, 200);
		timer.unref();
		client.on("close", () => clearInterval(timer));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		port: server.address().port,
		state,
		async close() { await new Promise((r) => server.close(r)); },
	};
}

/**
 * 经「空闲回收中继 → 网关 → 静默上游」建立一条 WS，观察 observeMs 内是否被回收。
 * 返回是否中途断开 + 收到的 PING 数。
 */
async function observeThroughIdleProxy(proxyPort, gatewayPort, cookie, observeMs) {
	const socket = tls.connect({ host: "127.0.0.1", port: proxyPort, rejectUnauthorized: false });
	const chunks = [];
	let closed = false;
	socket.on("data", (c) => chunks.push(Buffer.from(c)));
	socket.on("close", () => { closed = true; });
	await new Promise((resolve, reject) => {
		socket.once("secureConnect", resolve);
		socket.once("error", reject);
		socket.once("close", resolve);
	});
	socket.write(
		"GET /api/remote.mux HTTP/1.1\r\n" +
		"host: gateway.invalid\r\n" +
		"upgrade: websocket\r\n" +
		"connection: Upgrade\r\n" +
		"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"sec-websocket-version: 13\r\n" +
		`cookie: dr_device=${cookie}\r\n` +
		"\r\n",
	);
	await sleep(observeMs);
	// 必须在 destroy 之前取样：close 事件既可能来自回收，也可能来自我们自己的 destroy
	const closedBeforeDestroy = closed;
	socket.destroy();
	await sleep(120);
	const bytes = Buffer.concat(chunks);
	if (bytes.length === 0) return { closed: closedBeforeDestroy, pings: 0, reaped: true };
	const headEnd = findHttpHeadEnd(bytes);
	if (headEnd < 0) return { closed: closedBeforeDestroy, pings: 0, reaped: true };
	const decoded = decodeFrames(bytes.subarray(headEnd + 4));
	assert.equal(decoded.ok, true, `帧流必须合法：${decoded.ok ? "" : decoded.error}`);
	assert.equal(decoded.rest.length, 0, "不应残留半帧");
	const pings = decoded.frames.filter((f) => f.opcode === OPCODE_PING).length;
	return { closed: closedBeforeDestroy, pings, reaped: closedBeforeDestroy };
}

test("T31-2/空闲回收：静默链路上，开 PING 则连接不被回收、关 PING 则被回收", async () => {
	const IDLE_MS = 2_000;
	const OBSERVE_MS = 7_000;

	// 静默上游：握手后一个字节都不发（唯一可能的流量就是网关的 PING）
	const silent = net.createServer((socket) => {
		socket.on("error", () => {});
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			if (buf.length > 0) return;
			buf = Buffer.concat([buf, chunk]);
			const text = buf.toString("latin1");
			if (serveFingerprint(text, socket)) {
				socket.end();
				return;
			}
			const end = findHttpHeadEnd(buf);
			if (end < 0) return;
			const key = /sec-websocket-key:\s*(\S+)/i.exec(text)?.[1] ?? "";
			const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-5AB0DC85B11F`).digest("base64");
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
				`sec-websocket-accept: ${accept}\r\n\r\n`,
			);
			buf = Buffer.alloc(0);
		});
	});
	await new Promise((r) => silent.listen(0, "127.0.0.1", r));

	const gwOn = await createTestGateway({
		label: "t31-idle-on",
		config: { upstreamPort: silent.address().port, listenPort: 0, ws: { pingIntervalMs: 1_000 } },
	});
	const gwOff = await createTestGateway({
		label: "t31-idle-off",
		config: { upstreamPort: silent.address().port, listenPort: 0, ws: { pingIntervalMs: 0 } },
	});

	const keepProxy = await startIdleReapingProxy({ targetPort: gwOn.port, idleMs: IDLE_MS });
	const reapProxy = await startIdleReapingProxy({ targetPort: gwOff.port, idleMs: IDLE_MS });

	try {
		const kept = await observeThroughIdleProxy(keepProxy.port, gwOn.port, await pairCookie(gwOn), OBSERVE_MS);
		const reaped = await observeThroughIdleProxy(reapProxy.port, gwOff.port, await pairCookie(gwOff), OBSERVE_MS);

		assert.ok(kept.pings >= 3, `开 PING：7s @1s 应至少 3 个 PING，实得 ${String(kept.pings)}`);
		assert.equal(kept.reaped, false, "开 PING：链路始终有流量，不应被空闲回收");
		assert.equal(keepProxy.state.reaped, 0, "开 PING：中继一次都不该回收");

		assert.equal(reaped.pings, 0, "关 PING：不应有任何 PING");
		assert.equal(reaped.reaped, true, "关 PING：静默链路必须被空闲回收（否则这个对照没意义）");
		assert.equal(reapProxy.state.reaped, 1, "关 PING：中继应恰好回收 1 次");
	} finally {
		await keepProxy.close();
		await reapProxy.close();
		await gwOn.destroy();
		await gwOff.destroy();
		await new Promise((r) => silent.close(r));
	}
});

// ---------- T121：上游腿的空闲回收 ----------
//
// T31-2 只证明了浏览器腿（PING 只往浏览器发）。但中继段掐的是静默腿：
// 网关→上游方向在 mux 空闲期几分钟零字节， frp/运营商 NAT 按空闲回收，
// 平板无 hook 自愈，每次微闪都可见（手机档几百毫秒自愈，用户无感）。
// 这里把掐线中继放在**网关与静默上游之间**：开 PING（上行掩码 PING 保温）
// 则不被回收，关 PING 则被回收 —— 与浏览器腿镜像。
test("T121/空闲回收：上游腿静默时，开上行 PING 则不被回收、关则被回收", async () => {
	const IDLE_MS = 2_000;
	const OBSERVE_MS = 7_000;

	const silent = net.createServer((socket) => {
		socket.on("error", () => {});
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			if (buf.length > 0) return;
			buf = Buffer.concat([buf, chunk]);
			const text = buf.toString("latin1");
			if (serveFingerprint(text, socket)) {
				socket.end();
				return;
			}
			const end = findHttpHeadEnd(buf);
			if (end < 0) return;
			const key = /sec-websocket-key:\s*(\S+)/i.exec(text)?.[1] ?? "";
			const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-5AB0DC85B11F`).digest("base64");
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
				`sec-websocket-accept: ${accept}\r\n\r\n`,
			);
			buf = Buffer.alloc(0);
		});
	});
	await new Promise((r) => silent.listen(0, "127.0.0.1", r));

	// 掐线中继放在网关与上游之间：网关的上游指向中继，中继指向静默上游。
	// 网关的上行 PING 必须穿过中继才能保温；指纹探测的 GET / 同样穿过中继（透明 TCP）。
	const keepProxy = await startIdleReapingProxy({ targetPort: silent.address().port, idleMs: IDLE_MS });
	const reapProxy = await startIdleReapingProxy({ targetPort: silent.address().port, idleMs: IDLE_MS });
	const gwOn = await createTestGateway({
		label: "t121-idle-on",
		config: { upstreamPort: keepProxy.port, listenPort: 0, ws: { pingIntervalMs: 1_000 } },
	});
	const gwOff = await createTestGateway({
		label: "t121-idle-off",
		config: { upstreamPort: reapProxy.port, listenPort: 0, ws: { pingIntervalMs: 0 } },
	});

	try {
		// 客户端经网关建链（浏览器腿同样静默：裸客户端不回 PONG、不发数据）；
		// 断言的是上游侧中继的回收计数。
		await observeThroughIdleProxy(gwOn.port, gwOn.port, await pairCookie(gwOn), OBSERVE_MS);
		await observeThroughIdleProxy(gwOff.port, gwOff.port, await pairCookie(gwOff), OBSERVE_MS);
		assert.equal(keepProxy.state.reaped, 0, "开上行 PING：上游腿始终有流量，中继一次都不该回收");
		assert.equal(reapProxy.state.reaped, 1, "关 PING：上游腿静默，中继应恰好回收 1 次");
	} finally {
		await keepProxy.close();
		await reapProxy.close();
		await gwOn.destroy();
		await gwOff.destroy();
		await new Promise((r) => silent.close(r));
	}
});
