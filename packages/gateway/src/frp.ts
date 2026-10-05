/**
 * frp 传输适配器：
 * - 生成 frpc.toml（三种形态：entry 公网入口 / stcp 秘密中转 / xtcp P2P 打洞，
 *   TLS 在网关终结，WebSocket 直通）；
 * - 以子进程方式托管 frpc，崩溃自动重启（指数退避）；
 * - 不做任何网络魔法：frp 只是把流量原样搬到 127.0.0.1:<listenPort>。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_VISITOR_BIND_PORT, type FrpConfig, type FrpMode } from "./config.ts";
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
	return locateFrBinary("frpc", config, store);
}

/** 在约定位置寻找 frpc/frps 可执行文件：config.binaryPath（仅 frpc）→ <home>/vendor/frp/。 */
export async function locateFrBinary(
	kind: "frpc" | "frps",
	config: FrpConfig,
	store: Store,
): Promise<string | undefined> {
	const exe = process.platform === "win32" ? `${kind}.exe` : kind;
	const candidates = [
		kind === "frpc" ? config.binaryPath : undefined,
		join(store.home, "vendor", "frp", exe),
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

/** edge=visitor/frps 时 visitor 的本地绑定端口缺省值兜底。 */
export function visitorBindPortOf(config: FrpConfig): number {
	return typeof config.visitorBindPort === "number" && config.visitorBindPort > 0
		? config.visitorBindPort
		: DEFAULT_VISITOR_BIND_PORT;
}

/** TOML 基础字符串转义（token 等生成值虽是 base64url，仍防御手工注入）。 */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------- T31-1：控制连接心跳（transport.heartbeat*） ----------

/**
 * frpc 控制连接心跳的缺省值（秒）。
 *
 * 依据（重要，别把它当"根治项"）：
 * - frp 0.61.1 的内建缺省就是 `heartbeatInterval=30` / `heartbeatTimeout=90`，
 *   **显式写死并不改变"frpc 能多快发现控制连接已死"**，只是把行为钉死、不随版本漂移。
 * - 取 25s（比缺省早 5s）让"控制连接已被运营商 NAT 悄悄回收"的发现窗口从
 *   最坏 ~120s 缩到 ~115s；`heartbeatTimeout=90` 与缺省一致，留足蜂窝抖动余量
 *   （缺心跳只会误判为掉线并重建隧道，代价远大于晚 5s 发现）。
 * - **它不保活数据面**：frp 的心跳 worker 只挂在 `client.(*Control)`，
 *   proxied 连接（xtcp P2P 打洞后的那条）上没有任何心跳。
 *   数据面的空闲保活由 T31-2（网关周期性 WS PING）承担，两者互补、不可互相替代。
 */
export const DEFAULT_FRP_HEARTBEAT_INTERVAL_SEC = 25;
export const DEFAULT_FRP_HEARTBEAT_TIMEOUT_SEC = 90;

/** 单个心跳字段的归一化；返回 undefined 表示"这一行不写进 toml"。 */
function heartbeatSec(raw: unknown, fallback: number): number | undefined {
	// 显式 false / 0 / 负数 = 关闭该项（回落到 frp 内建默认，而不是写出非法值）
	if (raw === false) return undefined;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	if (raw <= 0) return undefined;
	return Math.round(Math.min(Math.max(raw, 1), 3600));
}

export interface FrpHeartbeat {
	/** transport.heartbeatInterval（秒）；undefined = 不写该行 */
	intervalSec?: number;
	/** transport.heartbeatTimeout（秒）；undefined = 不写该行 */
	timeoutSec?: number;
}

/** 模板入参：undefined = 用缺省；false = 整个心跳关掉；对象 = 逐字段覆盖。 */
export type FrpHeartbeatInput = false | { interval?: unknown; timeout?: unknown } | undefined;

/**
 * 把模板入参归一化成要写进 toml 的两行。
 * 超时必须严格大于周期（frpc 对 `timeout <= interval` 直接启动失败），这里兜住。
 */
export function resolveFrpHeartbeat(input: FrpHeartbeatInput): FrpHeartbeat {
	if (input === false) return {};
	const src = input ?? {};
	const intervalSec = heartbeatSec(src.interval, DEFAULT_FRP_HEARTBEAT_INTERVAL_SEC);
	if (intervalSec === undefined) return {};
	const timeoutSec = heartbeatSec(src.timeout, DEFAULT_FRP_HEARTBEAT_TIMEOUT_SEC);
	if (timeoutSec === undefined) return { intervalSec };
	// 周期被调大到超过缺省超时时，成比例抬超时，避免写出 frpc 拒绝的组合
	return { intervalSec, timeoutSec: timeoutSec > intervalSec ? timeoutSec : intervalSec * 2 };
}

/** 渲染成两行 TOML（无有效值时返回空串）。 */
function heartbeatBlock(input: FrpHeartbeatInput): string {
	const { intervalSec, timeoutSec } = resolveFrpHeartbeat(input);
	const lines: string[] = [];
	if (intervalSec !== undefined) lines.push(`transport.heartbeatInterval = ${String(intervalSec)}`);
	if (timeoutSec !== undefined) lines.push(`transport.heartbeatTimeout = ${String(timeoutSec)}`);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * 生成 frps 端配置（edge=frps 角色在容器/服务器本地跑 frps）。
 * 只开控制口；入口端口由 allowPorts 限定，避免 PC 端把任意端口绑到公网。
 */
export function renderFrpsToml(options: {
	bindAddr: string;
	bindPort: number;
	authToken: string;
	allowPorts?: Array<{ start: number; end: number }>;
}): string {
	const allowLines = (options.allowPorts ?? [])
		.filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end))
		.map((range) => `  { start = ${range.start}, end = ${range.end} }`)
		.join(",\n");
	const allowBlock = allowLines.length > 0
		? `allowPorts = [\n${allowLines},\n]\n`
		: "";
	return `# 由 dsh-remote 自动生成，手工修改会在下次 start 时被覆盖
bindAddr = "${options.bindAddr}"
bindPort = ${options.bindPort}

auth.token = ${tomlString(options.authToken)}
transport.tls.force = true

${allowBlock}webServer.addr = "127.0.0.1"
`;
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
	/** T31-1：控制连接心跳；undefined = 缺省 25/90，false = 不写 */
	heartbeat?: FrpHeartbeatInput;
}): string {
	const mode = normalizeFrpMode(options.mode);
	const proxyName = normalizeTunnelName(options.name);
	const beat = heartbeatBlock(options.heartbeat);
	if (mode === "entry") {
		return `# 由 dsh-remote 自动生成，手工修改会在下次 start 时被覆盖
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = ${tomlString(options.authToken)}
transport.tls.enable = true
${beat}
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

auth.token = ${tomlString(options.authToken)}
transport.tls.enable = true
${beat}
[[proxies]]
name = "${proxyName}"
type = "stcp"
secretKey = ${tomlString(options.secretKey ?? "")}
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

auth.token = ${tomlString(options.authToken)}
transport.tls.enable = true
${beat}
[[proxies]]
name = "${proxyName}-stcp"
type = "stcp"
secretKey = ${tomlString(options.secretKey ?? "")}
localIP = "127.0.0.1"
localPort = ${options.localPort}
transport.useEncryption = false
transport.useCompression = false

[[proxies]]
name = "${proxyName}"
type = "xtcp"
secretKey = ${tomlString(options.secretKey ?? "")}
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
	/** T31-1：visitor 侧控制连接心跳；undefined = 缺省 25/90，false = 不写 */
	heartbeat?: FrpHeartbeatInput;
}): string {
	const mode = normalizeFrpMode(options.mode);
	const serverName = normalizeTunnelName(options.serverName);
	const visitorName = options.name ?? `${serverName}-visitor`;
	const common = `# 由 dsh-remote visitor 自动生成 —— 访客侧 frpc 配置
# 用法：frpc -c frpc-visitor.toml 之后访问 https://127.0.0.1:${String(options.bindPort)}
serverAddr = "${options.serverAddr}"
serverPort = ${options.serverPort}

auth.token = ${tomlString(options.authToken)}
transport.tls.enable = true
${heartbeatBlock(options.heartbeat)}`;
	if (mode !== "xtcp") {
		return `${common}
[[visitors]]
name = "${visitorName}"
type = "stcp"
serverName = "${serverName}"
secretKey = ${tomlString(options.secretKey ?? "")}
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
secretKey = ${tomlString(options.secretKey ?? "")}
bindPort = -1

[[visitors]]
name = "${visitorName}"
type = "xtcp"
serverName = "${serverName}"
secretKey = ${tomlString(options.secretKey ?? "")}
bindAddr = "${options.bindAddr ?? "127.0.0.1"}"
bindPort = ${options.bindPort}
keepTunnelOpen = true
fallbackTo = "${stcpVisitor}"
# T113：打洞尝试的超时预算。原为 frp 缺省的 5000 —— 实测**每一条新建 TCP 连接**都要付一次
# （5057–5162ms，与资源体积无关），稳态首屏两段就白等 10.37s（T111 report §3.3）。
# 800ms 与 Android 侧 VisitorConfig.FALLBACK_TIMEOUT_MS 必须同值（cross-end.mjs 逐行对齐）。
fallbackTimeoutMs = 800
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

interface FrpSupervisorStatus {
	running: boolean;
	restarts: number;
	lastError?: string;
	binary: string;
	configPath: string;
}

/** FRP-02：子进程“稳定运行”阈值——存活超过该时长后偶发崩溃不再吃累积退避。 */
const STABLE_RUN_MS = 60_000;

export class FrpSupervisor {
	private readonly binary: string;
	private readonly configPath: string;
	private readonly onLog: (line: string) => void;
	private child?: ChildProcess;
	private restarts = 0;
	private lastError?: string;
	private stopping = false;
	private backoffMs = 1_000;
	/** FRP-02：最近一次 spawn 成功的时间戳，用于 exit 时判断是否稳定运行过 60s。 */
	private lastSpawnAt = 0;

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
		this.onLog(`${this.binary.split(/[\\/]/).pop()} 启动：${this.binary} -c ${this.configPath}`);
		let child: ChildProcess;
		try {
			child = spawn(this.binary, ["-c", this.configPath], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			// spawn 同步抛错（如二进制被安全软件拦截）：与退出同路径，退避重启
			this.lastError = error instanceof Error ? error.message : String(error);
			this.onLog(`spawn 失败（${this.lastError}），${this.backoffMs}ms 后重试`);
			this.restarts += 1;
			const delay = this.backoffMs;
			this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
			setTimeout(() => this.spawnChild(), delay);
			return;
		}
		// FRP-02：记录 spawn 成功时刻；下次 exit 时若已稳定运行 ≥60s，退避与计数归零
		this.lastSpawnAt = Date.now();
		// FRP-04：用 readline 按完整行切割输出——按 chunk 直接 toString 会在日志行
		// 跨 chunk 时打印半行、单 chunk 含多行时把多行并进一条日志
		if (child.stdout !== null) {
			createInterface({ input: child.stdout }).on("line", (line) => this.onLog(line.trimEnd()));
		}
		if (child.stderr !== null) {
			createInterface({ input: child.stderr }).on("line", (line) => this.onLog(line.trimEnd()));
		}
		child.on("exit", (code, signal) => {
			if (this.stopping) return;
			// FRP-02：长期稳定运行后的偶发崩溃视为孤立事件——先归零退避与重启计数，
			// 避免稳定跑了几天后一次偶发崩溃仍吃 30s 退避延迟
			if (Date.now() - this.lastSpawnAt >= STABLE_RUN_MS) {
				this.backoffMs = 1_000;
				this.restarts = 0;
			}
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
			// FRP-01：兜底定时器在 exit 触发时必须清理——否则优雅退出后事件循环上还挂 3s
			const killTimer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3_000);
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
			this.killChild(child);
		});
	}

	/**
	 * FRP-03：终止 frpc 子进程。
	 * Windows 上 child.kill() 只作用于直接子进程；网关被硬杀（任务管理器/断电）后
	 * frpc 会成为孤儿进程占住端口，因此改用 `taskkill /pid <pid> /T /F` 杀掉整个
	 * 进程树，失败（如进程已退出）再回落到 child.kill()。
	 * 注意：网关自身被硬杀时仍执行不到这里的清理（部署文档应注明该残留风险）。
	 */
	private killChild(child: ChildProcess): void {
		if (process.platform === "win32" && child.pid !== undefined) {
			const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			if (result.status === 0) return;
		}
		child.kill();
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
