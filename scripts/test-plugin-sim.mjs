#!/usr/bin/env node
/**
 * 插件模拟运行测试：不碰真实 DSH，用假 ctx 跑 apply()，
 * 验证：网关子进程被拉起、日志转发、dispose 收进程。
 * 需要真实 gateway 包在 ../gateway（workspace 内必然成立）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const tempHome = await mkdtemp(join(tmpdir(), "dshr-plugin-test-"));
process.env.DSH_REMOTE_HOME = tempHome;

// 随机空闲端口：默认 18443 可能被真实部署的网关占用（随 DSH 自启的场景）
const freePort = await new Promise((resolve) => {
	const probe = net.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const port = probe.address().port;
		probe.close(() => resolve(port));
	});
});
await writeFile(
	join(tempHome, "config.json"),
	JSON.stringify({ autoStart: true, listenPort: freePort }),
	"utf8",
);

// 假 cordis ctx
const effects = [];
const fakeCtx = {
	effect(setup, label) {
		const dispose = setup();
		effects.push({ dispose, label });
	},
	on() {},
	get() {
		return undefined;
	},
};

const logs = [];
const originalLog = console.log;
console.log = (...args) => {
	logs.push(args.join(" "));
};

const plugin = (await import("../packages/plugin/lib/index.js")).default;
plugin.apply(fakeCtx);

// 等网关起来（插件内部是异步 spawn）
async function waitPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise((resolveProbe) => {
			const s = net.connect({ host: "127.0.0.1", port }, () => resolveProbe(true));
			s.setTimeout(500, () => {
				s.destroy();
				resolveProbe(false);
			});
			s.on("error", () => resolveProbe(false));
			s.on("connect", () => {
				s.destroy();
				resolveProbe(true);
			});
		});
		if (open) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

let pass = 0;
let fail = 0;
function check(name, ok) {
	console.log = originalLog;
	console.log(`${ok ? "✓" : "✗"} ${name}`);
	if (ok) pass += 1;
	else fail += 1;
	console.log = (...a) => logs.push(a.join(" "));
}

check("ctx.effect 注册了生命周期", effects.length === 1);
const up = await waitPort(freePort, 15000);
check(`网关子进程已监听 ${freePort}`, up);

if (up) {
	// dispose 后进程应收掉
	effects[0].dispose();
	await new Promise((r) => setTimeout(r, 1500));
	const stillUp = await waitPort(freePort, 2000);
	check("dispose 后网关端口已释放", !stillUp);
}

console.log = originalLog;
console.log(`\n日志采样：`);
for (const line of logs.slice(-6)) console.log(`  ${line}`);

await rm(tempHome, { recursive: true, force: true });
console.log(fail === 0 ? "\n模拟运行全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
