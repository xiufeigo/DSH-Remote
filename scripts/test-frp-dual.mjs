import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../packages/gateway/src/config.ts";
import { visitorKeyAdmits } from "../packages/gateway/src/auth.ts";
import { publicEntryEnabled, renderFrpcToml } from "../packages/gateway/src/frp.ts";
import { GatewayServer } from "../packages/gateway/src/server.ts";
import { Store } from "../packages/gateway/src/store.ts";
import { makeTempHome, startFakeUpstream } from "./test-harness.mjs";
import { rm } from "node:fs/promises";

const options = {
	serverAddr: "127.0.0.1", serverPort: 7000, authToken: "test-token",
	localPort: 18443, remotePort: 9443, entryLocalPort: 19443, secretKey: "test-visitor", name: "pc",
};

test("附加公网映射保留访客名称与 fallback，使用独立本地端口", () => {
	for (const mode of ["stcp", "xtcp"]) {
		const toml = renderFrpcToml({ ...options, mode });
		const blocks = toml.split("[[proxies]]").slice(1);
		assert.equal(blocks.length, mode === "xtcp" ? 3 : 2);
		const entry = blocks.find(block => block.includes('type = "tcp"'));
		assert.match(entry, /name = "pc-entry"/);
		assert.match(entry, /localPort = 19443/);
		assert.match(entry, /remotePort = 9443/);
		for (const block of blocks.filter(block => block !== entry)) {
			assert.match(block, /localPort = 18443/);
			assert.ok(!block.includes("remotePort"));
		}
		if (mode === "xtcp") assert.match(toml, /name = "pc-stcp"/);
		assert.match(toml, /name = "pc"/);
		assert.equal((toml.match(/serverAddr =/g) ?? []).length, 1);
	}
});

test("禁用附加映射维持原拓扑；legacy entry 只有一个 TCP 代理", () => {
	for (const mode of ["stcp", "xtcp"]) {
		const toml = renderFrpcToml({ ...options, entryLocalPort: undefined, mode });
		assert.ok(!toml.includes('type = "tcp"'));
		assert.ok(!toml.includes("remotePort"));
	}
	const legacy = renderFrpcToml({ ...options, mode: "entry" });
	assert.equal((legacy.match(/\[\[proxies\]\]/g) ?? []).length, 1);
	assert.match(legacy, /name = "pc"/);
	assert.match(legacy, /localPort = 18443/);
});

test("拒绝将公网 proxy 指向访客免配对端口，以及非法公网端口", () => {
	assert.throws(() => renderFrpcToml({ ...options, mode: "xtcp", entryLocalPort: options.localPort }), /独立/);
	for (const remotePort of [undefined, 0, 65536, 9443.5]) {
		assert.throws(() => renderFrpcToml({ ...options, mode: "xtcp", remotePort }), /remotePort/);
	}
});

test("公网和 edge 不能复用访客密钥准入，附加入口默认关闭", () => {
	for (const mode of ["stcp", "xtcp"]) {
		const config = { ...DEFAULT_CONFIG, frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode, entryEnabled: true } };
		assert.equal(visitorKeyAdmits(config), true);
		assert.equal(visitorKeyAdmits(config, true), false);
		assert.equal(visitorKeyAdmits({ ...config, role: "edge" }), false);
		assert.equal(publicEntryEnabled(config.frp), true);
		assert.equal(publicEntryEnabled({ ...config.frp, entryEnabled: false }), false);
		assert.equal(publicEntryEnabled({ ...config.frp, enabled: false }), false);
	}
	assert.equal(publicEntryEnabled(DEFAULT_CONFIG.frp), false);
});

test("启动期间停止：等待双监听创建完成后统一回收；停止后禁止重启旧实例", async () => {
	const home = await makeTempHome("dshr-start-stop-");
	const upstream = await startFakeUpstream();
	const gateway = new GatewayServer({ store: await Store.open(home), env: {}, config: {
		...structuredClone(DEFAULT_CONFIG), listenPort: 0, upstreamPort: upstream.port, autoFixUpstreamPort: false,
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode: "xtcp", entryEnabled: true, serverAddr: "127.0.0.1" },
	} });
	try {
		const startup = gateway.start();
		await Promise.all([startup, gateway.stop(), gateway.stop()]);
		assert.equal(gateway.actualPort, undefined);
		assert.equal(gateway.frpStatus()?.running ?? false, false);
		await assert.rejects(gateway.start(), /网关已关闭/);
	} finally {
		await gateway.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
});
