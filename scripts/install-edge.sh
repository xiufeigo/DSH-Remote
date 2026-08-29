#!/usr/bin/env bash
# ============================================================================
# dsh-remote · Edge 网关裸机一键部署（Linux + systemd）
#
# 在公网 VPS 上执行一条命令，装好 Node ≥24、frp 二进制、网关代码并注册 systemd：
#   sudo bash install-edge.sh --from-dir /path/to/DSH-Remote   # 从本地目录安装
#   sudo bash install-edge.sh                                  # 从 GitHub main 分支拉取
#   sudo bash install-edge.sh --token <访问Token> --frp-role frps --domain remote.example.com
#   sudo bash install-edge.sh --uninstall                      # 停止并移除服务（保留数据）
#
# 重复执行 = 升级：只覆盖 /opt/dsh-remote/app 代码，数据目录 /var/lib/dsh-remote 不动。
#
# HTTPS：脚本默认监听 127.0.0.1:18443，请配合 Caddy/nginx 反代签发正式证书
# （docs/edge-deployment.md 给有现成 Caddy 的最小配置）。没有反代时可用
# --listen 0.0.0.0 过渡（自签证书，浏览器需手动信任一次）。
# ============================================================================
set -euo pipefail

# OPS-05：frp 版本单一来源 = 仓库根 package.json 的 config.frpVersion。
# 优先级：环境变量 FRP_VERSION > 安装来源 package.json（node -p 读取）> 内置缺省值。
# ⚠️ FRP_VERSION_DEFAULT 必须与根 package.json config.frpVersion 保持一致。
FRP_VERSION_OVERRIDE="${FRP_VERSION:-}"
FRP_VERSION_DEFAULT="0.61.1"
FRP_VERSION=""
TMP_ROOT_PKG="/tmp/dshr-root-package.json"
REPO_TARBALL="${DSHR_REPO_TARBALL:-https://github.com/xiufeigo/DSH-Remote/archive/refs/heads/main.tar.gz}"
MIRROR_PREFIX="https://ghproxy.net/"

OPT_DIR="/opt/dsh-remote"
APP_DIR="$OPT_DIR/app"
NODE_DIR="$OPT_DIR/node"
DATA_DIR="/var/lib/dsh-remote"
CONF_DIR="/etc/dsh-remote"
SERVICE_NAME="dsh-remote-edge"

FROM_DIR=""
TOKEN=""
FRP_ROLE="frps"
DOMAIN=""
LISTEN="127.0.0.1"
CONTROL_PORT=7000
TUNNEL_NAME="dsh-remote"
VISITOR_BIND_PORT=18443
UNINSTALL=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--from-dir)        FROM_DIR="$2"; shift 2 ;;
		--token)           TOKEN="$2"; shift 2 ;;
		--frp-role)        FRP_ROLE="$2"; shift 2 ;;
		--control-port)    CONTROL_PORT="$2"; shift 2 ;;
		--tunnel-name)     TUNNEL_NAME="$2"; shift 2 ;;
		--visitor-bind-port) VISITOR_BIND_PORT="$2"; shift 2 ;;
		--domain)          DOMAIN="$2"; shift 2 ;;
		--listen)          LISTEN="$2"; shift 2 ;;
		--uninstall)       UNINSTALL=1; shift ;;
		*) echo "未知参数: $1" >&2; exit 1 ;;
	esac
done

# OPS-03：--token 给了空值/纯空白（如 --token ""）视同未提供，回落自动生成，
# 避免把空 Token 写进门禁形同虚设
if [[ -z "${TOKEN//[[:space:]]/}" ]]; then
	TOKEN=""
fi

if [[ "$(id -u)" -ne 0 ]]; then
	echo "请用 root 运行（sudo bash $0 ...）" >&2
	exit 1
fi

# ── 卸载 ────────────────────────────────────────────────────────────────────
if [[ "$UNINSTALL" -eq 1 ]]; then
	systemctl stop "$SERVICE_NAME" 2>/dev/null || true
	systemctl disable "$SERVICE_NAME" 2>/dev/null || true
	rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
	systemctl daemon-reload
	echo "✅ 已停止并移除 systemd 服务；数据保留在 $DATA_DIR（不再需要可手动删除）"
	exit 0
fi

case "$FRP_ROLE" in
	frps|visitor|off) ;;
	*) echo "--frp-role 只支持 frps | visitor | off" >&2; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
	x86_64) FRP_ARCH="amd64" ;;
	aarch64|arm64) FRP_ARCH="arm64" ;;
	*) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

# OPS-01：下载助手——退出码检查（下载器失败即失败）+ 文件大小检查
# （防截断/空文件被当成完整产物送去解压）；失败时清理半成品。
# $3 为期望最小字节数（缺省 64KB）。
download() {
	local url="$1" out="$2" min_bytes="${3:-65536}"
	local ok=0 size=0
	if command -v curl >/dev/null 2>&1; then
		curl -fSL --connect-timeout 15 --retry 2 -o "$out" "$url" && ok=1
	elif command -v wget >/dev/null 2>&1; then
		wget -q -T 15 -t 3 -O "$out" "$url" && ok=1
	fi
	if [[ "$ok" -eq 1 && -f "$out" ]]; then
		size="$(wc -c < "$out" | tr -d '[:space:]')"
		if [[ "$size" -ge "$min_bytes" ]]; then
			return 0
		fi
		echo "  下载文件过小（${size} B < ${min_bytes} B），视为失败：$url" >&2
	fi
	rm -f "$out"
	return 1
}

echo "▶ 1/6 Node.js ≥24"
NODE_BIN=""
if command -v node >/dev/null 2>&1 && [[ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -ge 24 ]]; then
	NODE_BIN="$(command -v node)"
	echo "  使用系统 Node：$NODE_BIN ($(node --version))"
else
	NODE_VER="v24.10.0"
	NODE_PKG="node-${NODE_VER}-linux-${FRP_ARCH}"
	if [[ ! -x "$NODE_DIR/bin/node" ]]; then
		mkdir -p "$NODE_DIR" /tmp/dshr-node
		URL="https://nodejs.org/dist/${NODE_VER}/${NODE_PKG}.tar.xz"
		download "$URL" "/tmp/dshr-node/${NODE_PKG}.tar.xz" 10000000 \
			|| download "${MIRROR_PREFIX}${URL}" "/tmp/dshr-node/${NODE_PKG}.tar.xz" 10000000 \
			|| { echo "Node 下载失败，请手动安装 Node ≥24 后重跑" >&2; exit 1; }
		# OPS-02：先取官方 SHASUMS256.txt 校验 SHA-256，通过后才解压
		# （SHASUMS 只从 nodejs.org 官方源拉取，不走镜像）
		command -v sha256sum >/dev/null 2>&1 \
			|| { echo "缺少 sha256sum（coreutils），无法校验 Node 安装包，中止" >&2; exit 1; }
		download "https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt" /tmp/dshr-node/SHASUMS256.txt 1024 \
			|| { echo "无法下载 SHASUMS256.txt，出于安全中止安装" >&2; exit 1; }
		grep " ${NODE_PKG}.tar.xz\$" /tmp/dshr-node/SHASUMS256.txt > /tmp/dshr-node/expected.sha256 \
			|| { echo "SHASUMS256.txt 缺少 ${NODE_PKG}.tar.xz 条目" >&2; exit 1; }
		( cd /tmp/dshr-node && sha256sum --check --status expected.sha256 ) \
			|| { echo "Node 安装包 SHA-256 校验失败，中止安装" >&2; rm -rf /tmp/dshr-node; exit 1; }
		tar -xJf "/tmp/dshr-node/${NODE_PKG}.tar.xz" -C /tmp/dshr-node
		cp -a "/tmp/dshr-node/${NODE_PKG}/." "$NODE_DIR/"
		rm -rf /tmp/dshr-node
	fi
	NODE_BIN="$NODE_DIR/bin/node"
	echo "  使用独立 Node：$NODE_BIN ($($NODE_BIN --version))"
fi

echo "▶ 2/6 网关代码 → $APP_DIR"
mkdir -p "$OPT_DIR"
if [[ -n "$FROM_DIR" ]]; then
	[[ -f "$FROM_DIR/packages/gateway/src/server.ts" ]] || { echo "目录里找不到 packages/gateway/src/server.ts：$FROM_DIR" >&2; exit 1; }
	rm -rf "$APP_DIR"
	mkdir -p "$APP_DIR"
	cp -a "$FROM_DIR/packages/gateway" "$APP_DIR/gateway"
	# OPS-05：留下根 package.json 供后面读取 config.frpVersion
	cp -f "$FROM_DIR/package.json" "$TMP_ROOT_PKG" 2>/dev/null || true
else
	mkdir -p /tmp/dshr-code
	TMP_CODE=/tmp/dshr-code/repo.tar.gz
	download "$REPO_TARBALL" "$TMP_CODE" 65536 \
		|| download "${MIRROR_PREFIX}${REPO_TARBALL}" "$TMP_CODE" 65536 \
		|| { echo "代码下载失败；可在有网的机器 clone 后用 --from-dir 安装" >&2; exit 1; }
	rm -rf "$APP_DIR" /tmp/dshr-code/unpack
	mkdir -p /tmp/dshr-code/unpack
	tar -xzf "$TMP_CODE" -C /tmp/dshr-code/unpack
	SRC_ROOT="$(find /tmp/dshr-code/unpack -maxdepth 1 -type d ! -path /tmp/dshr-code/unpack | head -n1)"
	# OPS-05：留下根 package.json 供后面读取 config.frpVersion
	cp -f "$SRC_ROOT/package.json" "$TMP_ROOT_PKG" 2>/dev/null || true
	mv "$SRC_ROOT/packages/gateway" /tmp/dshr-code/gateway
	rm -rf "$APP_DIR"
	mkdir -p "$APP_DIR"
	mv /tmp/dshr-code/gateway "$APP_DIR/gateway"
	rm -rf /tmp/dshr-code
fi
chmod +x "$APP_DIR/gateway/src/cli.ts" 2>/dev/null || true

echo "▶ 3/6 网关依赖（qrcode/selfsigned）"
(cd "$APP_DIR/gateway" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# OPS-05：解析 frp 版本——环境变量 > 安装来源根 package.json 的 config.frpVersion > 内置缺省
if [[ -n "$FRP_VERSION_OVERRIDE" ]]; then
	FRP_VERSION="$FRP_VERSION_OVERRIDE"
elif [[ -f "$TMP_ROOT_PKG" ]]; then
	FRP_VERSION="$("$NODE_BIN" -p "try{require(process.argv[1]).config?.frpVersion ?? ''}catch(e){''}" "$TMP_ROOT_PKG" 2>/dev/null || true)"
fi
if [[ -z "$FRP_VERSION" ]]; then
	FRP_VERSION="$FRP_VERSION_DEFAULT"
	echo "  frp 版本：v$FRP_VERSION（内置缺省；⚠️ 需与根 package.json config.frpVersion 一致）"
else
	echo "  frp 版本：v$FRP_VERSION"
fi
rm -f "$TMP_ROOT_PKG"

echo "▶ 4/6 frp v$FRP_VERSION 二进制"
VENDOR_DIR="$DATA_DIR/vendor/frp"
mkdir -p "$VENDOR_DIR"
if [[ -x "$VENDOR_DIR/frpc" ]]; then
	echo "  已存在，跳过下载（删除 $VENDOR_DIR 可强制重下）"
else
	TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
	BASE="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"
	mkdir -p /tmp/dshr-frp
	download "${BASE}/${TARBALL}" /tmp/dshr-frp/frp.tgz 5000000 \
		|| download "${MIRROR_PREFIX}${BASE}/${TARBALL}" /tmp/dshr-frp/frp.tgz 5000000 \
		|| { echo "frp 下载失败，请手动解压 frpc/frps 到 $VENDOR_DIR 后重跑" >&2; exit 1; }
	tar -xzf /tmp/dshr-frp/frp.tgz -C /tmp/dshr-frp
	UNPACKED="/tmp/dshr-frp/frp_${FRP_VERSION}_linux_${FRP_ARCH}"
	install -m 755 "$UNPACKED/frpc" "$VENDOR_DIR/frpc"
	install -m 755 "$UNPACKED/frps" "$VENDOR_DIR/frps"
	rm -rf /tmp/dshr-frp
fi

echo "▶ 5/6 配置"
mkdir -p "$CONF_DIR" "$DATA_DIR"
chmod 700 "$CONF_DIR" "$DATA_DIR" 2>/dev/null || true
if [[ -z "$TOKEN" ]]; then
	# OPS-03：复用已存 Token 前判空——空文件/空值不能进门禁，回落自动生成
	if [[ -f "$CONF_DIR/access-token" ]]; then
		TOKEN="$(cat "$CONF_DIR/access-token" || true)"
		if [[ -n "$TOKEN" ]]; then
			echo "  复用已保存的访问 Token（$CONF_DIR/access-token）"
		fi
	fi
	if [[ -z "$TOKEN" ]]; then
		TOKEN="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
		TOKEN="${TOKEN:0:24}"
		echo "  自动生成访问 Token：$TOKEN"
	fi
	echo "$TOKEN" > "$CONF_DIR/access-token"
	chmod 600 "$CONF_DIR/access-token"
else
	echo -n "$TOKEN" > "$CONF_DIR/access-token"
	chmod 600 "$CONF_DIR/access-token"
fi

cat > "$CONF_DIR/env" <<EOF
# 由 install-edge.sh 维护；手改后 systemctl restart ${SERVICE_NAME}
DSHR_ROLE=edge
DSHR_LISTEN_HOST=${LISTEN}
DSHR_LISTEN_PORT=18443
DSHR_ACCESS_TOKEN=${TOKEN}
DSHR_TOKEN_LOGIN_DAYS=30
DSHR_UPSTREAM_TLS=true
DSHR_VISITOR_BIND_PORT=${VISITOR_BIND_PORT}
DSHR_FRP_ROLE=${FRP_ROLE}
DSHR_FRP_SERVER_PORT=${CONTROL_PORT}
DSHR_FRP_NAME=${TUNNEL_NAME}
DSHR_EDGE_CONSUME=stcp
EOF

echo "▶ 6/6 systemd 服务"
# ── OPS-04：专用运行用户 + 属主收敛 ─────────────────────────────────────────
# 用户判断块：不存在才创建（幂等）
if ! id dsh-remote >/dev/null 2>&1; then
	useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin dsh-remote 2>/dev/null \
		|| adduser --system --home "$DATA_DIR" --shell /usr/sbin/nologin dsh-remote \
		|| { echo "创建系统用户 dsh-remote 失败" >&2; exit 1; }
	echo "  已创建系统用户 dsh-remote"
fi
# 判断块外无条件收敛属主：重复执行/上次中断可能留下 root 属主文件，
# 导致服务以 dsh-remote 启动时 EACCES；每次安装统一纠正
chown -R dsh-remote:dsh-remote "$OPT_DIR" "$DATA_DIR"
# 配置含访问 Token：root 属主 + 属组可读（systemd 以 dsh-remote 读 EnvironmentFile）
chown root:dsh-remote "$CONF_DIR" "$CONF_DIR/env" "$CONF_DIR/access-token"
chmod 750 "$CONF_DIR"
chmod 640 "$CONF_DIR/env" "$CONF_DIR/access-token"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=dsh-remote edge gateway (Token gate + mobile hook + frp)
After=network-online.target
Wants=network-online.target

[Service]
User=dsh-remote
Group=dsh-remote
EnvironmentFile=${CONF_DIR}/env
Environment=DSH_REMOTE_HOME=${DATA_DIR}
WorkingDirectory=${APP_DIR}/gateway
ExecStart=${NODE_BIN} src/cli.ts start
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# ── 防火墙尽力放行 ──────────────────────────────────────────────────────────
FW_PORTS="443 80"
[[ "$FRP_ROLE" == "frps" ]] && FW_PORTS="$FW_PORTS $CONTROL_PORT"
for port in $FW_PORTS; do
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
		ufw allow "${port}/tcp" >/dev/null || true
	elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
		firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
	fi
done
command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true

sleep 1
systemctl --no-pager --lines 5 status "$SERVICE_NAME" || true

ENTRY_HINT="https://127.0.0.1:18443（本机自测）"
if [[ -n "$DOMAIN" ]]; then ENTRY_HINT="https://${DOMAIN}/（配好 Caddy/nginx 反代后）"; fi
NEXT_STEPS_PC=$(cat <<'PCDOC'
    PC 端（家里跑 DSH 的电脑）~/.dsh-remote/config.json 里把 frp 指向本机：
      "frp": { "enabled": true, "serverAddr": "<本服务器公网IP>", "serverPort": <控制端口>,
               "mode": "stcp", "name": "<隧道名>" }
    （token 同步：PC secrets.json 的 frpAuthToken 与 frpVisitorKey 需与服务器一致，
      见 docs/edge-deployment.md §密钥同步）
PCDOC
)
NEXT_STEPS_PC="${NEXT_STEPS_PC//<控制端口>/$CONTROL_PORT}"
NEXT_STEPS_PC="${NEXT_STEPS_PC//<隧道名>/$TUNNEL_NAME}"

cat <<EOF

✅ 安装完成
   入口:      $ENTRY_HINT
   访问 Token: $TOKEN
   监听:      ${LISTEN}:18443（自签 TLS；对外请置于反代之后）
   frp 角色:  $FRP_ROLE（控制端口 $CONTROL_PORT，隧道名 $TUNNEL_NAME）
   数据目录:  $DATA_DIR    日志: journalctl -u ${SERVICE_NAME} -f
   体检:      sudo ${NODE_BIN} ${APP_DIR}/gateway/src/cli.ts doctor

   云厂商安全组放行 TCP：80、443$( [[ "$FRP_ROLE" == "frps" ]] && echo "、${CONTROL_PORT}(frps 控制口)" )。

$NEXT_STEPS_PC

   iPhone/iPad 浏览器打开入口 → 输入访问 Token → 即用。
EOF
