#!/usr/bin/env node
/**
 * dsh-remote 命令行入口。
 *
 *   dsh-remote start              启动网关守护进程（含 frpc 托管）
 *   dsh-remote pair [--name X]    生成一次性配对码并在终端渲染二维码
 *   dsh-remote devices            列出已配对设备
 *   dsh-remote revoke <deviceId>  吊销设备
 *   dsh-remote status             查看网关/上游/frp 状态
 *   dsh-remote doctor             体检：证书/端口/上游指纹/frp 配置
 */

import { connect } from "node:net";
import process from "node:process";
import { GatewayServer } from "./server.ts";
import { Store } from "./store.ts";
import type { GatewayConfig } from "./config.ts";

interface CliArgs {
	command: string;
	flags: Map<string, string | boolean>;
	rest: string[];
}

function parseArgs(argv: string[]): CliArgs {
	const [command = "help", ...tokens] = argv;
	const flags = new Map<string, string | boolean>();
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(key, next);
				i += 1;
			} else {
				flags.set(key, true);
			}
		} else {
			rest.push(token);
		}
	}
	return { command, flags, rest };
}

const USAGE = `dsh-remote —— DSH Desktop 远程控制网关

用法：
  dsh-remote start                启动网关（前台运行；Ctrl-C 退出）
  dsh-remote pair [--name 名称]   生成一次性配对码 + 二维码
  dsh-remote devices              列出已配对设备
  dsh-remote revoke <设备ID>      吊销设备
  dsh-remote status               网关 / 上游 / frp 状态
  dsh-remote doctor               全面体检

环境变量：
  DSH_REMOTE_HOME                 数据目录（默认 ~/.dsh-remote）`;

async function main(): Promise<number> {
	const { command, flags, rest } = parseArgs(process.argv.slice(2));
	const store = await Store.open(typeof flags.get("home") === "string" ? String(flags.get("home")) : undefined);

	switch (command) {
		case "start":
			return cmdStart(store, flags);
		case "pair":
			return await cmdPair(store, flags);
		case "devices":
			return await cmdDevices(store);
		case "revoke": {
			const id = rest[0];
			if (id === undefined) {
				console.error("用法：dsh-remote revoke <设备ID>（先 devices 查看）");
				return 1;
			}
			const ok = await store.revokeDevice(id);
			console.log(ok ? `已吊销 ${id}` : `未找到在用设备 ${id}`);
			return ok ? 0 : 1;
		}
		case "status":
			return await cmdStatus(store);
		case "doctor":
			return await cmdDoctor(store);
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		default:
			console.error(`未知命令：${command}\n`);
			console.log(USAGE);
			return 1;
	}
}

// ---------- start ----------

async function cmdStart(store: Store, flags: Map<string, string | boolean>): Promise<number> {
	if (flags.get("daemon") === true) {
		console.error("后台化请交给 cordis 插件或系统服务管理；本命令保持前台。");
		return 1;
	}
	const config = await store.loadConfig();
	const server = new GatewayServer({
		store,
		config,
		log: (line) => console.log(`[dsh-remote] ${line}`),
	});

	process.on("SIGINT", () => {
		void (async () => {
			await server.stop();
			process.exit(0);
		})();
	});
	await server.start();

	const entry = entryUrl(config, server.actualPort ?? config.listenPort);
	console.log(`[dsh-remote] 入口地址：${entry}`);
	console.log(`[dsh-remote] 上游：http://127.0.0.1:${String(config.upstreamPort)}（DSH Web GUI）`);
	if (!config.frp.enabled) console.log("[dsh-remote] 提示：config.json 里 frp.enabled=true 后将自动托管 frpc");

	// 守护模式：挂住事件循环直到收到信号（server 句柄本身不会让 main 结束，
	// 必须显式永不 resolve，否则上方的 process.exit 会立即杀掉网关）
	await new Promise<never>(() => {});
	return 0;
}

// ---------- pair ----------

async function cmdPair(store: Store, flags: Map<string, string | boolean>): Promise<number> {
	const config = await store.loadConfig();
	const { generatePairingCode } = await import("./auth.ts");
	const code = generatePairingCode();
	const pending = await store.putPendingCode(code, config.pairingCodeMinutes);

	const name = typeof flags.get("name") === "string" ? String(flags.get("name")) : "";
	const publicEntry = config.frp.enabled && typeof config.frp.serverAddr === "string"
		? entryUrl(config, config.frp.remotePort)
		: undefined;

	console.log(`配对码：${code}（${config.pairingCodeMinutes} 分钟内有效，仅可用一次）`);
	console.log(`手机访问：${publicEntry ?? entryUrl(config, config.listenPort)}`);
	if (publicEntry !== undefined) console.log("(frp 已启用，使用公网入口；局域网内也可用 https://127.0.0.1:" + String(config.listenPort) + " 调试)");
	try {
		const QRCode = (await import("qrcode")).default;
		const qr = await QRCode.toString(publicEntry ?? entryUrl(config, config.listenPort), { type: "terminal", small: true });
		console.log(qr);
	} catch {
		console.log("(二维码渲染失败，手动输入上方地址即可)");
	}
	console.log(`备注：${name || "(无)"}`);
	await store.audit("pair_code_created", { note: name });
	return 0;
}

// ---------- devices ----------

async function cmdDevices(store: Store): Promise<number> {
	const devices = await store.listDevices();
	const active = devices.filter((device) => device.revokedAt === undefined);
	if (active.length === 0) {
		console.log("尚无已配对设备（dsh-remote pair 开始配对）");
		return 0;
	}
	for (const device of active) {
		console.log(`${device.id}  ${device.name.padEnd(20)}  配对于 ${device.createdAt}  最近活跃 ${device.lastSeenAt}`);
	}
	return 0;
}

// ---------- status ----------

async function cmdStatus(store: Store): Promise<number> {
	const config = await store.loadConfig();
	console.log(`数据目录      ${store.home}`);
	console.log(`网关监听      ${config.listenHost}:${String(config.listenPort)} ${await probeTcp(config.listenHost, config.listenPort) ? "[监听中]" : "[未运行]"}`);
	console.log(`上游 DSH      127.0.0.1:${String(config.upstreamPort)} ${await probeTcp("127.0.0.1", config.upstreamPort) ? "[可达]" : "[不可达]"}`);
	if (config.frp.enabled) {
		const binary = await import("./frp.ts").then((mod) => mod.locateFrpcBinary(config.frp, store));
		console.log(`frp           ${config.frp.serverAddr ?? "?"}:${String(config.frp.serverPort)} → 本机:${String(config.frp.remotePort)} ${binary === undefined ? "[缺 frpc 二进制]" : "[frpc 就绪]"}`);
		console.log(`公网入口      https://${config.frp.serverAddr ?? "?"}:${String(config.frp.remotePort)}`);
	} else {
		console.log("frp           未启用（config.json → frp.enabled）");
	}
	const devices = (await store.listDevices()).filter((device) => device.revokedAt === undefined);
	console.log(`已配对设备    ${devices.length}`);
	return 0;
}

// ---------- doctor ----------

async function cmdDoctor(store: Store): Promise<number> {
	const config = await store.loadConfig();
	const { hasDshFingerprint, listLoopbackListeners, resolveUpstreamPort } = await import("./upstream.ts");
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

	const upstreamOk = await hasDshFingerprint(config.upstreamPort);
	checks.push({
		name: `上游 DSH GUI 127.0.0.1:${String(config.upstreamPort)}`,
		ok: upstreamOk,
		detail: upstreamOk
			? "端口可达且指纹匹配"
			: `失配。回环监听候选：[${listLoopbackListeners().slice(0, 12).map((entry) => String(entry.port)).join(", ") || "未探测到"}]…` +
				"；启动网关会自动跟随（autoFixUpstreamPort）",
	});
	if (upstreamOk) {
		checks.push({ name: "上游指纹", ok: true, detail: "确认是 DSH Web 界面" });
	} else {
		const resolution = await resolveUpstreamPort(config.upstreamPort);
		checks.push({
			name: "上游自动纠正",
			ok: resolution !== null,
			detail: resolution === null
				? "候选端口全部失配——DSH 是否在运行？"
				: `探测到真实端口 ${String(resolution.port)}，下次 start 自动切换`,
		});
	}

	const listenLoopback = config.listenHost === "127.0.0.1" || config.listenHost === "::1";
	checks.push({
		name: "网关监听面",
		ok: true,
		detail: listenLoopback
			? `${config.listenHost}:${String(config.listenPort)}（仅本机，最安全）`
			: `${config.listenHost}:${String(config.listenPort)} —— 局域网模式：家庭网络内设备可直接访问，` +
				"请确认网络可信或配置防火墙限制来源",
	});

	const listenBusy = await probeTcp(config.listenHost, config.listenPort);
	checks.push({
		name: `网关端口 ${config.listenHost}:${String(config.listenPort)}`,
		ok: true,
		detail: listenBusy ? "已被占用（网关可能正在运行）" : "空闲",
	});

	const certsOk = await import("./cert.ts")
		.then(async (mod) => {
			try {
				const cert = await mod.ensureCert(store.path("certs"));
				return cert.fingerprintSha256;
			} catch {
				return undefined;
			}
		});
	checks.push({
		name: "TLS 证书",
		ok: typeof certsOk === "string",
		detail: typeof certsOk === "string" ? `SHA-256 ${certsOk.slice(0, 16)}…` : "生成失败",
	});

	if (config.frp.enabled) {
		checks.push({
			name: "frp serverAddr",
			ok: typeof config.frp.serverAddr === "string",
			detail: typeof config.frp.serverAddr === "string" ? config.frp.serverAddr : "未配置",
		});
		if (typeof config.frp.serverAddr === "string") {
			const controlOk = await probeTcp(config.frp.serverAddr, config.frp.serverPort);
			checks.push({ name: `frps 控制端口 ${String(config.frp.serverPort)}`, ok: controlOk, detail: controlOk ? "可达" : "不可达（检查 VPS 防火墙/frps 是否运行）" });
			const entryOk = await probeTcp(config.frp.serverAddr, config.frp.remotePort);
			checks.push({ name: `公网入口端口 ${String(config.frp.remotePort)}`, ok: true, detail: entryOk ? "开放" : "未开放（网关+frpc 未连上时属正常）" });
		}
		const binary = await import("./frp.ts").then((mod) => mod.locateFrpcBinary(config.frp, store));
		checks.push({ name: "frpc 二进制", ok: binary !== undefined, detail: binary ?? `缺失，放到 ${store.path("vendor", "frp")} 下` });
	}

	let failed = 0;
	for (const check of checks) {
		if (!check.ok) failed += 1;
		console.log(`${check.ok ? "✓" : "✗"} ${check.name} —— ${check.detail}`);
	}
	console.log(failed === 0 ? "\n体检通过 ✅" : `\n${failed} 项未过 ❌`);
	return failed === 0 ? 0 : 1;
}

// ---------- 工具 ----------

function entryUrl(config: GatewayConfig, port: number): string {
	return `https://${typeof config.frp.serverAddr === "string" && config.frp.enabled ? config.frp.serverAddr : config.listenHost}:${String(port)}/`;
}

function probeTcp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(`dsh-remote: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
