# DSH-Remote

> 让手机随时随地安全访问本机运行中的 **DSH Desktop / DeepSeek Harness**。  
> 保持与桌面端 100% 一致的原生交互体验：会话列表、实时流式响应、工具调用、任务中止与交互审批全功能支持。

[![CI](https://github.com/xiufeigo/DSH-Remote/actions/workflows/ci.yml/badge.svg)](https://github.com/xiufeigo/DSH-Remote/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)]()
[![DSH Baseline](https://img.shields.io/badge/DSH%20Baseline-0.2.0--rc.2-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

---

## 目录
- [系统架构与设计方案](#系统架构与设计方案)
  - [1. 零侵入旁路网关设计](#1-零侵入旁路网关设计)
  - [2. 网络拓扑与传输模型](#2-网络拓扑与传输模型)
  - [3. 多端自适应机制 (Mobile Hook)](#3-多端自适应机制-mobile-hook)
  - [4. 双层缓存与离线/省电设计](#4-双层缓存与离线省电设计)
  - [5. 纵深防御安全模型](#5-纵深防御安全模型)
- [核心功能特性](#核心功能特性)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
  - [模式 A：Android 壳 App + 访客打洞（推荐，公网零暴露）](#模式-aandroid-壳-app--访客打洞推荐公网零暴露)
  - [模式 B：Edge 边缘部署（iOS / Safari 浏览器直达）](#模式-bedge-边缘部署ios--safari-浏览器直达)
  - [模式 C：家庭局域网模式（免 VPS）](#模式-c家庭局域网模式免-vps)
  - [设备配对与管理](#设备配对与管理)
  - [随 DSH 自启与可视化设置](#随-dsh-自启与可视化设置)
- [开发与测试](#开发与测试)
- [相关文档与路线图](#相关文档与路线图)

---

## 系统架构与设计方案

```
📱 移动端：Android 壳 App (内嵌 frpc visitor) / 移动浏览器 (iOS PWA)
       │ HTTPS / WSS 端到端加密（支持客户端证书锁定）
       ▼
☁️ 远端中继：VPS · frps（访客模式仅开放内部控制口，无公网 Web 暴露）
       │
       ├─ [xtcp 模式] P2P 打洞成功 ➔ 手机 ⇄ PC 直连，流量完全不过 VPS
       └─ [stcp 模式] 打洞失败毫秒级回退 ➔ 经 VPS 安全加密中转
       ▼
🚪 本机网关：DSH-Remote Gateway @ 127.0.0.1:18443
       │ 旁路透明代理 · 启动令牌/Cookie 交换 · Host/Origin 重写 · 设备鉴权
       ▼
💻 宿主应用：DeepSeek Harness (DSH Desktop) @ 127.0.0.1:<动态端口>
       （零侵入：不修改 DSH 源码，完全保持官方安全信任栅栏）
```

### 1. 零侵入旁路网关设计
DSH 官方出于本地执行安全考虑，强制监听回环接口 `127.0.0.1`，并对 `/api` 施加了严格的 Host/Origin 信任栅栏；同时自 `0.1.2` 起引入了宿主启动令牌与 Cookie 鉴权（无有效令牌直接返回 401）。

DSH-Remote 坚持**不修改 DSH 一行源码**的原则，采用独立旁路网关架构：
- **安全栅栏穿透**：网关在 PC 本地代为发起请求，并将外部请求的 `Host` / `Origin` / `Referer` 重写为本地回环标识，顺畅通过 DSH 安全验证。
- **令牌自动交换与自愈**：随 Cordis 插件获取宿主动态启动令牌，网关内部向上游换取会话 Cookie 并注入后续反代连接；对下则彻底剥离会话 Cookie，手机端永不接触特权令牌。
- **端口自动跟随**：DSH 桌面端重启可能发生端口漂移，网关具备端口自动探测和交接能力，无感自愈。

### 2. 网络拓扑与传输模型
提供三种适配不同场景的网络接入形态：

| 模式 | 适用场景 | 拓扑特点 | 公网暴露面 | 性能与流量 |
|---|---|---|---|---|
| **xtcp 打洞直连**（推荐） | Android 壳 App | 手机与 PC 通过 STUN/P2P 打洞直连 | **零端口暴露**（仅 frps 控制口） | 延迟最低，流量直达不过 VPS |
| **stcp 安全中转** | Android 壳 App (对称 NAT) | 流量经由自有 VPS 安全隧道中继 | **零端口暴露** | 受限于 VPS 带宽，稳定可靠 |
| **Edge 边缘网关** | iOS / iPad / 纯浏览器 | VPS 部署轻量网关，Caddy 自动 HTTPS + Token | 仅开放 1 个 HTTPS 端口 | 零客户端安装，Safari 即可访问 |
| **LAN 局域网直连** | 家庭/办公室内网 | 手机直接访问 PC 内网 IP | 无公网暴露 | 本地千兆直连，无需 VPS |

### 3. 多端自适应机制 (Mobile Hook)
为保证在不同尺寸屏幕上的极致体验，注入层通过原生底层的 `smallestScreenWidthDp` 严格区分设备档位（彻底杜绝 CSS 视口虚高导致的误判）：

- **手机档 (`sw < 600`)**：
  - **流式单栏布局**：隐藏桌面端多余栏目，侧边栏改为平滑跟手抽屉（基于 CSS 变量硬件加速位移）。
  - **键盘防遮挡与焦点守护**：智能拦截非手势的程序化自动聚焦（如切换会话、打开子面板），防止软键盘无故弹起；输入时保证输入框完整可见。
  - **系统栏沉浸避让**：WebView 铺满全屏，系统栏置为透明，四向边距统一通过 `--dshr-inset-*` CSS 变量安全让位。
  - **系统返回键多层拦截**：返回键优先收起弹层，再收起抽屉，最后返回连接设置页，绝不误退桌面。
- **平板 / 折叠屏展开 (`sw ≥ 600`)**：
  - **遵循「零侵入契约」**：完全呈现 DSH 官方桌面端多栏布局，移动 hook 保持最小化，不在页面中注入额外 DOM 节点，原汁原味还原桌面端体验。

### 4. 双层缓存与离线/省电设计
- **静态资源首屏秒开**：
  - 官方前端全量资源通过 **App 原生磁盘直写** 与 **Service Worker** 双层缓存（URL 内容哈希寻址与 `rev` 版本控制）。
  - 首次填充后，后续进入静态资源 **0 网络传输**，冷启动由 14s+ 缩短至 5s 内，稳态单次进入网络开销仅百 KB 级心跳。
- **省电与连接健康自愈**：
  - **分级探针与按需降频**：后台运行保持 0 探针；健康前台探针自适应降至 60s 节拍；仅在切回前台或断网时启动 500ms 快探。
  - **精准断线判定**：区分传输层真实关闭与心跳抖动，自愈动作绝不主动掐断正常长连接；支持卡住自动探测与平滑重载恢复。

### 5. 纵深防御安全模型
- **网络层隔离**：默认仅监听 `127.0.0.1`，通过访客模式打洞，公网扫描无法探测到任何 DSH 端口。
- **认证门禁**：采用 Crockford-Base32 8 位一次性配对码（10 分钟有效、用后即焚），换取长效 `dr_device` 设备令牌（HttpOnly Cookie，服务端仅存储 SHA-256 哈希）。
- **抗爆破与限流**：连续 5 次配对失败自动锁定 IP 15 分钟；单 IP 滑动窗口限流。
- **传输层证书锁定**：Android 壳 App 在扫码时同步预置自签证书指纹，连接时进行硬编码级别的指纹锁定（Cert Pinning），免疫中间人攻击。
- **管理端点防护**：特权运维 API（`/__dsh_remote__/admin/*`）强制校验 PC 本地专属生成的 `adminToken`，公网侧无法触达。

---

## 核心功能特性

- 🖥️ **完整功能映射**：完美呈现会话历史、流式生成、代码高亮、交互确认卡片、任务终止与多 Agent 协同状态。
- 📱 **原生级移动体验**：平滑抽屉滑动交互、右滑手势关闭面板、长按品牌区快捷呼出连接设置、软键盘弹出自适应。
- ⚡ **毫秒级回退与打洞**：P2P 打洞优先，打洞超时优化至 800ms，连续打洞失败自动粘性回退至中转隧道，连接迅速不等待。
- 🔒 **全流程开箱即用安全**：一次性配对码扫码直连，免除手动搬运复杂证书与长密钥的繁琐流程。
- 🧩 **DSH 官方生态融合**：随 DSH Desktop 自动拉起的 Cordis 插件，深度集成官方「设置 → 插件 → DSH Remote」管理卡片。
- 🌐 **多平台客户端**：提供 Android 极简专用壳（内嵌 frpc）、Edge 服务器 Docker 部署（覆盖 iOS/iPadOS 浏览器直连）。

---

## 仓库结构

| 目录 / 文件 | 说明 |
|---|---|
| `packages/gateway/` | 网关核心（TypeScript，支持 PC 本地 desktop 与 VPS edge 两种运行角色） |
| `packages/plugin/` | DSH Cordis 插件（随 DSH 进程自启网关，提供官方插件设置卡片） |
| `android/` | Android 原生壳 App（内嵌 frpc visitor、证书锁定与自适应 Web 容器） |
| `deploy/docker/` | Edge 部署配置（Dockerfile + docker-compose + Caddy 自动 HTTPS） |
| `scripts/` | 运维与一键部署脚本（VPS frps 安装、Edge 部署、本地体检与冒烟测试） |
| `docs/` | 深入设计文档（[架构与安全](docs/architecture.md)、[VPS搭建](docs/vps-frps-setup.md)、[Edge部署](docs/edge-deployment.md)、[发版规范](docs/versioning.md)） |
| `CHANGELOG.md` | 历次发布变更日志与深度缺陷排查复盘（RCA）归档 |

---

## 快速开始

### 模式 A：Android 壳 App + 访客打洞（推荐，公网零暴露）

#### 1. VPS 安装 frps 控制服务
在你的 VPS（Debian/Ubuntu/CentOS 等）上执行：
```bash
# 自动生成随机密钥并安装启动 frps
sudo bash scripts/install-frps.sh
# 或显式指定 token: sudo bash scripts/install-frps.sh --token <自定义密钥>
```
> 访客模式下，VPS 仅监听 frps 控制端口（默认 7000），无需开放任何 HTTP 业务端口。详见 [docs/vps-frps-setup.md](docs/vps-frps-setup.md)。

#### 2. PC 端配置并启动网关
在运行 DSH Desktop 的 PC 端创建配置：
```powershell
mkdir ~\.dsh-remote
@'
{
  "listenPort": 18443,
  "upstreamPort": "<DSH 实际端口，如 19387>",
  "frp": {
    "enabled": true,
    "serverAddr": "<VPS 公网 IP>",
    "serverPort": 7000,
    "mode": "xtcp",
    "name": "dsh-remote"
  }
}
'@ | Set-Content ~\.dsh-remote\config.json -Encoding utf8

# 启动网关
pnpm start
# 运行环境自检
node packages/gateway/src/cli.ts doctor
```
> `upstreamPort` 是 DSH 桌面端 Web GUI 的端口。若桌面端重启端口漂移，网关默认开启的 `autoFixUpstreamPort` 会自动探测并回写修正。

#### 3. 手机扫码导入
在 PC 端生成访客二维码：
```powershell
node packages/gateway/src/cli.ts visitor --mode xtcp
```
终端将输出配置二维码及连接 URL。使用安装好的 **Android 壳 App** 扫码，App 将自动接管导入配置、建立 P2P 隧道并进入 DSH 界面。

---

### 模式 B：Edge 边缘部署（iOS / Safari 浏览器直达）

适合 iPhone / iPad 用户通过移动端浏览器安全访问，网关直接托管在公网 VPS 上：
```bash
cd deploy/docker
cp .env.example .env     # 配置域名与前端访问 Token
docker compose up -d --build
```
或者通过一键裸机脚本部署：
```bash
sudo bash scripts/install-edge.sh --token <访问Token>
```
部署完成后，直接使用手机浏览器访问 `https://<你的域名>` 登录即可。详见 [docs/edge-deployment.md](docs/edge-deployment.md)。

---

### 模式 C：家庭局域网模式（免 VPS）

在家庭或办公内网中，无需任何外部服务器即可体验：
1. 修改 PC 配置 `~/.dsh-remote/config.json`：
   ```jsonc
   { "listenHost": "0.0.0.0", "listenPort": 18443 }
   ```
2. 在 Windows 防火墙中放行 `18443` 端口。
3. 手机浏览器打开 `https://<PC局域网IP>:18443`，按提示输入配对码完成连接。

---

### 设备配对与管理

当通过浏览器访问或初次连接未认证设备时，需要进行安全配对：
```powershell
# 生成 10 分钟有效的 8 位一次性配对码
node packages/gateway/src/cli.ts pair --name 我的手机

# 查看当前已授权设备
node packages/gateway/src/cli.ts devices

# 吊销指定设备权限
node packages/gateway/src/cli.ts revoke <设备ID>
```

---

### 随 DSH 自启与可视化设置

将网关注册为 DSH 插件，实现跟随 DSH 启动以及在桌面端图形化配置：
```powershell
cd packages/plugin
node scripts/install.mjs
```
安装完成后重启 DSH Desktop，在 **设置 → 插件** 页面中将出现 **「DSH Remote」** 设置卡片，支持图形化切换隧道模式、修改 VPS 地址与一键生成配对码。

---

## 开发与测试

```bash
# 安装依赖
pnpm install

# 类型检查与静态验证
pnpm typecheck

# 核心测试套件
pnpm smoke           # 桌面端角色基础冒烟测试
pnpm smoke:edge      # Edge 角色功能冒烟测试
pnpm test:fixes      # 历史缺陷回归防护钉桩
pnpm test:desktop    # DSH 宿主兼容性测试
pnpm test:mobile     # 移动布局与 Hook 自测（需 Chrome）
pnpm test:terminal   # 手机档终端输入面（焦点守卫 / IME 抬起矩形）行为钉桩（需 Chrome）
pnpm test:device     # 设备档位自适应全真测试（基于真实 DSH 页面 CDP）
```

**Android 壳构建与测试**：
```powershell
# 运行 Android 单元测试契约
pwsh -File android\test-direct-nodes.ps1
pwsh -File android\test-immersive.ps1
pwsh -File android\test-backkey.ps1

# 构建 Release APK（输出至 android\dist\dsh-remote.apk）
pwsh -File android\build.ps1

# 构建调试包（开启 WebView DevTools 取证）
pwsh -File android\build.ps1 -Debug
```

---

## 相关文档与路线图

- [系统架构与安全模型设计](docs/architecture.md)
- [VPS frps 搭建与穿透排查指南](docs/vps-frps-setup.md)
- [Edge 服务器部署指南 (iOS浏览器直达)](docs/edge-deployment.md)
- [版本发布与命名规范](docs/versioning.md)
- [Android 壳 App 技术细节与构建](android/README.md)
- [版本变更历史与缺陷分析归档](CHANGELOG.md)

### 规划路线
- [x] 旁路网关与 DSH 0.2.0-rc.2 全链路兼容
- [x] frp P2P 打洞 (xtcp) 与安全中转 (stcp)
- [x] Android 原生壳 App（含内嵌 frpc、双层落盘缓存与证书锁定）
- [x] 手机与平板原生档位自适应交互
- [x] Edge 边缘网关部署（iOS 浏览器开箱即用）
- [ ] Tailscale (tsnet) 传输协议适配器
- [ ] iOS 原生壳 App
