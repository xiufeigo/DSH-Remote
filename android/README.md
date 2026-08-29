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
2. aapt2 → javac(Java 8 语法) → d8 → 打包 dex 与 `lib/arm64-v8a/libfrpc.so`
   （安装后系统解压到 nativeLibraryDir——Android 只允许执行该目录，
   这就是 frpc 必须伪装成 `lib*.so` 的原因）→ zipalign → apksigner；
3. 签名两种模式：
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

## 移动界面

- App 首屏不再显示连接表单。没有访客配置、直连地址或可用后端时，只显示本地连接状态；不会编造或缓存工作区、会话、消息内容。
- 已连接时，主页面仍是原始 DSH Web。移动适配由 **App 在页面加载完成后注入的 `res/raw/mobile.js`** 完成，**不依赖服务器端是否安装 dsh-remote-plugin**——连接官方 DSH Web 与连接带插件的网关表现一致。隧道前台通知在智能体正在生成时显示当前会话标题和用户内容；任务结束后改走静默渠道。Android 要求前台服务必须挂通知，小米「正在运行」里空闲时仍可能看到一条很淡的保活项，但不会再写本机端口直通。
- 注入链路做了纵深防御：`onPageFinished` / `doUpdateVisitedHistory` / `onPageCommitVisible` 三个时机注入 + 1.5s/4s 延迟补注入（脚本幂等）；官方 DOM 探测带多级回退（`data-shell-overlay` 父节点 → 官方侧栏开关按钮祖先链 → `data-sidebar-collapsed`）；页面加载 6 秒后自检脚本是否真的运行，若始终缺失则自动退回**实色状态栏**模式（内容排在状态栏下方），绝不与系统栏重叠，后续注入成功会自动恢复沉浸。
- 适配仅在**竖屏**启用：手机竖屏与平板竖屏走 hook；**平板横屏去掉适配，使用官方 DSH 桌面布局**。横屏状态栏保持透明沉浸：侧栏灰底 / 主栏白底各自延伸到屏幕顶，控件再避开系统栏，并挡住该区域点击，避免误触。Android 壳竖屏仍不看 1024px（部分机型 layout viewport 虚高）。收起态用左上角悬浮鲸鱼打开侧栏。展开后采用 DeepSeek App 式布局：侧栏铺在底层，中间会话列可**跟手拖动**滑成圆角浮层。手机竖屏右侧只留细条；**平板竖屏侧栏只划出约三分之一宽**，主会话窗口仍大块可见，点主会话或左滑即可收回。**主屏幕右划**也可打开；在侧栏里点对应会话（或新建会话）后抽屉自动收起。官方「设置」以**全屏页**盖住侧栏与会话（带进入动画），不再先收起侧栏再弹窗。**App 连接设置只通过长按鲸鱼进入**；若会话仍在，设置页顶部有「返回当前会话」，系统返回键同样回到已连接会话。会话内系统返回键：先关官方弹层，再收侧栏，再回 DSH 上一页；到会话根则把 App 放到后台，**不会**退到 App 设置，也**不会**拆掉 frpc。点浮层右侧细条、抽屉上左划也可收起。模型、权限、命令、模式等浮动选框会被钳在视口内。输入底栏里超长模型名会省略号截断，不得盖住左侧「+」和权限按钮。
- 官方设置在手机上是**全屏页**（从设置入口盖住整屏，置于会话浮层之上），导航仍横向排在上方；选中分区内容全宽展开。侧栏展开时，按住右侧主会话浮层左滑可**跟手**收回会话全屏。导航列表允许横向触摸滚动，并在 `aria-current` 改变后自动把选中分区完整滚入可视区。只统计**当前可见**的模态框，隐藏弹窗残留不会误触发“弹窗打开”状态。
- 会话头部适配：官方 header（含会话面包屑标题）在收起态整体右移 62px，不再被固定在左上角的鲸鱼按钮遮挡；官方「Session log」下载按钮在手机宽度下收成 32px 纯图标按钮（文字用 sr-only 剪裁，读屏仍可读，`aria-label` 同步补齐）。两者都按结构特征定位（`header` 内含 `nav`；按钮内 `span` 文本恰为 `Session log` 且带图标），不依赖 CSS Module 哈希类名。
- 系统栏沉浸：App 保持透明状态栏 edge-to-edge，并把真实的状态栏/导航栏 inset（CSS px）写入页面变量 `--dshr-inset-top` / `--dshr-inset-bottom`；页面内容下移让出状态栏，状态栏颜色与页面背景一致（`viewport-fit=cover` 与 `env(safe-area-inset-*)` 仅作兜底）。即使官方 frame 结构探测失败，body 兜底 padding 也保证内容不顶进时钟/挖孔区域。**虚拟键盘**弹出时，原生按焦点输入框位置平移，只抬到输入框露在键盘上方（空会话/设置页元素少时不会把输入框顶出屏幕）；页面侧再用 `interactive-widget=overlays-content` 与 `visualViewport` 把焦点矩形告诉原生。Android 返回键会优先关闭设置弹窗或收起已展开的 DSH 侧栏。
- 适配脚本只依赖官方 DOM 的稳定结构特征（`data-shell-overlay`、`data-sidebar-collapsed`、`aria-label`、`role="dialog"` 等），不依赖 CSS Module 哈希类名，也不往 React 管理的容器里插入节点。
- 连接失败、隧道超时或 PC 端 DSH Web 不可达时，远端页面会换成本地失败页，可点「重新连接」；改连接配置请长按鲸鱼。已在跑的隧道不会因返回键或误报断线被拆掉，再点「连接」会复用本机隧道端口（首选 18443，被占用时自动在 16225~16235 协商），不必清后台。
- 连接设置（配置组卡片页）**只通过长按小鲸鱼进入**。系统返回键不会打开该页：会话内先关官方弹层/侧栏再回上一页，到根则把 App 放到后台。点「连接」若隧道仍在，会直接恢复已注入移动适配的会话，不会重载成官方 DeepSeek Harness 桌面栏。
- 连接设置为卡片式布局（安全隧道 / 直连入口或局域网 / 连接维护三张卡片，圆角 + 浅灰页面底），并让出状态栏/导航栏 inset。「隧道形态」选择器提供 xtcp（P2P 打洞，推荐）与 stcp（加密中转）两项，文案与电脑端插件面板一致；entry（公网入口）形态是电脑端服务侧配置，手机上用「直连入口或局域网」即可，无需访客隧道。手动填写时按电脑端面板逐项对照：VPS 地址、控制端口、隧道形态、隧道名（默认 `dsh-remote`）、访客密钥、frps 登录密钥。

## 图标

`res/mipmap-*/ic_launcher.png` 由 `icon-src/icon.html`（白色圆角方块 + 鲸鱼标记）渲染：
本机用 Edge headless `--screenshot` 出 1024px 底图，再以 GDI+ 高质量缩放生成
48/72/96/144/192 五档密度 PNG；改图标只需改 `icon-src/icon.html` 后重跑该流程。

## 安全说明

- 连接串含 `token` + 访客 `sk` + 网关证书指纹，**等于家门钥匙**：
  不要截图外传；泄露后在 PC 删除 `secrets.json` 的 `frpVisitorKey` 字段重启重新出码。
- 证书锁定按 `host:port` 记录指纹；指纹变更会强提示中间人风险后才允许更新。
- frpc 配置与日志落在应用私有目录（`filesDir/frpc-visitor.toml`），不落外部存储。
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
