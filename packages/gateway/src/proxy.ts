/**
 * 反向代理：
 * - HTTP：用 node:http 客户端转发（解析/编码交给 Node），改写 Host/Origin/Referer
 *   为上游回环形态以通过 DSH 的浏览器信任栅栏；剥离本网关设备 Cookie 不外泄上游；
 *   对小型 text/html 响应注入 PWA 标记；
 * - WebSocket 升级：认证通过后按原始字节管道直通（不改写帧），双向透传。
 */

import http from "node:http";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Upstream {
	host: string;
	port: number;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"proxy-connection",
]);

/** 允许整包缓冲后注入的 HTML 上限（超过则原样流式转发） */
const INJECT_MAX_BYTES = 2 * 1024 * 1024;

function authorityOf(upstream: Upstream): string {
	return `${upstream.host}:${String(upstream.port)}`;
}

/** 生成发往上游的请求头：寻址头改写、逐跳头剥离、设备 Cookie 剥离。 */
export function buildUpstreamHeaders(req: IncomingMessage, upstream: Upstream): http.OutgoingHttpHeaders {
	const authority = authorityOf(upstream);
	const headers: http.OutgoingHttpHeaders = {};
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "cookie") continue;
		headers[key] = value as string | string[];
	}
	headers["host"] = authority;
	headers["origin"] = typeof headers["origin"] === "string" ? `http://${authority}` : `http://${authority}`;
	if (typeof headers["referer"] === "string" && headers["referer"].length > 0) {
		try {
			const refererUrl = new URL(headers["referer"]);
			headers["referer"] = `http://${authority}${refererUrl.pathname}${refererUrl.search}`;
		} catch {
			delete headers["referer"];
		}
	}
	headers["x-forwarded-host"] = req.headers.host ?? "";
	headers["x-forwarded-proto"] = "https";
	return headers;
}

// ---------- HTTP ----------

export function proxyHttp(
	req: IncomingMessage,
	res: ServerResponse,
	upstream: Upstream,
	transformHtml?: (body: Buffer) => Buffer,
): void {
	const headers = buildUpstreamHeaders(req, upstream);
	const upstreamReq = http.request(
		{
			host: upstream.host,
			port: upstream.port,
			method: req.method,
			path: req.url,
			headers,
		},
		(upstreamRes) => {
			if (upstreamRes.statusCode === undefined) {
				res.writeHead(502).end("dsh-remote: 上游无响应状态");
				return;
			}
			const status = upstreamRes.statusCode;
			const outHeaders: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(upstreamRes.headers)) {
				if (value === undefined) continue;
				outHeaders[key] = value;
			}

			const contentType = String(outHeaders["content-type"] ?? "");
			const canInject =
				transformHtml !== undefined
				&& status === 200
				&& contentType.includes("text/html");

			if (!canInject) {
				res.writeHead(status, outHeaders);
				upstreamRes.pipe(res);
				return;
			}

			// 小型 HTML 整包缓冲注入；超限退化为原样转发。
			// 缓冲路径必须去掉分帧头：content-length 由我们按注入后的实际长度重算。
			delete outHeaders["transfer-encoding"];
			const chunks: Buffer[] = [];
			let total = 0;
			let overflow = false;
			upstreamRes.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > INJECT_MAX_BYTES && !overflow) {
					overflow = true;
					chunks.length = 0;
					delete outHeaders["content-length"];
					outHeaders["transfer-encoding"] = "chunked";
					res.writeHead(status, outHeaders);
					upstreamRes.pipe(res);
					return;
				}
				if (!overflow) chunks.push(chunk);
			});
			upstreamRes.on("end", () => {
				if (overflow) return;
				const injected = transformHtml(Buffer.concat(chunks));
				outHeaders["content-length"] = String(injected.length);
				res.writeHead(status, outHeaders);
				res.end(injected);
			});
			upstreamRes.on("error", () => res.end());
		},
	);

	upstreamReq.on("error", (error) => {
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-remote: 上游不可达（${error.message}）`);
		} else {
			res.end();
		}
	});
	req.on("error", () => upstreamReq.destroy());
	res.on("close", () => upstreamReq.destroy());
	req.pipe(upstreamReq);
}

// ---------- WebSocket / Upgrade 直通 ----------

/**
 * 把升级请求按原始字节转发到上游：重写 host/origin 后写回请求行+头部，
 * 之后双向管道透传（不解析、不改写 WebSocket 帧）。
 */
export function proxyUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer, upstream: Upstream): void {
	const lines = [`${req.method} ${req.url} HTTP/1.1`];
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		// 注意：connection/upgrade 是升级跳的必需头，不能剥；只改写寻址头并剥离 Cookie
		if (lower === "host" || lower === "cookie") continue;
		if (lower === "origin" && typeof value === "string") {
			lines.push(`origin: http://${authorityOf(upstream)}`);
			continue;
		}
		lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
	}
	lines.push(`host: ${authorityOf(upstream)}`);
	lines.push("\r\n");

	const upstreamSocket = net.connect({ host: upstream.host, port: upstream.port }, () => {
		upstreamSocket.write(lines.join("\r\n"));
		if (head.length > 0) upstreamSocket.write(head);
		socket.pipe(upstreamSocket);
		upstreamSocket.pipe(socket);
	});

	const teardown = () => {
		socket.destroy();
		upstreamSocket.destroy();
	};
	upstreamSocket.on("error", teardown);
	socket.on("error", teardown);
	upstreamSocket.on("close", () => socket.destroy());
	socket.on("close", () => upstreamSocket.destroy());
}
