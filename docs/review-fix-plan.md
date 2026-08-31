# DSH-Remote 全面审查修复计划

> 审查日期：2026-07-14 · 版本基线：`0.1.1-rc.2.6`
> 审查方式：7 个并行专项审查（网关核心健壮性 / 网关 IO 与进程健壮性 / 代码简洁性 /
> Cordis 插件规范 / Android 开发 / Web 功能 / 部署脚本与文档一致性），
> 全部发现经人工对照源码逐条核验，**已剔除 15 条与代码不符的误报**（见附录 A）。

---

## 1. 总评

DSH-Remote 整体工程质量良好：安全基线扎实（Token 只存 SHA-256、`timingSafeEqual`
恒定时间比对、Cookie 纵深防御、设备 Cookie 不上行、审计日志），零重依赖的克制设计与
项目定位匹配，Cordis 插件与 DSH 宿主的加载器 / 模块表 / 设置槽位协议深度契合，
Android 壳的证书 TOFU 流程有指纹归一化保护。

但存在 **1 个 P0 级安全语义缺陷**（配对码"用后即焚"可被并发突破）与 **16 个 P1 级
问题**，集中在四类：

1. **认证与限流在 edge 反代拓扑下失真**（`trustProxyXff` 配置项形同虚设，Caddy 后
   所有客户端都呈现为 127.0.0.1，一人被锁全员被锁）；
2. **反代管道缺少超时/重定向改写/压缩响应处理**，慢速攻击与白屏隐患并存；
3. **Android 生命周期欠账**（无 `onDestroy`、`dataSync` 前台服务撞 Android 14+ 时限、
   前台服务早停路径违反 `startForegroundService` 契约）；
4. **发布链路断裂**（CI 每次发版生成全新签名密钥，APK 无法覆盖升级；
   插件安装绕过宿主标准 bundle patch 流，宿主升级后失效且无自愈）。

## 2. 缺陷统计（核验后）

| 级别 | 数量 | 定义 |
|---|---:|---|
| P0 | 1 | 安全语义被突破 |
| P1 | 16 | 功能性 bug / 明显健壮性缺口 / 发布阻断 |
| P2 | 27 | 边界缺陷 / 规范偏离 / 可维护性隐患 |
| P3 | 19 | 轻微加固与体验 |
| 合计 | 63 | |

## 3. 分阶段修复路线

| 阶段 | 范围 | 预估工作量 | 出口标准 |
|---|---|---|---|
| **阶段 0（热修）** | SEC-01、GW-03、GW-07、CI-01 | 1–2 天 | 配对码并发测试通过；edge 限流按真实 IP 生效；发版签名稳定 |
| **阶段 1（P1 健壮性）** | 其余 13 项 P1 | 1 周 | `pnpm smoke` / `smoke:edge` 全绿 + 新增用例全绿 |
| **阶段 2（P2）** | 27 项 | 2–3 周 | 各模块验收标准逐条勾销 |
| **阶段 3（P3 + 长期重构）** | 19 项（含 AND-11 Gradle 化等长期项） | 随迭代排期 | — |

---

## 4. 阶段 0：立即修复（P0 + 高危）

### SEC-01 [P0] 配对码核销存在 TOCTOU 竞态，"用后即焚"可被并发突破
- **位置**：`packages/gateway/src/store.ts:196-206`（`consumePendingCode`），
  消费方在 `packages/gateway/src/server.ts` 配对路由
- **问题**：`readJson → 校验 → writeAtomic("")` 之间存在异步 I/O 间隙。两个并发的
  `POST /__dsh_remote__/pair`（同一配对码）都能读到未消费的码、都返回 `true`、
  各自换取一个长效设备 Token，直接破坏一次性语义。（注意：实际是单码文件而非码数组，
  但竞态同样成立。）
- **修复**：在 `Store` 内维护进程级同步核销闸——用内存中的同步检查（如
  `consumedCodes: Set<string>` 或"当前待消费码"单值比对后**同步**置空）先完成原子
  核销，再异步持久化清空；或对所有写路径引入 Promise 链互斥。多实例并发由 CLI-01
  的进程锁兜底。
- **验收**：并发 10 路相同配对码压测，仅 1 路成功换得设备。

### GW-03 [P1] edge 反代拓扑下限流/锁定全面失真（`trustProxyXff` 形同虚设）
- **位置**：`packages/gateway/src/auth.ts:103-106`（`clientIp` 只返回
  `req.socket.remoteAddress`）；`packages/gateway/src/config.ts` 声明了
  `trustProxyXff?: boolean`；`deploy/docker/docker-compose.yml:57` 下发
  `DSHR_TRUST_PROXY_XFF` 但代码完全不读
- **问题**：edge 部署在 Caddy 之后时，所有客户端 IP 均为 `127.0.0.1`——任一外部
  攻击者触发配对失败锁定，会把**全部**正常用户锁 15 分钟；限流也完全失效。
  另外未归一化 `::ffff:1.2.3.4` 形式的 IPv4 映射地址。
- **修复**：
  1. `clientIp(req, config)`：仅当 `trustProxyXff === true` **且**
     `remoteAddress` 属于回环/可信反代网段时，取 `x-forwarded-for` 最左一跳；
  2. 归一化 `::ffff:` 前缀；
  3. `Caddyfile.example` 增注：必须保留 `trusted_proxies` 与 `X-Forwarded-For`
     头覆写，不可允许外部直接提交该头（Caddy 默认会覆写，需在文档固化）。
- **验收**：edge + Caddy 下两台不同设备触发限流互不影响；伪造直连请求的
  `X-Forwarded-For` 不被采信。

### GW-07 [P1] POSIX 数据目录与敏感文件未收紧权限
- **位置**：`packages/gateway/src/store.ts:55-62`（`Store.open`）、`store.ts:70-76`
  （`writeAtomic`）
- **问题**：`secrets.json`（frp 登录密钥/访客密钥/门禁 Token 哈希）、
  `devices.json` 按默认 umask（常为 0644）落盘，同机其他用户可读。
- **修复**：POSIX 下 `mkdir` 后 `chmod 0o700`（state/logs/certs/frp 各目录），
  `writeAtomic` 写文件传 `{ mode: 0o600 }`；对已存在目录启动时收敛一次权限。
- **验收**：全新初始化后 `ls -l ~/.dsh-remote/state` 全为 600/700。

### CI-01 [P1] Release CI 每次生成临时 Keystore，APK 签名不连续
- **位置**：`.github/workflows/release.yml:43-47`（无 keystore secret），
  `android/build.ps1`（缺省路径就地 `keytool -genkeypair`）
- **问题**：GitHub runner 干净环境每次打 tag 都生成新密钥 → 每个 Release 的 APK
  签名互不相同，用户升级被 Android 拦截（须卸载重装，丢失本地配置）。
- **修复**：
  1. 仓库 Secrets 配置 `RELEASE_KEYSTORE_BASE64` / `RELEASE_KEYSTORE_PASS` /
     `RELEASE_KEY_ALIAS`；
  2. `release.yml` 构建前解码写入 `~/.android/dsh-remote.jks` 并经环境变量传密码；
  3. `build.ps1` 区分"本地开发自动生成"与"发布构建必须显式提供"，发布路径缺
     密钥直接失败。
- **验收**：连续两个测试 tag 产出的 APK 用 `apksigner verify` 比对，签名一致。

---

## 5. 阶段 1：P1 健壮性修复（13 项）

### 5.1 网关反代管道（3 项）

#### GW-04 上游请求无超时 + 慢速请求体防护
- **位置**：`packages/gateway/src/proxy.ts:78-152`
- **问题**：`upstreamReq` 未设任何超时；请求体 `req.pipe(upstreamReq)` 无速率/总量
  约束，Slow POST 可长时间占用连接。
- **修复**：`upstreamReq.setTimeout(60_000)`（DSH 长任务接口除外，见下）超时销毁并
  回 504；给请求体设置与场景匹配的总量上限（配对/管理类已限 64KB，代理转发按
  业务上限设 50MB 并限速）。注意：DSH 的 SSE/大响应走流式，超时只应作用于
  **请求阶段与空闲**，不可误杀活跃流（用 `setTimeout` 的 socket-idle 语义）。
- **验收**：上游挂起时 60s 内返回 504；slowloris 压测不再耗尽连接。

#### GW-05 上游重定向 `Location` 未改写，泄漏内网地址
- **位置**：`packages/gateway/src/proxy.ts:93-97`（响应头原样拷贝）
- **问题**：上游 301/302 若含绝对地址（`http://127.0.0.1:<port>/...`），手机浏览器
  直接跳内网地址，页面白屏。
- **修复**：响应头转发时若 `location` 含上游 authority，改写为相对路径（去
  `scheme://authority` 前缀）。
- **验收**：构造上游 302 `Location: http://127.0.0.1:PORT/x` 的用例，客户端收到
  相对路径。

#### GW-06 HTML 注入未处理压缩响应（合并 Web 审查同源发现）
- **位置**：`packages/gateway/src/proxy.ts:100-136`、`packages/gateway/src/pwa.ts:84-101`
- **问题**：`accept-encoding` 被原样转发给上游（`buildUpstreamHeaders` 不剥该头），
  一旦上游（或未来的前置代理）返回 `content-encoding: gzip/br`，`toString("utf8")`
  得到乱码，注入失败且浏览器解码报错白屏。当前 DSH 上游不压缩，属**低概率但后果重**
  的防御缺口。
- **修复**：最简方案——`buildUpstreamHeaders` 中对可能注入的 `text/html` 请求
  直接置 `accept-encoding: identity`（一行改动，根治）；非 HTML 请求保留原
  `accept-encoding`（顺带修复"静态资源被强制去压缩"的潜在反方向问题）。
  进阶可选：支持 `zlib` 解压注入后透传。
- **验收**：模拟上游返回 gzip HTML（测试桩），页面正常渲染且注入生效。

### 5.2 网关状态与持久化（2 项）

#### GW-01 `writeAtomic` 在 Windows 遇文件锁失败无重试、无清理
- **位置**：`packages/gateway/src/store.ts:70-76`
- **问题**：（已核验纠正：Node 的 `rename` 在 Windows 可覆盖已存在文件，真实风险
  不是 EEXIST，而是杀毒/索引服务持锁时的 `EPERM/EBUSY`）失败后直接抛错中断配对/
  吊销/回写，且遗留 `.tmp` 文件。
- **修复**：对 `EPERM/EBUSY/EACCES` 做最多 3 次指数退避重试；`finally` 清理 tmp。
- **验收**：单测注入一次 `rename` 失败后重试成功；无临时文件残留。

#### GW-09 `autoFixUpstreamPort` 把运行时环境变量永久写回磁盘
- **位置**：`packages/gateway/src/server.ts:120-121`、`packages/gateway/src/cli.ts:115`
  （`applyEnvOverrides` 与磁盘配置合并为同一对象后整体 `saveConfig`）
- **问题**：edge 容器全靠 `DSHR_*` 环境变量配置；首次端口回写会把全部环境覆盖值
  （角色、监听面、断点等）永久烙进挂载卷的 `config.json`，之后改环境变量不再生效，
  且与"配置等价手改文件"的承诺冲突。
- **修复**：保存时只回写**增量**——以磁盘原始补丁对象为基础仅更新 `upstreamPort`
  字段后写回（`Store` 保留加载时的原始 patch 副本），或明确区分
  `persistedConfig` 与 `runtimeConfig` 两个对象。
- **验收**：带 3 个 `DSHR_*` 覆盖启动并触发回写后，`config.json` 只新增
  `upstreamPort`，其余字段不变；重启后环境变量覆盖仍生效。

### 5.3 网关资源与防护（2 项）

#### GW-02 `RateLimiter` 桶无淘汰，长期运行内存单调增长
- **位置**：`packages/gateway/src/auth.ts`（`buckets: Map<string, Bucket>`）
- **问题**：公网扫描场景下每个来源 IP 建桶永不清理 → OOM（edge 角色暴露面大）。
- **修复**：每 5 分钟清理 `hits` 全过期且未锁定的桶；设容量上限（如 20 000），
  超限按最老活跃时间淘汰。
- **验收**：单测模拟 5 万个一次性 IP 后，桶数量回落至活跃集。

#### SEC-02 管理端点 `JSON.parse` 未捕获 → 畸形请求 500
- **位置**：`packages/gateway/src/server.ts` `handleAdmin` 的 `/admin/revoke` 等
  POST 分支
- **修复**：统一 `tryParseJson` 包装，`SyntaxError` 回 400。

### 5.4 Web / PWA（2 项）

#### WEB-01 Service Worker 缓存未隔离认证与动态接口
- **位置**：`packages/gateway/src/pwa.ts`（SW fetch 策略：网络优先、失败回退缓存）
- **问题**：① `/api/*`、`/__dsh_remote__/*` 动态接口在瞬断时可能命中过期缓存；
  ② 未认证 + 网络异常时命中缓存的受保护 HTML → WS 401 → 白屏死锁，无法回到登录页。
- **修复**：SW `fetch` 白名单制——仅缓存静态资源扩展名；导航请求、`/api/*`、
  `/__dsh_remote__/*` 一律穿透网络，失败不回退缓存。
- **验收**：新增测试：离线命中缓存后导航仍能进入登录页。

#### WEB-02 `mobile.js` 双份拷贝已分叉
- **位置**：`android/app/src/main/res/raw/mobile.js` 与
  `packages/gateway/assets/mobile-web.js`（`src/mobile.ts:2` 的注释自认是
  "宽度断点 fork"；断点处理、横竖屏细节已不一致）
- **问题**：任一端修了 DSH 类名兼容 bug，另一端静默失效。
- **修复**：建立单一源（如 `shared/mobile-hook.js` 或 `packages/gateway/assets`
  为源），Android 构建脚本（`build.ps1`）在打包时拷贝/生成 `res/raw/mobile.js`；
  平台差异用注入变量（`__DSHR_MOBILE__` / `isAndroidShell()`）而非两份代码表达。
- **验收**：两份产物由同一源生成，diff 为空（或仅平台开关差异）。

### 5.5 Android（3 项）

#### AND-01 前台服务早停路径违反 `startForegroundService` 契约
- **位置**：`android/.../TunnelService.java:81-84`（`profile == null` 时直接
  `stopSelf()` 返回）
- **问题**：（已核验纠正：`onStartCommand` 并不读 `intent`，不存在 NPE；真实风险
  在此）若该次启动经由 `startForegroundService()`，5 秒内未调用
  `startForeground()` 即退出，Android 8+ 抛
  `did not then call Service.startForeground()` 崩溃/ANR。
- **修复**：该分支先 `stopForeground(STOP_FOREGROUND_REMOVE)` 再 `stopSelf()`。

#### AND-02 `dataSync` 前台服务撞 Android 14+ 时限 + 通知缺停止操作
- **位置**：`AndroidManifest.xml`（`foregroundServiceType="dataSync"`）、
  `TunnelService.java:108-112`、`buildNotification`
- **问题**：Android 14+ 对 `dataSync` 有累计时长限制（默认 6 小时内系统可杀），
  隧道属于长时代理场景；且前台通知无"断开"按钮，只能进 App 操作。
- **修复**：
  1. FGS 类型改为 `specialUse`（声明用途 + 审核材料）或按分发渠道策略处理；
  2. 通知增加 `addAction("断开", ACTION_STOP PendingIntent)`。

#### AND-03 `MainActivity` 无 `onDestroy`，WebView 从不销毁
- **位置**：`android/.../MainActivity.java`（全文件仅 `onPause`，无 `onDestroy`）
- **问题**：非静态内部类 `AppBridge` 经 `addJavascriptInterface` 被 WebView 持有，
  Activity 退出/重建时 Chromium 内核与 Context 全部泄漏。
- **修复**：实现 `onDestroy`：`removeJavascriptInterface` → `removeView` →
  `stopLoading` → `destroy()`；配合 GW 线程池（AND-06）取消在途任务。

### 5.6 Cordis 插件（1 项）

#### PLG-01 安装流程绕过宿主标准 bundle patch 流，宿主升级后失效且无自愈
- **位置**：`packages/plugin/scripts/install.mjs:79-99`（向
  `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加 insert 行）
- **问题**：（已核验纠正：脚本并不篡改 `payload/app`；`package.json` 也已声明
  `dsh.bundle.patch`。）真实风险：DSH Desktop 升级/重装会重置用户 profile 的
  `cordis.patch.yml` 与 `node_modules` 链接，插件静默失效，且无检测/修复手段。
- **修复**：
  1. `install.mjs` 追加前备份原文件（`.bak`），记录所适配的宿主版本；
  2. 提供 `node scripts/install.mjs --repair`（或网关 `dsh-remote doctor` 增加
     插件链接体检项）：检测 patch 行缺失/链接断裂并重建；
  3. 插件宿主侧启动时若检测到 `webServer.register` 失败，日志提示运行修复命令。

---

## 6. 阶段 2：P2 修复清单（27 项）

### 6.1 网关（9 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| GW-12 | `proxy.ts:93-97` | 未处理上游 `content-security-policy` 响应头：内联 `<script>`（SW 注册、`__DSHR_MOBILE__` 断点变量）在上游启用严格 CSP 的版本上会被拦截（当前上游无 CSP，故定 P2） | HTML 改写路径重写 `content-security-policy[-report-only]` 放行注入路径；或把内联脚本全部改为 `/__dsh_remote__/*` 外链（更彻底，推荐与 WEB-01 一起做） |
| GW-10 | `proxy.ts:54` | Origin 死三元：`typeof x === "string" ? a : a` 两分支相同，无 Origin 的请求也被强注 `Origin` | 仅当原请求含 `origin` 头时改写 |
| GW-11 | `server.ts` `readBody` | 超 64KB 直接 `req.destroy()`，客户端只见 RST | 先回标准 `413` 再关流 |
| GW-13 | `server.ts`（925 行） | 单文件混 5 类职责（双角色路由/WS 升级/SSE/登录页模板/限流） | 拆 `routes/views.ts`（HTML 模板）、`ws.ts`（升级转发）、`sse.ts`；`server.ts` 只留初始化与分发 |
| GW-16 | `proxy.ts:117-129` | 注入缓冲在超 2MB 前已累积全部分块（GC 抖动） | `content-length` 已知且超限时直接走流式直通，不进缓冲 |
| FRP-01 | `frp.ts:341-348` | `stop()` 的 SIGKILL 兜底定时器从不 `clearTimeout`，优雅退出多挂 3 秒事件循环 | `exit` 触发时清理定时器 |
| FRP-02 | `frp.ts:314-335` | `backoffMs`/`restarts` 永不复位，长期稳定运行后的偶发崩溃仍吃 30s 延迟 | 子进程稳定 60s 后归零 |
| FRP-03 | `frp.ts:343` | Windows 下仅杀直接子进程；网关被硬杀时 frpc 成孤儿占端口 | win32 用 `taskkill /pid <pid> /T /F`；文档注明硬杀风险 |
| CLI-01 | `cli.ts` `cmdStart` | 无单实例锁，双开网关并发写 `state/` 文件 | `fs.open(lock, "wx")` 排他锁 + 启动失败提示；解锁兜底删除 |

### 6.2 CLI / 配置（3 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| CLI-02 | `cli.ts:122-129` | 连按 Ctrl+C 时 `quit()` 并发重入，`server.stop()` 二次 `close()` 抛 `ERR_SERVER_NOT_RUNNING` 成未捕获 rejection | `isStopping` 防重入 + `.catch()` |
| CLI-03 | `cli.ts:31-45` | `parseArgs` 不认 `--flag=value` | `split("=", 2)` 拆分 |
| PLG-02 | `gateway/src/config.ts` + `plugin/lib/config-schema.js` + `plugin/lib/index.js:476-499` | 配置校验三轨：网关 TS 校验、插件手写 JS 校验、Cordis settings schema 各一份；且 `buildSettingsSchema` 只有 `frpEnabled`/`serverAddr` 两个残留字段，与 README 宣称的面板能力脱节 | 单一真相源：插件宿主侧直接复用网关校验（import 或生成）；`buildSettingsSchema` 与真实 `GatewayConfig` 对齐，清理 `frpEnabled` 扁平字段 |

### 6.3 Cordis 插件（3 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| PLG-03 | `scripts/smoke.mjs` / `smoke-edge.mjs` / `smoke-edge-frp.mjs` / `test-plugin-routes.mjs` | 进程拉起、输出等待、TLS fetch、清理队列等脚手架 70%+ 重复 | 抽 `scripts/test-harness.mjs`：`createTestGateway` / `requestTls` / `wsConnect` / `autoCleanup` |
| PLG-04 | `packages/plugin/lib/index.js`、`lib/config-schema.js`（手写）对 `src/client/index.tsx`（构建） | `lib/` 既是构建产物又含手写源码；宿主侧无类型检查，网关结构改名无编译期保护 | 迁移至 `src/server/*.ts`，tsdown 统一产出到 `lib/`；`lib/` 入 `.gitignore` |
| PLG-05 | `plugin/lib/index.js:27-35` `locateGatewayCli` | 依赖 monorepo 相对路径 + `require.resolve` 兜底；tarball/npm 独立分发时失效，且无覆盖入口 | 优先 `process.env.DSH_REMOTE_GATEWAY_CLI`；增加 `~/.dsh-remote/gateway/` 候选；找不到时给出明确诊断 |

### 6.4 Web / 设置面板（3 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| WEB-03 | `plugin/src/client/index.tsx` `save`/`restartGateway`/`load` | 重启按钮不受 `saving` 锁约束可连点；`load()` 无 `AbortController`，慢响应可覆盖新输入 | 操作区统一忙碌锁；请求级 `AbortController`，新请求/卸载时 abort 旧请求 |
| WEB-04 | `android/.../mobile.js` `invokeReactOnClick` | 直接摸 `__reactProps$`/`__reactFiber$` 调 `onClick`；React 升级或宿主改用其他事件即失效，`eventStub` 缺 `nativeEvent` 易抛错 | 首选 `dispatchEvent(new MouseEvent('click', {bubbles:true}))`；Fiber 探测仅兜底并补防御字段 |
| WEB-05 | `android/.../mobile.js` document 级 `touchmove` 捕获 | 横向可滚动子容器（`pre`/表格/Tabs）上的横滑被抽屉手势 `preventDefault` 吃掉 | 手势起点在可横滚容器内（`overflow-x: auto/scroll` 且 `scrollWidth > clientWidth`）时放弃接管 |

### 6.5 Android（5 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| AND-04 | `FrpcManager.java:37-67` | `Runtime.exec` 执行伪装成 `libfrpc.so` 的 ELF，违背 Android 对 native 目录二进制的政策方向（严格 SELinux ROM/未来版本可被拒），崩溃无法捕获 | 中期：`gomobile bind`/cgo 编出真 JNI 库，线程内调用 `Frpc.run(config)`；短期：保留现状但在 `README` 标注支持矩阵并加启动失败降级提示 |
| AND-05 | `android/build.ps1:107-111` | 默认签名密码 `dsh-remote-dev-2025` 硬编码，公开仓库下等于发布签名外泄 | 发布路径强制环境变量/交互输入；默认密码仅限显式 `--dev` |
| AND-06 | `MainActivity.java:570,807`、`FrpcManager.java:75,93`、`TunnelService.java:90` | 裸 `new Thread` 散布，等待轮询线程持有 Activity 引用，退出后空转泄漏 | 统一 `ScheduledExecutorService`（Activity 级），`onDestroy` 时 `shutdownNow()` |
| AND-07 | `ProfileStore.BIND_PORT=16225`、`FrpcManager` 端口检查 | 端口被占即失败，无协商 | 16225–16235 探测首个空闲端口，实际端口传给 WebView 加载 URL |
| AND-08 | `MainActivity.java:1672-1686` `handleSslError` | （已核验：指纹比对本身有归一化，不存在"格式误杀"。）残留风险：`getX509Certificate()` 返回 `null` 时静默 `handler.cancel()`，用户只见"校验失败"无原因 | 提取失败时弹明确错误（含重试），日志记录设备 API 级别；对 API 24–27 增加备用提取路径验证 |

### 6.6 部署脚本与文档（4 项）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| OPS-01 | `scripts/install-edge.sh:1-2`、`scripts/install-frps.sh:1-2` | 未 `set -euo pipefail`；`curl \| tar` 左侧失败被掩盖 | 加严格模式；下载后校验文件大小/退出码再解压 |
| OPS-02 | `scripts/install-edge.sh:105-131` | Node tarball 无 SHASUMS 校验 | 拉 `SHASUMS256.txt` 后 `sha256sum --check` |
| OPS-03 | 两个安装脚本的 `--token` 解析 | `--token ""` 可写入空 Token，门禁形同虚设 | 参数解析后统一判空回落自动生成 |
| OPS-04 | `scripts/install-edge.sh:91-96` | 重复执行/上次中断后 `~dsh-remote` 属主可能错乱 → 服务启动 EACCES | 用户判断块外无条件 `chown -R dsh-remote:dsh-remote` 相关目录 |

---

## 7. 阶段 3：P3 加固与体验（19 项）

### 网关 / CLI（7 项）
1. **GW-14** `verifyAccessToken` 限制输入长度上限（如 256），拒绝超长 Token 的无谓哈希（`auth.ts`）。
2. **GW-15** `safeNext` 增加长度上限（如 512）（`server.ts`）。
3. **GW-17** 统一 `bindPort`/`serverPort` 术语：注释与 UI 文案建立对照表，以 frp 官方字段为准（`config.ts`、`plugin/src/client/index.tsx`）。
4. **FRP-04** frpc 日志按行切割：`readline.createInterface({ input: child.stdout })` 替代按 chunk `split("\n")`（`frp.ts:319-320`）。
5. **CLI-04** ~~`upstream.ts` `probeHttp` 给 `res` 挂 `error` 监听~~ **（执行时判定过时：`probeHttp` 在当前源码中不存在，探测已由 `hasDshFingerprint` 的 fetch + try/catch + AbortSignal.timeout 实现，错误路径全覆盖，无需改动）**。
6. **CLI-05** `scripts/probe-ws.mjs` 完成/出错路径 `clearTimeout`。
7. **CLI-06** 证书指纹提取（`cert.ts` `extractCertHash`）在网关与 `scripts/smoke.mjs:29-33` 各写一遍；随 PLG-03 的 `test-harness.mjs` 收敛为导入复用。

### Web / 插件（5 项）
8. **WEB-06** 设置面板 `Toggle` 改 `<button role="switch" aria-checked>` + 键盘事件；`TextField` 补 `id`/`htmlFor`（`plugin/src/client/index.tsx`）。
9. **WEB-07** 测试补真实流式场景：WS 重连期间 hook 幂等断言；条件允许时加 WebKit 引擎用例（`scripts/test-mobile-chrome.mjs`）。
10. **WEB-08** iOS 动态改 viewport meta 生效时机不稳：edge 注入路径尽量在网关侧一次性输出目标 `<meta>`（`pwa.ts` 已补缺失 viewport，评估把 `viewport-fit=cover` 合并进该补写分支）。
11. **PLG-06** `package.json` `dsh.client.inject` 移除未使用的 `@deepseek-ai/dsh-client-ui-layout`（客户端源码只用 `slots`）。
12. **PLG-07** 客户端注入的 `<style id="dsh-remote-styles">` 在 `ctx.on('dispose')` 清理（防 HMR 重复注入）。

### Android（3 项）
13. **AND-09** `AndroidManifest.xml` 显式 `android:allowBackup="false"`（私钥/指纹防备份外泄）；评估 `EncryptedSharedPreferences`。
14. **AND-10** `MainActivity` 补 `android:windowSoftInputMode="adjustResize"`，消除键盘遮挡输入框。
15. **AND-11** Gradle 化 + R8 混淆 + 补 `x86_64` frpc 切片支持模拟器调试（长期，与 AND-04 的 JNI 化同步规划）。

### 部署 / 文档（4 项）
16. **OPS-05** FRP 版本单一源：根 `package.json` 增 `config.frpVersion`，`install-*.sh`/`build.ps1`/`Dockerfile` 统一读取，杜绝四处硬编码漂移。
17. **OPS-06** `install-frps.sh` 的 `frps.service` 补 `NoNewPrivileges=true`/`ProtectSystem=full`/`ProtectHome=true`（对齐 `install-edge.sh`）。
18. **OPS-07** `docs/versioning.md` 状态表停留在 `0.1.1-rc.2.5`，与当前 `.6` 不符；建议 `version.mjs bump` 自动同步该表。
19. **OPS-08** 文档端口示例统一：`README.md:63,87`（52392，"本会话"字样）、`docs/vps-frps-setup.md`（62257）改为占位符 `<DSH 实际端口>`；`docs/versioning.md:65-66` 的 APK 命名（带 `v`）与 `release.yml:51-52`（去 `v`）不一致，二选一并固化。

---

## 8. 回归与验证计划

1. **既有套件必须保持全绿**：`pnpm smoke`（desktop 14 项）、`pnpm smoke:edge`、
   `pnpm smoke:edge:frp`、`pnpm test:plugin`、`pnpm test:routes`、
   `pnpm test:panel`、`pnpm test:client`、`pnpm test:mobile`。
2. **阶段 0/1 每项修复新增对应用例**（上文各条"验收"），其中至少：
   - 配对码并发核销压测（SEC-01）；
   - XFF 信任/伪造双向用例（GW-03）；
   - 上游 gzip HTML 注入桩（GW-06）；
   - `Location` 改写用例（GW-05）；
   - `autoFix` 回写最小化断言（GW-09）；
   - SW 离线+未认证导航用例（WEB-01）。
3. **发布链路验证**：连续两个测试 tag 的 APK 签名一致性比对（CI-01）。
4. **文档同步**：每阶段完成后更新 `README.md` 与 `docs/` 受影响章节，
   随版本发布（`docs/versioning.md` 流程）。

---

## 附录 A：核验中剔除/纠正的误报（15 条）

为保证本计划不含虚假债务，以下子代理报告条目经对照源码**否决或改写**：

| # | 被否决/纠正的说法 | 核验结论 |
|---|---|---|
| 1 | [Android] 证书指纹格式（冒号/大小写）不匹配导致连接被永久拦截（P0） | `VisitorConfig.java:53` 导入时已 `toLowerCase().replace(":","")` 归一化；`MainActivity.java:1700` 比对双方均为同源格式。不成立（残留点已改写为 AND-08） |
| 2 | [Android] `TunnelService` `intent.getAction()` NPE 必崩（P0） | `onStartCommand` 不读 intent，直接读 Profile（`TunnelService.java:77-84`）。不成立（真实风险改写为 AND-01） |
| 3 | [部署] Dockerfile 用 `node:22-alpine` 跑不了 TS（P0） | 实为 `node:24-alpine`（`Dockerfile:14`）。不成立 |
| 4 | [部署] 网关 `clientIp` 采信 `X-Forwarded-For` 可被伪造 | 恰恰相反：`clientIp` 完全不读 XFF（`auth.ts:103-106`）。真实问题见 GW-03 |
| 5 | [简洁性] 5 个死导出（`clearStoreCache`/`ensureFrpBinaries`/`getUpstreamConfig`/`rotateToken`/`isPairCodeExpired`） | 全仓 grep 均不存在。不成立 |
| 6 | [IO] HTML 注入导致 `Transfer-Encoding`/`Content-Length` 双头冲突 | `proxy.ts:113` 已显式 `delete transfer-encoding`，超限回退路径也正确切换。不成立 |
| 7 | [IO] 客户端断开时未中止上游请求 | `proxy.ts:150` 已有 `res.on("close", () => upstreamReq.destroy())`。不成立 |
| 8 | [IO] HTML 缓冲无上限可 OOM | `INJECT_MAX_BYTES = 2MB` + overflow 回退（`proxy.ts:38,117-129`）。不成立（优化点保留为 GW-16） |
| 9 | [IO] `writeAtomic` 存在 `unlink+rename` 回退且有数据丢失窗口 | 该回退不存在（`store.ts:70-76` 是裸 `rename`）。不成立（真实缺口见 GW-01） |
| 10 | [IO] 注入匹配 `</head>` 大小写敏感 | 实际用不区分大小写的 `<head>` 开标签正则（`pwa.ts:97`）。不成立 |
| 11 | [Web] `/__dsh_remote__/mobile.js` 无 ETag/协商缓存 | `server.ts:545-555` 已实现 SHA-256 ETag + `if-none-match` 304。不成立 |
| 12 | [Cordis] `install.mjs` 篡改宿主 `payload/app/package.json` | 实际写 `~/.dsh/profiles/<profile>/cordis.patch.yml` 与 profile `node_modules` 链接。改写为 PLG-01 |
| 13 | [Cordis] `package.json` 缺 `dsh.bundle.patch` 声明 | `packages/plugin/package.json:19-21` 已声明。不成立 |
| 14 | [IO] WS 升级剥离 Cookie 破坏上游鉴权 | 设计决策：设备 Cookie 永不上行（README 安全模型第 4 条）。按设计 |
| 15 | [部署] compose 直接暴露 18443 到公网 | `docker-compose.yml:69-70` 仅暴露 7000（frps 控制口，有注释说明按角色取舍）。不成立 |

## 附录 B：审查覆盖清单

| 审查面 | 覆盖文件 | 报告条目（核验前 → 入计划） |
|---|---|---|
| 网关核心健壮性 | `server.ts` `auth.ts` `store.ts` `config.ts` | 12 → 12（2 条纠正表述；超时项与 IO 侧合并为 GW-04） |
| 网关 IO/进程 | `proxy.ts` `frp.ts` `upstream.ts` `pwa.ts` `mobile.ts` `cert.ts` `cli.ts` `probe-ws.mjs` | 21 → 11（8 条否决，2 条并入 GW-04/GW-06） |
| 代码简洁性 | 全仓源码 + 脚本 | 9 → 8（否决"5 个死导出"） |
| Cordis 规范 | `packages/plugin/*` 对照 DSH 宿主 checkout | 6 → 5（2 条否决/改写为 PLG-01，schema 契约疑虑并入 PLG-02） |
| Android | 全部 Java + Manifest + `build.ps1` | 11 → 10（否决指纹格式误杀；NPE 改写为 AND-01；通知停止并入 AND-02） |
| Web 功能 | `pwa.ts` `mobile.ts` `mobile.js` `client/index.tsx` + 测试 | 11 → 8（否决 ETag 误报；压缩/分叉两项上收为 GW-06/WEB-02） |
| 部署/文档 | `deploy/*` `scripts/*.sh` `docs/*` `.github/*` | 11 → 8（否决 Dockerfile/XFF/compose 三条） |

## 附录 C：执行记录（AgentTeams 修复轮 · 完结）

### C.1 完成度

计划 63 项：**58 项落地并回归通过**，5 项按计划延后（GW-13 WS 帧级解析、PLG-04 面板重构、AND-04 JNI 化、AND-11 Gradle 化、GW-17 术语表——均为大重构/长期项）。执行期另完成 3 项计划外补漏：

| 补漏 | 内容 |
|---|---|
| t12 | `server.ts stop()` 幂等防御（`ERR_SERVER_NOT_RUNNING` 吞错 + 未启动实例悬挂修复 + close Promise 记忆化） |
| t13 | GW-03 补全：`DSHR_TRUST_PROXY_CIDRS` 受信网段（ops 发现 compose 桥接拓扑下仅回环信任不生效；clientIp 扩展 CIDR 命中判定，零依赖 IPv4 前缀匹配，默认空数组向后兼容） |
| t14 | CIDR 语义同步 `.env.example` / `docker-compose.yml` / `Caddyfile.example` / `edge-deployment.md` |

### C.2 执行期新判定（追加误报/修正）

| # | 条目 | 结论 |
|---|---|---|
| 16 | CLI-04（`probeHttp` 缺 error 监听） | **过时**：`probeHttp` 不存在，现实现为 fetch + try/catch + `AbortSignal.timeout`，错误路径全覆盖，未做假改动 |
| 17 | AND-09（缺 `allowBackup="false"`） | **基线已满足**：Manifest 早已有该属性；`windowSoftInputMode=adjustResize`（AND-10）核验后补齐 |
| 18 | AND-07 的 `BIND_PORT=16225` 表述 | 代码实为 18443；按实际值实现（首选 18443、回退 16225~16235 探测并贯通 frpc 配置与 WebView URL） |
| 19 | GW-04 的"请求体 50MB 上限+限速"分量 | **残余风险接受**：上游为回环自有服务，慢速面已被 60s socket-idle 超时覆盖；总量上限对正常大载荷有误伤风险，本轮不做 |

### C.3 遗留与需要人工动作

1. **CI-01 前置**：发版前管理员需在仓库 Secrets 配置 `RELEASE_KEYSTORE_B64` / `RELEASE_KEYSTORE_PASS` / `RELEASE_KEY_ALIAS`（release.yml 缺失时打 notice 跳过发布构建，不会误产不可覆盖升级的 APK）。
2. **GW-07**（state 目录 chmod 700）：Windows 无法验证，Linux 回归时用 `ls -ld ~/.dsh-remote/state` 复核。
3. **OPS-04**：edge 服务改 `dsh-remote` 用户运行属行为升级，存量实例下次 restart 生效。
4. **WebKit 用例**（WEB-07 条件分量）：本机无 WebKit 可执行体，未加。
5. `android/build.ps1` 为带 BOM 的 UTF-8，任何工具编辑后必须校验 `EF BB BF` 头（本轮踩坑两次，已恢复并留档）。
6. **本机旧开发密钥（已解决）**：`~/.android/dsh-remote.jks` 是固定口令时代的产物、缺配套口令文件——`build.ps1` 已实现**口令自动找回**（`DSH_KEYSTORE_PASS` → 旧固定口令候选，实测本机找回成功并补写 `.pass`），并沿用原密钥签名。APK 签名证书 SHA-256（`1e217f…000d`）与原 keystore 逐字节一致，已装设备可直接覆盖升级。新生成的密钥仍只走随机口令，不再硬编码。

### C.4 最终回归（本机全绿）

`pnpm smoke` 22/22 · `pnpm smoke:edge` 19/19 · `pnpm smoke:edge:frp` 全链路 EXIT 0（含 frps/visitor/stcp/门禁/注入）· `pnpm test:fixes`（新增）11/11 · `pnpm test:routes` 15/15 · `pnpm test:panel` 全过 · `pnpm test:client` 全过 · `pnpm test:plugin` 全过（沙箱限制解除后补跑）· `pnpm test:mobile` 全过（含 WEB-02 单一源逐字节契约）。测试脚手架已收敛至 `scripts/test-harness.mjs`（PLG-03），5 个脚本迁移为纯重构。

Android 完整构建实测：`android/build.ps1`（隔离 USERPROFILE 下）EXIT 0 产出 5.6MB 已签名 APK——mobile.js 单一源同步、aapt2（含 specialUse/adjustResize Manifest）、javac、d8、frpc 打包、zipalign、apksigner 随机口令新密钥全链路走通；构建后 res/raw 与单一源字节一致复核通过。

---

## 附录 D：执行记录（0.1.2 质量轮 · 完结）

> 轮次日期：2026-08 · 版本基线：`0.1.2-alpha.1.1`（0.1.2 会话适配随轮入库 `59d5228`）
> 组织：AgentTeams 四路审计（网关 BUG / 插件规范 / Android+MD3 / 全仓精简）→ 修复/重构/微执行 → 收尾。

### D.1 完成度

| 线 | 结果 |
|---|---|
| 网关 BUG（scout-gateway 10 项确证） | 网关侧 8 项全部修复（P0×2/P1-3/P2×3/P3×3）；插件侧 P1-4、P2-7 随插件线落地 |
| 插件规范（scout-plugin） | 审计结论合规、0 修复项；跨域 3 项（P0-2 adminToken 配接 / P1-4 在途令牌丢失 / P2-7 secrets 0600）落地 |
| Android + MD3（scout-android） | P1×2（主线程探测移后台 / FGS 早停契约）+ 4 项 MD3 触控目标改进；死方法清理 2 批 |
| 精简（scout-lean F1–F22） | F1–F16 全部落地（t10/t11/t13/t9 分批）；F17=GW-13 由 t8 拆分清偿；F18 登记不动；F19 收紧；F20–F22 决策项已定夺（见 D.3） |
| 架构 | t8：server.ts 972→717 行，views/body/ws 三模块抽离（GW-13 延后债务清偿，F15 模板去重含逐字节等价验证） |
| 新增基建 | TS 5.8 全仓类型检查（gateway/plugin/根三层 `pnpm typecheck`，config.ts 4×TS2352 清零）+ 最小 Node CI（`.github/workflows/ci.yml`：push/PR main 跑 typecheck + 插件 bundle 同步锁 + 快测五件套） |

### D.2 本轮安全修复要点

- **P0-1** 畸形 absolute-form 请求行可打死网关进程（`new URL` 在 try 外 + `void handle` 无 catch）——根因修复 + 进程级兜底。
- **P0-2** 裸机 edge + 同机反代拓扑下 admin 端点对公网全开（完整认证绕过链 PoC 实证）——admin 端点叠加共享密钥门禁（`state/secrets.json` `adminToken` + `x-dshr-admin-token` 头），插件侧配接并支持轮换热跟。
- **P1-3** 无 content-length 的 HTML 超注入上限时丢已缓冲前缀（GW-16 只修了声明长度路径）——超限直通前先写出已缓冲块。
- **P2-7** 插件 `writeSecrets` 落盘无 0600（GW-07 在面板路径被绕过）——原子写统一 `mode: 0o600`。

### D.3 遗留与需要人工动作

1. **settings 命名空间半接入**（插件审计 ⛔ 项）：`dsh-remote` ns 注册但 value 是 schema 默认投影、与真实 config.json 脱节；当前卡片自绘不读 ns 故无用户可见影响。方向裁决（保留座位 / 真接线 / 移除）见审计报告，等用户确认。
2. **F20–F22 已定夺（本轮收尾）**：F20 本文档保留原地（附录 A 误报账本继续有效，只追加执行记录，不归档不删）；F21 `lib/client.js` 维持入库，CI 加同步锁——`pnpm -C packages/plugin build` 重建后 `git diff --exit-code`（`src/client` 改动未重建提交会被 `.github/workflows/ci.yml` 拦下）；F22 插件宿主半边维持手写零依赖 ESM（plugin tsconfig 注释注明有意不入类型检查）。
3. `smoke:edge:frp` / `test:panel` / `test:mobile` / `test:client` 不进 CI（需 frp 二进制 / 浏览器 / 运行中的 DSH 宿主），发版前本地全量回归。

### D.4 最终回归（本机全绿）

`pnpm typecheck`（新增，gateway + plugin）全绿 · `pnpm smoke` 22/22 · `pnpm smoke:edge` 19/19 · `pnpm smoke:edge:frp` 全链路 EXIT 0 · `pnpm test:plugin` 全过 · `pnpm test:routes` 17/17 · `pnpm test:session` 18/18（本轮 +5：P2-5/P3-9/adminToken/令牌纪元钉桩）· `pnpm test:panel` 全过 · `pnpm test:client` 全过 · `pnpm test:fixes` 16/16（本轮 +5：P0-1/P1-3/adminToken 钉桩）· `pnpm test:mobile` 全过（MD3 触控目标断言更新）。
