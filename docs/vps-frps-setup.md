# VPS 部署 frps 指南

目标：在你的公网 VPS 上跑起 frps，让家里 PC 能通过加密隧道把 DSH 网关挂到公网入口。

## 1. 前置

- 一台有公网 IP 的 Linux VPS（1核512MB 起步足够；国内节点速度最佳）
- 云厂商安全组放行的 TCP 端口按形态二选一：
  - **入口模式**（`mode = "entry"`）：控制端口 `7000/tcp` + 入口端口 `8443/tcp`
  - **访客模式**（`mode = "stcp"` 或 `"xtcp"`，推荐）：只放行控制端口 `7000/tcp`。
    VPS 上不监听任何入口端口，互联网扫不到 DSH 的任何痕迹；
    只有持有访客密钥的手机/电脑（Android 壳 App 或 `frpc -c frpc-visitor.toml`）能连入。

## 2. 一键安装 frps

```bash
# 上传 scripts/install-frps.sh 到 VPS 后执行：
sudo bash install-frps.sh
# 输出会回显自动生成的 token，记下来（PC 侧要用同一个值）

# 自定义端口 / token：
sudo bash install-frps.sh --token <密钥> --control-port 7000 --entry-port 8443

# 忘记 token 时查看：
sudo bash install-frps.sh --show-token
```

脚本做了什么：

1. 从 GitHub Releases 下载 frp 稳定版（直连失败自动走 ghproxy 镜像）
2. 安装 `/usr/local/bin/frps` + `/etc/dsh-remote/frps.toml`
3. 注册 systemd 服务 `frps-dsh-remote` 并开机自启
4. 尽力而为放行 ufw/firewalld（云安全组仍需手动）

常用运维：

```bash
systemctl status frps-dsh-remote
journalctl -u frps-dsh-remote -f
tail -f /var/log/dsh-remote/frps.log
```

## 3. PC 侧：放置 frpc 二进制

网关以子进程方式托管官方 `frpc`。下载与 VPS 相同版本的 Windows 版：

```
https://github.com/fatedier/frp/releases/tag/v0.61.1
→ frp_0.61.1_windows_amd64.zip → 解出 frpc.exe
```

> frp 版本以根 `package.json` 的 `config.frpVersion` 为单一来源（OPS-05，当前 `0.61.1`）；
> 安装脚本与 Docker 构建都从该字段取值，升级 frp 时只改这一处。

放到约定位置（二选一）：

- 缺省：`~\.dsh-remote\vendor\frp\frpc.exe`
- 或在 `config.json` 里指定：`"frp": { "binaryPath": "D:\\tools\\frpc.exe" }`

> 校验和见 release 页的 checksums.txt；`.gitignore` 已排除该目录，不会误提交。

## 4. PC 侧：配置并启动

`~/.dsh-remote/config.json`：

```jsonc
{
  "listenPort": 18443,          // 网关本机 HTTPS 端口（仅 127.0.0.1）
  "upstreamPort": "<DSH 实际端口>",  // DSH Web GUI 实际端口（浏览器地址栏 127.0.0.1: 后的数字）
  "frp": {
    "enabled": true,
    "serverAddr": "<VPS 公网 IP>",
    "serverPort": 7000,         // 与 VPS --control-port 一致
    // mode 三选一：
    //   "entry"  经典公网入口，需配 remotePort（如 8443），任何人可扫到该端口
    //   "stcp"   访客模式·加密中转：不开入口端口，流量固定走 VPS
    //   "xtcp"   访客模式·P2P 打洞（推荐）：优先直连，失败自动回退 stcp 中转
    "mode": "xtcp",
    "name": "dsh-remote",        // 可选；多人共用一台 VPS 时改成互不相同，例如 dsh-zhangsan
    "remotePort": 8443          // entry 形态或附加公网映射使用
    // authToken / 访客 secretKey 缺省读取 ~/.dsh-remote/state/secrets.json，
    // 需要与 VPS 的 token 一致：手动把 install-frps.sh 回显的值
    // 写进 secrets.json 的 frpAuthToken 字段即可
  }
}
```

同步 token 的两种方式（任选其一）：

- **A. 以 PC 为准**：读 `~\.dsh-remote\state\secrets.json` 里的 `frpAuthToken`，
  在 VPS 上 `sudo bash install-frps.sh --token <该值>`；
- **B. 以 VPS 为准**：把 `--show-token` 的值填进 PC 的 `secrets.json`。

启动 + 体检：

```powershell
node packages/gateway/src/cli.ts start     # 会拉起 frpc 子进程
node packages/gateway/src/cli.ts doctor    # 各环节逐项检查
```

`doctor` 全绿的标志（entry 形态）：

```
✓ 上游 DSH GUI 127.0.0.1:<DSH 实际端口> —— 端口可达
✓ 上游指纹 —— 确认是 DSH Web 界面
✓ TLS 证书 —— SHA-256 …
✓ frps 控制端口 7000 —— 可达
✓ 公网入口端口 8443 —— 开放
✓ frpc 二进制 —— C:\Users\<you>\.dsh-remote\vendor\frp\frpc.exe
```

stcp / xtcp 形态下「公网入口端口」一项会显示
`xtcp 形态不开入口端口，VPS 暴露面仅剩控制口 + 访客密钥`，同样属于全绿。

## 4.5 同时保留访客通道和指定公网端口

电脑端插件的「远程隧道」中保留 `xtcp`（或 `stcp`），打开「同时启用公网端口映射」，
填写「公网入口端口」并保存重启。等价的配置为：

```jsonc
"frp": {
  "enabled": true,
  "serverAddr": "<VPS 地址>",
  "serverPort": 7000,
  "mode": "xtcp",
  "name": "dsh-remote",
  "entryEnabled": true,
  "remotePort": 8443
}
```

Android 继续使用原访客配置（打洞失败仍回退 stcp）；浏览器访问
`https://<VPS 地址>:8443/`，输入电脑端插件中设置的「访客密钥」即可进入。
可直接在插件中自定义该密钥；Android 和网页使用同一把密钥，建议使用较长的随机值。
浏览器验证后会记住授权。修改密钥并保存重启后，旧网页会话失效，需输入新密钥；
Android 也需更新密钥。历史仅用配对码授权的浏览器首次需重新验证。
`serverPort` 是 frps 控制口，`remotePort` 是公网访问口，两者必须区分。
frps 的 `allowPorts`、服务器防火墙和云安全组都需允许 `remotePort`，该端口也不能被其他服务占用。
使用一键安装脚本时，`--entry-port` 应与这里的 `remotePort` 一致。

同一个 frpc 会注册原访客代理和附加 `<name>-entry` TCP 代理。
公网代理指向电脑上独立的回环 HTTPS 监听口（端口由系统分配），与访客代理共用网关处理逻辑，
但 HTTP 和 WebSocket 均强制校验设备 Cookie；公网连接不能借用访客隧道的免登录准入。
访客密钥只在登录时经 HTTPS 提交，不附在公网地址中。
默认自签证书通过 VPS 地址访问时仍会出现浏览器证书告警。

关闭 `entryEnabled` 并保存重启即可移除公网入口，访客配置无需修改。
旧的 `mode: "entry"` 单入口配置继续有效；附加公网映射默认关闭。

本地验证：`pnpm test:frp` 测试配置/认证契约；安装 frpc/frps 后运行
`pnpm smoke:dual:frp`，验证真实双通道、访客密钥网页登录、HTTP/WS 授权及吊销和监听口清理。
`pnpm test:visitor` 验证密钥轮换、旧会话失效和错误密钥锁定。

## 4.6 访客模式（未启用附加公网入口时不开公网端口）

`mode = "stcp"` 或 `"xtcp"` 时，手机不再访问 VPS 的公网端口，而是通过
**frpc visitor** 凭访客密钥连入。VPS 被扫到的面只剩一个 frps 控制口。

PC 网关侧配置好 `mode` 后，生成手机端导入物：

```powershell
node packages/gateway/src/cli.ts visitor --mode xtcp
# 输出：
#   ~/.dsh-remote/frp/frpc-visitor.toml   ← 给 PC/路由器上的 frpc 用
#   终端二维码                             ← 给 Android 壳 App 扫码导入
```

两种消费方式：

1. **Android 壳 App**（推荐）：任意扫码器扫描二维码 → 系统弹出 DSH Remote 接管
   `dsh-remote://visitor?...` 链接 → 点「启动隧道并进入」。证书指纹随码下发，
   连接前自动锁定，全程无告警。
2. **其他设备**：把 `frpc-visitor.toml` 拷过去跑 `frpc -c frpc-visitor.toml`，
   之后访问 `https://127.0.0.1:<bindPort>`。

> **xtcp 与 stcp 怎么选**：xtcp 会先尝试 P2P 打洞（STUN 探测 NAT 类型，
> EasyNAT 等友好型成功率很高），成功后数据不经 VPS、延迟更低；打洞失败自动
> 回退为 stcp 中转，不会断连。蜂窝网络的对称 NAT 常打不通，但因为有回退，
> 无脑选 xtcp 即可。
>
> **换机/重装后连不上？** 访客密钥在 PC 的 `state/secrets.json`
> （`frpVisitorKey` 字段），删掉该字段重启网关会重新生成，重新出码即可。

## 5. 手机验证

**入口模式**：浏览器打开 `https://<VPS IP>:8443`：

1. 出现「DSH Remote · 访问验证」页（说明隧道+网关全通）
2. 输入电脑端插件中的「访客密钥」（也可使用 `state/secrets.json.frpVisitorKey`）
3. 进入熟悉的 DSH 界面 🎉

> 自签证书首次访问会有告警，属预期；壳 App 阶段会用证书锁定消除。

**访客模式**：手机装壳 App（见 android/README.md）→ 扫 `dsh-remote visitor`
的二维码 → 启动隧道。浏览器验证不适用于此形态——公网上根本没有入口端口，
这正是它的意义。

## 6. 故障排查速查

| 现象 | 排查 |
|---|---|
| doctor 显示控制端口不可达 | 安全组没放行 7000；frps 没起来（`systemctl status`） |
| 控制通但入口不通 | PC 侧 frpc 没跑起来（看 `[frpc]` 日志）；token 不一致 |
| 入口通但登录页打不开 | 网关没监听（`netstat -ano \| findstr 18443`）；upstreamPort 填错不影响登录页 |
| 登录页能开、验证后 502 | `upstreamPort` 不是当前 DSH GUI 端口；网关启动时会自动探测跟随 |
| frpc 反复重启 | 网关日志里找 `[frpc]` 报错：多为 token 不匹配或 allowPorts 未覆盖 remotePort |

## 7. 不想先动 VPS？本地先把整条链路验掉

见 README「部署 VPS 前的本地全链路自测」——在本机同时跑 frps+frpc+网关，
除真实跨网外所有环节（隧道握手/代理注册/认证/配对/WS 直通）都可提前验证。
本项目交付时已用此方法完成全链路验证。
