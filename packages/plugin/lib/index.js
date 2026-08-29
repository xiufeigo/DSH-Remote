/**
 * dsh-remote-plugin —— cordis 宿主半边。
 *
 * 职责：
 *   1. 随 web profile 启动拉起 DSH-Remote 网关子进程（幂等、崩溃自动重启、
 *      可被设置面板触发手动重启）；
 *   2. 在 DSH webServer 上注册 /dsh-remote/* 路由，为设置页提供
 *      配置读写/状态聚合/配对码/重启能力；
 *   3. ctx.settings.register 注册命名空间，让插件出现在 设置→插件 的
 *      describe 座位上（卡片 UI 由浏览器半边渲染）。
 *
 * 幂等性：网关端口已被监听时不重复拉起。配置开关：config.json 的 autoStart。
 */

import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY_DEFAULTS, mergeConfigFile, validateConfigPatch } from "./config-schema.js";

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * 定位 gateway 包入口（PLG-05）。解析优先级：
 *   1. env DSH_REMOTE_GATEWAY_CLI —— 显式覆盖（建议绝对路径），供 tarball/npm
 *      独立分发或调试时指向任意位置的 gateway 入口；
 *   2. workspace 相对位置（plugin 与 gateway 仓库内同级；junction 安装后同样成立）；
 *   3. 裸包名 require.resolve 兜底（依赖共享农场 / profile 链接）。
 * 全部失败时抛出带明确诊断的错误（期望的目录布局与环境变量用法），由调用方
 * 决定降级方式（当前策略：打日志并跳过拉起，不拖垮宿主）。
 */
function locateGatewayCli() {
	const fromEnv = process.env.DSH_REMOTE_GATEWAY_CLI;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		const explicit = resolve(fromEnv.trim());
		if (existsSync(explicit)) return explicit;
		throw new Error(
			`DSH_REMOTE_GATEWAY_CLI 指向的文件不存在：${explicit}\n`
			+ "该环境变量应指向 dsh-remote 仓库的 packages/gateway/src/cli.ts（建议使用绝对路径）。",
		);
	}
	const workspace = resolve(PLUGIN_DIR, "..", "gateway", "src", "cli.ts");
	if (existsSync(workspace)) return workspace;
	try {
		return require.resolve("@dsh-remote/gateway/src/cli.ts");
	} catch {
		throw new Error(
			"找不到网关入口 packages/gateway/src/cli.ts。期望布局（任一成立即可）：\n"
			+ `  1. 与插件包同级的仓库目录：${workspace}\n`
			+ "  2. Node 可按裸包名解析 @dsh-remote/gateway/src/cli.ts"
			+ "（先运行 node packages/plugin/scripts/install.mjs 建立链接；链接断裂可用 --repair 体检重建）\n"
			+ "  3. 或用环境变量显式指定：DSH_REMOTE_GATEWAY_CLI=/绝对路径/…/packages/gateway/src/cli.ts",
		);
	}
}

export function resolveRemoteHome() {
	const fromEnv = process.env.DSH_REMOTE_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
	const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ".";
	return join(userProfile, ".dsh-remote");
}

function configPath(home) {
	return join(home, "config.json");
}

/**
 * 读磁盘上正在生效的 frpc.toml（插件设置页并不编辑这份文件）。
 * 解析失败或文件不存在时返回 null。
 */
export function readTunnelSnapshot(home) {
	try {
		const tomlPath = join(home, "frp", "frpc.toml");
		const toml = readFileSync(tomlPath, "utf8");
		const proxies = [];
		for (const block of toml.split("[[proxies]]").slice(1)) {
			const name = /(?:^|\n)\s*name\s*=\s*"([^"]+)"/.exec(block)?.[1];
			const type = /(?:^|\n)\s*type\s*=\s*"([^"]+)"/.exec(block)?.[1];
			if (name !== undefined && type !== undefined) proxies.push({ name, type });
		}
		const serverAddr = /(?:^|\n)\s*serverAddr\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? "";
		const portMatch = /(?:^|\n)\s*serverPort\s*=\s*(\d+)/.exec(toml);
		const serverPort = portMatch === null ? 0 : Number(portMatch[1]);
		return {
			tomlPath,
			serverAddr,
			serverPort,
			proxies,
			dualProxy: proxies.some((proxy) => proxy.type === "xtcp") && proxies.some((proxy) => proxy.type === "stcp"),
		};
	} catch {
		return null;
	}
}

function requestAdmin(port, path, method = "GET") {
	return new Promise((resolveRequest) => {
		const request = https.request(
			{ host: "127.0.0.1", port, path, method, rejectUnauthorized: false, timeout: 4000 },
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => resolveRequest({
					status: response.statusCode,
					body: Buffer.concat(chunks).toString("utf8"),
				}));
			},
		);
		request.on("timeout", () => {
			request.destroy();
			resolveRequest(undefined);
		});
		request.on("error", () => resolveRequest(undefined));
		request.end();
	});
}

function killProcessTree(proc) {
	if (proc === null || proc === undefined) return;
	const pid = proc.pid;
	if (process.platform === "win32" && typeof pid === "number") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	if (proc.exitCode === null) proc.kill("SIGTERM");
}

function readConfigFile(home) {
	try {
		return JSON.parse(readFileSync(configPath(home), "utf8"));
	} catch {
		return {};
	}
}

function readAutoStartFlag(home) {
	return readConfigFile(home).autoStart !== false;
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

// ============================================================================
// 路由处理器工厂：依赖注入便于单测（真实接线见 apply）。
// ============================================================================

/**
 * @param deps {{
 *   home: string,
 *   log: (line: string) => void,
 *   readConfig: () => object,
 *   writeConfig: (next: object) => Promise<void> | void,
 *   readSecrets?: () => object,
 *   writeSecrets?: (next: object) => Promise<void> | void,
 *   restartGateway: () => void,
 *   adminRequest: (path: string, method?: string) => Promise<{ status: number, body: string } | undefined>,
 * }}
 */
export function createRouteHandlers(deps) {
	const readSecrets = typeof deps.readSecrets === "function" ? deps.readSecrets : () => ({});
	const writeSecrets = typeof deps.writeSecrets === "function" ? deps.writeSecrets : async () => {};
	function sendJson(res, payload, status = 200) {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(payload));
	}

	async function readBody(req, limit = 32 * 1024) {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit) throw new Error("body too large");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	return {
		/** GET /dsh-remote/config —— 当前配置 + 展示默认值 + 密钥（供面板填写，与 Android 对齐）。 */
		async handleConfigGet(req, res) {
			const current = deps.readConfig();
			const secretsFile = readSecrets() ?? {};
			sendJson(res, {
				config: current,
				defaults: DISPLAY_DEFAULTS,
				secrets: {
					authToken: typeof secretsFile.frpAuthToken === "string" ? secretsFile.frpAuthToken : "",
					visitorKey: typeof secretsFile.frpVisitorKey === "string" ? secretsFile.frpVisitorKey : "",
				},
			});
		},

		/** POST /dsh-remote/config —— 校验 → 合并写盘 → 重启网关。 */
		async handleConfigPost(req, res) {
			let payload;
			try {
				payload = JSON.parse(await readBody(req));
			} catch (error) {
				sendJson(res, { ok: false, errors: [`请求体不是合法 JSON：${String(error.message ?? error)}`] }, 400);
				return;
			}
			const verdict = validateConfigPatch(payload);
			if (!verdict.ok) {
				sendJson(res, { ok: false, errors: verdict.errors }, 400);
				return;
			}
			const next = mergeConfigFile(deps.readConfig(), verdict.patch);
			await deps.writeConfig(next);
			const secretsPatch = {};
			if (typeof verdict.secrets?.authToken === "string") secretsPatch.frpAuthToken = verdict.secrets.authToken;
			if (typeof verdict.secrets?.visitorKey === "string") secretsPatch.frpVisitorKey = verdict.secrets.visitorKey;
			if (Object.keys(secretsPatch).length > 0) {
				const currentSecrets = readSecrets() ?? {};
				await writeSecrets({
					frpAuthToken: secretsPatch.frpAuthToken ?? currentSecrets.frpAuthToken ?? "",
					frpVisitorKey: secretsPatch.frpVisitorKey ?? currentSecrets.frpVisitorKey ?? "",
				});
			}
			deps.log("配置已更新，正在重启网关…");
			deps.restartGateway();
			sendJson(res, { ok: true, config: next });
		},

		/** GET /dsh-remote/status —— 聚合网关管理端点 + 本地配置。网关不在线时降级。 */
		async handleStatusGet(req, res) {
			const config = deps.readConfig();
			const listenPort = Number.isInteger(config.listenPort) ? config.listenPort : DISPLAY_DEFAULTS.listenPort;
			const [status, devices] = await Promise.all([
				deps.adminRequest("/__dsh_remote__/admin/status"),
				deps.adminRequest("/__dsh_remote__/admin/devices"),
			]);
			const parseSafe = (response) => {
				if (response === undefined || response.status !== 200) return undefined;
				try {
					return JSON.parse(response.body);
				} catch {
					return undefined;
				}
			};
			const gatewayStatus = parseSafe(status);
			const deviceList = parseSafe(devices);
			sendJson(res, {
				gatewayRunning: gatewayStatus !== undefined,
				config,
				gateway: gatewayStatus ?? null,
				deviceCount: Array.isArray(deviceList?.devices)
					? deviceList.devices.filter((device) => !device.revokedAt).length
					: null,
				listenPort,
				tunnel: readTunnelSnapshot(deps.home),
			});
		},

		/** POST /dsh-remote/restart —— 手动重启网关。 */
		async handleRestartPost(req, res) {
			deps.log("收到手动重启请求");
			deps.restartGateway();
			sendJson(res, { ok: true });
		},

		/** POST /dsh-remote/pair-code —— 转发网关管理端点生成一次性配对码。 */
		async handlePairCodePost(req, res) {
			const response = await deps.adminRequest("/__dsh_remote__/admin/pair-code", "POST");
			if (response === undefined || response.status !== 200) {
				sendJson(res, { ok: false, error: "网关未运行或不可达，无法生成配对码" }, 502);
				return;
			}
			try {
				sendJson(res, { ok: true, ...JSON.parse(response.body) });
			} catch {
				sendJson(res, { ok: false, error: "网关响应异常" }, 502);
			}
		},
	};
}

// ============================================================================
// 插件对象
// ============================================================================

var plugin_default = {
	name: "dsh-remote-plugin",
	inject: ["webServer", "settings"],
	apply(ctx) {
		const home = resolveRemoteHome();

		// ── 网关子进程控制（可重启） ────────────────────────────────
		let child = null;
		let disposed = false;
		let restartTimer = null;
		let plannedStop = false;

		const spawnGateway = () => {
			if (disposed) return;
			if (child !== null && child.exitCode === null) {
				console.log(`${TAG} 网关子进程已在运行，跳过重复拉起`);
				return;
			}
			let cliPath;
			try {
				cliPath = locateGatewayCli();
			} catch (error) {
				console.warn(`${TAG} 未找到网关入口，跳过自动拉起。${String(error.message ?? error)}`);
				return;
			}
			plannedStop = false;
			let proc;
			try {
				proc = spawn(process.execPath, [cliPath, "start"], {
					env: { ...process.env, DSH_REMOTE_HOME: home },
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				// spawn 同步失败（如权限/沙箱限制）：不拖垮宿主，记录后放弃本轮拉起
				console.warn(`${TAG} 拉起网关子进程失败：${String(error.message ?? error)}`);
				return;
			}
			child = proc;
			const forward = (chunk) => {
				for (const line of chunk.toString("utf8").split("\n")) {
					const trimmed = line.trimEnd();
					if (trimmed.length === 0) continue;
					console.log(trimmed.startsWith("[dsh-remote]") ? trimmed : `${TAG} ${trimmed}`);
				}
			};
			proc.stdout?.on("data", forward);
			proc.stderr?.on("data", forward);
			proc.on("error", (error) => {
				// spawn 异步失败（如入口不可执行）：清掉子进程引用，避免未处理错误
				console.warn(`${TAG} 网关子进程错误：${String(error.message ?? error)}`);
				if (child === proc) child = null;
			});
			proc.on("exit", (code, signal) => {
				if (child === proc) child = null;
				if (disposed || plannedStop) return;
				if (child !== null && child !== proc) return;
				console.warn(`${TAG} 网关退出（code=${String(code)} signal=${String(signal)}），3s 后重启`);
				restartTimer = setTimeout(spawnGateway, 3_000);
			});
		};

		const killChild = () => {
			plannedStop = true;
			if (restartTimer !== null) {
				clearTimeout(restartTimer);
				restartTimer = null;
			}
			const proc = child;
			child = null;
			killProcessTree(proc);
		};

		const restartGateway = () => {
			killChild();
			restartTimer = setTimeout(() => {
				void (async () => {
					const cfg = readConfigFile(home);
					const listenPort = Number.isInteger(cfg.listenPort) ? cfg.listenPort : 18443;
					if (await isPortBound("127.0.0.1", listenPort)) {
						console.log(`${TAG} 端口 ${String(listenPort)} 仍被占用，请求已有网关退出后重拉`);
						await requestAdmin(listenPort, "/__dsh_remote__/admin/shutdown", "POST");
						for (let i = 0; i < 25; i += 1) {
							if (!(await isPortBound("127.0.0.1", listenPort))) break;
							await new Promise((resolveWait) => setTimeout(resolveWait, 200));
						}
					}
					if (disposed) return;
					spawnGateway();
				})();
			}, 400);
		};

		ctx.effect(() => {
			void (async () => {
				if (!readAutoStartFlag(home)) {
					console.log(`${TAG} config.autoStart=false，跳过自动拉起`);
					return;
				}
				const firstConfig = readConfigFile(home);
				const listenPort = Number.isInteger(firstConfig.listenPort) ? firstConfig.listenPort : 18443;
				if (await isPortBound("127.0.0.1", listenPort)) {
					console.log(`${TAG} 端口 ${String(listenPort)} 已有网关在监听，不重复拉起`);
					return;
				}
				spawnGateway();
			})();
			return () => {
				disposed = true;
				if (restartTimer !== null) clearTimeout(restartTimer);
				killChild();
			};
		}, "dsh-remote: gateway lifecycle");

		// ── 设置页路由（webServer 存在时才注册） ────────────────────
		// PLG-01：webServer 缺失或路由注册失败通常意味着安装链接断裂/宿主升级
		// 重置了 profile，日志提示运行 install.mjs --repair 体检。
		const REPAIR_HINT = "可运行 node packages/plugin/scripts/install.mjs --repair 体检并修复安装（patch 行 / node_modules 链接）";
		const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
		if (webServer !== undefined && typeof webServer.register === "function") {
			const handlers = createRouteHandlers({
				home,
				log: (line) => console.log(`${TAG} ${line}`),
				readConfig: () => readConfigFile(home),
				writeConfig: async (next) => {
					const { writeFile, rename, mkdir } = await import("node:fs/promises");
					const target = configPath(home);
					await mkdir(dirname(target), { recursive: true });
					const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
					await writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
					await rename(tmp, target);
				},
				readSecrets: () => {
					try {
						return JSON.parse(readFileSync(join(home, "state", "secrets.json"), "utf8"));
					} catch {
						return {};
					}
				},
				writeSecrets: async (next) => {
					const { writeFile, rename, mkdir } = await import("node:fs/promises");
					const target = join(home, "state", "secrets.json");
					await mkdir(dirname(target), { recursive: true });
					const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
					await writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
					await rename(tmp, target);
				},
				restartGateway,
				adminRequest: async (path, method = "GET") => {
					const cfg = readConfigFile(home);
					const port = Number.isInteger(cfg.listenPort) ? cfg.listenPort : 18443;
					return await requestAdmin(port, path, method);
				},
			});

			const registerRoute = (path, handler, label) => {
				try {
					ctx.effect(() => webServer.register({
						kind: "exact",
						path,
						handler: (req, res) => {
							// 同源闸门：拒绝来自非本机页面的跨站请求（含远程经代理的伪造 Origin）
							const origin = req.headers.origin;
							if (origin !== undefined) {
								try {
									const parsed = new URL(origin);
									const host = parsed.hostname;
									if (!(host === "127.0.0.1" || host === "localhost" || host === "[::1]")) {
										res.writeHead(403).end();
										return;
									}
								} catch {
									res.writeHead(403).end();
									return;
								}
							}
							void handler(req, res).catch((error) => {
								console.error(`${TAG} ${label} 失败`, error);
								if (!res.headersSent) sendJsonSafe(res, { ok: false, error: String(error.message ?? error) }, 500);
							});
						},
					}), label);
				} catch (error) {
					console.error(`${TAG} 路由注册失败 ${path}`, error);
					console.warn(`${TAG} ${REPAIR_HINT}`);
				}
			};

			registerRoute("/dsh-remote/config", (req, res) => {
				if (req.method === "POST") return handlers.handleConfigPost(req, res);
				return handlers.handleConfigGet(req, res);
			}, "dsh-remote: config route");
			registerRoute("/dsh-remote/status", handlers.handleStatusGet, "dsh-remote: status route");
			registerRoute("/dsh-remote/restart", handlers.handleRestartPost, "dsh-remote: restart route");
			registerRoute("/dsh-remote/pair-code", handlers.handlePairCodePost, "dsh-remote: pair-code route");
		} else {
			console.warn(`${TAG} 未检测到宿主 webServer 服务，设置页路由未注册。${REPAIR_HINT}`);
		}

		// ── 设置命名空间（settings 服务存在时才注册） ────────────────
		const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
		if (settings !== undefined && typeof settings.register === "function") {
			try {
				settings.register("dsh-remote", buildSettingsSchema(), { applies: "live" });
			} catch (error) {
				console.error(`${TAG} settings.register 失败`, error);
			}
		}
	},
};

function sendJsonSafe(res, payload, status) {
	try {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	} catch {}
}

/**
 * settings.register 需要的可调用 schema（parse + toJSON + ~standard）。
 *
 * PLG-02：字段与真实 GatewayConfig 的面板可编辑项对齐（参照
 * src/client/index.tsx 表单）：autoStart / listenHost / upstreamPort /
 * autoFixUpstreamPort / frp.{enabled,serverAddr,serverPort,mode,name}。
 * 历史残留的 frpEnabled/serverAddr 扁平字段不再存在，但输入里出现时做
 * 向后兼容归一化到 frp.*。校验与 config-schema.js 的 validateConfigPatch
 * 共用单一真相源（该文件与网关 config.ts/frp.ts 规则同步，见其头注）。
 * 协议结构（可调用 parse / ~standard.validate / toJSON）为宿主 dsh-settings
 * 的硬依赖，不得改动。
 */
function buildSettingsSchema() {
	const defaults = DISPLAY_DEFAULTS;
	const parse = (input) => {
		const raw = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
		// 向后兼容：旧版扁平字段归一化进 frp.*（仅在未提供新结构时生效）
		const normalized = { ...raw };
		if (normalized.frp === undefined && (normalized.frpEnabled !== undefined || normalized.serverAddr !== undefined)) {
			normalized.frp = {};
			if (typeof normalized.frpEnabled === "boolean") normalized.frp.enabled = normalized.frpEnabled;
			if (typeof normalized.serverAddr === "string") normalized.frp.serverAddr = normalized.serverAddr;
		}
		delete normalized.frpEnabled;
		delete normalized.serverAddr;
		// 密钥（authToken/visitorKey）存 state/secrets.json，不进设置命名空间
		delete normalized.authToken;
		delete normalized.visitorKey;
		// 单一真相源校验；非法输入不抛错，逐字段回落面板默认值
		const verdict = validateConfigPatch(normalized);
		const patch = verdict.ok ? verdict.patch : {};
		const frpPatch = patch.frp ?? {};
		return {
			autoStart: typeof patch.autoStart === "boolean" ? patch.autoStart : defaults.autoStart,
			listenHost: typeof patch.listenHost === "string" ? patch.listenHost : defaults.listenHost,
			upstreamPort: Number.isInteger(patch.upstreamPort) ? patch.upstreamPort : defaults.upstreamPort,
			autoFixUpstreamPort: typeof patch.autoFixUpstreamPort === "boolean"
				? patch.autoFixUpstreamPort
				: defaults.autoFixUpstreamPort,
			frp: {
				enabled: typeof frpPatch.enabled === "boolean" ? frpPatch.enabled : defaults.frp.enabled,
				serverAddr: typeof frpPatch.serverAddr === "string" ? frpPatch.serverAddr : "",
				serverPort: Number.isInteger(frpPatch.serverPort) ? frpPatch.serverPort : defaults.frp.serverPort,
				mode: typeof frpPatch.mode === "string" ? frpPatch.mode : defaults.frp.mode,
				name: typeof frpPatch.name === "string" ? frpPatch.name : defaults.frp.name,
			},
		};
	};
	return Object.assign(parse, {
		"~standard": {
			version: 1,
			vendor: "dsh-remote",
			validate(value) {
				return { value: parse(value) };
			},
		},
		toJSON: () => ({
			type: "object",
			properties: {
				autoStart: { type: "boolean", default: defaults.autoStart, title: "DSH 启动时自动拉起网关" },
				listenHost: {
					type: "string",
					enum: ["127.0.0.1", "0.0.0.0", "::1"],
					default: defaults.listenHost,
					title: "网关监听地址",
				},
				upstreamPort: { type: "integer", minimum: 1, maximum: 65535, default: defaults.upstreamPort, title: "上游 DSH 端口" },
				autoFixUpstreamPort: { type: "boolean", default: defaults.autoFixUpstreamPort, title: "上游端口失配时自动探测回写" },
				frp: {
					type: "object",
					title: "frp 隧道",
					properties: {
						enabled: { type: "boolean", default: defaults.frp.enabled, title: "启用 frp 隧道" },
						serverAddr: { type: "string", default: "", title: "VPS 地址" },
						serverPort: { type: "integer", minimum: 1, maximum: 65535, default: defaults.frp.serverPort, title: "控制端口" },
						mode: { type: "string", enum: ["entry", "stcp", "xtcp"], default: defaults.frp.mode, title: "隧道形态" },
						name: { type: "string", default: defaults.frp.name, title: "隧道名" },
					},
				},
			},
		}),
	});
}

export { plugin_default as default };
