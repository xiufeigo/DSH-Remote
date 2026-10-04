/**
 * 移动 hook 资产：`assets/mobile-web.js`（WEB-02 单一源——与 Android 壳
 * `res/raw/mobile.js` 由 android/build.ps1 字节同步，禁止手改 res/raw 副本）。
 *
 * - edge 角色把 `<script>` 标记注入上游 HTML；脚本按视口宽度自行启停 hook：
 *   窄视口（≤ 断点，缺省 980px）套移动布局，宽视口走官方 DSH 桌面布局；
 * - 文件内容进程内缓存 + SHA-256 ETag；资产缺失时不阻塞网关（注入静默降级）。
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MOBILE_BREAKPOINT } from "./config.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = join(MODULE_DIR, "..", "assets", "mobile-web.js");

export interface MobileScriptAsset {
	etag: string;
	body: Buffer;
}

let cache: MobileScriptAsset | undefined;
/** 缓存命中时用来判断「文件是不是被改过」的指纹（mtimeMs + size）。 */
let cacheStamp = "";
let missingWarned = false;

/** 当前文件的轻量指纹。取不到就返回空串（⇒ 退化为每次都重读，代价只是多一次 readFile）。 */
async function assetStamp(): Promise<string> {
	try {
		const st = await stat(ASSET_PATH);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}

/**
 * 读取移动 hook 脚本；缺失返回 undefined（调用方打一次日志即可）。
 *
 * T53：原来这里是个**只认首次读取**的进程内缓存（`if (cache !== undefined) return cache`），
 * 于是「改了 `assets/mobile-web.js` 必须重启网关才生效」——T52 §10.2 实测过这个坑：
 * 改文件后重新 GET 拿到的还是旧字节。重启网关在开发期很烦（而且本机 18443 不许动）。
 *
 * 现在按 **mtime + size 变化**重读：变了就重新读盘并重算 ETag，没变就走缓存。
 * stat 一次远比 readFile（198 KB）+ SHA-256 便宜，而"文件没动"是绝大多数请求。
 *
 * ⚠️ **这个修复本身也要重启网关才生效**（本进程加载的是旧 mobile.ts 代码）。
 * 但只需重启**一次**：之后每次改资产都自动生效，不再需要第二次重启。
 * 这就是它对后续启动的意义 —— 不要误以为改完 mobile.ts 当前进程就变了。
 */
export async function loadMobileScript(): Promise<MobileScriptAsset | undefined> {
	const stamp = await assetStamp();
	if (cache !== undefined && (stamp === "" || stamp === cacheStamp)) return cache;
	try {
		const body = await readFile(ASSET_PATH);
		const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
		cache = { etag, body };
		cacheStamp = stamp;
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
	const breakpoint = Number.isFinite(breakpointPx) ? Math.round(breakpointPx) : DEFAULT_MOBILE_BREAKPOINT;
	return (
		`<script>window.__DSHR_MOBILE__={breakpoint:${String(breakpoint)}};</script>` +
		`<script src="/__dsh_remote__/mobile.js" defer></script>`
	);
}
