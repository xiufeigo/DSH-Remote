# Android 适配最新版 DSH（0.2.0-rc.2）+ 手机/平板界面分档 —— 执行计划

> 本文是**冻结的执行契约**：所有实现/测试/修复由 mcode（ACP 子智能体）执行，
> Lead 只负责出计划与最终核对。任何偏离本契约的实现都视为不通过。

- 目标基线：**DSH 0.2.0-rc.2**（= 用户机器上正在运行的桌面版
  `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json: desktopVersion`，= npm `latest`）
- 版本号目标：`0.2.0-rc.2.1`（现场工作区为上一轮的 `0.1.5-rc.1.5`，尚未提交）

---

## 1. 验收口径（G1–G8）

| 编号 | 验收项 | 判定方式（必须留证据） |
|---|---|---|
| **G1** | **手机**（`smallestScreenWidthDp < 600`）**竖屏** → 手机界面：移动 hook 全功能可用（抽屉/鲸鱼/全屏设置/沉浸系统栏/键盘抬起），且在 **0.2.0-rc.2 真实 DOM** 上逐项成立 | 折叠屏 AVD 折叠态 + Chrome CDP（真实 0.2.0-rc.2 页面）截图与断言 |
| **G2** | **平板 / 折叠屏展开**（`sw ≥ 600`，含竖屏与横屏）→ **与官方 DSH 桌面版一致的界面**：hook 零可见痕迹、官方布局零改动 | 对照实验：同视口「注入 hook」vs「不注入」的关键元素几何与 DOM 标记完全一致（≤1px）；AVD 展开态截图 |
| **G3** | **手机横屏** → 官方桌面布局（维持现状，不做 hook 适配） | AVD 折叠态横屏截图 + CDP 断言 |
| **G4** | 运行中**折叠 ⇄ 展开**切换：隧道不断、会话不丢、界面按新档位即时生效 | AVD 上 `cmd device_state` 切换前后：进程存活、隧道 PID 不变、页面 URL/会话不变、hook 状态翻转 |
| **G5** | 平板模式下内容**避开**状态栏/导航栏/挖孔，且**页面本身零改动** | 原生给 WebView 让位（不写 DOM）；截图证明顶部标题栏完整可见 |
| **G6** | 0.2.0-rc.2 基线：hook 的全部**结构依赖**在最新版 DOM 上逐条复核，失效项修复；手机端无可见回归 | 复核表（选择器 → 在 0.2.0-rc.2 上的状态 → 证据）+ 真机态截图 |
| **G7** | 全量回归 + APK 构建通过：`typecheck / smoke / smoke:edge / test:routes / test:session / test:fixes / test:desktop / test:client / test:mobile` + `android/build.ps1` | 每条命令的原始输出日志（含退出码） |
| **G8** | 文档与版本同步（README / android/README / versioning），本地 **git commit（不 push）** | `git log --oneline -3`、`git status --short` 干净 |

**非目标（本轮不做）**：浏览器/edge 注入路径的判档规则维持现状（仍按视口宽度 ≤ 断点）；
iOS；frp/证书/Gateway 协议改动；发布 tag 与 CI 发版。

---

## 2. 已确认决策（用户拍板）

| 编号 | 决策 |
|---|---|
| D1 | **手机横屏**：仍走官方桌面布局（hook 仅在手机竖屏启用） |
| D2 | **平板模式系统栏**：内容避开系统栏，官方布局本身不改（不写 DOM） |
| D3 | 测试用**新建专用折叠屏 AVD**（`DSH_Fold_Test`），独立端口启动，不占用另一会话的模拟器 |
| D4 | 继续使用当前 mcode 模型（MiniMax-M3.1-Flash-Preview） |
| D5 | 交付到**本地 commit 为止**，不 push、不打 tag |
| D6 | 平板模式必须补回 App 自有「连接设置」入口（hook 关闭后长按鲸鱼入口消失）：**①平板档下系统返回键在会话根 → 打开连接设置（再按一次才退后台）**；**②隧道常驻通知增加「连接设置」动作**。两者都不得在页面上新增任何可见浮层。 |
| D6.1 | **语义澄清（T2b 落地后追加）**：①的「再按一次才退后台」按字面执行——平板档下**由返回键路进入**连接设置后，设置页的返回键 = 退到后台（不得回到会话，否则会话⇄设置死循环、退不出 App）；设置页顶部既有的「返回当前会话」按钮仍是在平板档下回会话的正路。由**通知动作/长按鲸鱼**进入设置时，返回行为保持既有（回会话）。 |

---

## 3. 技术契约（冻结，禁止自行改签名）

### 3.1 档位判定（唯一权威源 = 原生）

```java
// MainActivity：设备档位
boolean isTabletClass = configuration.smallestScreenWidthDp >= 600;
```

- `sw ≥ 600` ⇒ `tablet`（平板 / 折叠屏展开）；`sw < 600` ⇒ `phone`。
- **不得**在 Android 壳内用 JS 视口宽度判断档位（部分机型 layout viewport 虚高，
  这是既有的 WEB-02 结论）。JS 只消费原生下发的档位。

### 3.2 注入配置（schema v2，向后兼容）

```js
window.__DSHR_MOBILE__ = {
  breakpoint: <number>,      // 既有字段，语义不变（edge 网关下发）
  device: 'phone' | 'tablet' | 'auto'   // 新增；缺省 'auto'
};
```

- 原生在**注入 mobile.js 之前**写入该对象；每个页面（重新）加载都要先写。
- `'auto'`（浏览器/edge/旧宿主）⇒ 完全保持既有行为，**不得**改变 web 端判定。

### 3.3 运行时切换 API（hook 暴露，幂等）

```js
window.__dshrSetDevice('phone' | 'tablet' | 'auto')  // 立即重算启用态
```

- 原生在 `onConfigurationChanged` 中调用（折叠/展开/旋转）。
- 调用时 hook 尚未安装 ⇒ 只更新配置，安装后按最新值生效（不得抛异常）。
- 该 API 必须幂等：同值重复调用不得产生任何副作用。
- **实现约束（T2 实测后追加）**：`window.__dshrSetDevice` 必须在本脚本**早期顶层**无条件定义
  （早于任何档位分支/早退），否则「展开→折回手机」时若 hook 从未安装过，原生将无 API 可调，
  G4 会失败。平板档允许不安装 hook，但**不允许**不定义该 API。

### 3.4 启用矩阵（Android 壳；`DSHRemoteAndroid/` UA）

| 档位 | 竖屏 | 横屏 |
|---|---|---|
| `phone` | **ON**（现有全部移动适配） | OFF ⇒ 官方桌面布局 |
| `tablet` | OFF ⇒ 官方桌面布局 | OFF ⇒ 官方桌面布局 |
| `auto` | 保持现状（= 手机行为） | 保持现状（OFF） |

浏览器 / edge 注入：`device` 非 `'auto'` 时才受本契约约束；缺省行为**逐字节不变**。

### 3.5 OFF 的语义（G2 的判定标准）

OFF 时必须同时满足：

1. `<html>` 上**没有** `data-dshr-*` 属性、没有 hook 的根类（含 `dshr-official-inset`）；
2. 页面上**没有** hook 创建的可见节点（悬浮鲸鱼、drag handle、抽屉遮罩、状态栏挡板等）；
3. **对照实验通过**：同视口下「注入 hook（OFF 态）」与「完全不注入」的关键元素
   `getBoundingClientRect()` 逐一相等（≤1px），`documentElement` 的
   `className / style.cssText / 子节点结构`一致（允许 hook 自身的 `<style>`/`<script>` 标签存在，
   但不得产生任何**生效中的**样式规则或事件拦截）；
4. 官方交互不受影响：侧栏开合按钮、设置入口、输入框、浮动选框均由官方逻辑处理。

> 允许保留「惰性无效」的注入物（无匹配选择器的样式表、早退的 observer），
> 但必须在报告中逐条说明，并证明其不产生可观察差异。
>
> **适用范围（T1 落地口径，Lead 已确认）**：严格零痕迹只作用于 `device='tablet'`。
> `phone` 横屏与 `auto` 维持既有行为（含 `dshr-official-inset` 状态栏让位）——这是 D1/G3
> 「维持现状」的直接推论，不属于本契约的回归。

### 3.7 0.2.0-rc.2 基线更正（T0 侦察结论，2026-10-02）

| # | 更正 |
|---|---|
| C1 | `~/.dsh/profiles/node_modules/@deepseek-ai/` 下是 **0.1.5-rc.1 且 dist 被本地改过**（`dist.upstream-bak` 才是原始备份）——**不得**当作 0.2.0-rc.2 基线。真实产物在 `…\Programs\DeepSeek Harness\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/`（`index-5SrrfWpU.js` 633282 B）与 `dsh-client-ui-*/lib/client.js`；已字节级证明**运行中的实例就是这份产物** |
| C2 | hook 结构依赖复核：**0 条失效**。71 条中 52 条不变、1 条换包（`data-team-action`）、18 条**两版都无**（rc.1 时代即死代码/第三方插件）。T7 复核**不得**把「两边都无」判成本轮回归 |
| C3 | 契约第 4 节行号在 T1/T3 改动后会漂移；行号以 `scratch/plan-0.2.0-rc.2/mobile-web.snapshot.js` 与当前文件实际内容为准 |
| C4 | 真实页面 DOM 在 T0 阶段**未能验证**（401 门禁 + Electron 未开调试端口）。**T4/T5b 必须补齐**：用 admin 端点铸一次性配对码 → `POST /__dsh_remote__/pair` 换设备 cookie → Chrome CDP 带 cookie 加载真实 0.2.0-rc.2 页面 |

### 3.6 平板模式的系统栏（G5）

- 由**原生**给 WebView 让出状态栏/导航栏（容器 padding 或等价手段），
  **不得**通过页面 DOM/CSS 修改官方布局；
- 状态栏保持透明，但底色与页面深浅色一致；不得出现突兀色块；
- 手机模式保持现有 edge-to-edge + `--dshr-inset-*` 透传机制不变。

---

## 4. 现状锚点（只读事实，供实现定位）

| 项 | 位置 |
|---|---|
| hook 单一源（125510 B，禁止手改副本） | `packages/gateway/assets/mobile-web.js` |
| 壳内副本（build.ps1 字节同步） | `android/app/src/main/res/raw/mobile.js` |
| 启用判定 | `mobile-web.js` 约 1077–1124（`applyWidthScope()`；现式 `on = portrait && (isAndroidShell() ‖ mql.matches)`） |
| 已有 JS API | `window.__dshRemoteInsets.set(top,bottom)`（约 1127）、`window.__dshRemoteAndroidMobile.syncViewport()` |
| 注入点 | `MainActivity.java:1452 injectMobileAdaptation()`、`1603/1622/1625/1640` 多处调用、`928` 本地壳页面 |
| 注入自检 | `MainActivity.java:1462 scheduleAdaptationProbe()`（6s 未装成 → 退回实色状态栏） |
| 配置变更 | `MainActivity.java:1484 onConfigurationChanged()`；Manifest 已声明 `configChanges=…|smallestScreenSize|…` |
| 系统栏 inset 透传 | `MainActivity.java:1426 applyInsetsToPage()` |
| 沉浸/实色切换 | `MainActivity.java:1504 applySystemBarMode()` / `1516 applySystemBars()` |
| 移动自测（含 WEB-02 字节一致性 + 源码契约） | `scripts/test-mobile-chrome.mjs`（真实页面用 fixture：`scripts/fixtures/mobile-selftest.html`） |
| 构建 | `android/build.ps1`（无 Gradle；aapt2→javac→d8→zipalign→apksigner；arm64-v8a 单架构） |
| 现有 AVD（被另一会话占用） | `Pixel_10_Pro_Fold`(5554…5564)、`Pixel_Tablet`、`Pixel_9a` 等 6 个 |
| Emulator | `%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe`（36.6.11，WHPX 可用） |
| adb | `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`（**不在 PATH**） |
| 目标系统镜像 | `system-images;android-37.2;google_apis_playstore_ps16k;x86_64`（模拟器 `abilist=x86_64,arm64-v8a`） |

**环境约束**：另有会话正在 `opencode-android-shell` 项目中占用全部现有模拟器与
4 个 mcode 进程 —— 严禁 `adb kill-server`、严禁停用/清空现有 AVD、严禁占用
`emulator-5554/5556/5558/5560/5562/5564`；本任务一律使用专用 AVD 与独立端口。

---

## 5. 任务分解

| 任务 | 内容 | 写范围 | 依赖 |
|---|---|---|---|
| **T0** | 0.2.0-rc.2 冲击复核：hook 结构依赖逐条对照最新版 DOM，产出复核表 + 修复清单 | `scratch/plan-0.2.0-rc.2/**` | — |
| **T1** | hook 分档契约落地（3.2/3.3/3.4/3.5） | `packages/gateway/assets/mobile-web.js` | — |
| **T2** | 原生档位判定 + 注入时序 + 运行时切换 + 平板系统栏（3.1/3.3/3.6） | `android/app/src/main/java/**/MainActivity.java`, `android/app/src/main/AndroidManifest.xml`（如需） | — |
| **T2b** | 平板模式连接设置入口（D6）：返回键兜底 + 通知动作 | `android/app/src/main/java/**/MainActivity.java`, `TunnelService.java` | T2 |
| **T3** | 0.2.0-rc.2 DOM 修复落地（T0 清单） | `packages/gateway/assets/mobile-web.js` | T0, T1 |
| **T4** | 测试建设：真实 0.2.0-rc.2 页面上的 手机/平板/横屏/运行中切换 断言（扩展现有 harness） | `scripts/test-mobile-chrome.mjs` 或新增 `scripts/test-device-class.mjs`, `package.json` | T1, T2, T3 |
| **T5** | 折叠屏 AVD 端到端：建 AVD → 装 APK → 折叠/展开/横屏/运行中切换 全部留证 | `android/build.ps1`（如需）, `scratch/avd-dsh/**` | T2, T4 |
| **T6** | 文档与版本：README / android/README / docs/versioning + 版本号 `0.2.0-rc.2.1` | `README.md`, `android/README.md`, `docs/versioning.md`, `package.json`, `packages/*/package.json` | T5 |
| **T7** | **对抗式复核**（全新上下文子智能体）：按第 1 节逐条尝试证伪，独立复跑关键验证 | `scratch/verify-device-class/**` | T6 |
| **T8** | 本地 commit（两笔：上一轮收尾 / 本轮改动），不 push | git index | T7 |

### 关键风险与回退

| 风险 | 处置 |
|---|---|
| R1 arm64-only APK 装不上 x86_64 AVD | 模拟器 `abilist` 已含 `arm64-v8a`；若安装/运行失败，改出**测试用 x86_64 APK**（直连模式，不启 frpc），**发布构建保持 arm64 不变** |
| R2 模拟器上拿不到已认证的 DSH 页面 | 首选 `adb reverse tcp:<port> tcp:<port>` + 网关直连地址 + 一次性配对码；退路 = 起一个**独立测试用 DSH 宿主/gateway 实例**（不得动用户正在跑的实例） |
| R3 运行中 teardown 不干净 | 首选 hook 自带的 on/off 重算路径；退路 = 档位切换时重载 WebView（须证明会话不丢），并在文档中写明 |
| R4 0.2.0-rc.2 DOM 变化超出预期 | T0 必须先出清单再改；改不动的项必须显式降级并记录，不许静默 |
| R5 Flash 模型长链路可靠性 | 任务切小、验收写死、独立子智能体对抗复核 |
| R6 与另一会话抢资源 | 专用 AVD + 独立端口；发现异常立即停手上报 |

---

## 6. 证据与产物清单（每个任务必须落盘）

- `scratch/plan-0.2.0-rc.2/recon.md`：0.2.0-rc.2 结构依赖复核表（含 file:line 或 DOM 证据）
- `scratch/plan-0.2.0-rc.2/dom-baseline-*.json`：注入/不注入 对照快照
- `scratch/avd-dsh/*.png`：折叠 / 展开 / 横屏 / 切换后 截图（含时间戳）
- `scratch/avd-dsh/evidence.md`：每条 G 验收 → 命令 → 原始输出 → 截图路径
- `scratch/verify-device-class/report.md`：T7 对抗复核报告（逐条 pass/fail + 反证尝试）
- 回归日志：`scratch/tests/*.log`（含退出码）

---

## 7. Lead 最终核对清单（收尾时逐条执行）

1. `git status --short` 干净、`git log --oneline -3` 两笔提交语义正确；
2. `packages/gateway/assets/mobile-web.js` 与 `android/app/src/main/res/raw/mobile.js` 字节一致（WEB-02）；
3. 我本人复跑：`pnpm typecheck && pnpm test:mobile && pnpm test:fixes && pnpm test:desktop`；
4. 我本人复核 G2 对照实验产物（DOM 标记 + 几何）与 G5 截图；
5. 我本人核对 hook 启用矩阵在源码中**唯一**成立（无第二处判档）；
6. 逐条比对 G1–G8 与证据文件，缺证即不通过；
7. 确认 APK 产物存在且版本号 = `0.2.0-rc.2.1`。
