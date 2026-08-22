# 架构决策与安全模型

记录 DSH-Remote 的关键取舍，避免未来"为什么当初这么设计"的考古。

## 1. 为什么是"旁路网关"，而不是改 DSH 绑定地址

DSH 官方源码（`dsh-web-app`）明确禁止 `--host 0.0.0.0`：

> `--host 0.0.0.0 is intentionally not supported yet for safety: it would expose
> remote code execution to the network; use 127.0.0.1 instead`

且 `/api` 有浏览器信任栅栏（DNS rebinding 防护，只认回环 authority）。

因此本项目的立场是：**不改 DSH 一行代码**。网关作为旁路进程：

- 对内：把 `Host`/`Origin`/`Referer` 改写成 `127.0.0.1:<port>` 回环形态，
  天然通过信任栅栏；
- 对外：自己管认证、限流、TLS、审计——安全边界完全在我们手里。

## 2. 传输层为什么选 frp 主线

需求约束：国内使用、随时随地（蜂窝网络）、PC 在家宽 NAT 后无公网 IP。

| 候选 | 结论 |
|---|---|
| Tailscale (tsnet) | 可行但控制平面/DERP 国内偶发抽风；留作适配器二期 |
| frp + 自有 VPS | ✅ 国内稳、内置成本最低（官方二进制直接托管）、与壳 App 证书锁定契合 |
| Cloudflare Tunnel | 国内速度不稳 |
| 路由器端口映射 | 家宽 80/443 封锁 + 暴露面太大，否决 |

架构上传输层是**可插拔适配器**：`frp.ts` 只负责"把 VPS 入口端口搬到
127.0.0.1:18443"，网关核心对此无感知；将来加 `tsnet.ts` 同样只是搬运工。

## 3. 安全模型

威胁建模：攻击者能扫到 `https://<VPS>:8443`，除此之外一无所有。

### 分层防御

```
第0层 网络    网关仅监听 127.0.0.1 —— LAN/WAN 直接不可见；frpc 是唯一入口
第1层 传输    手机→网关 TLS(自签+指纹)；frpc↔frps TLS 隧道；VPS 看不到明文
第2层 认证    一次性配对码 → 设备 Token(httpOnly Cookie)
第3层 抗滥用  配对失败5次锁IP15分钟；每IP滑动窗口限流；全部进审计日志
第4层 隔离    设备 Cookie 不透传上游；上游响应原样返回不注入除 PWA 外内容
```

### 配对协议

1. PC 终端 `dsh-remote pair` → 生成 Crockford-Base32 8 位码（如 `XK4M-P2VW`），
   写入 `pending-codes.json`，TTL 10 分钟，**一次性消费**
2. 手机浏览器打开入口 → 未认证请求一律重定向配对页
3. 提交码 → 校验并立即删除 → 签发 `dr_device` Token（32B 随机，
   httpOnly + Secure + SameSite=Lax，服务端只存 SHA-256）
4. 之后该设备所有请求凭 Cookie 通过；吊销即时生效（哈希比对失败）

### 为什么 Token 放 Cookie 而不是 localStorage

- httpOnly 让 XSS 拿不走 Token（DSH 页面渲染模型输出，风险面小但不为零）
- Secure 标记配合我们的强制 HTTPS
- 服务端存哈希：`secrets.json`/数据库泄露也不等于设备被接管

### 已知取舍（诚实清单）

- **自签证书告警**：手机浏览器首次访问需手动信任。壳 App 阶段用证书锁定消除；
  若你持有域名，也可给网关换 Let's Encrypt 证书（DNS-01 验证无需开入站端口）。
- **配对码人肉通道**：码经终端二维码传递，本质是"物理在 PC 旁"的带外证明。
  远程场景下先在 PC 上生成再通过已有可信渠道发给自己的手机。
- **VPS 是单点**：frps 挂了远程就断（本地局域网访问不受影响）；systemd 自动拉起。
- **限流键是 socket 地址**：经过 frp 后所有请求同源（都来自本机 frpc），限流退化为
  全局桶——阈值按单人使用标定，够用；壳 App 直连模式可恢复按 IP 精确限流。

### 安全审计记录（2026-08-22，交付前专项）

逐行复审认证/配对/代理路径，修复三处、确认若干项安全：

| 发现 | 等级 | 处置 |
|---|---|---|
| 配对页 `next` 回跳参数可注入 JS（`location.href='${next}'`）——攻击者可构造恶意配对链接钓鱼窃取一次性码 | 高 | `safeNext` 白名单化（禁引号/反斜杠/尖括号/双斜线）+ `JSON.stringify` 嵌入；冒烟新增注入回归用例 |
| 升级请求按原始字节直通上游，`req.url` 理论上可夹带控制字符造成请求走私 | 中 | HTTP 与 WS 两条路径均在入口拦 `[\r\n\0]`（纵深防御，Node 解析器本身也会拦） |
| 管理端点仅校验来源 IP，局域网监听模式下可被用户浏览器跨站触发（如恶意网页 POST revoke） | 低 | 增加 Origin 同源闸门：无 Origin（CLI）或 Origin 为本机才放行 |
| 设备表每请求读盘 | 性能 | 1.5s TTL 内存缓存（CLI 直改文件场景最多延迟 1.5s 可见） |
| 审计日志无限增长 | 运维 | >5MB 自动轮转为 `.1` |
| Cookie 解析、配对码比较（timingSafeEqual）、body 64KB 上限、WS head 4KB 上限、限流/锁定 | — | 复审确认无问题 |

## 4. 关键实现细节备忘

- **WS 直通**：升级请求认证后按原始 TCP 字节管道转发（不解析帧），只改写
  `host`/`origin` 头。注意 `Connection`/`Upgrade` 是升级跳必需头，绝不能当逐跳头剥掉
  （冒烟测试覆盖了这一回归）。
- **HTML 注入**：仅对 `200 + text/html` 且 ≤2MB 的响应整包缓冲注入 PWA 标记，
  注入时删 `transfer-encoding` 重算 `content-length`；超限或非 HTML 一律原样流式。
- **TS 运行方式**：Node ≥24 原生 strip-types 运行 `.ts`，因此全仓无构建步骤；
  代价是不能用 enum/namespace/参数属性等非可剥离语法（已遵守）。
- **端口漂移**：DSH GUI 端口可能随重启变化（OS 分配）。`upstreamPort` 进配置 +
  `doctor` 指纹探测兜底。

## 5. 二期路线图

1. **tsnet 适配器**：Go sidecar 内嵌 tailnet，免 VPS 免公网的备选通道
2. **自研壳 App**：
   - WebView 加载网关 + 自签证书锁定（指纹走配对二维码下发）
   - STCP 访客模式（frp secret tcp）：VPS 连对外端口都不开，App 内嵌 frpc visitor 才能连入
   - Android 先行（APK 直接分发），iOS 视开发者账号条件
3. **推送通知**：会话完成/审批请求到达时推送（依赖壳 App 的前台服务）
4. **多设备管理 UI**：桌面端可视化设备列表与吊销
