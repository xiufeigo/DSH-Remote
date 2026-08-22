import { defineConfig } from 'tsdown'

/**
 * 仅浏览器半边需要打包（宿主半边 lib/index.js 是手写零依赖 ESM）。
 *
 * 外部化共享模块：react / react-dom / primitives 复用壳的实例；
 * 其余 import 全部内联 —— 模块表答不出的 require() 是必然的运行时抛错。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

export default defineConfig([
  {
    name: 'dsh-remote-plugin/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
    },
    // NOTE: CJS module/exports 垫片必须放在 banner（tsdown 0.22 会丢弃
    // 顶层 intro，垫片放那里到不了产物，工厂体执行时会抛
    // `exports is not defined` 拖垮整个插件图）—— dsh-explorer 的教训。
    banner: 'window.__ModuleLoader__.load({ id: "dsh-remote-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
