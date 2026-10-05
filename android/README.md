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
| 设备档位 | 按原生 `smallestScreenWidthDp` 分档：手机竖屏＝手机界面；平板/折叠屏展开＝官方 DSH 桌面界面（rc.2.8 起 hook **最小化**：不新增 DOM 节点/属性/类名/样式）；手机横屏＝官方桌面布局。见 [移动界面](#移动界面) |
| 设置一致性 | 连接设置为卡片式（与电脑端插件面板观感对齐）；「隧道形态」（xtcp/stcp）与电脑端「设置 → 插件 → DSH Remote」同名同义，手动配置时两端可逐项对照 |

## 构建

依赖（本机已具备）：

- JDK 17+（Android Studio 自带 JBR 即可）
- Android SDK：build-tools **35.0.0** + platforms;**android-36**

```powershell
pwsh -File android\build.ps1
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

#### 构建纪律：参数与单一源

- **未知参数会报错退出（exit 2），不静默忽略。** `$args` 收的是没有被 `param()` 绑定的一切：
  拼错的开关（`-DebugBuild`）、多写的值、位置错，都会直接退出——**这正是要的行为**，
  拼错调试开关却悄悄出了一包 release 产物，比报错难查得多。实测三种拼错（`-DebugBuild` / `-debug` /
  `--debug`）**均在 0.27s 内退出且产物零触碰**。证据：`scratch/t51/report.md` §3、`scratch/t52/report.md` §2。
  调试构建就是 **`-Debug`**。
- **`res/raw/mobile.js` 由源无条件同步覆盖**：`Copy-Item -Force` 不看内容是否相同，
  `packages/gateway/assets/mobile-web.js` 每次构建都会被字节级覆盖过去。
  所以**只改 `res/raw` 的改动会被构建抹掉**，而且在抹掉之前**先触发单一源断言**（`test:mobile` 的
  钩子/壳内副本字节一致性检查，WEB-02）⇒ 症状是「跑测试就被拦下」，不是「改了没生效」。
  **要改就改源。** 证据：`scratch/t52/report.md` §10.1、`scratch/t53/report.md` §1.2。

### 测试期可观测构建（`-Debug`，仅测试用）

排查「手机界面到底有没有生效」这类问题时，用**带开关的可观测包**——它能开 WebView
DevTools，不必再靠无障碍树反推 DOM：

```powershell
pwsh -File android\build.ps1 -Debug      # 等价 $env:DSH_DEBUG=1
# 输出 android\dist\dsh-remote-debug.apk（另存名，绝不覆盖发布产物）
```

| 项 | 默认构建（release） | `-Debug` 构建 |
|---|---|---|
| 产物名 | `dsh-remote.apk` | `dsh-remote-debug.apk` |
| `aapt2 link` 参数 | 不传 `--debug-mode` | 传 `--debug-mode` |
| versionName | `0.2.0-rc.2.9` | `0.2.0-rc.2.9+debug` |
| manifest `android:debuggable` | **属性不存在** | `true` |
| WebView DevTools | 关 | 按 `FLAG_DEBUGGABLE` 开 `setWebContentsDebuggingEnabled(true)` |

**release 路径零变化**：默认构建不传 `--debug-mode`，产物清单里根本没有 `debuggable`
属性，原生那个分支**永不成立**，DevTools 从不开启。`MainActivity` 里按
`FLAG_DEBUGGABLE` 判定的写法是硬要求，**严禁改成无条件开启**——debuggable 的 WebView
任何本机应用都能接管调试。

装上之后按 T16 的取证姿势取值：

```powershell
adb install -r android\dist\dsh-remote-debug.apk
adb reverse tcp:18443 tcp:18443                  # 设备侧访问本机网关
adb shell "cat /proc/net/unix | grep webview_devtools_remote"   # 应出现 socket
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# 然后经 CDP 读真值：node scratch/t16/cdp.mjs probe|timer|watch|eval|targets
```

> 该能力由 T16 引入（`build.ps1` +31/-2、`MainActivity` +14），默认路径的行为与产物名
> 均未变；证据见 `scratch/t16/forensics.md` §1（含 `aapt2 dump xmltree` 原文）。

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
| 断言总数 | **158/158 通过，失败 0，跳过 0**（rc.2.6 批次终局，退出码 0；`断言合计 158：通过 158，失败 0，跳过 0`，台账 `scratch/lead-rc26-regression.log:19`。**rc.2.7 复跑同值：158/158、失败 0、跳过 0**，台账 `scratch/lead-rc27-regression.log:17`；**rc.2.8 复跑同值：158/158、失败 0、跳过 0**，断言行原文见 `scratch/t100/regression.log:19`，Lead 台账 `scratch/lead-rc28-regression.log:19` 记该项 `exit=0`）。其中 **34 条**是 rc.2.6 新增的平板档系统栏避让（6 条源码契约 + 四方向重叠 + 键盘 not-in-mask）；**140 条是本批次中期快照**（T72 收口时），55 条基线曾**连跑 4 次全绿**、91 条为 rc.2.3 批次、106 条为 rc.2.5 批次 |
| 零痕迹 | 平板档 C/D 与切换后的 OFF 态：`<html>` 无 `data-dshr-*`、无 hook 根类（含 `dshr-official-inset`）、无 hook 创建的可见节点、官方节点上无 `data-dshr-*` 标记——全部通过 |
| 平板档对照 | C（852×883）与 D（1280×800）两视口**逐项像素差全 0**：frame / 三列 / header / composerCard / composerSeat / rightbar / bodyScrollHeight / documentScrollWidth / documentClientWidth |
| 运行中切换 | `__dshrSetDevice('tablet'\|'phone')` 立即生效；**同值重复调用幂等**（第二次返回 `false`）；切回后根类、标记与几何可逆 |
| 测试设备 | 每次运行自建 1 个设备并在结束时吊销；连跑的设备表差额均为「未吊销的新设备 0 个」 |

**退出码语义（T51 起，三值）**：

| 退出码 | 含义 | 怎么读 |
|---|---|---|
| `0` | 断言全过 | 通过 |
| `1` | **有行为断言不成立** | 真回归，按失败处理 |
| `2` | **没拿到对照证据**（本轮一条断言都没真跑） | **瞬态**，不是失败；重跑即可 |

把「拿不到证据」与「断言失败」分成两个码是刻意的：官方 DSH 分阶段挂载，瞬态卡在半渲染时
**不该被读成回归**。触发退出码 2 的典型情形是视口下发失败、或注入 device 后未达渲染完成状态
——此时脚本**中止且不产出对照证据**，宁可不出证据，也不出错证据。
脚本内部对「导航成功但应用没起来 / 停在半渲染」会**重试**（`LOAD_MAX_ATTEMPTS = 4`，T51 由 2 提到 4）。
证据：`scratch/t51/report.md` R8、`scripts/test-device-class.mjs` 退出码约定原文。

> **已知瞬态（重试可恢复，不要当回归）**：对照臂偶发 `header 高度 = 0`（React 尚未挂载）。
> 成对复现见 `scratch/t52/report.md` §13.3——同一晚两次 AVD 起停后，**同一条命令 3/3 全绿**。
> 真遇到时重跑即可；若持续复现才是问题。

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

> **断言不是空转的**：T24 的联想浮层断言做过**负控制**——临时换入修复前的 hook 重跑同一套
> 断言，注入臂 3 条稳定转红、退出码 1，不注入的对照臂 4 条全绿。证据
> `scratch/t24/report.md` §6.1–§6.2。

### JVM 单测（无需模拟器、无需设备）

```powershell
pwsh -File android\test-direct-nodes.ps1
# Direct node tests passed: 20
# CertPin tests passed: 32
# TunnelReady tests passed: 25     ⇒ 合计 77 断言，EXIT=0

pwsh -File android\test-immersive.ps1         # T94+T115 系统栏沉浸契约（68 断言，rc.2.8 时 48）
pwsh -File android\test-reconnect-banner.ps1  # 探针/防抖 131 + StuckRescue 79 + 探针 DOM 桩 32
                                              #   + T109 判据臂：静态白名单 14 + 本网关协议族 13
pwsh -File android\test-backkey.ps1           # 返回键探针 66 + DOM 桩 18
```

> **T109 起 `test-reconnect-banner.ps1` 的构成变了**（横幅显示层删除）：
> 与「画出来」有关的臂（`isOnScreen` / `bandHeightPx` / `shouldSuppress` / `TEXT`）已删，
> 换来两条**行为**臂——把 `MainActivity` 里 `isStaticCachePath` / `isStreamingPath` /
> `isActiveGatewayUri` 及其四个 helper 的**方法体原文**抠出来，配 `Uri`/`TextUtils` 替身
> `javac` 真编译真跑（T40 §8 M1/M2：只做字符串断言，删掉关键一行照样全绿）。
> 采样那条链（`PROBE_JS` + `Debouncer` + `StuckRescueTest` 79 项）**一个字未动**。

> ⚠️ **调用纪律**：`android\test-*.ps1` **一律用 `pwsh -File`**。用 Windows PowerShell 5.1 会把
> UTF-8 脚本按 ANSI 读 ⇒ 非 ASCII 字面量被破坏、传参变空（脚本会拿 `MainActivity` 当 hook 源）
> ⇒ **假红**。证据：`scratch/t94/report.md` §6.2。

沿用既有 stub 测试风格（`main()` + `check()` + **直接跑真实生产类**）。`CertPin` /
`TunnelReady` 是刻意做成**零 Android 依赖**的纯函数类（连 `TextUtils` 都不用），因此可在
JVM 上直接跑：前者钉死证书锁定的键方案与 5 类场景（同档同指纹 / 同档异指纹 / 异档异指纹 /
无档有 host:port pin / 两者都无），后者钉死 20s 上限、200ms 首探、100/200/400ms 退避、
frpc 真实就绪关键字，并显式断言 `establishing nat hole…` 与 5 类噪声行**不算**就绪。
证据：`scratch/t23/report.md` §7（`ut.log`）。

### 全量回归（rc.2.5 批次，13 项全绿）

逐项退出码来源：`scratch/lead-rc25-regression.log`（每项以 `--- <命令> exit=0 ---` 分隔）。
`typecheck` / `test:mobile` / `test:device` / `test:fixes` / `test:desktop` / `test:perf` /
`smoke` / `smoke:edge` / `test:routes` / `test:session` / `test:client` / `test:build` /
`test:apk-sync` —— **13 项全部 exit 0**。证据：`scratch/t53/report.md` §4.1。

> 早前的 **rc.2.3 批次为 11 项全绿**（`scratch/lead-rc23-regression.log`，其中 `test:device`
> 打印 `断言合计 91`）。批次口径不同、逐项退出码各自留档，故两节并存、不合并。

### 验收台在哪（找错文件比跑错还费时间）

| 台 | 定位 | 怎么用 |
|---|---|---|
| `pnpm test:device`（`scripts/test-device-class.mjs`） | **真页面**设备档位回归，唯一跑真实 DSH 0.2.0-rc.2 页面 + **158** 条断言的那条（rc.2.6 起的终局口径） | 需本机 DSH 与网关 `127.0.0.1:18443` 都在跑 |
| `android\test-direct-nodes.ps1` | **JVM 纯函数**单测（`CertPin` / `TunnelReady`），无需模拟器、无需设备、无需 DSH | 改证书锁定 / 就绪轮询逻辑后**先跑这个**，秒级 |
| `android\test-immersive.ps1` · `android\test-reconnect-banner.ps1` · `android\test-backkey.ps1` | **JVM + DOM 桩契约**（T94 沉浸 48 / 横幅 122+79+32 / 返回键 66+18），无需设备 | 改系统栏配色 / `StuckRescue` / 返回键语义后跑；**必须 `pwsh -File`** |
| `scratch/t47/harness.mjs` | **手势 / 键盘**专项验收台（44/44），右栏关闭手势与 `+` 布防的证据都出自这里 | 改 hook 手势后跑；它是取证台不是回归门 |
| `scratch/t51/` · `scratch/t52/` | 键盘布防、假牙与修复的逐轮报告与日志 | 结论以报告为准，不以单次日志为准 |

> `pnpm test:device` 是**回归门**，`harness.mjs` 是**取证台**——两者断言口径不同，不要互相替代。

> **rc.2.6 各任务回归退出码（逐任务留档，非总台账）**：
>
> | 任务 | 回归内容 | 结果 |
> |---|---|---|
> | T60（`PinnedFetch` 加固） | 回归 5 项全绿（typecheck / test:mobile / test:device / test:fixes / test:desktop） | 5/5 exit 0 |
> | T65（首屏原生落盘） | 同步改 6 个文件后重跑 `typecheck` / `test:mobile` / `test:device` / `test:fixes` 全绿 | 4/4 exit 0 |
> | T72（平板 insets） | `test:device` 断言 **106 → 140**，**140/140** 通过 | exit 0 |
>
> ℹ️ **rc.2.6 总台账（Lead 侧统一跑，收口时已产出）**：`scratch/lead-rc26-regression.log` —— **14 项全部 exit 0**
> （typecheck / test:mobile / **test:device 158/158、失败 0、跳过 0** / test:fixes / test:perf / test:routes /
> test:session / test:client / test:desktop 10/10 / smoke / smoke:edge / ws-keepalive 19/19 /
> resume-recovery 12/12 / T47 验收台 44/44）。上表是**各任务收口当时**留档的退出码（写「没有总台账」那句时
> 总表尚未跑），两者**互补不冲突**，数字一律以总台账为准。证据：`scratch/t60/report.md` §7、
> `scratch/t65/report.md` §8、`scratch/t72/report.md` §6、`scratch/lead-rc26-regression.log`。
>
> **rc.2.7 总台账（Lead 侧统一跑，收口时已产出）**：`scratch/lead-rc27-regression.log` —— **14 项全部 exit 0**
> （typecheck / test:mobile / **test:device 158/158、失败 0、跳过 0** / test:fixes / test:perf / test:routes /
> test:session / test:client / test:desktop 10/10 / smoke 22 / smoke:edge 19 / ws-keepalive /
> **test-resume-recovery 12/12** / **T47 验收台 44/44**）。受测 hook 为
> `DD2FDD02…A15420`（292936B、CR=0），源与 `res/raw` 副本逐字节相同。
>
> **rc.2.8 总台账（本任务在**最终字节**上复跑，逐项 exit 0）**：`scratch/t100/regression.log`
> —— **17 项全部 exit 0**：`typecheck` / `test:mobile` / **`test:device` 断言合计 158：通过 158、
> 失败 0、跳过 0** / `test:fixes`(17/17) / `test:perf`(25/25) / `test:routes`(17/17) /
> `test:session` / `test:client` / `test:desktop`(10/10) / `smoke` / `smoke:edge`(19/19) /
> `ws-keepalive`(19/19) / `test-resume-recovery`(**12/12**) / `t47/harness.mjs`(**44/44**) /
> `android\test-immersive.ps1`(**48**) / `android\test-reconnect-banner.ps1`(**122 + 79 + 32**) /
> `android\test-backkey.ps1`(**66 + 18**)。受测 hook 为
> `D4466D0D58B272877E7EDC7287F1C0E5D047642B214F5548AFEE0CAC8923B26A`（**317998 B、CR=0**），
> 源 = `res/raw` 副本（= APK 内嵌，见下）。Lead 侧另有 `scratch/lead-rc28-regression.log`
> （14 项 + T47 44/44，全 exit 0），两者结论一致。
>
> **rc.2.9 总台账（本任务在**最终字节**上复跑，逐项 exit 0）**：`scratch/t116/regression.log`
> —— **17 项全部 exit 0**：`typecheck` / `test:mobile` / **`test:device` 断言合计 158：通过 158、
> 失败 0、跳过 0**（原文 `test:device 通过：真实 0.2.0-rc.2 页面上的手机/平板/横屏/运行中切换矩阵全部符合契约。`）/
> `test:fixes`(17/17) / `test:perf`(25/25) / `test:routes`(17/17) / `test:session`(18/18) /
> `test:client` / `test:desktop`(10/10) / `smoke`(**22/22**) / `smoke:edge`(**19/19**) /
> `ws-keepalive`(19/19) / `test-resume-recovery`(**12/12**) / `t47/harness.mjs`(**44/44**) /
> `android\test-immersive.ps1`(**68**) / `android\test-reconnect-banner.ps1`(**131 + 79 + 14 + 13 + 32**) /
> `android\test-backkey.ps1`(**77 + 18**)。受测 hook 为
> `FD0F443417E66D02FB10BC78B1DE05432F06F6BFC1B1EB91979FA5251FCD20C0`（**363829 B、CR=0**），
> 源 = `res/raw` 副本 = **APK 内嵌**（release 与 `-Debug` **两个包都核过**，三处逐字节相同）。
>
> ⚠️ **与 rc.2.8 相比的三处断言数变化，都是本批改动的直接后果，不是漏跑**：
> `test-immersive` **48 → 68**（T115 新增 24 条，旧 44 条**一条未删**）；
> `test-backkey` **66 → 77**（T99/T102 源码契约形状扩展）；
> `test-reconnect-banner` 由 `122 + 79 + 32` 变为 **`131 + 79 + 14 + 13 + 32`**
> （横幅**显示层**那批臂删除，换来 T109 的两条**行为**臂：静态白名单 14 + 本网关协议族 13）。
> **本批台账已把 `smoke` / `smoke:edge` 列在内**（见上方验收纪律最后一条）。

> **验收纪律（rc.2.6 两条 + rc.2.7 两条 + rc.2.8 三条，都能把「环境问题」误读成「代码回归」）**：
> - **网关有 240 次/分、按 IP 共享的限流。** 本机同一 IP 上**并行**跑多个验收任务时会互相打点，
>   被限流的那几项返回 429 ⇒ **该轮结果一律判无效（不是失败）**，退避后**单跑**重取。
>   证据：`scratch/t63/report.md` §1.0(1)。
> - **`caches.keys()` 会低报**，别用它判「缓存是不是空了」（索引惰性加载）。验收缓存一律配
>   **`du -sk` + 网卡字节**三者互证，详见「安全说明 → 磁盘缓存「0 条」是预期行为」。
>   证据：`scratch/t62/report.md` §2.3。
> - **真机验证前必须先重建 APK，并解包比对内嵌 hook 的 SHA**（rc.2.7）。旧包里的 `res/raw/mobile.js`
>   会**静默吃掉**新 CSS / 新逻辑——hook 的样式注入带「同名 style 已存在就跳过」的守卫，新 CSS 根本
>   进不了页面，量到的是旧行为。判据：源 = `res/raw` = **APK 内嵌** 三处 SHA 相同、纯 LF。
>   T84（开工时 APK 内嵌 hook 仍是提交 `5a8d3e5` 的版本）与 T85（陷阱 A）都踩过；
>   T90 两臂一律从隔离树重建后再解包比对。证据：`scratch/t84/report.md` §1、`scratch/t85/report.md` §3.1、
>   `scratch/t90/report.md` §9–§10.2。
> - **页面不能自己 `Page.reload`**（rc.2.7）。DSH 的「当前会话」指针在 localStorage 的
>   `dsh.sessions.current`（值是 `{}`），`Page.reload` 之后会落到 **workspace chooser**，
>   而右栏面板只有「会话 + 工作区」齐了才挂载 ⇒ 面板整个不存在、右栏一条都量不到；chooser 里
>   工作区列表又卡在 `Loading workspaces…`（经网关的查询不返回），**无法从 UI 恢复**。
>   唯一稳定的复位手段是**冷启 App 并重走它自己的「连接」**。证据：`scratch/t85/report.md` §3.1（第三个坑）。
> - **`android\test-*.ps1` 必须用 `pwsh -File` 跑**（rc.2.8）。**Windows PowerShell 5.1 把 UTF-8
>   脚本读成 ANSI** ⇒ 非 ASCII 字面量被破坏、传参变空（脚本会拿 `MainActivity` 当 hook 源）⇒ **假红**。
>   证据：`scratch/t94/report.md` §6.2。
> - **`adb shell input swipe x y x y 700` 在这种 WebView 里一个触摸事件都不投递**（rc.2.8，
>   页面侧计数 `events=[]`）⇒ **长按类验证必须用 CDP `Input.dispatchTouchEvent`**
>   （长按 700ms 实测能弹出设置页）。证据：`scratch/t97/report.md` §11.1。
> - **Java 桥属性是只读的**（rc.2.8）：JS 间谍替换 `DshRemoteApp.*` **静默失败**
>   （`String(window.DshRemoteApp.openSettings)` 仍是 `"[native code]"`）⇒ 间谍会给出「恒 0」的
>   **假绿**；判据只能看**原生 UI**（设置页有没有真的出现 / 有没有跳转）。
>   证据：`scratch/t97/report.md` §4、§11.1、`scratch/t99/report.md` §1。

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
  | `tablet`（`sw ≥ 600`，含折叠屏展开） | **与官方 DSH 桌面版一致的界面**：hook **最小化**（rc.2.8 起契约变更，见下）、不新增任何 DOM 节点/属性/类名/样式 | 同左（官方桌面界面） |

  - **判定源唯一**是原生 `smallestScreenWidthDp`；**JS 不得用视口宽度反推档位**（部分机型 layout viewport 虚高，WEB-02 既有结论）。原生在注入 `mobile.js` **之前**把档位写进 `window.__DSHR_MOBILE__.device`（`phone` / `tablet` / `auto`），hook 只消费该值。
  - **平板档零痕迹**：`<html>` 上无 `data-dshr-*` 属性、无 hook 根类（含 `dshr-official-inset`），页面上无 hook 创建的可见节点（悬浮鲸鱼、drag handle、抽屉遮罩、状态栏挡板）。
  - 🔴 **契约变更（rc.2.8，T97，用户明确授权）**：平板档由「hook **严格 OFF** / 零痕迹」改为
    **「允许最小 hook，但不得新增 DOM 节点 / 属性 / 类名 / 样式」**。触发变更的是平板档
    长按品牌区呼出连接设置页——那个手势只能由页面侧监听，原生接不到。**新判据**：
    常态只有 **1 个 `touchstart` 监听器**（`{passive:true,capture:true}`），DOM 与全局**零新增**
    （同机同态 base 与最终 APK 的 `outerHTML` **逐字节相同**；浏览器侧同页面只换 hook 源码
    全量 DOM 相等）。证据：`scratch/t97/report.md` §1、§6.1–§6.3。
  - **平板档的系统栏让位由原生做**：原生按状态栏 / 导航栏 / 挖孔收缩 WebView 自身 padding，官方布局拿到的是一个「本来就小一号」的视口，**页面本身零改动**（不写 DOM/CSS）。
  - **运行中折叠 ⇄ 展开切换**只改注入配置并调 hook 的幂等切换 API（`window.__dshrSetDevice`），**不重载 WebView、不中断隧道**，界面按新档位即时生效。平板档仍会定义该 API（幂等），只是不安装 hook。
  - 手机横屏的状态栏保持透明沉浸：侧栏灰底 / 主栏白底各自延伸到屏幕顶，控件再避开系统栏，并挡住该区域点击，避免误触。收起态用左上角悬浮鲸鱼打开侧栏。展开后采用 DeepSeek App 式布局：侧栏铺在底层，中间会话列可**跟手拖动**滑成圆角浮层。手机竖屏右侧只留细条。**主屏幕右划**＝打开左侧栏，**主屏幕左划**＝打开官方右侧栏（`<768px` 时官方为全屏态）；官方右栏已打开期间不再误开左侧栏。右划跟随手指，抽屉关闭时只有右划会被接管。左划开右栏是**本插件补的手势**——官方 `0.2.0-rc.2` 自身没有（bundle 内 swipe 零命中），故经官方开关 `button[data-sidebar-right-toggle]` 以 `dispatchNativeClick` 触发。在侧栏里点对应会话（或新建会话）后抽屉自动收起。官方「设置」以**全屏页**盖住侧栏与会话（带进入动画），不再先收起侧栏再弹窗。模型、权限、命令、模式等浮动选框会被钳在视口内。输入底栏里超长模型名会省略号截断，不得盖住左侧「+」和权限按钮。
- **输入联想浮层（`/`、`@` 触发的命令面板）保持官方锚点**：贴在输入卡上沿，不被 hook
  的浮层钳位改写，**不会压状态栏**。此前它会被钳到安全区顶端（`position:fixed; top:8px`），
  整条压在状态栏里——根因是钳位把「输入卡顶边 − 8px」当硬边界，而官方锚点只留 **4px**
  缝，于是每次都被判越界；判越界后的动作又是「搬走」而不是「收窄」。现按官方结构属性
  `[data-trigger-menu]` 放行，坐标换算完全不介入，官方 `position:absolute` 锚点原样保留。
  放行只认这一个属性，模型 / 权限 / 命令 / 模式浮层、「更多操作 → 下载 Session 日志」菜单、
  右栏 dockkit 全屏**仍走**原钳位路径。证据：`scratch/t24/report.md`（含不注入 hook 的对照臂，
  两臂同为 `top=84 / 距输入卡 4px`；修复前的负控制为 3 条断言红、退出码 1）。
- 官方设置在手机上是**全屏页**（从设置入口盖住整屏，置于会话浮层之上），导航仍横向排在上方；选中分区内容全宽展开。侧栏展开时，按住右侧主会话浮层左滑可**跟手**收回会话全屏。导航列表允许横向触摸滚动，并在 `aria-current` 改变后自动把选中分区完整滚入可视区。只统计**当前可见**的模态框，隐藏弹窗残留不会误触发“弹窗打开”状态。
- 会话头部适配：官方 header（含会话面包屑标题）在收起态整体右移 72px，不再被固定在左上角的鲸鱼按钮遮挡；官方「Session log」下载按钮在手机宽度下收成 48dp MD3 图标按钮（24dp 图标，文字用 sr-only 剪裁，读屏仍可读，`aria-label` 同步补齐）。两者都按结构特征定位（`header` 内含 `nav`；按钮内 `span` 文本恰为 `Session log` 且带图标），不依赖 CSS Module 哈希类名。
- 窄屏触控目标按 MD3 规范补齐：消息操作钮（复制/点赞/分支）视觉保持 22px 图标、命中区经透明外扩至 48dp；设置页导航 tab 48dp 触控高度；悬浮鲸鱼 48dp。侧栏抽屉展开时交界处显示 MD3 4×32dp drag handle 指示条（纯视觉，不拦截跟手拖动手势）。
- **左抽屉既有修复（T82/T84，本轮复核确认）**：鲸鱼改读与主列**同一个** `--dshr-drawer-x`（写在与两者的
  共同祖先上）并挂**同一对** `transition: transform 0.34s cubic-bezier(0.32,0.72,0,1)` ⇒
  **全程可见**（真机 138 个采样帧里隐藏帧 **0**）；`|鲸鱼.x − (10 + 主卡.x)|` **最大偏差 0px**；
  **header 全程位移 0px**——改前 `54 → 62` 那 **8px** 下移已消除（删掉两处 margin）。
  - ⚠️ **一处未达成，如实写明（别当回归）**：曾按「把 `setSidebarOpen(true)` 挪到落位阶段、拖动期只靠
    hook 自己的 CSS 点亮侧栏」做过，**实测会让拖动期的侧栏变成「宽 360px、可见文本 0」的图标 rail**
    （官方打开态是 360px / 28 字符），故**已回退**；那一帧（`expanded 0→1` 的 React 提交）的代价**仍在**。
  - 证据：`scratch/t82/report.md` §B.2–§B.4、`scratch/t84/report.md` §2。
- **左抽屉观感：圆角卡片平移（rc.2.7，不做缩放）**。抽屉不再是「硬边卡片直接平移」，而是**圆角卡片平移**：
  新增 token `--dshr-card-r: 20px`（圆角**唯一源**）与 `--dshr-seam`（两张同色圆角卡之间的**缝底**，
  浅色 `rgba(0,0,0,.1)` / 深色档 `.42`）。跟手期 `border-radius` 与**阴影同源跟手**——
  `border-radius: calc(var(--dshr-card-p,0) * var(--dshr-card-r,20px))`，阴影的 offset / blur / α 全部乘同一个量；
  `--dshr-card-p = min(drawerX,20)/20` 与 `--dshr-drawer-x` **同帧写入**（半径、阴影、位移永远同一帧）。
  **20px 的依据是官方同族表面实测**：整宽会话卡（`364×67`）用 **20px**、输入卡（`373×110`）用 **28px**、
  小图标钮 8~12px。抽屉**右缘**用同一 token 加圆角，并用 `clip-path: inset(… round 0 R R 0)` 把
  **可绘制右缘钉在主卡左缘**（抽屉盒顶在 y=0、主卡盒顶在 y=28，不裁的话两张卡的圆弧差 28px 对不上）。
  - **像素判据真值**（真机截图 + 圆弧反解）：主卡圆弧误差 **≤0.36 CSS px**、抽屉右缘 **≤1.05 CSS px**；
    真机 `x → 半径` 逐帧吻合 **0 / 12 / 18 / 20**，即 `r(x) = min(x, 20px)`（x≥20px 后半径饱和、只跟随平移）。
  - **「不做缩放」是产品决定**：全流程没有 `transform: scale`；鲸鱼的 transform 与尺寸**一字未改**
    （仍是 `translateX(var(--dshr-drawer-x))`）。证据：`scratch/t91/report.md` §1–§3。
- 系统栏沉浸（手机档）：App 保持透明状态栏 edge-to-edge，并把真实的状态栏/导航栏 inset（CSS px）写入页面变量 `--dshr-inset-top` / `--dshr-inset-bottom`；页面内容下移让出状态栏，状态栏颜色与页面背景一致（`viewport-fit=cover` 与 `env(safe-area-inset-*)` 仅作兜底）。即使官方 frame 结构探测失败，body 兜底 padding 也保证内容不顶进时钟/挖孔区域。**虚拟键盘**弹出时，原生按焦点输入框位置平移，只抬到输入框露在键盘上方（空会话/设置页元素少时不会把输入框顶出屏幕）；页面侧再用 `interactive-widget=overlays-content` 与 `visualViewport` 把焦点矩形告诉原生。Android 返回键会优先关闭设置弹窗或收起已展开的 DSH 侧栏。
- **系统栏「沉浸」配色：那两条跟着页面走（rc.2.8，T94）**：状态栏 / 导航栏那两条画的其实是
  **`rootLayout` 的底**（T80 把让位落成 WebView 外边距后露出的父容器），而**改前是硬编码**——
  `dark ? 0xFF141414 : WHITE`，`dark` 只能来自**系统主题**（平板档 hook 严格关闭，页面上没有
  任何信号可读）⇒ **页面主题 ≠ 系统主题时那两条与页面反色**（用户症状）。
  - **修法 = 只读探针**：采样「贴着系统栏那条边，页面真实画的颜色」（`elementFromPoint` +
    逐层合成 `background-color`），把同一个值同步到 **rootLayout + 状态栏色 + 导航栏色** 三处；
    **1.5s 只读轮询**跟随主题切换（回前台起、切后台停），页面内用官方设置面板改主题也能跟上。
    **不注入任何 DOM / CSS / 属性 / 类名**。
  - **像素真值（逐字节相等：R=G=B 三通道 0 差）**：平板 4 组（系统浅/深 × 页面浅/深）
    **两条带 == 左栏色**；手机两组**三色相等**。与主列残差 **≤7/255**。
  - ⚠️ **一个颜色无法同时贴合左栏与主列**——取舍是**贴边那列**（用户症状所在），如实写明。
  - **`targetSdk=34` 在 API 35 上的行为**：两个着色 API **仍生效**（决定性实验：让 `rootLayout`
    回到硬编码 `#141414`、导航栏色仍是采样色，底部那条读到的就是采样色 ⇒ 是系统按我们给的
    颜色画的）；**但手势导航下导航栏由系统画成透明、着色不生效** ⇒ **必须自己画**（`rootLayout`）。
  - 未回归真值：T80 内容避让四向重叠仍 **0 / 0 / 0 / 0**；平板档页面侧仍**只读**。
  - 证据：`scratch/t94/report.md` §1.1–§1.3、§2.1–§2.5、§3.2–§3.6、§4.1–§4.3、§8。
- **平板档系统栏避让（`sw ≥ 600` 会话页，rc.2.6 重做）**：让位算式改为**逐方向并集**
  `systemBars() | displayCutout() | tappableElement()`——`getInsets` 对掩码内各来源**逐边取 max**，
  **不求和**（求和会把两个来源的同一块区域算两次）；掩码**不含 `ime()`**，键盘仍然只走上面那条
  「按焦点输入框位置平移」的路，不参与 WebView 自身 padding。
  - API 24–29 走四向 `getSystemWindowInset*`，API 28+ 额外叠加 `DisplayCutout.safeInset*`；
    并修掉「栏已隐藏却仍多垫一段」的遗留问题。
  - **`uiState` 的游标写入收敛到唯一入口 `setUiState(...)`**（全字段只剩「字段初始化 +
    setter」两处写入、**游标写入 0**），赋值当句即重算让位（进 `WEB` 态再补一次 `post` 兜底）
    ⇒ **结构上不可能再漏**。这治的正是 rc.2.1→rc.2.5 那种「三条路径记得补、一条忘了补」的
    **约定失效**模式。
  - **用户那台 Xiaomi Pad 命中的正是旧实现唯一漏调的那条路径**：`uiState→WEB` 共四条里只有
    **FRP / 隧道**那条没补让位重算，而访客 / FRP 模式走的正是它 ⇒ 表现为「进会话后页面没让开、
    顶进状态栏 / 被底部任务栏盖住」。**负控制**把这两行摘掉即**精确复现**：
    冷启动首帧 top 重叠 **48px**、bottom 重叠 **64px**（双向同时错位）。
  - **实测**：横 / 竖屏 × 手势 / 三键 / 任务栏拉出共 5 格，**4 方向重叠量全部 0px**；
    任务栏在**三键**格被 `tappableElement` 独立上报 **112px** ⇒ 掩码里加它是**承重的**，
    不是保险性空转。
  - 证据：`scratch/t72/report.md` §1–§2（算式与实现）、§5（5 格重叠全 0）、§6（断言 106→140）、
    §7.1（负控制）。**rc.2.8 补**：让位只解决「重叠」，「**那两条的颜色**」由 T94 的只读探针同步
    （见上文「系统栏『沉浸』配色：那两条跟着页面走」）；两者互不影响——T94 复跑 T80 的四向
    重叠仍 **0 / 0 / 0 / 0**。
    **未取证项（如实）**：AVD 无挖孔 ⇒ `displayCutout` 分支与「状态栏/导航栏落左右」
    只由 javac 替身覆盖，**未在设备上跑过**；冷启动首帧**未做像素级取证**（进真实会话需建会话，
    本轮禁止），替代证据是时序格 + 负控制 + 6 条源码契约断言。次因（是否即算式）**无法判定**，
    只有强旁证。
- **键盘策略（手机档）**：**只有「用户主动点击输入框」才会聚焦并弹键盘**。切会话、开侧栏等
  **非用户手势的程序化聚焦会被收回**（有防打环上限，见 ②），按用户口径执行。两条机制：① hook 发起侧栏开合前先把当前可编辑元素
  的焦点收掉——此前鲸鱼 `touchend` 上的 `preventDefault()` 吃掉了「点按按钮 → 焦点离开可编辑
  元素」这条默认行为，composer 带着焦点留在原地，Chromium 判定「可编辑元素仍持焦 + 刚发生
  用户手势」于是抬起键盘；② **焦点守卫**：`touchstart`/`pointerdown`/`mousedown` 三个落指事件
  开一个 800ms「用户主动聚焦」窗口，窗口外的 `focusin` 走 `blur()` 收回（**不是无条件**：同一元素 1.2s 内
  最多 2 次，第 3 次放手并计数，防打环；最坏退回改动前行为）。
  守卫只在 hook 生效档位动作，**平板档（零痕迹）与手机横屏一律不介入**。

  > **这是有意偏离官方桌面行为**，请勿在日后当成回归回退。根因取证见 `scratch/t18/keyboard.md`：
  > 「切会话弹键盘」在**平板档关闭 hook、纯官方 UI、纯真实点按**下同样复现（`mInputShown`
  > 929ms，与手机档 hook 生效时的 931ms 同量级）⇒ 属**官方行为**；「开左侧栏弹键盘」才是本 hook
  > 引入的**回归**（同设备同粘滞态下 hook 路径弹、官方 `Collapse sidebar` 与滚动都不弹）。
  > 桌面端没有软键盘问题，故手机档单独改口径。修复落地见 `scratch/t21/report.md`
  > （真实页面 8 条新断言全绿）。**未实测项**：官方「发送后保持焦点」只有推理——
  > 守卫只对**新的** `focusin` 动手，页面只读约束下无法真发消息验证。
- **非可编辑触发器落指时「布防」**（`「+」` 是典型，命令面板 / 消息操作钮同理）：`+` 这类按钮
  不是输入框，却常处在「抬手即自抢焦点」的路径上，直接落进上面的焦点守卫就会被收回——
  但把焦点**主动**交出去时，键盘反而不会抬起。于是做法是：在其落指瞬间
  **标注意图 + 给事件 `preventDefault()` + 元素加 `inputmode=none`**，再由我们**自抢焦点**
  把输入框聚焦起来。焦点是我们主动给的、`preventDefault()` 也已掐掉「抬手抬起键盘」那条
  默认行为 ⇒ **面板照常打开、键盘不弹**；用户**真点输入框**时不受影响，仍正常弹、能打字。
  - **布防窗口已收窄到目标元素**（不是整页开窗）。收窄的原因是被否掉的宽窗口径：宽窗会挡住
    「打开面板后顺手点输入框想打字」这类正常操作——同一会话内已排除该回归
    （`scratch/t48/report.md`）。
  - **快速连点（800ms 内）也已覆盖**，这是此前明确的缺口：旧实现**只看「当前是否还有非输入框焦点」**
    来撤窗，所以「面板已开 + 焦点已收」之后再快点点一次 `+` 会**漏掉撤销**并弹键盘。
    真实设备上量到的点按间隔为 **119–916ms**，`+` 连点 **30 次、弹键盘 0/30**。
  - 证据：`scratch/t48/report.md`（窗口收窄 + 「面板开着点输入框」正控制）、
    `scratch/t51/report.md` §10（119–916ms 分布与撤窗漏掉的根因）、
    `scratch/t52/report.md` §7.1·§11（`0/30 imeTrue`，`inputmode=none` 令官方 `mInputShown=0`）。
  - **未实测项（如实）**：布防只覆盖**已观测到的**触发器，**没有逐个按钮穷举**；且上述数据
    来自 **AVD 模拟器**——模拟器本身没有软键盘，`imeShown` 取自**真实页面**的上报值，
    **不是真机软键盘实测**。真机上的最终手感仍待真机复核。
- **右栏手势（手机档）**：左滑打开官方右栏后，**从面板左缘一条带内右滑可关闭**。
  关闭路径判得很严——**带外起手一律不接管**；「区域门 / 方向门 / 中点右滑」这些
  **没有实际位移**的起手仍然 **no-op**，不会误关面板（`scratch/t47/harness.mjs` 44/44）。
  - **rc.2.6 调优**（两处都动了）：带宽 `clamp(round(视口宽×0.11), 24, 48)` →
    **`clamp(round(宽×0.15), 48, 96)`**（540px 视口 48→**81px**）；**起手窗整体右移 24px**
    让开**系统返回手势区**（Android 手势导航占最外约 24dp，**JS 抢不过、也挡不住**——它在系统输入
    管线里、早于 WebView 消费手势；实测返回桥命中的最大起点正是 24 CSS px）。
  - **实测收益**（216 格起点/距离/时长/纵向矩阵 + 抓 toggle 点击栈判「谁关的」）：
    用户体感「能关掉」**62.5% → 87.5%**；**hook 自己兑现**（三键导航 / 无手势设备 / 平板全靠这条）
    **25% → 50%**；彻底没反应 37.5% → 12.5%。面板中部右滑仍 **no-op**，方向/距离/纵向三道门未放宽。
  - **别再调那三个参数**：门限是**起点 x 的纯阶跃**——距离 150/250/400px、时长 200/350/500ms、
    纵向 25%/50%/75% 三档关闭率**完全一致**（恒 62.5%）。「滑远点 / 放慢点 / 往上滑」这条路已被数据排除。
  - **系统返回键只关面板、不退后台。**
  - ⚠️ **两条如实说明**：① **调优后的 216 格整矩阵没跑成**（基线那一份是完整的）——跑完基线并做
    两版归因后，共用网关上的**工作区上下文**对本实例不再可用（官方右栏面板不再挂载），**没有**
    去动配置。故收益数字来自**两个构建、同一台设备、同一会话**上的 8 个 x 档逐格归因表；
    这不影响结论，因为基线已证明结果与距离/时长/纵向无关，整网格的信息量≈那 8 档。
    ② **「系统返回手势抢走」这一维在本环境测不了**——`adb shell input swipe` 注入的事件**不经过
    系统手势导航监视器**（从物理 x=2 起手右滑 250px，系统返回一次都没触发）。`inset=24` 的依据是
    **结构性事实 + 归因表**（返回桥命中的最大起点 = 24 CSS px、hook 接管的最小起点 = 32 CSS px
    ⇒ 实测右边界落在 **24~32** 之间），**不是**直接测出来的。
  证据：`scratch/t47/report.md` §3·§4（原始判据）、`scratch/t66/report.md` §2.2、§3.1、§4.1–§4.2、
  §5.2–§5.3、§10.1–§10.2。
- **右栏两条方向不同的动画（rc.2.7，术语先分清）**：**打开 = `width` 过渡（不是跟手）**，
  **关闭 = `transform` 跟手**（= 上一条那条手势）。
  - **打开方向**：官方承载容器（`…rightbarCol`）在**关闭态与打开态都是 `width: 0`**，给它加任何
    `translateX` 都没有像素可动（实测「位移变化帧数 = 1」，与改前的 0 帧在观感上无从区分）
    ⇒ hook 自建**裁剪窗**：容器 `width` = 窗宽、`overflow: clip`（**不能用 `hidden`**，那会把容器变成
    滚动容器）、面板**重锚到容器左缘** + `translateX(-100vw)`，窗宽 `0 → 100vw` 走 `transition: width`
    （这确实是**布局动画**，但官方这边本来就没有可复用的合成器路径）。实测**16 个中间态窗宽 / 283.3ms**
    （改前 **1 帧**到位；CSS 声明 300ms）、帧间隔 p95 **16.8ms**、`>50ms` 长任务 **0 个**。
    **官方状态机逐字未动**（兑现时机、`dispatchNativeClick` 通道、遮罩/鲸鱼/composer 的可点性与
    `data-sidebar-right-open`/`aria-hidden` 翻转全部照旧）；**官方那颗折叠按钮的点击路径保持瞬时展开**
    ——本轮只做手势路径，不把没验过的交互面拖进动画。
  - **关闭方向**：**跟手 0px 对齐**（手指 120px → hook 写出 `--dshr-rightbar-x` = 120px → 面板实际位移
    偏差 **0px**，59 次比对；T91 复跑 42 次比对同为 0px），松手后走**合成线程 CSS transition 补间**
    （T91 真机：**21 个不同位移位置 / 333ms**；T84 真机另一跑：19 帧 / 18 个不同位移 / 300ms）。
    两条不变量真值成立：**面板中部右滑 no-op**、**打开态左滑 no-op**（判据一字未放宽）。
  - 证据：`scratch/t85/report.md` §1–§3（打开：裁剪窗、中间态/时长/帧间隔）、§4–§5（关闭与两条不变量）；
    `scratch/t82/report.md` §A.2–§A.4、`scratch/t84/report.md` §1.4、`scratch/t91/report.md` §4–§5。
- **发送键不再被布防**（rc.2.6）：发送键已从布防触发器名单**移除**，并新增独立的「发送」识别在
  判定**第一件事优先排除**——覆盖 `aria-label` 中英文 6 种写法，外加「在 composer 卡片内」的
  `button[type=submit]` 兜底。另加一条早退：**composer 已持焦时布防直接返回**（焦点没变 ⇒ 官方再抢
  也是空操作 ⇒ 不会多弹键盘）。
  - **为什么必须两路同改**：只从名单里删一行修不好。兜底分支（任何 `button` / `[role=button]` 的
    **后代**，含内部 `svg` / `path`，只要在 composer 卡片内就命中）实测会让 **40 个元素**被判成触发器。
  - **修的机理**（两条，实测同源）：① 在**一次触摸序列进行到一半**时把 DOM 焦点从别处搬回 composer，
    正是 WebView 可能不再为原目标合成 `click` 的条件；② 500ms 后摘掉 `inputmode=none`，
    此时 composer 仍持焦 ⇒ 浏览器**重新向 IME 请求**弹键盘（对应「点完键盘又弹出来」）。
  - **对「`+`」是恒等变换**：「`+`」不匹配任何发送判据，判定与改前完全一致；实测点「`+`」时布防
    仍 **5/5** 照跑，「面板照开、键盘不弹」的既有结论**不受影响**。
  > **如实标注：用户在 AVD 上报的「消息发不出去」本轮未能复现**（键盘弹着 / 收起各 1/1 都发得出去，
  > 源码复核找不到能解释「发了但发不出去」的路径）。因此本条只声称「**移除了发送路径上的抢焦点这个
  > 病因**」（机理与症状吻合、且可测），**不声称症状已消失**。
  > 证据：`scratch/t69/report.md` §1.4、§2.2–§2.3、§3.1–§3.2、§4.3。
- 适配脚本只依赖官方 DOM 的稳定结构特征（`data-shell-overlay`、`data-sidebar-collapsed`、`aria-label`、`role="dialog"` 等），不依赖 CSS Module 哈希类名，也不往 React 管理的容器里插入节点。
- **连接过程的状态文案按阶段实时推进**，不再停在同一句过期文案上：正在检测隧道状态… → 隧道已在运行，正在打开会话… → 正在启动隧道（端口 N）… → 正在建立隧道（frpc 打洞·建联）… → **正在等待隧道就绪…（9s / 最多 20s）**（每秒刷新）→ 隧道已就绪，正在打开 DSH… → 正在打开 DSH 页面…（验证网关与设备授权）→ 隧道运行中 → 失败时给出「隧道未就绪：检查电脑网关、密钥和 frps 网络」。连接中原生设置页是隐藏的，屏幕上只有 WebView 里的本地壳页，因此文案**同时**写到原生标签与壳页正文。
  就绪轮询同步提速：首探 600ms→**200ms**，间隔 100→200→400ms 退避，frpc 输出命中就绪关键字时**提前唤醒**一次探测。**「端口可连」始终是唯一判据**——日志文案会随 frp 版本漂移，绝不放行任何连接。**20s 硬顶与打洞 `fallbackTimeoutMs = 5000` 一个字没动**，最坏等待时间与改前完全一致。
  > 诚实标注：**就绪等待段的端上收益未实测**——arm64 `libfrpc.so` 在 x86_64 模拟器 SIGSEGV，本机建不起隧道。上面的 0.3~1.0s 是由单测钉死的计算值（最坏省 400ms、平均省 200ms、再省掉等下一个 tick 的最多 400ms，该段本身 3~20s），**不是实测**。真正解决「卡住」体感的是**状态文案**，不是这 0.3~1.0s。证据：`scratch/t23/report.md` §4。
- **连接失败现在给的是 App 自己的失败壳**（「无法打开 DSH」+「重新连接」+「返回服务器列表」），不再是 Chromium 原始错误页：① 主框架错误**结构性绕过**抑制标志上报，窗口由 1200ms 收紧到 400ms——窗口长度不再参与决定用户看到什么；② 主框架失败后的错误页**不再被当成会话页**（`uiState` 停在 `CONNECTING`、不 `clearHistory()`），所以后续失败**不会被降级成 Toast**，「重新连接」入口不再消失。实测：点「重新连接」后仍是同一个失败壳（截图与首次失败**字节相同**），再连回可用节点即恢复。证据：`scratch/t22/report.md` §2。
- **移动适配自检改判「效果」并可自愈**：自检不再只查「hook 装上了没有」这个在 IIFE 顶部就置位的标志（那分不清「装上了」与「装上了但没生效」），改为回读**根类 + 鲸鱼可见 + 收敛**；未达效果则打日志 → 同步修复 → 2s 后重试，**最多 3 轮**后收手（绝不无限补注）。实测把页面打成半吊子态后，检测到修回只隔 **66ms**，健康页面上自检完全静默（状态栏不会误退成实色）。平板档**整体早退、一个字节都不写**（零痕迹）。自愈边界如实记录：只有 hook 幂等重建能覆盖的破坏（拆根类、删鲸鱼节点）才自愈。
  - **T27 补：自检在 reload / 会话内导航 / 回前台也会重排**。此前 `enterSessionPage` 在「已在会话内」时提前 return，自检只排首连那一次 ⇒ **页面一重载就再也无人补注**（实测重载后人为破坏效果，26.7s 未修复、自检日志 0 条）。现在这三条路径都会重排一次。
  - **有界，绝不永动机**：3s 最小间隔（折叠一次导航的 `onPageCommitVisible` / `doUpdateVisitedHistory` / `onPageFinished` 三个回调）+ 60s 窗口内最多 4 次（重定向风暴下最多 4 次/分钟）；一轮新的连接尝试（`openGateway`，含「重新连接」）会把预算归零。平板档在排自检之前就返回（连定时器都不排，零痕迹）。
  证据：`scratch/t22/report.md` §1（含 12 项 AVD 验证矩阵 V1–V12）。
- 连接失败、隧道超时或 PC 端 DSH Web 不可达时，远端页面会换成本地失败页，可点「重新连接」；改连接配置请长按鲸鱼（平板档见下节）。已在跑的隧道不会因返回键或误报断线被拆掉，再点「连接」会复用本机隧道端口（首选 18443，被占用时自动在 16225~16235 协商），不必清后台。
- **重连判据与自愈（rc.2.7，本批次最重要的一条）**：页面侧**没有任何现成只读连接态**——把 window 上
  与 DSH 相关的 **17 个全局**在「健康 / 真断线 / 恢复」**三拍**逐一快照差分，唯一变化的是**我们自装的观测器**
  （`__DSH_CONNECTION_RECOVERY__` 实测只是**参数**：`{backoffBaseMs:500, backoffFactor:2, backoffMaxMs:10000, …}`，
  不是状态）⇒ hook 包装 `window.WebSocket` 自己观测连接态。
  - **包装是完整透传的**：真机上确实抓到了 App 那条 socket（URL 逐字 `wss://…/api/remote.mux`）；
    **9 条透传断言**全绿（prototype / 静态量 / 自有属性 / `name`·`length` / 不带 `new` 抛**逐字相同**的
    TypeError / `class extends` 子类化 / `instanceof` / 多 socket）。**平板档完整还原**（认领符号 0、
    观测器消失），切回手机档全部装回 ⇒ 与「平板档零痕迹」契约并存。
  - **判据两层，且与原生逐字同源**：**层 1** = `[data-phase]` **恰等于** `connecting`
    + `aria-label` 排除清单否决 + 有布局盒（`getClientRects().length > 0`）
    + **去掉 `aria-hidden` 子树后的文案**锚定 + **composer 祖先否决**；**层 2** = 原有「非按钮文案」路径
    （保留，并把 `isInteractiveNode()` **收紧**到与原生 `inter()` 逐条对齐）。
    官方那条本身是 `<button>`，走「排除可交互控件」就永远认不出来，所以**层 1 是定向例外、不是整体放宽**。
    另外 `scripts/test-mobile-chrome.mjs` 的源码契约**同时读 `mobile-web.js` 与 `ReconnectBanner.java`、
    把双方字面量抽出来做相等比较** ⇒ 任一侧被单独改动就红（不是靠人记）。
  - 🔴 **官方那条只在左栏展开时渲染**（官方源码逐字：`state: wide && …`，而 `wide = !collapsed`）
    ⇒ **左栏收起（用户平时）时页面上没有任何可读的重连文案**。这既是「只有拉开左侧栏才看得到重连提示」
    的根因，也是本任务必须自建 WebSocket 信号的原因（rail 态官方文案实测 **0 帧**）。
  - **原生横幅**：数据源 = hook 上报的连接态 **OR** DOM 探针（平板档 hook OFF ⇒ 只剩纯 DOM 探针）；
    抑制判据用「**横幅将要占据的带区**」而**不是横幅当前 rect**（`GONE` 时 rect 恒 `0×0` ⇒ 恒判重叠
    ⇒ 恒抑制 ⇒ 首次显示不出来，即自锁）。实测 rail 态横幅在 **`t_kill+1495ms`** 出现
    （`[0,121][1080,213]`、`clickable/focusable` 均 false、不抢焦点），恢复后消失；
    **不吞触摸**——在横幅与官方按钮的交叠区中心点按，页面仍回传 `official-click`。
  - **自愈真值（rail，真断线）**：hook 侧 nudge **6 次**（间隔 **8.0–9.0s**，到顶 `cap-reached` 并自卸巡检，
    改前臂是**死代码**、`nudges=0`）；「**服务端已回来 → 页面发起第一次重连**」由 **5496ms 压到 681ms（8.1×）**；
    健康态**零开销**（断线前 8 拍 `nudges=0 / tick=false`）。
  - ⚠️ **口径纠正：别再引用「永久停泊」这条**。此前记的机制是「上游退避梯子跑完 6 次后
    `isFinalBackoffTier` ⇒ 永久停泊、不再自动重连」，但**本机实际运行时**——npm `@deepseek-ai/dsh@0.2.0-rc.2`
    下发给浏览器的 bundle（389620B）与桌面 `app.asar`（121348951B）**全量字节扫描**——`isFinalBackoffTier`
    **命中 0 次**，`attempt` **无上限**、退避 `backoffCap(attempt)=min(backoffMaxMs, 500×2^(attempt-1))`，
    **单跳上限 10s**（`[cap/2, cap)` 即 5–10s 随机）。⇒ **不存在「退避跑完就永久停泊、不再自动重连」**；
    用户观感里的「30 秒」是**多次退避 + 服务端尚未恢复**的累积，不是某一档停泊。hook 的价值是把
    「**服务端已经回来、页面还在睡退避**」这段等待压到 **<1s**。判据边界另见「已知取舍」。
  - 证据：`scratch/t86/report.md` §4–§5、`scratch/t88/report.md` §A–§C、`scratch/t90/report.md` §1–§6·§12、
    `scratch/t87/report.md` §1·§6.4（停泊证否的字节扫描原文）。
- **半开检测与回前台探活（rc.2.8，T95）**：症状「切后台几分钟回来，界面停在**重新连接中**、
  几分钟不恢复」。**第一因不在我们这层**——上游 mux 载体
  （`dsh-api-gateway/lib/client.js`，全文件**唯一建连点** `new WebSocket()`）**没有握手超时**：
  `maintain()` 首个 `return` 就把那次挂死的握手持有了，`failAll()` 只在 `close` / `error` 才调
  ⇒ 握手挂死时 `open` / `error` / `close` **一个都不来**，客户端**永远停在 connecting**；
  hook 的 nudge 作用在上层 generation，**够不到它**。
  - **修法（只改 hook，未改 Java）**：回前台（后台 **≥20s**）**主动探活** = 同源绕缓存
    `GET /__dsh_remote__/health?__dshr_probe=<ts>`（探**隧道 / 传输链路**，不是上游会话）
    + `AbortController` **3s 硬超时** ⇒ 判「断」、结论并入 `isConnectionDown()`、
    `reportUiDiag()` 喂原生自救层、**立刻推**一次；回前台 5s 窗口可**跳过 8s 最小间隔**，
    另加 **1.5s 硬地板** `RESUME_HARD_MIN_GAP_MS`（任何两次推之间不得短于它）。
  - **真值**：半开场景改前「判据说健康 / 0 推 / 无横幅」→ 改后「探活超时 ⇒ 横幅 + nudge」；
    **回前台首次推 6763ms → 1307ms（5.2×）**（同装置同断言）；健康态探活 **0/0/1 次**
    （A1/A2/A3，20s 闸拦住短后台），**观测块仍零 `setInterval`**。
  - **三条实测硬约束**：① **断链上重载会把页面一次性打死**（`ERR_TIMED_OUT` + 错误页，
    链路恢复后**仍不恢复**）⇒ 重载必须**原生做且先探活**；② **健康链路上重载能回到同一会话
    （3s）**——此前「重载会掉到 chooser」被**证伪**，那是「重载时链路已断」的现象；
    ③ **健康会话本来就完全静默**（75s **零帧**）⇒ **不能用「静默」当半开判据**。
  - 平板档：探活只在「回前台 + 后台 ≥20s」触发，平板档 hook 不跑 ⇒ **一个字节都不跑**。
  - 证据：`scratch/t95/report.md` §1.4–§1.5、§1.8、§2、§3.2–§3.5、§7。
- **卡住自救 `StuckRescue`（rc.2.8，T96，原生 Java）**：症状「切后台几分钟回来卡住几分钟不恢复；
  杀掉重开十几秒就好」。**第一因**：平板档 hook 的 **WS 观测没装**，只读 DOM 探针可用但
  **没人消费**（`probeResumeRecovery` 只有三个入口，平板档缺 WS 那个；1s 巡检要等首次判「断」
  才装 ⇒ 平板档永远等不到），且实测**温和层在平板档本来就无效**（派发 `offline`→`online` 后
  40s 仍 `phase=[connecting]`），**只有受控重载有效**。
  - **状态机**（纯逻辑，可 JVM 验证）：**温和层** `evaluateJavascript` 派发
    `offline`→`online` 瞬态对，0s / +8s 各一次（`TIER1_AFTER_MS=1500`、间隔 `8000ms`、上限 **2 次**）
    → **+12s 升级层**受控重载；**手机档让位**（hook 自己会做，阈值抬到 **25s**）；
    防风暴：重载 **2 次 × 60s**，到顶后**只剩观测**（`StuckRescueTest` 用 200 拍 / 10 分钟钉死）。
  - 🔴 **链路闸（这是被真机打出来的）**：**升级前先用 `PinnedFetch` 取 `/__dsh_remote__/health`，
    不通就撤回**——v1（无链路闸）实测 `+12.2s` 重载把页面打成 `chrome-error` 错误页。
  - **真值**：**平板后台 5 分钟回前台 → 恢复 ≈13.6s**（重载提交 → 恢复 0.8s，会话保持：
    `sameSession=true`、`sessionId` 前后同一）；**改前同场景 ≥100s 仍卡**。健康态**零开销**
    （不新增定时器 / 回调，只挂在既有 500ms 探针之后，健康时一次比较即返回 `NONE`）。
  - **横幅不再滞留**：一直挂着**不是探针去抖失配**，而是「页面真的还卡着」的忠实反映
    （探针持续匹配 ⇒ 永远凑不满 3 拍 OK）。治法 = 治掉卡住 + **升级动作时立即收起** +
    **新文档提交清零**。
  - 证据：`scratch/t96/report.md` §1.1–§1.3、§3.1–§3.4、§4.1–§4.4、§5、§7。
- **手机档**下连接设置（配置组卡片页）可由**长按小鲸鱼**进入，也可在**会话根按系统返回键**进入
  （**rc.2.6 起两档一致**，此前手机档会话根是直接退到后台）。会话内先关官方弹层/侧栏再回上一页；
  **右栏打开态按返回键只关面板**，不多走一步到设置页。到会话根则回 App 连接设置页，
  **不会**退到桌面，也**不会**拆掉 frpc；若会话仍在，设置页顶部有「返回当前会话」，
  系统返回键同样回到已连接会话。点「连接」若隧道仍在，会直接恢复已注入移动适配的会话，
  不会重载成官方 DeepSeek Harness 桌面栏。
- 连接设置为卡片式布局（安全隧道 / 直连入口或局域网 / 连接维护三张卡片，圆角 + 浅灰页面底），并让出状态栏/导航栏 inset。「隧道形态」选择器提供 xtcp（P2P 打洞，推荐）与 stcp（加密中转）两项，文案与电脑端插件面板一致；entry（公网入口）形态是电脑端服务侧配置，手机上用「直连入口或局域网」即可，无需访客隧道。手动填写时按电脑端面板逐项对照：VPS 地址、控制端口、隧道形态、隧道名（默认 `dsh-remote`）、访客密钥、frps 登录密钥。
- **连接设置页有一行只读诊断行**（「页面适配诊断：档位 phone · 钩子 是 · 根类 dshr-mobile ·
  收敛 是 · 鲸鱼 是 · 三栏 是 · 严格关闭 否」，未连上会话时显示「未上报」），由页面经 JS 桥
  回报给原生。用途是在**真机上判断 hook 到底有没有生效**，不必再靠无障碍树反推。纯文本
  12sp、无点击、**不新增任何控件**；回调在 WebView 的 JS 线程，只做「解析 → 存 volatile 字段
  → UI 线程纯赋值」，解析失败静默 return；日志按摘要去重，繁忙页面上也不刷屏。
  已实测七个字段与 CDP `window.__dshrMobileDiag()` 逐个相等。证据：`scratch/t22/report.md` §4。
  - **rc.2.6 追加了三段**（原 7 个字段**不变**、`formatUiDiag()` 载荷契约**未动**——它被 `test:device`
    全等钉死，故新数据一律**独立成段**而不是揉进载荷）。仍是**纯文本、无点击、不新增控件**。
    真机 `uiautomator dump` 原文（fresh 进程故计数为 0）：

    ```
    页面适配诊断：未上报（连上会话后由页面回报） / 文件选择：未选择过 / 并发峰值 0/3 · 排队 0 · 闸门/上限拒绝 0 · 本次累计 0B
    ```

    另两段（`落盘缓存` / `未拦`）来自首屏落盘，屏上真实值例如：
    `落盘缓存 拦 8 · 命中 7 · 取回 0 · 淘汰 0 · 落盘失败 0 · 命中/取回字节 12.36MB/0B` /
    `未拦 主文档 2 · /api 0 · 非白名单 1 · 非GET 26 · 非本网关 1`。
    **这是远程场景下拿不到 logcat 时，用户自证缓存行为的唯一途径。**
  - 证据：`scratch/t60/report.md` §1.4、§8（诊断行取证方式）；`scratch/t65/report.md` §2.1、§6.2。

## T109 原生侧收口（去横幅 / wss 冷握手 / SSE 不接管 / 陈旧上界）

本批在原生产生的四条变更，**都在 `MainActivity.java` / `ReconnectBanner.java` / `res/values/ids.xml` 内**，
不碰 hook（`mobile.js` 与 `mobile-web.js` 由另一批改）。逐条的「为什么」与设备真值见
`scratch/t109/report.md`；这里只留工程结论。

1. **去重连横幅的显示层**（用户口径：「把重连横幅去了吧，这样可以少一半的耗电」）。
   - 删：`ReconnectBanner.Bar`、`TEXT`、`FADE_MS`、`isOnScreen`、`bandHeightPx`、
     `BAND_FALLBACK_DP`、`shouldSuppress`、`R.id.dshrReconnectBanner`、
     `installReconnectBanner()`、`applyReconnectBannerInsets()`、根布局里那条第二条 View、
     以及 `handleReconnectProbe` 里的 `show()/hide()` 与抑制几何。
   - 留（**一个字都没省**）：`ReconnectBanner.PROBE_JS` 与它的全部字面量、`Debouncer`、
     T108 的合并探针与自适应节拍、`runStuckRescue` 的接线。防抖器仍决定「确认仍在断开态时
     保持 500ms 快档」；探针照旧 `webView.evaluateJavascript(ReconnectBanner.PROBE_JS, this::handleReconnectProbe)`。
   - 状态改由设置页只读诊断行体现：新增一段 `重连探针：hook=… · 上次断线 … · 拍数 … · 最近 … · 节拍 …ms`，
     与既有几段同一块只读文本、**不新增任何可点控件**。
   - 回归钉在哪：`android/test-reconnect-banner.ps1` 的 `ReconnectBannerTest` 里加了「显示层不许回来」
     的**反射断言**（`Bar`/`TEXT`/`FADE_MS`/`isOnScreen`/`bandHeightPx`/`BAND_FALLBACK_DP`/`shouldSuppress`
     逐个查存在性，谁偷偷加回来立刻红）＋「采样链不许断」的正向断言。
2. **`wss://` 视同 `https://`**（发布阻塞 P0-3）。`isActiveGatewayUri()` 的协议族扩到
   `{http, https, ws, wss}` 并要求**两端安全级别一致**；主机/端口判定一个字没放松。
   `effectivePort()` 把 wss 折叠到 443。`handleSslError()` 的**每一支都打日志**（含放行支的 `scheme=`）：
   改前「非网关 URI ⇒ cancel」是纯静默的，真机上「连不上且毫无线索」正是它。
3. **SSE / 流式端点不接管**。白名单从 `startsWith("/plugins/")` 收成「`/assets/` 目录段 +
   **精确** `/plugins`」（与 `pwa.ts` 的 `/^\/plugins\/?$/` 同语义），并**显式排除流式端点**
   （路径 `/plugins/events` 或请求头 `Accept: text/event-stream`，任一命中即放行）。
   `interceptStaticAsset` 里新增放行计数 `passthroughStream`，进诊断行的「未拦 … SSE n」。
4. **hook 连接态的陈旧上界**（T106 静态审计 S1）。`hookConnStateAt` + `HOOK_CONN_STATE_MAX_AGE_MS = 20000`，
   读法统一走 `freshHookConnState()`；`hookSelfHealLive()` 刻意**不**用新鲜度（那问的是「桥装没装过」，
   是历史事实）。20s 的账：> T108 的 8s 快档窗口与 5s 兜底周期，且等于 20 次 hook 断开态重推
   （`RESUME_DOWN_TICK_MS = 1000`）都没到。

> ⚠️ **P1-1「设置页触摸穿透」的复核结论（与工单前提不同，如实写明）**：用**真 adb 触摸**
> （`input swipe` 0 距离长按 + `input tap`）在**改前与改后两个 APK 上各测一遍**，
> 点「背后鲸鱼位置」时抽屉 `data-dshr-expanded` **两次都保持 0，没有穿透**。
> V1 那条 `scratch/v1/whale-tap-after.json`（expanded 0→1）由 **CDP `Input.dispatchTouchEvent`** 产生，
> 而 CDP 事件直接进渲染器、**绕过 Android 的 View 分发**——本批用同一手法在**改后**的包上复现出
> 完全一样的 `0 → 1`（`scratch/t109/p11-cdp-control.json`）⇒ 那条证据测的是工具，不是应用。
> 机制上也对得上：`showConnectionSettings()` / `showEditor()` 都把 `webView` 设成 `View.GONE`，
> 设置页期间**下层根本没有可接收触摸的兄弟 View**。
> 本批仍按方向做了加固（`insetScroll()` 里 `scroll.setClickable(true)`，一行 + 注释），
> 它是**正确性加固**（让覆盖层自给自足，将来若有「覆盖层与可见 WebView 共存」的布局就靠它挡住），
> **不是**「复现→修复」的闭环；未达成的部分写在 `scratch/t109/report.md` 的未决里。

## rc.2.9 原生侧收口（打洞回落 800ms + 粘性中转 / 接管通道带凭据 / 系统栏原生透明 + 页面让位）

逐条的「为什么」与设备真值见 `scratch/t113/report.md`、`scratch/t114/report.md`、`scratch/t115/report.md`；
这里只留工程结论。

1. **打洞回落超时 5000 → 800 ms + 连续 2 次失败粘住中转**（T113，本批用户可感知最大的一项）。
   - `VisitorConfig.java:82` `FALLBACK_TIMEOUT_MS = 800`（`:159` 写进 toml）；网关侧
     `frp.ts:306` **同值**（`scratch/t104/cross-end.mjs` 逐行对齐，两端生成的 toml 不许漂移）。
     **同一个 toml 键只改数值**，T104 的「打洞优先 / 只用中转」二选一语义与写法一字未新。
   - `TunnelPath.java:56` `HOLE_FAIL_STREAK_TO_STICK = 2`：连续 2 次打洞超时后，**下一次 frpc 启动**
     直接用「只用中转」toml。**打洞成功立刻解除**；**换网络 / 换配置组 / 换档位**与**进程退出**清零；
     **「停隧道」不清零**。
   - **绝不主动重启 frpc**（会掐断在途连接 ⇒ 用户看到断线闪烁）：粘性只在「反正要重启」的时刻
     （新隧道启动 / frpc 崩溃自重启）生效；`TunnelService.watchTunnelEnvironment()` 每 3 s 巡检网络变化。
   - 诊断行（设备 UI dump 原文）：`打洞策略（配置）：打洞优先（先试 P2P，0.8 秒打不通自动回退中转）· 电脑端形态 xtcp` /
     `本次隧道：打洞优先 · 已粘性回落中转（连续 2 次打洞超时后不再等；换网络或重开 App 自动重试打洞）`。
   - 真值：稳态「点连接→可交互」**13,573/14,206 ms → 5,562/5,399/6,396/5,094 ms**；
     空等 **10.30–10.38 s → 1.88–2.06 s**（均值 1.97，有 3 次 ≥2 s，如实）；
     粘性生效后 **2,398/2,750/2,903 ms**、空等 **0**；冷启动 28,507/29,258 → **8,108/7,811 ms**。
2. **接管通道带上设备凭据**（T114，真机「频繁重连 / 白屏」的主因）。
   - `PinnedFetch.java`：`cookieFor()` 走 `CookieManager.getCookie(url)`（设备令牌是 HttpOnly，
     `document.cookie` 看不到，CookieManager 拿得到）；`isSameOriginUrl()` 要求 `https` + host 全等 +
     有效端口（缺省折叠 443），**只对同源附带**，并在**凭据唯一出口再判一遍**。
   - **无凭据 ⇒ 失败关闭**（`return null`，连接都不建）；**401 ⇒ 单独分支 + `return null`**
     ⇒ 调用点拿不到结果 ⇒ `StaticDiskCache.put` **不可达** ⇒ 401 不污染落盘缓存。
   - **唯一 fail-open**：网关侧免认证的 `GET /__dsh_remote__/health`，且**不带任何凭据**。
   - 真值：401 **12–16 次/次进入 → 0**；`#root kids=0 → 1`（正文 909 字）；
     稳定链路 **655.2 s：0 401 / 0 `connection lost` / 0 横幅 / 0 handshake failed**；
     安全负例 **16/16**（跨 host / 跨端口 ⇒ 服务端收到 `Cookie: null`）。
3. **系统栏改走原生透明 + 页面自己让位**（T115，见下节「平板档让位」）。
4. **原生不再涂导航栏色**：`configureSystemBars()` 与 `applySystemBars()` 在两个 API 段都写
   `Color.TRANSPARENT`（改前是 `shellColor(R.color.shell_background)`，API 30–34 上会真的涂上去）；
   对比度强制仍关；`setSystemBarsAppearance` 的图标明暗逻辑原样保留。
5. **页面让位写入口收敛**：新增唯一页面写入口 `writeInsetsToPage`，`applyInsetsToPage` 增左右两向
   且**与让位同源**（同一个 `readSystemBarInsetsPx()` 口径，否则两个写点会打架——实测抓到过
   24px/36px 竞态）。`applyDeviceClassInsets` 改为**布局盒恒 0 + 四向写页面**。

> ⚠️ **T115 披露的一处写域外改动**：路线「布局盒恒 0 + 四向写页面」与
> `scripts/test-device-class.mjs` 里 T72/T79/T80 的旧契约（「让位只落 WebView 布局盒」）**直接对立**。
> 处理方式 = 按「谁移动了被钉代码，谁负责更新断言」的口径**同批改写该块**，
> **断言总数仍 158**、四向取值仍被逐格钉死（变异 M1 反证：改回布局盒 ⇒ 通过数 158→145）。
> 这条**不在 T115 的写域白名单里**，已在其实报告 §0.3 明确披露。

## 平板档让位：从「原生外边距」改为「页面 CSS padding」（rc.2.9，T115）

- **改前**：平板档让位靠**原生**给 WebView 加外边距（`lp.setMargins`）⇒ 两条系统栏露出的是
  **`rootLayout` 的底**（一个原生单色）。而平板官方面板贴边那一行**本来就是两色**
  （左栏 `--dsw-specific-sidebar-fill` / 会话面板 `--dsw-alias-bg-base`）
  ⇒ **单色带必然在面板那一侧留一道缝**（改前上带 **1919/2560** 像素与贴边行不同、ΔRGB=(6,5,4)；下带 **1925/2560**）。
- **改后**：WebView **外边距置 0**（覆盖全窗），四向 inset 交给**页面 CSS**
  （`--dshr-inset-top/right/bottom/left`）。**「带 = 页面自己画的像素」成为构造性事实**，不存在第二个色源。

| 判据 | 改前 | 改后 |
|---|---|---|
| 四向遮挡（`WebView` 屏上框） | `[0,72][2560,1536]` ⇒ **0/72/0/64** | `[0,0][2560,1600]` ⇒ **0/0/0/0** |
| 页面视口 | `1280×732`（比整屏少 68 CSS px） | **`1280×800`**（= 2560×1600 ÷ dpr 2） |
| 页面 `--dshr-inset-*` | 四个全空 | **top 36px / bottom 32px / left 0 / right 0** |
| 两条带 vs 页面（跨旧带边逐像素） | 上 1919/2560、下 1925/2560 不同 | **ΔRGB = 0（四个主题组合全 0）** |
| 带内页面内容墨迹 | — | **0 行**（内容顶边 `top=36` CSS px） |
| **手机档** | 四向 0/0/0/0；`--dshr-inset-top: 46px` / `bottom: 24px` | **逐字不变**（手机档 CSS 未改一行） |

- **hook 侧**（平板作用域）：`__dshRemoteInsets.set` 收下左右两向，且**不再被「严格 OFF」早退挡在 inset 写入之前**；
  新增一组平板作用域 CSS（三列 `box-sizing:border-box` + 四向 `padding: var(--dshr-inset-*, env(...))`，
  会话面板列/右侧栏列补官方底色 token）。**契约在这批明确为「允许最小 hook + 允许新增 CSS 规则」**。
- **app 自己的可对账日志（新格式，含「谁在让位」）**：
  `I dshr-inset: avoid(px) l=0 t=72 r=0 b=64 page(css) l=0 t=36 r=0 b=32 box=0,0,0,0 tablet=true uiState=WEB`
- ⚠️ **未取证的形态（如实）**：**左右挖孔 / 三键栏**只有**源级证据**——测试 AVD 的
  `displayCutout` **恒 0**，左右两向只做到「原生写入 + 页面消费 + 源级断言」三级，**未在设备上跑过**；
  **平板右侧栏打开态（三列）未做像素取证**（右栏列已按同一 token 处理）。
- ⚠️ **API 30–34 未取真机真值**：本机是 Android 15，`dumpsys` 已不再暴露 legacy 导航栏色字段
  ⇒ 「透明」由**代码层断言 + 像素层无遮挡**两条共同证明。

## 平板档设置入口

平板档（`sw ≥ 600`，含折叠屏展开）下页面上没有长按鲸鱼那个入口。
为了让 App 自有的「连接设置」仍然可达，由**原生 + 最小 hook** 共补**三个**入口，
**三者都不在页面上新增任何可见浮层 / 节点 / 属性 / 类名 / 样式**：

| 入口 | 行为 |
|---|---|
| 隧道常驻通知的「**连接设置**」动作 | 进程外直达连接设置页（`MainActivity.ACTION_OPEN_SETTINGS`）。只切界面，**不碰隧道**、不重载 WebView；冷启动与已在前台/后台两条路径行为一致。通知上原有的「断开」动作不受影响 |
| **长按品牌区 600ms**（rc.2.8 新增，T97） | 锚点 `[data-slot="sidebar"] [data-window-drag="true"] > button`（会话页左上角「鲸鱼 + deepseek HARNESS」那块可拖拽按钮，**不依赖哈希类名 / aria**）→ 打开连接设置页。阈值 600ms；移动 >10px 取消；多指不立案；监听**全 passive、从不 preventDefault** |
| **会话根**按系统返回键 | 打开连接设置页（会话内仍先关官方弹层、再收侧栏、再回上一页）。**rc.2.6 起手机档同样如此**；**rc.2.8 起平板档一次返回即进设置页**（此前先关官方左抽屉） |

> **为什么平板档那条长按需要动 hook（契约变更的由来）**：该手势只能由页面侧监听，原生接不到。
> 为此平板档契约由「**hook 严格 OFF / 零痕迹**」改为「**允许最小 hook，但不得新增 DOM 节点 /
> 属性 / 类名 / 样式**」（rc.2.8，用户明确授权）。**痕迹实测**：常态只有 1 个
> `touchstart` 监听器，DOM / 全局**零新增**（base 与最终 APK 的 `outerHTML` 逐字节相同）；
> 手势进行中才临时挂 `touchmove` / `touchend` / `touchcancel`（全 passive）+ 捕获阶段 `click`，
> 收手即拆。**长按后必须吞掉窗口内每一次 `click`**——该区域单击的语义是**新建会话**，不吞就会
> 「开了设置页又顺手开了新会话」。真值 **18/18**（长按生效 / 单击仍开新会话 / 移动不触发 /
> 多指不触发 / 切 phone 档立即失效）；**手机档不生效**（档位闸）。
> 证据：`scratch/t97/report.md` §1–§3.5、§4–§6.3、§12。

**返回键语义（会话页，rc.2.6 起两档一致）**：

| 状态 | 按返回键 |
|---|---|
| 官方弹层 / 侧栏展开 | 先收弹层、再收侧栏 |
| **右栏打开态** | **只关面板**（不继续到设置页、不退后台） |
| 会话根 | **回 App 连接设置页**（再按一次才退后台） |
| 平板档会话根 | **第 1 次直接回 App 连接设置页**、第 2 次退后台（**rc.2.8 起不再先关左抽屉**） |

- **旧实现为什么「承诺与行为不一致」**：设置页那句「点上方「返回当前会话」或**系统返回键**继续」的
  判据是 `settingsViaBackKey && isTabletClass()`，而 `settingsViaBackKey` 的**唯一置位点就写在
  `if (isTabletClass())` 分支里**（源码注释原文「手机档永不置位」）⇒ 手机档恒为 false，
  **承诺最明确的那一条恰恰是假的**，按返回键直接 `moveTaskToBack(true)` 退桌面。
  现已去掉档位门，并让**设置页文案、会话根处理、文档三处同批改**。
- **其它入口未变**：由通知动作（或长按鲸鱼）进设置页时标记仍为 false，返回键仍**回会话**。
- 证据：`scratch/t65/report.md` §1.1–§1.2（源码两处 + 文案）、§4.1（三条路径的设备级真值）。

**平板档一次返回直接进设置页（rc.2.8，T99）**：

- 平板档会话根按**系统返回键**：**一次**返回即进 App 连接设置页（**不再先关官方左抽屉**）；
  第 2 次退后台。手机档会话根行为**未变**；右栏打开态仍只关右栏；无活会话仍退后台。
  注释与设置页文案同批改（避免「注释说先关抽屉、行为已换」这种不一致）。
- **设备真值 6 场景**（真实 `adb shell input keyevent 4`，两档逐场景）：平板会话根 1 次返回 →
  设置页（顶部出现「返回当前会话」）；官方弹层打开态只关弹层；右栏打开态只关面板；
  无会话退后台；手机档三条路径不变。变异反证 3 处（含把 WEB 分支改回 T99 之前 → 断言红 + 设备红）。
- ⚠️ **未决（如实）**：手机档「**右栏打开 + 返回**」在这套隔离装置里**点不出那个面板**
  （绑定工作区要过 mux RPC）⇒ 本体**没有**设备真值。替代证据三条：
  ① **代码路径逐字节相同**（手机档走的仍是 T99 之前那条 `closeOverlaysThenFinish()`）；
  ② 官方弹层臂的设备真值；③ T47 验收台 44/44。
- 证据：`scratch/t99/report.md` §2–§4、§6–§7、§9 未决①。

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
- **证书锁定按「配置档」记指纹**（不再只按 `host:port`）。判定分两支：
  **有配置档身份 ⇒ 只看该配置档自己的键，没有就 TOFU；没有配置档身份（直连 / 局域网）⇒ 只看地址键**。
  两个信任语境**互不回退**：

  | 键 | 谁读它 |
  |---|---|
  | `cert_prof_<profileId>` | **只有**该配置档的连接。`profileId` 是 App 自己生成的稳定 UUID，改隧道名 / 改端口 / 改密钥都不影响它 |
  | `cert_fp_<host>:<effectivePort>` | **只有**非配置档连接（直连 / 局域网节点），以及 URL 未写端口时查的字面端口旧键。配置档连接**不读**它 |

  - **修的是这样一条假警报**：两台不同的 PC 共用同一个回环端口时，地址键上存着其中一台的
    指纹，切到另一台就对不上 → 弹「证书已变更！」+ 中间人警告。实测同机 A/B 对照：同一批
    证书、只换键布局即当场复现该警告；改后**配置档 B 对上 B 自己的证书 ⇒ 零弹窗**。
    用 `profileId` 而非 `serverAddr:port:name` 派生，是因为隧道名由用户自己取，改名就等于
    换了一把锁。
  - **T27 对抗复核补的反例（「A 档带指纹、B 档不带」仍会误报）**：`seedKeys()` 预置时曾同时写
    配置档键与共享地址键，判定时又「没有自己的键就回退地址键」。于是 **B 档首次连接读到的是
    A 的指纹 → 判 CHANGED → 弹假「证书已变更！」**。一句话：**「首次见到某配置档」不等于
    「地址键为空」**。现在配置档连接**只**认自己的键，没有就是 TOFU；预置也**只**写配置档键
    （写地址键对本档已无用，而地址键的读者是另一个信任语境，写进去等于把信任泄漏出去）。
    独立探针 `scratch/t25/T25CertPinProbe.java`（期望值未改）由 20/22 → **22/22**。
  - **真变更仍会强提示，安全性没有削弱**：同一配置档内证书真变了照旧弹「证书已变更！」；
    直连 / 局域网节点没有配置档身份，走地址键，变更同样报警；共享地址键**无法**掩盖已锁档的
    变更（配置档连接根本不读它）。唯一变化是「**首次**见到某配置档且它自己没有锁」时走
    TOFU——那个配置档此前根本不存在「上次记录」，TOFU 才是诚实的结论。
  - **顺带修好一处死代码**：导入链接里的指纹此前在导入那一刻就被丢弃
    （`toVisitorConfig()` 写死空串），所谓「首连前预置指纹」永远不成立 ⇒ 每次隧道连接必然落到
    TOFU。现指纹随配置组持久化，首连预置才真正生效。
  - **存量迁移（升级代价，刻意接受）**：老配置组的 prefs 里没有指纹字段，该档**首次**连接仍会走
    一次 TOFU（这是诚实的：它确实还没有「上次记录」），用户信任后即按配置档锁定，之后不再误报。
    T27 起再多一条：**升级安装的存量地址键对配置档连接一律被忽略** ⇒ 即使老配置组曾经靠地址键
    锁定过，也会在**升级后首次**连接多问一次「信任此服务器？」。已经写过 `cert_prof_` 的配置档
    不受影响（仍直接放行）。这条代价换掉的是「首次见到 ≠ 地址键为空」造成的假中间人警告，
    判据本身没有放松。「清除本机授权数据」会一并清掉 `cert_prof_` 前缀，不留半套信任。
  - 证据：`scratch/t23/report.md`（A/B 对照矩阵 V1–V8、prefs 原文；两台夹具证书用与 App
    完全相同的算法 `SHA-256 over DER` 读取）、`scratch/t27/report.md`（T25 独立探针由红转绿）。
- **前端缓存没有削弱证书锁定**（详见 [根 README 前端缓存与 SW 供给](../README.md#前端缓存与-sw-供给)）：
  - SW 脚本**由 App 本地供给**——`ServiceWorkerClient.shouldInterceptRequest` 命中
    `/__dsh_remote__/sw.js` 时直接从 `res/raw/dsh_sw.js` 返回，**脚本不经网络 ⇒ 证书不参与**
    ⇒ 主框架的 pin / TOFU **一行不改**。这是本轮能同时拿到缓存收益与不放松锁定的关键。
  - SW 内部取数走 **`PinnedFetch`**：它**只复用主框架 TOFU 弹窗已经落盘的那把锁**，
    **只有 `TRUSTED` 才放行**；**TOFU 一律不放行、CHANGED 一律不放行**（抛 `CertificateException`，
    绝不在任何情况下静默供数，也**不把自签根装成受信任锚**）。
  - **实证**（A2 判定 PASS）：换真证书后 `action=CHANGED` ⇒ **不放行**、**新字节零落盘**、
    「**证书已变更！**」弹窗**照弹**。pin / TOFU / 「证书已变更！」三件事的语义与引入前**完全一致**。
    证据：`scratch/t50/report.md` §3。
  - **缓存上限分两套，别混谈**（rc.2.6）：**App 原生落盘目录**为 **48 MB / 64 条、真执行**
    （每次写入后遍历全目录 `File.length()` 逐条累加，超线按 `lastModified` 升序**真删**；
    **「LRU」是近似的**——`setLastModified` 在 API 23+ 被系统一律拒绝，命中**不刷新** mtime，
    按**写入时间升序**近似）；**降档探针**（48 MB→2 MB、64→3 条）实测**字节**与**条数**两条闸门
    **都真的触发**过，每行日志都带删前/删后字节与条数，且页面仍正常渲染（探针已逐字节还原）。
    **SW CacheStorage** 侧按条目数封顶、
    `/plugins/` 按 `rev` 保留若干代（**旧条目不是立即清理**，后续轮次才 prune），**没有字节数上限**
    （`CACHE_MAX_BYTES` 已删，原因见根 README 与 `scratch/t53/report.md` §2.1）。
  - **`PinnedFetch` 加固**（rc.2.6）：单请求体 **32 MB** 硬顶、总量 **45 s** deadline（**超限抛异常**，
    不给半份数据）、**deflate 真支持**（自实现层此前只发不解，只要上游真 gzip 就 `DataFormatException`
    ——反代**不剥** `Accept-Encoding`，所以这是真实会踩到的错），外加 4 个诊断计数
    （`并发峰值` / `排队` / `拒绝` / `累计B`，**只做归因，不参与任何判定或限流**）。
    ⚠️ **并发闸门是防御性护栏，不是当前环境的收益来源**：实测 App 进程内 `peak` 恒为 **1**、无排队
    （WebView 在此环境**串行**派发），32MB/45s **一个都没被拦下**（`拒绝 = 0`）。
    **T55 报的「并发 12」是假象**——那是浏览器请求窗口（含排队时间）量出来的；同一段取证里
    闸门 3 与 64 的 **RSS 只差 0.7MB（0.7%）** ⇒ **RSS 与闸门无关**，别把省下的 MB 算到闸门头上。
    证据：`scratch/t60/report.md` §1.1–§1.4、§3.1、§3.3、§7。
- **首屏静态资源由 App 原生落盘**（rc.2.6）：`/assets/`、`/plugins/` 的首屏 GET 经**五道门**
  （`GET` · 非主框架 · `https:` 且 origin 等于当前网关 · 路径**非** `/api/` 与 `/__dsh_remote__/` ·
  路径在 `/assets/` 或 `/plugins/`）后写进应用私有目录；**键 = `SHA256(完整 URL，含 `rev`)`**、
  **存解压后的字节**、**tmp → rename 原子替换**；失败一律 **bypass 回源**，不阻断加载。
  **SW 那条取数路径读同一目录**，两条路径不再各存一份逻辑。
  - 实测**第 2 次进入 6,264,975 → 544,640 B（−91.3%）**——改前那个数正是 T59 §6.1 记的
    「实质反例：第二次仍全量」，**该反例已被消掉**。口径诚实说明：544,640 B **不是「纯 0 传输」**，
    含主文档 36,908 B、favicon、若干 `/api/*` 与 SSE 长连接字节；**静态资源那一项传输是 0 字节**
    （7/7 读盘）。
  - **占盘按「双份」算**：App 侧 **≈12,812 KB** + SW 侧 **≈22,652 KB** ≈ **35.5MB**（内容相同、各存一份）——
    增量价值是那一次性 6.15MB（实测省 5.73 MB/次），代价常驻 **~12.8 MB**，
    **这是一个明确的取舍，不是免费的**。要撤掉只需删 `interceptStaticAsset` 与
    `fetchForServiceWorker` 里的查盘两处，SW 侧不受影响。
  - **它换不来毫秒，别对外承诺速度**：**没有做「接管前后同一条件 A/B」的 DCL 墙钟对照**；
    已取到的时点只有 N1 `t+10557ms`（含 TOFU 弹窗等待）、N2 `onPageStarted t+851ms`
    ⇒ **只做到「未观察到变慢」，没做到「证明不变慢」**。
  - ⚠️ **如实记下的限制**：淘汰**不删空分桶子目录**（`du` 8 KB→64 KB）；**本轮未在设备上真做一次
    DSH 升级**验证「换 `rev` 后能取到新资源」（依据是键含 `rev` 的设计 + T63 的回源测试，非设备实测）。
  - 证据：`scratch/t65/report.md` §2.2–§2.3、§3.3–§3.4、§5.1–§5.3、§9.3–§9.7、§9.9。
- **磁盘缓存「0 条」是预期行为，不是故障**：
  > **排查缓存问题前先读这条，避免把预期行为当 bug 反复查。**

  自签证书下走 `onReceivedSslError → proceed()` 的响应，**按 Chromium 策略不写 HTTP 磁盘缓存**
  ⇒ 该台**恒 0 条**是**设计使然**。**不要**拿 `fromDiskCache` 判命中，也**不要**在它上面挂
  「缓存失效」告警。真正存活的是 **SW CacheStorage**：实测 **8 条 / 12,960,301 B**，跨进程、
  跨重启**存活**且**逐字节校验全等**（60/60 项一致、0 差异）。
  - **`WebStorage.deleteAllData()` 只清 DOM Storage**：`localStorage` / `sessionStorage` /
    `indexedDB` / `webview` canary 键**全部未变** ⇒ **不清** CacheStorage、**不清** SW 注册。
    「清了数据还是走缓存」是**正确行为**。
  - **验收必须配 `du -sk` + 网卡字节**：`caches.keys()` 会**低报**——Chromium 的 CacheStorage 索引
    **按需/惰性加载**，没被读过的条目**不 materialize**。实测一次 `force-stop` + 重启后页面里读到的是
    **1 条 / 3,634 B**，而**磁盘上仍是 22,692 KB / 19 文件**、新进程 `pinnedFetch` **0 次**
    ⇒ 那 7 条**没有下载、没有重取，是从磁盘上「长」回来的**。可靠探针三条：磁盘 `du -sk` ·
    边界前后 `lo` 字节 · **完成一次导航后**的条目数。
  - ⚠️ **两条口径边界（如实）**：① 上述 `deleteAllData()` 的清理范围**只在 WebView
    **124.0.6367.219 / Android 15 上实测成立**——该 API 清什么属**实现相关**，换版本需重测；
    ② 另有**磁盘放大 1.75×**（解码后 12,960,301 B 占盘 22,652 KB），**容量规划按 1.75× 记**。
  - 证据：`scratch/t54/report.md` §3.2–§3.3、§B.1；`scratch/t62/report.md` §2.1–§2.3、§3、§5.3–§5.4。
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
- ~~**半装守卫竞态未根治**~~ → **已根治（rc.2.6）**。此前记的「`onPageStarted` 注入在页面尚未建好时执行，
  仍会抛 `mobile.js:911` 的 `appendChild of null`（实测 12 次会话内导航触发 5 次）」已**不再成立**。
  - **治法 = 两件事一起**：① 把 `mobile.js` 顶层的 IIFE 改成**具名函数表达式**并挂成
    `window.__dshrInstallMobile`；② 入口加**`<html>` 就绪闸门**——未就绪时**一行 DOM 代码都不走、
    守卫也不置位**（关键在「不置位」：置了位就等于自我毒化）。就绪后由 `init()` 走原路径。
  - **实测（12 次会话内导航）**：**JS 异常 24 → 0**（变异对照台 `t56-nav12.mjs`），
    **收敛 0/12 → 12/12**。
    - ⚠️ **两档口径要分清（别只引 12/12）**：**浏览器级**是 **12/12 收敛、0 异常**；
      **设备级 AVD** 是 **hook 装上 12/12、JS 异常 0 次，但全收敛 11/12**——差的 1 轮
      `officialEls=14`（其余 134~144）已定位为**官方 SPA 首屏 bundle 自身加载失败**，
      hook 只做「加节点 + 加标记」，不可能把官方树从 144 缩到 14。要补齐那一格
      需要一个不与他人抢 `18443` 的时段。
  - **变异①（退回旧形态，负控制）**：稳定复现**收敛 0/12、JS 异常 24**（每轮 2）、
    特征串 `TypeError: Cannot read properties of null (reading 'appendChild')`，
    状态正是半装签名 `{"guard":true,"api":"undefined","cls":"","style":false,"whale":false}`
    ⇒ **变异敏感**，「异常没了」不是因为测法变钝。
  - **自愈保留，理由改为「二道防线」**（不再是主要修复）：只兜「闸门之后正文里抛」这一类
    （守卫在闸门之后立刻置位，之后还有整份正文要跑完才导出 API；这段里任何一处抛都会产生半装，
    而**系统里没有第二条恢复路径**）。§移动界面自检那条的 3 轮重试预算、66ms 实测**一个字没动**。
    两条机制**互补不重叠**——本条治「装得太早」，自检治「装上了但被破坏」，都留着。
    另：新形态的 `__dshRemoteMobilePending` 挂起态对守卫**恒返回 0、绝不触碰**（实测逐字未变）。
  - 证据：`scratch/t56/report.md` §2.2（改法 + `flushStyle` 现挂 `:958-978`）、§3.1（前后对照）、
    §4.1–§4.3（自愈判定）、§5.2 与 §6（变异①与还原）、§9.1（11/12 定位）。
- **rc.2.7 重连判据的边界（如实写）**：
  - 判据依赖官方那条 UI 在**左栏展开**时渲染；**左栏收起（rail）下没有任何 UI 判据**，只能靠
    WebSocket 信号兜底。观测对象是 app 那条 socket 的 `open`/`close`——**若上游改用非 WebSocket 载体
    （或把 socket 建进 worker），这条观测会静默失效**（届时 `wsSeen` 仍为 true 而 `wsEvents` 长期不变，
    排查时可一眼看出）。
  - `role=searchbox` / `role=combobox` 容器内整段文案**恰为**「重新连接中」时，**层 2 仍会命中**
    （两端同结论，已知边界；要收掉得同时改两端层 2 的 `closest` 名单，会再动两处既有断言）。
  - **i18n 只覆盖官方中英两套词典**；出现第三语言时**宁漏报不误报**（文案锚定与 `aria-label` 锚定
    都可能命中不了）。
  - **取证环境**：本批次的量化真值全部来自 **AVD 模拟器**（T82 `-port 5570`、T84 `-port 5670`、
    T86 `emulator-5690/5692`、T90 `emulator-5710`）+ 真实页面 CDP；用户报障的小米 15 / Xiaomi Pad
    只命中**部分场景**，本批次**未在其实机上复验**。平板档只在 phone 档设备上做「运行时切 tablet」，
    **没有**起第二台平板跑完整的平板端到端（平板档横幅走 DOM 探针这条已在真机上用官方同构节点验过）。
  - 证据：`scratch/t90/report.md` §12、`scratch/t86/report.md` §2.1·§5.2·§6、`scratch/t88/report.md` §F。
- **rc.2.8 的取舍与未验（如实写，别当回归）**：
  - **平板档「温和层派发」会让官方客户端自己重渲染一次**：实测 `nodes 475→480`、
    `outerHTML` **+452B**（**不是我们写 DOM**，也没引入新的痕迹类别）。若要「DOM 逐字节相同」
    的硬门槛，`runStuckRescue` 里对 `isTabletClass()` 跳过温和层**一行开关即可关掉**
    （平板档只走 12s → 升级层）。**当前未改**，是明写的取舍。证据：`scratch/t96/report.md` §5、§7。
  - **手机档「右栏打开 + 返回」没有设备真值**（隔离装置里点不出那个面板），替代证据 =
    **代码路径逐字节相同 + 官方弹层臂 + T47 44/44**。证据：`scratch/t99/report.md` §9 未决①。
  - **总台账里 `test:device` 曾出现一次 exit 1 却不是断言失败**：首轮 **158/158、0 跳过** 全绿，
    红的是脚本的「清理义务」（它借用的**共享用户网关 18443** 的设备表在运行期被**别的并发任务**
    改动：284 → 285）⇒ 隔离复跑即 `未吊销的新设备 0 个`、exit 0。**这是环境争用，不是回归。**
    证据：`scratch/t99/report.md` §6。
  - **取证环境**：rc.2.8 批次的量化真值仍全部来自 **AVD 模拟器**
    （T94 `emulator-5682/5684`、T96 `emulator-5700/5702`、T97 `emulator-5730`、
    T99 `emulator-5900/5902`）+ 真实页面 CDP。用户报障的**小米 15 / Xiaomi Pad 本批次未复验**
    ——本批所说的「真机」= AVD。证据：`scratch/t94/report.md` §0.1、`scratch/t96/report.md` §0、
    `scratch/t97/report.md` §11.2、`scratch/t99/report.md` §1。
  - **一处未判红（如实）**：T94 的变异 M2（把 1.5s 轮询间隔改成 24h）**没有变红**——
    跟随被别的触发点覆盖（平板档没有 hook 推送，纠正本应完全靠轮询；实测 8s 内仍跟随）。
    该条的**主要**判据是设备像素与源码契约，不是这一处变异。证据：`scratch/t94/report.md` §5.1、§8。
