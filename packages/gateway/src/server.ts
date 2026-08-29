/**
 * 网关主服务：HTTPS 监听（自签证书），内部路由 + 认证门 + 反向代理。
 *
 * 路由约定：
 *   /__dsh_remote__/pair                配对页（未认证可访问，POST 消费一次性码）
 *   /__dsh_remote__/manifest.webmanifest / icon.svg   PWA 静态资源
 *   /__dsh_remote__/health              存活探针（无信息泄露）
 *   /__dsh_remote__/admin/*             本机管理端点（仅接受回环来源）
 *   其余                                设备认证后原样代理到上游 DSH Web GUI
 */

import https from "node:https";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	COOKIE_NAME,
	INTERNAL_PREFIX,
	LOGIN_PAGE,
	PAIR_PAGE,
	RateLimiter,
	checkRequest,
	clientIp,
	clearDeviceCookie,
	ensureAccessTokenHash,
	generatePairingCode,
	isLoopback,
	issueDeviceCookie,
	parseCookies,
	verifyAccessToken,
	visitorKeyAdmits,
} from "./auth.ts";
import { ensureCert, loadManualCert, type GatewayCert } from "./cert.ts";
import {
	effectiveEdgeFrpRole,
	effectiveUpstreamTls,
	mobileBreakpointPx,
	mobileInjectionEnabled,
	normalizeEdgeConsume,
	normalizeEdgeFrpRole,
	type GatewayConfig,
} from "./config.ts";
import {
	FrpSupervisor,
	locateFrBinary,
	locateFrpcBinary,
	normalizeFrpMode,
	normalizeTunnelName,
	renderFrpcToml,
	renderFrpsToml,
	renderVisitorToml,
	visitorBindPortOf,
} from "./frp.ts";
import { loadMobileScript } from "./mobile.ts";
import { BRAND_SVG, ICON_SVG, iconPng, injectIntoHtml, makeHtmlInjector, renderManifest, renderServiceWorker } from "./pwa.ts";
import { proxyHttp, proxyUpgrade, type Upstream } from "./proxy.ts";
import type { Store } from "./store.ts";
import { resolveUpstreamPort } from "./upstream.ts";

export interface GatewayServerOptions {
	store: Store;
	config: GatewayConfig;
	log?: (line: string) => void;
	/** 环境变量源（测试注入用）；缺省 process.env */
	env?: NodeJS.ProcessEnv;
}

export class GatewayServer {
	readonly store: Store;
	readonly config: GatewayConfig;
	private readonly limiter: RateLimiter;
	private readonly log: (line: string) => void;
	private readonly env: NodeJS.ProcessEnv;
	private server?: https.Server;
	private frp?: FrpSupervisor;
	private frps?: FrpSupervisor;
	private visitor?: FrpSupervisor;
	private cert?: GatewayCert;
	private accessTokenHash?: string;
	private htmlInjector: (body: Buffer) => Buffer = injectIntoHtml;

	constructor(options: GatewayServerOptions) {
		this.store = options.store;
		this.config = options.config;
		this.log = options.log ?? (() => {});
		this.env = options.env ?? process.env;
		this.limiter = new RateLimiter(
			options.config.rateLimitPerMinute,
			options.config.pairingFailLockThreshold,
			options.config.pairingFailLockMinutes,
		);
	}

	get actualPort(): number | undefined {
		const address = this.server?.address();
		return typeof address === "object" && address !== null ? address.port : undefined;
	}

	get certificate(): GatewayCert | undefined {
		return this.cert;
	}

	/**
	 * 启动前解析上游端口：失配时自动探测 dsh-gui 监听端口，
	 * 命中后按 autoFixUpstreamPort 决定是否回写配置。
	 */
	private async resolveUpstream(): Promise<void> {
		const configured = this.config.upstreamPort;
		const resolution = await resolveUpstreamPort(configured);
		if (resolution === null) {
			this.log(`警告：127.0.0.1:${String(configured)} 未探测到 DSH 指纹，仍按配置继续（可运行 doctor 体检）`);
			return;
		}
		if (resolution.how !== "auto-detected") return;
		this.config.upstreamPort = resolution.port;
		this.log(
			`上游端口漂移：${String(configured)} → ${String(resolution.port)}` +
			(resolution.candidates && resolution.candidates.length > 0 ? `（候选：${resolution.candidates.map(String).join(", ")}）` : ""),
		);
		if (this.config.autoFixUpstreamPort !== false) {
			// GW-09：只回写增量（磁盘原始补丁 + upstreamPort），
			// 不把 applyEnvOverrides 的运行时覆盖（角色/监听面等）烙进 config.json
			await this.store.patchDiskConfig({ upstreamPort: resolution.port });
			this.log("已回写 config.json 的 upstreamPort");
		}
	}

	/** 生效的上游地址（含是否按 HTTPS 访问的推断）。 */
	private upstreamAddress(): Upstream {
		const tls = effectiveUpstreamTls(this.config);
		if (this.config.role === "edge") {
			const role = normalizeEdgeFrpRole(this.config.frp.edge);
			if (role === "visitor") return { host: "127.0.0.1", port: visitorBindPortOf(this.config.frp), tls };
			if (role === "frps" && normalizeEdgeConsume(this.config.frp.edgeConsume) === "entry-port") {
				return { host: "127.0.0.1", port: this.config.frp.remotePort ?? this.config.upstreamPort, tls };
			}
			if (role === "frps") return { host: "127.0.0.1", port: visitorBindPortOf(this.config.frp), tls };
		}
		return { host: this.config.upstreamHost ?? "127.0.0.1", port: this.config.upstreamPort, tls };
	}

	async start(): Promise<void> {
		this.accessTokenHash = await ensureAccessTokenHash(this.store, this.env);
		this.htmlInjector = makeHtmlInjector(
			mobileInjectionEnabled(this.config)
				? { mobile: { enabled: true, breakpointPx: mobileBreakpointPx(this.config) } }
				: undefined,
		);
		if (this.config.role !== "edge") {
			await this.resolveUpstream();
		} else {
			const upstream = this.upstreamAddress();
			this.log(
				`edge 角色：上游 http${upstream.tls ? "s" : ""}://${upstream.host}:${String(upstream.port)}` +
				`（frp 形态 ${effectiveEdgeFrpRole(this.config)}，跳过本机端口探测）`,
			);
			if (this.accessTokenHash === undefined) {
				this.log("警告：未配置访问 Token（DSHR_ACCESS_TOKEN）——公网入口将退化为配对码认证，强烈建议配置");
			}
		}
		this.cert = await this.resolveCert();
		this.server = https.createServer(
			{ key: this.cert.keyPem, cert: this.cert.certPem },
			(req, res) => {
				void this.handle(req, res);
			},
		);
		this.server.on("upgrade", (req, socket, head) => {
			void this.handleUpgrade(req, socket as Duplex, head);
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.config.listenPort, this.config.listenHost, () => resolve());
		});
		this.log(`网关监听 https://${this.config.listenHost}:${String(this.actualPort)}`);
		await this.startFrpIfNeeded();
	}

	/** TLS 证书来源：config.tls 提供则加载手工证书，失败回退自签并告警。 */
	private async resolveCert(): Promise<GatewayCert> {
		const tls = this.config.tls;
		if (typeof tls?.certPath === "string" && tls.certPath.length > 0 && typeof tls.keyPath === "string" && tls.keyPath.length > 0) {
			try {
				const manual = await loadManualCert(tls.certPath, tls.keyPath);
				this.log(`TLS：使用手工证书 ${tls.certPath}`);
				return manual;
			} catch (error) {
				this.log(`TLS：手工证书加载失败（${String(error)}），回退自签证书`);
			}
		}
		return ensureCert(this.store.path("certs"));
	}

	private async startFrpIfNeeded(): Promise<void> {
		if (this.config.role === "edge") return this.startEdgeFrp();
		const frp = this.config.frp;
		if (!frp.enabled) return;
		if (typeof frp.serverAddr !== "string" || frp.serverAddr.length === 0) {
			this.log("frp 已启用但缺少 frp.serverAddr，跳过传输适配器");
			return;
		}
		const binary = await locateFrpcBinary(frp, this.store);
		if (binary === undefined) {
			this.log(
				`找不到 frpc 可执行文件。请将官方 frpc 放到 ${this.store.path("vendor", "frp", process.platform === "win32" ? "frpc.exe" : "frpc")}（或在 config.json 的 frp.binaryPath 指定）。`,
			);
			return;
		}
		const secrets = await this.store.ensureSecrets();
		const mode = normalizeFrpMode(frp.mode);
		const toml = renderFrpcToml({
			serverAddr: frp.serverAddr,
			serverPort: frp.serverPort,
			authToken: secrets.frpAuthToken,
			localPort: this.actualPort ?? this.config.listenPort,
			remotePort: frp.remotePort,
			mode,
			secretKey: secrets.frpVisitorKey,
			name: frp.name,
		});
		const configPath = this.store.path("frp", "frpc.toml");
		await this.store.writeAtomic("frp/frpc.toml", toml);
		this.log(mode === "entry"
			? `frp 传输适配器启动（entry，入口端口 ${String(frp.remotePort)}，隧道名 ${normalizeTunnelName(frp.name)}）`
			: `frp 传输适配器启动（${mode}，隧道名 ${normalizeTunnelName(frp.name)}；VPS 不开入口端口；手机填写同一把访客密钥和同一隧道名即可连入）`);
		this.frp = new FrpSupervisor(binary, configPath, (line) => this.log(`[frpc] ${line}`));
		this.frp.start();
	}

	/**
	 * edge 角色的 frp 分派：
	 * - visitor：起 frpc visitor 连外部 frps（serverAddr 必填），上游=本地绑定口；
	 * - frps：先起 frps（控制口 serverPort），再按消费方式接上游——
	 *   stcp（缺省）回环起 visitor 连自身；entry-port 直连 PC 绑定的 remotePort。
	 */
	private async startEdgeFrp(): Promise<void> {
		const frp = this.config.frp;
		const role = normalizeEdgeFrpRole(frp.edge);
		if (role === "off") {
			this.log("edge：frp 未启用（frp.edge=off），上游直连");
			return;
		}
		const secrets = await this.store.ensureSecrets();
		const authToken = typeof frp.authToken === "string" && frp.authToken.length > 0
			? frp.authToken
			: secrets.frpAuthToken;
		const secretKey = secrets.frpVisitorKey;
		const tunnelName = normalizeTunnelName(frp.name);
		const controlPort = frp.serverPort;
		const consume = normalizeEdgeConsume(frp.edgeConsume);

		if (role === "frps") {
			const frpsBin = await locateFrBinary("frps", frp, this.store);
			if (frpsBin === undefined) {
				this.log(
					`找不到 frps 可执行文件。请将官方 frps 放到 ${this.store.path("vendor", "frp", process.platform === "win32" ? "frps.exe" : "frps")}。`,
				);
			} else {
				const frpsToml = renderFrpsToml({
					bindAddr: "0.0.0.0",
					bindPort: controlPort,
					authToken,
					allowPorts: frp.allowPorts,
				});
				const frpsConfigPath = this.store.path("frp", "frps.toml");
				await this.store.writeAtomic("frp/frps.toml", frpsToml);
				this.frps = new FrpSupervisor(frpsBin, frpsConfigPath, (line) => this.log(`[frps] ${line}`));
				this.frps.start();
				this.log(
					`frps 已启动：控制口 ${String(controlPort)}（PC 端 frpc 填 serverAddr=<本机公网 IP>、serverPort=${String(controlPort)}、同名隧道「${tunnelName}」）；dashboard 仅本机`,
				);
			}
			if (consume === "entry-port") {
				this.log(`edge：entry-port 消费 —— 上游 http://127.0.0.1:${String(frp.remotePort ?? this.config.upstreamPort)}（PC 端须用 entry 形态并配同值 remotePort）`);
				return;
			}
			this.log("edge：stcp 消费 —— 回环起内部 visitor 连自身 frps（PC 端请用 stcp 形态注册）");
		}

		// visitor：visitor 角色连外部 frps；frps 角色回环消费自身。
		const serverAddr = role === "frps" ? "127.0.0.1" : typeof frp.serverAddr === "string" ? frp.serverAddr : "";
		if (serverAddr.length === 0) {
			this.log("edge：visitor 缺少 frp.serverAddr（外部 frps 地址），无法建立消费隧道");
			return;
		}
		const frpcBin = await locateFrBinary("frpc", frp, this.store);
		if (frpcBin === undefined) {
			this.log(
				`找不到 frpc 可执行文件。请将官方 frpc 放到 ${this.store.path("vendor", "frp", process.platform === "win32" ? "frpc.exe" : "frpc")}。`,
			);
			return;
		}
		const bindPort = visitorBindPortOf(frp);
		const visitorToml = renderVisitorToml({
			serverAddr,
			serverPort: controlPort,
			authToken,
			serverName: tunnelName,
			secretKey,
			mode: "stcp",
			bindAddr: "127.0.0.1",
			bindPort,
		});
		const configPath = this.store.path("frp", role === "frps" ? "frpc-edge-visitor.toml" : "frpc-visitor.toml");
		await this.store.writeAtomic(role === "frps" ? "frp/frpc-edge-visitor.toml" : "frp/frpc-visitor.toml", visitorToml);
		this.visitor = new FrpSupervisor(frpcBin, configPath, (line) => this.log(`[frpc-visitor] ${line}`));
		this.visitor.start();
		this.log(`edge：visitor 启动 → ${serverAddr}:${String(controlPort)}（隧道 ${tunnelName}）；生效上游 http://127.0.0.1:${String(bindPort)}`);
	}

	async stop(): Promise<void> {
		if (this.frp !== undefined) await this.frp.stop();
		if (this.visitor !== undefined) await this.visitor.stop();
		if (this.frps !== undefined) await this.frps.stop();
		this.limiter.stop(); // GW-02：停止限流桶后台清理定时器
		// CLI-02 遗留：幂等关闭 —— 重复/并发调用（信号重入、doctor/清理路径、
		// 从未 start 的实例）都必须安全，绝不因 ERR_SERVER_NOT_RUNNING 拒绝或悬挂
		if (this.httpClosePromise === undefined) this.httpClosePromise = this.closeHttpServer();
		await this.httpClosePromise;
	}

	/** 关闭 Promise 记忆化：并发调用并入同一 Promise，二次调用直接复用已 settle 的结果。 */
	private httpClosePromise?: Promise<void>;

	private closeHttpServer(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		// 从未 start（或句柄已被接管）：原先 `this.server?.close(...)` 短路后
		// resolve 永不被调用 → stop() 悬挂；这里直接视为已关闭
		if (server === undefined) return Promise.resolve();
		return new Promise<void>((resolve) => {
			try {
				server.close((error) => {
					// 二次关闭/未运行时回调携带 ERR_SERVER_NOT_RUNNING；
					// close 语义为尽力而为，吞掉错误正常 resolve（幂等）
					void error;
					resolve();
				});
			} catch {
				// 部分 Node 版本对未运行的服务器同步抛 ERR_SERVER_NOT_RUNNING，同样视为已关闭
				resolve();
			}
		});
	}

	frpStatus() {
		return this.frp?.status();
	}

	// ---------- HTTP ----------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "https://gateway.invalid");
		const pathname = url.pathname;

		try {
			// 纵深防御：请求行含控制字符一律 400（防上游请求走私）
			if (/[\r\n\0]/.test(req.url ?? "")) {
				res.writeHead(400).end();
				return;
			}
			// —— 内部路由 ——
			if (pathname.startsWith(INTERNAL_PREFIX)) {
				if (!isLoopback(req) && pathname.startsWith(`${INTERNAL_PREFIX}admin`)) {
					res.writeHead(403).end();
					return;
				}
				// 管理端点防 CSRF：拒绝来自非本机页面的跨站请求
				// （自签证书下浏览器通常直接握手失败，这里再加一道来源闸门）
				if (pathname.startsWith(`${INTERNAL_PREFIX}admin`) && !isSameSiteLoopbackOrigin(req)) {
					res.writeHead(403).end();
					return;
				}
				switch (`${req.method} ${pathname}`) {
					case "GET /__dsh_remote__/health":
						res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
						return;
					case "GET /__dsh_remote__/manifest.webmanifest":
						res.writeHead(200, { "content-type": "application/manifest+json" }).end(renderManifest());
						return;
					case "GET /__dsh_remote__/sw.js":
						// WEB-01（web-pwa）：Service Worker 白名单缓存的 SW 源码。
						// service-worker-allowed: / 放行 scope:"/" 注册（SW 文件在 /__dsh_remote__/ 下）；
						// no-cache 保证浏览器每次取最新 SW。
						res.writeHead(200, {
							"content-type": "text/javascript; charset=utf-8",
							"cache-control": "no-cache",
							"service-worker-allowed": "/",
							"x-content-type-options": "nosniff",
						}).end(renderServiceWorker());
						return;
					case "GET /__dsh_remote__/icon.svg":
						res.writeHead(200, { "content-type": "image/svg+xml" }).end(ICON_SVG);
						return;
					case "GET /__dsh_remote__/brand.svg":
						res.writeHead(200, {
							"content-type": "image/svg+xml",
							"cache-control": "public, max-age=604800",
							"x-content-type-options": "nosniff",
						}).end(BRAND_SVG);
						return;
					case "GET /__dsh_remote__/icon-192.png":
					case "GET /__dsh_remote__/icon-512.png": {
						const size = pathname.endsWith("512.png") ? 512 : 192;
						res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
						res.end(iconPng(size));
						return;
					}
					case "GET /__dsh_remote__/pair":
						await this.handlePairPage(req, res);
						return;
					case "POST /__dsh_remote__/pair":
						await this.handlePairSubmit(req, res);
						return;
					case "GET /__dsh_remote__/login":
						await this.handleLoginPage(req, res, url);
						return;
					case "POST /__dsh_remote__/login":
						await this.handleLoginSubmit(req, res);
						return;
					case "GET /__dsh_remote__/mobile.js":
						await this.handleMobileScript(req, res);
						return;
					default:
						if (pathname.startsWith(`${INTERNAL_PREFIX}admin/`)) {
							await this.handleAdmin(req, res, url);
							return;
						}
						res.writeHead(404).end();
						return;
				}
			}

			// —— 限流 ——
			// GW-03：传入 config，edge 反代拓扑下按真实客户端 IP 限流
			const ip = clientIp(req, this.config);
			if (!this.limiter.allow(ip)) {
				this.store.audit("rate_limited", { ip, path: pathname }).catch(() => {});
				res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote: 请求过于频繁");
				return;
			}

			// —— 认证门 ——
			// desktop：stcp/xtcp 形态下访客密钥已挡在隧道外，可免配对码；
			// edge：本身是公网入口，一律要求设备 Cookie（登录页 / 配对页二选一）。
			const tunnelAdmits = this.config.role !== "edge" && visitorKeyAdmits(this.config);
			const verdict = tunnelAdmits
				? { ok: true as const, deviceId: "visitor-key" }
				: await checkRequest(req, { store: this.store, config: this.config });
			if (!verdict.ok) {
				const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
				if (acceptsHtml) {
					const authPage = this.config.role === "edge" && this.accessTokenHash !== undefined
						? LOGIN_PAGE
						: PAIR_PAGE;
					res.writeHead(302, { location: `${authPage}?next=${encodeURIComponent(pathname + url.search)}` });
					res.end();
				} else {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "unpaired-device", reason: verdict.reason }));
				}
				return;
			}

			// —— 反向代理 ——
			proxyHttp(req, res, this.upstreamAddress(), this.htmlInjector);
		} catch (error) {
			this.log(`处理 ${pathname} 出错：${String(error)}`);
			if (!res.headersSent) res.writeHead(500).end("dsh-remote: 内部错误");
			else res.end();
		}
	}

	// ---------- 配对 ----------

	private async handlePairPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (await this.store.deviceByToken(parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? "")) {
			res.writeHead(302, { location: "/" }).end();
			return;
		}
		const locked = this.limiter.isLocked(clientIp(req, this.config));
		const next = safeNext(new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next"));
		const html = isDshRemoteAndroid(req)
			? renderAndroidPairPage(next, locked)
			: renderDefaultPairPage(next, locked);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	}

	private async handlePairSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const ip = clientIp(req, this.config);
		if (this.limiter.isLocked(ip)) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "失败次数过多，已临时锁定" }));
			return;
		}
		const parsed = await readJsonBody<{ code?: string; name?: string }>(req);
		if (!parsed.ok) {
			respondInvalidBody(req, res, parsed.oversized === true);
			return;
		}
		const payload = parsed.value;
		const code = String(payload.code ?? "").toUpperCase().trim();
		const consumed = await this.store.consumePendingCode(code);
		if (!consumed) {
			const stillAllowed = this.limiter.notePairFail(ip);
			await this.store.audit("pair_failed", { ip });
			res.writeHead(stillAllowed ? 403 : 429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: stillAllowed ? "配对码无效或已过期" : "失败次数过多，已临时锁定" }));
			return;
		}
		const { token } = await this.store.addDevice(String(payload.name ?? ""));
		await issueDeviceCookie(res, token, this.config.deviceTokenDays);
		await this.store.audit("pair_success", { ip });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	// ---------- edge 前置 Token 登录 ----------

	private async handleLoginPage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (await this.store.deviceByToken(parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? "")) {
			const next = safeNext(new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next"));
			res.writeHead(302, { location: next }).end();
			return;
		}
		if (this.accessTokenHash === undefined) {
			// 未配置门禁 Token：引导去配对页，避免出现永远登不进的页面
			res.writeHead(302, { location: PAIR_PAGE }).end();
			return;
		}
		const locked = this.limiter.isLocked(clientIp(req, this.config));
		const next = safeNext(url.searchParams.get("next"));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(renderTokenLoginPage(next, locked));
	}

	private async handleLoginSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const ip = clientIp(req, this.config);
		if (this.limiter.isLocked(ip)) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "失败次数过多，已临时锁定" }));
			return;
		}
		const parsed = await readJsonBody<{ token?: string; name?: string }>(req);
		if (!parsed.ok) {
			respondInvalidBody(req, res, parsed.oversized === true);
			return;
		}
		const payload = parsed.value;
		const submitted = String(payload.token ?? "");
		// 空 token 也走一次恒时比较路径，避免用响应时间区分「未配置/为空」
		const ok = verifyAccessToken(submitted, this.accessTokenHash ?? "");
		if (!ok) {
			const stillAllowed = this.limiter.notePairFail(ip);
			await this.store.audit("token_failed", { ip });
			res.writeHead(stillAllowed ? 403 : 429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: stillAllowed ? "访问 Token 无效" : "失败次数过多，已临时锁定" }));
			return;
		}
		const requested = String(payload.name ?? "").trim();
		const deviceName = (requested || deriveDeviceName(req)).slice(0, 64);
		const { token } = await this.store.addDevice(deviceName);
		const days = typeof this.config.auth?.tokenLoginDays === "number" ? this.config.auth.tokenLoginDays : 30;
		await issueDeviceCookie(res, token, days);
		await this.store.audit("token_login", { ip, device: deviceName });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	// ---------- 移动 hook 资产（需设备认证，缩小公网指纹面） ----------

	private async handleMobileScript(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const verdict = await checkRequest(req, { store: this.store, config: this.config });
		if (!verdict.ok) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "unpaired-device", reason: verdict.reason }));
			return;
		}
		const asset = await loadMobileScript();
		if (asset === undefined) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("dsh-remote: mobile.js 缺失");
			return;
		}
		if (req.headers["if-none-match"] === asset.etag) {
			res.writeHead(304, { etag: asset.etag }).end();
			return;
		}
		res.writeHead(200, {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "public, max-age=3600",
			etag: asset.etag,
			"x-content-type-options": "nosniff",
		});
		res.end(asset.body);
	}

	// ---------- 管理（仅回环） ----------

	private async handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		switch (`${req.method} ${url.pathname}`) {
			case "POST /__dsh_remote__/admin/pair-code": {
				const code = generatePairingCode();
				const pending = await this.store.putPendingCode(code, this.config.pairingCodeMinutes);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ code, expiresAt: pending.expiresAt }));
				return;
			}
			case "GET /__dsh_remote__/admin/devices": {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ devices: await this.store.listDevices() }, null, "\t"));
				return;
			}
			case "POST /__dsh_remote__/admin/revoke": {
				// SEC-02：畸形 JSON 回 400（原先裸 JSON.parse 抛成 500）；超限回 413（GW-11）
				const parsed = await readJsonBody<{ id?: string }>(req);
				if (!parsed.ok) {
					respondInvalidBody(req, res, parsed.oversized === true);
					return;
				}
				const body = parsed.value;
				const ok = typeof body.id === "string" ? await this.store.revokeDevice(body.id) : false;
				res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok }));
				return;
			}
			case "GET /__dsh_remote__/admin/status": {
				const upstream = this.upstreamAddress();
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({
					port: this.actualPort,
					role: this.config.role ?? "desktop",
					edgeFrpRole: effectiveEdgeFrpRole(this.config),
					tokenGate: this.accessTokenHash !== undefined,
					certFingerprint: this.cert?.fingerprintSha256,
					frpMode: normalizeFrpMode(this.config.frp.mode),
					frp: this.frpStatus(),
					frps: this.frps?.status(),
					visitor: this.visitor?.status(),
					upstream: `${upstream.host}:${String(upstream.port)}`,
				}, null, "\t"));
				return;
			}
			case "POST /__dsh_remote__/admin/shutdown": {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				void this.stop().finally(() => process.exit(0));
				return;
			}
			default:
				res.writeHead(404).end();
		}
	}

	// ---------- WebSocket ----------

	private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
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
		const tunnelAdmits = this.config.role !== "edge" && visitorKeyAdmits(this.config);
		const verdict = tunnelAdmits
			? { ok: true as const, deviceId: "visitor-key" }
			: await checkRequest(req, { store: this.store, config: this.config });
		if (!verdict.ok) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
			socket.destroy();
			await this.store.audit("upgrade_rejected", { path: url.split("?")[0] });
			return;
		}
		if (head.length > 4096) {
			socket.destroy();
			return;
		}
		proxyUpgrade(req, socket as never, head, this.upstreamAddress());
	}
}

function isDshRemoteAndroid(req: IncomingMessage): boolean {
	return String(req.headers["user-agent"] ?? "").includes("DSHRemoteAndroid/1");
}

function pairScript(next: string, locked: boolean): string {
	return `<script>
async function submit(){
 const err=document.getElementById('err');
 err.textContent='';
 const r=await fetch('${PAIR_PAGE}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value.trim(),name:document.getElementById('name').value})});
 if(r.ok){location.href=${JSON.stringify(next)};return;}
 const j=await r.json().catch(()=>({}));
 err.textContent= j.message ?? ('配对失败 ('+r.status+')');
}
document.getElementById('code').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
${locked ? "document.getElementById('err').textContent='失败次数过多，请稍后再试';" : ""}
</script>`;
}

/** edge 登录页脚本：提交访问 Token，成功后由 302/JSON 引导回 next。 */
function loginScript(next: string, locked: boolean): string {
	return `<script>
async function submit(){
 const err=document.getElementById('err');
 err.textContent='';
 const r=await fetch('${LOGIN_PAGE}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value.trim(),name:document.getElementById('name').value})});
 if(r.ok){location.href=${JSON.stringify(next)};return;}
 const j=await r.json().catch(()=>({}));
 err.textContent= j.message ?? ('验证失败 ('+r.status+')');
}
document.getElementById('token').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
${locked ? "document.getElementById('err').textContent='失败次数过多，请稍后再试';" : ""}
</script>`;
}

/** 从 User-Agent 推导设备显示名（Token 登录自动配对时缺省名称）。 */
function deriveDeviceName(req: IncomingMessage): string {
	const ua = String(req.headers["user-agent"] ?? "");
	if (/iPad/i.test(ua)) return "iPad · 浏览器";
	if (/iPhone/i.test(ua)) return "iPhone · 浏览器";
	if (/Android/i.test(ua)) return "Android · 浏览器";
	if (/Macintosh/i.test(ua)) return "Mac · 浏览器";
	if (/Windows/i.test(ua)) return "Windows · 浏览器";
	return "浏览器设备";
}

/**
 * edge 前置 Token 登录页。观感与默认配对页同族（深色卡片）；
 * 未认证可访问，因此渲染走纯静态模板 + safeNext 白名单，无任何注入面。
 */
function renderTokenLoginPage(next: string, locked: boolean): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH Remote · 访问验证</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#101418;color:#e8eaed;display:flex;justify-content:center;padding-top:12vh;margin:0}
 .card{background:#1a2027;border-radius:16px;padding:32px;width:min(92vw,380px)}
 h1{font-size:20px;margin:0 0 8px} p{color:#9aa4af;font-size:13px;line-height:1.6;margin:0 0 20px}
 input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2c3641;background:#0d1115;color:#fff;font-size:16px;margin-bottom:12px}
 button{width:100%;padding:12px;border:none;border-radius:10px;background:#1b66ff;color:#fff;font-size:15px;font-weight:600}
 .err{color:#ff6b6b;font-size:13px;min-height:18px;margin-bottom:8px}
</style></head><body><div class="card">
<h1>DSH Remote</h1><p>此入口受访问 Token 保护。输入服务器上配置的 Token，验证通过后本设备将被授权并长期保持登录。</p>
<div class="err" id="err"></div>
<input id="token" type="password" placeholder="访问 Token" autocomplete="off">
<input id="name" placeholder="设备名称（可选，如 我的 iPad）">
<button onclick="submit()">验证并进入</button>
${loginScript(next, locked)}</div></body></html>`;
}

function renderDefaultPairPage(next: string, locked: boolean): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH Remote · 设备配对</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#101418;color:#e8eaed;display:flex;justify-content:center;padding-top:12vh;margin:0}
 .card{background:#1a2027;border-radius:16px;padding:32px;width:min(92vw,380px)}
 h1{font-size:20px;margin:0 0 8px} p{color:#9aa4af;font-size:13px;line-height:1.6;margin:0 0 20px}
 input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2c3641;background:#0d1115;color:#fff;font-size:16px;margin-bottom:12px;text-transform:uppercase}
 button{width:100%;padding:12px;border:none;border-radius:10px;background:#1b66ff;color:#fff;font-size:15px;font-weight:600}
 .err{color:#ff6b6b;font-size:13px;min-height:18px;margin-bottom:8px}
</style></head><body><div class="card">
<h1>DSH Remote</h1><p>新设备需要配对。在电脑终端运行 <code>dsh-remote pair</code> 获取一次性配对码，输入后本设备将被授权访问。</p>
<div class="err" id="err"></div>
<input id="code" placeholder="配对码（如 XK4M-P2VW）" autocomplete="off" autocapitalize="characters">
<input id="name" placeholder="设备名称（如 我的手机）">
<button onclick="submit()">配对</button>
${pairScript(next, locked)}</div></body></html>`;
}

function renderAndroidPairPage(next: string, locked: boolean): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH Remote · 设备配对</title>
<style>
 :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
 *{box-sizing:border-box}html,body{min-height:100%;margin:0}body{color:#111318;background:#fff}
 main{min-height:100vh;display:flex;flex-direction:column;padding:max(20px,env(safe-area-inset-top)) 24px max(28px,env(safe-area-inset-bottom))}
 header{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;line-height:28px}header img{width:30px;height:30px}header small{display:inline-flex;align-items:center;min-height:17px;padding:1px 5px;border-radius:3px;background:#111318;color:#fff;font-size:10px;line-height:1}
 section{width:min(100%,360px);margin:auto;transform:translateY(-7vh)}h1{margin:0;font-size:24px;font-weight:650;line-height:1.35}p{margin:10px 0 26px;color:#73777f;font-size:14px;line-height:1.65}label{display:block;margin:0 0 7px;font-size:13px;font-weight:600}input{display:block;width:100%;min-height:48px;margin:0 0 17px;padding:0 12px;border:1px solid #d9dde5;border-radius:7px;background:#fff;color:#111318;font:inherit;font-size:16px;outline:none}input:focus{border-color:#111318;box-shadow:0 0 0 2px rgba(17,19,24,.12)}#code{text-transform:uppercase}.err{min-height:20px;margin:0 0 10px;color:#b33b3b;font-size:13px;line-height:20px}button{width:100%;min-height:48px;border:1px solid #111318;border-radius:7px;background:#111318;color:#fff;font:inherit;font-size:15px;font-weight:650;cursor:pointer}
</style></head><body><main><header><img src="/__dsh_remote__/brand.svg" alt=""><span>deepseek</span><small>HARNESS</small></header>
<section aria-labelledby="title"><h1 id="title">配对这台设备</h1><p>在电脑终端运行 <code>dsh-remote pair</code> 获取一次性配对码。</p>
<div class="err" id="err" role="status" aria-live="polite"></div>
<label for="code">配对码</label><input id="code" placeholder="如 XK4M-P2VW" autocomplete="off" autocapitalize="characters">
<label for="name">设备名称</label><input id="name" placeholder="如 我的手机" autocomplete="nickname">
<button type="button" onclick="submit()">配对</button>
${pairScript(next, locked)}</section></main></body></html>`;
}

// ---------- 小工具 ----------

/**
 * 配对页回跳地址白名单校验。
 * 只允许路径与基础 URL 字符；显式排除引号/反斜杠/尖括号等，
 * 杜绝经 `location.href='${next}'` 注入 JS 的 XSS（配对页可被未认证访问）。
 */
function safeNext(raw: string | null): string {
	if (raw === null || raw === "") return "/";
	// GW-15：长度上限 512，拒绝超长 next（匹配成本与回跳参数都界化）
	if (raw.length > 512) return "/";
	if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
	if (!/^[A-Za-z0-9\-._~!$&()*+,;=:@%?+\/]+$/.test(raw.slice(1))) return "/";
	return raw;
}

/**
 * 管理端点的同源判定：无 Origin（CLI/curl）或 Origin 指向本机网关自身才放行。
 * 局域网监听模式下，恶意网页从用户浏览器向 127.0.0.1 发起的跨站请求会被拦下。
 */
function isSameSiteLoopbackOrigin(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (origin === undefined) return true; // 非浏览器客户端（CLI/探针）
	try {
		const parsed = new URL(origin);
		return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
	} catch {
		return false;
	}
}

/** GW-11：请求体超限专用错误——调用方先回标准 413 再关流，不再裸 destroy 让客户端只吃 RST。 */
class BodyTooLargeError extends Error {
	constructor() {
		super("body too large");
	}
}

/** 配对/登录/管理类端点的请求体上限（代理转发另有业务上限，见 proxy.ts）。 */
const BODY_LIMIT_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk: Buffer) => {
			if (settled) return; // 超限/出错后停止累积，避免继续吃内存
			size += chunk.length;
			if (size > BODY_LIMIT_BYTES) {
				settled = true;
				reject(new BodyTooLargeError());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		});
		req.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
	});
}

type ParsedBody<T> = { ok: true; value: T } | { ok: false; oversized?: boolean };

/**
 * SEC-02 + GW-11：读取并解析 JSON 请求体，把两类失败区分开：
 * - 超 64KB → `{ ok: false, oversized: true }`（调用方回 413 后关流）；
 * - 非法 JSON / 非对象 → `{ ok: false }`（调用方回 400，不再抛成 500）。
 */
async function readJsonBody<T>(req: IncomingMessage): Promise<ParsedBody<T>> {
	let text: string;
	try {
		text = await readBody(req);
	} catch (error) {
		return { ok: false, oversized: error instanceof BodyTooLargeError };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) return { ok: true, value: parsed as T };
	} catch {
		// 非法 JSON 与下面的非对象值同样按 400 处理
	}
	return { ok: false };
}

/** SEC-02 / GW-11 的统一拒绝响应。 */
function respondInvalidBody(req: IncomingMessage, res: ServerResponse, oversized: boolean): void {
	if (oversized) {
		// 先写完标准 413（并声明关闭连接），刷出后再销毁请求流
		res.writeHead(413, { "content-type": "application/json", connection: "close" });
		res.end(JSON.stringify({ message: "请求体过大" }), () => req.destroy());
		return;
	}
	res.writeHead(400, { "content-type": "application/json" });
	res.end(JSON.stringify({ message: "请求体不是合法 JSON" }));
}
