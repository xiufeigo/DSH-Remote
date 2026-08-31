/**
 * WebSocket 升级入口：认证门与 HTTP 路径同一判定（edge 一律设备 Cookie，
 * desktop 保留访客密钥直通），随后交 proxyUpgrade 按原始字节管道直通上游
 * （只改写寻址头 + 注入 0.1.2+ 会话 cookie，帧层不动）。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { INTERNAL_PREFIX, checkRequest, visitorKeyAdmits } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { proxyUpgrade, type Upstream } from "./proxy.ts";
import type { Store } from "./store.ts";

export interface UpgradeDeps {
	config: GatewayConfig;
	store: Store;
	/** 生效上游地址（含 0.1.2+ 浏览器会话 cookie 接线）。 */
	resolveUpstream: () => Upstream;
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
	// edge 一律要求设备 Cookie；desktop 保留访客密钥直通（与 HTTP 路径同一判定）
	const tunnelAdmits = deps.config.role !== "edge" && visitorKeyAdmits(deps.config);
	const verdict = tunnelAdmits
		? { ok: true as const, deviceId: "visitor-key" }
		: await checkRequest(req, { store: deps.store, config: deps.config });
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
	proxyUpgrade(req, socket as never, head, deps.resolveUpstream());
}
