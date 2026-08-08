FROM node:22-bookworm AS bridge-build
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/openclaw/openclaw:2026.7.1

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-flask python3-openpyxl python3-requests rsync \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bridge-build /build/dist /opt/dealclaw/bridge/dist
COPY --from=bridge-build /build/node_modules /opt/dealclaw/bridge/node_modules
COPY --from=bridge-build /build/package.json /opt/dealclaw/bridge/package.json
COPY payload /opt/dealclaw/payload
COPY runtime /opt/dealclaw/runtime
RUN npm ci --omit=dev --legacy-peer-deps \
      --prefix /opt/dealclaw/runtime/dependencies \
    && chmod 0755 /opt/dealclaw/runtime/entrypoint.sh \
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
    DEALCLAW_PAYLOAD_VERSION=dealclaw-base.v1

USER node
EXPOSE 18789
CMD ["bash", "/opt/dealclaw/runtime/entrypoint.sh"]
