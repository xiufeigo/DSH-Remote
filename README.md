# DSH-Remote

让手机随时随地安全访问本机运行中的 **DSH Desktop / DeepSeek Harness**——看到和桌面端
一模一样的界面：会话列表、会话过程、发消息、中止任务、审批交互，全部原生支持。

```
📱 手机：壳 App（内嵌 frpc visitor）/ 浏览器 PWA
      │ HTTPS 端到端加密
      ▼
☁️ VPS · frps（访客模式仅开控制口；入口模式另开 1 个入口端口）
      │ frp 加密隧道（PC 主动外连，家宽不开任何端口、无需公网 IP）
      │ stcp/xtcp 形态下 VPS 不监听入口端口，只有持密钥的访客能连入；
      │ xtcp 打洞成功后手机 ⇄ PC 直连，数据不过 VPS
      ▼
🚪 网关 @127.0.0.1:18443（LAN/WAN 完全不可见）
      │ 设备配对 + Token 认证 · 限流锁定 · Host/Origin 改写
      ▼
💻 DSH Desktop Web GUI @127.0.0.1:<port>（零侵入，不改 DSH 一行代码）
```

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/gateway/` | 网关核心（TypeScript，Node ≥24 原生 TS 运行，无构建步骤）；支持 desktop（PC 侧）与 edge（服务器侧）两种角色 |
| `packages/plugin/` | cordis 插件：随 DSH web profile 自启网关 |
| `android/` | Android 壳 App：内嵌 frpc visitor + 证书锁定（见 [android/README.md](android/README.md)） |
| `deploy/docker/` | Edge 部署：Dockerfile + docker-compose（Caddy 自动 HTTPS）+ `.env.example` |
| `docs/edge-deployment.md` | **Edge 部署指南**：VPS 上 Docker/裸机部署，iPhone/iPad 浏览器直达 |
| `scripts/install-frps.sh` | VPS 一键安装 frps |
| `scripts/install-edge.sh` | VPS 一键裸机部署 edge 网关（Node+frp+systemd 全套） |
| `scripts/smoke.mjs` | 冒烟测试（desktop 角色） |
| `scripts/smoke-edge.mjs` | edge 角色冒烟（Token 门禁 / 移动 hook 注入 / frps 配置生成） |
| `scripts/smoke-edge-frp.mjs` | edge 全链路冒烟（本机 frp 二进制模拟 VPS↔PC 拓扑，无二进制自动跳过） |
| `docs/` | 架构决策、[版本与发布规范](docs/versioning.md)、VPS 部署、安全模型 |

## 宿主兼容性（DSH 0.2.0-rc.2 基线）

DSH `0.1.2-alpha.1` 为 Web 宿主引入了**浏览器启动令牌认证**：每个 Host 进程生成一次性
启动令牌，`GET /?token=<令牌>` 换取签名会话 cookie；index、`/api/*`、WebSocket upgrade
一律要求有效 cookie（401），仅非 index 静态资产公开。未适配的旧版插件在 0.1.2+ 宿主上
会整页 401（远程访问完全失效）。

本插件自 `0.1.2-alpha.1.1` 起完成适配，并**同时兼容新旧两代宿主**：

| 宿主版本 | 行为 |
|---|---|
| `≥ 0.1.2-alpha.1` | 插件宿主半边在 DSH 进程内经 `connection.authenticatedUrl()` 取得启动令牌，下发给网关（`POST /__dsh_remote__/admin/launch-token`）；网关向上游交换会话 cookie 并注入全部反代请求（HTTP + WS），自动处理上游端口漂移（authority 变化重铸）与 401 失效自愈 |
| `≤ 0.1.1-rc.2` | 宿主没有 `connection` 服务与令牌认证：网关收不到令牌、不做任何注入，行为与旧版完全一致 |

> 兼容性已复核至 npm latest `0.2.0-rc.2`（0.1.5-rc.1 那次复核从 `0.1.2-rc.1` 起共 1486
> 个提交），逐项核对了本插件的**全部接入面**，结论：**接入代码无需改动**。另已对照
> `0.2.0-rc.2` 发布物复核**前向兼容**（见下节），并实测**官方 Electron 桌面端**
> （DeepSeek Harness 桌面，内嵌 0.2.0-rc.2 Web 宿主）反代全链路可用。

### 0.1.5-rc.1 接入面复核

| 接入点 | 0.1.5-rc.1 状态 |
|---|---|
| `connection.authenticatedUrl()` | 不变；`browser-auth.ts` 与 `api-request-trust.ts` 与 0.1.2-rc.1 **逐字节一致** → 令牌→cookie 交换、401 自愈、Host/Origin 栅栏策略照旧 |
| `connection` 行的服务依赖 | `['webServer','credentials']` → `['credentials']`（webServer 改可选注入）；本插件的 `ctx.inject(['connection'])` 语义不变 |
| `webServer.register({kind:'prefix', …})`、`settings.register(ns, schema, {applies:'live'})` | 不变（`host/webserver`、`settings` 两包在本区间只改了版本号） |
| 客户端模块系统 | `window.__ModuleLoader__.load({id, factory})` 不变；`dsh.client` 声明字段（`platform`/`inject`/`immediately`/`external`）不变；`react`、`react-dom` 仍是平台 seed（`packages/client/web/src/seed.ts`）→ 客户端半边 bundle 形态无需改 |
| `dsh.client.inject` 目标 | `@deepseek-ai/dsh-cordis-client-runner`、`@deepseek-ai/dsh-client-ui-settings-plugins` 均在；后者仍是 keyed slot `settings.plugin.item`（键 = settings 命名空间） |
| profile patch（`- insert:` 行） | 不变（`cordis-plugin-loader` 仍 1.0.3）→ 安装器的 junction + patch 行机制照旧 |
| `/api` 新能力 | 0.1.3+ 新增 `POST` + `requestBody: 'buffered' \| 'streaming'` 精确路由（官方原始文件上传）。网关是 `req.pipe(upstreamReq)` 流式转发、无全局限体 → 兼容，回归见 `pnpm test:fixes` |

> 0.1.3+ 新增的右侧栏（文件树 / 文档预览）、工作区文件 API、Open In…、会话格式 v0→v3
> 迁移、OTel 遥测、`HTTP_PROXY` 等一律由反代透明穿透，与本插件无交集。
>
> 唯一需要留意的新 UI 交互：官方右侧栏 0.1.3+ 落在 `data-side="details"` 那一列（移动
> hook 在窄视口下会整列隐藏：`[data-side="details"]:not([data-dshx-details-col])`）；
> 0.1.5 起右侧栏改由 `[data-sidebar-right-panel]` 承载，手机端走 `fullscreen` 态
> （`position:fixed;inset:0`，绝对定位不吃 frame 的 padding），移动 hook 已给该面板
> 补上 `--dshr-inset-top/-bottom`：标题行不再顶进状态栏、底部不压导航栏，并在此时
> 收起悬浮鲸鱼 / 抽屉遮罩 / 拖动手柄。0.1.3 的旧列形态仍按原策略隐藏。
>
> **0.1.5 的两个新浮层**（移动 hook 已适配，`pnpm test:mobile` 有回归断言）：
> 上下文占用环（`ContextMeter`：环是 28px 按钮，点开的面板 `position:absolute;
> bottom:calc(100% + 8px);right:0` 长在输入卡底栏集群里）与「更多操作 → 下载 Session
> 日志」（primitives `Menu`，非 portal 的 `position:absolute` 列表，锚在 ⋯ 按钮上）。
> 移动 hook 的两条硬约束：① 输入卡底栏集群**不得 `overflow:hidden`**——裁剪会把
> 上下文面板整块吃掉，表现为「点环没反应」；② 浮动选框只在真的超出安全视口时才
> 改写成 `position:fixed`，且写坐标前必须换算到最近的 `transform` 祖先——会话列
> 自身常驻 `transform:translateX(0)` + `will-change:transform`，它就是 fixed 后代的
> 包含块，不换算会把祖先偏移再加一次，浮层每帧下漂，最后停在输入卡上方（表现为
> 「下载 Session 日志跑到屏幕底下」）。夹取同时改成「值没变就不写」的收敛循环，
> 不再每帧空转 rAF。
>
> **主屏标记**：manifest 由官方 index 自带
> （`<link rel="manifest" href="/manifest.webmanifest">`，复核过 0.1.0-rc.8 → 0.1.5-rc.1
> 每版都有），网关**不再自带 manifest**，只补官方没有的项：Service Worker 注册、
> `apple-touch-icon`（iOS 只认 PNG）、`apple-mobile-web-app-*`、`theme-color`。

### 0.2.0-rc.2 移动 hook 接入面复核

本轮起基线切到 **0.2.0-rc.2**（= npm latest = 用户机器上正在运行的桌面版）。
移动 hook（`packages/gateway/assets/mobile-web.js`）对官方 DOM 的**结构依赖共 71 条**，
逐条对照最新版产物复核结果：

| 判定 | 数量 | 说明 |
|---|---|---|
| **失效（回归）** | **0** | rc.1 有、0.2.0-rc.2 无的结构依赖：**零条** |
| 不变 | 52 | 在 0.2.0-rc.2 产物中仍位于同一包、同一语义位置 |
| 换包 | 1 | `data-team-action` 换到 `dsh-experimental-client-ui-agent-team`，判据本身未变 |
| 两版都无 | 18 | rc.1 时代即不存在（死代码 / 第三方插件），**不构成本轮回归** |

构成 `findFrame()` 主判据的四条（`data-sidebar-collapsed` / `data-shell-overlay` /
`data-side` / `gridTemplateColumns` 含 `minmax`）与右侧栏三件套
（`data-sidebar-right-panel/-open/-toggle`）全部原样保留，故本轮 hook 侧几乎没有修复面。

> **基线产物位置（别再用错）**：0.2.0-rc.2 的前端产物在**官方桌面 app.asar 内**——
> `…\Programs\DeepSeek Harness\resources\app.asar` →
> `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/`（入口 `index-*.js` / `index-*.css`）；
> **DOM 构造代码不在 app-shell bundle 内**，而在 `dsh-client-ui-*/lib/client.js`。
> `~/.dsh/profiles/node_modules/@deepseek-ai/` 下的副本是 **0.1.5-rc.1 且 `dist` 被本地改过**
> （`dist.upstream-bak` 才是原始备份），拿它做基线会得到错误且被污染的结论。
> 复核明细见 `scratch/plan-0.2.0-rc.2/recon.md`。

### 官方 Electron 桌面（DeepSeek Harness 桌面端）：支持

> **更正**：本节旧版（≤0.1.5-rc.1.4 时期）写的是「官方桌面不开任何端口、无法接入」。
> 那是早期 `apps/desktop` 的形态；实测当前官方桌面安装包（内嵌 `dsh-desktop-host`，
> profile 用 `dsh-base` + `dsh-web-app` bundle 组合）**内嵌完整 Web 宿主并监听
> `127.0.0.1:<动态端口>`**，`GET /` 无令牌返回 401 固定文案——标准 0.1.2+ 启动令牌
> 认证形态，与本插件的反代模型完全兼容。`webserver` / `web-startup` / `web-runtime` /
> `client-hmr` 四行在该宿主上全部在位且激活，`settings` 服务照常。

桌面端专属加固（自 `0.1.5-rc.1.5` 起）：

| 项 | 说明 |
|---|---|
| 上游端口精确交接 | 桌面端 Web 宿主端口每次启动可能漂移；插件宿主半边从 `webServer.port`（OS 分配时返回真实绑定值）取端口，经 `DSHR_UPSTREAM_PORT` 交给网关（env 优先级高于 config.json），免去启动扫描；取不到仍由 `autoFixUpstreamPort` 回环扫描兜底。回归：`pnpm test:desktop` |
| 安装器自动识别 profile | `node scripts/install.mjs` 不带 `--profile` 时，存在 `~/.dsh/profiles/desktop` 即装进 desktop（官方桌面），否则 web；显式 `--profile` 永远优先 |
| 宿主版本探测 | 安装标记的 hostVersion 新增 profile 农场 `@deepseek-ai/dsh/package.json` 来源（官方桌面 app.asar 内版本无法直读，农场与宿主运行时同源） |

与 0.2.0-rc.2 基线的差异（对照 npm `@deepseek-ai/dsh` 0.2.0-rc.2 发布物逐项核对）：

- `connection.authenticatedUrl(baseUrl)` 签名不变（语义推广为任意 mount，令牌机制不变）；webserver `register` 不变；**401 固定文案逐字节不变** → 网关指纹两代通吃。
- 0.2.0 **移除了 `settings.register()`**（SettingsForms 改为 `describe()/configure()/update()` 条目投影模型）：宿主半边检测到无 register 时降级 `settings.configure({auto:true})`，不影响网关与设置卡。
- 客户端卡片槽 `settings.plugin.item` 被 `settings.plugins.tab` 列表槽取代（tab 需显式 label，单一贡献整页直显）：客户端半边**双槽位注册**，两代宿主各取所需。
- 回归钉桩：`pnpm test:desktop`（DESK-01 端口交接 / DESK-02 settings 双路径 / DESK-03 hint 纯函数）。

> 令牌与上游会话 cookie 只存在于 PC 本机进程内存：手机端永远拿不到令牌，上游下发的
> `Set-Cookie` 在网关响应侧被剥离；`sec-fetch-site` 等浏览器指纹头也不透传上游，避免
> 0.1.2+ 的 /api Host fence 误拒。

## 快速开始

### 0. 前置

- PC：Node.js ≥ 24；DSH Desktop 正在运行
- VPS：任意有公网 IP 的 Linux（Debian/Ubuntu/CentOS）

### 1. VPS 装 frps

```bash
# 本地下载脚本上传到 VPS 后：
sudo bash install-frps.sh                      # 自动生成 token 并回显
# 或指定 token（与 PC 保持一致）：
sudo bash install-frps.sh --token <密钥>
```

详见 [docs/vps-frps-setup.md](docs/vps-frps-setup.md)。

### 2. PC 配置网关

```powershell
# 首次生成配置
mkdir ~\.dsh-remote
@'
{
  "listenPort": 18443,
  "upstreamPort": "<DSH 实际端口>",
  "frp": {
    "enabled": true,
    "serverAddr": "<VPS 公网 IP>",
    "serverPort": 7000,
    "mode": "xtcp",
    "name": "dsh-remote"
  }
}
'@ | Set-Content ~\.dsh-remote\config.json -Encoding utf8

# 放入 frpc.exe（见 docs/vps-frps-setup.md §3）
# 启动
pnpm start          # 或 node packages/gateway/src/cli.ts start
node packages/gateway/src/cli.ts doctor   # 全链路体检
```

> `frp.mode` 三选一：`"xtcp"`（推荐，P2P 打洞优先、失败自动回退中转，不开公网端口）、
> `"stcp"`（固定走 VPS 中转，也不开公网端口）、`"entry"`（经典公网入口，
> 需另配 `"remotePort": 8443`，任何人可扫到该端口）。
>
> `frp.name` 是写进 frps 的隧道名，缺省 `dsh-remote`。多人共用一台 VPS 时必须改成互不相同
> （字母开头，字母数字和 `-` `_`，最多 32 位）；手机 App 填同一名字，扫码会自动带上。

> `upstreamPort` 是 DSH Web GUI 的端口（`<DSH 实际端口>`：打开本机 DSH Web 页面，
> 浏览器地址栏 `127.0.0.1:` 后面的数字即是）。桌面端重启后端口若漂移，
> 网关启动时会**自动探测并回写**（`autoFixUpstreamPort: true` 默认开启）；`doctor` 可手动体检。

### 3.5 访客模式 + Android 壳 App（推荐，不开公网入口）

`mode` 设为 `stcp`/`xtcp` 后，VPS 上不再有任何可被扫到的 DSH 端口：

```powershell
node packages/gateway/src/cli.ts visitor --mode xtcp
# 终端出二维码 + 生成 ~/.dsh-remote/frp/frpc-visitor.toml
```

- **Android**：安装壳 App（[android/README.md](android/README.md)，仓库内
  `powershell -File android\build.ps1` 即可出 APK），任意扫码器扫上面的
  二维码 → App 自动接管导入并自动建立隧道 → 直接进入 DSH；无可用后端时只显示本地连接状态，
  不会显示伪造的工作区或会话内容。证书指纹随码下发，无告警。
  界面按**设备档位**分档（判定源是原生 `smallestScreenWidthDp`，见下方「设备档位」小节）：
  手机竖屏走手机界面，横屏与平板/折叠屏展开走官方 DSH 桌面界面。移动适配
  由 **App 注入的脚本完成，不依赖服务器端是否安装本插件**，连接官方 DSH Web 同样生效。
- **PC/其他设备**：拿 `frpc-visitor.toml` 跑 `frpc -c`，访问 `https://127.0.0.1:<bindPort>`。

xtcp 打洞成功时数据手机 ⇄ PC 直连不过 VPS；失败自动回退 stcp 中转不断连。
详见 [docs/vps-frps-setup.md §4.5](docs/vps-frps-setup.md)。

### 设备档位：手机 / 平板（Android 壳）

壳内按**设备档位**决定是否启用移动 hook，档位由**原生**判定：
`smallestScreenWidthDp >= 600` ⇒ `tablet`（平板 / 折叠屏展开），否则 `phone`。

| 档位 | 竖屏 | 横屏 |
|---|---|---|
| `phone`（`sw < 600`） | **手机界面**：隐藏桌面 rail、鲸鱼侧栏入口、设置全屏页、状态栏沉浸避让 | 官方 DSH 桌面布局（沿用 `dshr-official-inset` 让位） |
| `tablet`（`sw ≥ 600`，含折叠屏展开） | **与官方 DSH 桌面版一致的界面**：hook **最小化**（rc.2.8 起契约变更，见下）、**不新增任何 DOM 节点 / 属性 / 类名 / 样式** | 同左（官方桌面界面） |

- **判定源唯一**：原生 `smallestScreenWidthDp`。**JS 不得用视口宽度反推档位**——部分机型
  layout viewport 虚高（WEB-02 既有结论），壳内曾因此误判。原生在注入 hook 之前把档位写进
  `window.__DSHR_MOBILE__.device`（`phone` / `tablet` / `auto`），JS 只消费该值。
- **平板/折叠屏展开＝零痕迹**：`<html>` 上无 `data-dshr-*` 属性、无 hook 根类（含
  `dshr-official-inset`），页面上无 hook 创建的可见节点。系统栏避让由**原生**收缩 WebView
  padding 完成，官方布局本身零改动。
- 🔴 **契约变更（rc.2.8，用户明确授权）**：平板档从「hook 严格 OFF / 零痕迹」改为
  **「允许最小 hook，但不得新增 DOM 节点 / 属性 / 类名 / 样式」**。触发变更的是
  平板档长按品牌区呼出连接设置页（T97）——该手势只能由页面侧监听，原生接不到。
  新判据：**常态只有 1 个 `touchstart` 监听器，DOM 与全局零新增**（同机同态 base 与
  最终 APK 的 `outerHTML` **逐字节相同**）。证据：`scratch/t97/report.md` §1、§6.1–§6.3。
- **运行中折叠 ⇄ 展开切换**：只改注入配置并调 hook 幂等切换 API，**不重载 WebView、不中断隧道**。
- **平板档的「连接设置」入口**（页面上没有长按鲸鱼那个入口，由原生 + 最小 hook 共补三个入口）：
  - 隧道常驻通知增加「**连接设置**」动作，进程外直达，不碰隧道；
  - **长按会话页左上角品牌区 600ms** 呼出连接设置页（**rc.2.8 新增**，见下「平板长按品牌区」）；
  - **会话根按系统返回键**打开连接设置（手机档现在**同样**如此，见下「返回键语义」）。

**返回键语义（两档一致，会话页）**：

| 状态 | 按返回键 | 说明 |
|---|---|---|
| 官方弹层 / 侧栏展开 | 先收弹层、再收侧栏 | 不打断会话 |
| **右栏打开态** | **只关面板** | 不多走一步到设置页、不退后台 |
| 会话根 | **回 App 连接设置页**（**不再退桌面**） | 设置页顶部有「返回当前会话」；再按一次才退后台，隧道与会话活性保留 |
| 平板档会话根 | **第 1 次直接回 App 连接设置页**，第 2 次退后台（**rc.2.8 起不再先关左抽屉**） | 见下「平板档返回键改语义」 |

- **为什么旧实现「承诺与行为不一致」**：设置页那句「点上方「返回当前会话」或**系统返回键**继续」
  的判据是 `settingsViaBackKey && isTabletClass()`，而 `settingsViaBackKey` 的**唯一置位点就写在
  `if (isTabletClass())` 分支里**（注释原文「手机档永不置位」）⇒ 手机档恒为 false，**承诺最明确的
  那一条恰恰是假的**，按返回键直接 `moveTaskToBack(true)` 退桌面。现去掉档位门，三处判据同批改；
  其它入口（通知动作 / 长按鲸鱼）进设置页时标记仍为 false，返回键仍**回会话**，行为未变。
  证据：`scratch/t65/report.md` §1.1–§1.2、§4.1（三条路径的设备级真值）。

**平板档返回键改语义（rc.2.8，T99）**：

| 状态 | 按系统返回键 | 与 rc.2.7 的差别 |
|---|---|---|
| 平板档会话根 | **一次返回直接进 App 连接设置页** | 不再「第 1 次先关官方左抽屉」 |
| 手机档会话根 | 回 App 连接设置页（**未变**） | — |
| 右栏打开态（两档） | 只关右栏面板 | 未变 |
| 无活会话 | 退后台 | 未变 |

- 设置页文案与行为同批对齐（「系统返回键」那条承诺现在是**真的**）。
- 设备真值 6 场景（真实 `keyevent 4`，两档逐场景）：平板会话根 1 次返回 → 设置页
  （顶部出现「返回当前会话」）、官方弹层打开态只关弹层、右栏打开态只关面板、无会话退后台；
  手机档三条路径行为不变。证据：`scratch/t99/report.md` §2–§3。
  > **未决（如实）**：手机档「右栏打开 + 返回」在这套隔离装置里**点不出那个面板**（本体取不到
  > 设备真值）。替代证据三条：**代码路径逐字节相同**（手机档走的仍是 T99 之前那条
  > `closeOverlaysThenFinish()`）、官方弹层臂的设备真值、T47 验收台 44/44。
  > 证据：`scratch/t99/report.md` §9 未决①。

**平板长按品牌区呼出连接设置页（rc.2.8，T97）**：

- 锚点是 `[data-slot="sidebar"] [data-window-drag="true"] > button`（会话页左上角
  「鲸鱼 + deepseek HARNESS」那块可拖拽按钮）——**不依赖 CSS Module 哈希类名，也不用 aria**。
- 参数：阈值 **600ms**（Android `ViewConfiguration.getLongPressTimeout()` = 500ms 之上留一档余量）；
  移动 **> 10px** 取消；**多指不立案**；监听**全 `passive`、从不 `preventDefault`**。
- **长按后必须吞掉窗口内每一次 `click`**：该区域的单击语义是**新建会话**，不吞就会
  「开了设置页又顺手开了新会话」。
- 真值：平板 **18/18**（长按 → 设置页且不误开新会话 · 单击仍开新会话 · 移动不触发 ·
  多指不触发 · 切 phone 档立即失效）；**手机档不生效**（档位闸）。
- 痕迹 = **常态 1 个 `touchstart` 监听器，DOM / 全局零新增**。
- 证据：`scratch/t97/report.md` §2.1、§3.2–§3.5、§4–§6.3。

**去重连横幅（rc.2.9，T109）：视觉层删除，状态改由设置页诊断行体现**

> **版本归属更正**：下面这四条（去横幅 / `wss://` 协议族 / SSE 不接管 / 陈旧上界）是
> **rc.2.8 收口期间发现并实现的**，但**随 `0.2.0-rc.2.9` 发布**——`v0.2.0-rc.2.8` 那个包
> 里**仍然有横幅**（`ReconnectBanner.TEXT` / `FADE_MS` / `isOnScreen` / `R.id.dshrReconnectBanner`
> 在 `798a2c9` 上逐一在场），`isActiveGatewayUri()` 的协议族当时也只有 `{http, https}`。
> 判据：`git show v0.2.0-rc.2.8:android/.../ReconnectBanner.java` 与 `.../values/ids.xml`。

用户口径原话：「**把重连横幅去了吧，这样可以少一半的耗电**」。因此：

- **删掉的是「显示」这一层**：原生覆盖条 `ReconnectBanner.Bar`（与 WebView 同级、`layout_gravity=top`
  的 `TextView`）、它的淡入淡出动画与文案常量、它的系统栏 inset 外边距、
  `R.id.dshrReconnectBanner`、以及「官方那条已可见且不与横幅带区重叠 ⇒ 抑制」那一整套带区几何
  （`isOnScreen` / `bandHeightPx` / `shouldSuppress` / `BAND_FALLBACK_DP`）。没有横幅就无所谓
  「同一条信息画两遍」。
- **一个字都没省的是「采样」这一层**：只读探针 `ReconnectBanner.PROBE_JS` 与它的全部字面量、
  防抖状态机 `Debouncer`（2 真确认 / 3 假解除 / UNKNOWN 不计数）全部原样保留，
  继续喂 `StuckRescue` 自救判定；探针照旧 `webView.evaluateJavascript(ReconnectBanner.PROBE_JS, this::handleReconnectProbe)`。
  防抖器仍决定「确认仍在断开态时保持 500ms 快档」。
- **T108 的合并探针 + 自适应节拍 + 事件驱动配色**（这是「少一半耗电」的真正来源）：
  - **两条独立定时器合并成一条**（`reconnectPollTick` 500ms 为基拍），配色探针并进同一拍、
    周期 1500ms → **3000ms**（常量名保留，T94 的源码契约按名字钉着）；`MERGED_PROBE_JS` 是**拼出来的**
    （两条探针字面量仍是唯一真相源），返回值 `{b,g}` 由 `handleMergedProbe()` 拆开喂**既有**判据/防抖/自救/配色应用。
  - **自适应节拍** `probeIntervalMs()`：快档 **500ms**（窗口 `PROBE_FAST_WINDOW_MS=8000`，
    在「回前台 / 进会话 / 探针看到重连」三处开）｜健康态兜底 **一档 5000ms**（`PROBE_IDLE_MS`）。
    > **rc.2.9 → 下一版（T117）**：这里原来是两档——「有推送通道 `PROBE_IDLE_HOOK_MS=5000` /
    > 无推送通道 `PROBE_IDLE_MS=1000`」。那 1000ms 档是**平板档的常态**（平板档 `hookSelfHealLive()==false`），
    > 也就是用户截图里那行 `节拍 1000ms`。T117 把无通道档放宽到 5000ms ⇒ **两档合并成一个常量**，
    > `probeIntervalMs()` 的健康态分支只剩 `return PROBE_IDLE_MS;`。
    > 判据/阈值/采样链一个字未改（见本文件「去重连横幅」一节与本批小节的真值表）。
  - **手机档「推送即真相」**：`hookConnState` 真变化时投递 `onHookConnStateFlip()` ⇒ 开快档 +
    配色欠账清零 + **立刻补一拍**（横幅时延 = 推送时延 + 一拍防抖）。
  - **配色事件驱动**：`requestPageBackground()` 在「进会话 / 新文档提交 / 回前台 / 配置变化 /
    hook 主题翻转」各补一次独立只读采样。
  - **手机档「推送即真相」**：`hookConnState` 真变化时投递 `onHookConnStateFlip()` ⇒ 开快档 +
    配色欠账清零 + **立刻补一拍**（横幅时延 = 推送时延 + 一拍防抖）。
  - **配色事件驱动**：`requestPageBackground()` 在「进会话 / 新文档提交 / 回前台 / 配置变化 /
    hook 主题翻转」各补一次独立只读采样。
  - **实测（`scratch/t108/report.md`）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 每分钟 `evaluateJavascript`（手机、被动空闲） | **159.5**（横幅 119.5 + 配色 40.0） | **44.5**（含事件驱动 2.0），**−72%** |
| 每分钟 `evaluateJavascript`（后台） | — | **0/分**（实测；**后台不是主因**） |
| CPU（ms/分，app+renderer）· **长会话档**（12120 候选节点） | **1665.6** | **272.4**（**−84%**） |
| CPU（ms/分）· 平板长会话 | 1547.8 | 844.1（**−45.5%**） |

  - ⚠️ **口径（如实）**：手机的 −84% 里**含渲染/布局成本这一层混淆，不能整条算在轮询头上**
    （报告 §原文）；两个进程合计里轮询只占 **16.3%（手机）/ 32.1%（平板）**，其余是 WebView 渲染合成与 DSH 前端自身。
  - ⚠️ **改后为何是 44.5/分而不是设计值 12/分**：**被动页 hook 不上报 ⇒ `hookConnState` 恒 `null`
    ⇒ 落 1s 兜底档**（活跃页有 mutation ⇒ 5s 档）。**这是已知的后续优化点**，不是缺陷掩盖。
    > **T117 已收口这一条**：无推送通道档放宽到 5000ms ⇒ 被动页也从 60 拍/分降到 12 拍/分
    > （实测见本批小节）。
- **状态可见面**：rc.2.9 时是「设置页那行只读诊断」（`重连探针：hook=… · 上次断线 … · 拍数 … ·
  最近 … · 节拍 …ms`），与既有的「页面适配诊断 / 文件选择 / PinnedFetch / 落盘缓存 / 未拦计数 /
  打洞策略」同一块只读文本，**不新增任何可点控件**（设备真值见 `scratch/t109/report.md`）。
  > **rc.2.9 → 下一版（T117）**：用户明确要求删掉那串诊断 ⇒ **那一整块从 UI 上删除**，
  > 同一份内容改由 **logcat 标签 `dshr-diag`** 输出（只在值变化时打；进设置页时无条件打一份全文快照）。
  > 取回方式见 `android/README.md`。**采集与记账一个字没删**（并发闸 / 落盘缓存 / 未拦计数 /
  > 路径判定 / 探针拍数全都照跑），删的只有"画到屏上"这一层。
- 🔴 **契约表述（与 T97 的最小 hook 一并读）**：平板档的契约经过**两步演进**——
  **rc.2.8**：从「hook **严格 OFF** / 零痕迹」放宽到「**允许最小 hook**（`touchstart` 监听器 1 个），
  但不得新增 DOM 节点 / 属性 / 类名 / 样式」；**rc.2.9**：再放宽到
  **「允许最小 hook + 允许新增 CSS 规则」**。当前的完整表述是：
  **平板档允许最小 hook（常态 1 个 `touchstart` 监听器）与新增 CSS 规则，仍不得新增 DOM 节点 /
  属性 / 类名**。横幅当初之所以做成**原生覆盖条**，正是因为「平板档不许往页面里写一个字节」——
  这条前提松动之后，原生覆盖条也就不再是唯一选择；加上耗电口径，T109 把它整层删掉。
  rc.2.9 的 T115 又需要把**系统栏让位**从「原生外边距」改到「页面 CSS padding」（见下节），
  于是「允许新增 CSS 规则」被明确写进契约（新增的规则只读 `--dshr-inset-*`，不选元素之外的任何东西）。
  **新的等价保证**：`<html>` 上仍无 `data-dshr-*` 属性 / 无 hook 根类、页面上仍无 hook 创建的可见节点
  （常态判据不变），CSS 规则只加在 hook 自己的 `<style data-dshr-mobile-css>` 里。

**`wss://` 视同 `https://` 参与同网关判定（rc.2.9，T109，发布阻塞 P0-3）**

- 现象：真机**换网 / 长时间空闲后 mux 连不上，且毫无线索**（无日志、无弹窗）。根因是
  `isActiveGatewayUri()` 的协议判定只认 `http|https`，而 WebSocket 的 TLS 握手错误**也**走
  `onReceivedSslError`（`error.getUrl()` 就是 `wss://…/api/remote.mux`）⇒
  被判成「非本网关」⇒ `handler.cancel()` **静默**取消掉每一次**冷**握手；
  只有 Chromium 复用一条已经建好的热 https 连接时才连得上。
- 修法：把「web 族」从 {http, https} 扩到 **{http, https, ws, wss}**，并要求**两端安全级别一致**
  （明文族 {http, ws} ↔ 加密族 {https, wss}）。**主机与端口的相等判定一个字没放松**——
  那是信任边界的门（决定要不要用本网关的证书 pin）；协议这一维只是承认
  「`wss://host:port` 与 `https://host:port` 是同一台服务器的两种传输形态」（RFC 6455 的
  `Upgrade: websocket` 本来就是 HTTP/HTTPS 握手）。`effectivePort()` 同步把 wss 折叠到 443。
- **诊断面**：`handleSslError` 的**每一支**现在都打日志（改前「非网关 ⇒ cancel」是纯静默的）。
  放行那一支会打印 `scheme=`，于是设备侧一次冷握手就能直接对上「wss 有没有走到这里」。
- 真机真值：改前（把 ws/wss 从协议族拿掉这一行变异）`wss://…/api/remote.mux` → 每次都被
  `cancel`、`wsState` 恒 `reconnecting`；改后同一场景 `scheme=wss … proceed`、`wsState=ok`。
  证据：`scratch/t109/report.md` §P0-3。

**SSE / 流式端点不再被原生静态落盘接管（rc.2.9，T109）**

- 原生白名单改前是 `path.startsWith("/plugins/")` 的**前缀**匹配，而浏览器侧 `pwa.ts` 的白名单是
  `FINGERPRINTED_PATH = /^\/plugins\/?$/` 的**精确**匹配。前缀匹配让原生比 SW 多吞了一整类路径：
  **`/plugins/events`（SSE 长连接）**也被判进白名单 ⇒ 打到 `PinnedFetch`
  （15s 读超时 / 45s 总预算，且**读满整体才返回**）⇒ 事件流永远回不来，
  用户体感「掉线后半天回不来」。
- 修法两条，都只**放行**、不接管：① 白名单收成「`/assets/` 目录段 + **精确** `/plugins`」，
  与 `pwa.ts` 同语义；② **显式排除流式端点**——路径名单（`/plugins/events`）与协议标记
  （请求头 `Accept: text/event-stream`）**任一命中即放行**。端点改名时路径名单会漂，
  协议标记不会，两条互补。
- 设备真值：诊断行的「未拦 … **SSE 2**」计数在场，logcat 里 `/plugins/events` **0 命中**。

**hook 连接态的陈旧上界（rc.2.9，T109，T106 静态审计 S1）**

- 原生那份 hook 连接态（`hookConnState`）改前只在**下一次推送到达**时被覆盖 ⇒
  一次假的 `reconnecting` 会把「正在重连」**永久**钉进判据。
- 现在配一个**陈旧上界 20s**：超过 20s 没收到新推送，这个值就不再投票（读的地方统一走
  `freshHookConnState()`，日志里可见 `hookConnState 陈旧 age=…ms ⇒ 本轮起视为 UNKNOWN`）。
  与 hook 侧 T112 的「断开态 1s 按电平重推 + 恢复立刻推 + open 撤闩」**配对**：
  真断开时推送每 1s 来一次、永不陈旧；推送链路真坏了也不会把状态钉死。
- **只作用于"投票"，不作用于"桥装没装过"**：`hookSelfHealLive()` 仍看未加时间戳的原值——
  否则健康态静默 20s 后会被误判成"hook 不在场"，兜底探针从 5s 掉到 1s，与省电目标相反。

## rc.2.21 本批的用户可感知变化（两个手机档交互缺陷，T135）

用户口径原话：「右侧边栏手动滑动关闭的时候，在关闭后会自动再弹一遍动画，也就是自动打开侧边栏
又给关上」；另一条：「我手机版改不了这个模型。模型面板是在输入框顶部向上弹出，然后点击模型这个框
会自己消失。」两条都已定位到根因并修复（唯一产品改动 `packages/gateway/assets/mobile-web.js`，
与 `android/app/src/main/res/raw/mobile.js` 字节同步）。结单报告：`scratch/t135/report.md`。

### ① 右栏「关完又自己弹回来再关上」＝**两套位移载体共用同一个闸**

- hook 的卡片位移加在**面板本体**上（`transform: translateX(var(--dshr-rx))`），闸是官方属性
  `data-sidebar-right-open`；而**官方真正的收起/展开过渡在面板内层**
  （`[data-dockkit-host=dock]`/`[data-dockkit-empty]`/`[data-dockkit-divider]`：
  `transform: translateX(var(--dsh-sidebar-width)); visibility: hidden;
  transition: transform var(--ds-transition-duration-slow) …, visibility 0s linear …`）。
- 手势关闭补间到 `rx=max` 后再兑现官方收起 ⇒ 属性消失使面板那条规则**整条失效**
  （面板 `transform` 回落 `none`、rect 412→**0** 瞬回屏内），官方内层随即起跑它自己的 0.3s
  过渡（`visibility` 延迟 0.3s 才隐藏、**全程可见**）⇒ 用户看到的第二次动画。
  逐帧实测：官方提交帧 `t=1109`，内层可见窗口 `1109→1376ms`（屏内 17 帧）。
  **不是状态机问题**：每次关闭官方 toggle 精确派发 **1 次**、属性只翻转 1 次（rc.2.18/2.19/2.20
  三次「补拍」类修复治不好，原因就在这里）。
- 修法：新手势关闭**交接窗** `data-dshr-rclosing`——交接窗内面板继续停在屏外（同一条卡片规则
  用第二个选择器命中），并**压掉官方内层过渡**（收起一步到位 `translate+hidden`）；
  官方状态一落地（`syncDom`）**先撤窗、再清 `--dshr-rx`**。打开意图 / 看门狗放弃 /
  `setRightbarOpen` 早退 / 拆卸痕迹都要撤窗。
- 附带：`startObserver` 的 `attributeFilter` 补 `data-sidebar-right-open` + `aria-hidden`
  ——原先右栏属性翻转能否及时同步，全靠官方那次提交**恰好**带了 childList 变更；若只有属性变化，
  `rightToggleBusy` 迟迟不解，1200ms 看门狗会按「派发丢失」补发第二颗 toggle（另一条
  「关完又自己打开」的链路）。
- 真值：独立复现脚本修前 **5/5 复现**、修后 **0/5**；提交帧面板 `left` 由 **0 → 412**（停在屏外）；
  官方按钮直关的 0.3s 正常动画**未被误杀**。回归：`pnpm test:mobile`（fixture 逐帧断言
  `rdrawer-official-close-no-replay` 等 + 源码契约）。

### ② 手机端改不了模型 ＝**守卫 blur 掉了官方子面板自己弹出的搜索框**

- 点「模型 …」行 ⇒ 官方打开模型子面板（18 条模型 + 搜索框
  `input[role="searchbox"][aria-label="搜索模型…"]`）并**自动聚焦**该搜索框；
  hook 的 `focusin` capture 守卫把它判成「非用户手势造成的偷焦点」⇒ `revokeStealthFocus` ⇒
  `el.blur()` ⇒ 官方浮层以「焦点离开浮层」为准 dismiss ⇒ **blur 后 1.6ms** 菜单 + 刚渲染的
  模型列表 + 外点遮罩整块卸载，列表一帧都没画。四臂对照（注入 hook ❌ / 无 hook ✅ /
  tablet 严格 OFF ✅ / 只中和那一句 blur ✅ 且真能换模型）钉死因果；`click` 实测送达
  （`defaultPrevented=false`、目标仍在文档里）⇒ 与「吞 click」无关。
- 修法：**浮层内手势通行证 + 压 IME 而不是 blur**——手势起点落在已打开浮层内 ⇒ 开一张
  **只对「浮层内元素」生效**的窗口；窗口内落在浮层里的可编辑元素被聚焦时**不 blur**，
  只打 `inputmode="none"` + `data-dshr-imemute`（**记住原值**）⇒ 菜单活着、Chromium 不请求
  `showSoftInput`（不把 T48 §5 的键盘病换回来）；用户之后真去点输入框 ⇒ 撤压制并还原原值。
  判据**不靠 role**（官方容器 role 会在 `menu`/`group` 间切换），也不只认 hook 自己的标记
  （标记由 50ms 合并的 `syncDom` 写，而官方这次聚焦发生在子面板挂载后 ~10ms）。
- 范围严格性：点 composer 上的「+」/模型触发器**不开**窗口 ⇒ T48 §5 的防护不变（实测「+」路径
  `data-dshr-imemute` 计数 = 0）；放行对象必须是**浮层内**的可编辑元素 ⇒ 官方浮层关闭把焦点
  还给 composer 那种「偷焦点」仍被正常收回（T42 语义不变）。
- 真值：真页面端到端**真的换了一次模型并逐字复原**（`DeepSeek V4.1 Flash/Max` →
  `DeepSeek-V41-Flash/High` → 复原；切模型会同时重置推理等级，回滚分两步）。
- ⚠️ **未决（如实）**：软键盘真机行为未实测（headless Chrome 量不到 `showSoftInput`）；
  本修法取「放行焦点 + 压 IME」是**保守方向**；`inputmode` 撤销路径已实测
  （点搜索框后还原、能输入并过滤 18→3 条）。

## rc.2.10 本批的用户可感知变化（省电清理）

用户口径原话：「**兜底探针改成按分钟计吧，然后在后台的时候不触发，只有在前台才会触发探针，这样才是真省电。**」
另一条原话：「请你顺手把你之前加的那些测试用的内容删了吧，免得徒增耗电。**比如这串诊断字样**。」

| 项 | 改前 | 改后 | 真值来源 |
| --- | --- | --- | --- |
| **设置页那串诊断** | 8 行键值/计数器（页面适配诊断 / 文件选择 / 并发峰值 / 落盘缓存 / 未拦 / 打洞策略 / 本次隧道 / 重连探针） | **全部从 UI 移除**，只留人话提示（如「隧道仍在运行。点上方「返回当前会话」继续…」） | 改后截图；**同样信息转 logcat**（`dshr-diag`，仅值变化时打，UI 零成本） |
| **兜底探针周期**（健康态，仅前台） | 无推送通道档 **1000 ms** | **60000 ms（按分钟）** | T117 实测：**1s 档 60 拍/分 → 5s 档 12 拍/分、CPU 624.9 → ~210 ms/分（−66%）**；60s 档按同口径推算 ≈ **1 拍/分**（⚠️ **未单独真机计时**，真机可用 logcat `dshr-diag` 的拍数对账） |
| **后台** | 已 **0 拍/分**（`onPause` 停轮询 + `pauseTimers()`） | 不变，**仍为 0** | T108 实测（后台态探针 0/分）；本轮按用户要求**显式复测** |
| **配对后的设备凭据** | 前台直接 `force-stop`（未经 `onPause` flush）会丢设备 cookie ⇒ 回配对页 | 配对/导入成功后 **`CookieManager.flush()`** | T117 报告（强杀前/后设备真值） |

> ⚠️ **及时性权衡（如实写）**：60s 只影响「**待在页面里干等时**多久发现断开」；「**切后台再回来**」这条主场景仍由
> 回前台**立刻开的 500ms 快档**在 ~1s 级发现。`StuckRescue` 的阈值（温和 2×8s / 升级 12s / 链路闸）
> **一个字未改**；回前台/进会话的"立刻补一拍"也**没有**删。
>
> 判据改动与"谁钉住了谁"：本批删掉了设置页诊断行 ⇒ 钉住它们的断言（若有）同批改写，并**由变异反证**证明更新后仍有判别力。

## rc.2.9 本批的用户可感知变化

### 启动加载提速（rc.2.9，T113）——本批最大的一项

用户诉求原话：「**优化启动加载速度**」「**加载快速不等待**」。量出来的第一因**不在压缩、不在带宽**，
而是**每次连接都固定空等一段**：xtcp 打洞失败后回退 stcp 的 `fallbackTimeoutMs` 是 **5000 ms**，
而这条等待**与传输体积无关**（同一资源各 3 次：xtcp `5149/5143/5106 ms` vs stcp `49/131/142 ms`，
宿主直连 17–118 ms）⇒ 稳态 14 s 里有 **10.37 s（73.6%）** 花在这段**一个字节都没传**的空等上。

| 改动 | 落点 |
|---|---|
| 打洞回落超时 **5000 → 800 ms** | `VisitorConfig.java:82` `FALLBACK_TIMEOUT_MS = 800`（`:159` 写进 toml）；网关侧 `frp.ts:306` 同值，**cross-end 逐行对齐**（`scratch/t104/cross-end.mjs`） |
| **连续 2 次**打洞失败后**粘住中转** | `TunnelPath.java:56` `HOLE_FAIL_STREAK_TO_STICK = 2`；粘住后下一次 frpc 启动直接用 T104 已有的「只用中转」toml |
| 粘性**解除**条件 | **打洞成功立刻解除**；**换网络 / 换配置组 / 换档位**（`noteStickyContext`）与**进程退出**清零；**「停隧道」不清零**（否则「断开→再连接」又要白等） |
| **绝不主动重启 frpc** | 粘性只在「反正要重启」的时刻（新隧道启动 / frpc 崩溃自重启）生效——主动重启会掐断在途连接，用户会看到断线闪烁 |

**实测真值**（隔离装置 + 真实配对；`scratch/t113/report.md`）：

| 指标 | 改前 | 改后 |
|---|---|---|
| 稳态「点连接 → 可交互」 | **13,573 / 14,206 ms** | **5,562 / 5,399 / 6,396 / 5,094 ms**（均值 5,613，**−8.28 s ≈ −60%**） |
| 打洞回落**空等**（稳态，n=4） | **10.30–10.38 s** | **1.88–2.06 s**（均值 1.97，**−81%**） |
| 冷启动（缓存空） | 28,507 / 29,258 ms | **8,108 / 7,811 ms** |
| 冷启动空等 | 10,298 / 10,479 ms | **1,823 / 1,909 ms** |
| **粘性生效后**（同会话页面重载，n=3） | — | **2,398 / 2,750 / 2,903 ms**，空等 **0** |
| 逐连接（同 3 资源 × 3 次） | 5,044–5,205 ms | **855–990 ms** →（粘性）**62–238 ms**（宿主直连 7–78 ms） |

> 「≤2 s」是**量级成立而非次次成立**：n=4 里有 **3 次 ≥2 s**，所以准确说法是
> **「1.88–2.06 s（均值 1.97 s）」**（报告 §3.1 原话）。

**首页注入后压缩**（`proxy.ts`）：`/` 在**客户端声明 `accept-encoding` 时**压一次——
**35,443 B → 5,232 B（gzip）/ 5,262 B（br）**（省 30,211 B，**−85.2%**）；
**未声明 `accept-encoding` 或 `gzip;q=0` 时仍是 35,443 B 裸传**（语义正确，不把压缩当默认）。
设备侧同一主文档 `nav.transferSize` **35,743 → 5,562**（6 次测量逐次一致）。

> ⚠️ **压缩的毫秒收益测不出来，所以不给数字**——字节真值由「宿主 curl + 设备 `transferSize`」双证，
> 但端到端毫秒落在噪声里（报告 §7/§9 如实标注）。

**诊断面（设备 UI dump 原文，两条只读行）**：
```
打洞策略（配置）：打洞优先（先试 P2P，0.8 秒打不通自动回退中转）· 电脑端形态 xtcp
本次隧道：打洞优先 · 已粘性回落中转（连续 2 次打洞超时后不再等；换网络或重开 App 自动重试打洞）
```

> ✅ **实现纪律（值得记住）**：改 `FALLBACK_TIMEOUT_MS` 是**同一个 toml 键只改数值**，
> 「打洞优先 / 只用中转」二选一的**语义与写法一字未新**；T104 的 38/38 与 cross-end 14/14
> 复跑仍绿。变异 M1（把 800 改回 5000）⇒ 空等回到 **10,498 ms**。

### 接管通道带上设备凭据（rc.2.9，T114）——真机「频繁重连 / 白屏」的主因

**这是本批最关键的一个修复**，也是前几轮「隔离装置全绿、用户真机频繁重连」那条缝的答案。

- **根因**：`PinnedFetch`（SW 侧与首屏落盘的取数通道）改前只发
  `Accept-Encoding` / `Accept` / `User-Agent`，**不带 Cookie、也没有 Authorization 旁路**
  ——Android 的 `shouldInterceptRequest` **不会自动带 cookie**。而网关的设备令牌**只认 cookie**
  （`dr_device`，HttpOnly）⇒ 凡被这条通道接管的请求**全都是未鉴权的**：
  **连 `/assets/*.js` 都返回 401** ⇒ 静态资源进不了缓存、`/plugins/events` 长连接永远建不起来
  ⇒ **白屏（`#root kids=0`）+ `connection lost` 无限重试**。
  实测 `pinnedFetch 非 200 status=401 url=…/assets/vendor-CCJJTK99.js`。
- **为什么我们之前全绿**：我们多数验收装置**没启用设备鉴权**（直连 / 无配对）⇒ 本地一切正常。
  ⇒ **今后所有验证装置必须显式开启设备鉴权并走真实配对**（已写进下方验收纪律）。
- **修法**（`PinnedFetch.java`）：① 发请求前用 `CookieManager.getCookie(url)` 取该 URL 在当前
  WebView cookie 罐里的凭据（设备令牌是 HttpOnly，`document.cookie` 看不到，CookieManager 拿得到）；
  ② **只对同源附带**——`isSameOriginUrl()` 要求 `https` + host 全等 + 有效端口（缺省折叠 443），
  且**在「凭据唯一出口」再判一遍**（纵深防御）；跨 host / 跨端口实测服务端收到 **`Cookie: null`**；
  ③ **无凭据 ⇒ 失败关闭**（`return null`，**连接都不建**），不把必然 401 的请求发出去当「成功」；
  ④ **401 ⇒ 单独分支 + `return null`** ⇒ 调用点拿不到结果 ⇒ `StaticDiskCache.put` **不可达**
  ⇒ **401 不可能污染落盘缓存**。
- **唯一的 fail-open 例外**：网关侧**免认证**的 `GET /__dsh_remote__/health`，且**不带任何凭据**
  （不泄露、不可能 401）。

**实测真值**（开鉴权 + 真实配对）：

| 指标 | 改前 | 改后 |
|---|---|---|
| `pinnedFetch 非 200 status=401` | **12–16 次 / 次进入**（静态资源 + `/plugins/events` 全中） | **0**（全文件 0 次） |
| 第二次进入（`am force-stop` 后重连） | **白屏**：`#root kids=0`、正文空 | **不白屏**：`#root kids=1`、正文 909 字 |
| 稳定链路 soak（真实会话 + 开鉴权） | 401 常驻 | **655.2 s（10 分 55 秒）：0 401 / 0 `connection lost` / 0 横幅 / 0 `handshake failed`** |

- **安全负例 16/16 通过**（含跨 host、跨端口 ⇒ `Cookie: null`；缺凭据 ⇒ 服务端**收不到请求**）；
  变异 M1（去掉 Cookie 头）⇒ 同源也没带、**15/16 exit 1**；M2（跨 host/端口**泄露令牌**）⇒ 红。
- ⚠️ **残余（如实）**：**无人值守的断线恢复未达标**——网关重启会丢上游**一次性启动令牌**，
  换新令牌后 App **未自动恢复**（`tier2 reloads=2/2` 用满 + health 恒通）⇒ 手动重载即恢复且零 401。
  归 T96/T108 的自愈策略，**标注未覆盖**（另见下方「已知边界」）。

### 掉线不再被自愈机制**自己造出来**（rc.2.9，T112 / T112b）

用户症状是「**用着用着就掉线**」，而因果链是**反的**：不是断网触发了自愈，是**自愈自己把健康连接掐了**。

- **机制**：自愈的 nudge 动作从 rc.2.7 起是 **`offline`→`online` 瞬态对**，上游收到会真的
  `abort(NETWORK_STATE_CHANGED)` + 掐掉在用 socket ⇒ **一次判据误报 = 一次真掐断**。
  而上限 `RESUME_MAX_NUDGES` 是 **6**，配合 rc.2.8 的 3s 探活硬超时（异地首字节 >3s 是常态）
  ⇒ 一次回前台就可能连掐 **6 次**（≈50 s 内连掉 6 次）。
- **三处修法**（`mobile-web.js`）：
  1. **nudge 动作按来源分流**：新增 `connectionDownSource()`，**只有 `wsSrc === 3`（WS 观测到真 `close`）
     才允许派 `offline`**；来源 1/2（DOM 文案）与 4（探活超时）一律退回 **`online`-only**（上游首行幂等短路 ⇒ 无害）；
  2. **上限 6 → 2**（`RESUME_MAX_NUDGES = 2`）；
  3. **记录 `CloseEvent.code/reason/wasClean`**（改前只记 `lastEvent="close"`）——这是把
     「隧道抖动」与「手机网络」分开的**唯一钥匙**；真断线实测 **`1006 / wasClean=false`**。

**实测真值**（同一误报 + 一次前后台切换，链路健康）：

| 场景 | 改前（rc.2.8） | 改后 |
|---|---|---|
| S4 构造误报 | nudge/派发 offline/**真掐断 = 6/6/6** | **2 / 0 / 0**（mux 7 建 6 关 → **1 建 0 关**） |
| S2 后台 25s 回前台 + `/health` 4.5s | **1/1/1** | **0/0/0**（主探超时 → 确认探 4.5s 内成功 ⇒ **撤销**） |

- **真断线仍能发现**：判定 **1628 ms**（另一次 1585 ms）、mux 断开 3 ms、网关回来 **≈0.5 s** 恢复；
  半开（hold）发现 **10804 ms**，nudge=2 但 **offline=0 / aborts=0**。
- **稳定链路 601.3 s / 1204 拍（最终 SHA、真实会话内）**：`reconnecting 0 / nudge 0 / abort 0 / 探活 0 / 重推 0 / 活动定时器 0`。
- ⚠️ **代价（如实）**：来源 4 不再掐断重建 ⇒ **半开场景的自愈交给原生自救层 + 「真死 ⇒ WS close」**；
  S2/S4 是**构造刺激**，真实外网的触发频率**未测**。

### 系统栏改走**原生透明 + 页面自己让位**（rc.2.9，T115）

- **改前**：平板档的让位靠**原生**给 WebView 加外边距（`lp.setMargins`），于是两条系统栏露出的是
  **`rootLayout` 的底**——一个**原生单色**。而平板官方面板贴边那一行**本来就是两色**
  （左栏 `--dsw-specific-sidebar-fill` / 会话面板 `--dsw-alias-bg-base`）
  ⇒ **单色带必然在面板那一侧留一道缝**：实测改前上带 **1919/2560 像素与页面贴边行不同、ΔRGB=(6,5,4)**，
  下带 **1925/2560 不同**。另有一处**字面与口径相反**：`configureSystemBars()` 仍写
  `setNavigationBarColor(shell_background)`（API 30–34 上会真的涂上去）。
- **改后**：WebView **外边距置 0**（覆盖全窗），**四向 inset 交给页面 CSS**
  （`--dshr-inset-top/right/bottom/left`，新增唯一页面写入口 `writeInsetsToPage`）；
  `configureSystemBars()` 与 `applySystemBars()` 在两个 API 段都写 **`Color.TRANSPARENT`**
  （对比度强制仍关）。**「带 = 页面自己画的像素」于是成为构造性事实**，不存在第二个色源。

**实测真值**：

| 判据 | 改前 | 改后 |
|---|---|---|
| 四向遮挡（`WebView` 屏上框） | `[0,72][2560,1536]` ⇒ **0/72/0/64** | `[0,0][2560,1600]` ⇒ **0/0/0/0** |
| 页面视口 | `1280×732`（比整屏少 68 CSS px） | **`1280×800`**（= 整屏 2560×1600 ÷ dpr 2） |
| 页面 `--dshr-inset-*` | 四个全空 | **top 36px / bottom 32px / left 0 / right 0** |
| 两条带 vs 页面（**跨旧带边逐像素**） | 上 **1919/2560**、下 **1925/2560** 不同 | **ΔRGB = 0（四个主题组合全 0）** |
| 带内页面内容墨迹 | — | **0 行**（页面内容顶边 `top=36` CSS px ⇒ 一个像素都没进带） |
| **手机档** | 四向 0/0/0/0、`--dshr-inset-top: 46px / bottom: 24px` | **逐字不变**（手机档 CSS 未改一行） |

- 四条**不可回退项**（抽屉圆角卡片 / 右栏两条动画 / 返回键新语义 / 打洞-中转二选一）逐项无回归。
- 变异反证 2 处（M1 把四向改回布局盒 ⇒ `test-immersive` 红 + `test:device` 158→145；
  M2 把严格 OFF 早退插回 inset 写入之前 ⇒ 新断言红），**均逐字节还原**。
- ⚠️ **如实披露**：本机是 Android 15，`dumpsys` 已不再暴露 legacy 导航栏色字段 ⇒
  「透明」由**代码层断言 + 像素层无遮挡**两条共同证明，**未取到 API 30–34 真机真值**；
  另见下方「已知边界」的两条（左右挖孔 / 三键栏、平板右侧栏打开态）。

### rc.2.9 的已知边界（如实列全，**读验收结论前先读这一节**）

1. **真实外网 / 真实 NAT 下的打洞表现未验**。本批所有装置里 **frps 都在本机回环** ⇒
   **打洞必然失败**（两相 0 次成功）⇒ 下面三件事**只能由用户真机验**：
   ① 真实异地网络下的**打洞成功率**；② **800 ms 在用户那条链路上够不够**；
   ③ **粘性会不会误粘**（装置里必然粘住，所以「不误粘」这条只有规则与单测钉着，没有真实反例）。
   **建议用户真机抓一次 `logcat -s dshr-frpc`**（看有没有 `open tunnel error`）即可判定他那边能否打洞。
2. **「真机」在本批 = AVD**。用户报障的**小米 15 / Xiaomi Pad 本批未复验**；
   两台自建 AVD 是 Android 15（`displayCutout` 恒 0、手势导航），与 MIUI / 真平板形态有差异。
3. **前台直接 `am force-stop` 会丢设备 cookie**（未经 `onPause` 的 `CookieManager.flush()`）⇒
   重进回到配对页需重新配对。**先按 Home 再 force-stop 则正常**（2/2 对照）。
   用户正常路径都经过 `onPause`，故严重度**低**；**留 rc.2.10**（现在改会作废已冻结的验证）。
4. 🔴 **`autoFixUpstreamPort`（默认 `true`）是多实例同机时的脚枪**：上游端口失配时网关会**自动探测回环**
   并把**自己**改指到另一个 DSH 实例（V3 的隔离装置首启就被它指到了**用户的 19387**，
   日志里能看见「上游：http://127.0.0.1:19387」）。这是**网关配置行为、不是 APK 问题**，
   且**没有污染用户环境**（已当场纠正）。**缓解：同机多实例时设 `"autoFixUpstreamPort": false`。**
5. **抽屉「拖动关」的节拍有装置差异，且「跟手」存在口径差异**（都**未定为本批回归**，留一次复核）：
   - 帧间隔 p95：**V2 33.3 ms**（擦线过）/ **V1 42.8 ms** / **V4 49.9 ms**（超 34 ms 判据）。
     三台装置数字差得远，**不能据此判定代码回归**；V4 同装置同时段静止对照是 16.8 ms。
   - 「跟手 ≤1px」的口径各家不同：**T105 的 ≤1px** 量的是「鲸鱼 vs 主列」；
     **V2 的 ≤0.90px** 量的是「手指 `clientX` vs `--dshr-drawer-x`」；**V4 的 p95 5.98px**
     量的是「手指 vs 主列」，其残差**恰好等于鲸鱼 `queueDrawerVisual` 的 rAF 一帧视觉滞后**（≈6.5–12 ms）。
     ⇒ **三组数字不矛盾，但判据口径不同**，要一次复核把它统一。
6. **两种「源级证据」形态**（**没有设备级真值**）：① **左右挖孔 / 三键栏**——测试 AVD 的
   `displayCutout` **恒 0**，左右两向只做到「原生写入 + 页面消费 + 源级断言」三级；
   ② **平板右侧栏打开态（三列）未做像素取证**（右栏列已按同一 token 处理，但本轮未实测）。
   ③ 另：**API 30–34 的「导航栏透明」未取真机真值**（本机 Android 15 的 `dumpsys` 已不暴露该字段），
   「透明」由代码层断言 + 像素层无遮挡两条证明。
7. **接管通道的无人值守恢复未达标**：网关重启会丢上游**一次性启动令牌**，换新令牌后 App
   **未自动恢复**（`tier2 reloads=2/2` 用满 + health 恒通）⇒ **手动重载即恢复且零 401**。
   归 T96/T108 的自愈策略，标注未覆盖。

**手机档 hook 的行为补充**（详见 [android/README.md 移动界面](android/README.md#移动界面)）：

- **键盘策略**：**只有「用户主动点击输入框」才会聚焦并弹键盘**；切会话、开侧栏等**非用户手势的
  程序化聚焦会被收回**（同一元素 1.2s 内最多收回 2 次，第 3 次放手并计数，防打环——最坏退回改动前
  行为；这是设计内的上限，不是「一律收回」）。这**有意偏离官方桌面行为**（桌面端没有软键盘问题）——取证显示「切会话弹键盘」在
  平板档关闭 hook、纯官方 UI 下同样复现，属官方行为；「开左侧栏弹键盘」才是本 hook 的回归，已修。
  - **非可编辑触发器落指时「布防」**：`+` 这类按钮不是输入框，却常处在「抬手即自抢焦点」的路径上。
    在其落指瞬间**标注意图 + `inputmode=none` + 自抢焦点**（事件已被 `preventDefault()`，抬手不再抬起键盘），
    焦点由我们主动给出 ⇒ **面板照开、键盘不弹**；用户真点输入框时不受影响，仍正常弹、能打字。
    **布防窗口只给本次落指的元素**（不再整页开窗，否则会挡住「开面板后顺手点输入框想打字」这类正常操作），
    窗口一过即撤。**快速连点也已覆盖**：真实设备上量到的点按间隔为 **119–916ms**，
    `+` 连点 **30 次、弹键盘 0/30**。证据：`scratch/t48/report.md`、`scratch/t51/report.md` §10、
    `scratch/t52/report.md` §7.1/§11。
    > **未实测项**：布防只覆盖**已观测到的**触发器（未逐个按钮穷举），且数据来自模拟器（AVD 无软键盘，
    > `imeShown` 取自真实页面上报值），**不是真机键盘实测**。
- **输入联想浮层锚定**：`/`、`@` 触发的命令面板**保持官方锚点**（贴输入卡上沿），不再被 hook
  的浮层钳位改写，**不压状态栏**。此前会被钳到安全区顶端整条压进状态栏。
- **连接阶段文案实时推进**：检测隧道 / 启动隧道 / frpc 打洞·建联 / 等待就绪（带已等待秒数）/
  打开页面逐段刷新，不再停在同一句过期文案上；就绪轮询提速，**20s 硬顶与打洞 5s 超时未动**。
- **右栏手势（手机档）**：左滑打开官方右栏后，**从面板左缘一条带内右滑可关闭**——
  带宽由 `clamp(round(视口宽×0.11), 24, 48)` 放宽到 **`clamp(round(宽×0.15), 48, 96)`**
  （540px 视口 48→**81px**），且**起手窗整体右移 24px** 让开系统返回手势区
  （Android 手势导航占最外约 24dp，**JS 抢不过、也挡不住**——它在系统输入管线里、早于 WebView；
  实测返回桥命中的最大起点正是 24 CSS px）。
  - **实测收益**（216 格基线矩阵 + 8 档调用栈归因判「谁关的」）：
    用户体感「能关掉」**62.5% → 87.5%**；**hook 自己兑现**（三键导航 / 无手势设备 / 平板全靠这条）
    **25% → 50%**；彻底没反应 37.5% → 12.5%。带外起手仍 0%，方向/距离/纵向三道门未放宽。
  - **别再调那三个参数**：实测门限是**起点 x 的纯阶跃**——距离 150/250/400px、时长 200/350/500ms、
    纵向 25%/50%/75% 三档关闭率**完全一致**（恒 62.5%）。「滑远点 / 放慢点 / 往上滑」这条路已被数据排除。
  - **系统返回键只关面板、不退后台**（与上节「返回键语义」同源）。
  - ⚠️ **如实说明**：`inset=24` 的依据是**结构性事实 + 归因表**（返回桥命中的最大起点 **24 CSS px**、
    hook 接管的最小起点 **32 CSS px** ⇒ 实测右边界落在 24~32 之间），**不是**直接测出来的——
    `adb shell input swipe` 注入的事件不经过系统手势导航监视器。且**调优后的 216 格整矩阵没跑成**
    （基线那份完整），收益数字来自同设备同会话的 8 档逐格归因表。
  证据：`scratch/t47/report.md` §3·§4（原始判据）、`scratch/t66/report.md` §2.2、§3.1、§4.1–§4.2、
  §5.2–§5.3、§10.1–§10.2。
- **发送按钮不再被布防**（手机档）：发送键已从布防触发器名单移除，并新增独立的「发送」识别在
  判定**第一件事优先排除**（覆盖 `aria-label` 中英文 6 种 + composer 卡片内 `button[type=submit]` 兜底）。
  另加一条：**composer 已持焦时布防早退**（焦点没变 ⇒ 官方再抢也是空操作 ⇒ 不会多弹键盘）。
  - **为什么必须两路同改**：只从名单里删一行修不好——兜底分支（任何 `button`/`[role=button]` 的**后代**，
    含内部 `svg`/`path`，只要在 composer 卡片内就命中）实测会让 **40 个元素**被判成触发器。
  - **修的机理**（两条，实测同源）：① 在**一次触摸序列进行到一半**时把 DOM 焦点从别处搬回 composer，
    正是 WebView 可能不再为原目标合成 `click` 的条件；② 500ms 后摘掉 `inputmode=none`，
    此时 composer 仍持焦 ⇒ 浏览器**重新向 IME 请求**弹键盘（对应「点了后键盘又弹出」）。
  - **对「`+`」是恒等变换**：「`+`」不匹配任何发送判据，判定与改前完全一致；实测点「`+`」时布防
    仍 **5/5** 照跑，「面板照开、键盘不弹」的既有结论不受影响。
  > **如实标注：用户在 AVD 上报的「消息发不出去」本轮未能复现**（键盘弹着 / 收起各 1/1 都发得出去）。
  > 因此本条只声称「**移除了发送路径上的抢焦点这个病因**（机理与症状吻合、且可测）」，
  > **不声称症状已消失**。证据：`scratch/t69/report.md` §1.4、§2.2–§2.3、§3.1–§3.2、§4.3。
- **左抽屉既有修复（T82/T84，rc.2.7 复核）**：鲸鱼改读与主列**同一个** `--dshr-drawer-x`、挂**同一对**
  `transition` ⇒ **全程可见**（真机 138 帧隐藏帧 **0**）；`|鲸鱼.x − (10+主卡.x)|` **0px**；
  **header 位移 0px**（改前 `54 → 62` 的 8px 下移已消除）。
  ⚠️ 一处**未达成**：把 `setSidebarOpen(true)` 挪到落位阶段的做法实测会让拖动期侧栏变成
  「宽 360px、可见文本 0」的图标 rail，**已回退**，那一帧（React 提交）的代价仍在。
  证据：`scratch/t82/report.md` §B.2–§B.4、`scratch/t84/report.md` §2。
- **左抽屉观感：圆角卡片平移（rc.2.7，不做缩放）**：新增 token `--dshr-card-r: 20px`（圆角**唯一源**，
  依据是官方同族表面实测——整宽会话卡 `364×67` 用 **20px**、输入卡 `373×110` 用 **28px**）与
  `--dshr-seam`（两张同色圆角卡之间的**缝底**，深色档 `.42`）。跟手期 `border-radius` 与阴影**同源跟手**
  （`calc(var(--dshr-card-p) * var(--dshr-card-r))`），而 `--dshr-card-p = min(drawerX,20)/20` 与
  `--dshr-drawer-x` **同帧写入**；抽屉右缘用同一 token 加圆角，并用 `clip-path: inset(… round 0 R R 0)`
  把**可绘制右缘钉在主卡左缘**。像素判据真值：主卡圆弧误差 **≤0.36 CSS px**、抽屉右缘 **≤1.05 CSS px**，
  真机 `x → 半径` 逐帧吻合 **0 / 12 / 18 / 20**。**「不做缩放」是产品决定**——鲸鱼的 transform 与尺寸
  **一字未改**。证据：`scratch/t91/report.md` §1–§3。
- **右栏两条动画（rc.2.7，术语别混）**：**打开 = `width` 过渡（不是跟手）**——官方承载容器两态恒宽 0，
  故 hook 自建**裁剪窗**（`width` = 窗宽、`overflow: clip`、`translateX(-100vw)`、面板重锚到容器左缘），
  实测 **16 个中间态 / 283.3ms / 帧 p95 16.8ms / 长任务 0**（改前 **1 帧**到位），官方状态机逐字未动，
  **官方折叠按钮那条路径保持瞬时**（本轮只做手势路径）；**关闭 = `transform` 跟手**——手指 120px →
  写入 120px → 面板位移偏差 **0px**，松手补间 **21 个不同位移位置 / 333ms**；两条不变量
  （面板中部右滑 no-op、打开态左滑 no-op）真值成立。证据：`scratch/t85/report.md` §1–§5、
  `scratch/t82/report.md` §A.3、`scratch/t91/report.md` §4–§5。
- **重连判据与自愈（rc.2.7，本批次最重要）**：页面侧**没有任何现成只读连接态**
  （17 个 DSH 全局三拍差分只有自装观测器在变；`__DSH_CONNECTION_RECOVERY__` 只是参数，**单跳上限 10s**）
  ⇒ hook 包装 `window.WebSocket` 观测（真机抓到 `wss://…/api/remote.mux`，**9 条透传**断言全绿；
  平板档完整还原、零痕迹）。判据两层且**与原生逐字同源**（源码契约同时读 `mobile-web.js` 与
  `ReconnectBanner.java` 比较字面量）；**官方那条只在左栏展开时渲染**（官方源码 `state: wide && …`，
  `wide = !collapsed`）——这正是「**只有拉开左侧栏才看得到重连提示**」的根因。原生横幅以 hook 连接态
  **OR** DOM 探针为数据源、按「**将要占据的带区**」抑制（rail 态实测 `t_kill+1495ms` 出现、不可点不可聚焦、
  **不吞触摸**）；自愈 nudge **6 次**（间隔 8.0–9.0s），「**服务端已回来 → 页面发起第一次重连**」
  **5496ms → 681ms（8.1×）**，健康态零开销。
  ⚠️ **口径纠正**：本机运行时（npm `0.2.0-rc.2` 下发的 bundle + 桌面 `app.asar` **全量字节扫描**）
  **不存在 `isFinalBackoffTier`**、`attempt` 无上限 ⇒ **没有「退避跑完 6 次就永久停泊、不再自动重连」
  这回事**；「30 秒」是**多次退避 + 服务端尚未恢复**的累积。证据：`scratch/t86/report.md` §4–§5、
  `scratch/t88/report.md` §A–§C、`scratch/t90/report.md` §1–§6·§12、`scratch/t87/report.md` §1·§6.4。
- **半开检测与回前台探活（rc.2.8，T95）**：用户症状是「切后台几分钟回来，界面停在
  **重新连接中**、几分钟不恢复」。**第一因不在我们这层**——上游 mux 载体
  （`dsh-api-gateway/lib/client.js`，唯一建连点 `new WebSocket()`）**没有握手超时**：
  `maintain()` 首个 `return` 就把那次挂死的握手持有了，`failAll()` 只在 `close` / `error` 才走
  ⇒ 握手挂死时 `open` / `error` / `close` **一个都不来**，客户端**永远停在 connecting**；
  而 hook 的 nudge 作用在上层 generation，**够不到它**。
  - **修法（只改 hook，未改 Java）**：回前台（后台 **≥ 20s**）**主动探活** = 同源绕缓存
    `GET /__dsh_remote__/health?__dshr_probe=<ts>`（探的是**隧道 / 传输链路**，不是上游会话）
    + **3s 硬超时**（`AbortController`）⇒ 判「断」、把结论并入 `isConnectionDown()`、
    报给原生自救层并**立刻推**一次；回前台 5s 窗口内可**跳过 8s 最小间隔**，
    另加 **1.5s 硬地板**（任何两次推之间不得短于它）。
  - **真值**：半开场景改前「判据说健康 / 0 推 / 无横幅」→ 改后「探活超时 ⇒ 横幅 + nudge」；
    **回前台首次推 6763ms → 1307ms（5.2×）**（同装置同断言）；健康态探活 **0 / 0 / 1 次**
    （20s 闸拦住短后台），**无新定时器**。
  - **三条实测硬约束（写下来免得重踩）**：
    ① **断链上重载会把页面一次性打死**（`ERR_TIMED_OUT` + 错误页，链路恢复后**仍不恢复**）
    ⇒ 重载**必须由原生做、且先探活**（见下 T96 的链路闸）；
    ② **健康链路上重载能回到同一会话（3s）**——此前「重载会掉到 chooser」的认知**被证伪**，
    那只是「重载时链路已断」时的现象；
    ③ **健康会话本来就完全静默**（75s **零帧**）⇒ **不能用「静默」当半开判据**。
  - 证据：`scratch/t95/report.md` §1.4–§1.5、§1.8、§2、§3.2–§3.5、§7。
- **卡住自救：`StuckRescue`（rc.2.8，T96）**：用户症状是「切后台几分钟回来卡住几分钟不恢复；
  杀掉重开十几秒就好」。**第一因**：平板档 hook 的 **WS 观测没装**，只读 DOM 探针虽可用但
  **没人消费**（`probeResumeRecovery` 只有三个入口，平板档缺 WS 那个；而 1s 巡检要等首次判「断」
  才装 ⇒ 平板档永远等不到）。
  - **修法**：新增纯 Java 状态机 `StuckRescue.java`——**温和层**（`evaluateJavascript` 派发
    `offline`→`online` 瞬态对）0s / +8s 各一次 → **+12s 升级层**受控重载；**手机档让位**
    （hook 自己会做，阈值抬到 **25s**，给 hook 的确认 + 巡检留整段时间）；
    防风暴：温和层 **2 次 × 8s**、重载 **2 次 × 60s**、到顶后**只剩观测**。
  - 🔴 **链路闸（被真机打出来的）**：**升级前先用 `PinnedFetch` 取 `/__dsh_remote__/health`，
    不通就撤回**。v1（无链路闸）实测在断链上重载，把页面打成了 `chrome-error` 错误页。
  - **真值**：**平板后台 5 分钟回前台 13.6s 恢复**（其中重载提交 → 恢复 0.8s，会话保持：
    同一 `sessionId`、`sameSession=true`）；**改前同场景 ≥ 100s 仍卡**。
    健康态**零开销**：不新增任何定时器 / 回调，只挂在既有 500ms 探针后面、健康时一次比较即返回。
  - 证据：`scratch/t96/report.md` §1.1–§1.3、§3.1–§3.4、§4.1–§4.4。
  > ⚠️ **一处取舍（如实）**：平板档「温和层派发」会让**官方客户端自己**重渲染一次
  > （实测 `nodes 475→480`、`outerHTML` **+452B**，**不是我们写 DOM**，也没引入新的痕迹类别）。
  > 若要「DOM 逐字节相同」的硬门槛，`runStuckRescue` 里对 `isTabletClass()` 跳过温和层
  > **一行开关即可关掉**（平板档只走 12s → 升级层）。当前**未改**。证据：`scratch/t96/report.md` §5、§7。
- **横幅不再滞留（rc.2.8，T96）**：横幅一直挂着**不是探针去抖失配**，而是「**页面真的还卡着**」的
  忠实反映——探针持续匹配 ⇒ 永远凑不满 3 拍 OK。治法 = 治掉卡住（上一条）
  + **升级动作发生时立即收起** + **新文档提交清零**。证据：`scratch/t96/report.md` §1.3、§4.3。
- **系统栏沉浸：那两条的颜色跟着页面走（rc.2.8，T94）**：状态栏 / 导航栏那两条画的是
  **`rootLayout` 的底**（T80 把让位落成 WebView 外边距后露出的父容器），**改前是硬编码**
  `dark ? 0xFF141414 : WHITE`；而平板档 hook 严格关闭（rc.2.8 起也只是最小 hook、不参与配色）
  ⇒ 只能用**系统主题**猜 ⇒ **页面主题 ≠ 系统主题时那两条与页面反色**（用户症状）。
  - **修法 = 只读探针**：采样「贴着系统栏那条边，页面真实画的颜色」（`elementFromPoint` +
    逐层合成 `background-color`），同步到 **rootLayout + 状态栏色 + 导航栏色** 三处；
    **1.5s 只读轮询**跟随主题切换（回前台起、切后台停），页面内改主题也能跟上。
  - **像素真值（逐字节相等：R=G=B 三通道 0 差）**：平板 4 组（系统浅 / 深 × 页面浅 / 深）
    **两条带 == 左栏色**；手机两组**三色相等**。与主列残差 ≤ **7/255**。
  - ⚠️ **一个颜色无法同时贴合左栏与主列**——取舍是**贴边那列**（用户症状所在），如实写明。
  - `targetSdk=34` ⇒ 在 API 35 上两个着色 API **仍然生效**（决定性实验：让 `rootLayout` 回到
    硬编码 `#141414`、导航栏色仍是采样到的页面色，底部那条读到的就是采样的颜色 ⇒ 是系统按
    我们给的颜色画的）；**但手势导航下导航栏由系统画成透明、着色不生效** ⇒ **必须自己画**（`rootLayout`）。
  - 证据：`scratch/t94/report.md` §1.1–§1.3、§2.1–§2.3、§3.2–§3.6、§4.1–§4.3、§8。
- **平板档系统栏避让（`sw ≥ 600` 会话页）**：让位算式改为**逐方向并集**
  `systemBars() | displayCutout() | tappableElement()`（`getInsets` 对掩码内各来源逐边取 max，
  **不求和**；掩码**不含 `ime()`**，键盘仍只走平移那条路）；API 24–29 走四向
  `getSystemWindowInset*` + API 28+ `DisplayCutout.safeInset*`，并修掉栏隐藏时多垫的问题。
  - **`uiState` 的游标写入收敛到唯一入口 `setUiState(...)`**（赋值当句即重算让位，`WEB` 态再补
    一次 `post` 兜底）⇒ **结构上不可能再漏**。这治的正是 rc.2.1→rc.2.5 那种
    「三条记得补、一条忘了补」的约定失效模式。
  - **用户那台 Xiaomi Pad 命中的正是旧实现唯一漏调的那条路径**（`uiState→WEB` 四条里只有
    FRP / 隧道那条没补让位重算，而访客/FRP 模式就走它）。负控制把这两行摘掉即**精确复现症状**：
    冷启动首帧 top 重叠 **48px**、bottom 重叠 **64px**（顶进状态栏 + 被底部任务栏盖住，双向同时错位）。
  - **实测**：横/竖屏 × 手势/三键/任务栏拉出共 5 格，**4 方向重叠量全部 0px**；
    任务栏在**三键**格被 `tappableElement` 独立上报 **112px** ⇒ 掩码里加它是**承重的**，不是保险性空转。
  > **未取证项（如实）**：AVD 无挖孔 ⇒ `displayCutout` 分支只由 javac 替身覆盖，未在设备上跑过；
  > 状态栏/导航栏落左右同样只在替身上覆盖；冷启动首帧**未做像素级取证**（进真实会话需建会话，
  > 本轮禁止），替代证据是时序格 + 负控制 + 6 条源码契约断言。证据：`scratch/t72/report.md` §1–§2、§5、§7。
- **前端缓存（本轮最大收益）**：见下方 [前端缓存与 SW 供给](#前端缓存与-sw-供给)。

**真机自查与安全行为变化**：

- **连接设置页曾有一行只读诊断行**（「页面适配诊断：档位 phone · 钩子 是 · 根类 dshr-mobile ·
  收敛 是 · 鲸鱼 是 · 三栏 是 · 严格关闭 否」，未连上时显示「未上报」），由页面经 JS 桥回报，
  用来在真机上判断 **hook 到底有没有生效**——不必再靠无障碍树猜。纯文本、无点击、不新增控件。
  > **rc.2.9 → 下一版（T117）**：这一行（以及后面陆续接上去的 8 行）**已从 UI 删除**（用户要求）；
  > 同样的内容改由 logcat 标签 `dshr-diag` 输出，取回方式见 `android/README.md`。
- 适配自检改判「**效果**」（根类 + 鲸鱼可见）而非「装上了没有」，未达效果会同步修复并重试
  （最多 3 轮）；**首连、页面 reload、会话内导航、回前台**都会重排一次自检（重定向风暴下有上限：
  3s 最小间隔 + 60s 内最多 4 次），页面重载后坏掉的适配不再无人补注；平板档仍整体跳过（零痕迹）。
  连接失败给出 **App 自己的失败壳**（「重新连接」入口不再被降级成 Toast 而消失）。
- **证书锁定改按「配置档」记指纹**：有配置档身份时**只看该配置档自己的键**，没有就走 TOFU
  「信任此服务器？」，**不再回退**共享的地址键（那把键可能是另一台 PC 写下的，会把「首次见到」
  变成假的「证书已变更！」）；地址键只服务**直连 / 局域网节点**。两台不同的 PC 共用同一个回环
  端口时不再误报，而**同一配置档内证书真变更仍会强提示**中间人风险。顺带修好导入链接里指纹被
  丢弃的死代码。
  > **升级代价（刻意接受）**：升级安装的存量地址键对配置档连接一律被忽略 ⇒ 每个配置档**首次**
  > 连接会多一次 TOFU（「信任此服务器？」），信任后即按该档锁定、不再问。已经写过配置档键的
  > 配置档不受影响（仍直接放行）。

> 浏览器 / Edge 注入路径的判档规则**维持现状**（仍按视口宽度断点），不受本规则影响。

## 下一版（T117，尚未发版）：设置页诊断块下线 + 兜底探针降频 + 配对 flush

> 版本号留给发版人（`pnpm ver:bump`）填；本节按 T116 的「本批的用户可感知变化」同一格式写，
> 便于发版时直接并入。设备真值、原始 logcat、截图全部在 `scratch/t117/report.md`。

### 设置页那串诊断整块删除（用户明确要求）

- 用户原话：「请你顺手把你之前加的那些测试用的内容删了吧，免得徒增耗电。**比如这串诊断字样**。」
  删掉的正是连接设置页上那 9 行：`页面适配诊断 / 文件选择 / 并发峰值 / 落盘缓存 / 未拦 /
  打洞策略（配置）/ 本次隧道 / 重连探针`。
- **保留**的是人话级提示与可操作入口：`隧道仍在运行。点上方「返回当前会话」继续，无需重新连接。`、
  连接失败原因与「重新连接 / 返回服务器列表」。判据：设置页上不再出现任何**计数器 / 键值对 /
  `hook=… 陈旧 …s`** 字样（改后截图见 `scratch/t117/report.md` §3）。
- **信息没有丢**：同一份内容改由 logcat 标签 **`dshr-diag`** 输出，**只在值变化时打**
  （时间类单调量"拍数/陈旧秒数"从判重键里归一化掉 ⇒ 稳态实测 **0 行/分**）；
  **打开设置页**这一动作会无条件打一份完整快照。取回方式见 `android/README.md`。
- **采集与记账一个字没删**：并发闸 `PinnedFetch`、落盘缓存 `StaticDiskCache`、路径记账
  `TunnelPath`、探针拍数全部照跑，删的只是"画到屏上"这一层。

### 兜底探针 1000ms → 5000ms（这才是省电要点）

- 那串文字本身几乎不耗电（静态文本，只在设置页可见时绘制一次）；**真耗电的是它最后一行暴露的
  `节拍 1000ms`** —— 平板档没有 hook 推送通道 ⇒ 兜底探针**每秒一次**，健康态也白跑。
- 改动：无推送通道档 `PROBE_IDLE_MS` 1000ms → **5000ms**，与有通道档一致 ⇒ **两档合并成一个常量**，
  `probeIntervalMs()` 的健康态分支只剩 `return PROBE_IDLE_MS;`。
- 实测（本任务装置，平板档 2560×1600 + 会话页注入 3000 节点）：兜底探针
  **60 拍/分 → 12 拍/分**（`/proc/<pid>/stat` 双进程口径 CPU 同向下降，真值见 report §3）。
- **不许削弱卡住自救**：`StuckRescue` 的温和 2×8s / 12s 升级 / 链路闸语义**一个字没改**；
  5s 一拍远快于 12s 升级阈值，实测（平板档硬杀网关）依旧 nudge → tier2 意图 → 链路闸撤回，
  网关恢复后页面自愈（时间线见 report §3.4）。

### 配对成功后立刻 flush cookie（强杀不再回配对页）

- 病灶：`dr_device`（HttpOnly）是**配对成功那一刻**由网关 Set-Cookie 下发的；WebView 默认先留内存、
  之后再批量落盘，而改前唯一的落盘点在 `onPause` ⇒ **前台直接 force-stop 就整条丢掉**，
  下次进来网关认不出设备、又跳回配对页（表现为"明明配对过还要再配一次"）。
- 改动：在 `enterSessionPage()`（配对成功落的会话文档）与 `handleImportIntent()`
  （导入链接写入配置组之后）各加一次 `CookieManager.flush()`。
- 实测（本任务装置，手机档）：改前强杀后点直连节点 **2/2 落回 `__dsh_remote__/pair`**；
  改后 **落会话页 `/`**（真值见 report §3.5）。

### 局域网模式（可选，无 VPS 时先用起来）

默认网关只监听 `127.0.0.1`（最安全）。想在家里 WiFi 直接用手机访问：

```jsonc
{ "listenHost": "0.0.0.0", "listenPort": 18443, ... }
```

并在 Windows 防火墙放行该端口。手机浏览器打开 `https://<电脑局域网IP>:18443` 配对即可。
认证门对所有来源生效，但请仅在可信家庭网络使用此模式；出门在外请走 frp 通道。

### Edge 部署（服务器侧，iPhone/iPad 浏览器直达）

把网关搬到公网 VPS 上跑（Docker 或裸机一键脚本）：自带 frpc/frps、前置访问 Token
认证（登录即自动配对设备）、窄视口自动套 Android 端同款移动 hook 布局——
iOS 无需任何 App。该路径的判档仍按**视口宽度断点**（`device` 缺省 `auto`），
不使用 Android 壳的 `smallestScreenWidthDp` 设备档位规则：

```bash
cd deploy/docker && cp .env.example .env   # 填域名与访问 Token
docker compose up -d --build
# 或裸机：sudo bash scripts/install-edge.sh --token <访问Token>
```

详见 [docs/edge-deployment.md](docs/edge-deployment.md)。

### 3. 手机配对

```powershell
node packages/gateway/src/cli.ts pair --name 我的手机
# 终端出现二维码 → 手机扫码（或手动访问入口地址）→ 输入配对码
```

配对一次长期有效。设备管理：

```powershell
node packages/gateway/src/cli.ts devices          # 列出已配对设备
node packages/gateway/src/cli.ts revoke dev-xxxx  # 吊销
```

### 4. （可选）随 DSH 自启

```powershell
cd packages/plugin
node scripts/install.mjs        # junction 进 profile 农场 + 写 patch 行
node scripts/uninstall.mjs      # 卸载
```

不带 `--profile` 时自动识别目标：存在 `~/.dsh/profiles/desktop`（官方桌面端）装
desktop，否则装 web；显式 `--profile <名字>` 永远优先。重启 DSH 后，网关随 profile
自动拉起（`config.json` 里 `"autoStart": false` 可关闭）。

### 5. 设置面板（设置 → 插件 → DSH Remote）

插件已接入 DSH 官方的插件设置扩展点，重启 DSH 后在 **设置 → 插件** 页会出现
「DSH Remote」卡片，可视化完成：

- frp 隧道开关、VPS 地址、控制端口、**隧道名**（写进 frps 的 proxy 名，缺省 `dsh-remote`；多人共用一台 VPS 时必须互不相同）、登录密钥、访客密钥（共享密钥仍走 `secrets.json`，面板可改）
- 监听面切换（仅本机 / 局域网）、上游端口与自动跟随开关、随 DSH 自启开关
- 网关状态实时展示（运行中/离线、已配对设备数）
- 一键生成配对码、一键重启网关

所有修改保存后自动写入 `~/.dsh-remote/config.json` 并重启网关生效；等价于手改
配置文件，两条路径随时混用。

## 安全模型（摘要）

- **网络层**：网关只监听 `127.0.0.1`，局域网/外网都摸不到；访客模式（stcp/xtcp）下
  公网上连 DSH 的端口都不存在（只剩 frps 控制口），只有持密钥的设备能连入；
  entry 模式公网暴露 VPS 上 frp 的两个端口。
- **认证层**：一次性配对码（10 分钟有效、用后即焚）换取长效设备 Token（httpOnly Cookie，
  服务端只存 SHA-256）；配对失败 5 次锁 IP 15 分钟；每 IP 滑动窗口限流。
  管理端点（`/__dsh_remote__/admin/*`）仅回环可达，并叠加共享密钥门禁
  （`x-dshr-admin-token`，密钥存 PC 本机 `state/secrets.json` 自动生成，公网侧无从获取）。
- **传输层**：手机↔网关 TLS（自签，指纹可校验；壳 App 将做证书锁定）；frpc↔frps 隧道 TLS。
- **隔离层**：设备 Cookie 不转发给上游 DSH；上游 DSH（0.1.2+）的浏览器会话 cookie 与
  启动令牌也绝不下发手机端（只存在于 PC 本机网关进程内存）；审计日志记录全部配对/拒绝事件。

完整说明见 [docs/architecture.md](docs/architecture.md)。

## 前端缓存与 SW 供给

> 时序口径：以下机制**自 rc.2.4 起已在设备上生效**；rc.2.5 收口文档与验收包，
> **rc.2.6 是收口「数字」**——把一处被误读的传输量、两处被误读的机制口径就地纠正（见下表脚注与
> `PinnedFetch` 并发一节）。

这是收益最大的一项：根因是官方 DSH 首屏那套固定资源（`/plugins/` 三包 5.14MB + `/assets/` ≈6MB）
**每次进入都整包重下**。做法分三步——**让 SW 脚本不必走网络**、**让 SW 取数只信已经落盘的锁**、
**让首屏静态资源由 App 原生直接落盘**。

| 机制 | 做法 |
|---|---|
| **SW 脚本由 App 本地供给** | SW 脚本改由 `ServiceWorkerClient` 从 APK 内直接返回，绕开网关的 `GET /sw.js` |
| **SW 取数走 `PinnedFetch`** | SW 内部取数不再裸奔 TLS，而是走与主框架**同一套**证书锁定链，且**只有已锁定的 `TRUSTED` 指纹才放行** |
| **首屏静态资源原生落盘** | `/assets/`·`/plugins/` 的首屏 GET 由 App 直接写进应用私有目录，SW 那条取数路径**读同一目录** |
| **`/plugins/` 按 rev 缓存** | 官方插件包按 `rev` 整包缓存，命中即 0 传输 |
| **`/assets/` 按内容寻址** | 判据是 **`isContentAddressed(url)`**（内容地址：路径、`rev=` 参数、内容哈希文件名），**不是**响应头 |

**实测收益（口径以 rc.2.6 为准）**：

| 场景 | `lo rx` 传输量 | 可严格归因的部分 | 证据 |
|---|---|---|---|
| 冷加载首屏（`/plugins/` + `/assets/`） | ≈6.0 MB | — | `scratch/t63/report.md` §1.1(c) |
| **进入 #1**（装 / 升级后的**缓存填充轮**） | **5,906,128 B** | — | 同上 |
| 进入 #2 | 113,605 B | — | 同上 |
| 进入 #3 | 116,556 B | — | 同上 |
| **稳态（每次进入）** | **≈113–117 KB** | — | 同上 |
| 落盘后进入 #2（逐条对账） | **6,264,975 → 544,640 B** | — | `scratch/t65/report.md` §3.3 / §3.4 |
| 后台静默 600 s（改前） | 194,067 B | `pinnedFetch` **1 次 / 3,634 B**（`/favicon.svg`） | `scratch/t63/report.md` §4.1 |
| 后台静默 600 s（**改后**） | 154,624 B | `pinnedFetch` **0 次 / 0 B**、**0 次回源** | 同上 |

> ⚠️ **两处数字纠正（重要，别再引用旧值）**：
> ① **稳态是 ≈113–117KB，不是 13MB**。13MB 是**两处东西叠在一起**造成的误读：
>   **(a)** 那个数是 `PinnedFetch` 的**按连接累计**计数器（结算行原文 `total=12,974,837`），
>   而 `MainActivity` 只在 `openGateway` 时 `resetStats()` ⇒ **`total` 记的是「本次连接以来全部」**，
>   把**冷加载**也记进去了；**(b)** T60 拿 `Page.reload` 当「二次进入 / warm 期」，
>   量的其实是**进入 #1 这个缓存填充轮**（5,906,128 B，SW 缓存条目 1 → 8）。
>   缓存填充是**一次性**的，第二次进入之后就不再发生 ⇒ 每次进入的真实代价就是三位数 KB。
>   证据：`scratch/t63/report.md` §1.1(a)(b)(c)、§5-U1。
> ② **「内容寻址」的判据换过实现**（`/plugins/` 与 `/assets/*` 走的是**两条闸门**，别当成一道）。
>   - **改前**：后台重验要不要发起，判据是**缓存里那条响应的 `cache-control` 有没有 `immutable`**
>     （旧 `cachedCc` 分支）。两个毛病：① **判据在别人手里**——`immutable` 是上游 dsh-gui / 网关
>     `proxy.ts` 加的响应头，上游哪天自己改掉就**静默失效**，11.5MB 的 `/plugins/` + 约 2.9MB 的
>     `/assets/*` 全量重验立刻回来，而**代码与注释都还写着「已关」**（正是 T53 判为「假账」那一类）；
>     ② **判据与事实无关**——「内容变则 URL 变」这件事**只看 URL 就能判定**。
>   - **改后**：判据换成 **`isContentAddressed(url)`**（`/plugins/` 组合包路径 · 带 `rev=` 参数 ·
>     构建期哈希文件名）。其中 `HASHED_NAME` 与 `proxy.ts` 的 `HASHED_ASSET` **逐字同形**
>     ⇒ 网关标 `immutable` 的那些文件名 SW 一定也认成内容寻址，**两边判定不会漂移**。
>     响应头的 `immutable` 检查**保留**为额外一条（代价只是一次 header 读取），但**不再指望它兜底**。
>   - **实测（后台静默 600s）**：改前 `pinnedFetch` **1 次 / 3,634 B**（唯一被重验的
>     `/favicon.svg`）⇒ 改后 **0 次 / 0 B**、**0 次回源**。
>   - **为什么「不重验」不等于「拿不到新版」**（本轮最关键的一条论证）：**正确性从不依赖后台重验，
>     因为主文档永远不走缓存**（`pwa.ts` 里 `if (request.mode === "navigate") return;`）——
>     每次进入都从网络拿**新文档**，而**只有主文档会说出新版的资源 URL**。于是 `rev` 变了
>     ⇒ 新 URL ⇒ 未命中 ⇒ 回源，**绝不把旧包当新版发出去**；favicon 这类 URL 不随内容变的
>     **有意保留 SWR**（关掉就等于「升级后 favicon 永远停在旧版」，KB 量级，与大包不同量级）。
>   证据：`scratch/t63/report.md` §2.1–§2.5、§4.1、§4.3（改 `rev` ⇒ 必然回源，是读数不是论证）。
> ③ **后台那两行的差值（194,067 → 154,624 B）不是省下的 SWR 字节。** `lo rx` 里含
>   `/plugins/events`（SSE）与 WebSocket 的**长连接心跳**——那是页面开着就必需的流量。
>   **能严格归因给 SW 的只有 `pinnedFetch` 计数：改前 1 次 / 3,634 B，改后 0 次 / 0 B**；
>   两者差值落在心跳噪声量级。另外 `lo` 本来就**不会**归零（心跳一直在），期望值是「≈0」，
>   而 `pinnedFetch` 计数**确实达到了 0**。
>   证据：`scratch/t63/report.md` §4.1（含两条诚实限定）、§5-U5。
>
> **未构造项（如实）**：**跨进程重启后进入的稳态字节本轮未单独测**（只测了同进程内三次进入）。
> 已知结构性事实是跨进程会丢内存态、但**不会**丢 CacheStorage（落盘），故 SW 命中与同进程一致，
> 差别只可能来自 WebView 自身 HTTP 缓存是否落盘——对此**不下结论**。证据：`scratch/t63/report.md` §1.4、§5-U4。

### 收益折算的来源（如实标注）

| 链路（少传的字节） | 3 Mbps | 6 Mbps | 20 Mbps |
|---|---|---|---|
| rc.2.4 批次合计 5,613,123 B | 14.97 s | 7.48 s | 2.25 s |
| 落盘后进入 #2 少传 6,264,975 B | 16.71 s | 8.36 s | 2.51 s |
| **稳态每次进入 ≈113,605 B** | **0.30 s** | **0.15 s** | **0.05 s** |

⚠️ 这张表是**回环实测字节 × 线性折算**，**不是真机带宽实测**。要拿到真机数字必须在真实弱网下计时，
本轮没做——所以只按「少传了多少字节」表述，不写成「用户实际快了多少」。第三行是**稳态**的量级：
换到弱网上，稳态那点字节已可忽略，**真正值钱的是头两次（冷加载 ≈6.0MB + 填充轮 5,906,128 B）
不再每程重付**。

### 首屏静态资源原生落盘（App 直写 + SW 读同一份）

`/assets/`、`/plugins/` 的首屏 GET 现在由 App 自己**落盘**，SW 那条取数路径**读同一目录**，
两条路径不会再各存一份逻辑。

| 项 | 做法 |
|---|---|
| **五道门** | `GET` · 非主框架 · `https:` **且 origin 等于当前网关** · 路径**非** `/api/` 与 `/__dsh_remote__/` · 路径在 `/assets/` 或 `/plugins/` |
| **键** | `SHA256(完整 URL，**含 `rev` 参数**)` ⇒ 同 URL 变体天然分键、不会串包 |
| **存什么** | **解压后的字节**（响应体直取，**不是编码态**）⇒ 回源不会再叠加一层 deflate |
| **写入方式** | `tmp` 文件 → `rename` 原子替换 ⇒ 任何时刻读到的都是完整文件 |
| **上限** | **48 MB / 64 条**，**真执行**（不是常量摆设）。稳态只用到 12.9 MB < 48 MB，**本轮没触发**；为不留「注释说有上限、实现里没验证过」这种假账，专门构建了**临时降配探针**（48 MB→**2 MB**、64→**3 条**）跑一次首连，拿到真实日志 |
| **失败即 bypass** | 落盘侧任何异常都**放行回源**，不阻断加载；下一次仍会再试 |

- **实测收益**：**第 2 次进入 6,264,975 → 544,640 B（−91.3%）**。改前 6,264,975 B 正是 T59 §6.1
  记的「实质反例：第二次仍全量」——**那个反例被消掉了**。
  口径诚实说明：544,640 B **不是「纯 0 传输」**，它由主文档（36,908 B）、favicon、若干 `/api/*`、
  以及 `/plugins/events` 这条 SSE 长连接在测量窗口内持续吐的字节组成；**静态资源那一项的传输是 0 字节**
  （7/7 读盘，日志逐条可查）。证据：`scratch/t65/report.md` §3.3–§3.4。
- **降档探针证明了「上限存在」且「上限生效」是两件事**：探针那轮**字节**与**条数**两条闸门
  **都真的执行了、两个触发原因都真的出现过**，每行都带删前/删后字节与条数（可从 logcat 直接读出），
  且**页面仍正常渲染**（刚写完就淘汰也已把字节交回本次加载，淘汰不打断当前这一次）。
  探针**已逐字节还原**，`2 MB / 3 条` 不是交付值。
- **但它换不来毫秒（别对外承诺速度）**：**没有做「接管前后同一条件 A/B」的 DCL 墙钟对照**
  （降档探针那轮反而更快，因为不写盘；正常轮与改前的首屏基线不可直接相减）。
  已取到的时点只有：N1 `t+10557ms`（含 TOFU 弹窗等待）、N2 `onPageStarted t+851ms`。
  ⇒ **只做到「未观察到变慢」，没做到「证明不变慢」**。
  证据：`scratch/t65/report.md` §9.7。
- **占盘要按「双份」算**：App 私有目录 **≈12,812 KB** + SW CacheStorage **≈22,652 KB**
  ≈ **35.5MB**（内容相同、各存一份）。增量价值是那一次性 6.15MB（实测省 5.73 MB/次），
  代价是常驻多占 **~12.8 MB** ⇒ **这是一个明确的取舍，不是免费的**。
  若将来要撤掉本目录，只需删 `interceptStaticAsset` 与 `fetchForServiceWorker` 里的查盘两处，
  SW 侧行为完全不受影响。证据：`scratch/t65/report.md` §5.1–§5.2、§9.6。
- ⚠️ **三处如实记下的限制**：① **淘汰不删空分桶子目录**（极端降配下 `du` 8 KB→64 KB），
  不影响正确性与上限语义，但确实存在；② **「LRU」是近似的**——`File.setLastModified` 在
  API 23+（minSdk 24）被系统一律拒绝，故命中**不刷新** mtime，淘汰按**写入时间升序**近似；
  旧 `rev` 僵尸仍会先走，但「当前版本 + 上一版本」这种跨代偏好没有严格保证（反向风险由
  48 MB / 64 条两条硬顶兜住）；③ **「网关换内容却不换 `rev`」的窗口**天然规避不了——
  现状由 T50 §2.3（`rev` 随插件集合变化 + 哈希文件名补 `immutable`）判定不构成真实风险，
  但那是**继承来的**约定，**不是这一层加的保证**。
  证据：`scratch/t65/report.md` §9.3–§9.5。
- ⚠️ **本轮未做**：**没在设备上真做一次 DSH 升级**去验证「换 `rev` 后能取到新资源」——
  该条依据是「键含 `rev`」的设计 + T63「`rev` 变了必须回源」的测试（`test:perf` 25/25 里通过），
  **不是**设备实测。证据：`scratch/t65/report.md` §9.9。

### 磁盘缓存「0 条」是预期行为，不是故障

> **排查缓存问题前先读本节，避免把预期行为当 bug 反复查。**

自签证书下走 `onReceivedSslError → proceed()` 的响应，**按 Chromium 策略不写 HTTP 磁盘缓存**
（`Proceed` 会把该响应标记为不可缓存）。这是**设计使然**：

| 台 | 状态 | 说明 |
|---|---|---|
| **HTTP 磁盘缓存** | **恒 0 条** | 预期。**不要**拿 `fromDiskCache` 判命中，**也不要在它上面挂「缓存失效」告警** |
| **SW CacheStorage** | 8 条 / **12,960,301 B** | 跨进程、跨重启**存活**，**逐字节校验全等**（`60/60` 项一致，0 差异） |
| **DOM Storage** | `deleteAllData()` **会清** | 用 canary 键隔离实测：**只清 DOM Storage** |

- **`WebStorage.deleteAllData()` 只清 DOM Storage**：**不清** CacheStorage、**不清** SW 注册
  （`localStorage` / `sessionStorage` / `indexedDB` / `webview` canary 键**全部未变**）。
  ⇒ 「清了数据还是走缓存」是**正确行为**，别当清理失败反复试。
- **验收必须配 `du -sk` + 网卡字节**：`caches.keys()` 会**低报**——Chromium 的 CacheStorage
  索引是**按需/惰性加载**的，没被读过的条目**不 materialize**。实测一次 `force-stop` + 重启后，
  页面里读到的是 **1 条 / 3,634 B**，而**磁盘上仍是 22,692 KB / 19 文件**、新进程 `pinnedFetch` **0 次**
  ⇒ 那 7 条**没有下载、没有重取，是从磁盘上「长」回来的**。可靠探针是三条：
  ① 磁盘 `du -sk`　② 边界前后 `lo` 字节　③ **完成一次导航后**的条目数。
  只看 `caches.keys()` 会得出「缓存全丢」的**相反**结论。
- ⚠️ **口径边界（如实）**：上述 `deleteAllData()` 的清理范围结论**只在 WebView
  124.0.6367.219 / Android 15 上实测成立**。该 API 清什么属**实现相关**，换版本需重测。
  证据：`scratch/t54/report.md` §3.2–§3.3、§B.1；`scratch/t62/report.md` §2.1–§2.3、§3、§5.3–§5.4。
- 证据：`scratch/t54/report.md` §3.2–§3.3、§B.1（策略定性 + 24 次请求 0 落盘 + canary 隔离）；
  `scratch/t62/report.md` §2.1–§2.3（8 条逐字节、跨重启存活、`deleteAllData` 边界、`caches.keys()` 低报）。

### `PinnedFetch` 加固，以及并发口径必须纠正

**加固**（`scratch/t60/report.md` §1.1–§1.3，均在 AVD 上量化过）：

| 项 | 值 | 为什么 |
|---|---|---|
| 单请求体硬顶 | **32 MB** | 单体无界可被 `compress bomb` 或坏资源放大成 OOM；只收 `GET` + 静态域，其余**照常直连** |
| 总量 deadline | **45 s** | 卡死不再无限占线程；**超限抛异常**而不是给半份数据（半份会变成静默截断，最难查） |
| deflate | **真支持** | 自实现层此前把 `Accept-Encoding` 原样发给上游，但**解码时没实现 deflate** ⇒ 只要上游真 gzip 就 `DataFormatException`。反代**不剥** `Accept-Encoding`，所以这是**真实会踩到的错**，现已真支持 |
| 诊断计数 | `并发峰值` / `排队` / `拒绝` / `累计B` | 4 个计数器。排队数**恒 0**，拒绝数**恒 0**，累计 B **只做归因**（谁在传、按什么语义传），**不参与任何判定或限流** |

**并发闸门是防御性护栏，不是当前环境的收益来源**——这是必须纠正的口径：

- 实测 **App 进程内 `peak` 恒为 1、无排队**：WebView 在此环境**串行**派发，一个资源不取完不派下一个。
  ⇒ 32MB/45s 那些**一个都没被拦下**（`拒绝 = 0`）。它们的价值是「**万一**派发变并发时仍不失控」。
- ⚠️ **T55 报的「并发 12」是假象**：那是**浏览器请求窗口**（含**排队时间**）量出来的，
  不是 App 进程内的真实并发数。同一段取证里**闸门 3 与 64 的 RSS 只差 0.7MB**（`0.7%`）
  ⇒ **RSS 与闸门无关**，别再把省下来的 MB 算到闸门头上。
- **诊断行（连接设置页，只读纯文本）新增三段**，已有 7 字段与 `formatUiDiag()` 载荷契约
  **一个字没动**（载荷被 `test:device` 全等钉死，故新数据一律**独立成段**）：
  `并发峰值 N/3 · 排队 N · 闸门/上限拒绝 N · 本次累计 NB`，以及首屏落盘的
  `落盘缓存 拦/命中/取回/淘汰/落盘失败/命中-取回字节` 与 `未拦 主文档//api/非白名单/非GET/非本网关`。
  三个计数器**只做归因**（谁在传、按什么语义传），**不参与任何判定或限流**；一轮新连接尝试
  （`openGateway`）即全部归零。**这是远程场景拿不到 logcat 时，用户自证缓存行为的唯一途径。**
- 证据：`scratch/t60/report.md` §1.1–§1.4（加固与量化）、§3.1（并发假象与 RSS 0.7MB）、
  §8（诊断行真机原文）、§7（回归 5 项全绿）；`scratch/t65/report.md` §2.1、§6.2。
- ⚠️ **两条如实未验证**：**45 s 总量 deadline 的行为未实测**（需一个限速且周期性停顿的服务端，
  `18443` 不能改配置、未搭限速垫片）；**闸门在真有并发时的行为未验证**（当前 WebView 串行派发，
  闸门永不触发，要验证需要一个并行派发的 WebView 版本——本环境不具备）。
  32 MB / 45 s **与并发无关，是无条件生效的代码路径**。
  证据：`scratch/t60/report.md` §5-U3、§5-U4。


### 生效范围（两个端不一样）

- **Android 端已生效**：SW 脚本随 APK 走，装上即生效；**首屏原生落盘**那一层也**只有 Android 有**
  （它是 App 侧代码，网关侧没有对应物）。
- **桌面端需重启网关**才会下发新版 SW。`mobile.ts` 已改为**按内容变更重读**，但
  **当前运行中的进程不会变**——这是刻意的：文件监听 + 进程内重读不适用于已注册的 SW，
  换 SW 必须重新注册。⇒ 改完 SW 之后**桌面端务必重启网关**，否则验收会读到旧 SW。


### 缓存淘汰

⚠️ **两套缓存、两套上限，别混谈**（rc.2.6 起）：

| 缓存 | 上限 | 淘汰方式 |
|---|---|---|
| **App 原生落盘目录**（`/assets/`·`/plugins/`） | **48 MB / 64 条**，**真执行** | 每次写入后遍历全目录 `File.length()` 逐条累加，超线按 `lastModified` 升序**真删**（**近似 LRU**：命中不刷新 mtime，因 `setLastModified` 在 API 23+ 被系统一律拒绝）。**降档探针**（48 MB→2 MB、64→3 条）实测**字节**与**条数**两条闸门**都真的触发**过 |
| **SW CacheStorage** | **条目数**上限（`/plugins/` 按 `rev` 保留若干代） | 每轮写入后才跑一次 prune，**旧条目不是立即清理**——被挤掉的旧 rev 会在**后续轮次**才消失 |

- **SW CacheStorage 侧没有字节数上限**（`CACHE_MAX_BYTES` 已删）。原因：T51 声明过「字节数硬上限」
  并留了常量，但**全仓零引用**——真要按字节计量，就得在 `put` 时克隆响应把长度另存，这会把一次命中
  变成一次克隆。更关键的是**字节数并非唯一闸门**：`/plugins/` 的增长是 rev 驱动且已被 rev 上限封顶
  （3 包/轮 × 9 rev），其余资源由条目数上限封顶。把没有实测依据的闸门写成「已实现」比不写更糟，
  故按实情删掉。**注意这条只约束 SW 侧**——App 侧是有真字节上限的（48 MB），别把两者的口径互相套用。
  证据：`scratch/t53/report.md` §2.1、`scratch/t65/report.md` §2.3、§5.2。
- **降档实测为什么必要**：长期跑下去条数是否真会回落、旧包是否真能被挤掉，只能靠**临时把上限调小**
  跑一轮来证伪，否则「上限存在」和「上限生效」分不开。证据同上。


### 安全语义未削弱（重要）

缓存供给**没有**给证书锁定开新口子：

- 证书锁定仍是**原语义**（按配置档记指纹，TOFU / CHANGED 照旧弹窗）。
- `PinnedFetch` **只复用已经弹窗落盘的那把锁**。**TOFU 一律不放行、CHANGED 一律不放行**——
  它**不把自签根装成受信任锚**，也不在任何情况下静默供数。
- 实证（T50 A2，PASS）：换真证书后 `action=CHANGED` ⇒ **不放行**、**新字节零落盘**、
  「**证书已变更！**」弹窗照弹。pin / TOFU / 「证书已变更！」三件事的语义与引入前完全一致。
  证据：`scratch/t50/report.md` §3。

## 开发

```bash
pnpm install
pnpm typecheck      # 全仓类型检查（gateway + plugin 客户端半边，TS 5.8）
pnpm smoke          # 冒烟测试（desktop 网关角色）
pnpm smoke:edge     # 冒烟测试（edge 角色）
pnpm test:plugin    # 插件模拟运行（假 ctx 拉起/回收网关）
pnpm test:routes    # 插件宿主路由逻辑单测
pnpm test:session   # DSH 0.1.2+ 浏览器会话适配回归（令牌下发/cookie 注入/自愈）
pnpm test:fixes     # 历轮修复回归钉桩
pnpm test:panel     # 面板端到端（需 DSH 宿主运行）
pnpm test:client    # 客户端 bundle 加载检查
pnpm test:mobile    # 移动布局自测（需 Chrome）
pnpm test:device    # 设备档位自测（真实 0.2.0-rc.2 页面 158 条断言，实测 158/158、失败 0、跳过 0；宿主/网关不可达自动跳过）
pnpm smoke:edge:frp # edge 全链路（需本机 frp 二进制，无则自动跳过）
pnpm -C packages/plugin build   # 构建设置卡片客户端 bundle
node scripts/probe-ws.mjs [端口]   # 对运行中的网关+DSH 做 WS 直通探针
```

Android 壳侧（PowerShell，无需模拟器）：

```powershell
pwsh -File android\test-direct-nodes.ps1   # JVM 单测：20+32+25 = 77 断言（CertPin / TunnelReady 纯函数类）
pwsh -File android\test-immersive.ps1      # 系统栏沉浸契约：48 断言（T94）
pwsh -File android\test-reconnect-banner.ps1  # 重连横幅 + StuckRescue + 探针桩：122 + 79 + 32（T90/T96）
pwsh -File android\test-backkey.ps1        # 返回键探针契约：66 + 18（T99）
pwsh -File android\build.ps1               # 发布产物 android\dist\dsh-remote.apk（无 debuggable）
pwsh -File android\build.ps1 -Debug        # 测试期可观测包 dsh-remote-debug.apk（开 WebView DevTools，仅供取证）
```

> `android\test-*.ps1` **一律用 `pwsh -File`**（Windows PowerShell 5.1 会按 ANSI 读 UTF-8 ⇒ **假红**）。

> **构建纪律两条**（都被坑过，写下来免得再犯）：
> - **`build.ps1` 未知参数会报错退出**（exit 2），不静默忽略。调试构建是 `-Debug`；
>   拼成 `-DebugBuild` / `-debug` 会在 0.3s 内退出、**产物零触碰**。
>   证据：`scratch/t51/report.md` §3、`scratch/t52/report.md` §2。
> - **`res/raw` 由源无条件同步覆盖**（`Copy-Item -Force`）：只改 `res/raw/mobile.js` 的改动
>   **会被构建抹掉**，而且在抹掉之前**先触发单一源断言**。要改就改源。
>   证据：`scratch/t52/report.md` §10.1、`scratch/t53/report.md` §1.2。

> **验收纪律（rc.2.6 两条 + rc.2.7 两条 + rc.2.8 三条 + rc.2.9 五条，都能把「环境问题」误读成「代码回归」）**：
> - **网关有 240 次/分、按 IP 共享的限流。** 本机同一 IP 上并行跑多个验收任务时会**互相打点**、
>   被限流的那几项返回 429 ⇒ **该轮结果一律判无效**（不是失败），退避后单跑重取。
>   证据：`scratch/t63/report.md` §1.0(1)。
> - **`caches.keys()` 会低报**，别用它判「缓存是不是空了」。CacheStorage 索引**惰性加载**，
>   没被 fetch 唤醒过的域根本不枚举 ⇒ 同一进程内 `caches.keys()` 报 0 条而 `du -sk` 报 12,960,301 B
>   **同时为真**。验收缓存一律配 **`du -sk` + 网卡字节**三者互证。
>   证据：`scratch/t62/report.md` §2.3。
> - **真机验证前必须先重建 APK，并解包比对内嵌 hook 的 SHA**（rc.2.7）。旧包里的 `res/raw/mobile.js`
>   会**静默吃掉**新 CSS / 新逻辑——hook 的样式注入带「同名 style 已存在就跳过」的守卫，新 CSS 根本
>   进不了页面，量到的是旧行为。判据：源 = `res/raw` = **APK 内嵌** 三处 SHA 相同、纯 LF。
>   T84（开工时 APK 内嵌 hook 仍是提交 `5a8d3e5` 的版本）与 T85（陷阱 A）都踩过。
>   证据：`scratch/t84/report.md` §1、`scratch/t85/report.md` §3.1、`scratch/t90/report.md` §9–§10.2。
> - **页面不能自己 `Page.reload`**（rc.2.7）。DSH 的「当前会话」指针在 localStorage 的
>   `dsh.sessions.current`（值是 `{}`），`Page.reload` 之后会落到 **workspace chooser**，而右栏面板只有
>   「会话 + 工作区」齐了才挂载 ⇒ 面板整个不存在、一条都量不到，且 chooser 里的工作区列表卡在
>   `Loading workspaces…`（经网关的查询不返回），**无法从 UI 恢复**。唯一稳定的复位手段是
>   **冷启 App 并重走它自己的「连接」**。证据：`scratch/t85/report.md` §3.1（第三个坑）。
> - **`android/test-*.ps1` 必须用 `pwsh -File` 跑**（rc.2.8）。**Windows PowerShell 5.1 会把 UTF-8
>   脚本读成 ANSI**：非 ASCII 字面量被破坏、传参变空（脚本会拿 `MainActivity` 当 hook 源）⇒
>   **假红**。同一脚本 `powershell -File` 红、`pwsh -File` 绿，属环境问题不是代码回归。
>   证据：`scratch/t94/report.md` §6.2。
> - **`adb shell input swipe x y x y 700` 在这种 WebView 里一个触摸事件都不投递**（rc.2.8，
>   页面侧计数 `events=[]`）⇒ **长按类验证必须用 CDP `Input.dispatchTouchEvent`**。
>   （同源的老结论：`input swipe` 也不经过系统手势导航监视器。）
>   证据：`scratch/t97/report.md` §11.1。
> - **Java 桥属性是只读的**（rc.2.8）：不能用 JS 间谍替换 `DshRemoteApp.*` 来数调用——
>   赋值**静默失败**（`String(window.DshRemoteApp.openSettings)` 仍是 `"[native code]"`），
>   间谍会给出「恒 0」的**假绿**。**判据要看原生 UI**（设置页有没有真的出现 / 有没有跳转）。
>   证据：`scratch/t97/report.md` §4、§11.1、`scratch/t99/report.md` §1。
> - 🔴 **验证装置必须开设备鉴权 + 走真实配对**（rc.2.9，**本轮最大的教训**）。网关的设备令牌
>   只认 cookie；**没开鉴权的装置会「全绿却漏掉 401」**——T114 那个「真机频繁重连 / 白屏」
>   的 P0 就是在未开鉴权的装置上连跑多轮都没暴露，直到 V2 用了真配对的装置才抓到
>   （`pinnedFetch … status=401` 连 `/assets/*.js` 都中）。判据：装置自证必须是
>   **匿名 `GET /` 返回 401 `no-device-token`**，且设备是**在配网页面上真填一次性码真提交**
>   （不是预置 cookie 的假配对）。证据：`scratch/t114/report.md` §1、`scratch/v3/report.md` §0.3。
> - 🔴 **稳定性 soak 必须在真实会话页内跑**（rc.2.9）。**首启页（workspace chooser）不等价**——
>   同一 mux / 同一 hook / 同一探针，但缺少会话面板，量到的不是用户实际在用的那条路径。
>   T106 那轮 17 分钟「零横幅」测的其实就是首启页（它进不去会话页），结论**不足以**代表真机。
>   证据：`scratch/t106/report.md`（明写「不等价」）、`scratch/v3/report.md` §2、`scratch/v4/report.md` §3。
> - 🔴 **CDP 触摸不能用来测「触摸穿透」类问题**（rc.2.9）。`Input.dispatchTouchEvent` 的事件
>   **直接进渲染器、绕过 Android 的 View 分发** ⇒ 用它测「设置页会不会被穿透」得到的是
>   **工具的行为不是应用的行为**：V1 那条「穿透」证据（`expanded 0→1`）在**改后**的包上
>   用同一手法能**逐字复现**。这类判据必须走 **`adb shell input tap` / `input swipe`**（真 View 分发）。
>   证据：`scratch/t109/report.md`（P1-1 复核）、`scratch/v1/report.md` §P1-1、`scratch/t109/p11-cdp-control.json`。
> - **`-no-window` 的 AVD 进程名是 `qemu-system-x86_64-headless.exe`**（rc.2.9，收尾必读）。
>   按 `qemu-system-x86_64.exe` / `emulator.exe` 过滤会**漏杀**，模拟器会一直占着端口与内存；
>   必须**按命令行匹配**（例如带上 AVD 名或自建前缀），并**端口 + 进程两条判据**都核。
>   证据：`scratch/t108/report.md`（T108 自曝误杀自己刚重启的网关）、`scratch/t115/report.md` §10。
> - **台账必须包含 `pnpm smoke` / `pnpm smoke:edge`**（rc.2.9）。本批曾因台账**漏列**这两项，
>   使一条依赖它们的断言**过期而无人发现**。漏列不是「少跑一项」，是**给了一条过期断言一个免检通道**。
>   证据：`scratch/t116/regression.log`（本批 17 项含这两项）。

push/PR 到 main 时 CI 自动跑类型检查 + 插件 bundle 同步检查（`src/client` 改动后
忘记重建提交会被拦下）+ 快测五件套（smoke / smoke:edge / test:routes /
test:session / test:fixes，见 `.github/workflows/ci.yml`）；
重链路（panel/mobile/frp 全链路）留在本地跑。

> `pnpm test:device` 在**真实的 DSH 0.2.0-rc.2 页面上**跑设备档位断言（经 Chrome CDP
> 配对取真页面，不是 fixture）。它需要**本机 DSH 与网关 `127.0.0.1:18443` 都在跑**
> （铸一次性配对码、读取 `~/.dsh-remote/state/secrets.json` 的 adminToken）。
> 宿主/网关不可达、找不到 Chrome 时会打印原因并**以退出码 0 自动跳过**，不算失败——
> 与 `smoke:edge:frp` 的无依赖跳过约定一致。运行结束会吊销本次创建的测试设备。
>
> **退出码语义（T51 起）**：`0` = 断言全过 / `1` = **有行为断言不成立** /
> `2` = **没拿到对照证据**（本轮一条断言都没真跑，属**瞬态**、不算失败）。
> 「拿不到证据」与「断言失败」被刻意分开：瞬态不该被读成回归。
>
> 本机实测：矩阵 A–E（手机竖屏 / 手机横屏 / 平板 ×2 / 运行中切换）**共 158 条断言**
> （rc.2.6 批次终局；140 条是该批次中期快照，平板档系统栏避让新增 34 条），**158/158 通过、失败 0、跳过 0**；
> **rc.2.7 复跑同值（158/158、0 跳过，台账 `scratch/lead-rc27-regression.log:17`）**；
> **rc.2.8 复跑同值（158/158、失败 0、跳过 0，台账 `scratch/t100/regression.log`）**。平板档两臂（注入 vs
> 完全不注入）关键元素**逐项像素差全 0**。更早的 55 / 91 / 106 条基线曾**连跑 3 次全绿**。
> 模拟器端到端（B1–B9）、通知动作运行时验证与已知限制见
> [android/README.md 验证小节](android/README.md#验证)。

### 版本与发布

版本号 = `<deepseek-harness 基线版本>.<发版号>`，发版号每次发布 +1，详见
[docs/versioning.md](docs/versioning.md)。当前基线 `0.2.0-rc.2`、版本 **`0.2.0-rc.2.12`**
（tag `v0.2.0-rc.2.12`）。

> **填表纪律**：下表**只写实测值**，Release 创建前不填任何预期值（文件名/字节数/时间/digest
> 全部由 `gh release view` + 下载后本机重算得出）。rc.2.8 起本表由一次 `docs:` 提交回填
> （rc.2.8 原始记录见 `scratch/t100/report.md` §3.5；rc.2.9 见 `scratch/t116/report.md` §6）。
> `0.2.0-rc.2.10` / `0.2.0-rc.2.11` 发布时未补表（本轮起恢复逐版回填）。

**本版 `0.2.0-rc.2.12`**：

| Release 资产 / 核验项 | 实测值 |
|---|---|
| 资产文件名 | `dsh-remote-0.2.0-rc.2.12.apk` |
| 字节数 | **5,776,598 B**（下载后本机 `Get-Item.Length`） |
| 发布时间 | **2026-10-06T11:42:30Z**（UTC；北京时间 2026-10-06 19:42:30，资产 `Last-Modified`） |
| APK SHA-256 | `523156DAE5ADE88EF4C09C4FB6D409DF52BC3AEC9121CEC9EB2F31BA30DE3F85`（下载后**本机重算**） |
| 包内 `res/raw/mobile.js` | `60566C6BBB69399D72E5FE13513FB9BEB1C4739F7ACC7E0715935E648280DCCA`（**362,597 B**、CR=0 纯 LF），与源 `packages/gateway/assets/mobile-web.js` **逐字节相同**（两处 `Get-FileHash` 逐字一致） |
| 签名证书 | DN `CN=DSH Remote`，SHA-256 `1E217FA66C3C68F6E031ED28B8B1C12B675DB01F01B87BF7426A4F94D8E4000D`（包内 `META-INF/DSHREMOT.RSA` 提取，与 rc.2.5 起各发布**同一条签名链**，可直接覆盖升级） |
| APK `versionName` / `versionCode` | `0.2.0-rc.2.12` / `2000212`（包内二进制 manifest 含该 versionName 字符串；versionCode 按 `build.ps1` 百进制折叠公式推导 `[0,2,0,2,12]→2000212`，本机无 SDK 未跑 `aapt2 dump badging`） |
| 本轮工作流结论 | `ci`(main) ✅ · `android-apk`(main) ✅ · `android-apk`(tag) ✅ · `release`(tag) ✅（Actions API 实测四条全部 completed+success） |

> Release 页：https://github.com/xiufeigo/DSH-Remote/releases/tag/v0.2.0-rc.2.12
>
> **发布前**已实测（与 CI 资产无关的那部分）：`test-mobile-chrome` 全过、
> `test-resume-recovery` 12/12、`test-device-class` 158/158；单一源
> `mobile-web.js == res/raw/mobile.js`（`sync-equal true`）。本轮**未跑本地
> `build.ps1`**（本机无 SDK，构建由 CI 执行）；T101 删圆角后平板绘制回到官方原生。

**上一版 `0.2.0-rc.2.9`（已发布，下表全部为实测值，非预期值）**：

| Release 资产 / 核验项 | 实测值 |
|---|---|
| 资产文件名 | `dsh-remote-0.2.0-rc.2.9.apk` |
| 字节数 | **5,776,599 B**（与本地构建产物同尺寸） |
| 发布时间 | **2026-10-05T22:13:29Z**（UTC；北京时间 2026-10-06 06:13:29） |
| APK SHA-256 | `9c2b0512e78e30474a1da9127d382eb8bf0b2cb6634f8fcd69f6883302133254`（下载后**本机重算**，与 `gh release view` 的资产 digest 逐字一致） |
| 包内 `res/raw/mobile.js` | `fd0f443417e66d02fb10bc78b1de05432f06f6bfc1b1eb91979fa5251fcd20c0`（**363,829 B**、纯 LF），与源 `packages/gateway/assets/mobile-web.js` **逐字节相同** |
| 签名证书 | DN `CN=DSH Remote`，SHA-256 `1e217fa66c3c68f6e031ed28b8b1c12b675db01f01b87bf7426a4f94d8e4000d`（与 rc.2.5 / rc.2.6 / rc.2.7 / rc.2.8 及更早发布**同一条签名链**，可直接覆盖升级） |
| APK `versionName` / `versionCode` | `0.2.0-rc.2.9` / `2000209`（`aapt2 dump badging`） |
| 本轮工作流结论 | `ci`(main) ✅ · `android-apk`(main) ✅ · `android-apk`(tag) ✅ · `release`(tag) ✅（四条全部 success；逐 job：`ci`/`test` success、`android-apk`/`build` success ×2、`release`/`android` success） |

> Release 页：https://github.com/xiufeigo/DSH-Remote/releases/tag/v0.2.0-rc.2.9
>
> **发布前**已实测（与 CI 资产无关的那部分）：`aapt2 dump badging` = `0.2.0-rc.2.9` / `2000209`
> （`-Debug` 为 `0.2.0-rc.2.9+debug`）；`build.ps1` 默认与 `-Debug` 均 exit 0；
> 源 = `res/raw` 副本 = **两个 APK 的内嵌** 三处同为 `FD0F4434…20C0`（**363829 B、CR=0**）。
> 台账 `scratch/t116/regression.log`（17 项全部 exit 0）与 `scratch/t116/report.md`。

**再上一版 `0.2.0-rc.2.8`（已发布，下表全部为实测值，非预期值）**：

| Release 资产 / 核验项 | 实测值 |
|---|---|
| 资产文件名 | `dsh-remote-0.2.0-rc.2.8.apk` |
| 字节数 | **5,756,119 B**（与本地构建产物同尺寸） |
| 发布时间 | **2026-10-05T10:59:48Z**（UTC；北京时间 18:59:48） |
| APK SHA-256 | `ad5399ab4d9d84ea664f2c265e92c136cf99fe4003ead42a35ff40d1b5d72fb6`（下载后**本机重算**，与 `gh release view` 的资产 digest 逐字一致） |
| 包内 `res/raw/mobile.js` | `d4466d0d58b272877e7edc7287f1c0e5d047642b214f5548afee0cac8923b26a`（**317,998 B**、纯 LF），与源 `packages/gateway/assets/mobile-web.js` **逐字节相同** |
| 签名证书 | DN `CN=DSH Remote`，SHA-256 `1e217fa66c3c68f6e031ed28b8b1c12b675db01f01b87bf7426a4f94d8e4000d`（与 rc.2.5 / rc.2.6 / rc.2.7 及更早发布**同一条签名链**，可直接覆盖升级） |
| APK `versionName` / `versionCode` | `0.2.0-rc.2.8` / `2000208`（`aapt2 dump badging`） |
| 本轮工作流结论 | `ci`(main) ✅ · `android-apk`(main) ✅ · `android-apk`(tag) ✅ · `release`(tag) ✅ |

> Release 页：https://github.com/xiufeigo/DSH-Remote/releases/tag/v0.2.0-rc.2.8

```powershell
pnpm ver:bump     # 发版号 +1 并同步 package.json（+ docs/versioning.md）；harness 升级用 --base <新版本>
git tag v0.2.0-rc.2.12 && git push origin v0.2.0-rc.2.12   # 推 tag 即自动打包发布
```

> ⚠️ **只有推 tag 会重新发布**：`release.yml` 的触发条件是 `on.push.tags: ["v*"]`，
> 推 `main`（包括发布后的文档回填提交）**不会再触发任何构建或 Release**，只会跑
> `ci.yml` / `android.yml` 的常规检查。

### 部署 VPS 前的本地全链路自测（无需 VPS）

在同一台机器上把 frps + frpc + 网关整条链路跑起来，验证除真实跨网外的所有环节：

1. `~/.dsh-remote/vendor/frp/` 放好 `frpc.exe` 与 `frps.exe`（同一 release）
2. 写一个本地 frps 配置（模拟 VPS）：`bindPort=17000`、与 `state/secrets.json`
   相同的 `auth.token`、`allowPorts=[{start=18448,end=18448}]`
3. `config.json` 里 `frp.serverAddr="127.0.0.1"`、`serverPort=17000`、`remotePort=18448`
4. 启动 frps → 启动网关（自动拉起 frpc 并注册代理）
5. 访问 `https://127.0.0.1:18448` 应看到配对页；`node scripts/probe-ws.mjs 18448`
   应输出两条 `101 Switching Protocols`

全绿即代表：隧道握手、代理注册、认证门、配对、反代、WS 直通全部工作，
VPS 上唯一要验证的只剩网络可达性。

## 路线图

- [x] 网关核心：认证/反代/WS 直通/主屏标记注入/frp 托管/CLI
- [x] cordis 插件自启
- [x] frp 访客模式（stcp/xtcp）：VPS 不开公网入口，`dsh-remote visitor` 出码导入
- [x] Android 壳 App：内嵌 frpc visitor + 证书锁定 + 扫码导入
- [x] Android 设备档位分档（DSH 0.2.0-rc.2 基线）：手机竖屏＝手机界面；平板/折叠屏展开＝官方桌面界面且零痕迹；手机横屏＝官方桌面布局
- [x] Edge Web 服务：Docker/裸机部署，iPhone/iPad 浏览器直达（Token 门禁 + 移动 hook 布局 + 可选容器内 frps）
- [ ] tsnet 传输适配器（无 VPS 备选）
- [ ] iOS 壳 App（需开发者账号分发；Edge Web 服务已覆盖浏览器场景）
