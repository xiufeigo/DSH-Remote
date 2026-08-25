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
import { mkdir, readFile, rename, appendFile, stat as statFile, writeFile } from "node:fs/promises";
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
}

export class Store {
	readonly home: string;
	private devicesCache?: { at: number; devices: DeviceRecord[] };
	private constructor(home: string) {
		this.home = home;
	}

	static async open(explicitHome?: string): Promise<Store> {
		const home = resolveHome(explicitHome);
		await mkdir(join(home, "state"), { recursive: true });
		await mkdir(join(home, "logs"), { recursive: true });
		await mkdir(join(home, "certs"), { recursive: true });
		await mkdir(join(home, "frp"), { recursive: true });
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
		await writeFile(tmp, data, "utf8");
		await rename(tmp, target);
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

	async loadConfig(): Promise<GatewayConfig> {
		const patch = (await this.readJson<Record<string, unknown>>("config.json")) ?? {};
		return mergeConfig(DEFAULT_CONFIG, patch);
	}

	async saveConfig(config: GatewayConfig): Promise<void> {
		await this.writeAtomic("config.json", `${JSON.stringify(config, null, "\t")}\n`);
	}

	// ---------- 机密 ----------

	async ensureSecrets(): Promise<SecretsFile> {
		const existing = await this.readJson<SecretsFile>("state/secrets.json");
		if (existing?.frpAuthToken && existing?.frpVisitorKey) return existing;
		// 兼容旧版 secrets.json（只有 frpAuthToken）：缺哪个补哪个，其余保留
		const fresh: SecretsFile = {
			frpAuthToken: existing?.frpAuthToken ?? randomBytes(32).toString("base64url"),
			frpVisitorKey: existing?.frpVisitorKey ?? randomBytes(32).toString("base64url"),
		};
		await this.writeAtomic("state/secrets.json", `${JSON.stringify(fresh, null, "\t")}\n`);
		return fresh;
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

	async putPendingCode(code: string, ttlMinutes: number, note?: string): Promise<PendingCode> {
		const pending: PendingCode = { code, expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(), note };
		await this.writeAtomic("state/pending-codes.json", `${JSON.stringify(pending, null, "\t")}\n`);
		return pending;
	}

	/** 校验并消费配对码：有效返回 true（同时删除），否则 false。 */
	async consumePendingCode(code: string): Promise<boolean> {
		const pending = await this.readJson<PendingCode>("state/pending-codes.json");
		if (pending === undefined) return false;
		if (new Date(pending.expiresAt).getTime() < Date.now()) {
			await this.writeAtomic("state/pending-codes.json", "");
			return false;
		}
		if (!safeEqualUtf8(pending.code, code)) return false;
		await this.writeAtomic("state/pending-codes.json", "");
		return true;
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
		await appendFile(auditPath, line, "utf8").catch(() => {});
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
