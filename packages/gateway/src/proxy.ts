/**
 * 反向代理：
 * - HTTP：用 node:http 客户端转发（解析/编码交给 Node），改写 Host/Origin/Referer
 *   为上游回环形态以通过 DSH 的浏览器信任栅栏；剥离本网关设备 Cookie 不外泄上游；
 *   对小型 text/html 响应注入 PWA 标记；
 * - WebSocket 升级：认证通过后按原始字节管道直通（不改写帧），双向透传。
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Upstream {
	host: string;
	port: number;
	/** 上游是 HTTPS（如隧道对端的 PC 网关自签服务）时按 TLS 连接，证书不校验（指纹可后续加）。 */
	tls?: boolean;
}

/** 上游 HTTPS 自签证书专用 agent（进程级单例，keep-alive 复用）。 */
const insecureUpstreamAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

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

/** GW-04：上游空闲超时（毫秒）。只约束"请求阶段/未响应"的空闲，详见 proxyHttp 内注释。 */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;
/** 上游超时专用错误码：在 'error' 分支区分 504（超时）与一般 502（不可达）。 */
const UPSTREAM_TIMEOUT_CODE = "ERR_DSHR_UPSTREAM_TIMEOUT";

function authorityOf(upstream: Upstream): string {
	return `${upstream.host}:${String(upstream.port)}`;
}

/**
 * GW-05：上游重定向 Location 若为携带本网关上游 authority（host:port）的绝对地址，
 * 剥离为相对路径（保留 path+query），避免客户端浏览器直跳不可达的回环/内网地址而白屏。
 * 只匹配上游自身 authority，其余 Location（如外部绝对地址）原样放行。
 */
function rewriteUpstreamLocation(location: string, upstream: Upstream): string {
	const prefix = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(location);
	if (prefix === null) return location;
	const rest = location.slice(prefix[0].length);
	const restLower = rest.toLowerCase();
	// IPv6 主机在 URL 里带方括号，裸地址一并尝试。
	const candidates = upstream.host.includes(":")
		? [`[${upstream.host}]:${String(upstream.port)}`, authorityOf(upstream)]
		: [authorityOf(upstream)];
	for (const authority of candidates) {
		const authorityLower = authority.toLowerCase();
		if (restLower === authorityLower) return "/";
		if (restLower.startsWith(authorityLower) && rest[authority.length] === "/") {
			return rest.slice(authority.length);
		}
	}
	return location;
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
	// GW-10：仅当原请求携带 origin 时才改写。旧实现是死三元（两分支相同），
	// 会把 Origin 强注给本来无 origin 的请求。
	if (headers["origin"] !== undefined) headers["origin"] = `http://${authority}`;
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
	// GW-06：一律声明 accept-encoding: identity，根治"压缩响应注入损坏"。
	// 是否注入由响应决定（200 + text/html），构造请求时无法预知，凡经 proxyHttp
	// 的请求都可能被注入 HTML；若上游（或未来前置代理）返回压缩体，整包
	// toString("utf8") 注入会得到乱码、浏览器解码失败白屏。
	// 取舍：静态资源因此也失去传输压缩（当前 DSH 上游不压缩，暂无实际损失）；
	// 注入正确性优先。将来若需压缩，应升级为"zlib 解压 → 注入 → 透传/重压"，
	// 而非移除此行。
	headers["accept-encoding"] = "identity";
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
	const transport = upstream.tls === true ? https : http;
	/** 上游响应头是否已到达；GW-04 的空闲超时只在此之前生效。 */
	let upstreamResponded = false;
	const upstreamReq = transport.request(
		{
			host: upstream.host,
			port: upstream.port,
			method: req.method,
			path: req.url,
			headers,
			...(upstream.tls === true ? { agent: insecureUpstreamAgent, servername: upstream.host } : {}),
		},
		(upstreamRes) => {
			upstreamResponded = true;
			// GW-04：响应已到达，解除空闲超时——DSH 的 SSE/长流式响应允许长时间
			// 静默，这里不清掉会误杀活跃流（与下方 'timeout' 守卫互为双保险）。
			upstreamReq.setTimeout(0);
			if (upstreamRes.statusCode === undefined) {
				res.writeHead(502).end("dsh-remote: 上游无响应状态");
				return;
			}
			const status = upstreamRes.statusCode;
			const outHeaders: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(upstreamRes.headers)) {
				if (value === undefined) continue;
				// GW-05：剥离 Location 里的上游 authority 为相对路径。注入与非注入
				// 两条转发路径共用 outHeaders，在此统一改写。
				if (key === "location" && typeof value === "string") {
					outHeaders[key] = rewriteUpstreamLocation(value, upstream);
					continue;
				}
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

			// GW-16：content-length 已声明且超过注入上限时直接流式直通，
			// 不再像旧路径那样先累积全部分块、超限才发现（白白占用内存、GC 抖动）。
			// 注意：此分支不注入，故上游 CSP 原样保留（由下方真正注入的分支剥离）。
			const declaredLengthRaw = outHeaders["content-length"];
			const declaredLength = typeof declaredLengthRaw === "string" ? Number(declaredLengthRaw) : Number.NaN;
			if (Number.isFinite(declaredLength) && declaredLength > INJECT_MAX_BYTES) {
				res.writeHead(status, outHeaders);
				upstreamRes.pipe(res);
				return;
			}

			// GW-12：注入场景剥离上游 Content-Security-Policy。
			// 我们注入的内联脚本（移动断点变量 window.__DSHR_MOBILE__ 等）在上游
			// 启用严格 CSP 的版本上会被 script-src 拦截，导致注入能力静默失效；
			// 代理无法可靠改写 CSP 指令（nonce/哈希不可预知），注入场景直接移除。
			// 不注入的直通路径保留原 CSP，上游内容仍受其自身策略保护。
			// （极端边角：缓冲途中超限回退为直通时 CSP 已被剥离——彼时上游声明的
			// content-length 已失真，两害相权取其轻。）
			delete outHeaders["content-security-policy"];
			delete outHeaders["content-security-policy-report-only"];

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

	// GW-04：上游请求空闲超时。Node 的 request.setTimeout 是 socket-idle 语义：
	// 套接字上任何读写活动（包括缓慢上传的请求体）都会重置计时，只有上游真正
	// 挂死（60s 内连响应头都没有）才触发 'timeout'；响应头一旦到达立即解除
	// （见响应回调里的 setTimeout(0)），不误杀 SSE/大响应等活跃长流。
	upstreamReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS);
	upstreamReq.on("timeout", () => {
		if (upstreamResponded) return; // 双保险：绝不误杀已响应的流
		const timeoutError = new Error(`dsh-remote: 上游 ${String(UPSTREAM_IDLE_TIMEOUT_MS / 1000)}s 无响应`);
		(timeoutError as NodeJS.ErrnoException).code = UPSTREAM_TIMEOUT_CODE;
		upstreamReq.destroy(timeoutError);
	});

	upstreamReq.on("error", (error) => {
		if (res.destroyed) return; // 客户端已断开：无需再写响应
		if (!res.headersSent) {
			const timedOut = (error as NodeJS.ErrnoException).code === UPSTREAM_TIMEOUT_CODE;
			res.writeHead(timedOut ? 504 : 502, { "content-type": "text/plain; charset=utf-8" });
			res.end(
				timedOut
					? `dsh-remote: 上游响应超时（${String(UPSTREAM_IDLE_TIMEOUT_MS / 1000)}s 无响应）`
					: `dsh-remote: 上游不可达（${error.message}）`,
			);
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

	const connectOptions = { host: upstream.host, port: upstream.port };
	const upstreamSocket = upstream.tls === true
		? tls.connect({ ...connectOptions, rejectUnauthorized: false, servername: upstream.host }, () => {
			upstreamSocket.write(lines.join("\r\n"));
			if (head.length > 0) upstreamSocket.write(head);
			socket.pipe(upstreamSocket);
			upstreamSocket.pipe(socket);
		})
		: net.connect(connectOptions, () => {
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
