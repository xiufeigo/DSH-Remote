# Edge 部署：服务器侧 Web 网关（Docker / 裸机）

把「PC 网关 + Android 壳 App」的体验搬到服务器侧：VPS 上跑一个 Web 服务，
iPhone/iPad 用浏览器访问域名即可使用家里 PC 的 DSH Desktop——
**窄视口自动套用 Android 端同款 hook 移动布局，宽视口走官方桌面布局**；
公网入口前置 Token 认证，Token 登录即自动配对为可管理设备。

```
iPhone/iPad Safari
      │ HTTPS（Caddy 自动签发 Let's Encrypt）
      ▼
VPS Docker：caddy:2 ──reverse_proxy──► gateway 容器（node:24-alpine）
                                        │ ① Token 门禁 → 自动配对设备 Cookie
                                        │ ② 注入 /__dsh_remote__/mobile.js + PWA 标记
                                        │ ③ 反代(含 WS 直通) → 上游 127.0.0.1:<bindPort>
                                        ▼
                       ┌─ FRP_ROLE=visitor：容器内 frpc visitor → 外部已有 frps
                       ├─ FRP_ROLE=frps：容器内 frps(PC 的 frpc 连入) + 内部 visitor 回环消费
                       └─ FRP_ROLE=off：直连 upstream（调试/局域网用）
                                        ▼
        家里 PC（现状不动）：DSH Desktop ← 127.0.0.1:18443 网关(托管 frpc)
```

## 目录

1. [两种 frp 角色怎么选](#1-两种-frp-角色怎么选)
2. [Docker 部署（推荐）](#2-docker-部署推荐)
3. [PC 端配置与密钥同步](#3-pc-端配置与密钥同步)
4. [裸机一键部署](#4-裸机一键部署)
5. [认证：访问 Token 与设备管理](#5-认证访问-token-与设备管理)
6. [移动 hook 布局说明](#6-mobile-hook-布局说明)
7. [环境变量速查](#7-环境变量速查)
8. [故障排查](#8-故障排查)

---

## 1. 两种 frp 角色怎么选

| | `DSHR_FRP_ROLE=frps`（缺省） | `DSHR_FRP_ROLE=visitor` |
|---|---|---|
| 适用 | **自包含**：服务器上不再单独装 frps | 你已经有一台在跑的 frps（比如按 `scripts/install-frps.sh` 装的） |
| 服务器进程 | frps（控制口 7000）+ 内部 stcp visitor | 仅一个 frpc visitor |
| 公网暴露面 | Caddy 80/443 + frps 控制口 7000 | Caddy 80/443 |
| PC 端动作 | `serverAddr=<本服务器IP>` 指过来 | 指向那台已有的 frps |
| 安全组 | 80/443/7000 TCP | 80/443 TCP |

> 推荐用 `frps` 角色 + PC 端 `mode: "stcp"`：全链路只有控制口暴露（无 token 连不上），
> DSH 流量走加密中转，容器内 visitor 回环消费，一台 VPS 全搞定。
>
> 若 PC 端坚持用 xtcp 打洞：xtcp 对「服务器作为消费端」没有收益（数据终点就是这台
> 服务器），且其伴生 stcp 代理名为 `<name>-stcp`——此时需把服务器的
> `DSHR_FRP_NAME` 设成 `<name>-stcp` 才能对上。直接用 stcp 最省心。

## 2. Docker 部署（推荐）

前置：域名已解析到服务器；安全组放行 80/443（frps 角色再加 7000）。

```bash
cd DSH-Remote/deploy/docker
cp .env.example .env          # 填 DSHR_DOMAIN 与 DSHR_ACCESS_TOKEN（必填）
cp Caddyfile.example Caddyfile
mkdir data && sudo chown -R 1000:1000 data   # 容器内 node 用户写数据目录
docker compose up -d --build

# 验证
curl -sk https://127.0.0.1/__dsh_remote__/health -H "Host: <你的域名>"
docker compose logs -f gateway
sudo docker exec dsh-remote-gateway node src/cli.ts doctor   # edge 分项体检
```

然后 iPhone/iPad Safari 打开 `https://<域名>` → 输入 `.env` 里的访问 Token → 进入 DSH。

升级：

```bash
git pull && docker compose up -d --build
```

### compose 要点

- `gateway` 不对外映射端口（除 frps 控制口），只被 caddy 内网访问；
- Caddy 自动签发续期证书、透传 WebSocket，无需额外 header；
- 数据持久化在 `./data`（= 容器内 `/data`）：secrets、设备表、审计日志、frp 配置；
- **限流的真实客户端 IP（GW-03）**：Caddy 默认用真实客户端 IP **覆写**
  `X-Forwarded-For` 后再发给网关，不要把外部直传的该头透传给网关。网关侧仅当
  `DSHR_TRUST_PROXY_XFF=true` 且直连来源是回环**或**命中
  `DSHR_TRUST_PROXY_CIDRS`（逗号分隔受信网段）时才采信 XFF 最左一跳。
  compose 桥接下 caddy→gateway 源地址是容器网段 IP：在 `.env` 设
  `DSHR_TRUST_PROXY_XFF=true` 并把 `DSHR_TRUST_PROXY_CIDRS` 覆盖该网段
  （如 `172.16.0.0/12`，按 `docker network inspect` 实际子网收紧）即可按真实
  客户端 IP 限流；受信网段只应填反代所在网段——配宽了伪造 XFF 可绕过限流。
  裸机 + 宿主机 Caddy（回环）只需前者。详见 `deploy/docker/Caddyfile.example` 头部约定。

## 3. PC 端配置与密钥同步

PC 端**完全沿用现有部署**，只是 frp 指向 edge 服务器。以 frps 角色为例：

```jsonc
// ~/.dsh-remote/config.json
{
  "listenPort": 18443,
  "upstreamPort": <DSH Web GUI 端口>,
  "frp": {
    "enabled": true,
    "serverAddr": "<服务器公网 IP>",
    "serverPort": 7000,          // 与 DSHR_FRP_SERVER_PORT 一致
    "mode": "stcp",              // 推荐 stcp；entry 形态见下方“entry-port 消费”
    "name": "dsh-remote"         // 必须与 DSHR_FRP_NAME 一致！
  }
}
```

### 密钥同步（一次性）

edge 容器首次启动会自动生成 `frpAuthToken`（frpc↔frps 登录）与 `frpVisitorKey`
（stcp 访客密钥）。PC 端必须持有相同值：

```bash
# 服务器上读取（容器内 secrets）
docker exec dsh-remote-gateway cat /data/state/secrets.json
# 把 frpAuthToken 与 frpVisitorKey 两个值原样填进 PC 的 ~/.dsh-remote/state/secrets.json
# （文件不存在就先跑一次 dsh-remote start 让它生成骨架，再替换这两个字段）
```

PC 上 `node packages/gateway/src/cli.ts start` 重启后，日志应出现
`stcp 形态…`；服务器上 `docker compose logs gateway` 应看到 frps 收到注册、
visitor 就绪。之后经浏览器发起请求即打通。

> 反过来也可以：以 PC 为准——把 PC secrets.json 的值通过 `.env`
> `DSHR_ACCESS_TOKEN` 同级地预置进容器的 `/data/state/secrets.json` 后再启动。

### entry-port 消费（可选）

若 PC 端坚持 `mode: "entry"`（会把 remotePort 绑到服务器公网，**不推荐**）：
`.env` 里设 `DSHR_EDGE_CONSUME=entry-port`，并保证 PC 的
`frp.remotePort` 落在 `DSHR_FRPS_ALLOW_PORTS` 范围内。此时容器不起内部 visitor，
网关直连 `127.0.0.1:<remotePort>`。

## 4. 裸机一键部署

不使用 Docker 时，一条脚本完成 Node ≥24、frp、代码安装与 systemd 注册：

```bash
# 从 GitHub main 分支安装（国内 VPS 自动走 ghproxy 回退）：
sudo bash scripts/install-edge.sh --token <访问Token> --domain remote.example.com

# 或从已 clone 的目录离线安装：
sudo bash scripts/install-edge.sh --from-dir /path/to/DSH-Remote

# 升级 = 重跑（代码覆盖到 /opt/dsh-remote/app，数据 /var/lib/dsh-remote 不动）
# 卸载（保留数据）：
sudo bash scripts/install-edge.sh --uninstall
```

常用参数：`--frp-role frps|visitor|off`、`--control-port 7000`、
`--tunnel-name dsh-remote`、`--listen 127.0.0.1|0.0.0.0`。

HTTPS：脚本固定监听 `127.0.0.1:18443` 自签 TLS，对外请配合反代（Caddy 一份配置即可，
把 `reverse_proxy gateway:18443` 改为 `reverse_proxy 127.0.0.1:18443`，
GW-03 信任约定见 `deploy/docker/Caddyfile.example` 头部）。
宿主机反代到 `127.0.0.1:18443` 的直连来源是回环——在 `/etc/dsh-remote/env`
加 `DSHR_TRUST_PROXY_XFF=true` 即让限流/锁定按真实客户端 IP 生效
（缺省关闭时按回环地址限流，全员共享一个键）。
临时过渡可 `--listen 0.0.0.0` 直接暴露自签入口（浏览器手动信任一次证书）。

运维速查：

```bash
systemctl status dsh-remote-edge
journalctl -u dsh-remote-edge -f
cat /etc/dsh-remote/access-token        # 查看访问 Token（600 权限）
sudo /opt/dsh-remote/node/bin/node /opt/dsh-remote/app/gateway/src/cli.ts doctor
```

## 5. 认证：访问 Token 与设备管理

- 未认证请求：HTML 导航一律 302 到 `/__dsh_remote__/login`；API/XHR 返回 401 JSON。
- Token 校验：服务端只存 SHA-256（首启时由明文 env 哈希落盘），恒时比较；
  连续错 5 次锁 IP 15 分钟，全部进审计日志（`data/logs/audit.jsonl`）。
- 登录成功 = 自动配对成设备（名称默认按 UA 推导，如 `iPad · 浏览器`），
  之后凭 httpOnly+Secure Cookie 长期有效（缺省 30 天），可在设备列表查看/吊销：

```bash
# 服务器（裸机）
sudo /opt/.../cli.ts devices            # 列出设备
sudo /opt/.../cli.ts revoke dev-xxxx    # 吊销单台
# Docker
docker exec dsh-remote-gateway node src/cli.ts devices
```

- **轮换 Token**：改 env 后重启即对新登录生效；已登录设备不受影响。
- **全体下线**：清空 `state/devices.json` 再重启。
- 未配置 Token 时 edge 会退化为配对码认证（兼容），但 doctor 会告警——
  公网入口请务必配置 Token。

> 与 desktop 角色的关键差别：edge **不复用**「访客密钥即准入」的捷径
> （`visitorKeyAdmits`），因为 edge 本身就是公网页面入口，人人必须过门禁。

## 6. 移动 hook 布局说明

- 注入物：网关给上游 HTML 追加 `<script src="/__dsh_remote__/mobile.js" defer>`
  与断点变量 `window.__DSHR_MOBILE__={breakpoint:980}`（上游缺 viewport meta 时补齐）。
- 脚本是 Android 壳 `res/raw/mobile.js` 的 web fork，激活条件从「仅竖屏」改为
  「仅视口宽度 ≤ 断点」：iPhone 全程 hook；iPad 竖屏 hook；iPad 横屏 ≥1024px
  自然回到官方 DSH 桌面布局。抽屉侧栏、设置全屏页、浮动选框钳制等行为与安卓端一致。
- 断点可用 `DSHR_MOBILE_BREAKPOINT` 调整（240–4096）；`DSHR_MOBILE_ENABLED=false`
  整体停用。
- 双网关注入幂等：隧道对端 PC 网关也会注入 PWA 标记，edge 只补移动块，不会重复。

## 7. 环境变量速查

| 变量 | 缺省 | 说明 |
|---|---|---|
| `DSHR_ROLE` | desktop | `edge` 启用服务器角色 |
| `DSHR_LISTEN_HOST` / `_PORT` | 127.0.0.1 / 18443 | 监听面 |
| `DSHR_ACCESS_TOKEN` | — | 前置访问 Token（明文仅用于首启哈希持久化） |
| `DSHR_TOKEN_LOGIN_DAYS` | 30 | 登录后设备 Cookie 有效期 |
| `DSHR_TRUST_PROXY_XFF` | false | 信任反代 X-Forwarded-For 作限流键：仅 `=true` 且直连来源为回环（同机可信反代，如宿主机 Caddy）**或**命中 `DSHR_TRUST_PROXY_CIDRS` 时，取该头最左一跳；其余来源伪造的 XFF 一律不采信。反代侧约定（Caddy 覆写该头、禁止透传外部值）见 `deploy/docker/Caddyfile.example` |
| `DSHR_TRUST_PROXY_CIDRS` | 空 | 受信代理网段（逗号分隔 CIDR 或精确 IP，如 `172.16.0.0/12`）。compose 桥接拓扑下让 XFF 信任生效的关键；只应填反代所在网段，配宽了伪造 XFF 可绕过限流。仅 `DSHR_TRUST_PROXY_XFF=true` 时参与判定 |
| `DSHR_UPSTREAM_HOST` / `_PORT` | 127.0.0.1 / 52392 | 直连上游地址（缺省值；实际请设为 `<DSH 实际端口>`） |
| `DSHR_UPSTREAM_TLS` | 隧道形态推断 true | 上游是否 HTTPS（PC 网关是自签 HTTPS） |
| `DSHR_MOBILE_ENABLED` / `_BREAKPOINT` | true / 980 | 移动 hook 开关与断点 |
| `DSHR_TLS_CERT` / `DSHR_TLS_KEY` | — | 手工 PEM 证书（一般交给 Caddy，不用） |
| `DSHR_FRP_ROLE` | off | `off` / `visitor` / `frps` |
| `DSHR_FRP_SERVER_ADDR` | — | 外部 frps 地址（visitor 必填） |
| `DSHR_FRP_SERVER_PORT` | 7000 | frps 控制口（frps 监听 / visitor 目标） |
| `DSHR_FRP_NAME` | dsh-remote | 隧道名，必须与 PC 端一致 |
| `DSHR_VISITOR_BIND_PORT` | 18443 | visitor 本地绑定端口（= 生效上游） |
| `DSHR_EDGE_CONSUME` | stcp | frps 角色消费方式：`stcp` / `entry-port` |
| `DSHR_FRPS_ALLOW_PORTS` | — | frps allowPorts，如 `18400-18500,8443` |

env 覆盖 config.json；两者都缺省时回落内置默认值。

## 8. 故障排查

| 现象 | 排查 |
|---|---|
| 登录页能开、登录后一直 502 | 隧道没通：`logs` 找 `[frpc]`/`[frps]`/`[frpc-visitor]` 行。常见：token 不一致、`DSHR_FRP_NAME` 与 PC 端 `frp.name` 不同、PC 用了 xtcp 而 edge 在等 stcp 代理名（见 §1 提示） |
| frps 反复打印 `register visitor conn error … doesn't exist` | PC 侧还没注册上来（刚启动属正常）；持续出现则检查 PC frpc 是否在跑、token 是否一致 |
| health 通但手机打不开域名 | Caddy 证书未签发成功：`docker compose logs caddy`；确认域名解析与 80/443 放行 |
| 错 Token 提示「已临时锁定」 | 5 次失败锁 15 分钟，等或重启网关清内存桶 |
| 手机端无移动布局 | ① 视口宽度 > 断点（iPad 横屏属预期）；② `DSHR_MOBILE_ENABLED=false`？③ 看 HTML 里有没有 `mobile.js` 标记（双网关注入被跳过的回归由 smoke-edge 覆盖） |
| WS 会话流断开 | 确认流量确实经过网关：直连上游会绕过 WS 认证与改写；Caddy 默认支持 WS，无需配置 |

本地全链路验证（无需 VPS）：本机放好 frp 二进制后运行 `pnpm smoke:edge:frp`，
它会在同一台机器上模拟「edge 容器(frps+visitor) ↔ PC 网关(frpc/stcp) ↔ 假上游」
整条链路并断言登录、注入与代理。
