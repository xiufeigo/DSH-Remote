/**
 * 网关主服务：HTTPS 监听（自签证书），内部路由 + 认证门 + 反向代理。
 * 本文件只保留初始化 / 路由分发 / 生命周期；配对与登录页模板在 views.ts，
 * 请求体读取解析在 body.ts，WebSocket 升级转发在 ws.ts。
 *
 * 路由约定：
 *   /__dsh_remote__/pair                配对页（未认证可访问，POST 消费一次性码）
 *   /__dsh_remote__/sw.js               主屏/离线用的 Service Worker（白名单缓存）
 *   /__dsh_remote__/icon-192.png        apple-touch-icon（iOS 只认 PNG）
 *   /__dsh_remote__/health              存活探针（无信息泄露）
 *   /__dsh_remote__/admin/*             本机管理端点（回环来源 + 同源 Origin +
 *                                       secrets 管理密钥三重门；launch-token
 *                                       接收插件下发的 DSH 0.1.2+ 启动令牌）
 *   其余                                设备认证后原样代理到上游 DSH Web GUI
 */

import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
	ADMIN_TOKEN_HEADER,
	INTERNAL_PREFIX,
	LOGIN_PAGE,
	PAIR_PAGE,
	RateLimiter,
	checkRequest,
	clientIp,
	deviceCookieName,
	ensureAccessTokenHash,
	generatePairingCode,
	hashAccessToken,
	isLoopback,
	issueDeviceCookie,
	parseCookies,
	sameOriginAsHost,
	verifyLoginSecret,
	verifyAdminToken,
	type LoginKind,
} from "./auth.ts";
import { PeerDeviceSession, edgeNeedsPeerDeviceCookie } from "./peer-device.ts";
import { readJsonBody, respondInvalidBody } from "./body.ts";
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
	publicEntryEnabled,
	renderFrpcToml,
	renderFrpsToml,
	renderVisitorToml,
	visitorBindPortOf,
	type FrpHeartbeatInput,
} from "./frp.ts";
import { loadMobileScript } from "./mobile.ts";
import { BRAND_SVG, iconPng, injectIntoHtml, makeHtmlInjector, renderServiceWorker, renderShellManifest } from "./pwa.ts";
import { proxyHttp, type Upstream } from "./proxy.ts";
import { UpstreamSession } from "./session.ts";
import type { Store } from "./store.ts";
import { resolveUpstreamPort } from "./upstream.ts";
import {
	deriveDeviceName,
	isDshRemoteAndroid,
	renderAndroidPairPage,
	renderDefaultPairPage,
	renderLoginPage,
	safeNext,
} from "./views.ts";
import { parseProxyV2, proxyClientIpOf, setProxyClientIp } from "./proxyproto.ts";
import { handleGatewayUpgrade } from "./ws.ts";

/**
 * T31-1：把 `frp.heartbeatInterval/Timeout` 翻译成模板入参。
 * 两项都写 ≤0（或缺省但被显式置 0）时输出 `false`，模板就一行心跳都不写。
 */
function frpHeartbeatOf(frp: GatewayConfig["frp"]): FrpHeartbeatInput {
	return { interval: frp.heartbeatInterval, timeout: frp.heartbeatTimeout };
}

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
	private readonly entryLimiter: RateLimiter;
	private readonly log: (line: string) => void;
	private readonly env: NodeJS.ProcessEnv;
	private server?: https.Server;
	private entryServer?: https.Server;
	private entryNet?: net.Server;
	private instanceId?: string;
	private startPromise?: Promise<void>;
	private stopPromise?: Promise<void>;
	private frp?: FrpSupervisor;
	private frps?: FrpSupervisor;
	private visitor?: FrpSupervisor;
	private cert?: GatewayCert;
	private loginCredential?: { kind: LoginKind; hash: string };
	/** P0-2：管理端点共享密钥（state/secrets.json 的 adminToken），start() 时加载。 */
	private adminToken?: string;
	private htmlInjector: (body: Buffer) => Buffer = injectIntoHtml;
	/**
	 * DSH 0.1.2+ 上游浏览器会话（令牌由插件宿主半边经 admin 端点下发）。
	 * 旧版宿主（≤0.1.1-rc.2）无浏览器认证，令牌永不 arrive，注入自然缺席。
	 */
	private readonly session: UpstreamSession;
	/** edge → 电脑端隧道：用访客密钥换来的对端设备 Cookie。 */
	private readonly peerDevices = new PeerDeviceSession((line) => this.log(line));
	private peerVisitorKey = "";

	constructor(options: GatewayServerOptions) {
		this.store = options.store;
		this.config = options.config;
		this.log = options.log ?? (() => {});
		this.env = options.env ?? process.env;
		this.session = new UpstreamSession({ log: (line) => this.log(line) });
		this.limiter = new RateLimiter(
			options.config.rateLimitPerMinute,
			options.config.pairingFailLockThreshold,
			options.config.pairingFailLockMinutes,
		);
		this.entryLimiter = new RateLimiter(
			options.config.rateLimitPerMinute,
			options.config.pairingFailLockThreshold,
			options.config.pairingFailLockMinutes,
		);
	}

	private limiterFor(publicEntry: boolean): RateLimiter {
		return publicEntry ? this.entryLimiter : this.limiter;
	}

	get actualPort(): number | undefined {
		const address = this.server?.address();
		return typeof address === "object" && address !== null ? address.port : undefined;
	}

	get publicEntryPort(): number | undefined {
		const address = this.entryNet?.address();
		return typeof address === "object" && address !== null ? address.port : undefined;
	}

	get certificate(): GatewayCert | undefined {
		return this.cert;
	}

	private get credentialHash(): string | undefined {
		return this.loginCredential?.kind === "visitor-key" ? this.loginCredential.hash : undefined;
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

	/**
	 * 生效的上游地址（含是否按 HTTPS 访问的推断）。
	 * 本机 DSH（desktop、非 TLS）额外携带上游浏览器会话 cookie（0.1.2+）：
	 * cookie 由 session.ts 为该 authority 铸造缓存；TLS 上游（对端是另一台
	 * PC 网关）不做注入 —— 对端自己负责它本地 DSH 的会话。
	 */
	private upstreamAddress(): Upstream {
		const tls = effectiveUpstreamTls(this.config);
		let base: Upstream;
		if (this.config.role === "edge") {
			const role = normalizeEdgeFrpRole(this.config.frp.edge);
			if (role === "visitor") base = { host: "127.0.0.1", port: visitorBindPortOf(this.config.frp), tls };
			else if (role === "frps" && normalizeEdgeConsume(this.config.frp.edgeConsume) === "entry-port") {
				base = { host: "127.0.0.1", port: this.config.frp.remotePort ?? this.config.upstreamPort, tls };
			} else if (role === "frps") base = { host: "127.0.0.1", port: visitorBindPortOf(this.config.frp), tls };
			else base = { host: this.config.upstreamHost ?? "127.0.0.1", port: this.config.upstreamPort, tls };
		} else {
			base = { host: this.config.upstreamHost ?? "127.0.0.1", port: this.config.upstreamPort, tls };
		}
		if (base.tls === true) return base;
		const sessionCookie = this.session.cookieHeaderFor(base);
		if (sessionCookie === undefined) {
			// 令牌在而 cookie 不在（首铸前 / 401 重铸失败后）：后台补铸
			// （mint 节流兜底，不会形成风暴）；本次请求先按无会话代理。
			if (this.session.hasToken) void this.session.ensureCookie(base).catch(() => {});
			return base;
		}
		return { ...base, sessionCookie, onUnauthorized: () => this.session.invalidate(base) };
	}

	/**
	 * 反代用的上游。edge 打到电脑端网关时，先换好对端设备 Cookie 再注入。
	 * 换不到就保持无 Cookie，调用方应回 502，不能把电脑端登录页透给浏览器。
	 */
	private async upstreamForProxy(): Promise<Upstream> {
		const upstream = this.upstreamAddress();
		if (!edgeNeedsPeerDeviceCookie(this.config)) return upstream;
		const cookie = await this.peerDevices.ensure(upstream, this.peerVisitorKey);
		if (cookie === undefined) return upstream;
		return {
			...upstream,
			sessionCookie: cookie,
			onUnauthorized: () => {
				this.peerDevices.invalidate(upstream);
				return this.peerDevices.ensure(upstream, this.peerVisitorKey);
			},
		};
	}

	start(): Promise<void> {
		if (this.stopPromise !== undefined) return Promise.reject(new Error("网关已关闭，请创建新的实例"));
		this.startPromise ??= this.startInternal().catch(async (error: unknown) => {
			await this.cleanup();
			throw error;
		});
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		// P0-2：admin 门禁密钥（ensureSecrets 对旧 secrets.json 自动补齐 adminToken）
		const secrets = await this.store.ensureSecrets();
		this.adminToken = secrets.adminToken;
		this.instanceId = secrets.instanceId;
		this.peerVisitorKey = secrets.frpVisitorKey;
		const mode = normalizeFrpMode(this.config.frp.mode);
		const desktopTunnel = this.config.role !== "edge" && this.config.frp.enabled === true
			&& (mode === "stcp" || mode === "xtcp");
		if (desktopTunnel || (this.config.role !== "edge" && publicEntryEnabled(this.config.frp))) {
			// 主隧道口和公网入口都用访客密钥换设备 Cookie，不再凭隧道密钥直通。
			this.loginCredential = { kind: "visitor-key", hash: hashAccessToken(secrets.frpVisitorKey) };
			if (secrets.frpVisitorKey.trim().length < 16) {
				this.log("警告：访客密钥短于 16 位。面板只接受至少 16 位可见 ASCII；已保存的短密钥仍可登录，避免把现有隧道锁在外面。");
			}
		} else {
			const hash = await ensureAccessTokenHash(this.store, this.env);
			if (hash !== undefined) this.loginCredential = { kind: "access-token", hash };
		}
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
			if (this.loginCredential === undefined) {
				this.log("警告：未配置访问 Token（DSHR_ACCESS_TOKEN）——公网入口将退化为配对码认证，强烈建议配置");
			}
		}
		this.cert = await this.resolveCert();
		this.server = this.createHttpsServer(false);
		await this.listen(this.server, this.config.listenPort, this.config.listenHost);
		this.log(`网关监听 https://${this.config.listenHost}:${String(this.actualPort)}`);
		if (this.config.role !== "edge" && publicEntryEnabled(this.config.frp)) {
			// OS 分配回环端口。stcp/xtcp 的附加入口和旧的 mode=entry 都把公网流量打到这里，
			// 先吃 PROXY v2 再进 HTTPS，这样限流键是真实来源而不是 127.0.0.1。
			this.entryServer = this.createHttpsServer(true);
			await this.listenEntry(this.entryServer);
		}
		await this.startFrpIfNeeded();
	}

	private createHttpsServer(publicEntry: boolean): https.Server {
		if (this.cert === undefined) throw new Error("HTTPS 监听前必须加载证书");
		const server = https.createServer(
			{ key: this.cert.keyPem, cert: this.cert.certPem },
			(req, res) => {
				// P0-1 兜底：handle 全程 try/catch，这里只拦日志回调等极端抛出，
				// 绝不让 handle 演变成未处理 rejection（同类问题曾可打死进程）
				void this.handle(req, res, publicEntry).catch(() => res.destroy());
			},
		);
		server.on("upgrade", (req, socket, head) => {
			// 认证门与直通转发都在 ws.ts；这里只做接线（P0-1 同款兜底）
			void handleGatewayUpgrade(req, socket as Duplex, head, {
				config: this.config,
				store: this.store,
				publicEntry,
				credentialHash: this.credentialHash,
				instanceId: this.instanceId,
				resolveUpstream: () => this.upstreamForProxy(),
				peerCookieRequired: edgeNeedsPeerDeviceCookie(this.config),
			}).catch(() => socket.destroy());
		});
		server.on("secureConnection", (tlsSocket) => {
			const ip = proxyClientIpOf(tlsSocket);
			if (ip !== undefined) setProxyClientIp(tlsSocket, ip);
		});
		return server;
	}

	/**
	 * 公网入口先吃 PROXY v2，再把剩下的字节交给未 listen 的 HTTPS 服务。
	 * 必须 pauseOnConnect：流式 data 监听会把字节从原生句柄拿走，TLS 握手看不到。
	 */
	private listenEntry(httpsServer: https.Server): Promise<void> {
		const entryNet = net.createServer({ pauseOnConnect: true }, (socket) => {
			this.acceptEntryConnection(socket, httpsServer);
		});
		this.entryNet = entryNet;
		return new Promise<void>((resolve, reject) => {
			entryNet.once("error", reject);
			entryNet.listen(0, "127.0.0.1", () => {
				entryNet.removeListener("error", reject);
				resolve();
			});
		});
	}

	private acceptEntryConnection(socket: net.Socket, httpsServer: https.Server): void {
		let buf = Buffer.alloc(0);
		const onReadable = () => {
			let chunk: Buffer | null;
			while ((chunk = socket.read() as Buffer | null) !== null) buf = Buffer.concat([buf, chunk]);
			if (buf.length > 4096) {
				socket.destroy();
				return;
			}
			const parsed = parseProxyV2(buf);
			if (!parsed.ok) {
				if (parsed.needMore) return;
				socket.destroy();
				return;
			}
			socket.off("readable", onReadable);
			if (parsed.info.srcAddr.length === 0) {
				socket.destroy();
				return;
			}
			setProxyClientIp(socket, parsed.info.srcAddr);
			if (parsed.info.rest.length > 0) socket.unshift(parsed.info.rest);
			httpsServer.emit("connection", socket);
		};
		socket.on("readable", onReadable);
		socket.on("error", () => socket.destroy());
	}

	private listen(server: https.Server, port: number, host: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, host, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
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
		const entryLocalPort = this.publicEntryPort;
		const toml = renderFrpcToml({
			serverAddr: frp.serverAddr,
			serverPort: frp.serverPort,
			authToken: secrets.frpAuthToken,
			localPort: this.actualPort ?? this.config.listenPort,
			remotePort: frp.remotePort,
			entryLocalPort,
			mode,
			secretKey: secrets.frpVisitorKey,
			name: frp.name,
			heartbeat: frpHeartbeatOf(frp),
			trustedCaFile: frp.tlsTrustedCaFile,
			tlsServerName: frp.tlsServerName,
		});
		const configPath = this.store.path("frp", "frpc.toml");
		await this.store.writeAtomic("frp/frpc.toml", toml);
		this.log(mode === "entry"
			? `frp 传输适配器启动（entry，入口端口 ${String(frp.remotePort)}，隧道名 ${normalizeTunnelName(frp.name)}）`
			: `frp 传输适配器启动（${mode}，隧道名 ${normalizeTunnelName(frp.name)}；手机凭访客密钥连入）`);
		if (entryLocalPort !== undefined) this.log(`附加公网入口 https://${frp.serverAddr}:${String(frp.remotePort)}（浏览器输入访客密钥验证）`);
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
			heartbeat: frpHeartbeatOf(frp),
			trustedCaFile: frp.tlsTrustedCaFile,
			tlsServerName: frp.tlsServerName,
		});
		const configPath = this.store.path("frp", role === "frps" ? "frpc-edge-visitor.toml" : "frpc-visitor.toml");
		await this.store.writeAtomic(role === "frps" ? "frp/frpc-edge-visitor.toml" : "frp/frpc-visitor.toml", visitorToml);
		this.visitor = new FrpSupervisor(frpcBin, configPath, (line) => this.log(`[frpc-visitor] ${line}`));
		this.visitor.start();
		this.log(`edge：visitor 启动 → ${serverAddr}:${String(controlPort)}（隧道 ${tunnelName}）；生效上游 http://127.0.0.1:${String(bindPort)}`);
	}

	async stop(): Promise<void> {
		// 先等启动完成或失败，再回收全部资源；失败仍由 start() 的调用方接收。
		this.stopPromise ??= (this.startPromise ?? Promise.resolve()).then(
			() => this.cleanup(),
			() => this.cleanup(),
		);
		await this.stopPromise;
	}

	private async cleanup(): Promise<void> {
		if (this.frp !== undefined) await this.frp.stop();
		if (this.visitor !== undefined) await this.visitor.stop();
		if (this.frps !== undefined) await this.frps.stop();
		this.limiter.stop();
		this.entryLimiter.stop();
		await this.closeHttpServer();
	}

	private async closeHttpServer(): Promise<void> {
		const servers = [this.server, this.entryServer];
		const nets = [this.entryNet];
		this.server = undefined;
		this.entryServer = undefined;
		this.entryNet = undefined;
		// 从未 start（或句柄已被接管）：原先 `this.server?.close(...)` 短路后
		// resolve 永不被调用 → stop() 悬挂；这里直接视为已关闭
		const closeOne = (server: { close: (cb: (error?: Error) => void) => void } | undefined) => {
			if (server === undefined) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
					else resolve();
				});
			});
		};
		await Promise.all([...servers.map(closeOne), ...nets.map(closeOne)]);
	}

	frpStatus() {
		return this.frp?.status();
	}

	// ---------- HTTP ----------

	private async handle(req: IncomingMessage, res: ServerResponse, publicEntry: boolean): Promise<void> {
		try {
			// P0-1：绝对形式请求行（RFC 7230 合法语法，Node http 照单全收）遇畸形
			// authority（端口越界/坏 IPv6 字面量）会让 URL 构造器抛 TypeError——
			// 解析必须留在 try 内，否则未处理 rejection 会击杀整个网关进程
			//（PoC：单条 `GET http://x:99999/ HTTP/1.1` 即可让网关 exit 1）。
			const url = new URL(req.url ?? "/", "https://gateway.invalid");
			const pathname = url.pathname;
			// 纵深防御：请求行含控制字符一律 400（防上游请求走私）
			if (/[\r\n\0]/.test(req.url ?? "")) {
				res.writeHead(400).end();
				return;
			}
			// —— 内部路由 ——
			if (pathname.startsWith(INTERNAL_PREFIX)) {
				if (pathname.startsWith(`${INTERNAL_PREFIX}admin`)) {
					// P0-2：管理端点三重门——回环来源 + 同源 Origin + 管理密钥。
					// 前两道挡不住「同机反代转来的公网流量」：frpc 隧道转发与宿主
					// Caddy 反代下公网请求的 socket 源地址同样是 127.0.0.1，非浏览器
					// 客户端又不带 Origin，曾可经 pair-code 铸造绕过全部认证门。
					// 第三道密钥只存于 0600 的 state/secrets.json，公网侧无从获取。
					const rawToken = req.headers[ADMIN_TOKEN_HEADER];
					const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
					if (!isLoopback(req) || !isSameSiteLoopbackOrigin(req) || !verifyAdminToken(token, this.adminToken)) {
						res.writeHead(403).end();
						return;
					}
				}
				switch (`${req.method} ${pathname}`) {
					case "GET /__dsh_remote__/health":
						res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
							ok: true,
							fingerprint: this.cert?.fingerprintSha256 ?? "",
						}));
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
					case "GET /__dsh_remote__/brand.svg":
						res.writeHead(200, {
							"content-type": "image/svg+xml",
							"cache-control": "public, max-age=604800",
							"x-content-type-options": "nosniff",
						}).end(BRAND_SVG);
						return;
					case "GET /__dsh_remote__/icon-192.png":
						// apple-touch-icon：manifest 图标交给官方 /manifest.webmanifest，
						// 这里只保留 iOS 主屏必需的 PNG（iOS 不读 manifest 图标）。
						res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
						res.end(iconPng(192));
						return;
					case "GET /__dsh_remote__/icon-512.png":
						// 512 一档给安装型 PWA 的 manifest（Chrome 安装 UI 要求 ≥512 的图标）。
						// 生成一次进 iconPng 的进程内缓存，后续请求只是拷贝。
						res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=604800" });
						res.end(iconPng(512));
						return;
					case "GET /__dsh_remote__/pair":
						await this.handlePairPage(req, res, publicEntry);
						return;
					case "POST /__dsh_remote__/pair":
						await this.handlePairSubmit(req, res, publicEntry);
						return;
					case "GET /__dsh_remote__/login":
						await this.handleLoginPage(req, res, url, publicEntry);
						return;
					case "POST /__dsh_remote__/login":
						await this.handleLoginSubmit(req, res, publicEntry);
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

			// —— 限流 + 认证 ——
			// 设备凭据是已认证流量的唯一闸门：Cookie 通过之后没有次数上界。
			// 未认证才 429。不要改成「超限一律 429」，否则正常会话会被自己的桶掐断。
			// 锁定只在登录/配对里生效，不在这里。
			const limiter = this.limiterFor(publicEntry);
			const ip = clientIp(req, this.config);
			const withinRate = limiter.allow(ip);
			const verdict = await checkRequest(req, {
				store: this.store,
				config: this.config,
				credentialHash: this.credentialHash,
				instanceId: this.instanceId,
			});
			if (!withinRate && !verdict.ok) {
				this.store.audit("rate_limited", { ip, path: pathname }).catch(() => {});
				res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote: 请求过于频繁");
				return;
			}
			if (!verdict.ok) {
				// PWA 壳资源（manifest）：浏览器取 `<link rel="manifest">` 的那条请求按规范
				// **不带凭据**（实测 initiator=parser、头里没有 Cookie），必然落到这条未认证
				// 分支 ⇒ 每次冷加载两行控制台红字，且「添加到主屏幕」拿不到 manifest。
				// 未带凭据时由网关自己回一份**不含任何会话/设备数据**的壳 manifest；
				// 带凭据的请求走下面的原路（照原样反代官方那份，保留官方 file handler 等）。
				if (req.method === "GET" && pathname === "/manifest.webmanifest") {
					res.writeHead(200, {
						"content-type": "application/manifest+json; charset=utf-8",
						"cache-control": "no-cache",
						"x-content-type-options": "nosniff",
					});
					res.end(renderShellManifest());
					return;
				}
				const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
				if (acceptsHtml) {
					const authPage = this.loginCredential !== undefined
						&& (this.config.role === "edge" || this.loginCredential.kind === "visitor-key") ? LOGIN_PAGE : PAIR_PAGE;
					res.writeHead(302, { location: `${authPage}?next=${encodeURIComponent(pathname + url.search)}` });
					res.end();
				} else {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "unpaired-device", reason: verdict.reason }));
				}
				return;
			}
			// GET/HEAD 导航可以没有 Origin。其余方法必须与 Host 同源，挡住跨站提交。
			if (req.method !== "GET" && req.method !== "HEAD" && !sameOriginAsHost(req)) {
				res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote: 跨站请求已拒绝");
				return;
			}

			// —— 反向代理 ——
			const upstream = await this.upstreamForProxy();
			if (edgeNeedsPeerDeviceCookie(this.config) && upstream.sessionCookie === undefined) {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
				res.end("dsh-remote: 对端网关尚未就绪");
				return;
			}
			proxyHttp(req, res, upstream, this.htmlInjector, this.log);
		} catch (error) {
			// P0-1：URL 解析失败按 400（请求行畸形），其余内部错误按 500
			const malformedUrl = (error as NodeJS.ErrnoException)?.code === "ERR_INVALID_URL";
			this.log(`处理 ${req.url ?? "/"} 出错：${String(error)}`);
			if (!res.headersSent) {
				res.writeHead(malformedUrl ? 400 : 500).end(malformedUrl ? "dsh-remote: 无法解析的请求行" : "dsh-remote: 内部错误");
			} else {
				res.end();
			}
		}
	}

	// ---------- 配对 ----------

	private async handlePairPage(req: IncomingMessage, res: ServerResponse, publicEntry: boolean): Promise<void> {
		const limiter = this.limiterFor(publicEntry);
		if (await this.store.deviceByToken(parseCookies(req.headers.cookie).get(deviceCookieName(this.instanceId)) ?? "", this.credentialHash)) {
			res.writeHead(302, { location: "/" }).end();
			return;
		}
		const locked = limiter.isLocked(clientIp(req, this.config));
		const next = safeNext(new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next"));
		const html = isDshRemoteAndroid(req)
			? renderAndroidPairPage(next, locked)
			: renderDefaultPairPage(next, locked);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	}

	private async handlePairSubmit(req: IncomingMessage, res: ServerResponse, publicEntry: boolean): Promise<void> {
		const limiter = this.limiterFor(publicEntry);
		const ip = clientIp(req, this.config);
		if (limiter.isLocked(ip)) {
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
			const stillAllowed = limiter.notePairFail(ip);
			await this.store.audit("pair_failed", { ip });
			res.writeHead(stillAllowed ? 403 : 429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: stillAllowed ? "配对码无效或已过期" : "失败次数过多，已临时锁定" }));
			return;
		}
		const { token } = await this.store.addDevice(String(payload.name ?? ""), this.credentialHash);
		await issueDeviceCookie(res, token, this.config.deviceTokenDays, this.instanceId);
		await this.store.audit("pair_success", { ip });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	// ---------- 访客密钥 / edge 访问 Token 登录 ----------

	private async handleLoginPage(req: IncomingMessage, res: ServerResponse, url: URL, publicEntry: boolean): Promise<void> {
		const limiter = this.limiterFor(publicEntry);
		if (await this.store.deviceByToken(parseCookies(req.headers.cookie).get(deviceCookieName(this.instanceId)) ?? "", this.credentialHash)) {
			const next = safeNext(new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next"));
			res.writeHead(302, { location: next }).end();
			return;
		}
		if (this.loginCredential === undefined) {
			// 未配置门禁 Token：引导去配对页，避免出现永远登不进的页面
			res.writeHead(302, { location: PAIR_PAGE }).end();
			return;
		}
		const locked = limiter.isLocked(clientIp(req, this.config));
		const next = safeNext(url.searchParams.get("next"));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(renderLoginPage(next, locked, this.loginCredential.kind));
	}

	private async handleLoginSubmit(req: IncomingMessage, res: ServerResponse, publicEntry: boolean): Promise<void> {
		const limiter = this.limiterFor(publicEntry);
		const ip = clientIp(req, this.config);
		if (limiter.isLocked(ip)) {
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
		const submitted = typeof payload.token === "string" ? payload.token : "";
		const visitor = this.loginCredential?.kind === "visitor-key";
		const ok = verifyLoginSecret(submitted, this.loginCredential?.hash, this.loginCredential?.kind ?? "access-token");
		if (!ok) {
			const stillAllowed = limiter.notePairFail(ip);
			await this.store.audit(visitor ? "visitor_key_failed" : "token_failed", { ip });
			res.writeHead(stillAllowed ? 403 : 429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: stillAllowed ? `${visitor ? "访客密钥" : "访问 Token"}无效` : "失败次数过多，已临时锁定" }));
			return;
		}
		const requested = String(payload.name ?? "").trim();
		const deviceName = (requested || deriveDeviceName(req)).slice(0, 64);
		const { token } = await this.store.addDevice(deviceName, this.credentialHash, true);
		const days = visitor ? this.config.deviceTokenDays
			: typeof this.config.auth?.tokenLoginDays === "number" ? this.config.auth.tokenLoginDays : 30;
		await issueDeviceCookie(res, token, days, this.instanceId);
		await this.store.audit(visitor ? "visitor_key_login" : "token_login", { ip, device: deviceName });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	// ---------- 移动 hook 资产（需设备认证，缩小公网指纹面） ----------

	private async handleMobileScript(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const verdict = await checkRequest(req, {
			store: this.store,
			config: this.config,
			credentialHash: this.credentialHash,
			instanceId: this.instanceId,
		});
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
					tokenGate: this.loginCredential !== undefined,
					certFingerprint: this.cert?.fingerprintSha256,
					frpMode: normalizeFrpMode(this.config.frp.mode),
					frp: this.frpStatus(),
					frps: this.frps?.status(),
					visitor: this.visitor?.status(),
					upstream: `${upstream.host}:${String(upstream.port)}`,
					upstreamSession: this.session.state,
				}, null, "\t"));
				return;
			}
			case "POST /__dsh_remote__/admin/launch-token": {
				// DSH 0.1.2+ 适配：插件宿主半边在 DSH 进程内经 connection 服务
				// 取得浏览器启动令牌后下发到这里；网关随后向上游交换会话 cookie。
				// admin 前缀已统一「回环 + 同源 + 管理密钥」三重门（P0-2）。
				const parsed = await readJsonBody<{ token?: string }>(req);
				if (!parsed.ok) {
					respondInvalidBody(req, res, parsed.oversized === true);
					return;
				}
				const token = typeof parsed.value.token === "string" ? parsed.value.token.trim() : "";
				if (token.length === 0 || token.length > 512) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: false, message: "token 字段缺失或超长" }));
					return;
				}
				this.session.setLaunchToken(token);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				// 立即向上游交换会话 cookie（不阻塞响应）
				void this.session.ensureCookie(this.upstreamAddress()).catch(() => {});
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
}

// ---------- 小工具 ----------

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
