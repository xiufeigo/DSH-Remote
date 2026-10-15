/**
 * PROXY protocol v2（frpc `transport.proxyProtocolVersion = "v2"` 写给本地入口）。
 * 只解析地址块，取真实客户端 IP 作限流键；签名不对或超长直接拒绝。
 */

import type { Duplex } from "node:stream";

const SIG = Buffer.from([
	0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

const PROXY_CLIENT_IP = Symbol.for("dsh-remote.proxyClientIp");

export interface ProxyV2Header {
	srcAddr: string;
	srcPort: number;
	rest: Buffer;
}

export function parseProxyV2(
	buf: Buffer,
): { ok: true; info: ProxyV2Header } | { ok: false; needMore?: boolean } {
	if (buf.length < 16) return { ok: false, needMore: true };
	if (!buf.subarray(0, 12).equals(SIG)) return { ok: false };
	const version = buf[12] >> 4;
	const command = buf[12] & 0x0f;
	if (version !== 2 || (command !== 0 && command !== 1)) return { ok: false };
	const family = buf[13] >> 4;
	const length = buf.readUInt16BE(14);
	if (buf.length < 16 + length) return { ok: false, needMore: true };
	const rest = buf.subarray(16 + length);
	if (command === 0) return { ok: true, info: { srcAddr: "", srcPort: 0, rest } };
	if (family === 0x1) {
		if (length < 12) return { ok: false };
		const srcAddr = `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;
		const srcPort = buf.readUInt16BE(24);
		return { ok: true, info: { srcAddr, srcPort, rest } };
	}
	if (family === 0x2) {
		if (length < 36) return { ok: false };
		const parts: string[] = [];
		for (let i = 0; i < 8; i += 1) parts.push(buf.readUInt16BE(16 + i * 2).toString(16));
		return { ok: true, info: { srcAddr: parts.join(":"), srcPort: buf.readUInt16BE(48), rest } };
	}
	return { ok: false };
}

export function setProxyClientIp(socket: Duplex, ip: string): void {
	(socket as Duplex & { [PROXY_CLIENT_IP]?: string })[PROXY_CLIENT_IP] = ip;
}

export function proxyClientIpOf(socket: object | undefined): string | undefined {
	if (socket === undefined || socket === null) return undefined;
	const direct = (socket as { [PROXY_CLIENT_IP]?: unknown })[PROXY_CLIENT_IP];
	if (typeof direct === "string" && direct.length > 0) return direct;
	const parent = (socket as { _parent?: object })._parent;
	if (parent === undefined) return undefined;
	const viaParent = (parent as { [PROXY_CLIENT_IP]?: unknown })[PROXY_CLIENT_IP];
	return typeof viaParent === "string" && viaParent.length > 0 ? viaParent : undefined;
}
