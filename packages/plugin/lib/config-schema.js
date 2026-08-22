/**
 * 配置补丁校验与合并 —— 纯函数，宿主半边与测试共用。
 *
 * 设置面板（浏览器）只能通过白名单提交这些键；端口/地址做范围与格式校验，
 * 其余一律拒绝。合并语义：与 config.ts 的 mergeConfig 相同的浅+frp 深合并。
 */

const ALLOWED_LISTEN_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1"]);

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

/**
 * 校验设置面板提交的补丁。返回 { ok: true, patch } 或 { ok: false, errors: string[] }。
 * 只接受已知键；未知键直接报错（防把任意内容写进配置文件）。
 */
export function validateConfigPatch(input) {
	const errors = [];
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, errors: ["请求体必须是对象"] };
	}
	const allowed = new Set([
		"enabled", "listenHost", "listenPort", "upstreamPort",
		"autoFixUpstreamPort", "autoStart", "frp",
	]);
	const patch = {};

	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) {
			errors.push(`未知配置项：${key}`);
			continue;
		}
		const value = input[key];
		switch (key) {
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
				const frpAllowed = new Set(["enabled", "serverAddr", "serverPort", "remotePort"]);
				for (const frpKey of Object.keys(value)) {
					if (!frpAllowed.has(frpKey)) {
						errors.push(`未知 frp 配置项：${frpKey}`);
						continue;
					}
					const frpValue = value[frpKey];
					if (frpKey === "enabled") {
						if (typeof frpValue !== "boolean") errors.push("frp.enabled 必须是布尔值");
						else frpPatch.enabled = frpValue;
					} else if (frpKey === "serverAddr") {
						if (!isHostOrIp(frpValue)) errors.push("frp.serverAddr 必须是合法域名或 IP");
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

	return errors.length > 0 ? { ok: false, errors } : { ok: true, patch };
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
	frp: { enabled: false, serverPort: 7000, remotePort: 8443 },
};
