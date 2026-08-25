#!/usr/bin/env node
/**
 * 客户端 bundle 加载测试：在 Node 里模拟壳的 window.__ModuleLoader__ 与模块表，
 * 真实执行 lib/client.js 工厂体，验证：
 *   1. 包装器形状正确、工厂可执行（CJS 垫片生效）；
 *   2. 导出 apply/inject/name；inject 只依赖 slots（移动适配已移交给 Android App 注入）；
 *   3. apply 后保留 settings.plugin.item 卡片（key 对齐宿主命名空间）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm 严格布局：react 系 devDeps 在 plugin 包内解析
const pluginRequire = createRequire(join(repoRoot, "packages/plugin/package.json"));

const code = await readFile(join(repoRoot, "packages/plugin/lib/client.js"), "utf8");

// 模拟浏览器最小组面：卡片样式表安装只用到这些。
let loaded;
const styles = [];
function makeNode() {
	return {
		dataset: {},
		textContent: "",
		setAttribute(name, value) { this[name] = String(value); },
	};
}
globalThis.document = {
	querySelector() {
		return null;
	},
	createElement() {
		return makeNode();
	},
	head: {
		appendChild(node) {
			styles.push(node);
		},
	},
};
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded = definition;
		},
	},
};

/** 模块表：bundle 外部化的共享实例 */
function shellRequire(id) {
	if (id === "react" || id === "react/jsx-runtime" || id === "react-dom" || id === "react-dom/client") {
		return pluginRequire(id);
	}
	throw new Error(`模块表无法解析：${id}`);
}

// 执行工厂体
new Function("window", "require", code)(globalThis.window, shellRequire);

assert.ok(loaded !== undefined, "__ModuleLoader__.load 应被调用");
assert.equal(loaded.id, "dsh-remote-plugin");

const exports = loaded.factory(shellRequire);
assert.equal(typeof exports.apply, "function", "应导出 apply");
assert.deepEqual(exports.inject, ["slots"], "客户端插件只应依赖 slots 服务");
assert.equal(exports.name, "dsh-remote-plugin");
assert.ok(styles.length === 1 && styles[0].dataset.plugin === "dsh-remote-plugin", "应安装卡片样式表");

// ── SSR 渲染冒烟：抓组件渲染期崩溃 ──
// 卡片默认折叠，SSR 只渲染头部；展开态的表单在浏览器端由数据加载后渲染。
const React = pluginRequire("react");
const { renderToString } = pluginRequire("react-dom/server");
const html = renderToString(React.createElement(exports.DshRemoteSettingsCard));
for (const marker of ["DSH Remote", "手机远程访问本机 DSH", "xtcp + stcp", 'aria-expanded="false"']) {
	assert.ok(html.includes(marker), `渲染产物应包含「${marker}」`);
}
console.log("✓ SSR 渲染通过（折叠态头部完整，长度", html.length, "字符）");

// 模拟槽位上下文，验证设置卡片注册（且不再注册任何移动端槽位）。
const registrations = [];
const injected = [];
const ctx = {
	slots: {
		inject(name, callback) {
			injected.push(name);
			callback();
		},
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
};
exports.apply(ctx);

assert.deepEqual(injected, ["settings.plugin.item"], "只应注册设置卡片槽位");
assert.equal(registrations.length, 1);
const settings = registrations[0];
assert.equal(settings.options.id, "dsh-remote");
// 卡片 key 必须等于宿主半边 settings.register 的命名空间（dsh-remote），
// 否则设置页 describe() 对不上 key，卡片会被整个过滤掉。
assert.equal(settings.options.key, "dsh-remote");
assert.equal(typeof settings.component, "function", "设置卡片应为 React 组件函数");

console.log("✅ 客户端 bundle 与设置卡片注册全部通过");
