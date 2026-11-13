# AGENTS.md

DSH-Remote：让手机访问本机 DSH Desktop 的旁路网关。pnpm monorepo，Node >= 24（网关直接跑 `.ts`，无构建）。

## 结构

- `packages/gateway/`：网关（HTTPS 反代 + 认证 + frp 托管）。`assets/mobile-web.js` 是移动 hook 的唯一源。
- `packages/plugin/`：DSH Cordis 插件。`lib/client.js` 是入库的构建产物（`pnpm -C packages/plugin build`，CI 要求重建后无 diff）。
- `android/`：Java 壳 App，手工工具链（`android/build.ps1`，无 Gradle）。
- `scripts/`：全部测试与运维脚本；`scratch/` 不入库，放实验与证据。

## 验证命令

- 类型：`pnpm typecheck`
- 快测（与 CI 一致）：`pnpm smoke`、`smoke:edge`、`test:routes`、`test:lock`、`test:frp`、`test:visitor`、`test:session`、`test:fixes`、`test:perf`、`test:desktop`、`test:security`
- 需要本机 Chrome：`pnpm test:mobile`、`test:official-shell`、`test:terminal`
- 需要 frp 二进制（`~/.dsh-remote/vendor/frp`）：`pnpm smoke:edge:frp`、`smoke:dual:frp`
- 其余：`pnpm test:client`、`test:plugin`、`node --test scripts/test-ws-keepalive.mjs`、`node scripts/test-resume-recovery.mjs`
- `pnpm test:device` 需要 18443 上有真网关，没有就自动跳过。

## 必须遵守

- 改 `packages/gateway/assets/mobile-web.js` 后必须 `cp` 到 `android/app/src/main/res/raw/mobile.js`（测试要求逐字节相同）；Android 端要重新打 APK 才生效。
- `android/app/src/main/res/raw/dsh_sw.js` 由 `node android/sync-sw-asset.mjs` 从 `pwa.ts` 渲染，禁止手改；`/__dsh_remote__/sw.js` 路由必须保持 `.end(renderServiceWorker())`（有测试钉住）。
- 工作区是 CRLF（`core.autocrlf=true`），编辑时保持原行尾；`android/build.ps1` 是带 BOM 的 UTF-8。
- 测试自己起网关（临时目录 + 系统分配端口）。不要动 18443 端口上的进程和真实的 `~/.dsh-remote`。
- 版本号只能用 `pnpm ver:bump` 改（见 `docs/versioning.md`）；变更记在 `CHANGELOG.md` 顶部的「待发布」段。
- 性能结论先量后改：hook 的流式基准在 `scratch/perf-20261113/bench-hook.mjs`（`--mode=android|web --pace=raf|flood`），网关在 `bench-gateway.mjs`。
