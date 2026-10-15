/**
 * 配置补丁校验与合并 —— 纯函数，宿主半边与测试共用。
 *
 * 设置面板（浏览器）只能通过白名单提交这些键；端口/地址做范围与格式校验，
 * 其余一律拒绝。合并语义：与 config.ts 的 mergeConfig 相同的浅+frp 深合并。
 *
 * ⚠ 单一真相源同步约定（PLG-02）：本文件的校验规则必须与网关侧保持同步——
 *   - 端口范围            ↔ packages/gateway/src/config.ts `portEnv`（1-65535 整数）
 *   - frp.name 正则        ↔ packages/gateway/src/frp.ts `TUNNEL_NAME_RE`（见下方
 *                            FRP_TUNNEL_NAME_RE，两处必须逐字符一致）
 *   - frp.mode 白名单      ↔ packages/gateway/src/frp.ts `normalizeFrpMode`（entry/stcp/xtcp）
 *   - frp.name 空值回落    ↔ packages/gateway/src/frp.ts `DEFAULT_TUNNEL_NAME`（"dsh-remote"）
 *   - 展示默认值           ↔ packages/gateway/src/config.ts `DEFAULT_CONFIG`（见底部
 *                            DISPLAY_DEFAULTS，scripts/test-plugin-routes.mjs 有对齐抽查）
 *   - 合并语义             ↔ packages/gateway/src/config.ts `mergeConfig`
 * 网关侧改动上述任一规则时，必须同步改动本文件（docs/review-fix-plan.md PLG-02）。
 * 差异说明：网关 `mergeConfig` 对任意对象键深合并（auth/mobile/tls/frp），本文件
 * `mergeConfigFile` 仅对 frp 深合并——面板白名单中对象键只有 frp，二者对面板等价。
 */

/**
 * 网关监听地址白名单。比网关侧更严（网关 applyEnvOverrides 接受任意非空字符串）：
 * 面板只暴露经过评估的三个值，防止把网关意外暴露到不受控的地址。
 */
const ALLOWED_LISTEN_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1"]);

/** frp 隧道形态：entry 公网入口 / stcp 秘密中转 / xtcp P2P 打洞（与网关 FrpMode 对齐） */
const FRP_MODES = new Set(["entry", "stcp", "xtcp"]);

/**
 * 隧道名规则：字母开头，字母数字与 - _，最长 32 位。
 * 必须与网关 packages/gateway/src/frp.ts 的 TUNNEL_NAME_RE 完全一致（PLG-02）。
 * 行为差异（有意）：网关 `normalizeTunnelName` 非法时静默回落缺省名；面板校验
 * 选择报错，让用户立刻看到名字不合法，空白输入同样回落 "dsh-remote"。
 */
export const FRP_TUNNEL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** 端口范围与网关 config.ts `portEnv` 一致：1-65535 的整数（PLG-02）。 */
function isPort(value) {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 域名、IPv4、IPv6（可带方括号）和字母类域名（含 IDN）。
 * 与 Android VisitorConfig.isHostOrIp 同一套：拒绝空白、引号和控制字符。
 */
function isHostOrIp(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
	if (/[\u0000-\u001F\u007F\s"'\\/]/.test(value)) return false;
	if (/^[\p{L}0-9.\-_]+$/u.test(value)) return true;
	const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	return bare.includes(":") && /^[0-9A-Fa-f:.]+$/.test(bare);
}

/**
 * 登录密钥 / 访客密钥：非空、不过长、不含控制字符。
 * 访客密钥上限与网关 auth.ts MAX_VISITOR_KEY_LENGTH 一致（512）。
 */
function isSecret(value) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value);
}

/** 自定义访客密钥：至少 16 位可见 ASCII，拒绝空格和控制字符。 */
function isVisitorKey(value) {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	return trimmed.length >= 16 && trimmed.length <= 512 && /^[\x21-\x7E]+$/.test(trimmed);
}

/**
 * 校验设置面板提交的补丁。返回 { ok: true, patch, secrets } 或 { ok: false, errors }。
 * 只接受已知键；未知键直接报错（防把任意内容写进配置文件）。
 * authToken / visitorKey 不进 config.json，由路由层写入 state/secrets.json。
 */
export function validateConfigPatch(input) {
	const errors = [];
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, errors: ["请求体必须是对象"] };
	}
	const allowed = new Set([
		"enabled", "listenHost", "listenPort", "upstreamPort",
		"autoFixUpstreamPort", "autoStart", "frp",
		"authToken", "visitorKey",
	]);
	const patch = {};
	const secrets = {};

	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) {
			errors.push(`未知配置项：${key}`);
			continue;
		}
		const value = input[key];
		switch (key) {
			case "authToken":
				if (!isSecret(value)) errors.push("登录密钥必须是 1-512 位且不含控制字符");
				else secrets[key] = value.trim();
				break;
			case "visitorKey":
				if (!isVisitorKey(value)) errors.push("访客密钥至少 16 位、最长 512 位，且只能使用可见 ASCII 字符");
				else secrets[key] = value.trim();
				break;
			case "autoFixUpstreamPort":
			case "autoStart":
				if (typeof value !== "boolean") errors.push(`${key} 必须是布尔值`);
				else patch[key] = value;
				break;
			case "listenHost":
				if (typeof value !== "string" || !ALLOWED_LISTEN_HOSTS.has(value)) {
					errors.push("listenHost 仅允许 127.0.0.1 / 0.0.0.0 / ::1");
				} else {
					patch[key] = value;
				}
				break;
			case "listenPort":
			case "upstreamPort":
				if (!isPort(value)) errors.push(`${key} 必须是 1-65535 的整数`);
				else patch[key] = value;
				break;
			case "frp": {
				if (value === null || typeof value !== "object" || Array.isArray(value)) {
					errors.push("frp 必须是对象");
					break;
				}
				const frpPatch = {};
				const frpAllowed = new Set([
					"enabled", "entryEnabled", "serverAddr", "serverPort", "remotePort", "mode", "name",
					"tlsTrustedCaFile", "tlsServerName",
				]);
				for (const frpKey of Object.keys(value)) {
					if (!frpAllowed.has(frpKey)) {
						errors.push(`未知 frp 配置项：${frpKey}`);
						continue;
					}
					const frpValue = value[frpKey];
					if (frpKey === "enabled" || frpKey === "entryEnabled") {
						if (typeof frpValue !== "boolean") errors.push(`frp.${frpKey} 必须是布尔值`);
						else frpPatch[frpKey] = frpValue;
					} else if (frpKey === "mode") {
						// 白名单与网关 frp.ts normalizeFrpMode 的合法集一致（entry/stcp/xtcp）
						if (typeof frpValue !== "string" || !FRP_MODES.has(frpValue)) {
							errors.push("frp.mode 仅允许 entry / stcp / xtcp");
						} else {
							frpPatch.mode = frpValue;
						}
					} else if (frpKey === "name") {
						if (typeof frpValue !== "string") {
							errors.push("隧道名必须是字符串");
						} else {
							const trimmed = frpValue.trim();
							if (trimmed === "") {
								// 空值回落与网关 frp.ts DEFAULT_TUNNEL_NAME 一致
								frpPatch.name = "dsh-remote";
							} else if (!FRP_TUNNEL_NAME_RE.test(trimmed)) {
								errors.push("隧道名须以字母开头，仅含字母数字和 - _，最长 32 位");
							} else {
								frpPatch.name = trimmed;
							}
						}
					} else if (frpKey === "serverAddr") {
						if (frpValue === "") frpPatch.serverAddr = "";
						else if (!isHostOrIp(frpValue)) errors.push("frp.serverAddr 必须是合法域名或 IP");
						else frpPatch.serverAddr = frpValue;
					} else if (frpKey === "tlsTrustedCaFile" || frpKey === "tlsServerName") {
						if (typeof frpValue !== "string" || frpValue.length > 1024 || /[\u0000-\u001F\u007F]/.test(frpValue)) {
							errors.push(`frp.${frpKey} 只能是不含控制字符的路径或名称（最长 1024）`);
						} else {
							frpPatch[frpKey] = frpValue.trim();
						}
					} else {
						if (!isPort(frpValue)) errors.push(`frp.${frpKey} 必须是 1-65535 的整数`);
						else frpPatch[frpKey] = frpValue;
					}
				}
				if (Object.keys(frpPatch).length > 0) patch.frp = frpPatch;
				break;
			}
		}
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, patch, secrets };
}

/**
 * 与网关侧一致的合并语义：顶层浅覆盖 + frp 深合并。
 * 对应网关 config.ts `mergeConfig`；白名单内对象键仅 frp，故对面板提交等价。
 */
export function mergeConfigFile(current, patch) {
	const next = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "frp" && value !== null && typeof value === "object") {
			next.frp = { ...(next.frp ?? {}), ...value };
		} else {
			next[key] = value;
		}
	}
	return next;
}

/**
 * 设置页展示用的默认值（与网关 config.ts DEFAULT_CONFIG 对齐；enabled 由 autoStart 承担）。
 * 有意差异：frp.mode 缺省 "xtcp"（面板形态，访客密钥连入），网关文件缺省仍为
 * "entry"（避免改写未显式配置 mode 的历史部署）——见 test-plugin-routes.mjs 对齐抽查。
 */
export const DISPLAY_DEFAULTS = {
	listenHost: "127.0.0.1",
	listenPort: 18443,
	upstreamPort: 52392,
	autoFixUpstreamPort: true,
	autoStart: true,
	frp: { enabled: false, entryEnabled: false, serverPort: 7000, remotePort: 8443, mode: "xtcp", name: "dsh-remote" },
};
