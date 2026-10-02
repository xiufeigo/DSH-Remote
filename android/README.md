# DSH Remote · Android 壳 App

内嵌 **frpc visitor** 的 WebView 壳：配合网关的 stcp/xtcp 访客模式，
手机凭访客密钥直连家里 PC，**VPS 不需要开放任何公网入口端口**。

```
手机 App ── frpc visitor（内嵌）──> frps(VPS, 仅控制口) ──> frpc(PC 网关侧) ──> 127.0.0.1:18443
                └─ xtcp 打洞成功时：手机 ⇄ PC 直连，数据不过 VPS
```

## 功能

| 能力 | 说明 |
|---|---|
| 扫码导入 | `dsh-remote visitor` 出二维码 → 任意第三方扫码器打开 `dsh-remote://visitor?...` 链接 → 本 App 自动接管导入；也支持剪贴板粘贴/手动填写 |
| 隧道托管 | 前台服务保活内嵌 `libfrpc.so`（frp 官方 android_arm64 二进制），崩溃自动重启（指数退避）。通知在智能体正在跑时显示当前会话标题和内容；空闲走静默渠道，不再写本机端口直通文案 |
| 证书锁定 | 指纹随二维码下发、连接前预置（无感锁定）；直连模式退化为 TOFU 首连确认 + 变更强提示 |
| 直连模式 | 备用：WebView 直接打开 `https://VPS:8443`（entry 形态）或局域网地址 |
| 配对 | 复用网关配对页（一次性码），设备 Token 落 WebView Cookie 长期有效 |
| 移动界面 | 启动后先进入 DSH 风格移动壳；真实工作区和会话仍由已认证的 DSH Web 提供 |
| 设备档位 | 按原生 `smallestScreenWidthDp` 分档：手机竖屏＝手机界面；平板/折叠屏展开＝官方 DSH 桌面界面且零痕迹；手机横屏＝官方桌面布局。见 [移动界面](#移动界面) |
| 设置一致性 | 连接设置为卡片式（与电脑端插件面板观感对齐）；「隧道形态」（xtcp/stcp）与电脑端「设置 → 插件 → DSH Remote」同名同义，手动配置时两端可逐项对照 |

## 构建

依赖（本机已具备）：

- JDK 17+（Android Studio 自带 JBR 即可）
- Android SDK：build-tools **35.0.0** + platforms;**android-36**

```powershell
powershell -File android\build.ps1
# 输出 android\dist\dsh-remote.apk（已签名，直接侧载）
```

脚本行为：

1. 缺少 `android/jniLibs/arm64-v8a/libfrpc.so` 时自动从 GitHub Releases
   下载 frp android_arm64（版本取根 `package.json` 的 `config.frpVersion`，
   读取失败回落内置版本并告警；失败走 ghproxy 镜像）；
2. **同步移动适配脚本**：`packages/gateway/assets/mobile-web.js` 是 hook 的**单一源**
   （edge 网关注入与安卓壳注入共用同一份代码，平台差异运行时探测）。构建脚本每次都会
   把它**字节级复制**到 `res/raw/mobile.js`（WEB-02 铁律），因此**不要手改壳内副本**——
   下次构建就会被覆盖回去。构建日志里的「已同步 mobile.js 单一源（N 字节）」即该步骤；
3. aapt2 → javac(Java 8 语法) → d8 → 打包 dex 与 `lib/arm64-v8a/libfrpc.so`
   （安装后系统解压到 nativeLibraryDir——Android 只允许执行该目录，
   这就是 frpc 必须伪装成 `lib*.so` 的原因）→ zipalign → apksigner；
4. 签名两种模式：
   - **开发构建（默认）**：`%USERPROFILE%\.android\dsh-remote.jks` 首次构建
     自动生成（PKCS12），口令随机生成并写入同目录 `dsh-remote.pass`。
     **升级安装必须沿用同一密钥与口令文件，请一并备份。**
     旧版本（固定口令时代）的存量密钥若缺 `dsh-remote.pass`，构建脚本会
     自动尝试找回口令（`DSH_KEYSTORE_PASS` 环境变量 → 旧固定口令），找回后
     补写口令文件并**沿用原密钥签名**——已安装设备的覆盖升级不受影响。
   - **发布构建（`DSH_RELEASE=1`）**：要求 `~/.android/dsh-remote.jks` 已就位，
     口令来自环境变量 `DSH_KEYSTORE_PASS` / `DSH_KEY_PASS`（可选
     `DSH_KEY_ALIAS`）；缺失立即报错，绝不生成临时密钥。CI 发版由
     `release.yml` 解码 GitHub secret 写入（保证历次发版 APK 签名一致、
     可覆盖升级）。

无 Gradle、零 npm/maven 依赖；CI（GitHub Actions ubuntu runner）用同一条
脚本构建，见 `.github/workflows/android.yml`。

## 使用流程

一次性准备（PC 侧）：

```jsonc
// ~/.dsh-remote/config.json
{ "frp": { "enabled": true, "serverAddr": "<VPS IP>", "serverPort": 7000, "mode": "xtcp", "name": "dsh-remote" } }
```

```powershell
node packages/gateway/src/cli.ts start     # 启动网关（自动托管服务端 frpc）
node packages/gateway/src/cli.ts visitor --mode xtcp   # 出码
```

手机侧：

1. 安装 APK，点「从剪贴板导入」或用任意扫码器扫终端里的二维码；
2. 导入成功后 App 自动拉起前台服务跑 frpc visitor，
   就绪后自动打开 `https://127.0.0.1:<bindPort>`；已有访客配置的后续冷启动同样自动连接；
3. 首次进入 DSH 配对页，PC 上 `dsh-remote pair --name 我的手机` 输码即完成绑定。

## 验证

### 真实页面（Chrome CDP，无需模拟器）

`pnpm test:device`（`scripts/test-device-class.mjs`）在**真实的 DSH 0.2.0-rc.2 页面上**
跑设备档位断言：用 admin 端点铸一次性配对码换设备 cookie，再由 Chrome CDP 带 cookie 加载
真页面（不是 fixture）。矩阵 A–E：A 手机竖屏 412×915（hook ON）、B 手机横屏 915×412（hook OFF）、
C 平板 852×883 / D 平板 1280×800（平板档对照实验）、E 运行中 `phone → tablet → phone` 切换。
对照实验按「注入 hook（平板档）」与「完全不注入」两臂逐项比对关键元素几何、computed style 与
`documentElement` 行内样式，两臂的渲染完成快照写进 `scratch/plan-0.2.0-rc.2/dom-baseline-tablet-*.json`。

| 项 | 实测结果 |
|---|---|
| 断言总数 | **55/55 通过，失败 0，跳过 0**；**连跑 4 次全绿**（4 次均 `EXITCODE=0`） |
| 零痕迹 | 平板档 C/D 与切换后的 OFF 态：`<html>` 无 `data-dshr-*`、无 hook 根类（含 `dshr-official-inset`）、无 hook 创建的可见节点、官方节点上无 `data-dshr-*` 标记——全部通过 |
| 平板档对照 | C（852×883）与 D（1280×800）两视口**逐项像素差全 0**：frame / 三列 / header / composerCard / composerSeat / rightbar / bodyScrollHeight / documentScrollWidth / documentClientWidth |
| 运行中切换 | `__dshrSetDevice('tablet'\|'phone')` 立即生效；**同值重复调用幂等**（第二次返回 `false`）；切回后根类、标记与几何可逆 |
| 测试设备 | 每次运行自建 1 个设备并在结束时吊销；4 次连跑的设备表差额均为「未吊销的新设备 0 个」 |

**渲染完成门禁**：官方 DSH 是分阶段挂载的（主界面先出 → composer seat → 右栏 dockkit），
脚本在**两臂、全部场景**统一等「渲染完成」才取证——五项判据
（`#root` 有子节点 / `header` 高 > 0 / `data-composer-card` 高 > 0 / `data-composer-seat` 高 > 0 /
宽视口 `innerWidth ≥ 900` 下 `data-sidebar-right-panel` 已挂载）**且**取值**连续 3 次采样完全一致**；
采样**必须含各元素 top 坐标**（半渲染的 composer 表现为「高度对、y 差 20px」，只比高度会把它当成已落定）。
拿不到这个状态就**抛错中止**，宁可不出证据，也不出错证据。

> **该门禁做过反向验证**：临时放宽后，场景 D（1280×800）稳定复现 **53/55**、两条 FAIL
> （header 注入高 40px / 不注入高 0；composer 与 composerSeat y 差 20px；右栏 `present-in-one-arm-only`），
> 与「两臂被拍在半渲染状态」的症状完全吻合；恢复门禁后同一视口逐项像素差归零。
>
> 证据：`scratch/plan-0.2.0-rc.2/run1-strict.log`、`run2-strict.log`、`run3-strict.log`、
> `run5-final-restore.log`（各含 55/55 与逐项像素差原文）；反向验证
> `scratch/plan-0.2.0-rc.2/run4-RELAXED-repro.log`（53/55 与两条 FAIL 原文）。
> 0.2.0-rc.2 产物侧的结构依赖复核（71 条，**0 条失效**）见 `scratch/plan-0.2.0-rc.2/recon.md`。

`pnpm test:mobile`（`scripts/test-mobile-chrome.mjs`）覆盖手机布局自测（fixture 页面），
含 hook 单一源与壳内副本的字节一致性检查（WEB-02）。

两条命令都需要**本机 DSH + 网关 `127.0.0.1:18443` 在跑**；宿主/网关不可达或找不到
Chrome 时打印原因并以退出码 0 自动跳过，不算失败。运行时会在本机 DSH 上创建一个
测试设备并在结束时吊销。

### 模拟器端到端

用专用 AVD、端口独立（**不要碰其它会话占用的模拟器端口**）。本轮实际跑端到端的是平板档案 AVD
`DSH_Class_Test`（serial `emulator-5590`，镜像 `system-images;android-35;google_apis_playstore_tablet;x86_64`，
`abilist=x86_64,arm64-v8a`）——选它是因为三道闸门全过：`dumpsys display` 只枚举出 **1 块 display**、
`screencap` 出的是**经魔数 + IHDR + IEND 校验的真 PNG**、架构装得下 arm64 APK。折叠屏 AVD 走不通，
原因见「已知限制」。

档位靠 `wm size`（尺寸）+ `wm density`（密度）覆盖驱动，判定值一律取 `dumpsys window displays` 的真实
`overrideConfig`（不由截图反推）。`sw393dp`（手机）↔ `sw618dp` / `sw800dp`（平板）**均真实触发系统
Configuration 变化**，跨过 600 分界线：

| 编号 | 场景 | 手段 | 真实 Configuration | 结果 |
|---|---|---|---|---|
| B1 | 手机档竖屏 | `wm size 1080x2340` + `density 440` | `sw393dp w393dp h851dp … port` | ✅ 手机界面：左上悬浮鲸鱼、官方 rail 被鲸鱼入口取代、输入框被改写为移动态 |
| B2 | 平板档竖屏 | `wm size 1600x2560` | `sw800dp … port` | ✅ 官方桌面布局：无鲸鱼 / 抽屉 / 任何 hook 浮层，系统栏由原生让位（不写 DOM） |
| B3 | 平板档横屏 | `wm size reset` | `sw800dp … land` | ✅ 同 B2 |
| B4 | 手机档横屏 | `wm size 2340x1080` | `sw393dp … land` | ✅ 官方 rail + 完整桌面输入框（hook OFF） |
| B5 | 运行中切换 | `wm size` phone ⇄ tablet ⇄ phone | `sw393dp ↔ sw618dp` | ✅ 界面按新档位即时生效，**App 进程 PID、WebView 渲染器 PID、`ActivityRecord` / `Window` 对象哈希全程恒定**，页面未重载 |
| B6 | 原生判定跨 600 | 同上 | `sw393dp`(<600) ↔ `sw618dp`(≥600) | ✅ 判定源 = 原生 `smallestScreenWidthDp`（全树唯一实现） |
| B7 | 平板档返回键 | 连续 `keyevent 4` | `sw618dp` | ✅ 会话根 → 连接设置（顶部出现「返回当前会话」）→ 再按 → 退到桌面（进程未被杀），会话 ⇄ 设置无死循环 |
| B8 | 手机档返回键回归 | `keyevent 4` | `sw393dp` | ✅ 直达桌面，**不进**连接设置页 |
| B9 | 通知动作 | 见下节 | — | ✅（T5c 补齐运行时验证） |

> 证据：`scratch/avd-dsh/e2e/evidence.md`（A–B9 逐条命令与原始输出、截图清单，24 张 PNG 全部通过
> 魔数 + IHDR + IEND 校验）；B5 的 `ActivityRecord` / `Window` 身份恒定另见 `scratch/t2e/evidence.md` §3.1。

### 通知「连接设置」动作（运行时）

D6 ② 已在运行态验证（`scratch/avd-dsh/e2e/notification-actions.md`）：

- `dumpsys notification --noredact` 里该通知带 `actions=2`，`actions={ [0] "断开" …, [1] "连接设置" … }`；
- **三个 PendingIntent 互不相同**（`PendingIntentRecord` 哈希 `340cdc0` / `3c84af9` / `1a81343`），
  `dumpsys activity intents` 补齐 action 串与 `requestCode 0/1/2`：`连接设置` =
  `action.OPEN_SETTINGS` → `MainActivity`（requestCode 2），`断开` = `action.STOP_TUNNEL`
  → `TunnelService`（requestCode 1），点通知本体无 action（requestCode 0）；
- **实点验证**（不只看 dumpsys）：点「连接设置」进连接设置页且**隧道不断**——通知对象哈希
  `0x0bee6fe8` 前后未变、`isForeground=true foregroundId=1` 不变；点「断开」→ logcat
  `收到通知断开操作，停止隧道`，`TunnelService` 记录与 `NotificationRecord` 双双消失；
- 通知栏实拍可见两个按钮（`PN-4-shade-expanded.png` + `ui-T5c-5-shade.xml`）。
- `OPEN_SETTINGS` 的冷路径（`LaunchState: COLD`）由 `scratch/avd-dsh/e2e/evidence.md` §6 覆盖，
  热路径（`onNewIntent`）本轮实测通过。

> **模拟器只走直连模式**：APK 的 `primaryCpuAbi=arm64-v8a` 而宿主是 x86_64 模拟器（走 native bridge），
> frpc 起来即 `SIGSEGV(139)` 并被无限重启（`frpc 退出 code=139`），所以**隧道连通性在模拟器上无法验证**；
> 本轮只用「假配置组 + 不可达 frps」把前台服务拉起来，验证**通知与 UI 行为**，不要求隧道真通。
> 另记一个坑：设备侧只要有 `adb reverse tcp:18443`，App 的隧道复用探测就会误判「隧道已活着」，
> `startForegroundService` 根本不被调用（造通知前须先 `adb reverse --remove tcp:18443`）。

### 已知限制

如实列出，不美化：

- **折叠屏 AVD 上无法截图**：`DSH_Fold_Test`
  （`system-images;android-37.2;google_apis_playstore_ps16k;x86_64` + `pixel_10_pro_fold` 档）
  在本机**多枚举出一块 display**，`screencap` 命中
  `Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma`，且 `system_server` 不稳定
  ⇒ **该 AVD 上截图类验收被阻断**。`config.ini`（与参考 AVD `Compare-Object` 只差 AVD 身份键与一个无害的
  `hw.lcd.depth`）与启动参数（同形裸命令行）两个变量均已排除，根因未定位。因此档位验证改用平板档案 AVD
  + `wm size` / `wm density` 覆盖。同镜像另有两个限制：**真·hinge 折叠不可用**
  （`cmd device_state` 报 `device state not available`，`adb emu fold` 报 `Device is not foldable`）、
  **旋转被 skin 锁死**（`ignoreOrientationRequest`），横屏只能靠 `wm size` 模拟几何；
  冷启动也长（无快照首次约 11.5 分钟，之后约 28 秒），每次 `wm size` 变更后还要等它 settle 再取值。
- **`configChanges` 补 `density` 的代价**：为避免折叠屏内外屏密度不同时重建 Activity、重载页面丢会话，
  Manifest 补进 `density`（`aapt2 dump xmltree` 实测 `configChanges=0x1fa0`）。实测密度 440→320 后
  **Activity 不再重建**（`ActivityRecord` / `Window` / `ProcessRecord` 三者哈希全等，页内非持久化探针
  连列表滚动偏移都不丢），但**原生壳页（App 自己的连接设置页）保留旧密度下的 dp 尺寸**：440→320 时
  「返回当前会话」按钮仍高 **132px**（理论 96px）、侧边内缩仍 50px（理论 36px）。**无破相**
  （所有 dp 同比例整体残留、版式自洽，只是整体偏大），**WebView 会话页不受影响**。
  修它要拆 `homeScroll` / `setupScroll` 重建壳页视图树并处理 EDIT 态输入，改动面超出本轮最小改动——
  建议单开一轮处理（证据文件 §5 / §6.1）。
- **「页面未重载」的探针方法学（已修正）**：上一轮用「输入框里的一段草稿文本」当探针是**无效**的——
  DSH 会持久化输入草稿，页面真重载后文本照样被还原（force-stop 对照里草稿「复活」即证伪）。
  现改用**工作区下拉菜单的展开态**（纯前端 React 状态，服务端不持久化，并比对列表滚动偏移）作主探针；
  「页面未重载」的结论由 **App 进程 PID + WebView 渲染器 PID + `ActivityRecord` / `Window` 身份恒定**
  与该探针共同支撑。
- **模拟器两次意外退出**：验证过程中 `emulator-5590` 曾两次整个 qemu 进程从宿主消失（并发跑 7 个模拟器、
  宿主负载很高时），判定为宿主资源争抢导致的 flake（非 App 缺陷）——所有截图均在崩溃前落盘并通过 PNG 校验。
- **未覆盖项**：`dsh-explorer` 插件共存路径本机不可验证（该插件是空安装，其 `data-dshx-*` 标记在
  0.2.0-rc.2 产物中 0 命中，两版都无，**不构成本轮回归**）。

> 详细预检记录见 `scratch/avd-dsh/preflight.md`；折叠 AVD 失败过程与替代 AVD 三道闸门见
> `scratch/avd-dsh/e2e/evidence.md` §1–§2；密度 / 文案 / 探针修正见 `scratch/t2e/evidence.md`。

## 移动界面

- App 首屏不再显示连接表单。没有访客配置、直连地址或可用后端时，只显示本地连接状态；不会编造或缓存工作区、会话、消息内容。
- 已连接时，主页面仍是原始 DSH Web。移动适配由 **App 在页面加载完成后注入的 `res/raw/mobile.js`** 完成，**不依赖服务器端是否安装 dsh-remote-plugin**——连接官方 DSH Web 与连接带插件的网关表现一致。隧道前台通知在智能体正在生成时显示当前会话标题和用户内容；任务结束后改走静默渠道。Android 要求前台服务必须挂通知，小米「正在运行」里空闲时仍可能看到一条很淡的保活项，但不会再写本机端口直通。
- 注入链路做了纵深防御：`onPageFinished` / `doUpdateVisitedHistory` / `onPageCommitVisible` 三个时机注入 + 1.5s/4s 延迟补注入（脚本幂等）；官方 DOM 探测带多级回退（`data-shell-overlay` 父节点 → 官方侧栏开关按钮祖先链 → `data-sidebar-collapsed`）；页面加载 6 秒后自检脚本是否真的运行，若始终缺失则自动退回**实色状态栏**模式（内容排在状态栏下方），绝不与系统栏重叠，后续注入成功会自动恢复沉浸。
- 适配按**设备档位**启用，档位由**原生**判定：`smallestScreenWidthDp >= 600` ⇒ `tablet`（平板 / 折叠屏展开），否则 `phone`。

  | 档位 | 竖屏 | 横屏 |
  |---|---|---|
  | `phone`（`sw < 600`） | **手机界面**（下列各项适配全部生效） | 官方 DSH 桌面布局（沿用 `dshr-official-inset` 让位） |
  | `tablet`（`sw ≥ 600`，含折叠屏展开） | **与官方 DSH 桌面版一致的界面**：hook 关闭、零痕迹 | 同左（官方桌面界面） |

  - **判定源唯一**是原生 `smallestScreenWidthDp`；**JS 不得用视口宽度反推档位**（部分机型 layout viewport 虚高，WEB-02 既有结论）。原生在注入 `mobile.js` **之前**把档位写进 `window.__DSHR_MOBILE__.device`（`phone` / `tablet` / `auto`），hook 只消费该值。
  - **平板档零痕迹**：`<html>` 上无 `data-dshr-*` 属性、无 hook 根类（含 `dshr-official-inset`），页面上无 hook 创建的可见节点（悬浮鲸鱼、drag handle、抽屉遮罩、状态栏挡板）。
  - **平板档的系统栏让位由原生做**：原生按状态栏 / 导航栏 / 挖孔收缩 WebView 自身 padding，官方布局拿到的是一个「本来就小一号」的视口，**页面本身零改动**（不写 DOM/CSS）。
  - **运行中折叠 ⇄ 展开切换**只改注入配置并调 hook 的幂等切换 API（`window.__dshrSetDevice`），**不重载 WebView、不中断隧道**，界面按新档位即时生效。平板档仍会定义该 API（幂等），只是不安装 hook。
  - 手机横屏的状态栏保持透明沉浸：侧栏灰底 / 主栏白底各自延伸到屏幕顶，控件再避开系统栏，并挡住该区域点击，避免误触。收起态用左上角悬浮鲸鱼打开侧栏。展开后采用 DeepSeek App 式布局：侧栏铺在底层，中间会话列可**跟手拖动**滑成圆角浮层。手机竖屏右侧只留细条。**主屏幕右划**也可打开；在侧栏里点对应会话（或新建会话）后抽屉自动收起。官方「设置」以**全屏页**盖住侧栏与会话（带进入动画），不再先收起侧栏再弹窗。模型、权限、命令、模式等浮动选框会被钳在视口内。输入底栏里超长模型名会省略号截断，不得盖住左侧「+」和权限按钮。
- 官方设置在手机上是**全屏页**（从设置入口盖住整屏，置于会话浮层之上），导航仍横向排在上方；选中分区内容全宽展开。侧栏展开时，按住右侧主会话浮层左滑可**跟手**收回会话全屏。导航列表允许横向触摸滚动，并在 `aria-current` 改变后自动把选中分区完整滚入可视区。只统计**当前可见**的模态框，隐藏弹窗残留不会误触发“弹窗打开”状态。
- 会话头部适配：官方 header（含会话面包屑标题）在收起态整体右移 72px，不再被固定在左上角的鲸鱼按钮遮挡；官方「Session log」下载按钮在手机宽度下收成 48dp MD3 图标按钮（24dp 图标，文字用 sr-only 剪裁，读屏仍可读，`aria-label` 同步补齐）。两者都按结构特征定位（`header` 内含 `nav`；按钮内 `span` 文本恰为 `Session log` 且带图标），不依赖 CSS Module 哈希类名。
- 窄屏触控目标按 MD3 规范补齐：消息操作钮（复制/点赞/分支）视觉保持 22px 图标、命中区经透明外扩至 48dp；设置页导航 tab 48dp 触控高度；悬浮鲸鱼 48dp。侧栏抽屉展开时交界处显示 MD3 4×32dp drag handle 指示条（纯视觉，不拦截跟手拖动手势）。
- 系统栏沉浸：App 保持透明状态栏 edge-to-edge，并把真实的状态栏/导航栏 inset（CSS px）写入页面变量 `--dshr-inset-top` / `--dshr-inset-bottom`；页面内容下移让出状态栏，状态栏颜色与页面背景一致（`viewport-fit=cover` 与 `env(safe-area-inset-*)` 仅作兜底）。即使官方 frame 结构探测失败，body 兜底 padding 也保证内容不顶进时钟/挖孔区域。**虚拟键盘**弹出时，原生按焦点输入框位置平移，只抬到输入框露在键盘上方（空会话/设置页元素少时不会把输入框顶出屏幕）；页面侧再用 `interactive-widget=overlays-content` 与 `visualViewport` 把焦点矩形告诉原生。Android 返回键会优先关闭设置弹窗或收起已展开的 DSH 侧栏。
- 适配脚本只依赖官方 DOM 的稳定结构特征（`data-shell-overlay`、`data-sidebar-collapsed`、`aria-label`、`role="dialog"` 等），不依赖 CSS Module 哈希类名，也不往 React 管理的容器里插入节点。
- 连接失败、隧道超时或 PC 端 DSH Web 不可达时，远端页面会换成本地失败页，可点「重新连接」；改连接配置请长按鲸鱼（平板档见下节）。已在跑的隧道不会因返回键或误报断线被拆掉，再点「连接」会复用本机隧道端口（首选 18443，被占用时自动在 16225~16235 协商），不必清后台。
- **手机档**下连接设置（配置组卡片页）**只通过长按小鲸鱼进入**。系统返回键不会打开该页：会话内先关官方弹层/侧栏再回上一页，到会话根则把 App 放到后台，**不会**退到 App 设置，也**不会**拆掉 frpc。若会话仍在，设置页顶部有「返回当前会话」，系统返回键同样回到已连接会话。点「连接」若隧道仍在，会直接恢复已注入移动适配的会话，不会重载成官方 DeepSeek Harness 桌面栏。
- 连接设置为卡片式布局（安全隧道 / 直连入口或局域网 / 连接维护三张卡片，圆角 + 浅灰页面底），并让出状态栏/导航栏 inset。「隧道形态」选择器提供 xtcp（P2P 打洞，推荐）与 stcp（加密中转）两项，文案与电脑端插件面板一致；entry（公网入口）形态是电脑端服务侧配置，手机上用「直连入口或局域网」即可，无需访客隧道。手动填写时按电脑端面板逐项对照：VPS 地址、控制端口、隧道形态、隧道名（默认 `dsh-remote`）、访客密钥、frps 登录密钥。

## 平板档设置入口

平板档（`sw ≥ 600`，含折叠屏展开）关闭了移动 hook，页面上也就没有长按鲸鱼那个入口。
为了让 App 自有的「连接设置」仍然可达，原生补两个入口，**两者都不在页面上新增任何可见浮层**：

| 入口 | 行为 |
|---|---|
| 隧道常驻通知的「**连接设置**」动作 | 进程外直达连接设置页（`MainActivity.ACTION_OPEN_SETTINGS`）。只切界面，**不碰隧道**、不重载 WebView；冷启动与已在前台/后台两条路径行为一致。通知上原有的「断开」动作不受影响 |
| **会话根**按系统返回键 | 打开连接设置页（会话内仍先关官方弹层、再收侧栏、再回上一页）。**仅平板档**如此；手机档在会话根仍是退到后台 |

**返回键语义（平板档）**：

- 由**返回键路**进入连接设置后，设置页的返回键 = **退到后台**（不回会话）。
  否则会形成「会话根 → 设置 → 返回 → 会话 → 返回 → 设置」死循环，用返回键退不出 App。
  该标记一次性消费，退后台时即清零；设置页顶部既有的「返回当前会话」按钮仍是平板档回会话的正路。
- 由**通知动作**（或长按鲸鱼）进入设置时，返回行为保持既有：**回会话**。
- 两条路径都**不会**拆掉 frpc。

## 图标

`res/mipmap-*/ic_launcher.png` 由 `icon-src/icon.html`（白色圆角方块 + 鲸鱼标记）渲染：
本机用 Edge headless `--screenshot` 出 1024px 底图，再以 GDI+ 高质量缩放生成
48/72/96/144/192 五档密度 PNG；改图标只需改 `icon-src/icon.html` 后重跑该流程。

## 安全说明

- 连接串含 `token` + 访客 `sk` + 网关证书指纹，**等于家门钥匙**：
  不要截图外传；泄露后在 PC 删除 `secrets.json` 的 `frpVisitorKey` 字段重启重新出码。
- 证书锁定按 `host:port` 记录指纹；指纹变更会强提示中间人风险后才允许更新。
- frpc 配置与日志落在应用私有目录（`filesDir/frpc-visitor.toml`），不落外部存储。
- 明文 HTTP 已默认禁用（`networkSecurityConfig`）：隧道会话固定 `https://127.0.0.1`（自签证书锁定），直连地址入口即拒绝 `http://` 并提示改用 `https://`——Basic Auth 凭据经明文传输会泄露。
- minSdk 24 / targetSdk 34；arm64-v8a 单架构（覆盖近十年真机）。

## Nginx Basic Auth（直连）

直连地址可放在 Nginx `auth_basic` 后。App 只会为当前 **HTTPS** 网关显示原生用户名/密码对话框；勾选「记住此网关的认证信息」后，用户名和密码写入 Android WebView 的 App 私有 HTTP Auth 数据库，`SharedPreferences` 只记录该 host+realm 是否允许自动使用，不保存密码。App 重启或重新连接后会自动提交一次；若 Nginx 再次返回认证挑战，则视为凭据失效，清空该条并重新显示输入框，不会用错误密码循环重试。「清除本机授权数据」会同时删除全部已保存的 Basic Auth 凭据。Basic Auth 通过后，才会进入 DSH Remote 的设备配对页。

在现有的 Nginx 反向代理 `location` 中保留 WebSocket 相关头，并补上：

```nginx
location / {
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # Nginx 已完成认证，不把浏览器的 Basic 凭据传给网关或本机 DSH。
    proxy_set_header Authorization "";

    proxy_pass https://127.0.0.1:18443;
}
```

手机的直连地址必须明确填写为 `https://...`，不要先填 `http://` 再依赖跳转；Basic Auth 仅是 Base64 编码，明文 HTTP 会泄露密码，App 也会拒绝在 HTTP 入口提交该凭据。

### Nginx 直接代理官方 DSH Web

推荐让 Nginx 代理上面的 DSH-Remote 网关 `18443`：网关会自动探测 DSH 的动态端口，并在设备认证通过后把上游 `Host` / `Origin` 改写成 loopback。若 `GET /__dsh_remote__/health` 返回 404，说明入口绕过了网关、正在直接代理官方 DSH Web。

官方 DSH 有两道独立的远程保护：

1. Host API 对 `settings.describe`、`settings.update`、`agentPreset.copy` 等操作执行 loopback-only 校验。只把公网域名加入 `trustedHosts` 仍不够：`agentPreset.list` 可能返回 200，写接口仍会返回 403。
2. 官方 connection 客户端直接用地址栏的 `location.hostname` 计算 `connection.isLoopback`。公网域名下会把设置镜像固定成内存只读模式；即使 Nginx 已让 API 返回 200，网页也不会发出 `settings.describe`，「通用设置 → Agent 预设」仍会静默禁用。

如果明确要让 Nginx 直接代理官方 DSH，普通 HTTP/API location 必须保留 HTTPS + Basic Auth，并把已认证请求改写成 loopback 上游：

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Authorization "";
proxy_set_header Host localhost;
proxy_set_header Origin "";
proxy_set_header X-Real-IP $remote_addr;
proxy_buffering off;
```

WebSocket location 也必须显式设置 `proxy_http_version 1.1`、`Upgrade` 和 `Connection "upgrade"`；sibling location 不会继承普通 location 中的这些指令。

在全站 Basic Auth 已覆盖该 server block 的前提下，可只对官方 connection bundle 增加以下兼容处理，使认证后的网页启用 Host 设置能力。这里的 `proxy_pass` 和 loopback 请求头要与普通 location 使用同一个上游：

```nginx
location = /plugins/@deepseek-ai/dsh-client-connection/client.js {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_set_header Authorization "";
    proxy_set_header Host localhost;
    proxy_set_header Origin "";
    proxy_set_header Accept-Encoding "";

    sub_filter_types text/javascript;
    sub_filter_once on;
    sub_filter 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),' 'isLoopback: true,';
    add_header X-DSH-Settings-Proxy "authenticated-loopback" always;
}
```

官方 index 的 manifest 标签默认不携带 Basic Auth。为避免 `/manifest.webmanifest` 固定返回 401，可在普通 HTML location 中增加精确替换，同时继续保护 manifest 本身：

```nginx
proxy_set_header Accept-Encoding "";
sub_filter_once on;
sub_filter '<link rel="manifest" href="/manifest.webmanifest" />' '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />';
```

这些替换依赖官方 bundle 中的精确字符串；升级 DSH 后应重新检查 connection 响应中原字符串命中一次、替换后字符串命中一次。修改前先备份配置，执行 `nginx -t`，再 restart 以断开仍占用旧 worker 的 HTTP/2/WebSocket 长连接。最终应同时满足：`settings.describe=200`、`settings.update=200`、`events.mux/events.host=101`，且网页选择框不是 disabled。

这会有意让经过 Nginx 认证的请求通过 DSH 的 loopback 栅栏，因此必须使用强密码，并确保 Basic Auth 覆盖 `/api/*`、WebSocket 和 connection bundle 在内的全部路径。

## 已知取舍

- 未内置相机扫码组件（保持零三方依赖）：扫码交给系统里任意扫码器 +
  URL 接管完成；没有扫码器时可走剪贴板粘贴。
- xtcp 打洞成功率取决于两端 NAT 类型；失败由 frpc 自动回退 stcp 中转。
- iOS 版未做（需开发者账号分发）；传输协议两端通用，浏览器亦可按
  docs/vps-frps-setup.md §4.5 的 toml 方式接入。
