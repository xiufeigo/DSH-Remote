#!/usr/bin/env node
/**
 * 面板后端端到端测试：真实 apply() + 真实文件 IO + 真实网关子进程。
 *
 * 流程：autoStart=false 启动插件（不拉网关）→ status 离线
 *   → POST config {autoStart:true} → 断言配置写盘 + 网关被拉起
 *   → pair-code 经真实管理端点拿到一次性码 → dispose 回收。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const tempHome = await mkdtemp(join(tmpdir(), "dshr-panel-e2e-"));
process.env.DSH_REMOTE_HOME = tempHome;
const LISTEN_PORT = 18449;

await writeFile(
	join(tempHome, "config.json"),
	JSON.stringify({ autoStart: false, listenPort: LISTEN_PORT, upstreamPort: 52392 }),
	"utf8",
);

// ── 假 cordis 上下文 ──────────────────────────────────────────────
const disposables = [];
const routes = new Map();
const settingsRegistrations = [];
const fakeWebServer = {
	register(options) {
		routes.set(options.path, options.handler);
		return () => {};
	},
};
const fakeSettings = {
	register(namespace, schema, options) {
		settingsRegistrations.push({ namespace, schema, options });
	},
};
const fakeCtx = {
	get(name) {
		if (name === "webServer") return fakeWebServer;
		if (name === "settings") return fakeSettings;
		return undefined;
	},
	effect(setup, label) {
		const dispose = setup();
		disposables.push({ dispose, label });
	},
};

const plugin = (await import("../packages/plugin/lib/index.js")).default;
plugin.apply(fakeCtx);

// 路由与命名空间应已注册
assert.ok(routes.has("/dsh-remote/config"), "应注册 config 路由");
assert.ok(routes.has("/dsh-remote/status"), "应注册 status 路由");
assert.ok(routes.has("/dsh-remote/restart"), "应注册 restart 路由");
assert.ok(routes.has("/dsh-remote/pair-code"), "应注册 pair-code 路由");
assert.equal(settingsRegistrations.length, 1, "应注册 settings 命名空间");
assert.equal(settingsRegistrations[0].namespace, "dsh-remote");
console.log("✓ 5 条路由 + settings 命名空间注册到位");

// 假 req/res 工具
function fakeReq(body) {
	return {
		headers: {},
		method: "POST",
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(body);
		},
	};
}
function fakeRes() {
	const state = { status: 0, body: "" };
	return {
		state,
		writeHead(status) {
			state.status = status;
			return this;
		},
		end(body = "") {
			state.body = body;
			return this;
		},
	};
}

function parseBody(res, label) {
	try {
		return JSON.parse(res.state.body);
	} catch (error) {
		throw new Error(`[${label}] 响应不是合法 JSON（status=${String(res.state.status)}）：${JSON.stringify(res.state.body)}`);
	}
}

/** 路由包装器是 fire-and-forget 风格：调用后轮询等待响应落盘。 */
async function callRoute(path, req, timeoutMs = 12_000) {
	const res = fakeRes();
	const maybePromise = routes.get(path)(req, res);
	const deadline = Date.now() + timeoutMs;
	while (res.state.body === "" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 20));
	}
	if (res.state.body === "") throw new Error(`[${path}] ${String(timeoutMs)}ms 内未收到响应`);
	await maybePromise?.catch?.(() => {});
	return res;
}

async function waitPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise((resolve) => {
			const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(true));
			socket.setTimeout(400, () => {
				socket.destroy();
				resolve(false);
			});
			socket.on("error", () => resolve(false));
			socket.on("connect", () => {
				socket.destroy();
				resolve(true);
			});
		});
		if (open) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

// ── ① 初始 status：网关离线 ──
{
	const res = await callRoute("/dsh-remote/status", fakeReq());
	const payload = parseBody(res, "status");
	assert.equal(payload.gatewayRunning, false, "autoStart=false 时网关不应在跑");
	console.log("✓ 初始状态：网关离线");
}

// ── ② POST config：autoStart=true → 写盘 + 自动拉起 ──
{
	const res = await callRoute(
		"/dsh-remote/config",
		// 与真实设置卡片一致：frp 段全量提交（表单用展示默认值补齐过）
		fakeReq(JSON.stringify({ autoStart: true, frp: { enabled: true, serverAddr: "203.0.113.7", serverPort: 17000, remotePort: 18448 } })),
	);
	const payload = parseBody(res, "config-post");
	assert.equal(payload.ok, true, `保存应成功：${res.state.body}`);
	const persisted = JSON.parse(await readFile(join(tempHome, "config.json"), "utf8"));
	assert.equal(persisted.autoStart, true);
	assert.equal(persisted.listenPort, LISTEN_PORT, "未提交的顶层键保持原值");
	assert.equal(persisted.frp.enabled, true);
	assert.equal(persisted.frp.serverAddr, "203.0.113.7");
	console.log("✓ 配置已写盘");

	const up = await waitPort(LISTEN_PORT, 15000);
	assert.ok(up, "保存后网关应被自动拉起");
	console.log("✓ 网关已随保存动作自动拉起");
}

// ── ③ status：在线 + pair-code 闭环 ──
{
	const res = await callRoute("/dsh-remote/status", fakeReq());
	const payload = parseBody(res, "status");
	assert.equal(payload.gatewayRunning, true);
	assert.equal(typeof payload.gateway.port, "number");
	console.log("✓ 状态聚合：网关在线，端口", payload.gateway.port);

	const pairRes = await callRoute("/dsh-remote/pair-code", fakeReq());
	const pair = parseBody(pairRes, "pair-code");
	assert.equal(pair.ok, true, `配对码应生成成功：${pairRes.state.body}`);
	assert.match(pair.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
	console.log("✓ 配对码闭环：", pair.code);
}

// ── ④ dispose 回收 ──
for (const { dispose } of disposables) {
	if (typeof dispose === "function") dispose();
}
console.log("dispose 已调用，开始逐秒观测端口…");
const { execSync } = await import("node:child_process");
const deadline = Date.now() + 20_000;
let freed = false;
while (Date.now() < deadline) {
	const open = await waitPort(LISTEN_PORT, 400);
	if (!open) {
		freed = true;
		break;
	}
	let owners = "";
	try {
		owners = execSync(
			"powershell -NoProfile -Command \"(Get-NetTCPConnection -State Listen -LocalPort " + String(LISTEN_PORT) + " -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','\"",
			{ encoding: "utf8", shell: true },
		).trim();
	} catch {}
	console.log(`  t+${String(20_000 - (deadline - Date.now()))}ms 仍开放，owner pid=${owners || "?"}`);
}
if (!freed) {
	console.error("❌ 20s 后端口仍未释放");
	process.exit(1);
}
console.log("✓ dispose 后网关已释放");

await rm(tempHome, { recursive: true, force: true });
console.log("\n✅ 面板后端端到端全部通过");
process.exit(0);

