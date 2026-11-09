/**
 * 网关单实例锁（CLI-01）。
 *
 * 旧实现只往 `gateway.lock` 写一行 pid，判活靠 `process.kill(pid, 0)`，并把
 * EPERM 当成「进程存在但无权发信号」。Windows 的 PID 会被系统复用，回收到的
 * 进程权限更高时 kill(0) 抛 EPERM —— 陈旧锁就被永久误判成「已有网关在运行」，
 * 网关再也起不来（2026-11-08 实锤：11/6 残留的 pid 9764 被系统进程复用）。
 *
 * 新格式（JSON 一行）记录 pid / startedAt / exe / host / port / token：
 *   1. pid 明确不存在（ESRCH）→ 陈旧锁，直接清理；
 *   2. pid 存在（或 EPERM 无法判定）→ 用管理端点核对身份：网关在
 *      `/__dsh_remote__/admin/status` 里回显本次锁令牌，令牌一致才算「真在运行」；
 *   3. 管理端点无法判定时，只有**刚创建**（启动窗口内）的锁才保守视为「正在启动」。
 * 旧格式（纯 pid 一行）仍可识别：管理端点有响应即视为在用网关，否则按陈旧处理。
 */

import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

/** 锁文件版本号。 */
export const LOCK_VERSION = 1;
/** 新锁刚创建后的启动窗口：管理端点尚不可判定时保守视为「正在启动」。 */
export const STARTUP_GRACE_MS = 15_000;
/** 管理端点探测失败时，单次请求的超时。 */
const PROBE_TIMEOUT_MS = 3_000;

export interface InstanceLockRecord {
	version: typeof LOCK_VERSION;
	pid: number;
	/** 写锁时刻（ISO）；用于区分「刚启动」与「陈旧锁」。 */
	startedAt: string;
	/** 网关进程可执行文件（诊断用）。 */
	exe: string;
	/** 管理端点探测地址（listenHost 归一化后的回环地址）。 */
	host: string;
	port: number;
	/** 本次启动的随机令牌；网关在 admin/status 原样回显，用于核对锁的主人。 */
	token: string;
}

/** 交给探测器的锁持有者信息；旧格式锁没有 token。 */
export interface LockHolderProbe {
	host: string;
	port: number;
	pid: number;
	token?: string;
}

/** true=确实是锁里那个网关；false=端口上不是它；undefined=无法判定。 */
export type LockProbeResult = boolean | undefined;

export interface LockDeps {
	/** true=存活；false=确认不存在；undefined=无法判定（如 EPERM / PID 复用）。 */
	isPidAlive(pid: number): boolean | undefined;
	probeLockHolder(holder: LockHolderProbe): Promise<LockProbeResult>;
	/** 时钟注入（测试用）；缺省 Date.now。 */
	now?(): number;
	/** 诊断日志；缺省静默。 */
	log?(line: string): void;
}

export interface ParsedLock {
	record?: InstanceLockRecord;
	/** 旧格式：一行纯 pid。 */
	legacyPid?: number;
}

export type LockVerdictReason =
	| "corrupt"
	| "stale-dead-pid"
	| "stale-unverified"
	| "live-verified"
	| "live-unverifiable-fresh";

export interface LockVerdict {
	live: boolean;
	reason: LockVerdictReason;
	holderPid?: number;
}

/** 生成新锁令牌（32 位 hex）。 */
export function newLockToken(): string {
	return randomBytes(16).toString("hex");
}

/** 解析锁文件：优先 JSON 新格式，回退旧格式（纯 pid 一行）。 */
export function parseLockFile(raw: string): ParsedLock {
	const text = raw.trim();
	if (text.length === 0) return {};
	try {
		const value = JSON.parse(text) as Partial<InstanceLockRecord> | null;
		if (
			value !== null
			&& typeof value === "object"
			&& value.version === LOCK_VERSION
			&& Number.isInteger(value.pid)
			&& (value.pid as number) > 0
			&& typeof value.token === "string"
			&& value.token.length > 0
		) {
			return { record: value as InstanceLockRecord };
		}
	} catch {
		// 旧格式或损坏内容，继续按纯 pid 解析
	}
	const pid = Number.parseInt(text, 10);
	return Number.isInteger(pid) && pid > 0 ? { legacyPid: pid } : {};
}

/**
 * 判定现有锁的持有者是否还活着。
 *
 * @param parsed 已解析的锁内容
 * @param fallback 旧格式锁没有记录 host/port 时，用当前实例的监听地址探测
 * @param deps 存活/探测依赖
 */
export async function evaluateLock(
	parsed: ParsedLock,
	fallback: { host: string; port: number },
	deps: LockDeps,
): Promise<LockVerdict> {
	const holderPid = parsed.record?.pid ?? parsed.legacyPid;
	if (holderPid === undefined) return { live: false, reason: "corrupt" };

	const alive = deps.isPidAlive(holderPid);
	if (alive === false) return { live: false, reason: "stale-dead-pid", holderPid };

	const verdict = parsed.record !== undefined
		? await deps.probeLockHolder({
			host: parsed.record.host,
			port: parsed.record.port,
			pid: parsed.record.pid,
			token: parsed.record.token,
		})
		: await deps.probeLockHolder({ host: fallback.host, port: fallback.port, pid: holderPid });

	if (verdict === true) return { live: true, reason: "live-verified", holderPid };
	if (verdict === false) return { live: false, reason: "stale-unverified", holderPid };

	// 管理端点无法判定：只有刚写下的新锁才保守视为「正在启动」。
	const startedAt = parsed.record !== undefined ? Date.parse(parsed.record.startedAt) : Number.NaN;
	const now = deps.now !== undefined ? deps.now() : Date.now();
	if (Number.isFinite(startedAt) && now - startedAt < STARTUP_GRACE_MS) {
		return { live: true, reason: "live-unverifiable-fresh", holderPid };
	}
	return { live: false, reason: "stale-unverified", holderPid };
}

function reasonText(reason: LockVerdictReason): string {
	switch (reason) {
		case "stale-dead-pid": return "原进程已不存在";
		case "stale-unverified": return "管理端点无响应，判定不是在用网关";
		case "corrupt": return "锁内容损坏或为空";
		default: return reason;
	}
}

/** 原子创建锁文件（'wx' 排他）；已存在返回 false。 */
async function createLock(lockPath: string, record: InstanceLockRecord): Promise<boolean> {
	let handle;
	try {
		handle = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`);
	} finally {
		await handle.close();
	}
	return true;
}

/**
 * 获取单实例排他锁。拿到返回锁文件路径；冲突（确有网关在运行）返回 undefined。
 * 陈旧锁（原进程已退出 / PID 被复用 / 内容损坏）自动清除并重抢一次。
 */
export async function acquireInstanceLock(
	lockPath: string,
	record: InstanceLockRecord,
	deps: LockDeps,
): Promise<string | undefined> {
	if (await createLock(lockPath, record)) return lockPath;

	let raw = "";
	try {
		raw = await readFile(lockPath, "utf8");
	} catch {
		raw = "";
	}
	const parsed = parseLockFile(raw);
	const verdict = await evaluateLock(parsed, { host: record.host, port: record.port }, deps);
	if (verdict.live) {
		const pidText = verdict.holderPid !== undefined ? String(verdict.holderPid) : "未知";
		deps.log?.(`已有网关实例在运行（pid=${pidText}，锁文件 ${lockPath}）。`);
		return undefined;
	}

	await unlink(lockPath).catch(() => {});
	if (!(await createLock(lockPath, record))) {
		deps.log?.(`已有网关实例在运行（锁文件 ${lockPath}）。`);
		return undefined;
	}
	const pidText = verdict.holderPid !== undefined ? String(verdict.holderPid) : "不可读";
	deps.log?.(`[dsh-remote] 已清除陈旧锁文件（原 pid=${pidText}；${reasonText(verdict.reason)}）`);
	return lockPath;
}

/**
 * 探测 pid 是否存活：
 * - true：进程存在；
 * - false：确认不存在（ESRCH）；
 * - undefined：存在但无法判定（EPERM 等，也可能是 PID 复用），交由锁身份核对决定。
 */
export function probePidAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		return undefined;
	}
}

/**
 * 更新已持有的锁记录（原子写）。用于 listenPort=0 时把 OS 分配的真实端口回填，
 * 否则后续判活探测会一直打到端口 0 上。
 */
export async function updateLockRecord(
	lockPath: string,
	patch: Partial<Pick<InstanceLockRecord, "host" | "port">>,
): Promise<void> {
	let raw;
	try {
		raw = await readFile(lockPath, "utf8");
	} catch {
		return;
	}
	const parsed = parseLockFile(raw);
	if (parsed.record === undefined) return;
	const next: InstanceLockRecord = { ...parsed.record, ...patch };
	const tmp = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await rename(tmp, lockPath);
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

/** 供 CLI 复用的管理端点探测超时。 */
export function probeTimeoutMs(): number {
	return PROBE_TIMEOUT_MS;
}
