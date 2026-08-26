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
| `packages/gateway/` | 网关核心（TypeScript，Node ≥24 原生 TS 运行，无构建步骤） |
| `packages/plugin/` | cordis 插件：随 DSH web profile 自启网关 |
| `android/` | Android 壳 App：内嵌 frpc visitor + 证书锁定（见 [android/README.md](android/README.md)） |
| `scripts/install-frps.sh` | VPS 一键安装 frps |
| `scripts/smoke.mjs` | 冒烟测试（18 项） |
| `docs/` | 架构决策、[版本与发布规范](docs/versioning.md)、VPS 部署、安全模型 |

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
  "upstreamPort": 52392,
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

> `upstreamPort` 是 DSH Web GUI 的端口（本会话为 52392）。桌面端重启后端口若漂移，
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
  手机端竖屏移动界面（隐藏桌面 rail、鲸鱼侧栏入口、设置底部 sheet、状态栏沉浸避让）；横屏走官方 DSH
  由 **App 注入的脚本完成，不依赖服务器端是否安装本插件**，连接官方 DSH Web 同样生效。
- **PC/其他设备**：拿 `frpc-visitor.toml` 跑 `frpc -c`，访问 `https://127.0.0.1:<bindPort>`。

xtcp 打洞成功时数据手机 ⇄ PC 直连不过 VPS；失败自动回退 stcp 中转不断连。
详见 [docs/vps-frps-setup.md §4.5](docs/vps-frps-setup.md)。

### 局域网模式（可选，无 VPS 时先用起来）

默认网关只监听 `127.0.0.1`（最安全）。想在家里 WiFi 直接用手机访问：

```jsonc
{ "listenHost": "0.0.0.0", "listenPort": 18443, ... }
```

并在 Windows 防火墙放行该端口。手机浏览器打开 `https://<电脑局域网IP>:18443` 配对即可。
认证门对所有来源生效，但请仅在可信家庭网络使用此模式；出门在外请走 frp 通道。

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

重启 DSH Desktop 后，网关随 profile 自动拉起（`config.json` 里 `"autoStart": false`
可关闭）。

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
- **传输层**：手机↔网关 TLS（自签，指纹可校验；壳 App 将做证书锁定）；frpc↔frps 隧道 TLS。
- **隔离层**：设备 Cookie 不转发给上游 DSH；审计日志记录全部配对/拒绝事件。

完整说明见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
pnpm install
pnpm smoke          # 14 项冒烟测试（网关）
pnpm test:plugin    # 插件模拟运行（假 ctx 拉起/回收网关）
pnpm test:routes    # 插件宿主路由逻辑单测（9 项）
pnpm -C packages/plugin build   # 构建设置卡片客户端 bundle
node scripts/probe-ws.mjs [端口]   # 对运行中的网关+DSH 做 WS 直通探针
```

### 版本与发布

版本号 = `<deepseek-harness 基线版本>.<发版号>`，发版号每次发布 +1，
详见 [docs/versioning.md](docs/versioning.md)：

```powershell
pnpm ver:bump     # 发版号 +1 并同步 package.json；harness 升级用 --base <新版本>
git tag v0.1.1-rc.2.6 && git push origin v0.1.1-rc.2.6   # 推 tag 即自动打包发布
```

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

- [x] 网关核心：认证/反代/WS 直通/PWA 注入/frp 托管/CLI
- [x] cordis 插件自启
- [x] frp 访客模式（stcp/xtcp）：VPS 不开公网入口，`dsh-remote visitor` 出码导入
- [x] Android 壳 App：内嵌 frpc visitor + 证书锁定 + 扫码导入
- [ ] tsnet 传输适配器（无 VPS 备选）
- [ ] iOS 壳 App（需开发者账号分发）
