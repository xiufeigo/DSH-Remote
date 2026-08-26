/**
 * frp 传输适配器：
 * - 生成 frpc.toml（三种形态：entry 公网入口 / stcp 秘密中转 / xtcp P2P 打洞，
 *   TLS 在网关终结，WebSocket 直通）；
 * - 以子进程方式托管 frpc，崩溃自动重启（指数退避）；
 * - 不做任何网络魔法：frp 只是把流量原样搬到 127.0.0.1:<listenPort>。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { FrpConfig, FrpMode } from "./config.ts";
import type { Store } from "./store.ts";

/** 归一化隧道形态：未知/缺省值一律回落为 entry（保持历史行为）。 */
export function normalizeFrpMode(mode: string | undefined): FrpMode {
	return mode === "stcp" || mode === "xtcp" ? mode : "entry";
}

/** 写进 frps 的缺省 proxy 名；历史配置没有 `frp.name` 时沿用这个值。 */
export const DEFAULT_TUNNEL_NAME = "dsh-remote";

const TUNNEL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** 空或非法字符回落缺省名，避免把空格/引号写进 toml。 */
export function normalizeTunnelName(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_TUNNEL_NAME;
	const trimmed = raw.trim();
	return TUNNEL_NAME_RE.test(trimmed) ? trimmed : DEFAULT_TUNNEL_NAME;
}

/** 在约定位置寻找 frpc 可执行文件；找不到返回 undefined。 */
export async function locateFrpcBinary(config: FrpConfig, store: Store): Promise<string | undefined> {
	const candidates = [
		config.binaryPath,
		join(store.home, "vendor", "frp", process.platform === "win32" ? "frpc.exe" : "frpc"),
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// 尝试下一个位置
		}
	}
	return undefined;
}

export function renderFrpcToml(options: {
	serverAddr: string;
	serverPort: number;
	authToken: string;
	localPort: number;
	/** 仅 mode=entry 需要；其余形态 VPS 上不监听任何端口 */
	remotePort?: number;
	mode?: string;
	/** mode=stcp/xtcp 时的访客密钥 */
	secretKey?: string;
	name?: string;
}): string {
	const mode = normalizeFrpMode(options.mode);
	const proxyName = normalizeTunnelName(options.name);
	if (mode === "entry") {
		return `# 由 dsh-remote 自动生成，手工修改会在下次 start 时被覆盖
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = "${options.authToken}"
transport.tls.enable = true

[[proxies]]
name = "${proxyName}"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${options.localPort}
remotePort = ${options.remotePort}
transport.useEncryption = false
transport.useCompression = false
`;
	}
	if (mode === "stcp") {
		return `# 由 dsh-remote 自动生成，手工修改会在下次 start 时被覆盖
# 形态：stcp（秘密中转，VPS 不开任何入口端口）
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = "${options.authToken}"
transport.tls.enable = true

[[proxies]]
name = "${proxyName}"
type = "stcp"
secretKey = "${options.secretKey ?? ""}"
localIP = "127.0.0.1"
localPort = ${options.localPort}
transport.useEncryption = false
transport.useCompression = false
`;
	}
	// xtcp：同时挂一条同端口的 stcp，供 visitor 的 fallbackTo 使用。
	// 官方 frpc 不会因为 type=xtcp 就自动中转，必须显式配置双 proxy。
	return `# 由 dsh-remote 自动生成，手工修改会在下次 start 时被覆盖
# 形态：xtcp（P2P 打洞；visitor 侧 fallbackTo stcp 中转）
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = "${options.authToken}"
transport.tls.enable = true

[[proxies]]
name = "${proxyName}-stcp"
type = "stcp"
secretKey = "${options.secretKey ?? ""}"
localIP = "127.0.0.1"
localPort = ${options.localPort}
transport.useEncryption = false
transport.useCompression = false

[[proxies]]
name = "${proxyName}"
type = "xtcp"
secretKey = "${options.secretKey ?? ""}"
localIP = "127.0.0.1"
localPort = ${options.localPort}
transport.useEncryption = false
transport.useCompression = false
`;
}

/**
 * 生成访客侧 frpc.toml（手机壳 App / 其他设备内嵌的 frpc visitor 使用）。
 * visitor 与服务端 proxy 通过 serverName + secretKey 关联；authToken 用于登录同一台 frps。
 */
export function renderVisitorToml(options: {
	serverAddr: string;
	serverPort: number;
	authToken: string;
	/** 服务端 [[proxies]] 的 name，须与电脑端 `frp.name` 一致 */
	serverName?: string;
	secretKey?: string;
	mode?: string;
	bindAddr?: string;
	bindPort: number;
	name?: string;
}): string {
	const mode = normalizeFrpMode(options.mode);
	const serverName = normalizeTunnelName(options.serverName);
	const visitorName = options.name ?? `${serverName}-visitor`;
	const common = `# 由 dsh-remote visitor 自动生成 —— 访客侧 frpc 配置
# 用法：frpc -c frpc-visitor.toml 之后访问 https://127.0.0.1:${String(options.bindPort)}
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = "${options.authToken}"
transport.tls.enable = true
`;
	if (mode !== "xtcp") {
		return `${common}
[[visitors]]
name = "${visitorName}"
type = "stcp"
serverName = "${serverName}"
secretKey = "${options.secretKey ?? ""}"
bindAddr = "${options.bindAddr ?? "127.0.0.1"}"
bindPort = ${options.bindPort}
`;
	}
	const stcpVisitor = `${serverName}-stcp-visitor`;
	return `${common}
[[visitors]]
name = "${stcpVisitor}"
type = "stcp"
serverName = "${serverName}-stcp"
secretKey = "${options.secretKey ?? ""}"
bindPort = -1

[[visitors]]
name = "${visitorName}"
type = "xtcp"
serverName = "${serverName}"
secretKey = "${options.secretKey ?? ""}"
bindAddr = "${options.bindAddr ?? "127.0.0.1"}"
bindPort = ${options.bindPort}
keepTunnelOpen = true
fallbackTo = "${stcpVisitor}"
fallbackTimeoutMs = 5000
`;
}

/**
 * 连接串：把访客需要的全部参数打包成一条可扫码的 URL。
 * Android 壳 App 扫码导入即完成全部配置（含网关证书指纹，用于证书锁定）。
 */
export function visitorConnectionString(options: {
	mode?: string;
	serverAddr: string;
	serverPort: number;
	serverName?: string;
	secretKey: string;
	authToken: string;
	bindPort: number;
	/** 网关自签证书 SHA-256 指纹（hex）；提供后 App 端启用证书锁定 */
	fingerprint?: string;
}): string {
	const params = new URLSearchParams({
		v: "1",
		mode: normalizeFrpMode(options.mode),
		server: options.serverAddr,
		cport: String(options.serverPort),
		name: normalizeTunnelName(options.serverName),
		sk: options.secretKey,
		token: options.authToken,
		bport: String(options.bindPort),
	});
	if (typeof options.fingerprint === "string" && options.fingerprint.length > 0) {
		params.set("fp", options.fingerprint.replace(/:/g, "").toLowerCase());
	}
	return `dsh-remote://visitor?${params.toString()}`;
}

export interface FrpSupervisorStatus {
	running: boolean;
	restarts: number;
	lastError?: string;
	binary: string;
	configPath: string;
}

export class FrpSupervisor {
	private readonly binary: string;
	private readonly configPath: string;
	private readonly onLog: (line: string) => void;
	private child?: ChildProcess;
	private restarts = 0;
	private lastError?: string;
	private stopping = false;
	private backoffMs = 1_000;

	constructor(binary: string, configPath: string, onLog: (line: string) => void = () => {}) {
		this.binary = binary;
		this.configPath = configPath;
		this.onLog = onLog;
	}

	start(): void {
		this.stopping = false;
		this.spawnChild();
	}

	private spawnChild(): void {
		if (this.stopping) return;
		this.onLog(`frpc 启动：${this.binary} -c ${this.configPath}`);
		const child = spawn(this.binary, ["-c", this.configPath], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (chunk: Buffer) => this.onLog(chunk.toString("utf8").trimEnd()));
		child.stderr?.on("data", (chunk: Buffer) => this.onLog(chunk.toString("utf8").trimEnd()));
		child.on("exit", (code, signal) => {
			if (this.stopping) return;
			this.lastError = `frpc 退出（code=${String(code)} signal=${String(signal)}）`;
			this.onLog(`${this.lastError}，${this.backoffMs}ms 后重启`);
			this.restarts += 1;
			setTimeout(() => {
				this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
				this.spawnChild();
			}, this.backoffMs);
		});
		child.on("error", (error) => {
			this.lastError = error.message;
		});
		this.child = child;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const child = this.child;
		if (child === undefined || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill();
			setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3_000);
		});
	}

	status(): FrpSupervisorStatus {
		return {
			running: this.child !== undefined && this.child.exitCode === null,
			restarts: this.restarts,
			lastError: this.lastError,
			binary: this.binary,
			configPath: this.configPath,
		};
	}
}
