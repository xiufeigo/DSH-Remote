#!/usr/bin/env node
/**
 * 客户端 bundle 加载测试：在 Node 里模拟壳的 window.__ModuleLoader__ 与模块表，
 * 真实执行 lib/client.js 工厂体，验证：
 *   1. 包装器形状正确、工厂可执行（CJS 垫片生效）；
 *   2. 导出 apply/inject/name；
 *   3. apply 后向 settings.plugin.item 槽位注册卡片组件。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(join(repoRoot, "package.json"));
// pnpm 严格布局：react 系 devDeps 在 plugin 包内解析
const pluginRequire = createRequire(join(repoRoot, "packages/plugin/package.json"));

const code = await readFile(join(repoRoot, "packages/plugin/lib/client.js"), "utf8");

// 模拟壳环境
let loaded;
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
assert.ok(Array.isArray(exports.inject), "应导出 inject");
assert.equal(exports.name, "dsh-remote-plugin");

// 模拟槽位上下文，验证设置卡片注册
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

assert.deepEqual(injected, ["settings.plugin.item"], "应注入 settings.plugin.item 槽位");
assert.equal(registrations.length, 1);
assert.equal(registrations[0].options.id, "dsh-remote-plugin");
assert.equal(registrations[0].options.key, "dsh-remote-plugin");
assert.equal(typeof registrations[0].component, "function", "卡片应为 React 组件函数");

console.log("✅ 客户端 bundle 加载与槽位注册全部通过");
