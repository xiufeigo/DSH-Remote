/**
 * 配置补丁校验与合并 —— 纯函数，宿主半边与测试共用。
 *
 * 设置面板（浏览器）只能通过白名单提交这些键；端口/地址做范围与格式校验，
 * 其余一律拒绝。合并语义：与 config.ts 的 mergeConfig 相同的浅+frp 深合并。
 */

const ALLOWED_LISTEN_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1"]);

/** frp 隧道形态：entry 公网入口 / stcp 秘密中转 / xtcp P2P 打洞（与网关 FrpMode 对齐） */
const FRP_MODES = new Set(["entry", "stcp", "xtcp"]);

function isPort(value) {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isHostOrIp(value) {
	return (
		typeof value === "string"
		&& value.length > 0
		&& value.length <= 253
		&& /^[A-Za-z0-9.\-_]+$/.test(value) // 域名/IPv4 字符集（IPv6 走字面量白名单外场景暂不支持）
	);
}

/** 登录密钥 / 访客密钥：非空、不过长、不含控制字符。 */
function isSecret(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
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
			case "visitorKey":
				if (!isSecret(value)) errors.push(`${key === "authToken" ? "登录密钥" : "访客密钥"}必须是 1-512 位且不含换行`);
				else secrets[key] = value;
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
				const frpAllowed = new Set(["enabled", "serverAddr", "serverPort", "remotePort", "mode", "name"]);
				for (const frpKey of Object.keys(value)) {
					if (!frpAllowed.has(frpKey)) {
						errors.push(`未知 frp 配置项：${frpKey}`);
						continue;
					}
					const frpValue = value[frpKey];
					if (frpKey === "enabled") {
						if (typeof frpValue !== "boolean") errors.push("frp.enabled 必须是布尔值");
						else frpPatch.enabled = frpValue;
					} else if (frpKey === "mode") {
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
								frpPatch.name = "dsh-remote";
							} else if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(trimmed)) {
								errors.push("隧道名须以字母开头，仅含字母数字和 - _，最长 32 位");
							} else {
								frpPatch.name = trimmed;
							}
						}
					} else if (frpKey === "serverAddr") {
						if (frpValue === "") frpPatch.serverAddr = "";
						else if (!isHostOrIp(frpValue)) errors.push("frp.serverAddr 必须是合法域名或 IP");
						else frpPatch.serverAddr = frpValue;
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

/** 与网关侧一致的合并语义：顶层浅覆盖 + frp 深合并。 */
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

/** 设置页展示用的默认值（与网关 DEFAULT_CONFIG 对齐；enabled 由 autoStart 承担）。 */
export const DISPLAY_DEFAULTS = {
	listenHost: "127.0.0.1",
	listenPort: 18443,
	upstreamPort: 52392,
	autoFixUpstreamPort: true,
	autoStart: true,
	frp: { enabled: false, serverPort: 7000, remotePort: 8443, mode: "xtcp", name: "dsh-remote" },
};
