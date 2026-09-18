# 版本与发布规范

DSH-Remote 的版本号由两部分拼成：

```
<deepseek-harness 基线版本>.<发版号>
└────── 跟随上游 ──────┘ └─ 自己维护 ─┘
```

## 规则

1. **基线段**与 [deepseek-harness（DSH Desktop）](https://github.com/deepseek-ai) 当前版本
   完全一致。例如 harness 为 `0.1.1-rc.2`，我们的版本就以 `0.1.1-rc.2.` 开头。
2. **发版号**是我们自己的递增计数：harness 某个基线下第一次发布为 `.1`，
   之后**每次发新版都 +1**——哪怕代码只改了一行、甚至没有代码改动（重新打包也要新号，
   否则 tag 和 APK 无法区分）。
   例：`0.1.1-rc2` → 我们 `0.1.1-rc2.1`、`0.1.1-rc2.2`、……
3. **切换基线**：harness 出新版本时用 `bump --base <新版本>` 切换，发版号**重置回 1**。
4. 约束：各数字段保持两位数以内（<100），这是 versionCode 折叠推导的前提；
   tag 固定格式 `v<完整版本号>`，如 `v0.1.1-rc.2.6`。

## 单一来源

根 [`package.json`](../package.json) 是唯一权威：

| 位置 | 内容 | 维护方式 |
|---|---|---|
| 根 `package.json` → `version` | 完整版本号（权威来源） | 只能通过 `scripts/version.mjs` 修改 |
| 根 `package.json` → `dshVersion` | harness 基线版本 | 同上 |
| `packages/gateway/package.json`、`packages/plugin/package.json` → `version` | 与根同步的副本 | 由脚本自动写，不要手改 |
| `android/app/src/main/AndroidManifest.xml` | **不再写死**版本 | APK 打包时注入 |
| APK `versionName` / `versionCode` | 构建时从根 package.json 推导 | `android/build.ps1` 自动处理 |
| 根 `package.json` → `config.frpVersion` | frp 版本单一来源（OPS-05） | 安装脚本/Dockerfile 从该字段读取 |
| 本文档「当前状态」表 | 版本快照 | `version.mjs bump` 自动同步（OPS-07） |

### versionCode 推导

Android 要求 versionCode 为单调递增整数。`android/build.ps1` 把版本号的数字段
逐个按百进制折叠：

```
0.1.1-rc.2.6  →  ((0·100+1)·100+1)·100+2)·100+6 = 1010206
0.1.1-rc.2.5  →                                 = 1010205   （< 1010206 ✓）
```

任意一段变大 ⇒ 整数变大，升级安装覆盖无忧。（历史硬编码值 `31` 已被自然超越。）

## 日常操作

```powershell
pnpm ver            # 显示当前版本、基线、发版号
pnpm ver:next       # 预览下一个版本号（不改文件）
pnpm ver:bump       # 发版号 +1 并同步三个 package.json，打印发布命令
pnpm ver:bump --base 0.1.2-rc.1   # harness 升级到 0.1.2-rc.1，发版号重置为 1
```

## 发布流程（runbook）

```powershell
pnpm ver:bump                          # 1. 递增版本号（提交信息照脚本输出抄即可）
git add -A && git commit -m "release: v0.1.1-rc.2.6"
git tag v0.1.1-rc.2.6                  # 2. 打 tag
git push && git push origin v0.1.1-rc.2.6   # 3. 推送
```

推送 tag 触发 [.github/workflows/release.yml](../.github/workflows/release.yml)：
CI 先校验 **tag == `v` + package.json 版本**（不一致直接失败），再构建签名 APK、按 tag
重命名为 `dsh-remote-0.1.1-rc.2.6.apk`（**不带 `v` 前缀**，与 release.yml 实际行为一致，
即 `dsh-remote-<版本号>.apk`）并发布 GitHub Release。

> **发布签名（CI-01）**：为保证跨版本 APK 签名一致（可覆盖升级，无需卸载重装），
> CI 从仓库 Secrets 解码固定 keystore 到 `~/.android/dsh-remote.jks`，并以
> `DSH_RELEASE=1` + `DSH_KEYSTORE_PASS` + `DSH_KEY_ALIAS` 调 `android/build.ps1`。
> 仓库管理员需配置 `RELEASE_KEYSTORE_B64` / `RELEASE_KEYSTORE_PASS` /
> `RELEASE_KEY_ALIAS` 三个 Secret；未配置时（fork、无 Secret 的手动触发）
> CI 跳过发布签名构建并给出提示。

> 忘记 bump 就打 tag？CI 会拦下；此时删掉本地/远端 tag，bump 后重打即可：
> `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`

## 当前状态

| 项 | 值 |
|---|---|
| deepseek-harness 基线 | `0.1.5-rc.1` |
| 当前已发布版本 | `0.1.5-rc.1.5`（tag `v0.1.5-rc.1.5`） |
| 下一次发布 | `0.1.5-rc.1.6` |

> 本表为快照，以根 package.json 为准；`version.mjs bump` 会自动同步上表（OPS-07）。
