/**
 * 反向代理：
 * - HTTP：用 node:http 客户端转发（解析/编码交给 Node），改写 Host/Origin/Referer
 *   为上游回环形态以通过 DSH 的浏览器信任栅栏；剥离本网关设备 Cookie 不外泄上游；
 *   DSH 0.1.2+ 下注入插件下发的上游浏览器会话 Cookie（session.ts）并通过
 *   onUnauthorized 在上游 401 时触发重铸；对小型 text/html 响应注入主屏标记；
 * - WebSocket 升级：认证通过后按原始字节管道直通（不改写帧），双向透传。
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Upstream {
	host: string;
	port: number;
	/** 上游是 HTTPS（如隧道对端的 PC 网关自签服务）时按 TLS 连接，证书不校验（指纹可后续加）。 */
	tls?: boolean;
	/**
	 * DSH 0.1.2+ 浏览器会话 cookie（"name=value"，session.ts 铸造缓存）。
	 * 缺省（旧版宿主 / TLS 上游 / 令牌未就绪）不注入 —— 行为与旧版一致。
	 */
	sessionCookie?: string;
	/** 注入了会话 cookie 的请求被上游 401 拒绝时回调（触发 session.ts 重铸）。 */
	onUnauthorized?: () => void;
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

/**
 * PERF-01：只有"可能返回待注入 HTML"的请求才强制 identity。
 * 判定：GET/HEAD + （根路径 / 目录 / .html 结尾 / Accept 含 text/html）。
 * 其余（JS/CSS/图片字体、/api JSON、WS 之前的普通 GET）透传客户端的
 * accept-encoding；客户端未声明时给上游 identity（REVIEW-01：不得把压缩
 * 字节透传给不支持解压的客户端），静态大包才能走压缩，隧道传输量按 DSH
 * 这类 Vite 包通常省 2/3 以上。
 * 注入正确性由响应侧兜底：见 proxyHttp 内压缩 HTML 的解压后再注入。
 */
export function wantsHtmlIdentity(req: IncomingMessage): boolean {
	const method = String(req.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") return false;
	const pathname = pathnameOf(req.url);
	// /api 只回 JSON/SSE，永不进 HTML 注入——即使形如目录也不强制 identity。
	if (isApiPath(pathname)) return false;
	if (pathname === "/" || pathname.endsWith("/") || pathname.toLowerCase().endsWith(".html")) return true;
	const accept = req.headers["accept"];
	const acceptText = Array.isArray(accept) ? accept.join(",") : String(accept ?? "");
	return acceptText.toLowerCase().includes("text/html");
}

/** 取请求路径（去 query；异常回退 "/"）。 */
export function pathnameOf(url: string | undefined): string {
	const raw = String(url ?? "/");
	return raw.split("?", 1)[0] ?? "/";
}

/** 上游 DSH 的 API 面（JSON/SSE）：永不 HTML 注入、永不网关侧压缩。 */
export function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/** 可被网关侧即时压缩的内容类型（文本系；字体/图片二进制已压缩的不碰）。 */
const COMPRESSIBLE_CONTENT = /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml|x-www-form-urlencoded)|image\/svg\+xml)/i;

/**
 * 解析 accept-encoding 为"被接受（q>0）的编码集合"（REVIEW-01：`br;q=0` 不得选中 br）。
 * 无效 q 值按接受处理（与浏览器缺省一致）。
 */
export function acceptedEncodings(acceptEncoding: unknown): Set<string> {
	const text = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : String(acceptEncoding ?? "");
	const out = new Set<string>();
	for (const part of text.split(",")) {
		const [name, ...params] = part.split(";");
		const token = name.trim().toLowerCase();
		if (token === "") continue;
		let q = 1;
		for (const param of params) {
			const [key, value] = param.split("=");
			if (key.trim().toLowerCase() === "q" && value !== undefined) {
				const parsed = Number.parseFloat(value.trim());
				if (Number.isFinite(parsed)) q = parsed;
			}
		}
		if (q > 0) out.add(token);
		else out.delete(token);
	}
	return out;
}

/** 从客户端 accept-encoding 选网关压缩编码：br > gzip > deflate；不支持返回 undefined。 */
export function selectGatewayEncoding(acceptEncoding: unknown): "br" | "gzip" | "deflate" | undefined {
	const accepted = acceptedEncodings(acceptEncoding);
	if (accepted.has("br")) return "br";
	// REVIEW-02：x-gzip 是 gzip 别名；裸 "*"（q>0）按最保守的 gzip 处理，
	// 只会少压不会错发（* 语义即"任意编码可接受"，gzip 最通用）。
	if (accepted.has("gzip") || accepted.has("x-gzip")) return "gzip";
	if (accepted.has("deflate")) return "deflate";
	if (accepted.has("*")) return "gzip";
	return undefined;
}

/**
 * 网关侧即时压缩判定（PERF-01）：只压"静态文本类 + 200 + 上游未压 + 非流式"。
 * 明确排除：/api/*（含 SSE text/event-stream/长流 JSON，压了反而加缓冲抖动）、
 * 非 GET、206/304/204、无内容类型或已带 content-encoding 的响应。
 */
export function shouldGatewayCompress(
	req: IncomingMessage,
	status: number,
	outHeaders: Record<string, string | string[]>,
): boolean {
	if (String(req.method ?? "GET").toUpperCase() !== "GET") return false;
	if (status !== 200) return false;
	// REVIEW-02：与 wantsHtmlIdentity 共用 pathname 判定（剥 query、精确 /api 覆盖）。
	if (isApiPath(pathnameOf(req.url))) return false;
	const contentEncoding = String(outHeaders["content-encoding"] ?? "").toLowerCase();
	if (contentEncoding !== "" && contentEncoding !== "identity") return false;
	const contentType = String(outHeaders["content-type"] ?? "");
	if (!COMPRESSIBLE_CONTENT.test(contentType)) return false;
	if (String(outHeaders["content-type"] ?? "").includes("text/event-stream")) return false;
	if (selectGatewayEncoding(req.headers["accept-encoding"]) === undefined) return false;
	return true;
}

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

/** 生成发往上游的请求头：寻址头改写、逐跳头剥离、设备 Cookie 剥离、会话 Cookie 注入。 */
export function buildUpstreamHeaders(req: IncomingMessage, upstream: Upstream): http.OutgoingHttpHeaders {
	const authority = authorityOf(upstream);
	const headers: http.OutgoingHttpHeaders = {};
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "cookie") continue;
		// DSH 0.1.2+ 的 /api Host fence 拒绝 sec-fetch-site: cross-site（api-request-trust.ts）。
		// 手机浏览器发往本网关的请求可能是跨站导航/快捷方式启动，剥离后按
		// "无标记"处理（fence 注释明确无标记可接受，Host fence 仍然生效）。
		if (lower === "sec-fetch-site") continue;
		// PERF-01：accept-encoding 不盲拷，见下方按 wantsHtmlIdentity 决策。
		if (lower === "accept-encoding") continue;
		headers[key] = value as string | string[];
	}
	headers["host"] = authority;
	// DSH 0.1.2+：上游会话 cookie（为该 authority 铸造）。设备 Cookie 已在上方剥离，
	// 这里注入的是网关持有的上游浏览器会话，绝不透传手机端的任何 Cookie。
	if (upstream.sessionCookie !== undefined) headers["cookie"] = upstream.sessionCookie;
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
	// PERF-01（替代旧 GW-06 一刀切 identity）：只有可能回 HTML 注入的导航
	// 才强制 identity（注入前无需解压）；静态/接口透传客户端编码。
	// REVIEW-01：客户端未声明 accept-encoding（curl/脚本类）时给上游 identity，
	// 否则上游的压缩字节会被原样透传给不支持解压的客户端。
	if (wantsHtmlIdentity(req)) {
		headers["accept-encoding"] = "identity";
	} else {
		const clientEncoding = req.headers["accept-encoding"];
		const forwarded = Array.isArray(clientEncoding)
			? clientEncoding.join(", ")
			: typeof clientEncoding === "string" && clientEncoding.trim() !== ""
				? clientEncoding
				: "identity";
		headers["accept-encoding"] = forwarded;
	}
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
			// DSH 0.1.2+：会话 cookie 失效（DSH 重启换令牌/authority 漂移）时触发
			// 重铸；本请求按 401 透传，客户端重试一次即可恢复。
			if (status === 401 && upstream.sessionCookie !== undefined) {
				try {
					upstream.onUnauthorized?.();
				} catch { /* 回调异常不影响代理主流程 */ }
			}
			const outHeaders: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(upstreamRes.headers)) {
				if (value === undefined) continue;
				// GW-17：逐跳响应头不得转发（RFC 7230 §6.1）。Node 的 http 客户端
				// 已把 transfer-encoding 解码为流、由本端 http 服务器按需重新分帧，
				// 故这些头只描述「客户端↔上游」那一跳。原样转发上游的
				// `connection: keep-alive` 会让客户端的 `connection: close` 语义
				// 失效——表现为响应读完后连接空挂到 keepAliveTimeout 才断开。
				if (HOP_BY_HOP.has(key)) continue;
				// 会话隔离：上游（0.1.2+ 可能下发/刷新它自己的浏览器会话 cookie）
				// 的 Set-Cookie 绝不下发给手机端；网关持有的会话只存在于本进程。
				if (key === "set-cookie") continue;
				// GW-05：剥离 Location 里的上游 authority 为相对路径。注入与非注入
				// 两条转发路径共用 outHeaders，在此统一改写。
				if (key === "location" && typeof value === "string") {
					outHeaders[key] = rewriteUpstreamLocation(value, upstream);
					continue;
				}
				outHeaders[key] = value;
			}

			const contentType = String(outHeaders["content-type"] ?? "");
			// REVIEW-02：未知编码（zstd 等）不进注入缓冲——删头不解码会乱码白屏，
			// 直接原样直通；HEAD 无 body，直接直通（旧实现会为空 body 算出注入长度）；
			// /api 与 wantsHtmlIdentity 保持一致：接口面永不注入（注释与行为统一）。
			const upstreamEncodingEarly = String(outHeaders["content-encoding"] ?? "").toLowerCase();
			const decodable = upstreamEncodingEarly === "" || upstreamEncodingEarly === "identity"
				|| upstreamEncodingEarly === "gzip" || upstreamEncodingEarly === "deflate"
				|| upstreamEncodingEarly === "br";
			const canInject =
				transformHtml !== undefined
				&& status === 200
				&& String(req.method ?? "GET").toUpperCase() !== "HEAD"
				&& contentType.includes("text/html")
				&& decodable
				&& !isApiPath(pathnameOf(req.url));

			if (!canInject) {
				// PERF-01：上游（回环 DSH）多半不压缩，手机隧道却很吃带宽。
				// 可压缩静态由网关即时压一次再下发；已压/SSE/接口原样直通。
				// REVIEW-01：变换字节必须剥 etag（上游 304/条件请求不得复用旧实体）。
				if (shouldGatewayCompress(req, status, outHeaders)) {
					const encoding = selectGatewayEncoding(req.headers["accept-encoding"]);
					if (encoding !== undefined) {
						delete outHeaders["content-length"];
						delete outHeaders["etag"];
						outHeaders["content-encoding"] = encoding;
						const vary = String(outHeaders["vary"] ?? "");
						outHeaders["vary"] = vary === ""
							? "Accept-Encoding"
							: (/accept-encoding/i.test(vary) ? vary : `${vary}, Accept-Encoding`);
						res.writeHead(status, outHeaders);
						// REVIEW-01：Brotli 质量 4（默认 11 首字节慢、手机隧道下不划算）；
						// 用 pipeline：任一段失败即销毁整链，绝不 end() 出截断包。
						const compressor = encoding === "br"
							? zlib.createBrotliCompress({
								params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
							})
							: encoding === "gzip"
								? zlib.createGzip()
								: zlib.createDeflate();
						pipeline(upstreamRes, compressor, res, () => {});
						return;
					}
				}
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
			// REVIEW-01：改字节同样剥 etag；未知编码到不了这里（见 canInject decodable）。
			// PERF-01 兜底：若上游仍回了压缩 HTML（分类误判/未来代理），先解压再注入，
			// 下发给手机时按 identity（HTML 本体小，不值得为它再压一次）。
			const upstreamEncoding = String(outHeaders["content-encoding"] ?? "").toLowerCase();
			delete outHeaders["content-encoding"];
			delete outHeaders["etag"];
			delete outHeaders["transfer-encoding"];
			const chunks: Buffer[] = [];
			let total = 0;
			let overflow = false;
			upstreamRes.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > INJECT_MAX_BYTES && !overflow) {
					overflow = true;
					// P1-3（GW-16 补全）：未声明长度（chunked）路径超限时，必须先把
					// 「已缓冲前缀 + 触发超限的当前块」写出再切直通 —— 旧实现清空
					// chunks 直接 pipe，上游 3MB 手机端只收到 1MB（静默截断无标记）。
					// PERF-01：若上游是压缩 HTML，直通必须恢复 content-encoding，
					// 否则手机会把压缩字节当 identity 解码白屏。
					delete outHeaders["content-length"];
					if (upstreamEncoding === "gzip" || upstreamEncoding === "deflate" || upstreamEncoding === "br") {
						outHeaders["content-encoding"] = upstreamEncoding;
					}
					outHeaders["transfer-encoding"] = "chunked";
					res.writeHead(status, outHeaders);
					for (const buffered of chunks) res.write(buffered);
					chunks.length = 0;
					res.write(chunk);
					upstreamRes.pipe(res);
					return;
				}
				if (!overflow) chunks.push(chunk);
			});
			upstreamRes.on("end", () => {
				if (overflow) return;
				try {
					let html = Buffer.concat(chunks);
					if (upstreamEncoding === "gzip" || upstreamEncoding === "deflate" || upstreamEncoding === "br") {
						try {
							// REVIEW-01：maxOutputLength 防压缩炸弹；deflate 失败回退 raw。
							const cap = { maxOutputLength: INJECT_MAX_BYTES } as const;
							html = upstreamEncoding === "gzip"
								? zlib.gunzipSync(html, cap)
								: upstreamEncoding === "deflate"
									? (() => {
										try {
											return zlib.inflateSync(html, cap);
										} catch {
											return zlib.inflateRawSync(html, cap);
										}
									})()
									: zlib.brotliDecompressSync(html, cap);
						} catch {
							// 解压失败：按原压缩字节直通（恢复编码头，不注入）。
							outHeaders["content-encoding"] = upstreamEncoding;
							outHeaders["content-length"] = String(html.length);
							res.writeHead(status, outHeaders);
							res.end(html);
							return;
						}
						if (html.length > INJECT_MAX_BYTES) {
							// 解后超限：同样回退直通，避免网关内存爆炸。
							const raw = Buffer.concat(chunks);
							outHeaders["content-encoding"] = upstreamEncoding;
							outHeaders["content-length"] = String(raw.length);
							res.writeHead(status, outHeaders);
							res.end(raw);
							return;
						}
					}
					const injected = transformHtml(html);
					outHeaders["content-length"] = String(injected.length);
					res.writeHead(status, outHeaders);
					res.end(injected);
				} catch {
					res.end();
				}
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
		// 与 HTTP 路径同理：剥离 sec-fetch-site，避免上游 /api 升级路径的 fence 误拒
		if (lower === "sec-fetch-site") continue;
		if (lower === "origin" && typeof value === "string") {
			lines.push(`origin: http://${authorityOf(upstream)}`);
			continue;
		}
		lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
	}
	lines.push(`host: ${authorityOf(upstream)}`);
	// DSH 0.1.2+：WS 升级路径同样要求浏览器会话（401/403 与 HTTP 一致）
	if (upstream.sessionCookie !== undefined) lines.push(`cookie: ${upstream.sessionCookie}`);
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
