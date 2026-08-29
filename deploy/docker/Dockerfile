# syntax=docker/dockerfile:1
# ============================================================================
# DSH-Remote Edge 网关镜像
#
#   - Node ≥24 原生运行 TypeScript（无构建步骤），直接跑源码；
#   - 自带官方 frp 二进制（frpc + frps，amd64/arm64），
#     由网关按 DSHR_FRP_ROLE 决定拉起 visitor 还是 frps；
#   - 数据目录 /data（config.json、secrets、设备表、审计日志、证书）。
#
# 构建仓库根目录执行：
#   docker build -f deploy/docker/Dockerfile -t dsh-remote-edge .
# 显式指定 frp 版本（OPS-05：单一来源 = 根 package.json config.frpVersion）：
#   docker build -f deploy/docker/Dockerfile \
#     --build-arg FRP_VERSION="$(node -p "require('./package.json').config.frpVersion")" \
#     -t dsh-remote-edge .
# ============================================================================

FROM node:24-alpine

ARG TARGETARCH
# OPS-05：缺省值必须与根 package.json 的 config.frpVersion 保持一致
# （shell 安装脚本用 node -p 从该字段读取；镜像构建可用 --build-arg 覆盖）
ARG FRP_VERSION=0.61.1

RUN apk add --no-cache curl tzdata

# ── frp 官方二进制（直连失败自动走 ghproxy 镜像）────────────────────────────
RUN set -eux; \
	case "$TARGETARCH" in \
		amd64) FRP_ARCH="amd64" ;; \
		arm64) FRP_ARCH="arm64" ;; \
		*) echo "unsupported TARGETARCH=$TARGETARCH"; exit 1 ;; \
	esac; \
	TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"; \
	BASE="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"; \
	mkdir -p /app/vendor/frp /tmp/frpdl; \
	curl -fSL --connect-timeout 15 -o /tmp/frpdl/frp.tgz "${BASE}/${TARBALL}" \
		|| curl -fSL --connect-timeout 15 -o /tmp/frpdl/frp.tgz "https://ghproxy.net/${BASE}/${TARBALL}"; \
	tar -xzf /tmp/frpdl/frp.tgz -C /tmp/frpdl; \
	install -m 755 "/tmp/frpdl/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frpc" /app/vendor/frp/frpc; \
	install -m 755 "/tmp/frpdl/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" /app/vendor/frp/frps; \
	rm -rf /tmp/frpdl

WORKDIR /app/gateway

COPY packages/gateway/package.json ./package.json
COPY packages/gateway/src ./src
COPY packages/gateway/assets ./assets
RUN npm install --omit=dev --no-audit --no-fund

ENV DSH_REMOTE_HOME=/data \
	NODE_ENV=production

VOLUME ["/data"]
# 对外入口一律经 Caddy/nginx 反代；此端口仅供反代容器访问
EXPOSE 18443

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD wget -qO /dev/null --no-check-certificate "https://127.0.0.1:${DSHR_LISTEN_PORT:-18443}/__dsh_remote__/health" || exit 1

ENTRYPOINT ["node", "src/cli.ts", "start"]
