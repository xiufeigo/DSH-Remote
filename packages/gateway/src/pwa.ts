/**
 * PWA 支持：manifest 与图标由网关自己提供；对上游 HTML 注入引用标记。
 * 手机「添加到主屏幕」即可全屏运行，观感接近原生 App。
 */

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
				{ src: "/__dsh_remote__/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
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
		`<link rel="apple-touch-icon" href="/__dsh_remote__/icon.svg">`,
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
