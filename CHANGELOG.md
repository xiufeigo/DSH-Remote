# 变更日志与技术演进记录 (Changelog & Technical Postmortems)

本文档归档 DSH-Remote 历次版本迭代的用户可感知变化、缺陷定位根因分析（RCA）及技术实测台账。

---

## v0.2.0-rc.2.24（手机档终端「弹出来后点击没反应」修复）

- **现象（用户口径）**：手机上打开工作区终端后，点终端没有任何反应——点不动、软键盘不弹、打字没有回显。
- **根因**：DSH 的工作区终端是 xterm.js。它的落点是 `.xterm-screen`（`div`，**不是**可编辑元素），
  真正的输入面是它内部那个 CSS 上 `0×0` 且 `left:-9999em` 的 `.xterm-helper-textarea`（见 `xterm.css`），
  xterm 在**抬手之后自己 `focus()`** 它。
  而 `mobile-web.js` 的焦点守卫（T21/T42/T48/T51/T135 那一套，`bindFocusGuard` 的 `onDown` + `focusin`）
  只放行「落指就在可编辑元素内」的聚焦（`isEditablePoint()` 对 `.xterm-screen` 恒为假），
  于是这次聚焦被判成「非用户手势造成的偷焦点」⇒ `revokeStealthFocus()` 当场 `blur()`
  ⇒ 终端永远拿不到焦点；反复点还会升级成**粘性持续收回**（同一签名 5s 内持续 blur）。
  次级缺陷：即便焦点留住，`imeLiftElement()` 也会把那个 `0×0` 的 textarea 矩形（`≈(0,0)`）上报给原生，
  原生 `computeImeShift()` 的 `needed = fieldBottom + pad - keyboardTop ≤ 0` ⇒ **平移量恒 0**
  ⇒ 键盘盖住终端下半屏（看不到自己在打什么）。
- **修复**（`packages/gateway/assets/mobile-web.js`，单一源；`android/.../res/raw/mobile.js` 字节同步）：
  1. 新增 `terminalHostOf()` / `terminalFocusTarget()` / `terminalCursorRow()`：认 `.xterm` 宿主。
  2. `bindFocusGuard.onDown` 的「非可编辑落点」分支最前面新增终端分支：
     `markUserFocusIntent(helper textarea)` + `clearFocusSticky()` + `releasePanelIme()` 后**直接 return**。
     必须先于 `isInsideOpenPanel()`：窄屏下终端所在的右栏是**全屏固定面板**，走浮层分支只会
     `mutePanelIme()`（放行焦点但 `inputmode="none"`）——键盘不弹，症状同样是「点了没反应」。
  3. `imeLiftElement()` 对终端改报**光标行**（`.xterm-cursor`）矩形：只抬「必须的量」，
     既不会把第 0 行的提示符顶出屏幕，也不会让键盘盖住终端下半屏；取不到光标时退化成宿主本身（平移量 0，与改前等价）。
- **证据（A/B，真 Chrome 里跑真实 hook + 真 CDP 触摸）**：`scripts/test-terminal-focus.mjs`（`pnpm test:terminal`）。
  合成 xterm 形态（`.xterm` / `.xterm-screen` / `.xterm-cursor` / `0×0` 的 helper textarea + 抬手 `focus()`）
  跑 11 条断言：**修复前 9/11**（红的两条正是本缺陷：「真触摸终端后焦点留在 helper textarea」实测 `active:false`、
  「抬起矩形=光标行」实测 `[-1,-1]`）；**修复后 11/11**（`active:true`、未被压 `inputmode`、上报 `[55,75]`；
  另 3 条钉住平板档严格 OFF 与收敛诊断契约）。另外两条回归钉桩证明没有过度修正：非手势的程序化聚焦
  **照样被收回**（守卫本职），composer 真触摸**照常聚焦**。`pnpm test:mobile` 全绿（含 T135 浮层 IME 压制等既有钉桩）。
- **真终端 A/B（最强证据）**：`scratch/qa/lib/e2e-terminal.mjs` 在真实 DSH 页面 + 网关 18443 上真触摸
  `.xterm-screen`：修复前 `activeElement=BODY`（被守卫 blur）、`echo` **一字未变**；修复后
  `activeElement=TEXTAREA.xterm-helper-textarea`、`echo QA-phone` **真回显**。
- **为什么最初用合成终端钉桩**：DSH 的终端池按 Session 计（`maxTerminals=8`，**已退出的也占名额**，
  只有关标签页才释放）。QA 期间换页未关标签把用户当前 Session 的名额占满（错误原文
  「终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。」）；名额释放后已补真终端 E2E。
  **这不是本仓库的 bug**（官方终端控制器行为 + 测试用法），但后续测终端一律「测完真触摸关标签」。

### 同版本附带修复：PWA manifest 冷加载 401 + 平板档「零痕迹」判据澄清

#### ① 未带凭据的 `/manifest.webmanifest` 恒 401（手机/平板两个 QA 独立复现，8/8 轮）
- **现象**：冷加载 `https://<网关>/` 时控制台必现两行
  `Failed to load resource: 401 … /manifest.webmanifest` + `Manifest fetch … failed, code 401`；
  「添加到主屏幕」永远拿不到 manifest（PWA 装不出）。
- **根因**：浏览器取 `<link rel="manifest">` 的那条请求**按规范不带凭据**（实测 initiator=parser、请求头无 Cookie），
  必然落到设备门禁的未认证分支；而同一路径用 `fetch(..., {credentials:'include'})` 是 200 —— 所以不是 manifest 坏了。
- **修复**：`server.ts` 未认证分支对 `GET /manifest.webmanifest` 回**网关自产壳 manifest**
  （`pwa.ts: renderShellManifest()`：应用名 / `start_url` / `scope` / 图标，**不含任何会话、设备、令牌字段**）；
  带凭据的请求仍原样反代官方那份（保留官方 file handler 等能力）。新增 `GET /__dsh_remote__/icon-512.png`
  （安装型 PWA 要求 ≥512 图标；`iconPng()` 进程内缓存，只生成一次）。
- **钉桩**：`pnpm test:fixes` 新增 **WEB-09**（无凭据 200 + `manifest+json` + nosniff + 192/512 图标均 200
  且是真 PNG + 载荷无会话字段 + 带凭据仍透传上游）。全仓 `test:fixes` **18/18**。
- ⚠️ **生效条件**：网关是长驻进程，**需重启网关**才生效（当前 18443 上的实例仍是旧代码）。

#### ② 平板档「零痕迹」判据澄清（`android/README.md`）
- **现象（QA 判红）**：平板档注入 hook 后 `outerHTML` 与「完全不注入」不等（657 565 B vs 632 013 B，
  差 25 552 B）——多一个惰性 `<style data-dshr-mobile-css>`，且 `viewport` meta 被改写为
  `…viewport-fit=cover, interactive-widget=overlays-content`。
- **结论：不是 bug，是判据写法错**。逐条扫 102 条 CSS：平板档只有 T115 的 **2 条**让位规则命中官方列容器
  （让位的输入，设计内例外），其余 100 条（`html.dshr-mobile*` / `html.dshr-official-inset*` / 4 个 hook 自有 ID）
  一条都不命中；meta 改写是平台级 edge-to-edge/IME 机制，`teardownHookTraces()` 明文不还原。
- **动作**：`android/README.md` 的平板档零痕迹条目补上「判据是**语义级**（DOM 标记/节点/几何/绘制），
  不是 `outerHTML` 逐字节相等」与两类允许残留，避免后续 QA 反复产出假红。

---

## v0.2.0-rc.2.23（安全加固，待发布）

相对 `0.2.0-rc.2.22` 的行为变化。包版本号已对齐到 `0.2.0-rc.2.23`，待打 tag 发布。

1. **设备 Cookie 改名。** 名称从 `dr_device` 变成 `dr_device_<实例>`。已经配对的手机和浏览器都要重新登录一次，旧 Cookie 不再有效。
2. **隧道主口必须有设备凭据。** 本机其他 App 不能再直接访问隧道口。edge 部署不受影响：edge 用同一把访客密钥向电脑端换 Cookie，再注入反代，浏览器仍只登录 edge。
3. **手机上的插件设置卡片不再经隧道可用。** 请求只要带上网关加上的 `x-forwarded-host` / `x-forwarded-proto`，`/dsh-remote/*` 就返回 403。电脑上直接打开的 DSH 设置页不受影响。
4. **Android `targetSdk` 34 → 35。** Android 15 会强制 edge-to-edge，原生首页和设置页的系统栏留白需要在真机上看一遍。
5. **公网入口（含旧的 `mode: entry`）按 PROXY v2 的真实来源限流。** 不再把所有公网用户算进 `127.0.0.1` 同一个桶。
6. **内容寻址缓存收紧。** 小写十六进制和 Vite 哈希文件名仍长期缓存；纯字母单词、纯大写串、`main_menu` 这类名字会重新校验。
7. **每台手机用自己的设备名登录。** 名称是厂商、型号，加上首次安装时记下的随机后缀。两台手机连同一台电脑不再互相把对方踢下线。同一台手机重连仍复用原来那一行。升级后的第一次登录会新开一行，设备列表里可能留下旧的「Android」，可以手动吊销。
8. **登录也校验主机名。** 规则与打开页面相同：系统信任库接受的证书优先，所以更换 CA 证书后不必重新扫码；自签证书仍以指纹为准。
9. **edge 访客密钥被拒绝后停止重试。** 对端返回 403 或 429 时不再每 2 秒打一次，避免把电脑端和手机自动登录共用的 `127.0.0.1` 桶锁 15 分钟。改密钥或重启 edge 后再试。

---

## v0.2.0-rc.2.21（移动端交互缺陷修复，T135）

### ① 右栏「关完又自己弹回来再关上」＝ 两套位移载体共用同一个闸
- **现象**：右侧边栏手动滑动关闭的时候，在关闭后会自动再弹一遍动画，即自动打开侧边栏又给关上。
- **根因**：
  - hook 的卡片位移加在面板本体上（`transform: translateX(var(--dshr-rx))`），闸是官方属性 `data-sidebar-right-open`；而官方真正的收起/展开过渡在面板内层（`[data-dockkit-host=dock]` 等：`transform: translateX(var(--dsh-sidebar-width)); visibility: hidden; transition: ...`）。
  - 手势关闭补间到 `rx=max` 后再兑现官方收起 ⇒ 属性消失使面板那条规则整条失效（面板 `transform` 回落 `none`、rect 412→0 瞬回屏内），官方内层随即起跑它自己的 0.3s 过渡（`visibility` 延迟 0.3s 才隐藏、全程可见）⇒ 用户看到的第二次动画。
- **修复**：
  - 新手势关闭交接窗 `data-dshr-rclosing`：交接窗内面板继续停在屏外，并压掉官方内层过渡（收起一步到位 `translate+hidden`）；官方状态一落地（`syncDom`）先撤窗、再清 `--dshr-rx`。
  - `startObserver` 的 `attributeFilter` 补充 `data-sidebar-right-open` + `aria-hidden`，防止属性变化未被及时监听导致 1200ms 看门狗补发第二颗 toggle。

### ② 手机端改不了模型 ＝ 守卫 blur 掉了官方子面板自己弹出的搜索框
- **现象**：手机端在输入框顶部弹出模型选择子面板时，点击模型框会自动消失，无法完成切换。
- **根因**：点击「模型…」行打开官方子面板并自动聚焦搜索框（`input[role="searchbox"]`），hook 的 `focusin` capture 守卫将其误判为「非用户手势偷焦点」⇒ 执行 `revokeStealthFocus` ⇒ `el.blur()` ⇒ 官方浮层按「焦点离开」逻辑 dismiss，子面板在 blur 后 1.6ms 瞬间被卸载。
- **修复**：浮层内手势通行证 + 压 IME 而不是 blur。手势起点落在已打开浮层内时，开启仅对浮层内元素生效的窗口；窗口内元素获焦时不 blur，仅标记 `inputmode="none"` + `data-dshr-imemute`。菜单保持存活且不拉起软键盘；用户真正点击输入框时撤压制并还原原值。

---

## v0.2.0-rc.2.10（省电与诊断清理）

| 项 | 改前 | 改后 | 说明 |
|---|---|---|---|
| **设置页诊断信息** | 8 行键值/计数器（页面适配诊断 / 文件选择 / 并发峰值 / 落盘缓存等） | **全部从 UI 移除** | 保持界面简洁清爽，诊断信息改由 logcat 标签 `dshr-diag` 输出（值变化时输出） |
| **兜底探针周期**（健康态前台） | 无推送通道档 1000 ms | **60000 ms（按分钟计）** | 大幅降低无通道状态下的心跳轮询 CPU 消耗 |
| **后台探针** | 已为 0 拍/分 | 保持为 0 | `onPause` 停轮询并挂起计时器 |
| **设备凭据持久化** | 前台直接强杀丢 cookie | 配对/导入成功后立刻 `CookieManager.flush()` | 强杀进程重启后无需重复配对 |

---

## v0.2.0-rc.2.9（启动提速、凭据接管与自愈重构）

### 启动加载提速（T113）
- **打洞回落超时优化**：xtcp 打洞失败回落 stcp 的 `fallbackTimeoutMs` 由 5000 ms 优化至 **800 ms**。
- **粘性中转**：连续 2 次打洞失败后，自动粘住 stcp 中转；打洞成功、切换网络或重启 App 时重置。避免每次启动固定白等打洞超时。
- **首文档动态压缩**：首页 HTML 根据客户端 `Accept-Encoding` 提供 gzip/br 压缩，传输体积缩减约 85.2%（35KB → 5.2KB）。

### 接管通道带上设备凭据（T114）
- **根因**：`PinnedFetch`（SW 与原生落盘通道）未附带 Cookie，而网关设备令牌只认 `dr_device` HttpOnly Cookie。导致接管后的静态资源请求返回 401，进而造成真机白屏与断连重试。
- **修复**：发请求前经 `CookieManager.getCookie(url)` 提取同源凭据；限定同源同端口出口；非 200/401 响应严禁写入落盘缓存。

### 自愈解耦断线风暴（T112 / T112b）
- **根因**：自愈机制误报触发 `offline` 导致上游 socket 被强行 abort，产生「自愈本身掐断正常连接」的假断线。
- **修复**：nudge 动作按来源分流，仅在 WebSocket 观测到真实 `close` 时允许派发 `offline`，其余 DOM 异常仅退回 `online-only` 幂等自愈；上限由 6 次收敛为 2 次；记录完整 `CloseEvent` 状态码区分网络抖动与真实离线。

### 原生透明系统栏与 CSS Inset 避让（T115）
- **修复**：WebView 边距置零（全屏覆盖），四向 inset 通过 CSS 变量 `--dshr-inset-*` 交付页面避让；状态栏与导航栏由原生写入透明，彻底消除双色背景带缝隙。

---

## v0.2.0-rc.2.8 及更早版本关键技术沉淀

### 1. 设备档位判定契约
- **唯一判定源**：原生 `smallestScreenWidthDp`。`sw >= 600` 为 `tablet`，否则为 `phone`。
- **平板档零侵入**：平板档下 hook 保持最小化（仅保留 1 个 `touchstart` 监听器用于长按品牌区手势与必要 CSS 让位规则），不新增业务 DOM 节点/类名，保持官方桌面布局 100% 原汁原味。

### 2. 双层缓存架构（SW + 原生落盘）
- **App 原生落盘**：`/assets/` 与 `/plugins/` 首屏静态资源由原生拦截直接落盘至私有目录，按 URL SHA-256（含 rev 参数）内容寻址，配额 48MB / 64 条写入淘汰。
- **SW 本地供给**：SW 脚本本地直接返回，SW 内部取数通过 `PinnedFetch` 复用证书锁定。
- **Chromium 自签证书特性**：Chromium 对走 `proceed()` 放行的自签证书默认不写 HTTP 磁盘缓存，因此必须依赖 SW CacheStorage 与原生磁盘双重落地。

### 3. StuckRescue 卡住自救状态机
- 前台静默半开连接由原生状态机监测：温和层（派发网络瞬态对）重试 2 次（间隔 8s）未果后升级到受控重载，升级前先通过 health 探活验证隧道连通性，避免断网重载导致永久白屏。

---

## 发布核验台账归档

### v0.2.0-rc.2.12
- 资产：`dsh-remote-0.2.0-rc.2.12.apk` (5,776,598 B)
- 发布时间：2026-10-06T11:42:30Z
- SHA-256：`523156DAE5ADE88EF4C09C4FB6D409DF52BC3AEC9121CEC9EB2F31BA30DE3F85`
- 签名链：CN=DSH Remote, SHA-256 `1E217FA66C3C68F6E031ED28B8B1C12B675DB01F01B87BF7426A4F94D8E4000D`

### v0.2.0-rc.2.9
- 资产：`dsh-remote-0.2.0-rc.2.9.apk` (5,776,599 B)
- 发布时间：2026-10-05T22:13:29Z
- SHA-256：`9c2b0512e78e30474a1da9127d382eb8bf0b2cb6634f8fcd69f6883302133254`

### v0.2.0-rc.2.8
- 资产：`dsh-remote-0.2.0-rc.2.8.apk` (5,756,119 B)
- 发布时间：2026-10-05T10:59:48Z
- SHA-256：`ad5399ab4d9d84ea664f2c265e92c136cf99fe4003ead42a35ff40d1b5d72fb6`
