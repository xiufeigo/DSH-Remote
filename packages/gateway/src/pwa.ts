/**
 * 主屏/独立窗口支持：只补官方宿主没有的项 —— iOS 三件套 + 主题色 +
 * Service Worker 注册，外加 iOS 必需的 apple-touch-icon（PNG，运行时
 * 零依赖生成：node:zlib 手写 PNG 编码器）。
 *
 * **不注入 manifest**：官方 index 自带
 * `<link rel="manifest" href="/manifest.webmanifest">`（复核过 0.1.0-rc.8 →
 * 0.1.5-rc.1 每个版本都有），官方 manifest 提供 name/display/icons 全套；
 * 网关再注一份只会盖掉官方品牌与 `display: fullscreen` 设定。
 * 同理不再提供自有的 icon.svg / icon-512.png。
 *
 * SW 注册脚本的路径同时充当「本注入块是否已存在」的幂等标记。
 */

import { deflateSync } from "node:zlib";
import { mobileHeadTags } from "./mobile.ts";

/** Service Worker 路径：既是被注册的资源，也是注入幂等标记。 */
const SW_PATH = "/__dsh_remote__/sw.js";
/** apple-touch-icon（iOS 只认 PNG，不读 manifest 图标）。 */
export const APPLE_TOUCH_ICON_PATH = "/__dsh_remote__/icon-192.png";

/** Android 配对页使用的轻量 DSH 鲸鱼标记；不携带配置、会话或认证信息。 */
export const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <path fill="#111318" d="M56.1 15.5c-2.4 1.9-5 2.8-7.8 2.7-3.1-5.1-8.6-8.4-14.9-8.4-7.4 0-13.7 4.5-16.4 10.9-5.3.7-9.4 4.2-10.9 9.2-2.1 7 1.9 14.5 9 16.6 2.5.7 5.1.7 7.4.1 3.2 4.7 8.6 7.7 14.6 7.7 9.8 0 17.8-8 17.8-17.8 0-2.2-.4-4.3-1.1-6.2 2.2-3.5 3.1-8.1 2.3-14.8ZM19.3 35.8a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Zm23.7 8.8c-4.1 2.9-9.6 3.2-14 .8 4.4-.8 8.2-3.1 10.9-6.4 1.1 2.1 2.2 3.9 3.1 5.6Zm-4.9-17.2c-2.6 0-4.8-2.1-4.8-4.8s2.2-4.8 4.8-4.8 4.8 2.1 4.8 4.8-2.2 4.8-4.8 4.8Z"/>
</svg>`;

/** 生成注入到上游 HTML <head> 的标记块（官方 manifest 之外的补充项）。 */
export function homeScreenHeadTags(): string {
	return [
		`<meta name="theme-color" content="#1b66ff">`,
		`<meta name="mobile-web-app-capable" content="yes">`,
		`<meta name="apple-mobile-web-app-capable" content="yes">`,
		`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
		`<meta name="apple-mobile-web-app-title" content="DSH">`,
		`<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`,
		// WEB-01：注册网关 Service Worker（白名单缓存策略，源码见 renderServiceWorker）。
		// SW 文件位于 /__dsh_remote__/sw.js（server.ts 内部路由，响应需带
		// Service-Worker-Allowed: /），注册时 scope:"/" 把拦截面扩到全站。
		// 注册失败静默降级（非安全上下文/不支持的浏览器不影响页面本身）。
		`<script>if("serviceWorker"in navigator){navigator.serviceWorker.register("${SW_PATH}",{scope:"/"}).catch(function(){});}</script>`,
	].join("");
}

/**
 * 在 HTML 里注入主屏标记：优先插到 <head…> 开标签之后；
 * 没有 head 标签时插到文档最前（宽松处理，避免破坏上游页面）。
 */
export function injectIntoHtml(html: Buffer): Buffer {
	return makeHtmlInjector()(html);
}

export interface HtmlInjectOptions {
	/** 移动 hook 注入（edge 角色）：提供时追加断点变量 + mobile.js 脚本标记。 */
	mobile?: { enabled: boolean; breakpointPx: number };
}

/**
 * 构造 HTML 注入器：desktop 角色等价于历史 injectIntoHtml；
 * edge 且 mobile.enabled 时额外注入移动 hook 标记，并在上游缺失
 * viewport meta 时补一个（避免 iOS Safari 按桌面 980px 布局渲染）。
 *
 * 幂等按标记独立判断：edge 的上游是另一台 dsh-remote 网关时，
 * 响应里可能已有它注入的主屏标记——此时只补移动 hook 块，不重复注。
 *
 * WEB-08：补写的 viewport meta 一次性带上目标值（`viewport-fit=cover` +
 * 浏览器缺省的 `interactive-widget=resizes-content`）。iOS 对 JS 动态改
 * viewport meta 的生效时机不稳，能在网关侧给到位就不留给运行时——
 * mobile-web.js 里的动态修改因此只作兜底：页面自带 viewport meta 但缺
 * 关键项时补齐，以及 Android 壳把 interactive-widget 换成 overlays-content
 * 的平台适配。
 */
export function makeHtmlInjector(options: HtmlInjectOptions = {}): (body: Buffer) => Buffer {
	const extraTags = options.mobile?.enabled === true ? mobileHeadTags(options.mobile.breakpointPx) : "";
	return function inject(body: Buffer): Buffer {
		const text = body.toString("utf8");
		const needHome = !text.includes(SW_PATH);
		const needMobile = extraTags !== "" && !text.includes("/__dsh_remote__/mobile.js");
		if (!needHome && !needMobile) return body;
		const payload =
			(needHome ? homeScreenHeadTags() : "")
			+ (needMobile
				? extraTags
					+ (!/name=["']viewport["']/i.test(text)
						? '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">'
						: "")
				: "");
		const headOpen = /<head(?:\s[^>]*)?>/i.exec(text);
		if (headOpen === null) return Buffer.from(payload + text, "utf8");
		const at = headOpen.index + headOpen[0].length;
		return Buffer.from(text.slice(0, at) + payload + text.slice(at), "utf8");
	};
}

/**
 * WEB-01：Service Worker 源码（白名单缓存策略）。
 *
 * 历史策略是「网络优先、失败回退缓存」且不区分请求类别：瞬断时
 * `/api/*`、`/__dsh_remote__/*` 动态接口可能命中过期缓存；未认证 +
 * 网络异常时还会命中缓存里的受保护 HTML → WS 401 → 白屏死锁，连登录页
 * 都回不去。现改为白名单制：
 *
 *   - 只有「静态资源扩展名」的同源 GET 请求可进缓存（网络优先，
 *     成功后更新缓存，失败才回退缓存）；
 *   - 导航请求、`/api/*`、`/__dsh_remote__/*`（登录/配对页、配对码、
 *     管理端点等）一律穿透网络，失败不回退缓存——认证相关的响应
 *     永远拿网关的实时判定，离线/瞬断时不会把过期受保护页面糊回给用户；
 *     网络恢复后导航自然回到登录页，不再有缓存造成的死锁。
 *
 * 不在白名单内的请求不调用 respondWith，等价于完全不拦截。
 * 缓存名带版本号：策略/资源结构变更时改名即可在 activate 时清旧缓存。
 */
export function renderServiceWorker(): string {
	return `/* DSH-Remote Service Worker —— 静态资源白名单缓存（WEB-01） */
"use strict";
var CACHE_NAME = "dsh-remote-static-v1";
var CACHEABLE = /\\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|eot|ico)$/i;

self.addEventListener("install", function (event) {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
	event.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(
				keys
					.filter(function (key) { return key.indexOf("dsh-remote-") === 0 && key !== CACHE_NAME; })
					.map(function (key) { return caches.delete(key); })
			);
		}).then(function () { return self.clients.claim(); })
	);
});

self.addEventListener("fetch", function (event) {
	var request = event.request;
	if (request.method !== "GET") return;
	var url;
	try { url = new URL(request.url); } catch (err) { return; }
	if (url.origin !== self.location.origin) return;
	// 导航请求：一律穿透网络，失败不回退缓存（绝不把过期受保护 HTML 糊回去）。
	if (request.mode === "navigate") return;
	// 动态接口：认证/配对/管理/上游 API，永不缓存、永不拦截。
	if (url.pathname.indexOf("/api/") === 0 || url.pathname.indexOf("/__dsh_remote__/") === 0) return;
	// 白名单：仅静态资源扩展名可缓存。
	if (!CACHEABLE.test(url.pathname)) return;
	event.respondWith(
		fetch(request).then(function (fresh) {
			if (fresh.ok) {
				var cacheControl = fresh.headers.get("cache-control") || "";
				if (!/no-store|private/i.test(cacheControl)) {
					var copy = fresh.clone();
					caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); }).catch(function () {});
				}
			}
			return fresh;
		}).catch(function () {
			return caches.match(request, { ignoreSearch: true }).then(function (cached) {
				if (cached) return cached;
				throw new Error("dsh-remote sw: offline and not cached " + request.url);
			});
		})
	);
});
`;
}

// ============================================================================
// 零依赖 PNG 生成：圆角方块 + 白色闪电。仅用 node:zlib。
// ============================================================================

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

/** 点是否在闪电多边形内（射线法），坐标基于 512 viewBox。 */
const BOLT: Array<[number, number]> = [
	[286, 84],
	[148, 292],
	[234, 292],
	[210, 428],
	[362, 212],
	[272, 212],
];

function pointInBolt(x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i, i += 1) {
		const [xi, yi] = BOLT[i];
		const [xj, yj] = BOLT[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function drawIconRgba(size: number): Uint8Array {
	const rgba = new Uint8Array(size * size * 4);
	const radius = size * 0.22;
	const inset = size * 0.03125; // 对应 SVG 的 16/512 边距
	const r = 0x1b, g = 0x66, b = 0xff;
	for (let py = 0; py < size; py += 1) {
		for (let px = 0; px < size; px += 1) {
			const offset = (py * size + px) * 4;
			// 圆角矩形内测试（局部坐标，含边距）
			const lx = px - inset;
			const ly = py - inset;
			const w = size - inset * 2;
			const h = size - inset * 2;
			const inRect =
				lx >= 0 && lx <= w && ly >= 0 && ly <= h &&
				(() => {
					// 四角圆弧判定
					const cornerX = lx < radius ? radius : lx > w - radius ? w - radius : null;
					const cornerY = ly < radius ? radius : ly > h - radius ? h - radius : null;
					if (cornerX === null || cornerY === null) return true;
					return (lx - cornerX) ** 2 + (ly - cornerY) ** 2 <= radius ** 2;
				})();
			if (!inRect) continue;
			rgba[offset] = r;
			rgba[offset + 1] = g;
			rgba[offset + 2] = b;
			rgba[offset + 3] = 255;
			if (pointInBolt((px / size) * 512, (py / size) * 512)) {
				rgba[offset] = 255;
				rgba[offset + 1] = 255;
				rgba[offset + 2] = 255;
			}
		}
	}
	return rgba;
}

const pngCache = new Map<number, Buffer>();

/** 生成指定尺寸的图标 PNG（带缓存）。 */
export function iconPng(size: number): Buffer {
	const cached = pngCache.get(size);
	if (cached !== undefined) return cached;

	const rgba = drawIconRgba(size);
	// 每行前置 filter byte 0
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let row = 0; row < size; row += 1) {
		raw[row * (size * 4 + 1)] = 0;
		Buffer.from(rgba.buffer, row * size * 4, size * 4).copy(raw, row * (size * 4 + 1) + 1);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	const png = Buffer.concat([
		// 字节数组重载不接受编码参数（@types/node 24 严格化；字节序列本身即签名）
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
	pngCache.set(size, png);
	return png;
}
