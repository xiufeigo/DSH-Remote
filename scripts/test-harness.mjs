/**
 * DSH-Remote 测试公共脚手架（PLG-03 收敛）。
 *
 * smoke / e2e 系脚本统一从这里取用，不再各自复制：
 *   - createTestGateway(options)   临时 home + 写配置 → 拉起网关子进程（cli.ts start），
 *                                  等待「网关监听」输出后返回句柄（含实际端口）
 *   - requestTls(url, options)     忽略自签证书的 HTTPS 请求（fetch 风格返回）
 *   - wsConnect(url, options)      原始 TLS WebSocket 升级握手（不依赖 ws 库，可做字节级断言）
 *   - autoCleanup(run, sync)       集中注册 exit / SIGINT 清理队列（崩溃 / Ctrl-C 兜底）
 *   - waitFor / waitForPort        就绪轮询
 *   - makeTempHome(prefix)         临时数据目录（自动注册清理）
 *   - startFakeUpstream(options)   假上游 DSH（可选记录寻址头；upgrade 原样回声）
 *   - fakeHttpRequest / fakeHttpResponse  插件路由测试用的假 req / res
 *
 * CLI-06：证书指纹提取复用网关 packages/gateway/src/cert.ts 的导出（单一实现，不复制正则）。
 */

import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import net from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayCliPath = join(repoRoot, "packages", "gateway", "src", "cli.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- autoCleanup：集中清理队列 ----------

const cleanups = new Set();
let hooksInstalled = false;
let runningCleanups = false;

function installExitHooks() {
	if (hooksInstalled) return;
	hooksInstalled = true;

	const runAllAsync = async (exitCode) => {
		if (runningCleanups) return;
		runningCleanups = true;
		for (const entry of [...cleanups].reverse()) {
			try {
				await Promise.race([
					Promise.resolve().then(() => entry.run()),
					sleep(10_000),
				]);
			} catch {
				// 尽力清理，单项失败不阻塞其余项
			}
		}
		process.exit(exitCode);
	};

	process.on("SIGINT", () => {
		void runAllAsync(130);
	});
	if (process.platform !== "win32") {
		process.on("SIGTERM", () => {
			void runAllAsync(143);
		});
	}
	// 'exit' 只能跑同步代码：子进程杀进程树 + 删临时目录的同步兜底
	process.on("exit", () => {
		if (runningCleanups) return;
		for (const entry of cleanups) {
			if (typeof entry.sync === "function") {
				try {
					entry.sync();
				} catch {
					// 尽力清理
				}
			}
		}
	});
}

/**
 * 注册一个清理动作到集中队列（LIFO 执行）。
 * @param {() => Promise<void> | void} run 正常 / 信号退出时的异步清理
 * @param {(() => void) | undefined} [sync] 'exit' 事件里的同步兜底（可选）
 * @returns {{ run: Function, sync?: Function }} 令牌；完成后传给 releaseCleanup 注销
 */
export function autoCleanup(run, sync) {
	installExitHooks();
	const entry = { run, sync };
	cleanups.add(entry);
	return entry;
}

/** 注销清理项（资源已被显式释放后调用，避免重复清理）。 */
export function releaseCleanup(entry) {
	cleanups.delete(entry);
}

// ---------- requestTls / wsConnect ----------

/**
 * 忽略自签证书的 HTTPS 请求（网关测试统一入口）。
 * 返回形态与原各脚本的 callGateway 一致：{ status, headers, body, raw, setCookie }。
 * @param {string} url 形如 https://127.0.0.1:<port>/path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | Buffer, timeoutMs?: number }} [options]
 */
export function requestTls(url, { method = "GET", headers = {}, body, timeoutMs } = {}) {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: target.hostname,
				port: target.port === "" ? 443 : Number(target.port),
				path: `${target.pathname}${target.search}`,
				method,
				headers,
				rejectUnauthorized: false,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks);
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: raw.toString("utf8"),
						raw,
						setCookie: res.headers["set-cookie"]?.join("; ") ?? "",
					});
				});
			},
		);
		req.on("error", reject);
		if (timeoutMs !== undefined) {
			req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${String(timeoutMs)}ms）：${url}`)));
		}
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/**
 * 原始 TLS WebSocket 升级握手：发送最小升级请求，收集响应头文本。
 * - `headersText` 在收到 "\r\n\r\n"（或出错 / 超时）时 settle，语义同原 smoke-edge 的 rawUpgrade；
 * - 需要字节级双向断言时直接使用返回的 `socket`。
 * @param {string} url 形如 wss://127.0.0.1:<port>/ws
 * @param {{ headers?: Record<string, string> | string, timeoutMs?: number }} [options]
 *   headers 传对象则逐条拼为请求头；传字符串则原样作为原始头行（可含多条，行间 \r\n 分隔）。
 */
export function wsConnect(url, { headers = {}, timeoutMs = 5_000 } = {}) {
	const target = new URL(url);
	const port = target.port === "" ? 443 : Number(target.port);
	const path = target.pathname + target.search === "" ? "/" : target.pathname + target.search;
	const headerLines = typeof headers === "string"
		? headers
		: Object.entries(headers).map(([name, value]) => `${name}: ${String(value)}`).join("\r\n");

	const socket = tls.connect({ host: target.hostname, port, rejectUnauthorized: false });
	let collected = "";
	let settled = false;
	let settle;
	const headersText = new Promise((resolve) => {
		settle = resolve;
	});
	const timer = setTimeout(finish, timeoutMs);
	function finish() {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.removeListener("data", onData);
		settle(collected);
	}
	function onData(chunk) {
		collected += chunk.toString("latin1");
		if (collected.includes("\r\n\r\n")) finish();
	}
	socket.on("data", onData);
	socket.on("error", finish); // 与原实现对齐：出错时返回已收集的响应头文本，由断言方判定
	socket.on("close", finish);
	socket.once("secureConnect", () => {
		socket.write(
			`GET ${path} HTTP/1.1\r\n` +
			"host: gateway.invalid\r\n" +
			"upgrade: websocket\r\n" +
			"connection: Upgrade\r\n" +
			"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
			"sec-websocket-version: 13\r\n" +
			(headerLines.length > 0 ? `${headerLines}\r\n` : "") +
			"\r\n",
		);
	});

	const entry = autoCleanup(() => socket.destroy(), () => {
		try {
			socket.destroy();
		} catch {
			// 已关闭则忽略
		}
	});
	function close() {
		releaseCleanup(entry);
		finish();
		try {
			socket.destroy();
		} catch {
			// 已关闭则忽略
		}
	}
	return { socket, headersText, close };
}

// ---------- createTestGateway ----------

/** Windows：杀整棵进程树（网关子进程托管的 frpc / frps 一并回收；思路同 FRP-03）。 */
function killTreeSync(pid) {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
	}
}

/**
 * 拉起一个真实网关子进程用于测试：
 * 1. 新建临时 home（mkdtemp）并按 options 写入 config.json / state/secrets.json；
 * 2. 以子进程运行 `node packages/gateway/src/cli.ts start`（走真实 CLI 启动链路：
 *    配置合并、环境变量覆盖、单实例锁）；
 * 3. 等待子进程输出「网关监听 https://<host>:<port>」，解析出实际端口后返回句柄。
 *
 * 句柄自动登记到 autoCleanup（崩溃 / Ctrl-C 时杀进程树 + 删临时目录）。
 *
 * @param {object} [options]
 * @param {string} [options.label] 出错信息里的标签（缺省 "gateway"）
 * @param {string} [options.homePrefix] 临时目录前缀（缺省 "dshr-test-"）
 * @param {Record<string, unknown>} [options.config] config.json 补丁（与网关缺省配置深合并）
 * @param {Record<string, unknown>} [options.secrets] state/secrets.json 内容（可选）
 * @param {Record<string, string>} [options.env] 追加给子进程的环境变量（DSHR_* 等）。
 *   父进程的 DSHR_* 会被先剥离，保证子进程只见到这里显式给的值（对齐旧版进程内
 *   GatewayServer 传显式 env 对象的语义）。
 * @param {(home: string) => Promise<void> | void} [options.prepare] 拉起前对 home 的布置（如拷贝 frp 二进制）
 * @param {string} [options.logPrefix] 给出时把子进程输出按行转发到控制台（如 "[edge]"）；缺省静默缓冲
 * @param {number} [options.timeoutMs] 等待监听的超时（缺省 30_000）
 * @returns {Promise<{ label: string, home: string, port: number, pid: number | undefined,
 *   output: () => string, waitForLine: (regex: RegExp, timeoutMs?: number) => Promise<RegExpExecArray>,
 *   stop: () => Promise<void>, destroy: () => Promise<void> }>}
 */
export async function createTestGateway({
	label = "gateway",
	homePrefix = "dshr-test-",
	config = {},
	secrets,
	env = {},
	prepare,
	logPrefix,
	timeoutMs = 30_000,
} = {}) {
	const home = await mkdtemp(join(tmpdir(), homePrefix));
	await writeFile(join(home, "config.json"), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	if (secrets !== undefined) {
		await mkdir(join(home, "state"), { recursive: true });
		await writeFile(join(home, "state", "secrets.json"), `${JSON.stringify(secrets, null, "\t")}\n`, "utf8");
	}
	if (prepare !== undefined) await prepare(home);

	// 剥离父进程 DSHR_*，避免开发机全局环境变量渗进测试子进程
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("DSHR_")) delete childEnv[key];
	}
	Object.assign(childEnv, env, { DSH_REMOTE_HOME: home });

	const child = spawn(process.execPath, [gatewayCliPath, "start"], {
		cwd: repoRoot,
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdoutBuffer = "";
	let stderrBuffer = "";
	let stdoutPending = "";
	let exited = false;
	let exitInfo = { code: null, signal: null };
	const exitPromise = new Promise((resolve) => {
		child.on("exit", (code, signal) => {
			exited = true;
			exitInfo = { code, signal };
			resolve(exitInfo);
		});
	});
	const forward = (text) => {
		if (logPrefix === undefined) return;
		stdoutPending += text;
		const lines = stdoutPending.split(/\r?\n/);
		stdoutPending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length > 0) console.log(`${logPrefix} ${line}`);
		}
	};
	child.stdout.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		stdoutBuffer += text;
		forward(text);
	});
	child.stderr.on("data", (chunk) => {
		stderrBuffer += chunk.toString("utf8");
	});
	child.on("error", (error) => {
		stderrBuffer += `\nspawn error: ${String(error)}`;
	});

	// 等待「网关监听 https://<host>:<port>」输出；子进程提前退出则带诊断信息失败
	const port = await new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			const match = /网关监听 https:\/\/[^\s:]+:(\d+)/.exec(stdoutBuffer);
			if (match !== null) {
				clearInterval(timer);
				resolve(Number(match[1]));
				return;
			}
			if (exited) {
				clearInterval(timer);
				reject(new Error(
					`${label}：网关子进程提前退出（code=${String(exitInfo.code)}，signal=${String(exitInfo.signal)}）` +
					`\n--- stdout ---\n${stdoutBuffer}\n--- stderr ---\n${stderrBuffer}`,
				));
				return;
			}
			if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(
					`${label}：等待网关监听超时（${String(timeoutMs)}ms）` +
					`\n--- stdout ---\n${stdoutBuffer}\n--- stderr ---\n${stderrBuffer}`,
				));
			}
		}, 50);
	});

	let stopPromise;
	async function stop() {
		if (stopPromise !== undefined) return stopPromise;
		stopPromise = (async () => {
			if (!exited && child.pid !== undefined) {
				if (process.platform === "win32") {
					// Windows 下 kill 信号无法触发 cli.ts 的优雅停机钩子，直接杀进程树
					//（连同托管的 frpc / frps），避免孤儿进程占端口
					killTreeSync(child.pid);
				} else {
					child.kill("SIGTERM");
				}
				await Promise.race([exitPromise, sleep(8_000)]);
				if (!exited) {
					try {
						child.kill("SIGKILL");
					} catch {
						// 进程可能刚好退出
					}
					await exitPromise;
				}
			}
		})();
		return stopPromise;
	}

	const handle = {
		label,
		home,
		port,
		get pid() {
			return child.pid;
		},
		/** 目前收集到的子进程全部 stdout。 */
		output: () => stdoutBuffer,
		/** 继续等待子进程输出匹配某正则的行（如等待 frp 适配器就绪日志）。 */
		waitForLine(regex, ms = 15_000) {
			return new Promise((resolve, reject) => {
				const started = Date.now();
				const timer = setInterval(() => {
					const match = regex.exec(stdoutBuffer);
					if (match !== null) {
						clearInterval(timer);
						resolve(match);
						return;
					}
					if (Date.now() - started > ms) {
						clearInterval(timer);
						reject(new Error(`${label}：等待输出 ${String(regex)} 超时（${String(ms)}ms）`));
					}
				}, 50);
			});
		},
		stop,
		/** stop + 删除临时 home（幂等）。 */
		destroy: async () => {
			await stop();
			await rm(home, { recursive: true, force: true });
			releaseCleanup(entry);
		},
	};

	const entry = autoCleanup(
		async () => {
			await handle.destroy();
		},
		() => {
			if (!exited) killTreeSync(child.pid);
			try {
				rmSync(home, { recursive: true, force: true });
			} catch {
				// 尽力清理
			}
		},
	);

	return handle;
}

// ---------- 假上游 ----------

/**
 * 假上游 DSH：GET / 返回带 __dsh_boot__ 标记的 HTML；upgrade 原样回声。
 * @param {{ seen?: Record<string, string | undefined>, page?: string }} [options]
 *   seen 给出时记录 host / origin / cookie / upgradeHost（验证寻址改写与 Cookie 不外泄）。
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
export async function startFakeUpstream({ seen, page = "<!doctype html><html><head><title>fake dsh</title></head><body>__dsh_boot__ ok</body></html>" } = {}) {
	const server = http.createServer((req, res) => {
		if (seen !== undefined) {
			seen.host = req.headers.host;
			seen.origin = req.headers.origin;
			seen.cookie = req.headers.cookie;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page);
	});
	server.on("upgrade", (req, socket, head) => {
		if (seen !== undefined) seen.upgradeHost = req.headers.host;
		socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
		if (head.length > 0) socket.write(head);
		socket.pipe(socket); // 原始字节回声：只验证管道保真，不实现 WS 协议
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const close = () => new Promise((resolve) => server.close(resolve));
	const entry = autoCleanup(close);
	return {
		server,
		port,
		close: async () => {
			releaseCleanup(entry);
			await close();
		},
	};
}

// ---------- 通用小工具 ----------

/** 临时数据目录（自动登记清理）。 */
export async function makeTempHome(prefix = "dshr-test-") {
	const home = await mkdtemp(join(tmpdir(), prefix));
	autoCleanup(
		() => rm(home, { recursive: true, force: true }),
		() => {
			try {
				rmSync(home, { recursive: true, force: true });
			} catch {
				// 尽力清理
			}
		},
	);
	return home;
}

/**
 * 轮询直到谓词为真（谓词抛错视为未就绪），超时抛错。
 * 语义同原 smoke-edge-frp 的 waitFor。
 */
export async function waitFor(label, fn, timeoutMs = 15_000) {
	const started = Date.now();
	for (;;) {
		try {
			if (await fn()) return;
		} catch {
			// 未就绪
		}
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
		await sleep(400);
	}
}

/**
 * 轮询 TCP 端口是否可连，返回布尔（不抛错）。
 * 语义同原 test-panel-e2e 的 waitPort：probeTimeoutMs 内连不上算一次失败，
 * intervalMs 后重试，超过 timeoutMs 返回 false。
 */
export async function waitForPort(port, timeoutMs = 10_000, { host = "127.0.0.1", probeTimeoutMs = 400, intervalMs = 300 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const open = await new Promise((resolve) => {
			const socket = net.connect({ host, port });
			const settle = (ok) => {
				socket.destroy();
				resolve(ok);
			};
			socket.setTimeout(probeTimeoutMs, () => settle(false));
			socket.once("connect", () => settle(true));
			socket.once("error", () => settle(false));
		});
		if (open) return true;
		await sleep(intervalMs);
	}
	return false;
}

/** 插件路由测试的假请求体（可异步迭代的 POST req）。 */
export function fakeHttpRequest(body, { method = "POST", headers = {} } = {}) {
	return {
		headers,
		method,
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(body);
		},
	};
}

/** 插件路由测试的假响应：捕获 writeHead / end 写入 status / headers / body。 */
export function fakeHttpResponse() {
	const res = {
		status: 0,
		body: "",
		headers: null,
		writeHead(status, headers) {
			res.status = status;
			if (headers !== undefined) res.headers = headers;
			return res;
		},
		end(body = "") {
			res.body = body;
			return res;
		},
	};
	return res;
}

// ---------- CLI-06：证书指纹提取（网关单一实现） ----------

export { fingerprintOf as certFingerprintOf } from "../packages/gateway/src/cert.ts";
