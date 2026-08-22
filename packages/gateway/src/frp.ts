/**
 * frp 传输适配器：
 * - 生成 frpc.toml（纯 TCP 管道模式，TLS 在网关终结，WebSocket 直通）；
 * - 以子进程方式托管 frpc，崩溃自动重启（指数退避）；
 * - 不做任何网络魔法：frp 只是把 VPS 端口原样搬到 127.0.0.1:<listenPort>。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { FrpConfig } from "./config.ts";
import type { Store } from "./store.ts";

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
	remotePort: number;
	name?: string;
}): string {
	const proxyName = options.name ?? "dsh-remote";
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
