# VPS 部署 frps 指南

目标：在你的公网 VPS 上跑起 frps，让家里 PC 能通过加密隧道把 DSH 网关挂到公网入口。

## 1. 前置

- 一台有公网 IP 的 Linux VPS（1核512MB 起步足够；国内节点速度最佳）
- 云厂商安全组放行两个 TCP 端口：
  - **控制端口** `7000/tcp`（frpc ↔ frps 握手）
  - **入口端口** `8443/tcp`（手机浏览器访问）

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
tail -f /etc/dsh-remote/frps.log
```

## 3. PC 侧：放置 frpc 二进制

网关以子进程方式托管官方 `frpc`。下载与 VPS 相同版本的 Windows 版：

```
https://github.com/fatedier/frp/releases/tag/v0.61.1
→ frp_0.61.1_windows_amd64.zip → 解出 frpc.exe
```

放到约定位置（二选一）：

- 缺省：`~\.dsh-remote\vendor\frp\frpc.exe`
- 或在 `config.json` 里指定：`"frp": { "binaryPath": "D:\\tools\\frpc.exe" }`

> 校验和见 release 页的 checksums.txt；`.gitignore` 已排除该目录，不会误提交。

## 4. PC 侧：配置并启动

`~/.dsh-remote/config.json`：

```jsonc
{
  "listenPort": 18443,          // 网关本机 HTTPS 端口（仅 127.0.0.1）
  "upstreamPort": 52392,        // DSH Web GUI 实际端口
  "frp": {
    "enabled": true,
    "serverAddr": "<VPS 公网 IP>",
    "serverPort": 7000,         // 与 VPS --control-port 一致
    "remotePort": 8443          // 与 VPS --entry-port 一致
    // authToken 缺省读取 ~/.dsh-remote/state/secrets.json，
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

`doctor` 全绿的标志：

```
✓ 上游 DSH GUI 127.0.0.1:52392 —— 端口可达
✓ 上游指纹 —— 确认是 DSH Web 界面
✓ TLS 证书 —— SHA-256 …
✓ frps 控制端口 7000 —— 可达
✓ 公网入口端口 8443 —— 开放
✓ frpc 二进制 —— C:\Users\<you>\.dsh-remote\vendor\frp\frpc.exe
```

## 5. 手机验证

浏览器打开 `https://<VPS IP>:8443`：

1. 出现「DSH Remote · 设备配对」页（说明隧道+网关全通）
2. PC 上 `dsh-remote pair --name 我的手机` 扫码/输码
3. 进入熟悉的 DSH 界面 🎉

> 自签证书首次访问会有告警，属预期；壳 App 阶段会用证书锁定消除。

## 6. 故障排查速查

| 现象 | 排查 |
|---|---|
| doctor 显示控制端口不可达 | 安全组没放行 7000；frps 没起来（`systemctl status`） |
| 控制通但入口不通 | PC 侧 frpc 没跑起来（看 `[frpc]` 日志）；token 不一致 |
| 入口通但配对页打不开 | 网关没监听（`netstat -ano \| findstr 18443`）；upstreamPort 填错不影响配对页 |
| 配对页能开、登录后 502 | `upstreamPort` 不是当前 DSH GUI 端口；桌面端重启后端口可能变化 |
| frpc 反复重启 | 网关日志里找 `[frpc]` 报错：多为 token 不匹配或 allowPorts 未覆盖 remotePort |
