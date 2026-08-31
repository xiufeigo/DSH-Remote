/**
 * 配置加载与默认值。
 *
 * 配置文件：`<home>/config.json`（home 默认 `~/.dsh-remote`，可用 `DSH_REMOTE_HOME` 覆盖，
 * 便于测试隔离）。文件里只需要写与默认值不同的键。
 */

/**
 * frp 隧道形态。
 *
 * - `entry`：经典形态。VPS 开一个公网入口端口（remotePort），任何人都能扫到该端口，
 *   安全完全依赖网关的认证门；
 * - `stcp`：秘密 TCP。VPS **不开任何入口端口**，只有持有 secretKey 的 frpc visitor
 *   才能建立连接，流量仍经 VPS 加密中转；
 * - `xtcp`：点对点。在 stcp 的基础上先尝试 P2P 打洞，成功后数据不经过 VPS；
 *   打洞失败时 frpc 自动回退为 stcp 中转，不会断连。
 */
export type FrpMode = "entry" | "stcp" | "xtcp";

/**
 * edge 部署的 frp 角色（仅 role="edge" 时生效；desktop 的旧语义走 enabled+mode）。
 *
 * - `off`：不起任何 frp 进程，上游直连 upstreamHost:upstreamPort；
 * - `visitor`：容器内起 frpc **visitor** 连到已有 frps（serverAddr 指向那台 frps），
 *   上游生效地址变为 127.0.0.1:<visitorBindPort>；
 * - `frps`：容器内起 **frps**（bindPort=serverPort）供家里 PC 的 frpc 注册，
 *   并自动再起一个连回自身的内部 visitor 消费隧道——全链路自包含在一台 VPS。
 */
export type EdgeFrpRole = "off" | "visitor" | "frps";

export interface FrpConfig {
	/** 是否启用 frp 传输适配器 */
	enabled: boolean;
	/** frpc 可执行文件路径；缺省在 <home>/vendor/frp/ 下寻找 */
	binaryPath?: string;
	/** VPS 公网地址 */
	serverAddr?: string;
	/** frps 控制端口（bindPort） */
	serverPort: number;
	/** frpc↔frps 共享密钥；缺省自动生成并持久化 */
	authToken?: string;
	/** 隧道形态；文件缺省为 entry。插件设置页保存时写 xtcp（访客密钥连入）。 */
	mode?: FrpMode;
	/** VPS 对外入口端口，仅 mode=entry 时使用；手机访问 https://<vps>:<该端口> */
	remotePort: number;
	/** 访客密钥（mode=stcp/xtcp）：proxy 与 visitor 必须一致；缺省自动生成并持久化 */
	secretKey?: string;
	/**
	 * 写进 frps 的 proxy 名。多人共用一台 VPS 时必须互不相同，否则后连上的会把先连上的挤掉。
	 * 缺省 `dsh-remote`；手机 App / visitor 二维码必须填同一名字。
	 */
	name?: string;
	/** edge 角色（role="edge" 时生效）：off / visitor / frps；缺省 off。 */
	edge?: EdgeFrpRole;
	/** visitor 在本机的绑定端口（edge=visitor/frps 时上游生效地址指向它）；缺省 18443。 */
	visitorBindPort?: number;
	/**
	 * edge=frps 时如何消费隧道：
	 * - `stcp`（缺省，推荐）：内部起 stcp visitor 回环连自身 frps —— PC 端用 stcp 形态注册；
	 * - `entry-port`：PC 端用 entry 形态把 remotePort 绑到本机，网关直连 127.0.0.1:<remotePort>。
	 */
	edgeConsume?: "stcp" | "entry-port";
	/** frps 的 allowPorts（仅 edge=frps 生成 frps.toml 时写入），如 [{start:18400,end:18500}]。 */
	allowPorts?: Array<{ start: number; end: number }>;
}

/** 前置 Token 门禁配置（edge 公网入口）。 */
export interface AuthConfig {
	/** 访问 Token 的 SHA-256（hex）；配置后未认证请求一律先进登录页。 */
	accessTokenHash?: string;
	/** Token 登录成功后签发的设备 Cookie 有效期（天）；缺省 30。 */
	tokenLoginDays?: number;
	/**
	 * 是否信任来自私有地址的 X-Forwarded-For 作为限流键（前面有可信反代时开启）。
	 * 缺省 false：全局限流桶（单人使用足够）。
	 */
	trustProxyXff?: boolean;
	/**
	 * GW-03 补全：受信代理网段列表（CIDR 格式，如 `["172.16.0.0/12", "10.0.0.0/8"]`）。
	 * 当 trustProxyXff=true 时，除回环地址外，来源 IP 命中此列表的请求也会采信 XFF。
	 * 用于 docker-compose 桥接拓扑（caddy→gateway 走容器 IP 而非回环）。
	 * 缺省空数组：仅回环可采信（与未配置前行为一致）。
	 * 环境变量：DSHR_TRUST_PROXY_CIDRS（逗号分隔，如 "172.16.0.0/12,10.0.0.0/8"）。
	 */
	trustProxyCidrs?: string[];
}

/** 移动 hook 注入（edge 角色默认开启：窄视口套移动布局、宽视口走官方桌面布局）。 */
export interface MobileConfig {
	enabled?: boolean;
	/** 激活断点（px）：视口 ≤ 该值注入并启用 hook；缺省 980。 */
	breakpointPx?: number;
}

/** 手工提供 TLS 证书（不配则自签；Caddy 反代场景保持缺省即可）。 */
export interface TlsConfig {
	certPath?: string;
	keyPath?: string;
}

export interface GatewayConfig {
	/**
	 * 部署角色：
	 * - `desktop`（缺省）：跑在 PC 上、紧挨 DSH，行为与历史版本完全一致；
	 * - `edge`：跑在公网服务器（Docker/裸机），上游是 frp 隧道对端的 PC 网关，
	 *   强制认证门 + 移动 hook 注入，不做本机端口探测。
	 */
	role?: "desktop" | "edge";
	/** 网关 HTTPS 监听地址；默认仅回环 —— frpc 从本机连入，LAN/WAN 不可见 */
	listenHost: string;
	listenPort: number;
	/** 上游 DSH Web GUI 端口（127.0.0.1） */
	upstreamPort: number;
	/** 上游主机名；desktop 恒为回环，edge 可指向隧道本地绑定口所在主机（一般仍是 127.0.0.1） */
	upstreamHost?: string;
	/**
	 * 上游是否为 HTTPS。desktop 恒否；edge 走隧道时对端是 PC 网关（自签 HTTPS），
	 * 未显式配置时按此推断为 true，直连形态缺省 false。
	 */
	upstreamTls?: boolean;
	/** 上游端口失配时是否自动探测并回写配置 */
	autoFixUpstreamPort: boolean;
	/** 前置 Token 门禁与限流键策略（edge 用） */
	auth?: AuthConfig;
	/** 移动 hook 注入开关与断点（edge 用） */
	mobile?: MobileConfig;
	/** 手工 TLS 证书（可选） */
	tls?: TlsConfig;
	/** 设备 Token 有效期（天） */
	deviceTokenDays: number;
	/** 配对码有效期（分钟） */
	pairingCodeMinutes: number;
	/** 连续配对失败锁定阈值 / 锁定分钟 */
	pairingFailLockThreshold: number;
	pairingFailLockMinutes: number;
	/** 每IP每分钟请求上限（突发桶容量） */
	rateLimitPerMinute: number;
	frp: FrpConfig;
}

export const DEFAULT_CONFIG: GatewayConfig = {
	listenHost: "127.0.0.1",
	listenPort: 18443,
	upstreamPort: 52392,
	autoFixUpstreamPort: true,
	deviceTokenDays: 365,
	pairingCodeMinutes: 10,
	pairingFailLockThreshold: 5,
	pairingFailLockMinutes: 15,
	rateLimitPerMinute: 240,
	frp: {
		enabled: false,
		serverPort: 7000,
		remotePort: 8443,
		mode: "entry",
	},
};

/** 解析 DSH-Remote 数据根目录（显式参数 > 环境变量 > ~/.dsh-remote）。 */
export function resolveHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env["DSH_REMOTE_HOME"];
	const raw = explicit ?? (fromEnv && fromEnv.trim().length > 0 ? fromEnv : undefined);
	if (raw !== undefined) return raw;
	return (process.platform === "win32" ? env["USERPROFILE"] : env["HOME"] ?? "~")
		+ (process.platform === "win32" ? "\\.dsh-remote" : "/.dsh-remote");
}

/** 深合并：文件值覆盖默认值，仅覆盖已存在的键。 */
export function mergeConfig(base: GatewayConfig, patch: Record<string, unknown>): GatewayConfig {
	// GatewayConfig 无索引签名，经 unknown 中转取记录视图（键仍受 patch 的 entries 约束）
	const out = structuredClone(base) as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		const current = out[key];
		if (
			value !== null && typeof value === "object" && !Array.isArray(value)
			&& current !== null && typeof current === "object" && !Array.isArray(current)
		) {
			out[key] = {
				...(current as Record<string, unknown>),
				...(value as Record<string, unknown>),
			};
		} else {
			out[key] = value;
		}
	}
	return out as unknown as GatewayConfig;
}

// ============================================================================
// edge 部署辅助：角色归一化 + 环境变量覆盖层（Docker / install 脚本统一走 env）
// ============================================================================

/** 归一化 edge frp 角色：未知/缺省回落 off。 */
export function normalizeEdgeFrpRole(raw: unknown): EdgeFrpRole {
	return raw === "visitor" || raw === "frps" ? raw : "off";
}

/** edge=frps 时的隧道消费方式：未知/缺省回落 stcp（推荐形态）。 */
export function normalizeEdgeConsume(raw: unknown): "stcp" | "entry-port" {
	return raw === "entry-port" ? "entry-port" : "stcp";
}

/** visitor 本地绑定端口缺省值（与 desktop 网关监听端口一致，便于记忆）。 */
export const DEFAULT_VISITOR_BIND_PORT = 18443;

/**
 * 上游是否按 HTTPS 访问：
 * 显式配置优先；edge + 隧道形态（visitor/frps）未配置时推断为 true——
 * 隧道对端必然是 PC 网关的自签 HTTPS 服务；其余情况一律 false。
 */
export function effectiveUpstreamTls(config: GatewayConfig): boolean {
	if (typeof config.upstreamTls === "boolean") return config.upstreamTls;
	return config.role === "edge" && normalizeEdgeFrpRole(config.frp.edge) !== "off";
}

/** edge 角色下生效的 frp 形态（desktop 角色不使用）。 */
export function effectiveEdgeFrpRole(config: GatewayConfig): EdgeFrpRole {
	if (config.role !== "edge") return "off";
	return normalizeEdgeFrpRole(config.frp.edge);
}

/** 移动 hook 是否注入（仅 edge 且未显式关闭）。 */
export function mobileInjectionEnabled(config: GatewayConfig): boolean {
	return config.role === "edge" && config.mobile?.enabled !== false;
}

/** 移动 hook 断点：非法值一律回落 980。 */
export const DEFAULT_MOBILE_BREAKPOINT = 980;

export function mobileBreakpointPx(config: GatewayConfig): number {
	const raw = config.mobile?.breakpointPx;
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 240 && raw <= 4096
		? Math.round(raw)
		: DEFAULT_MOBILE_BREAKPOINT;
}

function boolEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function portEnv(value: string | undefined): number | undefined {
	const port = Number.parseInt(value ?? "", 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** 解析 allowPorts 环境变量，形如 `18400-18500` 或 `8443,18400-18500`。 */
export function parseAllowPorts(raw: string | undefined): Array<{ start: number; end: number }> | undefined {
	if (raw === undefined || raw.trim().length === 0) return undefined;
	const ranges: Array<{ start: number; end: number }> = [];
	for (const part of raw.split(",")) {
		const segment = part.trim();
		if (segment.length === 0) continue;
		const match = /^(\d+)(?:-(\d+))?$/.exec(segment);
		if (match === null) continue;
		const start = Number.parseInt(match[1] ?? "", 10);
		const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : start;
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) continue;
		ranges.push({ start, end });
	}
	return ranges.length > 0 ? ranges : undefined;
}

/**
 * 环境变量覆盖层：env 有值才覆盖，优先级高于 config.json。
 * 明文 Token（DSHR_ACCESS_TOKEN）不进配置对象 —— 由 server 启动时哈希后持久化。
 */
export function applyEnvOverrides(base: GatewayConfig, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
	const out = structuredClone(base);
	const set = (path: string[], value: unknown) => {
		let node = out as unknown as Record<string, unknown>;
		for (const key of path.slice(0, -1)) {
			const existing = node[key];
			if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
				node[key] = {};
			}
			node = node[key] as Record<string, unknown>;
		}
		node[path[path.length - 1] ?? ""] = value;
	};

	const role = env["DSHR_ROLE"];
	if (role === "edge" || role === "desktop") set(["role"], role);

	const listenHost = env["DSHR_LISTEN_HOST"];
	if (typeof listenHost === "string" && listenHost.trim().length > 0) set(["listenHost"], listenHost.trim());
	const listenPort = portEnv(env["DSHR_LISTEN_PORT"]);
	if (listenPort !== undefined) set(["listenPort"], listenPort);
	const upstreamHost = env["DSHR_UPSTREAM_HOST"];
	if (typeof upstreamHost === "string" && upstreamHost.trim().length > 0) set(["upstreamHost"], upstreamHost.trim());
	const upstreamPort = portEnv(env["DSHR_UPSTREAM_PORT"]);
	if (upstreamPort !== undefined) set(["upstreamPort"], upstreamPort);
	const upstreamTls = boolEnv(env["DSHR_UPSTREAM_TLS"]);
	if (upstreamTls !== undefined) set(["upstreamTls"], upstreamTls);

	const mobileEnabled = boolEnv(env["DSHR_MOBILE_ENABLED"]);
	if (mobileEnabled !== undefined) set(["mobile", "enabled"], mobileEnabled);
	const breakpoint = Number.parseInt(env["DSHR_MOBILE_BREAKPOINT"] ?? "", 10);
	if (Number.isInteger(breakpoint) && breakpoint >= 240 && breakpoint <= 4096) {
		set(["mobile", "breakpointPx"], breakpoint);
	}

	const tokenDays = Number.parseInt(env["DSHR_TOKEN_LOGIN_DAYS"] ?? "", 10);
	if (Number.isInteger(tokenDays) && tokenDays >= 1 && tokenDays <= 3650) set(["auth", "tokenLoginDays"], tokenDays);
	const trustXff = boolEnv(env["DSHR_TRUST_PROXY_XFF"]);
	if (trustXff !== undefined) set(["auth", "trustProxyXff"], trustXff);
	const trustCidrsRaw = env["DSHR_TRUST_PROXY_CIDRS"];
	if (typeof trustCidrsRaw === "string" && trustCidrsRaw.trim().length > 0) {
		const cidrs = trustCidrsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		if (cidrs.length > 0) set(["auth", "trustProxyCidrs"], cidrs);
	}

	const tlsCert = env["DSHR_TLS_CERT"];
	if (typeof tlsCert === "string" && tlsCert.trim().length > 0) set(["tls", "certPath"], tlsCert.trim());
	const tlsKey = env["DSHR_TLS_KEY"];
	if (typeof tlsKey === "string" && tlsKey.trim().length > 0) set(["tls", "keyPath"], tlsKey.trim());

	const frpRole = env["DSHR_FRP_ROLE"];
	if (typeof frpRole === "string" && frpRole.trim().length > 0) set(["frp", "edge"], normalizeEdgeFrpRole(frpRole.trim()));
	const serverAddr = env["DSHR_FRP_SERVER_ADDR"];
	if (typeof serverAddr === "string" && serverAddr.trim().length > 0) set(["frp", "serverAddr"], serverAddr.trim());
	const serverPort = portEnv(env["DSHR_FRP_SERVER_PORT"]);
	if (serverPort !== undefined) set(["frp", "serverPort"], serverPort);
	const tunnelName = env["DSHR_FRP_NAME"];
	if (typeof tunnelName === "string" && tunnelName.trim().length > 0) set(["frp", "name"], tunnelName.trim());
	const remotePort = portEnv(env["DSHR_FRP_REMOTE_PORT"]);
	if (remotePort !== undefined) set(["frp", "remotePort"], remotePort);
	const visitorBindPort = portEnv(env["DSHR_VISITOR_BIND_PORT"]);
	if (visitorBindPort !== undefined) set(["frp", "visitorBindPort"], visitorBindPort);
	const edgeConsume = env["DSHR_EDGE_CONSUME"];
	if (edgeConsume === "stcp" || edgeConsume === "entry-port") set(["frp", "edgeConsume"], edgeConsume);
	const allowPorts = parseAllowPorts(env["DSHR_FRPS_ALLOW_PORTS"]);
	if (allowPorts !== undefined) set(["frp", "allowPorts"], allowPorts);

	return out;
}
