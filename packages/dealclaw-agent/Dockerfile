FROM node:22-bookworm AS bridge-build
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/openclaw/openclaw:2026.7.1

# Feishu channel plugin — MUST match the base image's OpenClaw version
# (plugins are version-coupled to the host runtime). Pinned, not `latest`.
# This baked copy is the OFFLINE FALLBACK only: entrypoint.sh installs the
# plugin via `openclaw plugins install` into the PVC state dir at first boot
# (trusted identity → openKeyedStore / persistent feishu-dedup); when that
# install fails (no egress) write-config.mjs falls back to this sideload
# copy via plugins.load.paths (untrusted → in-memory dedup only).
USER root
RUN npm install --omit=dev --no-save --legacy-peer-deps \
      --prefix /opt/dealclaw/plugins/feishu \
      @openclaw/feishu@2026.7.1 \
    && chown -R node:node /opt/dealclaw/plugins

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-venv python3-pip python3-flask python3-openpyxl python3-requests rsync \
    && rm -rf /var/lib/apt/lists/*

# Feishu official CLI — required by lark/feishu skills (docs, base, drive).
# Pinned; bump together with skills that reference new CLI capabilities.
RUN npm install -g @larksuite/cli@1.0.68

# 小元 CLI — 直连 blade-agent-adapter 的接口命令（替代 find-buyers 零散脚本）。
# venv 隔离：Debian python3 是 externally-managed（PEP 668），不能直接 pip install。
COPY blade_agent_cli-0.1.0-py3-none-any.whl /tmp/blade_agent_cli-0.1.0-py3-none-any.whl
RUN python3 -m venv /opt/xiaoyuan-venv \
    && /opt/xiaoyuan-venv/bin/pip install /tmp/blade_agent_cli-0.1.0-py3-none-any.whl \
    && rm /tmp/blade_agent_cli-0.1.0-py3-none-any.whl

COPY --from=bridge-build /build/dist /opt/dealclaw/bridge/dist
COPY --from=bridge-build /build/node_modules /opt/dealclaw/bridge/node_modules
COPY --from=bridge-build /build/package.json /opt/dealclaw/bridge/package.json
COPY payload /opt/dealclaw/payload
COPY runtime /opt/dealclaw/runtime
RUN npm ci --omit=dev --legacy-peer-deps \
      --prefix /opt/dealclaw/runtime/dependencies \
    && chmod 0755 /opt/dealclaw/runtime/*.sh \
    && mkdir -p /data/home /data/state /data/workspace \
    && chown -R node:node /data /opt/dealclaw

ENV NODE_ENV=production \
    OPENCLAW_HOME=/data/home \
    OPENCLAW_STATE_DIR=/data/state \
    OPENCLAW_CONFIG_PATH=/data/state/openclaw.json \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    OPENCLAW_GATEWAY_PORT=18790 \
    OPENCLAW_RUNTIME_URL=http://127.0.0.1:18790 \
    OPENCLAW_AGENT_ID=dealclaw \
    DEALCLAW_PAYLOAD_VERSION=dealclaw-base.v2 \
    PATH="/opt/xiaoyuan-venv/bin:${PATH}"

USER node
EXPOSE 18789
CMD ["bash", "/opt/dealclaw/runtime/entrypoint.sh"]
