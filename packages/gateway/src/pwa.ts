/**
 * PWA 支持：manifest 与图标由网关自己提供；对上游 HTML 注入引用标记。
 * 手机「添加到主屏幕」即可全屏运行，观感接近原生 App。
 *
 * 图标三件套：
 *   icon.svg        —— 矢量源（新浏览器）
 *   icon-{192,512}.png —— 运行时零依赖生成（老 iOS/Android 需要 PNG；
 *                          node:zlib 手写 PNG 编码器，无任何依赖）
 */

import { deflateSync } from "node:zlib";

const MANIFEST_PATH = "/__dsh_remote__/manifest.webmanifest";

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#1b66ff"/>
  <path d="M286 84 148 292h86l-24 136 152-216h-90z" fill="#fff"/>
</svg>`;

export function renderManifest(): string {
	return `${JSON.stringify(
		{
			name: "DSH Remote",
			short_name: "DSH",
			description: "DeepSeek Harness 远程控制",
			start_url: "/",
			scope: "/",
			display: "standalone",
			background_color: "#101418",
			theme_color: "#1b66ff",
			icons: [
				{ src: "/__dsh_remote__/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
				{ src: "/__dsh_remote__/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
				{ src: "/__dsh_remote__/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
			],
		},
		null,
		"\t",
	)}\n`;
}

/** 生成注入到上游 HTML <head> 的标记块。 */
export function pwaHeadTags(): string {
	return [
		`<link rel="manifest" href="${MANIFEST_PATH}">`,
		`<meta name="theme-color" content="#1b66ff">`,
		`<meta name="mobile-web-app-capable" content="yes">`,
		`<meta name="apple-mobile-web-app-capable" content="yes">`,
		`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
		`<meta name="apple-mobile-web-app-title" content="DSH">`,
		`<link rel="apple-touch-icon" href="/__dsh_remote__/icon-192.png">`,
	].join("");
}

/**
 * 在 HTML 里注入 PWA 标记：优先插到 <head…> 开标签之后；
 * 没有 head 标签时插到文档最前（宽松处理，避免破坏上游页面）。
 */
export function injectIntoHtml(html: Buffer): Buffer {
	const text = html.toString("utf8");
	if (text.includes(MANIFEST_PATH)) return html;
	const headOpen = /<head(?:\s[^>]*)?>/i.exec(text);
	const out = headOpen === null
		? pwaHeadTags() + text
		: `${text.slice(0, headOpen.index + headOpen[0].length)}${pwaHeadTags()}${text.slice(headOpen.index + headOpen[0].length)}`;
	return Buffer.from(out, "utf8");
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
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "latin1"),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
	pngCache.set(size, png);
	return png;
}
