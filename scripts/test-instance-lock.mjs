#!/usr/bin/env node
/**
 * gateway.lock 单实例锁回归测试。
 *
 * 背景（2026-11-08 实锤）：旧实现只往锁里写 pid，判活靠 kill(pid, 0)，并把 EPERM
 * 当「进程存在但无权发信号」。Windows PID 被系统复用后，陈旧锁永远被判成
 * 「已有网关在运行」，网关再也起不来。这里钉住新逻辑：
 *   - 旧格式 / 损坏 / pid 已死 / pid 被复用（管理端点不是本网关）→ 清锁重抢；
 *   - 真在运行（管理端点回显同一 lockToken）→ 拒绝启动，且不改动锁文件；
 *   - 端到端：旧格式锁指向「活着的非网关进程」时，网关仍能正常启动。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LOCK_VERSION,
	STARTUP_GRACE_MS,
	acquireInstanceLock,
	newLockToken,
	parseLockFile,
	probePidAlive,
} from "../packages/gateway/src/instance-lock.ts";
import { createTestGateway, startFakeUpstream } from "./test-harness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "gateway", "src", "cli.ts");

async function tempLockPath() {
	const dir = await mkdtemp(join(tmpdir(), "dshr-lock-"));
	return join(dir, "gateway.lock");
}

function makeRecord(ageMs = 0, overrides = {}) {
	return {
		version: LOCK_VERSION,
		pid: 4242,
		startedAt: new Date(Date.now() - ageMs).toISOString(),
		exe: process.execPath,
		host: "127.0.0.1",
		port: 18443,
		token: newLockToken(),
		...overrides,
	};
}

/** 注入式依赖桩：默认「pid 已死」，按用例覆盖（显式传 undefined 表示无法判定）。 */
function makeDeps(opts = {}) {
	const alive = "alive" in opts ? opts.alive : false;
	const probe = "probe" in opts ? opts.probe : undefined;
	const now = typeof opts.now === "function" ? opts.now : Date.now;
	const logs = Array.isArray(opts.logs) ? opts.logs : [];
	return {
		isPidAlive: () => alive,
		probeLockHolder: async () => probe,
		now: () => now(),
		log: (line) => logs.push(line),
	};
}

test("parseLockFile：JSON 新格式 / 旧 pid 行 / 空 / 损坏", () => {
	const record = makeRecord();
	const parsed = parseLockFile(`${JSON.stringify(record)}\n`);
	assert.equal(parsed.record?.pid, record.pid);
	assert.equal(parsed.record?.token, record.token);

	assert.equal(parseLockFile("4242\n").legacyPid, 4242);
	assert.deepEqual(parseLockFile("   \n"), {});
	assert.deepEqual(parseLockFile("not-a-lock"), {});
	assert.deepEqual(parseLockFile('{"version":1}'), {});
});

test("acquireInstanceLock：无锁时创建 JSON 锁", async () => {
	const lockPath = await tempLockPath();
	const record = makeRecord();
	const got = await acquireInstanceLock(lockPath, record, makeDeps());
	assert.equal(got, lockPath);
	const saved = parseLockFile(await readFile(lockPath, "utf8"));
	assert.equal(saved.record?.version, LOCK_VERSION);
	assert.equal(saved.record?.pid, record.pid);
	assert.equal(saved.record?.token, record.token);
	assert.match(saved.record?.token ?? "", /^[0-9a-f]{32}$/);
});

test("acquireInstanceLock：旧格式锁 + pid 已死 → 清锁重抢", async () => {
	const lockPath = await tempLockPath();
	await writeFile(lockPath, "999999\n", "utf8");
	const logs = [];
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: false, logs }));
	assert.equal(got, lockPath);
	assert.ok(logs.some((line) => line.includes("已清除陈旧锁文件") && line.includes("原进程已不存在")), logs.join("\n"));
	assert.equal(parseLockFile(await readFile(lockPath, "utf8")).record?.pid, 4242);
});

test("acquireInstanceLock：EPERM 无法判定 + 管理端点无响应 → 清锁重抢（PID 复用实锤场景）", async () => {
	const lockPath = await tempLockPath();
	await writeFile(lockPath, "9764\n", "utf8");
	const logs = [];
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: undefined, probe: undefined, logs }));
	assert.equal(got, lockPath, "PID 被系统进程复用导致的 EPERM 不应再挡住启动");
	assert.ok(logs.some((line) => line.includes("已清除陈旧锁文件") && line.includes("管理端点无响应")), logs.join("\n"));
});

test("acquireInstanceLock：管理端点回显同 lockToken → 拒绝（真在运行）", async () => {
	const lockPath = await tempLockPath();
	const holder = makeRecord(0);
	await writeFile(lockPath, `${JSON.stringify(holder)}\n`, "utf8");
	const before = await readFile(lockPath, "utf8");
	const logs = [];
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: true, probe: true, logs }));
	assert.equal(got, undefined);
	assert.ok(logs.some((line) => line.includes("已有网关实例在运行") && line.includes(holder.pid)), logs.join("\n"));
	assert.equal(await readFile(lockPath, "utf8"), before, "拒绝启动时不得改动锁文件");
});

test("acquireInstanceLock：管理端点回显别的 lockToken → 清锁重抢（PID 被复用）", async () => {
	const lockPath = await tempLockPath();
	const holder = makeRecord(60_000);
	await writeFile(lockPath, `${JSON.stringify(holder)}\n`, "utf8");
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: true, probe: false }));
	assert.equal(got, lockPath);
	const saved = parseLockFile(await readFile(lockPath, "utf8"));
	assert.notEqual(saved.record?.token, holder.token);
});

test("acquireInstanceLock：管理端点不可判定 + 刚创建的锁 → 保守拒绝（启动中）", async () => {
	const lockPath = await tempLockPath();
	const holder = makeRecord(1_000);
	await writeFile(lockPath, `${JSON.stringify(holder)}\n`, "utf8");
	const logs = [];
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: true, probe: undefined, logs }));
	assert.equal(got, undefined);
	assert.ok(logs.some((line) => line.includes("已有网关实例在运行")), logs.join("\n"));
});

test("acquireInstanceLock：管理端点不可判定 + 锁已陈旧 → 清锁重抢", async () => {
	const lockPath = await tempLockPath();
	const holder = makeRecord(STARTUP_GRACE_MS + 5_000);
	await writeFile(lockPath, `${JSON.stringify(holder)}\n`, "utf8");
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ alive: true, probe: undefined }));
	assert.equal(got, lockPath);
});

test("acquireInstanceLock：锁内容损坏 → 清锁重抢", async () => {
	const lockPath = await tempLockPath();
	await writeFile(lockPath, "garbage", "utf8");
	const logs = [];
	const got = await acquireInstanceLock(lockPath, makeRecord(), makeDeps({ logs }));
	assert.equal(got, lockPath);
	assert.ok(logs.some((line) => line.includes("已清除陈旧锁文件") && line.includes("锁内容损坏")), logs.join("\n"));
});

test("probePidAlive：本进程判活，不存在的 pid 不为 true", () => {
	assert.equal(probePidAlive(process.pid), true);
	// Windows 上 0x7fffffff 一般不存在；权限受限环境下允许返回 undefined，但绝不能是 true
	assert.notEqual(probePidAlive(0x7fff_ffff), true);
});

/** 轮询等待锁文件落成带真实端口的 JSON（listenPort=0 时 CLI 在监听后回填端口）。 */
async function waitForLockRecord(lockPath, timeoutMs = 5_000) {
	const started = Date.now();
	for (;;) {
		try {
			const parsed = parseLockFile(await readFile(lockPath, "utf8"));
			if (parsed.record !== undefined && Number.isInteger(parsed.record.port) && parsed.record.port > 0) {
				return parsed.record;
			}
		} catch {
			// 文件尚未出现/正被原子替换，继续等
		}
		if (Date.now() - started > timeoutMs) throw new Error(`等待锁文件就绪超时（${timeoutMs}ms）：${lockPath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("E2E：旧格式锁指向活着的非网关进程（PID 复用）不再挡住启动", async (t) => {
	const upstream = await startFakeUpstream();
	const gw = await createTestGateway({
		label: "lock-reused-pid",
		config: { upstreamPort: upstream.port, listenPort: 0, autoFixUpstreamPort: false },
		prepare: async (home) => {
			// 指向测试进程自己：pid 活着、同用户，但并不是网关（模拟 PID 被复用）
			await writeFile(join(home, "gateway.lock"), `${process.pid}\n`, "utf8");
		},
	});
	t.after(async () => {
		await gw.destroy();
		await upstream.close();
	});
	const saved = await waitForLockRecord(join(gw.home, "gateway.lock"));
	assert.equal(saved.pid, gw.pid);
	assert.equal(saved.port, gw.port, "listenPort=0 时应回填真实端口供后续判活探测");
	assert.ok(gw.errorOutput().includes("已清除陈旧锁文件"), `应记录清锁原因：\n${gw.errorOutput()}`);
});

test("E2E：网关真在跑时第二个实例被拒且不抢锁", async (t) => {
	const upstream = await startFakeUpstream();
	const gw = await createTestGateway({
		label: "lock-live",
		config: { upstreamPort: upstream.port, listenPort: 0, autoFixUpstreamPort: false },
	});
	t.after(async () => {
		await gw.destroy();
		await upstream.close();
	});
	await waitForLockRecord(join(gw.home, "gateway.lock"));
	const before = await readFile(join(gw.home, "gateway.lock"), "utf8");

	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("DSHR_")) delete childEnv[key];
	}
	childEnv.DSH_REMOTE_HOME = gw.home;

	const result = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "start"], {
			cwd: repoRoot,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`第二个实例未在 15s 内退出：\n${stdout}\n${stderr}`));
		}, 15_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});

	assert.equal(result.code, 1, `第二个实例应拒绝启动：\n${result.stderr}`);
	assert.ok(result.stderr.includes("已有网关实例在运行"), result.stderr);
	assert.equal(await readFile(join(gw.home, "gateway.lock"), "utf8"), before, "拒绝启动时不得改动锁文件");
});
