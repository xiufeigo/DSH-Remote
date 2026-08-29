/**
 * 移动 hook 资产：`assets/mobile-web.js`（Android 壳 mobile.js 的宽度断点 fork）。
 *
 * - edge 角色把 `<script>` 标记注入上游 HTML；脚本按视口宽度自行启停 hook：
 *   窄视口（≤ 断点，缺省 980px）套移动布局，宽视口走官方 DSH 桌面布局；
 * - 文件内容进程内缓存 + SHA-256 ETag；资产缺失时不阻塞网关（注入静默降级）。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = join(MODULE_DIR, "..", "assets", "mobile-web.js");

export interface MobileScriptAsset {
	etag: string;
	body: Buffer;
}

let cache: MobileScriptAsset | undefined;
let missingWarned = false;

/** 读取移动 hook 脚本；缺失返回 undefined（调用方打一次日志即可）。 */
export async function loadMobileScript(): Promise<MobileScriptAsset | undefined> {
	if (cache !== undefined) return cache;
	try {
		const body = await readFile(ASSET_PATH);
		const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
		cache = { etag, body };
		return cache;
	} catch {
		if (!missingWarned) {
			missingWarned = true;
			console.error(`[dsh-remote] 移动 hook 资产缺失：${ASSET_PATH}（移动适配已停用）`);
		}
		return undefined;
	}
}

/** 注入 <head> 的移动 hook 标记块：断点经内联变量下发，脚本本体走独立路由（带 ETag 缓存）。 */
export function mobileHeadTags(breakpointPx: number): string {
	const breakpoint = Number.isFinite(breakpointPx) ? Math.round(breakpointPx) : 980;
	return (
		`<script>window.__DSHR_MOBILE__={breakpoint:${String(breakpoint)}};</script>` +
		`<script src="/__dsh_remote__/mobile.js" defer></script>`
	);
}
