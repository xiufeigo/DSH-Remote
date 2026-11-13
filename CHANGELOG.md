# 变更日志与技术演进记录 (Changelog & Technical Postmortems)

本文档归档 DSH-Remote 历次版本迭代的用户可感知变化、缺陷定位根因分析（RCA）及技术实测台账。

---

## 待发布（2026-11-13）：流式输出时主线程白耗 + mobile.js 裸传 + 空闲 5 秒断连

先量后改。基准在真 Chrome（headless，CDP）里跑真实 hook：合成的 DSH 形态页面，1000 轮会话 ≈ 1.5 万节点，
CPU 4 倍降速，每帧提交一次（rAF）共 300 次；夹具自身不读布局。改前 / 改后在同一时段交替各跑两轮，
每轮都带「不注入 hook」对照。脚本与原始 JSON 在 `scratch/perf-20261113/`（不入库）。

### ① Android 官方壳：观察器逐次提交做全文档扫描 + 强制同步布局（PERF-05）

- **根因**：rc.2.26 起 Android 壳写 `chrome:false`，会话页走 `installOfficialHost()`。它的 MutationObserver
  （body，childList + subtree）在**每一批**变更里同步调 `syncPageTheme()` 和 `rememberSessionIfAny()`：
  4–7 次全文档选择器查询，外加 `getBoundingClientRect()` 与 `innerText`（都会强制同步布局），浅色主题再多一次
  `getComputedStyle`。这两样结果只在换主题、换会话时才变，流式输出的每个 token 都在为它付费。
  10 月那轮「1000 条消息全局扫描 0 次」验的是手机 hook 的 `onDomMutations`，官方壳这条观察器是之后加的。
- **实测**：
  | 指标（300 次提交） | 改前 | 改后 |
  |---|---|---|
  | hook 脚本耗时 | 1550–1660 ms | 174–204 ms |
  | 浅色主题每次提交比不注入多 | 5.9–7.2 ms | −0.6–0.0 ms（噪声内） |
  | 一帧内连发 300 次提交：强制布局次数 | 300 | 4 |
  | 同上：每次提交耗时 | 38.5 ms | 0.53 ms |
- **修复**（`packages/gateway/assets/mobile-web.js`，`res/raw/mobile.js` 字节同步）：主题属性翻转仍当场同步
  （状态栏配色不能迟到）；其余合并成最多每 300ms 一次，末次变更后 300ms 内必跑。
- **测试**（`pnpm test:official-shell`）：新增流式夹具，连发 200 次提交期间 `getBoundingClientRect` ≤ 10、
  全文档 `querySelectorAll` ≤ 20（改前实测 200 / 400，红）。另钉三条护栏：主题翻转当场生效；
  不经点击换会话后，插件页按返回仍回到新会话；尾沿同步确实发生。

### ② 浏览器 / edge：没有原生桥也在为通知扫 DOM（PERF-06）

- **根因**：`scheduleSessionNotice()` 的结果只有一个去处 `DshRemoteApp.setSessionNotice`。浏览器里没有这个桥，
  流式期间仍约每秒跑一次 `collectSessionNotice()` → `readLastUserPrompt()`：主列全部 `div, p` 逐个
  `closest` + `querySelector` + `getComputedStyle`，算完直接丢弃。
- **实测**（iPhone UA，同一夹具）：hook 脚本耗时 740–829 → 126–128 ms；超过 50ms 的长任务 6–7 个
  （最长约 92ms）→ 0–1 个。
- **修复**：没有桥就不排程（`hasSessionNoticeSink()`）。Android 行为不变。
- **测试**（同文件）：无桥时通知链路的 DOM 扫描次数为 0（改前 4，红）；有桥时仍上报 `running=true`。

### ③ edge：`/__dsh_remote__/mobile.js` 裸传（PERF-07）

- **根因**：内部路由不经 `proxyHttp`，吃不到网关压缩；`deploy/docker/Caddyfile.example` 也没开 `encode`。
- **修复**（`mobile.ts` / `server.ts`）：资产加载时异步预压 br（q9）与 gzip（-9），按 `accept-encoding` 选；
  ETag 按编码区分，响应带 `Vary: Accept-Encoding`。不带 `accept-encoding` 的客户端字节与 ETag 同改前。
- **效果**：379,148 B → 106,526 B（br，−72%）/ 127,649 B（gzip，−66%）。付费时机是首次加载与缓存过期
  （`max-age=3600` 之后是 304）。Android 壳不走这条路由（脚本在 APK 里）。
- **测试**：`pnpm test:perf`（解压后逐字节相等、编码选择、并发加载单飞）、`pnpm smoke:edge`（200/304 与变体 ETag）。

### ④ 网关空闲 5 秒就断开客户端连接（PERF-08）

- **根因**：Node `keepAliveTimeout` 缺省 5s。本机实测：空闲 6.5s 后的下一个请求不再复用连接。
  隧道上每条新连接都要重新开流 + TLS 握手，T111 实机量过这个固定成本（stcp 中转下 49–142ms；
  打洞失败且未粘住中转时再加 `fallbackTimeoutMs`）。「看几秒再点一下」正好每次都落在新连接上。
- **修复**（`server.ts`）：`keepAliveTimeout = 60s`，主监听与公网入口都生效。`headersTimeout` 不动
  （Node 24 实测：空闲时长超过 `headersTimeout` 的连接照常复用）。
- **测试**（`pnpm test:fixes`）：空闲 7s 后的请求复用同一条连接（改前红）。
- ⚠️ **没有在手机实网重测省了多少**：依据是 T111 的单连接成本加本机的复用事实。

### ⑤ Android 官方壳：前台通知正文恒为「正在生成…」（功能修复）

- **根因**：`readLastUserPrompt()` 先 `querySelector('[data-dshr-main-col]')`，没有就直接返回空。
  但这个标记只有手机档 `syncDom()` 会写；rc.2.26 起 Android 壳 `chrome:false` 走 `installOfficialHost()`
  严格 OFF 路径，`data-dshr-main-col` 从不存在，函数在第一行就出局——不是启发式没猜中，是根本
  没跑到。真实页面抓包（`scratch/qa/pad/raw/arm-real.html`）里 14 处 `data-dshr-main-col`
  全部在注入 CSS 文本里，DOM 上零命中。
- **依据**（DSH 0.2.2-rc.1 安装包，`app.asar` 提取）：
  - 用户气泡有稳定语义标记：会话消息渲染点（`conversation.chat.user.content` → `UserContent`）
    给 `UserMessageBubble` 传 `data-message-bubble`，该 primitive 是
    `({className, ...rest}) => <div {...rest}>`，`data-*` 直达根 `div`；
  - 全前端只有这一个地方设置它；`PendingSteering` / `PendingSubmission`（排队中的输入回显）
    走同一渲染路径，故 DOM 序即时间序；
  - 队列坞（QueueDock）预览也渲染 `conversation.user.text`，但**不带**气泡标记，不会误取。
- **修复**（`mobile-web.js`，`res/raw/mobile.js` 字节同步）：先按
  `[data-dshr-main-col] → [data-slot="main"] → [data-conversation-content] → document`
  定作用域，倒序找 `[data-message-bubble]`，跳过 `[hidden]/[inert]` 祖先与输入区
  （`data-composer-card/seat`）内的候选，取第一条非空气泡，照旧 `clipNoticeText(..., 160)`；
  一个候选都没有时才回落旧版式启发式（仅老 harness 的移动档用得上）。
- **测试**（`pnpm test:official-shell`，红→绿）：官方壳 + 原生桥下通知正文 = 最后一条用户气泡，
  隐藏容器与输入区里的同名标记不计；删掉全部气泡仍回退「正在生成…」。旧代码在同夹具下
  稳定输出 `["Alpha","正在生成…",true]`（红）。

### 查过、没改

- **网关反代每请求开销**：回环 p50 0.32ms（直连上游 0.12ms），216KB JS 经 br 1.5ms。不是瓶颈。
- **WS 上游 socket 的 TCP_NODELAY**：Windows 回环上连续两次小写的到达间隔，开 / 关 Nagle 为 0.12 / 0.11ms，无差别。
- **Android 重复注入 mobile.js**（每次进页 5 次，SPA 路由切换各 1 次）：4 倍降速下单次约 9.7ms。
  要省就得动注入时序（T27-B 那一带），收益不抵风险。
- **SW 缓存 64 条上限**：历史抓包（T44 / T45）里每次加载的 `/assets/*` 只有 4 个，碰不到。

### 顺带发现、未修

- **Android 官方壳的前台通知正文恒为「正在生成…」**：`readLastUserPrompt()` 依赖 `[data-dshr-main-col]`，
  而 `chrome:false` 下 `syncDom()` 早退、从不打这个标记（实测 Android 档返回兜底文案，浏览器档能读到用户原话）。
  rc.2.26 起如此。直接改成按官方属性找主列，会把 ② 那种每秒全量扫描带回 Android，需要先有便宜的定位方式。

### 生效条件

- ① 改的是 APK 内置脚本，**要重新打包发版**；②③ 只影响 edge，④ 全角色，**重启网关**生效。

---

## 待发布（2026-11-09）：陈旧锁 PID 复用导致网关起不来 + 访客密钥下限回退

### ① 网关「起不来」：陈旧锁 + Windows PID 复用误判

- **现象**：DSH 启动后设置卡一直「网关未运行」，手机连不上；`18443` 无监听，
  `~/.dsh-remote/gateway.lock` 仍是几天前的 pid，插件每 3s 静默重试。
- **根因**：旧锁只写一行 pid，判活用 `process.kill(pid, 0)` 并把 `EPERM` 当作
  「进程存在但无权发信号」。Windows 的 PID 会被系统复用：11/6 残留的 pid 被系统
  进程回收后 `kill(0)` 抛 EPERM，陈旧锁被永久误判成「已有网关在运行」，网关再也起不来。
- **修复**（`packages/gateway/src/instance-lock.ts`）：锁文件升级为 JSON
  （`pid/startedAt/exe/host/port/token`），判活三级：`ESRCH` 确认不存在 → 清锁；
  pid 存活或 EPERM → 用管理端点回显的 `lockToken` 核对身份，令牌一致才拒绝启动，
  否则清锁重抢；管理端点不可判定时，只有 15s 启动窗口内的新锁才保守拒绝。
  `listenPort=0` 时监听后回填真实端口；旧格式纯 pid 锁保持兼容。
- **可观测性**：插件捕获网关子进程 stderr 尾部与退出码，`/dsh-remote/status` 新增
  `gatewayLastError` / `gatewayLastExit`，设置卡在网关未运行时显示「上次启动网关失败：…」，
  不再静默重试。
- **测试**：新增 `scripts/test-instance-lock.mjs`（含 PID 复用、在跑拒绝两条真启动 E2E），
  接入 CI（`pnpm test:lock`）。

### ② 访客密钥最小长度 16 → 8（部署方要求回退）

- rc.2.23 的安全加固「至少 16 位可见 ASCII」回退为「至少 8 位」：客户端预检、
  插件服务端 schema、网关启动警告阈值与文案、`scripts/test-plugin-routes.mjs` 同步调整。
- ⚠️ 安全提示：8 位口令强度回到 rc.2.22 之前；公网入口（`entryEnabled`）与 edge
  场景仍建议使用 ≥16 位随机密钥。

### ③ Android 壳会话页改走官方 Harness

- Android 注入 `mobile.js` 前写入 `__DSHR_MOBILE__.chrome = false`。壳内不再创建悬浮鲸鱼、圆角抽屉、全屏设置改写和焦点守卫效果。
- 官方空会话上的品牌鲸鱼和「探索未至之境」仍会显示，那是 deepseek-harness 自己的首页（对照 `master` `fcc0ad4`，dsh-v0.2.2-rc.1 合入 master）。
- 视口低于 768px 时，跟手滑动只推动官方 `data-sidebar-drawer` 和右侧 dock，松手过半后点击官方开关。左抽屉里的服务器切换保留。隧道、证书、配对和添加/编辑服务器页面不动。
- 浏览器和 edge 不写 `chrome: false`，原有窄屏 hook 保持原样。

### ④ Android 官方壳会话正文被收起的右栏刷白

- **现象**：v0.2.0-rc.2.26 实机上，官方顶栏（对话 / 轨迹）和底部 composer 都在，页脚还能看到「1 轮 45 步」「4.4M tok」，中间消息列表整片空白。
- **根因**：视口低于 768px 时，官方右栏即使收起也是 `[data-sidebar-right-panel="fullscreen"]`，盒子 `width:100vw`、`position:absolute`、`z-index:auto`，从 0 宽右栏列向左盖住整屏；内层 dock 被 `translateX(100vw)` 且 `visibility:hidden`。`mobile-web.js` 为系统栏让位给这块面板铺了不透明底（`--dsw-alias-bg-base`，回退白色）。自有 chrome 靠主列 `z-index:20` 把收起的板压在会话下面，所以以前看不见；`chrome:false` 不再挂 `html.dshr-mobile`，这张白底就盖住正文。顶栏（`z-index:1`）和 composer（`z-index:9`）层叠更高，所以还露在外面。
- **修复**（`packages/gateway/assets/mobile-web.js`，`android/.../res/raw/mobile.js` 字节同步）：官方壳 / 平板档下，未打开的 fullscreen 右栏底色改回透明。打开（`data-sidebar-right-open`）仍用原来的 token 垫系统栏。不恢复悬浮鲸鱼或自有抽屉。跟手滑动和侧栏里的服务器切换不动。
- **测试**：`scripts/test-official-shell.mjs` 增加收起态取样：消息像素保持正文色，打开后面板底色重新不透明。原有左右缘跟手断言保留。

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
