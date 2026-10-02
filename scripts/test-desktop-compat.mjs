#!/usr/bin/env node
/**
 * 官方桌面端兼容回归（0.1.5 现役 + 0.2.x 前向）：
 *
 *   DESK-01  上游端口精确交接（端到端）：假 ctx 提供 webServer.port → 插件经
 *            DSHR_UPSTREAM_PORT 交给真网关子进程 → admin/status 回显该端口，
 *            且网关按 "configured" 采纳（日志无"上游端口漂移"）。
 *            config.upstreamPort 故意指向死端口 1：交接断了就会走回环扫描，
 *            而扫描命中必然打"上游端口漂移"日志 —— 以此区分两条路径。
 *   DESK-02  settings 双路径：0.1.x register(ns, schema, {applies:'live'})；
 *            0.2.x（register 被移除）降级 configure({auto:true})；两者皆无不炸。
 *   DESK-03  upstreamPortHintFrom 纯函数钉桩（合法透传 / 非法回落 undefined）。
 */

import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

import { requestTls, makeTempHome, waitForPort } from "./test-harness.mjs";

const logs = [];
const originalLog = console.log;
const originalWarn = console.warn;
const out = (line) => originalLog(line);
console.log = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(`[warn] ${a.join(" ")}`);

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	out(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const { default: plugin, upstreamPortHintFrom } = await import("../packages/plugin/lib/index.js");

// ---------- DESK-03：纯函数钉桩 ----------
check("DESK-03  hint：合法端口透传", upstreamPortHintFrom({ port: 19387 }) === 19387);
check("DESK-03  hint：缺失/非法一律 undefined",
	upstreamPortHintFrom(undefined) === undefined
	&& upstreamPortHintFrom(null) === undefined
	&& upstreamPortHintFrom({}) === undefined
	&& upstreamPortHintFrom({ port: 0 }) === undefined
	&& upstreamPortHintFrom({ port: -1 }) === undefined
	&& upstreamPortHintFrom({ port: 70000 }) === undefined
	&& upstreamPortHintFrom({ port: 1.5 }) === undefined
	&& upstreamPortHintFrom({ port: "19387" }) === undefined);

// ---------- 公共夹具 ----------
function makeCtx(settingsService, extra = {}) {
	return {
		effect(setup) {
			const dispose = setup();
			extra.disposers?.push(dispose);
			return dispose;
		},
		on() {},
		inject() {},
		get(name) {
			if (name === "settings") return settingsService;
			if (name === "webServer") return extra.webServer;
			return undefined;
		},
	};
}

// 静默 home（autoStart=false：DESK-02 的 apply 不许拉起真网关）
const quietHome = await makeTempHome("dshr-desk-quiet-");
await writeFile(join(quietHome, "config.json"), JSON.stringify({ autoStart: false, listenPort: 0 }), "utf8");
process.env.DSH_REMOTE_HOME = quietHome;

// ---------- DESK-02：settings 双路径 ----------
try {
	const registerCalls = [];
	plugin.apply(makeCtx({ register: (...args) => registerCalls.push(args) }));
	check("DESK-02  0.1.x：register(dsh-remote, schema, {applies:'live'})",
		registerCalls.length === 1
		&& registerCalls[0][0] === "dsh-remote"
		&& typeof registerCalls[0][1] === "function"
		&& registerCalls[0][1].toJSON !== undefined
		&& registerCalls[0][2]?.applies === "live");

	const configureCalls = [];
	plugin.apply(makeCtx({ configure: (...args) => configureCalls.push(args) }));
	check("DESK-02  0.2.x（register 已移除）：降级 configure({auto:true})",
		configureCalls.length === 1
		&& JSON.stringify(configureCalls[0][0]) === JSON.stringify({ auto: true }));

	let threw = false;
	try {
		plugin.apply(makeCtx({}));
	} catch {
		threw = true;
	}
	check("DESK-02  两者皆无：不抛错", !threw);
} catch (error) {
	check("DESK-02  settings 双路径", false, String(error.message ?? error));
}

// ---------- DESK-01：上游端口精确交接（真网关端到端） ----------
const upstream = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end("<!doctype html><html><body>__dsh_boot__ upstream-port-hint-ok</body></html>");
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const home = await makeTempHome("dshr-desk-compat-");
const listenPort = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const port = probe.address().port;
		probe.close(() => resolve(port));
	});
});
await writeFile(
	join(home, "config.json"),
	JSON.stringify({ autoStart: true, listenPort, upstreamPort: 1 }),
	"utf8",
);

const disposers = [];
try {
	process.env.DSH_REMOTE_HOME = home;
	plugin.apply(makeCtx({}, { webServer: { port: upstreamPort, register() {} }, disposers }));

	const up = await waitForPort(listenPort, 20000);
	check("DESK-01  网关子进程已监听", up, `port=${String(listenPort)}`);

	if (up) {
		const { Store } = await import("../packages/gateway/src/store.ts");
		const store = await Store.open(home);
		const adminToken = (await store.ensureSecrets()).adminToken;
		const status = await requestTls(`https://127.0.0.1:${String(listenPort)}/__dsh_remote__/admin/status`, {
			headers: { "x-dshr-admin-token": adminToken },
		});
		let body = {};
		try {
			body = JSON.parse(status.body);
		} catch { /* 保持空对象，下方断言报错可见 */ }
		check("DESK-01  admin/status.upstream === webServer.port（env 交接生效）",
			status.status === 200 && body.upstream === `127.0.0.1:${String(upstreamPort)}`,
			`upstream=${String(body.upstream ?? "?")}`);
		check("DESK-01  无『上游端口漂移』日志（按 configured 采纳，未走扫描）",
			!logs.some((line) => line.includes("上游端口漂移")));
		check("DESK-01  插件日志含『上游端口精确交接』",
			logs.some((line) => line.includes("上游端口精确交接") && line.includes(String(upstreamPort))));

		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch { /* 逐个兜底 */ }
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const stillUp = await waitForPort(listenPort, 2000);
		check("DESK-01  dispose 后网关端口已释放", !stillUp);
	}
} catch (error) {
	check("DESK-01  上游端口精确交接", false, String(error.message ?? error));
} finally {
	for (const dispose of disposers) {
		try {
			dispose?.();
		} catch { /* 幂等兜底 */ }
	}
	upstream.close();
	await rm(home, { recursive: true, force: true });
	await rm(quietHome, { recursive: true, force: true });
}

console.log = originalLog;
console.warn = originalWarn;
const failed = results.filter((ok) => !ok).length;
out(`\n日志采样（末 5 条）：`);
for (const line of logs.slice(-5)) out(`  ${line}`);
out(failed === 0 ? `\n桌面端兼容回归 ${results.length}/${results.length} 全部通过 ✅` : `\n${String(failed)} 项失败 ❌`);
process.exitCode = failed === 0 ? 0 : 1;
