/**
 * edge 反代电脑端网关时的设备凭据。
 *
 * 浏览器只登录 edge。edge 再拿两边相同的访客密钥，向隧道对端的
 * `/__dsh_remote__/login` 换一张 `dr_device_<实例>` Cookie，注入后续反代。
 * 这张 Cookie 只留在本进程，不下发给浏览器，也不把浏览器的 edge Cookie 转过去。
 */

import https from "node:https";
import net from "node:net";
import { DEVICE_COOKIE_NAME_RE } from "./auth.ts";
import { effectiveUpstreamTls, normalizeEdgeFrpRole, type GatewayConfig } from "./config.ts";

export interface PeerEndpoint {
	host: string;
	port: number;
}

const peerAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 2 });

/** edge 的上游是隧道对端的电脑端网关时，必须先换设备 Cookie。 */
export function edgeNeedsPeerDeviceCookie(config: GatewayConfig): boolean {
	return config.role === "edge"
		&& effectiveUpstreamTls(config)
		&& normalizeEdgeFrpRole(config.frp.edge) !== "off";
}

function authorityOf(upstream: PeerEndpoint): string {
	return `${upstream.host}:${String(upstream.port)}`;
}

/**
 * 只收网关签发的设备 Cookie。名字是 `dr_device_<instanceId>`，
 * 与 auth.ts 的 deviceCookieName / DEVICE_COOKIE_NAME_RE 是同一条规则；改名时两边一起改，否则 edge 会静默 502。
 */
function deviceCookiePairs(setCookies: string[]): string | undefined {
	const pairs: string[] = [];
	for (const header of setCookies) {
		const pair = header.split(";", 1)[0]?.trim() ?? "";
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (!DEVICE_COOKIE_NAME_RE.test(name) || value.length === 0) continue;
		pairs.push(`${name}=${value}`);
	}
	return pairs.length > 0 ? pairs.join("; ") : undefined;
}

export class PeerDeviceSession {
	private readonly log: (line: string) => void;
	private cookie?: string;
	private cookieAuthority?: string;
	private readonly inflight = new Map<string, Promise<string | undefined>>();
	/** 对端 403/429 后停掉的访客密钥。换密钥或进程重启才再试，避免打满电脑端 127.0.0.1 锁定桶。 */
	private readonly stoppedKeys = new Map<string, string>();

	constructor(log?: (line: string) => void) {
		this.log = log ?? (() => {});
	}

	invalidate(upstream: PeerEndpoint): void {
		if (this.cookieAuthority === authorityOf(upstream)) {
			this.cookie = undefined;
			this.cookieAuthority = undefined;
		}
	}

	/** 拿到可注入的 Cookie 头；失败返回 undefined，调用方不要把登录跳转透给浏览器。 */
	ensure(upstream: PeerEndpoint, visitorKey: string): Promise<string | undefined> {
		const key = visitorKey.trim();
		if (key.length === 0) return Promise.resolve(undefined);
		const authority = authorityOf(upstream);
		if (this.cookieAuthority === authority && this.cookie !== undefined) return Promise.resolve(this.cookie);
		const pending = this.inflight.get(authority);
		if (pending !== undefined) return pending;
		if (this.stoppedKeys.get(authority) === key) return Promise.resolve(undefined);
		const job = this.exchange(authority, upstream, key).finally(() => {
			this.inflight.delete(authority);
		});
		this.inflight.set(authority, job);
		return job;
	}

	private exchange(authority: string, upstream: PeerEndpoint, visitorKey: string): Promise<string | undefined> {
		const body = JSON.stringify({ token: visitorKey, name: "edge" });
		return new Promise<string | undefined>((resolve) => {
			let settled = false;
			const finish = (cookie: string | undefined) => {
				if (settled) return;
				settled = true;
				resolve(cookie);
			};
			const req = https.request({
				host: upstream.host,
				port: upstream.port,
				path: "/__dsh_remote__/login",
				method: "POST",
				agent: peerAgent,
				rejectUnauthorized: false,
				...(net.isIP(upstream.host) ? {} : { servername: upstream.host }),
				timeout: 8_000,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(body),
				},
			}, (res) => {
				res.resume();
				const status = res.statusCode ?? 0;
				const raw = res.headers["set-cookie"];
				const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
				const cookie = status === 200 ? deviceCookiePairs(setCookies) : undefined;
				if (cookie !== undefined) {
					this.cookie = cookie;
					this.cookieAuthority = authority;
					this.stoppedKeys.delete(authority);
					this.log(`已用访客密钥登录对端网关 ${authority}`);
					finish(cookie);
					return;
				}
				if (status === 403 || status === 429) {
					this.stoppedKeys.set(authority, visitorKey);
					this.log(status === 403
						? `对端网关 ${authority} 拒绝访客密钥，已停止重试。请核对接线两端的访客密钥是否一致，改好后重启 edge。`
						: `对端网关 ${authority} 已锁定来自隧道的登录，已停止重试，避免和手机自动登录共用的 127.0.0.1 桶继续被打满。`);
				} else {
					this.log(`对端网关 ${authority} 登录未成功（HTTP ${String(status)}）`);
				}
				finish(undefined);
			});
			req.on("error", () => finish(undefined));
			req.on("timeout", () => {
				req.destroy();
				finish(undefined);
			});
			req.end(body);
		});
	}
}
