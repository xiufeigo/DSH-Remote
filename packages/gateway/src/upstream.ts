/**
 * 上游 DSH GUI 端口解析。
 *
 * 桌面端每次启动可能拿到不同的 OS 分配端口，且 Web 服务由 payload 的
 * node.exe 子进程承载（不是 dsh-gui.exe 本体）。策略：
 *   1. 先试配置的 upstreamPort（指纹匹配即用）；
 *   2. 失配则枚举全部回环监听端口，DSH 相关进程（路径含 DSH Desktop 或
 *      名为 dsh-gui）优先、其余并发指纹探测兜底；
 *   3. 命中后由调用方决定是否回写配置。
 *
 * 监听枚举：Windows 走 PowerShell（含 DSH 进程标注）；POSIX 走
 * ss/netstat/lsof 兜底（P3-8，此前仅 Windows 可用导致 macOS/Linux 端口
 * 漂移跟随静默失效），进程标注缺省（仅影响探测顺序，不影响正确性）。
 *
 * 指纹判据：GET / 返回 200 且 HTML 含 __DSH_BOOT__ 注入点或 DSH 特征词。
 */

import { execFileSync } from "node:child_process";
import { DSH_UNAUTHORIZED_MARKER } from "./session.ts";

const MARKERS = ["__dsh_boot__", "deepseek harness", ">dsh<", "dsh-client"];
const MAX_PROBES = 96;

export async function hasDshFingerprint(port: number, timeoutMs = 2500): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
			headers: { host: `127.0.0.1:${String(port)}`, accept: "text/html" },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		// DSH 0.1.2-alpha.1 起：未认证的 GET / 直接 401（纯文本），index 不再公开。
		// 该 401 的响应体是 DSH 认证组件的固定文案，足以作为正向指纹 —— 否则
		// 端口自动探测在 0.1.2+ 宿主上会全部失配。
		if (response.status === 401) {
			const text = (await response.text()).slice(0, 4_000).toLowerCase();
			return text.includes(DSH_UNAUTHORIZED_MARKER);
		}
		if (!response.ok) return false;
		const text = (await response.text()).slice(0, 400_000).toLowerCase();
		return MARKERS.some((marker) => text.includes(marker));
	} catch {
		return false;
	}
}

interface ListenerEntry {
	port: number;
	dshRelated: boolean;
}

/** Windows：PowerShell Get-NetTCPConnection 枚举，并按进程路径/名标注 DSH 相关（排序优先探测）。 */
function listLoopbackListenersWindows(): ListenerEntry[] {
	try {
		const stdout = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
				"Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } | " +
				"ForEach-Object { " +
				"  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; " +
				"  if ($null -ne $proc) { " +
				"    $dsh = ($proc.Path -like '*DSH Desktop*') -or ($proc.ProcessName -eq 'dsh-gui'); " +
				"    \"{0}|{1}\" -f $_.LocalPort, $(if($dsh){1}else{0}) " +
				"  } " +
				"} | Sort-Object -Unique",
			],
			{ encoding: "utf8", timeout: 10_000, windowsHide: true },
		);
		const seen = new Set<number>();
		const entries: ListenerEntry[] = [];
		for (const line of stdout.split("\n")) {
			const [portText, flag] = line.trim().split("|");
			const port = Number.parseInt(portText ?? "", 10);
			if (!Number.isInteger(port) || port <= 0 || port >= 65536 || seen.has(port)) continue;
			seen.add(port);
			entries.push({ port, dshRelated: flag === "1" });
		}
		return entries;
	} catch {
		return [];
	}
}

/** POSIX 候选地址形态：仅回环/通配监听参与探测（IPv6 字面量带方括号）。 */
const POSIX_LISTENER_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "*", "::", "[::]"]);

/**
 * 解析 host:port 形态的监听地址列（ss/netstat 的 Local Address、lsof 的 NAME）。
 * 仅接受回环/通配 host；端口越界或格式异常返回 undefined。
 */
function portOfHostPortToken(token: string | undefined): number | undefined {
	if (token === undefined) return undefined;
	const colon = token.lastIndexOf(":");
	if (colon <= 0) return undefined;
	if (!POSIX_LISTENER_HOSTS.has(token.slice(0, colon))) return undefined;
	const port = Number.parseInt(token.slice(colon + 1), 10);
	if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
	return port;
}

export type PosixListenerKind = "ss" | "netstat" | "lsof";

/**
 * P3-8：POSIX 监听枚举的纯解析器（可跨平台单测）。
 * - ss/netstat：第 4 列为 Local Address:Port；
 * - lsof：倒数第 2 列为 NAME（host:port），末列固定 "(LISTEN)"。
 * dshRelated 一律 false —— 进程路径标注是 Windows 独有的排序优化，
 * POSIX 侧全部候选交给指纹探测裁决（错误候选只会探测失败，不会误选）。
 */
export function parsePosixListeners(stdout: string, kind: PosixListenerKind): ListenerEntry[] {
	const seen = new Set<number>();
	const entries: ListenerEntry[] = [];
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const parts = line.split(/\s+/);
		const token = kind === "lsof" ? parts[parts.length - 2] : parts[3];
		const port = portOfHostPortToken(token);
		if (port === undefined || seen.has(port)) continue;
		seen.add(port);
		entries.push({ port, dshRelated: false });
	}
	return entries;
}

/**
 * POSIX 枚举（P3-8）：ss（Linux/iproute2）→ netstat（旧 Linux）→ lsof（macOS）
 * 依次尝试，命令缺失/失败静默跳过（fail-safe 为空表，行为同旧版）。
 */
function listLoopbackListenersPosix(): ListenerEntry[] {
	const attempts: Array<{ cmd: string; args: string[]; kind: PosixListenerKind }> = [
		{ cmd: "ss", args: ["-tlnpH"], kind: "ss" },
		{ cmd: "netstat", args: ["-tlnp"], kind: "netstat" },
		{ cmd: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN"], kind: "lsof" },
	];
	for (const attempt of attempts) {
		let stdout: string;
		try {
			stdout = execFileSync(attempt.cmd, attempt.args, {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			continue; // 命令不存在（ENOENT）或非零退出（如 BSD netstat 不认 -tlnp）
		}
		return parsePosixListeners(stdout, attempt.kind);
	}
	return [];
}

/** 枚举本机全部回环监听端口，标注是否属于 DSH 相关进程（Windows 独有标注）。 */
export function listLoopbackListeners(): ListenerEntry[] {
	return process.platform === "win32" ? listLoopbackListenersWindows() : listLoopbackListenersPosix();
}

export interface UpstreamResolution {
	port: number;
	how: "configured" | "auto-detected";
	candidates?: number[];
}

async function probeFirst(ports: number[]): Promise<number | undefined> {
	const results = await Promise.all(
		ports.map(async (port) => ({ port, ok: await hasDshFingerprint(port) })),
	);
	return results.find((result) => result.ok)?.port;
}

/**
 * 解析当前可用的上游端口。`configured` 失配时自动探测；
 * 全部失败返回 null（保持 configured 以便错误信息可读）。
 */
export async function resolveUpstreamPort(configured: number): Promise<UpstreamResolution | null> {
	if (await hasDshFingerprint(configured)) return { port: configured, how: "configured" };

	const listeners = listLoopbackListeners().filter((entry) => entry.port !== configured);
	const dshFirst = listeners.filter((entry) => entry.dshRelated).map((entry) => entry.port);
	const others = listeners.filter((entry) => !entry.dshRelated).map((entry) => entry.port).slice(0, MAX_PROBES);

	// DSH 相关进程优先
	const dshHit = await probeFirst(dshFirst);
	if (dshHit !== undefined) {
		return { port: dshHit, how: "auto-detected", candidates: [...dshFirst, ...others] };
	}
	// 其余回环监听者并发兜底
	const otherHit = await probeFirst(others);
	if (otherHit !== undefined) {
		return { port: otherHit, how: "auto-detected", candidates: [...dshFirst, ...others] };
	}
	return null;
}
