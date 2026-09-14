FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/openclaw:2026.9.4@sha256:6bc0bf3117e1c5074db8a064084a5f9d41ece1aa2a16369a82f53207b846a5c3
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# CI builds remain on the existing builder; no host Docker socket is mounted.
RUN corepack enable
ARG KUBECTL_VERSION=v1.36.2
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" -o /tmp/kubectl \
    && curl -fsSL --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && cd /tmp && echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check \
    && install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl kubectl.sha256
RUN npm install --omit=dev --no-save --legacy-peer-deps \
    --prefix /opt/nexus-manager/plugins/feishu @openclaw/feishu@2026.9.4 \
    && chown -R node:node /opt/nexus-manager
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
