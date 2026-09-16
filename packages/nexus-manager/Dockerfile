FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/openclaw:2026.9.4@sha256:6bc0bf3117e1c5074db8a064084a5f9d41ece1aa2a16369a82f53207b846a5c3
USER root
# The pinned OpenClaw image already contains these runtime tools. Verify that
# contract without contacting Debian mirrors during every application build.
RUN git --version && python3 --version && curl --version && test -s /etc/ssl/certs/ca-certificates.crt
# CI builds remain on the existing builder; no host Docker socket is mounted.
RUN corepack enable
RUN npm install --omit=dev --no-save --legacy-peer-deps \
    --prefix /opt/nexus-manager/plugins/feishu @openclaw/feishu@2026.9.4 \
    && test ! -e /app/dist/extensions/feishu \
    && cp -a /opt/nexus-manager/plugins/feishu/node_modules/@openclaw/feishu /app/dist/extensions/feishu \
    && chown -R node:node /opt/nexus-manager /app/dist/extensions/feishu
COPY runtime /opt/nexus-manager/runtime
COPY payload /opt/nexus-manager/payload
RUN mkdir -p /data && chown node:node /data
ENV TZ=Asia/Shanghai \
    HOME=/data/home \
    XDG_CACHE_HOME=/tmp/cache \
    COREPACK_HOME=/tmp/corepack \
    npm_config_cache=/tmp/npm \
    OPENCLAW_HOME=/data/home \
    OPENCLAW_STATE_DIR=/data/state \
    OPENCLAW_CONFIG_PATH=/data/state/openclaw.json \
    OPENCLAW_WORKSPACE_DIR=/data/workspace
USER node
EXPOSE 18789
CMD ["node", "/opt/nexus-manager/runtime/start.mjs"]
