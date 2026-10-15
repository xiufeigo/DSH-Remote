/**
 * WebSocket 升级入口：先要求 Origin 与 Host 同源，再走设备 Cookie（不再凭访客密钥直通），
 * 随后交 proxyUpgrade 按原始字节管道直通上游。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { INTERNAL_PREFIX, checkRequest, sameOriginAsHost } from "./auth.ts";
import { wsPingIntervalMs, type GatewayConfig } from "./config.ts";
import { proxyUpgrade, type Upstream } from "./proxy.ts";
import type { Store } from "./store.ts";

export interface UpgradeDeps {
	config: GatewayConfig;
	store: Store;
	/** 由监听入口传入；公网入口必须验证设备 Cookie。 */
	publicEntry?: boolean;
	/** 与 HTTP 相同的当前登录凭据绑定。 */
	credentialHash?: string;
	/** 本实例设备 Cookie 名后缀。 */
	instanceId?: string;
	/** 生效上游地址（含会话 Cookie / edge 对端设备 Cookie）。 */
	resolveUpstream: () => Upstream | Promise<Upstream>;
	/** edge 反代电脑端时，没有对端设备 Cookie 就不要把升级请求打过去。 */
	peerCookieRequired?: boolean;
}

export async function handleGatewayUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	deps: UpgradeDeps,
): Promise<void> {
	const url = req.url ?? "/";
	// 升级请求按原始字节直通上游，控制字符必须在此拦死（防走私）
	if (/[\r\n\0]/.test(url)) {
		socket.destroy();
		return;
	}
	if (url.startsWith(INTERNAL_PREFIX)) {
		socket.destroy();
		return;
	}
	if (!sameOriginAsHost(req)) {
		socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	const verdict = await checkRequest(req, deps);
	if (!verdict.ok) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
		socket.destroy();
		await deps.store.audit("upgrade_rejected", { path: url.split("?")[0] });
		return;
	}
	if (head.length > 4096) {
		// P3-10：礼貌回 413 再关（与上方 401 拒绝同风格），不再裸 destroy 让客户端只见 RST
		socket.end("HTTP/1.1 413 Payload Too Large\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const upstream = await deps.resolveUpstream();
	if (deps.peerCookieRequired === true && upstream.sessionCookie === undefined) {
		socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	proxyUpgrade(req, socket as never, head, upstream, {
		wsPingIntervalMs: wsPingIntervalMs(deps.config),
	});
}
