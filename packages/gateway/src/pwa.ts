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
		//
		// T49：原来这里是 `.catch(function(){})` —— 注册失败的原因被丢进黑洞，
		// 控制台零报错、getRegistrations() 只说「没有」不说「为什么没有」，
		// T44/T45 连续两轮都因此只能靠排除法列假设（真因是设备 WebView 上
		// SW 脚本抓取不经 WebViewClient、拿不到 SslErrorHandler 放行）。
		// 静默降级本身仍要保留（非安全上下文/不支持的浏览器不该影响页面），
		// 但失败必须留痕：console.error 一行 + window.__DSH_SW_ERROR__ 供
		// CDP/自动化直接读真值，不必再猜。
		`<script>if("serviceWorker"in navigator){navigator.serviceWorker.register("${SW_PATH}",{scope:"/"}).catch(function(e){var d=(e&&e.name||"Error")+": "+(e&&e.message||e);window.__DSH_SW_ERROR__=d;console.error("[dsh-remote] sw register failed: "+d);});}else{window.__DSH_SW_ERROR__="unsupported";}</script>`,
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
 * WEB-01：Service Worker 源码（白名单缓存策略，PERF-02 stale-while-revalidate）。
 *
 * 历史策略是「网络优先、失败回退缓存」且不区分请求类别：瞬断时
 * `/api/*`、`/__dsh_remote__/*` 动态接口可能命中过期缓存；未认证 +
 * 网络异常时还会命中缓存里的受保护 HTML → WS 401 → 白屏死锁，连登录页
 * 都回不去。现改为白名单制：
 *
 *   - 只有「静态资源扩展名」的同源 GET 请求可进缓存；
 *   - 导航请求、`/api/*`、`/__dsh_remote__/*`（登录/配对页、配对码、
 *     管理端点等）一律穿透网络，失败不回退缓存——认证相关的响应
 *     永远拿网关的实时判定，离线/瞬断时不会把过期受保护页面糊回给用户；
 *     网络恢复后导航自然回到登录页，不再有缓存造成的死锁。
 *
 * PERF-02：静态走 stale-while-revalidate —— 有缓存先秒渲染旧版，
 * 后台 revalidate 成功后更新缓存（下次打开即新版）；无缓存才等网络，
 * 失败回退缓存。二次打开不再被隧道全量下载卡住。
 *
 * T49：`/plugins/` 组合包的 URL 是 `plugins/?@…&rev=…`——第一个 `?` 就开始 query，
 * `url.pathname` 退化成 `/plugins/`。由此有三件事**必须同批**改，少一半就坏，
 * 其中两半组合起来直接白屏：
 *
 *   1. **白名单**：只按扩展名判 ⇒ `/plugins/` 被整条判掉，5.14MB 每轮满额重下
 *      （设备与桌面同病，与证书无关——见 T45 §3.6 / §5-9）。
 *   2. **cacheKey 必须是完整 URL（含 `rev`）且不带 `ignoreSearch`**：旧的
 *      `origin + pathname` + `ignoreSearch:true` 让三个包塌成同一个 key，先落
 *      缓存的 5MB 大包会被当成所有 `/plugins/` 请求的答案，喂给只想要 40KB 的
 *      `__ModuleLoader__.load()` ⇒ **白屏**（T44 已证，本轮有负控制复现）。
 *   3. **`/plugins/` 关掉 SWR 后台重验**：`rev` 是内容指纹，重验 100% 拿回同一
 *      份字节 ⇒ 每轮白送一次 5.14MB 流量。`/assets/*` 的 SWR 保持不变。
 *
 * `immutable` 保留不动：桌面端已经在吃它，设备端一旦 WebView 缓存落盘也立刻生效。
 *
 * 不在白名单内的请求不调用 respondWith，等价于完全不拦截。
 * 缓存名带版本号：策略/资源结构变更时改名即可在 activate 时清旧缓存。
 *
 * T49：v2 → v3 的原因只有一个 —— cacheKey 语义变了。v2 里按
 * `origin + pathname` 存的条目在新的「完整 URL」key 下永远匹配不上，
 * 留着只是垃圾（且 5MB 量级）。其余策略语义不变。
 */
export function renderServiceWorker(): string {
	return `/* DSH-Remote Service Worker —— 静态资源白名单缓存（WEB-01 + PERF-02 SWR + T49） */
"use strict";
var CACHE_NAME = "dsh-remote-static-v3";
var CACHEABLE = /\\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|eot|ico)$/i;

// T49：内容指纹资源（/plugins/ 的组合包）。包体由 query 选、版本由 query 里的
// rev=<内容指纹> 选 ⇒ pathname 永远只剩 /plugins/，扩展名正则看不见它。
// "内容变则 URL 变"成立，所以这类资源可以 cache-only，不必后台重验。
function isFingerprinted(pathname) {
	return pathname === "/plugins/" || pathname === "/plugins";
}

// ── T51（R6）：缓存上限 + 淘汰 + 写入失败可见 ──
//
// T50 §8 实测的退化曲线：每次上游插件集合变化 ⇒ 三个 /plugins/ 的 rev 全变 ⇒
// 新增 3 条 = 11,477,184 B 僵尸。旧的 rev 条目**永远不会再被命中**（cacheKey 含 rev），
// 而 activate 的清理只在**缓存名**变化时触发（pwa.ts:164 过滤 key !== CACHE_NAME），
// rev 变化不触发任何清理 ⇒ 无上限、无 LRU、每次变更 +11.5 MB。
//
// 这里补两样：
//   1. /plugins/ 按 **rev 个数**淘汰：只留最新的 PLUGIN_KEEP_REVS 个不同 rev，
//      旧 rev 条目先走（它们本来就再也命中不了）。
//   2. cache.put 失败**必须可见**：T50 §8.1 指出「静默吞掉 QuotaExceededError ⇒
//      用户从此每轮重下 5.6MB、控制台无任何提示」比白屏更难被发现。
//
// ⚠️ **没有字节数上限**（T53 修正 T51 的假承诺）：T51 声明过
// 「全缓存的条目数/**字节数**硬上限」并留了个 CACHE_MAX_BYTES 常量，但
// **全仓零引用** —— pruneCache 只用了 PLUGIN_KEEP_REVS 与 CACHE_MAX_ENTRIES。
// 注释在说谎，比没有上限更糟。现在把常量和这句话一起删掉，理由与替代手段：
//   - Cache API **不提供任何条目大小查询**（没有 sizeOf、没有 Content-Length 索引），
//     真要按字节计量就得在 put 时把长度另存（克隆响应加自定义头）、
//     再在每次淘汰时逐条 cache.match() 把头读回来 —— 那是每写一条多 N 次缓存读，
//     而 /plugins/ 单条 5.6MB、写入本来就贵，代价与风险都不小。
//   - 字节数并不是**唯一**的闸门：/plugins/ 的增长是 rev 驱动且 rev 已被 PLUGIN_KEEP_REVS
//     封顶（3 包/轮 × 9 rev），其余资源由 CACHE_MAX_ENTRIES 封顶条目数。
//   - 真到了浏览器配额，行为**不再是静默的**：reportCacheWriteFailure() 会 console.warn
//     + postMessage（见下），至少可观测。
//   ⇒ 实际生效的上限只有下面两个，文档与实现现在一致。
//
// ⚠️ PLUGIN_KEEP_REVS 的单位是**rev 个数**，不是「代」。
// T50 §2.3 实测：**同一次页面加载**里的三个 /plugins/ 包 rev 互异
// （10ddc612f195 / 34b08f499984 / 997566eab253）——它们是三个不同插件、三个不同指纹，
// 不是「同一代的三个包」。T50 §8.1 建议的「保留最新 2 代」若照字面实现成 2 个 rev，
// 就会在第一次加载就把三个包里的一个删掉 ⇒ **正是 T49 修掉的那个白屏**。
// 本轮把上限按「加载轮次」取：每次加载 3 个 rev，留 3 轮 = 9 个 rev。
// 真被改坏过一次：test:perf 的 T49「三个包各存各的」用例当场翻红（见 T51 报告 §4.2）。
var PLUGIN_KEEP_REVS = 9;
var CACHE_MAX_ENTRIES = 64;

function revOf(key) {
	var m = /[?&]rev=([0-9A-Za-z_.-]+)/.exec(String(key));
	return m ? m[1] : "";
}

function pathnameOf(key) {
	try { return new URL(key).pathname; } catch (err) { return String(key).split("?")[0]; }
}

/** 缓存写入失败要吵：console.warn + postMessage，绝不静默。 */
function reportCacheWriteFailure(url, err) {
	var name = (err && err.name) ? err.name : "Error";
	var text = String((err && err.message) || err);
	var msg = "[dsh-remote sw] 缓存写入失败 " + name + ": " + String(url) + " -- " + text
		+ "（本次不进缓存；配额不足时会退化成每次进入都重下，请检查存储配额）";
	try { console.warn(msg); } catch (ignoredConsole) { /* 老引擎没有 console */ }
	try {
		if (typeof self.postMessage === "function") {
			self.postMessage({ type: "dshr-cache-write-failed", url: String(url), name: String(name) });
		}
	} catch (ignoredPost) { /* 没有 postMessage 就算了，console 已经喊过 */ }
}

/**
 * 淘汰：/plugins/ 按代留最新 N 个 rev；再对全缓存做**条目数**上限。
 * 依赖 cache.keys() 的插入顺序（Cache API 规范保证按插入序返回）。
 *
 * ⚠️ 这里**没有**字节数上限（T53 删掉了 T51 那句假承诺与 CACHE_MAX_BYTES 常量，
 * 理由见常量定义处的注释：Cache API 查不到条目大小，真计量代价与风险都不小）。
 * 实际生效的上限只有：/plugins/ 的 PLUGIN_KEEP_REVS 个 rev + 全缓存 CACHE_MAX_ENTRIES 条。
 */
function pruneCache(cache, justStoredKey) {
	return cache.keys().then(function (keys) {
		var doomed = [];
		// 1) /plugins/：按 rev 个数只留最新 PLUGIN_KEEP_REVS 个（见上面单位说明）。
		var revOrder = [];
		var byRev = Object.create(null);
		keys.forEach(function (k) {
			if (!isFingerprinted(pathnameOf(k))) return;
			var r = revOf(k);
			if (!r) return;
			if (!(r in byRev)) { byRev[r] = []; revOrder.push(r); }
			byRev[r].push(k);
		});
		if (revOrder.length > PLUGIN_KEEP_REVS) {
			revOrder.slice(0, revOrder.length - PLUGIN_KEEP_REVS).forEach(function (r) {
				doomed = doomed.concat(byRev[r]);
			});
		}
		// 2) 硬上限：剔掉上面淘汰的之后还超，就从最旧的开始删。
		var kept = keys.filter(function (k) { return doomed.indexOf(k) === -1; });
		if (kept.length > CACHE_MAX_ENTRIES) {
			doomed = doomed.concat(kept.slice(0, kept.length - CACHE_MAX_ENTRIES));
			kept = kept.slice(kept.length - CACHE_MAX_ENTRIES);
		}
		return cache.keys().then(function (freshKeys) {
			var pending = [];
			doomed.forEach(function (k) { pending.push(cache.delete(k)); });
			if (!doomed.length) return 0;
			return Promise.all(pending).then(function () {
				console.warn("[dsh-remote sw] 缓存淘汰 " + doomed.length + " 条（/plugins/ 保留最新 "
					+ PLUGIN_KEEP_REVS + " 个 rev）");
				return doomed.length;
			});
		});
	}).catch(function () { return 0; });
}

/** 统一的写入口：写成功后顺带淘汰，写失败则**可见**。 */
function putCached(cache, key, res) {
	return cache.put(key, res).then(function () {
		return pruneCache(cache, key).catch(function () { return 0; });
	}).catch(function (err) {
		reportCacheWriteFailure(key, err);
		return 0;
	});
}

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
	// T49：内容指纹资源（/plugins/ 的组合包）单独记一路，见 isFingerprinted。
	var fingerprinted = isFingerprinted(url.pathname);
	// 白名单：静态资源扩展名，或上面那条显式前缀（T49：/plugins/ 没有扩展名，
	// pathname 恒为 /plugins/，扩展名正则会把它整条判掉 ⇒ 5.14MB 每轮满额重下）。
	if (!CACHEABLE.test(url.pathname) && !fingerprinted) return;
	// PERF-02 stale-while-revalidate：命中缓存即秒回，后台更新；
	// 未命中等网络（成功后写缓存），网络失败才回退缓存。
	// REVIEW-02：revalidate 用 cache:"no-cache" 真回源；
	// put 并入 waitUntil 链（SW 提前终止不丢更新）；整链兜底回退网络
	// （CacheStorage 抛错时不让静态请求直接失败，退化为旧网络优先行为）。
	event.respondWith(
		caches.open(CACHE_NAME).then(function (cache) {
			// T49：key 改成**完整 request.url**（含 rev 指纹），并去掉 ignoreSearch。
			// 少了任一半，三个 /plugins/ 包都会塌成同一个 key ⇒ 先落缓存的大包被
			// 喂给只想要小包的模块加载器 ⇒ 白屏。白名单与本行必须同批改。
			var cacheKey = request.url;
			return cache.match(cacheKey).then(function (cached) {
				// T49：内容指纹资源命中即返回，**不**起后台重验（rev 变了 URL 就变，
				// 重验 100% 拿回同一份字节，纯浪费一整轮 5.14MB 流量）。
				if (fingerprinted) {
					if (cached) return cached;
					return fetch(request).then(function (fresh) {
						if (fresh && fresh.ok) {
							try {
								// T51（R6）：走统一写入口（写后淘汰 + 失败可见），不再 .catch(function(){}) 静默吞。
								event.waitUntil(putCached(cache, cacheKey, fresh.clone()));
							} catch (waitErr) {}
						}
						return fresh;
					});
				}
				var networkUpdate = null;
				// T49：命中了 immutable 资源就别再 revalidate。immutable 的定义就是
				// 「在有效期内字节不会变」，重验必然拿回同一份内容 —— 实测每次进入
				// 仍白拉 /assets/* 的 475,608 B（logcat 里 5 次 pinnedFetch），
				// 纯浪费。/assets/ 是哈希文件名，本就该长命。
				var cachedCc = "";
				try { cachedCc = (cached && cached.headers && cached.headers.get("cache-control")) || ""; } catch (hdrErr) {}
				if (!/immutable/i.test(cachedCc)) {
					networkUpdate = fetch(request, { cache: "no-cache" }).then(function (fresh) {
					if (fresh.ok) {
						var cacheControl = fresh.headers.get("cache-control") || "";
						// REVIEW-02：no-cache 语义是"每次使用前必须校验"，SWR 的
						// "先给旧版"严格来说违反它——这类响应不进 SW 缓存（哈希
						// 文件名资源一般带长 max-age，仍吃得到 SWR 秒开；no-cache
						// 资源走 WebView 自带 HTTP 缓存做条件请求，正确性优先）。
						if (!/no-store|private|no-cache/i.test(cacheControl)) {
							var copy = fresh.clone();
							// T51（R6）：失败不再静默——可见地喊出来（见 reportCacheWriteFailure）。
							return putCached(cache, cacheKey, copy).then(function () { return fresh; });
						}
					}
					return fresh;
				}).catch(function () { return cached; });
				}
				if (cached) {
					// 后台 revalidate 的拒绝已在内部消化；这里只为延长 SW 存活。
					// 异步回调调 waitUntil 在个别引擎会抛 InvalidStateError，加固。
					try {
						if (networkUpdate && typeof networkUpdate.catch === "function") {
							event.waitUntil(networkUpdate.catch(function () {}));
						}
					} catch (waitErr) {}
					return cached;
				}
				return networkUpdate.then(function (fresh) {
					if (fresh) return fresh;
					throw new Error("dsh-remote sw: offline and not cached " + request.url);
				});
			});
		}).catch(function () { return fetch(request); })
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
