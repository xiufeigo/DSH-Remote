/**
 * 持久化层：`<home>/` 下的设备表、配对码、frp 密钥与审计日志。
 *
 * 布局：
 *   config.json            配置（见 config.ts）
 *   state/secrets.json     frp authToken、访客 secretKey 等机密（首次自动生成）
 *   state/devices.json     已配对设备（只存 Token 的 SHA-256，不存原文）
 *   state/pending-codes.json  待使用的一次性配对码（CLI 写入、守护进程消费）
 *   logs/audit.jsonl       审计日志（追加写）
 *   certs/                 网关自签证书
 *   frp/frpc.toml          生成的 frpc 配置
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, appendFile, stat as statFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DEFAULT_CONFIG,
	mergeConfig,
	resolveHome,
	type GatewayConfig,
} from "./config.ts";

export interface DeviceRecord {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastSeenAt: string;
	revokedAt?: string;
}

export interface PendingCode {
	code: string;
	expiresAt: string;
	note?: string;
}

interface SecretsFile {
	/** frpc↔frps 登录密钥 */
	frpAuthToken: string;
	/** stcp/xtcp 访客密钥（proxy 与 visitor 两端必须一致） */
	frpVisitorKey: string;
	/**
	 * 管理端点共享密钥（P0-2）。回环 socket 源地址无法区分「本机 CLI/插件」与
	 * 「同机反代（frpc 隧道/宿主 Caddy）转来的公网流量」，admin 门禁必须叠加
	 * 此密钥；同机消费方读出后经 x-dshr-admin-token 头回传，公网侧无从获取。
	 */
	adminToken: string;
	/** edge 前置门禁 Token 的 SHA-256（hex）；由 DSHR_ACCESS_TOKEN 首启时写入，只存哈希 */
	accessTokenHash?: string;
}

export class Store {
	/** GW-07：POSIX 上敏感文件一律 0o600 落盘（Windows 忽略 mode，无副作用）。 */
	static readonly FILE_MODE = 0o600;
	/** GW-07：POSIX 上数据目录一律 0o700。 */
	static readonly DIR_MODE = 0o700;

	readonly home: string;
	private devicesCache?: { at: number; devices: DeviceRecord[] };
	private constructor(home: string) {
		this.home = home;
	}

	static async open(explicitHome?: string): Promise<Store> {
		const home = resolveHome(explicitHome);
		const subDirs = ["state", "logs", "certs", "frp"];
		for (const dir of subDirs) {
			await mkdir(join(home, dir), { recursive: true });
		}
		// GW-07：POSIX 下启动时把数据根目录与各子目录权限收敛为 0o700
		//（含已存在目录——老安装按默认 umask 755 落盘的，一次收敛到位）。
		// 收敛失败不阻塞启动（如挂载卷不支持 chmod），属纵深防御而非核心功能。
		if (process.platform !== "win32") {
			for (const dir of [home, ...subDirs.map((name) => join(home, name))]) {
				await chmod(dir, Store.DIR_MODE).catch(() => {});
			}
		}
		return new Store(home);
	}

	path(...segments: string[]): string {
		return join(this.home, ...segments);
	}

	// ---------- 通用原子写 ----------

	async writeAtomic(relPath: string, data: string): Promise<void> {
		const target = this.path(relPath);
		await mkdir(dirname(target), { recursive: true });
		const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, data, { encoding: "utf8", mode: Store.FILE_MODE });
		try {
			await renameWithRetry(tmp, target);
		} finally {
			// 成功时 tmp 已被 rename 走（ENOENT 静默）；失败时清理残留临时文件（GW-01）
			await unlink(tmp).catch(() => {});
		}
	}

	async readJson<T>(relPath: string): Promise<T | undefined> {
		try {
			return JSON.parse(await readFile(this.path(relPath), "utf8")) as T;
		} catch (error) {
			// 文件不存在或被原子写清空（如已消费的配对码）都视为缺失
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	// ---------- 配置 ----------

	/**
	 * GW-09：磁盘 config.json 的原始补丁副本（加载时保留）。
	 * 回写时只在它上面打增量，applyEnvOverrides 的运行时覆盖值不会被烙进磁盘。
	 */
	private diskConfigPatch?: Record<string, unknown>;

	async loadConfig(): Promise<GatewayConfig> {
		const patch = (await this.readJson<Record<string, unknown>>("config.json")) ?? {};
		this.diskConfigPatch = patch;
		return mergeConfig(DEFAULT_CONFIG, patch);
	}

	/**
	 * GW-09：增量回写——仅在磁盘原始补丁上更新给定字段后整体写回。
	 * 典型场景：autoFixUpstreamPort 只回写 `upstreamPort`，
	 * 环境变量覆盖（角色/监听面等）保持「重启即失效、不落盘」的承诺。
	 */
	async patchDiskConfig(updates: Record<string, unknown>): Promise<void> {
		const base = this.diskConfigPatch ?? (await this.readJson<Record<string, unknown>>("config.json")) ?? {};
		const next = { ...base, ...updates };
		this.diskConfigPatch = next;
		await this.writeAtomic("config.json", `${JSON.stringify(next, null, "\t")}\n`);
	}

	// ---------- 机密 ----------

	async ensureSecrets(): Promise<SecretsFile> {
		const existing = await this.readJson<SecretsFile>("state/secrets.json");
		if (existing?.frpAuthToken && existing?.frpVisitorKey && existing?.adminToken) return existing;
		// 兼容旧版 secrets.json（缺哪个补哪个，其余保留）
		const fresh: SecretsFile = {
			frpAuthToken: existing?.frpAuthToken ?? randomBytes(32).toString("base64url"),
			frpVisitorKey: existing?.frpVisitorKey ?? randomBytes(32).toString("base64url"),
			adminToken: existing?.adminToken ?? randomBytes(32).toString("base64url"),
			...(existing?.accessTokenHash ? { accessTokenHash: existing.accessTokenHash } : {}),
		};
		await this.writeAtomic("state/secrets.json", `${JSON.stringify(fresh, null, "\t")}\n`);
		return fresh;
	}

	/** 写入（或轮换）edge 门禁 Token 哈希；相同值跳过落盘。 */
	async setAccessTokenHash(hash: string): Promise<void> {
		const secrets = await this.ensureSecrets();
		if (secrets.accessTokenHash === hash) return;
		await this.writeAtomic(
			"state/secrets.json",
			`${JSON.stringify({ ...secrets, accessTokenHash: hash }, null, "\t")}\n`,
		);
	}

	// ---------- 设备 ----------

	async listDevices(): Promise<DeviceRecord[]> {
		// 会话 UI 每次请求都会查设备表，短 TTL 缓存避免每请求读盘
		if (this.devicesCache !== undefined && Date.now() - this.devicesCache.at < 1500) {
			return this.devicesCache.devices;
		}
		const file = await this.readJson<{ devices: DeviceRecord[] }>("state/devices.json");
		const devices = file?.devices ?? [];
		this.devicesCache = { at: Date.now(), devices };
		return devices;
	}

	async saveDevices(devices: DeviceRecord[]): Promise<void> {
		await this.writeAtomic("state/devices.json", `${JSON.stringify({ devices }, null, "\t")}\n`);
		this.devicesCache = { at: Date.now(), devices };
	}

	async deviceByToken(token: string): Promise<DeviceRecord | undefined> {
		const hash = hashToken(token);
		return (await this.listDevices()).find(
			(device) => !device.revokedAt && safeEqualHex(device.tokenHash, hash),
		);
	}

	async addDevice(name: string): Promise<{ device: DeviceRecord; token: string }> {
		const token = randomBytes(32).toString("base64url");
		const now = new Date().toISOString();
		const device: DeviceRecord = {
			id: `dev-${randomBytes(4).toString("hex")}`,
			name: name.trim().length > 0 ? name.trim().slice(0, 64) : "未命名设备",
			tokenHash: hashToken(token),
			createdAt: now,
			lastSeenAt: now,
		};
		const devices = await this.listDevices();
		devices.push(device);
		await this.saveDevices(devices);
		await this.audit("device_paired", { id: device.id, name: device.name });
		return { device, token };
	}

	async touchDevice(id: string): Promise<void> {
		const devices = await this.listDevices();
		const device = devices.find((candidate) => candidate.id === id);
		if (device === undefined) return;
		// 节流：最近 60 秒内已刷新过则跳过落盘
		if (Date.now() - new Date(device.lastSeenAt).getTime() < 60_000) return;
		device.lastSeenAt = new Date().toISOString();
		await this.saveDevices(devices);
	}

	async revokeDevice(id: string): Promise<boolean> {
		const devices = await this.listDevices();
		const device = devices.find((candidate) => candidate.id === id && !candidate.revokedAt);
		if (device === undefined) return false;
		device.revokedAt = new Date().toISOString();
		await this.saveDevices(devices);
		await this.audit("device_revoked", { id });
		return true;
	}

	// ---------- 一次性配对码（CLI 写入 / 守护进程消费） ----------

	/**
	 * SEC-01：进程级核销闸。「读文件 → 校验 → 置空」整条链排入互斥队列串行执行：
	 * 先到者完成置空落盘后，后续并发只能读到空文件返回 false，
	 * 一次性语义不再被 read-check-write 之间的异步间隙突破。
	 * put 也走同一队列，避免消费写空与新码签发互相覆盖。
	 * 多实例并发由 CLI-01 的单实例进程锁兜底。
	 */
	private pendingCodeChain: Promise<unknown> = Promise.resolve();

	private enqueuePendingCode<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.pendingCodeChain.then(fn);
		// 队列永不因单次失败断裂：失败只影响本次调用者
		this.pendingCodeChain = run.then(() => undefined, () => undefined);
		return run;
	}

	async putPendingCode(code: string, ttlMinutes: number, note?: string): Promise<PendingCode> {
		return this.enqueuePendingCode(async () => {
			const pending: PendingCode = { code, expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(), note };
			await this.writeAtomic("state/pending-codes.json", `${JSON.stringify(pending, null, "\t")}\n`);
			return pending;
		});
	}

	/** 校验并消费配对码：有效返回 true（同时删除），否则 false。 */
	async consumePendingCode(code: string): Promise<boolean> {
		return this.enqueuePendingCode(async () => {
			const pending = await this.readJson<PendingCode>("state/pending-codes.json");
			if (pending === undefined) return false;
			if (new Date(pending.expiresAt).getTime() < Date.now()) {
				await this.writeAtomic("state/pending-codes.json", "");
				return false;
			}
			if (!safeEqualUtf8(pending.code, code)) return false;
			// 到这里本次核销已在队列内原子胜出；先置空落盘再返回
			await this.writeAtomic("state/pending-codes.json", "");
			return true;
		});
	}

	// ---------- 审计 ----------

	static readonly AUDIT_MAX_BYTES = 5 * 1024 * 1024;

	async audit(event: string, details: Record<string, unknown> = {}): Promise<void> {
		const auditPath = this.path("logs", "audit.jsonl");
		// 简单轮转：超过 5MB 归档为 .1（保留一代，个人使用足够）
		try {
			const info = await statFile(auditPath);
			if (info !== undefined && info.size > Store.AUDIT_MAX_BYTES) {
				await rename(auditPath, `${auditPath}.1`);
			}
		} catch {
			// 轮转失败不阻塞审计
		}
		const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
		// GW-07：mode 只在文件创建时生效，收敛新建审计日志的权限
		await appendFile(auditPath, line, { encoding: "utf8", mode: Store.FILE_MODE }).catch(() => {});
	}
}

/**
 * GW-01：Windows 上杀毒/索引服务短暂持锁会让 `rename` 抛 EPERM/EBUSY/EACCES，
 * 对这三类错误指数退避重试最多 3 次（50ms → 100ms → 200ms），其余错误直接抛出。
 */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
	const maxRetries = 3;
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmp, target);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
			if (!retryable || attempt >= maxRetries) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
		}
	}
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function safeEqualUtf8(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}
