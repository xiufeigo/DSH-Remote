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
| `tablet`（`sw ≥ 600`，含折叠屏展开） | **与官方 DSH 桌面版一致的界面**：hook 关闭、**零痕迹** | 同左（官方桌面界面） |

- **判定源唯一**：原生 `smallestScreenWidthDp`。**JS 不得用视口宽度反推档位**——部分机型
  layout viewport 虚高（WEB-02 既有结论），壳内曾因此误判。原生在注入 hook 之前把档位写进
  `window.__DSHR_MOBILE__.device`（`phone` / `tablet` / `auto`），JS 只消费该值。
- **平板/折叠屏展开＝零痕迹**：`<html>` 上无 `data-dshr-*` 属性、无 hook 根类（含
  `dshr-official-inset`），页面上无 hook 创建的可见节点。系统栏避让由**原生**收缩 WebView
  padding 完成，官方布局本身零改动。
- **运行中折叠 ⇄ 展开切换**：只改注入配置并调 hook 幂等切换 API，**不重载 WebView、不中断隧道**。
- **平板档的「连接设置」入口**（hook 关闭后页面上的长按鲸鱼入口不复存在，由原生补两个入口）：
  - 隧道常驻通知增加「**连接设置**」动作，进程外直达，不碰隧道；
  - **会话根按系统返回键**打开连接设置（手机档现在**同样**如此，见下「返回键语义」）。

**返回键语义（两档一致，会话页）**：

| 状态 | 按返回键 | 说明 |
|---|---|---|
| 官方弹层 / 侧栏展开 | 先收弹层、再收侧栏 | 不打断会话 |
| **右栏打开态** | **只关面板** | 不多走一步到设置页、不退后台 |
| 会话根 | **回 App 连接设置页**（**不再退桌面**） | 设置页顶部有「返回当前会话」；再按一次才退后台，隧道与会话活性保留 |
| 平板档会话根 | 第 1 次**关官方左抽屉**、第 2 次回设置页、第 3 次退后台 | 抽屉优先于回设置 |

- **为什么旧实现「承诺与行为不一致」**：设置页那句「点上方「返回当前会话」或**系统返回键**继续」
  的判据是 `settingsViaBackKey && isTabletClass()`，而 `settingsViaBackKey` 的**唯一置位点就写在
  `if (isTabletClass())` 分支里**（注释原文「手机档永不置位」）⇒ 手机档恒为 false，**承诺最明确的
  那一条恰恰是假的**，按返回键直接 `moveTaskToBack(true)` 退桌面。现去掉档位门，三处判据同批改；
  其它入口（通知动作 / 长按鲸鱼）进设置页时标记仍为 false，返回键仍**回会话**，行为未变。
  证据：`scratch/t65/report.md` §1.1–§1.2、§4.1（三条路径的设备级真值）。

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

- **连接设置页有一行只读诊断行**（「页面适配诊断：档位 phone · 钩子 是 · 根类 dshr-mobile ·
  收敛 是 · 鲸鱼 是 · 三栏 是 · 严格关闭 否」，未连上时显示「未上报」），由页面经 JS 桥回报，
  用来在真机上判断 **hook 到底有没有生效**——不必再靠无障碍树猜。纯文本、无点击、不新增控件。
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
powershell -File android\test-direct-nodes.ps1   # JVM 单测：20+32+25 = 77 断言（CertPin / TunnelReady 纯函数类）
powershell -File android\build.ps1               # 发布产物 android\dist\dsh-remote.apk（无 debuggable）
powershell -File android\build.ps1 -Debug        # 测试期可观测包 dsh-remote-debug.apk（开 WebView DevTools，仅供取证）
```

> **构建纪律两条**（都被坑过，写下来免得再犯）：
> - **`build.ps1` 未知参数会报错退出**（exit 2），不静默忽略。调试构建是 `-Debug`；
>   拼成 `-DebugBuild` / `-debug` 会在 0.3s 内退出、**产物零触碰**。
>   证据：`scratch/t51/report.md` §3、`scratch/t52/report.md` §2。
> - **`res/raw` 由源无条件同步覆盖**（`Copy-Item -Force`）：只改 `res/raw/mobile.js` 的改动
>   **会被构建抹掉**，而且在抹掉之前**先触发单一源断言**。要改就改源。
>   证据：`scratch/t52/report.md` §10.1、`scratch/t53/report.md` §1.2。

> **验收纪律（rc.2.6 两条 + rc.2.7 两条，都能把「环境问题」误读成「代码回归」）**：
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
> **rc.2.7 复跑同值（158/158、0 跳过，台账 `scratch/lead-rc27-regression.log:17`）**。平板档两臂（注入 vs
> 完全不注入）关键元素**逐项像素差全 0**。更早的 55 / 91 / 106 条基线曾**连跑 3 次全绿**。
> 模拟器端到端（B1–B9）、通知动作运行时验证与已知限制见
> [android/README.md 验证小节](android/README.md#验证)。

### 版本与发布

版本号 = `<deepseek-harness 基线版本>.<发版号>`，发版号每次发布 +1，详见
[docs/versioning.md](docs/versioning.md)。当前基线 `0.2.0-rc.2`、版本 **`0.2.0-rc.2.7`**
（**已发布**：tag `v0.2.0-rc.2.7` 已推、Release 已创建。下表**全部为实测值**，非预期值）：

| Release 资产 / 核验项 | 实测值 |
|---|---|
| 资产文件名 | `dsh-remote-0.2.0-rc.2.7.apk` |
| 字节数 | **5,739,737 B** |
| 发布时间 | **2026-10-05T07:33:48Z**（UTC；北京时间 15:33:48） |
| APK SHA-256 | `1e48b334153ece8953a1d286b651c61d1bad85cc211ea00ec4756d4b7be59ff2`（与 `gh release view` 的资产 digest 逐字一致） |
| 包内 `res/raw/mobile.js` | `656CEE2E66D77404C0923F333AACAA77ECEF49CBF00E4E6187DD2F1B65BCE32E`（294305 B），与源 `packages/gateway/assets/mobile-web.js` **逐字节相同** |
| 签名证书 | DN `CN=DSH Remote`，SHA-256 `1e217fa66c3c68f6e031ed28b8b1c12b675db01f01b87bf7426a4f94d8e4000d`（与 rc.2.5 / rc.2.6 及更早发布**同一条签名链**，可直接覆盖升级） |
| APK `versionName` / `versionCode` | `0.2.0-rc.2.7` / `2000207`（`aapt2 dump badging`） |
| 本轮工作流结论 | `ci`(main) ✅ · `android-apk`(main) ✅ · `android-apk`(tag) ✅ · `release`(tag) ✅ |

> Release 页：https://github.com/xiufeigo/DSH-Remote/releases/tag/v0.2.0-rc.2.7

```powershell
pnpm ver:bump     # 发版号 +1 并同步 package.json；harness 升级用 --base <新版本>
git tag v0.2.0-rc.2.7 && git push origin v0.2.0-rc.2.7   # 推 tag 即自动打包发布
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
