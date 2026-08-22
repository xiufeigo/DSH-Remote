#!/usr/bin/env bash
# ============================================================================
# dsh-remote · VPS 端 frps 一键安装脚本（Debian/Ubuntu/CentOS 通用）
#
# 用法（在本机生成好 token 后拷过去，或让脚本自动生成并回显）：
#   curl -fsSL <本脚本URL> | bash -s -- --token <与PC一致的密钥>
#   或下载后执行：
#   bash install-frps.sh --token <密钥> [--control-port 7000] [--entry-port 8443]
#   bash install-frps.sh --show-token     # 查看已安装实例的 token
#
# 脚本行为：
#   1. 从 GitHub Releases 下载 frp 稳定版（失败自动尝试 ghproxy 镜像）
#   2. 安装 /usr/local/bin/frps + /etc/dsh-remote/frps.toml
#   3. 写入 systemd 服务并开机自启
#   4. 尽力而为放行防火墙端口（ufw/firewalld），云厂商安全组需手动放行
#
# 注意：auth.token 必须与你 PC 上 ~/.dsh-remote/state/secrets.json 的
#       frpAuthToken 一致（dsh-remote doctor 会提示核对）。
# ============================================================================
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.61.1}"
INSTALL_DIR="/usr/local/bin"
CONF_DIR="/etc/dsh-remote"
SERVICE_NAME="frps-dsh-remote"

CONTROL_PORT=7000
ENTRY_PORT=8443
TOKEN=""
SHOW_TOKEN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)        TOKEN="$2"; shift 2 ;;
    --control-port) CONTROL_PORT="$2"; shift 2 ;;
    --entry-port)   ENTRY_PORT="$2"; shift 2 ;;
    --show-token)   SHOW_TOKEN=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 运行（sudo bash $0 ...）" >&2
  exit 1
fi

if [[ "$SHOW_TOKEN" -eq 1 ]]; then
  [[ -f "$CONF_DIR/frps.toml" ]] || { echo "尚未安装" >&2; exit 1; }
  grep 'auth.token' "$CONF_DIR/frps.toml"
  exit 0
fi

echo "▶ 下载 frp v$FRP_VERSION"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac
TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
TMPDIR_DL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DL"' EXIT

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --connect-timeout 15 -o "$out" "$url" && return 0
  else
    wget -q -T 15 -O "$out" "$url" && return 0
  fi
  return 1
}

if ! download "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}" "$TMPDIR_DL/$TARBALL"; then
  echo "  GitHub 直连失败，改走镜像…"
  download "https://ghproxy.net/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}" "$TMPDIR_DL/$TARBALL" \
    || { echo "下载失败，请手动放置 ${TARBALL} 到 $TMPDIR_DL 后重跑" >&2; exit 1; }
fi
tar -xzf "$TMPDIR_DL/$TARBALL" -C "$TMPDIR_DL"
install -m 755 "$TMPDIR_DL/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" "$INSTALL_DIR/frps"

# ── token ────────────────────────────────────────────────────────────────────
if [[ -z "$TOKEN" ]]; then
  if [[ -f "$CONF_DIR/frps.toml" ]] && grep -q 'auth.token' "$CONF_DIR/frps.toml"; then
    TOKEN="$(grep 'auth.token' "$CONF_DIR/frps.toml" | sed 's/.*= *"//; s/"//')"
    echo "▶ 复用已存在的 token"
  else
    TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 43)"
    echo "▶ 自动生成 token：$TOKEN"
    echo "  （请把它同步到 PC 的 config/secrets —— 见 README）"
  fi
fi

echo "▶ 写配置 $CONF_DIR/frps.toml"
mkdir -p "$CONF_DIR"
cat > "$CONF_DIR/frps.toml" <<EOF
# 由 dsh-remote install-frps.sh 生成
bindAddr = "0.0.0.0"
bindPort = ${CONTROL_PORT}

auth.token = "${TOKEN}"

# 只允许 PC 网关申请的入口端口，缩小被滥用面
allowPorts = [
  { start = ${ENTRY_PORT}, end = ${ENTRY_PORT} }
]

log.to = "$CONF_DIR/frps.log"
log.level = "info"
log.maxDays = 7
EOF
chmod 600 "$CONF_DIR/frps.toml"

echo "▶ systemd 服务"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=dsh-remote frp server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${INSTALL_DIR}/frps -c ${CONF_DIR}/frps.toml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "▶ 防火墙放行（尽力而为）"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${CONTROL_PORT}/tcp" >/dev/null || true
  ufw allow "${ENTRY_PORT}/tcp" >/dev/null || true
  echo "  ufw 已放行 ${CONTROL_PORT}、${ENTRY_PORT}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${CONTROL_PORT}/tcp" >/dev/null || true
  firewall-cmd --permanent --add-port="${ENTRY_PORT}/tcp" >/dev/null || true
  firewall-cmd --reload >/dev/null || true
  echo "  firewalld 已放行 ${CONTROL_PORT}、${ENTRY_PORT}"
else
  echo "  未检测到活动防火墙，跳过（记得在云厂商安全组放行 TCP ${CONTROL_PORT} 与 ${ENTRY_PORT}）"
fi

sleep 1
systemctl --no-pager --lines 5 status "$SERVICE_NAME" || true

cat <<EOF

✅ 安装完成
   控制端口:  ${CONTROL_PORT}/tcp   （frpc 连接）
   入口端口:  ${ENTRY_PORT}/tcp   （手机访问 https://<本机IP>:${ENTRY_PORT}）
   token:     $TOKEN
   配置文件:  $CONF_DIR/frps.toml

下一步（在 PC 上）：
   1. 把 token 填入 ~/.dsh-remote/config.json 的 frp.authToken
      （或保持缺省，让网关自动生成的值与本脚本 --token 一致）
   2. config.json 设置:
        { "frp": { "enabled": true, "serverAddr": "<本机公网IP>",
                   "serverPort": ${CONTROL_PORT}, "remotePort": ${ENTRY_PORT} } }
   3. 云安全组放行上述两个 TCP 端口
   4. PC 上运行 dsh-remote start，然后手机访问 https://<VPS IP>:${ENTRY_PORT}
EOF
