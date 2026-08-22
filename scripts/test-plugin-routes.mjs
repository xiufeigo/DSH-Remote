#!/usr/bin/env node
/**
 * 插件宿主路由逻辑单测（不启动任何服务，依赖全注入）。
 * 覆盖：配置补丁校验、合并语义、config POST 写盘+重启联动、
 * status 降级、pair-code 转发成功/失败。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouteHandlers, resolveRemoteHome } from "../packages/plugin/lib/index.js";
import { validateConfigPatch, mergeConfigFile, DISPLAY_DEFAULTS } from "../packages/plugin/lib/config-schema.js";

/** 捕获 writeHead/end 的假 res。 */
function fakeRes() {
	const calls = { status: 0, body: "", headers: null };
	return {
		calls,
		writeHead(status, headers) {
			calls.status = status;
			calls.headers = headers;
			return this;
		},
		end(body = "") {
			calls.body = body;
			return this;
		},
	};
}

function fakeReq(body) {
	return {
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(body);
		},
		headers: {},
		method: "POST",
	};
}

test("validateConfigPatch：白名单与类型校验", () => {
	const bad = validateConfigPatch({ evil: 1, upstreamPort: "abc", listenHost: "evil.com", frp: { serverAddr: "a b" } });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => e.includes("evil")));
	assert.ok(bad.errors.some((e) => e.includes("upstreamPort")));
	assert.ok(bad.errors.some((e) => e.includes("listenHost")));
	assert.ok(bad.errors.some((e) => e.includes("serverAddr")));

	const good = validateConfigPatch({
		upstreamPort: 52392,
		autoStart: false,
		listenHost: "0.0.0.0",
		frp: { enabled: true, serverAddr: "1.2.3.4", serverPort: 7000, remotePort: 8443 },
	});
	assert.equal(good.ok, true);
	assert.deepEqual(good.patch.frp, { enabled: true, serverAddr: "1.2.3.4", serverPort: 7000, remotePort: 8443 });

	// 端口边界
	assert.equal(validateConfigPatch({ listenPort: 0 }).ok, false);
	assert.equal(validateConfigPatch({ listenPort: 65536 }).ok, false);
	assert.equal(validateConfigPatch({ listenPort: 65535 }).ok, true);
});

test("mergeConfigFile：顶层浅覆盖 + frp 深合并", () => {
	const current = { listenPort: 18443, upstreamPort: 52392, frp: { enabled: false, serverPort: 7000, remotePort: 8443 } };
	const next = mergeConfigFile(current, { upstreamPort: 9999, frp: { enabled: true, serverAddr: "v.example" } });
	assert.equal(next.upstreamPort, 9999);
	assert.equal(next.listenPort, 18443, "未提交的键保持不变");
	assert.equal(next.frp.enabled, true);
	assert.equal(next.frp.serverAddr, "v.example");
	assert.equal(next.frp.serverPort, 7000, "frp 未提交的键保持不变");
});

test("handleConfigPost：合法补丁 → 写盘 + 重启联动", async () => {
	const home = await mkdtemp(join(tmpdir(), "dshr-routes-"));
	let written = null;
	let restarts = 0;
	const handlers = createRouteHandlers({
		home,
		log: () => {},
		readConfig: () => ({ upstreamPort: 52392, frp: { enabled: false, serverPort: 7000, remotePort: 8443 } }),
		writeConfig: async (next) => {
			written = next;
		},
		restartGateway: () => {
			restarts += 1;
		},
		adminRequest: async () => undefined,
	});

	const res = fakeRes();
	await handlers.handleConfigPost(
		fakeReq(JSON.stringify({ frp: { enabled: true, serverAddr: "5.6.7.8" } })),
		res,
	);
	assert.equal(res.calls.status, 200);
	assert.equal(JSON.parse(res.calls.body).ok, true);
	assert.equal(written.frp.enabled, true);
	assert.equal(written.frp.serverAddr, "5.6.7.8");
	assert.equal(written.frp.serverPort, 7000);
	assert.equal(restarts, 1, "保存后必须联动重启网关");
	await rm(home, { recursive: true, force: true });
});

test("handleConfigPost：非法补丁 → 400 且不写盘不重启", async () => {
	let written = null;
	let restarts = 0;
	const handlers = createRouteHandlers({
		home: ".",
		log: () => {},
		readConfig: () => ({}),
		writeConfig: async (next) => {
			written = next;
		},
		restartGateway: () => {
			restarts += 1;
		},
		adminRequest: async () => undefined,
	});
	const res = fakeRes();
	await handlers.handleConfigPost(fakeReq(JSON.stringify({ hack: true })), res);
	assert.equal(res.calls.status, 400);
	assert.equal(written, null);
	assert.equal(restarts, 0);

	const res2 = fakeRes();
	await handlers.handleConfigPost(fakeReq("not-json"), res2);
	assert.equal(res2.calls.status, 400);
});

test("handleStatusGet：网关离线时降级", async () => {
	const handlers = createRouteHandlers({
		home: ".",
		log: () => {},
		readConfig: () => ({ listenPort: 18443, upstreamPort: 52392 }),
		writeConfig: async () => {},
		restartGateway: () => {},
		adminRequest: async () => undefined,
	});
	const res = fakeRes();
	await handlers.handleStatusGet(fakeReq(), res);
	const payload = JSON.parse(res.calls.body);
	assert.equal(payload.gatewayRunning, false);
	assert.equal(payload.deviceCount, null);
	assert.equal(payload.config.upstreamPort, 52392);
});

test("handleStatusGet：网关在线时聚合数据", async () => {
	const handlers = createRouteHandlers({
		home: ".",
		log: () => {},
		readConfig: () => ({ listenPort: 18443 }),
		writeConfig: async () => {},
		restartGateway: () => {},
		adminRequest: async (path) => {
			if (path === "/__dsh_remote__/admin/status") {
				return { status: 200, body: JSON.stringify({ port: 18443, certFingerprint: "AB12" }) };
			}
			if (path === "/__dsh_remote__/admin/devices") {
				return { status: 200, body: JSON.stringify({ devices: [{ id: "a" }, { id: "b", revokedAt: "x" }] }) };
			}
			return undefined;
		},
	});
	const res = fakeRes();
	await handlers.handleStatusGet(fakeReq(), res);
	const payload = JSON.parse(res.calls.body);
	assert.equal(payload.gatewayRunning, true);
	assert.equal(payload.gateway.certFingerprint, "AB12");
	assert.equal(payload.deviceCount, 1, "已吊销设备不计数");
});

test("handlePairCodePost：转发成功与失败", async () => {
	const ok = createRouteHandlers({
		home: ".", log: () => {}, readConfig: () => ({}), writeConfig: async () => {}, restartGateway: () => {},
		adminRequest: async () => ({ status: 200, body: JSON.stringify({ code: "ABCD-1234", expiresAt: "t" }) }),
	});
	const res1 = fakeRes();
	await ok.handlePairCodePost(fakeReq(), res1);
	const payload = JSON.parse(res1.calls.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.code, "ABCD-1234");

	const down = createRouteHandlers({
		home: ".", log: () => {}, readConfig: () => ({}), writeConfig: async () => {}, restartGateway: () => {},
		adminRequest: async () => undefined,
	});
	const res2 = fakeRes();
	await down.handlePairCodePost(fakeReq(), res2);
	assert.equal(res2.calls.status, 502);
});

test("resolveRemoteHome：显式环境变量优先", () => {
	const saved = process.env.DSH_REMOTE_HOME;
	process.env.DSH_REMOTE_HOME = "C:\\tmp\\dshr-x";
	assert.equal(resolveRemoteHome(), "C:\\tmp\\dshr-x");
	if (saved === undefined) delete process.env.DSH_REMOTE_HOME;
	else process.env.DSH_REMOTE_HOME = saved;
});

test("DISPLAY_DEFAULTS 与网关 DEFAULT_CONFIG 对齐抽查", async () => {
	const { DEFAULT_CONFIG } = await import("../packages/gateway/src/config.ts");
	assert.equal(DISPLAY_DEFAULTS.listenPort, DEFAULT_CONFIG.listenPort);
	assert.equal(DISPLAY_DEFAULTS.upstreamPort, DEFAULT_CONFIG.upstreamPort);
	assert.equal(DISPLAY_DEFAULTS.frp.serverPort, DEFAULT_CONFIG.frp.serverPort);
	assert.equal(DISPLAY_DEFAULTS.autoFixUpstreamPort, DEFAULT_CONFIG.autoFixUpstreamPort);
});
