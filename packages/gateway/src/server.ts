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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
	COOKIE_NAME,
	INTERNAL_PREFIX,
	PAIR_PAGE,
	RateLimiter,
	checkRequest,
	clientIp,
	clearDeviceCookie,
	generatePairingCode,
	isLoopback,
	issueDeviceCookie,
	parseCookies,
} from "./auth.ts";
import { ensureCert, type GatewayCert } from "./cert.ts";
import type { GatewayConfig } from "./config.ts";
import { FrpSupervisor, locateFrpcBinary, renderFrpcToml } from "./frp.ts";
import { ICON_SVG, iconPng, injectIntoHtml, renderManifest } from "./pwa.ts";
import { proxyHttp, proxyUpgrade } from "./proxy.ts";
import type { Store } from "./store.ts";
import { resolveUpstreamPort } from "./upstream.ts";

export interface GatewayServerOptions {
	store: Store;
	config: GatewayConfig;
	log?: (line: string) => void;
}

export class GatewayServer {
	readonly store: Store;
	readonly config: GatewayConfig;
	private readonly limiter: RateLimiter;
	private readonly log: (line: string) => void;
	private server?: https.Server;
	private frp?: FrpSupervisor;
	private cert?: GatewayCert;

	constructor(options: GatewayServerOptions) {
		this.store = options.store;
		this.config = options.config;
		this.log = options.log ?? (() => {});
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
			await this.store.saveConfig(this.config);
			this.log("已回写 config.json 的 upstreamPort");
		}
	}

	async start(): Promise<void> {
		await this.resolveUpstream();
		this.cert = await ensureCert(this.store.path("certs"));
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

	private async startFrpIfNeeded(): Promise<void> {
		const frp = this.config.frp;
		if (!frp.enabled) return;
		if (typeof frp.serverAddr !== "string" || frp.serverAddr.length === 0) {
			this.log("frp 已启用但缺少 frp.serverAddr，跳过传输适配器");
			return;
		}
		const binary = await locateFrpcBinary(frp, this.store);
		if (binary === undefined) {
			this.log(
				`找不到 frpc 可执行文件。请将官方 frpc 放到 ${this.store.path("vendor", "frp", "frpc.exe")}（或在 config.json 的 frp.binaryPath 指定）。`,
			);
			return;
		}
		const secrets = await this.store.ensureSecrets();
		const toml = renderFrpcToml({
			serverAddr: frp.serverAddr,
			serverPort: frp.serverPort,
			authToken: secrets.frpAuthToken,
			localPort: this.actualPort ?? this.config.listenPort,
			remotePort: frp.remotePort,
		});
		const configPath = this.store.path("frp", "frpc.toml");
		await this.store.writeAtomic("frp/frpc.toml", toml);
		this.frp = new FrpSupervisor(binary, configPath, (line) => this.log(`[frpc] ${line}`));
		this.frp.start();
	}

	async stop(): Promise<void> {
		if (this.frp !== undefined) await this.frp.stop();
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	frpStatus() {
		return this.frp?.status();
	}

	// ---------- HTTP ----------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "https://gateway.invalid");
		const pathname = url.pathname;

		try {
			// —— 内部路由 ——
			if (pathname.startsWith(INTERNAL_PREFIX)) {
				if (!isLoopback(req) && pathname.startsWith(`${INTERNAL_PREFIX}admin`)) {
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
					case "GET /__dsh_remote__/icon.svg":
						res.writeHead(200, { "content-type": "image/svg+xml" }).end(ICON_SVG);
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
			const ip = clientIp(req);
			if (!this.limiter.allow(ip)) {
				this.store.audit("rate_limited", { ip, path: pathname }).catch(() => {});
				res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote: 请求过于频繁");
				return;
			}

			// —— 认证门 ——
			const verdict = await checkRequest(req, { store: this.store, config: this.config });
			if (!verdict.ok) {
				const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
				if (acceptsHtml) {
					const target = new URL(PAIR_PAGE, `https://gateway.invalid${pathname}${url.search}`);
					res.writeHead(302, { location: `${PAIR_PAGE}?next=${encodeURIComponent(target.pathname + target.search)}` });
					res.end();
				} else {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "unpaired-device", reason: verdict.reason }));
				}
				return;
			}

			// —— 反向代理 ——
			proxyHttp(req, res, { host: "127.0.0.1", port: this.config.upstreamPort }, injectIntoHtml);
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
		const locked = this.limiter.isLocked(clientIp(req));
		const next = safeNext(new URL(req.url ?? "/", "https://gateway.invalid").searchParams.get("next"));
		const html = `<!doctype html>
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
<script>
async function submit(){
 const err=document.getElementById('err');
 err.textContent='';
 const r=await fetch('${PAIR_PAGE}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value.trim(),name:document.getElementById('name').value})});
 if(r.ok){location.href='${next}';return;}
 const j=await r.json().catch(()=>({}));
 err.textContent= j.message ?? ('配对失败 ('+r.status+')');
}
document.getElementById('code').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
</script></div>${locked ? "<script>document.getElementById('err').textContent='失败次数过多，请稍后再试'</script>" : ""}
</body></html>`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	}

	private async handlePairSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const ip = clientIp(req);
		if (this.limiter.isLocked(ip)) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "失败次数过多，已临时锁定" }));
			return;
		}
		let payload: { code?: string; name?: string };
		try {
			payload = JSON.parse(await readBody(req)) as { code?: string; name?: string };
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "请求体不是合法 JSON" }));
			return;
		}
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
				const body = JSON.parse(await readBody(req)) as { id?: string };
				const ok = typeof body.id === "string" ? await this.store.revokeDevice(body.id) : false;
				res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok }));
				return;
			}
			case "GET /__dsh_remote__/admin/status": {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({
					port: this.actualPort,
					certFingerprint: this.cert?.fingerprintSha256,
					frp: this.frpStatus(),
					upstream: `127.0.0.1:${String(this.config.upstreamPort)}`,
				}, null, "\t"));
				return;
			}
			default:
				res.writeHead(404).end();
		}
	}

	// ---------- WebSocket ----------

	private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const url = req.url ?? "/";
		if (url.startsWith(INTERNAL_PREFIX)) {
			socket.destroy();
			return;
		}
		const verdict = await checkRequest(req, { store: this.store, config: this.config });
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
		proxyUpgrade(req, socket as never, head, { host: "127.0.0.1", port: this.config.upstreamPort });
	}
}

// ---------- 小工具 ----------

function safeNext(raw: string | null): string {
	if (raw === null || raw === "") return "/";
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
	return raw;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
