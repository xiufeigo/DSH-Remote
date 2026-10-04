/* DSH-Remote Service Worker —— 静态资源白名单缓存（WEB-01 + PERF-02 SWR + T49） */
"use strict";
var CACHE_NAME = "dsh-remote-static-v3";
var CACHEABLE = /\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|eot|ico)$/i;

// T49：/plugins/ 组合包。包体由 query 选、版本由 query 里的 rev=<内容指纹> 选
// ⇒ pathname 永远只剩 /plugins/，扩展名正则看不见它（所以白名单要单开一条）。
var FINGERPRINTED_PATH = /^\/plugins\/?$/;

// ── T63：内容寻址判据（只看 URL，不看响应头）──
// 三条任意一条成立即「内容变则 URL 变」：命中缓存直接返回，**不**发后台重验。
// HASHED_NAME 与 proxy.ts 的 HASHED_ASSET **逐字同形**：网关标 immutable 的
// 那些文件名，SW 一定也认成内容寻址 ⇒ 两边判定不会漂移。
var REV_QUERY = /[?&]rev=[0-9A-Za-z_.-]+/;
var HASHED_NAME = /\/[^/]*[.-][0-9A-Za-z_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico)$/;

/** 内容寻址 ⇒ 后台重验 100% 拿回同一份字节，纯浪费流量 ⇒ 绝不重验。 */
function isContentAddressed(url) {
	if (FINGERPRINTED_PATH.test(url.pathname)) return true;
	if (REV_QUERY.test(url.search)) return true;
	return HASHED_NAME.test(url.pathname);
}

/** T49 遗留别名：白名单用的就是「路径形如 /plugins/」这一条。 */
function isFingerprinted(pathname) {
	return FINGERPRINTED_PATH.test(pathname);
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
	// T49：内容指纹路径（/plugins/ 的组合包）单独记一路，白名单要单开一条。
	var fingerprinted = isFingerprinted(url.pathname);
	// 白名单：静态资源扩展名，或上面那条显式前缀（T49：/plugins/ 没有扩展名，
	// pathname 恒为 /plugins/，扩展名正则会把它整条判掉 ⇒ 5.14MB 每轮满额重下）。
	// ⚠️ T63：**白名单与下面的 cacheKey 仍是 T49 那一对，没有动**。
	// 本轮只把「要不要后台重验」换成 URL 判据（isContentAddressed），没有碰
	// 「拦不拦截」「用什么 key 存」这两件事 —— T49 的白屏正是这两半不同批改出来的。
	if (!CACHEABLE.test(url.pathname) && !fingerprinted) return;
	// T63：白名单里的请求分两路 ——
	//   · **内容寻址**（rev 指纹 / /plugins/ 组合包 / 哈希文件名）：命中即返回，
	//     **不发后台重验**。这类资源占 99.9% 的体积（/plugins/ 三包 11.5MB +
	//     /assets/* 约 2.9MB），重验一次就是一次全量白付。
	//   · **稳定 URL**（/favicon*.svg 这类）：SWR 保留，后台重验是它唯一的更新途径。
	// 其余机制与历史一致：命中缓存先秒回；未命中等网络（成功后写缓存）；
	// 网络失败才回退缓存。revalidate 用 cache:"no-cache" 真回源；put 并入
	// waitUntil 链（SW 提前终止不丢更新）；整链兜底回退网络（CacheStorage 抛错时
	// 不让静态请求直接失败，退化为旧网络优先行为）。
	event.respondWith(
		caches.open(CACHE_NAME).then(function (cache) {
			// T49：key 改成**完整 request.url**（含 rev 指纹），并去掉 ignoreSearch。
			// 少了任一半，三个 /plugins/ 包都会塌成同一个 key ⇒ 先落缓存的大包被
			// 喂给只想要小包的模块加载器 ⇒ 白屏。白名单与本行必须同批改。
			var cacheKey = request.url;
			return cache.match(cacheKey).then(function (cached) {
				// T63：内容寻址资源（rev 指纹 / /plugins/ 组合包 / 哈希文件名）
				// 命中即返回，**不**起后台重验——内容变则 URL 变，重验必然拿回
				// 同一份字节。主文档永远不走缓存（上面 mode==="navigate" 已 return），
				// 版本信号永远新鲜，所以这里不重验不牺牲任何正确性（详见文件头 T63 段）。
				if (isContentAddressed(url)) {
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
				// 到了这里 = **非**内容寻址（稳定 URL，如 /favicon*.svg）。
				// 这类资源 URL 不随内容变，后台重验是它唯一的更新途径 ⇒ SWR **有意保留**。
				// 再叠一条：上游显式声明 immutable 的，长寿命期内字节不会变，也不重验。
				var cachedCc = "";
				try { cachedCc = (cached && cached.headers && cached.headers.get("cache-control")) || ""; } catch (hdrErr) {}
				if (!/immutable/i.test(cachedCc)) {
					networkUpdate = fetch(request, { cache: "no-cache" }).then(function (fresh) {
					if (fresh.ok) {
						var cacheControl = fresh.headers.get("cache-control") || "";
						// REVIEW-02：no-cache 语义是"每次使用前必须校验"，SWR 的
						// "先给旧版"严格来说违反它——这类响应不进 SW 缓存（走 WebView
						// 自带 HTTP 缓存做条件请求，正确性优先）。
						// T63 更正旧注释：这一支**已经**收窄到「非内容寻址且非
						// immutable」的稳定 URL 资源。哈希文件名资源从 T63 起走
						// isContentAddressed() 分支，根本到不了这里——旧注释里
						// 「哈希文件名资源一般带长 max-age，仍吃得到 SWR 秒开」
						// 描述的是一条已经不存在的路径，删掉而不是留着误导后来人。
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
