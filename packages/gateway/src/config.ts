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
}

export interface GatewayConfig {
	/** 网关 HTTPS 监听地址；默认仅回环 —— frpc 从本机连入，LAN/WAN 不可见 */
	listenHost: string;
	listenPort: number;
	/** 上游 DSH Web GUI 端口（127.0.0.1） */
	upstreamPort: number;
	/** 上游端口失配时是否自动探测并回写配置 */
	autoFixUpstreamPort: boolean;
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
	const out: GatewayConfig = structuredClone(base);
	for (const [key, value] of Object.entries(patch)) {
		const current = (out as Record<string, unknown>)[key];
		if (
			value !== null && typeof value === "object" && !Array.isArray(value)
			&& current !== null && typeof current === "object" && !Array.isArray(current)
		) {
			(out as Record<string, unknown>)[key] = {
				...(current as Record<string, unknown>),
				...(value as Record<string, unknown>),
			};
		} else {
			(out as Record<string, unknown>)[key] = value;
		}
	}
	return out;
}
