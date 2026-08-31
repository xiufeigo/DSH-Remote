/**
 * 认证与限流：
 * - 设备 Token 放在 httpOnly Cookie（`dr_device`），只存哈希；
 * - 未认证请求统一导向网关自带的一次性配对页（`/__dsh_remote__/pair`）；
 * - 连续配对失败按 IP 锁定；全局每 IP 滑动窗口限流；
 * - 本机管理端点仅接受 127.0.0.1 来源（CLI 与守护进程同机通信）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GatewayConfig } from "./config.ts";
import type { Store } from "./store.ts";

export const COOKIE_NAME = "dr_device";
export const PAIR_PAGE = "/__dsh_remote__/pair";
export const LOGIN_PAGE = "/__dsh_remote__/login";
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
	/** 最近活动时间（GW-02：容量上限淘汰按最老活跃时间排序） */
	lastSeenAt: number;
}

export class RateLimiter {
	/** GW-02：桶数量上限——公网扫描场景下每个来源 IP 建桶，必须可淘汰防 OOM。 */
	static readonly MAX_BUCKETS = 20_000;
	/** GW-02：过期桶清理周期（5 分钟）。 */
	static readonly SWEEP_INTERVAL_MS = 5 * 60_000;

	private readonly perMinute: number;
	private readonly lockThreshold: number;
	private readonly lockMinutes: number;
	private buckets = new Map<string, Bucket>();
	private readonly sweepTimer: NodeJS.Timeout;

	constructor(perMinute: number, lockThreshold: number, lockMinutes: number) {
		this.perMinute = perMinute;
		this.lockThreshold = lockThreshold;
		this.lockMinutes = lockMinutes;
		this.sweepTimer = setInterval(() => this.sweepExpired(), RateLimiter.SWEEP_INTERVAL_MS);
		// 清理定时器不阻塞进程退出（对测试与短命令友好）
		this.sweepTimer.unref();
	}

	/** 停止后台清理定时器（网关停机时调用；重复调用无害）。 */
	stop(): void {
		clearInterval(this.sweepTimer);
	}

	private bucket(ip: string): Bucket {
		let bucket = this.buckets.get(ip);
		if (bucket === undefined) {
			if (this.buckets.size >= RateLimiter.MAX_BUCKETS) this.makeRoom();
			bucket = { hits: [], lockedUntil: 0, failCount: 0, lastSeenAt: Date.now() };
			this.buckets.set(ip, bucket);
		}
		bucket.lastSeenAt = Date.now();
		return bucket;
	}

	/** GW-02：到达容量上限时先整体清一遍过期桶；仍超限则按最老活跃时间淘汰一个（不动锁定中的桶）。 */
	private makeRoom(): void {
		this.sweepExpired();
		if (this.buckets.size < RateLimiter.MAX_BUCKETS) return;
		const now = Date.now();
		let oldestIp: string | undefined;
		let oldestAt = Infinity;
		for (const [ip, candidate] of this.buckets) {
			if (candidate.lockedUntil > now) continue;
			if (candidate.lastSeenAt < oldestAt) {
				oldestAt = candidate.lastSeenAt;
				oldestIp = ip;
			}
		}
		if (oldestIp !== undefined) this.buckets.delete(oldestIp);
	}

	/** GW-02：清理 hits 全过期且未锁定的桶（锁定桶保留，锁定语义不能提前失效）。 */
	private sweepExpired(): void {
		const now = Date.now();
		for (const [ip, bucket] of this.buckets) {
			if (bucket.lockedUntil > now) continue;
			if (bucket.hits.every((at) => now - at >= 60_000)) this.buckets.delete(ip);
		}
	}

	/** 测试与诊断用：当前桶数量。 */
	get size(): number {
		return this.buckets.size;
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

/** GW-03：归一化 IPv4 映射地址（`::ffff:1.2.3.4` → `1.2.3.4`），保证限流键一致。 */
export function normalizeIp(addr: string): string {
	return addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
}

// ---------- GW-03 补全：CIDR 匹配（零依赖） ----------

/** 将点分十进制 IPv4 解析为 32 位无符号整数，失败返回 undefined。 */
function parseIpv4(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	let n = 0;
	for (const p of parts) {
		const v = Number.parseInt(p, 10);
		if (!Number.isInteger(v) || v < 0 || v > 255 || String(v) !== p) return undefined;
		n = (n << 8) | v;
	}
	return n >>> 0;
}

/** 判断 IPv4 地址是否命中 CIDR（如 `172.16.0.0/12`），支持精确匹配（无 `/` 等价 `/32`）。 */
function ipv4MatchesCidr(ip: string, cidr: string): boolean {
	const slashIdx = cidr.indexOf("/");
	const baseStr = slashIdx >= 0 ? cidr.slice(0, slashIdx) : cidr;
	const prefixLen = slashIdx >= 0 ? Number.parseInt(cidr.slice(slashIdx + 1), 10) : 32;
	if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
	const ipNum = parseIpv4(ip);
	const baseNum = parseIpv4(baseStr);
	if (ipNum === undefined || baseNum === undefined) return false;
	if (prefixLen === 0) return true;
	const mask = (~0 << (32 - prefixLen)) >>> 0;
	return (ipNum & mask) === (baseNum & mask);
}

/**
 * GW-03 补全：判断归一化后的 IP 是否命中受信 CIDR 列表。
 * 支持 IPv4 CIDR + 精确 IP 匹配。非法条目忽略（非静默：日志一次）。
 */
const _warnedCidrs = new Set<string>();
function isTrustedProxy(normalizedIp: string, cidrs: string[]): boolean {
	for (const cidr of cidrs) {
		if (ipv4MatchesCidr(normalizedIp, cidr)) return true;
		// IPv6 精确匹配兜底
		if (!cidr.includes("/") && normalizeIp(cidr) === normalizedIp) return true;
		// 对无法解析的条目告警一次（不是 IPv4 CIDR 也不是精确匹配）
		if (!cidr.includes("/") && parseIpv4(cidr) === undefined && !_warnedCidrs.has(cidr)) {
			_warnedCidrs.add(cidr);
			console.warn(`[dsh-remote] trustProxyCidrs: 忽略无法解析的条目 "${cidr}"`);
		}
	}
	return false;
}

/**
 * GW-03：限流/锁定用的客户端 IP。
 *
 * 缺省不信任任何 X-Forwarded-For（直接用 socket 地址）。仅当
 * `auth.trustProxyXff === true` **且** 直连方本身来自回环或命中
 * `auth.trustProxyCidrs` 受信网段时，才采信 `X-Forwarded-For` 最左一跳——
 * 外部直连请求伪造的 XFF 头因来源不受信一律不采信。
 * `config` 缺省时行为退回纯 socket 地址（与旧调用兼容）。
 */
export function clientIp(req: IncomingMessage, config?: GatewayConfig): string {
	const remote = req.socket.remoteAddress ?? "unknown";
	if (config?.auth?.trustProxyXff === true) {
		const normalizedRemote = normalizeIp(remote);
		const isLoopbackAddr = normalizedRemote === "127.0.0.1" || normalizedRemote === "::1";
		const cidrs = config.auth.trustProxyCidrs ?? [];
		if (isLoopbackAddr || isTrustedProxy(normalizedRemote, cidrs)) {
			const header = req.headers["x-forwarded-for"];
			const raw = Array.isArray(header) ? header[0] : header;
			const firstHop = raw?.split(",")[0]?.trim();
			if (firstHop !== undefined && firstHop.length > 0) return normalizeIp(firstHop);
		}
	}
	return normalizeIp(remote);
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

/**
 * stcp/xtcp 下隧道本身就是准入：VPS 不开入口，只有持有访客密钥的 frpc visitor
 * 能打到本机网关。此时不再要求一次性配对码 / 扫码。
 */
export function visitorKeyAdmits(config: GatewayConfig): boolean {
	if (config.frp.enabled !== true) return false;
	const mode = config.frp.mode;
	return mode === "stcp" || mode === "xtcp";
}

// ---------- edge 前置 Token 门禁 ----------

/** 明文访问 Token → SHA-256 hex（与设备 Token 同一套哈希管线）。 */
export function hashAccessToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 校验明文访问 Token 与持久化哈希是否一致（恒时比较）。
 * 未配置哈希（undefined / 长度不对）一律拒绝 —— 门禁缺失时应走配对页而非放行。
 */
export function verifyAccessToken(input: string, storedHash: string | undefined): boolean {
	// GW-14：超长输入直接拒绝，避免对无谓的大 Token 做 SHA-256（防资源滥用）
	if (typeof input !== "string" || input.length > 256) return false;
	if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
	const candidate = hashAccessToken(input);
	return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(storedHash, "utf8"));
}

/**
 * 解析生效的访问 Token 哈希：
 * - env 提供明文 `DSHR_ACCESS_TOKEN` 时以其为准，哈希后立即持久化进 secrets
 *   （轮换 = 改 env 重启；明文不落盘、不进配置文件）；
 * - 否则读 secrets 中已存的 `accessTokenHash`。
 * 返回 undefined 表示未配置门禁（edge 下 doctor 会告警，请求走配对页）。
 */
export async function ensureAccessTokenHash(
	store: Store,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const raw = env["DSHR_ACCESS_TOKEN"];
	if (typeof raw === "string" && raw.trim().length >= 8) {
		const hash = hashAccessToken(raw.trim());
		await store.setAccessTokenHash(hash);
		return hash;
	}
	return (await store.ensureSecrets()).accessTokenHash;
}
