/**
 * dsh-remote-plugin —— cordis 宿主半边。
 *
 * 职责只有一件事：随 web profile 启动，把 DSH-Remote 网关作为子进程拉起，
 * 并在插件卸载/进程退出时收掉。网关自身的认证、反代、frp 托管都在
 * packages/gateway 里，这里不做任何业务。
 *
 * 幂等性：若网关端口已被监听（例如用户手动跑过 `dsh-remote start`），
 * 本插件不重复拉起。
 *
 * 配置开关：~/.dsh-remote/config.json 的 `autoStart`（缺省 true）；
 * 设为 false 可让插件保持安装但不自动启动网关。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** 定位 gateway 包入口（workspace 内相对位置；junction 安装后同样成立）。 */
function locateGatewayCli() {
	const candidates = [
		join(PLUGIN_DIR, "..", "gateway", "src", "cli.ts"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	try {
		return require.resolve("@dsh-remote/gateway/src/cli.ts");
	} catch {
		return undefined;
	}
}

function resolveRemoteHome() {
	const fromEnv = process.env.DSH_REMOTE_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
	const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ".";
	return join(userProfile, ".dsh-remote");
}

function readAutoStartFlag(home) {
	try {
		const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		return config.autoStart !== false;
	} catch {
		return true; // 无配置文件时默认自启
	}
}

async function isPortBound(host, port) {
	const net = await import("node:net");
	return new Promise((resolveProbe) => {
		const socket = new net.Socket();
		const finish = (ok) => {
			socket.destroy();
			resolveProbe(ok);
		};
		socket.setTimeout(800);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, host);
	});
}

const TAG = "[dsh-remote]";

var plugin_default = {
	name: "dsh-remote-plugin",
	inject: [],
	apply(ctx) {
		const home = resolveRemoteHome();
		if (!readAutoStartFlag(home)) {
			console.log(`${TAG} config.autoStart=false，跳过自动拉起`);
			return;
		}
		const cliPath = locateGatewayCli();
		if (cliPath === undefined) {
			console.warn(`${TAG} 未找到 gateway 入口（期望 ${join(PLUGIN_DIR, "..", "gateway", "src", "cli.ts")}），跳过`);
			return;
		}

		let child;
		let disposed = false;
		const restartDelayMs = 3_000;

		ctx.effect(() => {
			void (async () => {
				const configText = existsSync(join(home, "config.json"))
					? readFileSync(join(home, "config.json"), "utf8")
					: "{}";
				let listenPort = 18443;
				try {
					listenPort = JSON.parse(configText).listenPort ?? listenPort;
				} catch {}
				if (await isPortBound("127.0.0.1", listenPort)) {
					console.log(`${TAG} 端口 ${String(listenPort)} 已有网关在监听，不重复拉起`);
					return;
				}
				child = spawn(process.execPath, [cliPath, "start"], {
					env: { ...process.env, DSH_REMOTE_HOME: home },
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				const forward = (chunk) => {
					for (const line of chunk.toString("utf8").split("\n")) {
						const trimmed = line.trimEnd();
						if (trimmed.length === 0) continue;
						// 网关自身日志已带 [dsh-remote] 前缀，避免叠加
						console.log(trimmed.startsWith("[dsh-remote]") ? trimmed : `${TAG} ${trimmed}`);
					}
				};
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);
				child.on("exit", (code, signal) => {
					if (disposed) return;
					console.warn(`${TAG} 网关退出（code=${String(code)} signal=${String(signal)}），${String(restartDelayMs / 1000)}s 后重启`);
					setTimeout(() => {
						if (disposed) return;
						child = spawn(process.execPath, [cliPath, "start"], {
							env: { ...process.env, DSH_REMOTE_HOME: home },
							stdio: ["ignore", "pipe", "pipe"],
							windowsHide: true,
						});
						child.stdout?.on("data", forward);
						child.stderr?.on("data", forward);
					}, restartDelayMs);
				});
			})();
			return () => {
				disposed = true;
				if (child !== undefined && child.exitCode === null) child.kill();
			};
		}, "dsh-remote: gateway lifecycle");
	},
};

export { plugin_default as default };
