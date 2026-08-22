/**
 * 认证与限流：
 * - 设备 Token 放在 httpOnly Cookie（`dr_device`），只存哈希；
 * - 未认证请求统一导向网关自带的一次性配对页（`/__dsh_remote__/pair`）；
 * - 连续配对失败按 IP 锁定；全局每 IP 滑动窗口限流；
 * - 本机管理端点仅接受 127.0.0.1 来源（CLI 与守护进程同机通信）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { GatewayConfig } from "./config.ts";
import type { Store } from "./store.ts";

export const COOKIE_NAME = "dr_device";
export const PAIR_PAGE = "/__dsh_remote__/pair";
export const INTERNAL_PREFIX = "/__dsh_remote__/";

export interface AuthDeps {
	store: Store;
	config: GatewayConfig;
}

// ---------- Cookie ----------

export function parseCookies(header: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!header) return map;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		map.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
	}
	return map;
}

function deviceTokenOf(req: IncomingMessage): string | undefined {
	return parseCookies(req.headers.cookie).get(COOKIE_NAME);
}

// ---------- 限流 / 锁定 ----------

interface Bucket {
	hits: number[];
	lockedUntil: number;
	failCount: number;
}

export class RateLimiter {
	private readonly perMinute: number;
	private readonly lockThreshold: number;
	private readonly lockMinutes: number;
	private buckets = new Map<string, Bucket>();

	constructor(perMinute: number, lockThreshold: number, lockMinutes: number) {
		this.perMinute = perMinute;
		this.lockThreshold = lockThreshold;
		this.lockMinutes = lockMinutes;
	}

	private bucket(ip: string): Bucket {
		let bucket = this.buckets.get(ip);
		if (bucket === undefined) {
			bucket = { hits: [], lockedUntil: 0, failCount: 0 };
			this.buckets.set(ip, bucket);
		}
		return bucket;
	}

	allow(ip: string): boolean {
		const now = Date.now();
		const bucket = this.bucket(ip);
		if (bucket.lockedUntil > now) return false;
		bucket.hits = bucket.hits.filter((at) => now - at < 60_000);
		if (bucket.hits.length >= this.perMinute) return false;
		bucket.hits.push(now);
		return true;
	}

	notePairFail(ip: string): boolean {
		const bucket = this.bucket(ip);
		bucket.failCount += 1;
		if (bucket.failCount >= this.lockThreshold) {
			bucket.lockedUntil = Date.now() + this.lockMinutes * 60_000;
			bucket.failCount = 0;
			return false;
		}
		return true;
	}

	isLocked(ip: string): boolean {
		return this.bucket(ip).lockedUntil > Date.now();
	}
}

// ---------- 判定 ----------

export function isLoopback(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress ?? "";
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function clientIp(req: IncomingMessage): string {
	// 网关只监听回环，frpc 是唯一入口代理；不存在可信任的 X-Forwarded-For 链，
	// 直接用 socket 地址（即 frpc 所在的本机）作为限流键。
	return req.socket.remoteAddress ?? "unknown";
}

/**
 * 请求级认证判定。返回：
 * - `{ ok: true, deviceId }` 已认证；
 * - `{ ok: false, status, reason }` 未认证/被拒，由 server 决定重定向或 401。
 */
export async function checkRequest(
	req: IncomingMessage,
	deps: AuthDeps,
): Promise<{ ok: true; deviceId: string } | { ok: false; status: number; reason: string }> {
	const token = deviceTokenOf(req);
	if (token === undefined || token.length === 0) return { ok: false, status: 401, reason: "no-device-token" };
	const device = await deps.store.deviceByToken(token);
	if (device === undefined) return { ok: false, status: 401, reason: "invalid-device-token" };
	void deps.store.touchDevice(device.id);
	return { ok: true, deviceId: device.id };
}

/** WebSocket 升级请求同样必须带有效设备 Cookie。 */
export async function checkUpgrade(req: IncomingMessage, deps: AuthDeps): Promise<boolean> {
	const result = await checkRequest(req, deps);
	return result.ok;
}

// ---------- 配对码 ----------

export function generatePairingCode(): string {
	// Crockford Base32 去掉易混淆字符，8 位 ≈ 32^8 组合，配合短 TTL 足够
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	const bytes = randomBytes(8);
	let code = "";
	for (const byte of bytes) code += alphabet[byte % alphabet.length];
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function issueDeviceCookie(res: ServerResponse, token: string, days: number): Promise<void> {
	const maxAge = Math.floor(days * 24 * 3600);
	res.setHeader(
		"Set-Cookie",
		`${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
	);
}

export function clearDeviceCookie(res: ServerResponse): void {
	res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}
