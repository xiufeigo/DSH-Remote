#!/usr/bin/env node
/**
 * 把网关的 Service Worker 源码渲染进 APK 的 res/raw/dsh_sw.js（T49 / WEB-01）。
 *
 * 为什么要这一步：WebView 的 Service Worker 脚本抓取由**浏览器进程的 SW 子系统**
 * 发起，不经过 WebViewClient，因此 `onReceivedSslError → handler.proceed()`
 * 放行不到它 ⇒ 自签证书下 `register()` 必失败
 * （SecurityError: An SSL certificate error occurred when fetching the script.，
 *  见 scratch/t45/report.md §2）。
 * 解法是 App 用 `ServiceWorkerController.setServiceWorkerClient()` 把这个脚本
 * 从 APK 里**本地供给**——不经网络 ⇒ 证书不参与 ⇒ pin/TOFU 一行不改。
 *
 * 单一源 = packages/gateway/src/pwa.ts 的 renderServiceWorker()（与网关
 * /__dsh_remote__/sw.js 路由下发的是同一份源码）。本脚本只做「渲染 + 写字节」，
 * 不做任何编码转换；res/raw/dsh_sw.js 是生成物，**禁止手改**（与 res/raw/mobile.js
 * 同一约定，WEB-02 单一源模式的延续）。
 *
 * 用法：node android/sync-sw-asset.mjs <目标路径>
 * 需 node>=24（直接 import .ts 的类型剥离，与 scripts/test-perf-opt.mjs 同要求）。
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = resolve(process.argv[2] ?? resolve(here, "app/src/main/res/raw/dsh_sw.js"));
// android/ → 仓库根 → packages/gateway/src/pwa.ts
const pwaModule = resolve(here, "../packages/gateway/src/pwa.ts");

// Windows 上绝对路径必须转成 file:// URL 才能被 ESM loader 接受
// （ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'）。
const { renderServiceWorker } = await import(pathToFileURL(pwaModule).href);
const source = renderServiceWorker();

// 生成的 SW 会被注册执行，写坏一条就是设备上整片白屏 —— 渲染后立刻自检语法。
// 用 new Function 解析（不执行）：只验「能不能被解析成函数体」。
new Function(source);

if (!source.includes("addEventListener(\"fetch\"")) {
	throw new Error("渲染出的 SW 缺少 fetch 监听，单一源 renderServiceWorker() 可能已变");
}

writeFileSync(dest, source, "utf8");
process.stdout.write(`== 已渲染 Service Worker 单一源（${Buffer.byteLength(source, "utf8")} 字节）→ ${dest} ==\n`);
