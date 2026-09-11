FROM dealclaw-acr-registry.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm AS bridge-build
WORKDIR /build

# 配置 npm 使用国内镜像源 + 缓存挂载
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000

# 先只复制依赖描述文件，最大化缓存命中
COPY package*.json ./
# 使用 BuildKit 缓存挂载 npm 缓存目录，避免重复下载
# 注意：用 npm install 而非 npm ci，兼容仓库中未提交 package-lock.json 的情况
# （npm ci 要求必须存在 lockfile，否则 EUSAGE 报错）
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install

# 复制配置文件（变更频率低）
COPY tsconfig.json vitest.config.ts ./

# write-config-channels tests spawn `node /build/runtime/write-config.mjs`,
# so the runtime dir must be present before `npm test`.
COPY runtime ./runtime

# 复制源码（变更频率最高，放最后）
COPY src ./src

# 先执行测试（失败则不浪费构建时间）
RUN npm test

# 再执行构建
RUN npm run build \
    && npm prune --omit=dev

# Internal ACR mirror — synced from ghcr.nju.edu.cn/openclaw/openclaw:2026.7.1
# Original digest for verification: sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f
FROM dealclaw-acr-registry.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/openclaw:2026.7.1

USER root

# ========== 一次性完成所有 root 权限操作 ==========

# 1. 配置 npm 国内源
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000

# 2. 安装 Feishu 插件（使用缓存挂载） + 配置 apt 源 + 安装系统依赖（使用缓存挂载）
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    # P2: Feishu channel plugin — MUST match the base image's OpenClaw version
    # (plugins are version-coupled to the host runtime). Pinned, not `latest`.
    npm install --omit=dev --no-save --legacy-peer-deps \
      --prefix /opt/dealclaw/plugins/feishu \
      @openclaw/feishu@2026.7.1 \
    # WeChat (personal WeChat) channel plugin — external plugin maintained by
    # Tencent Weixin team. peerDeps openclaw >=2026.5.12 (satisfied by 2026.7.1).
    # Same trusted-install + sideload fallback pattern as Feishu.
    && npm install --omit=dev --no-save --legacy-peer-deps \
      --prefix /opt/dealclaw/plugins/weixin \
      @tencent-weixin/openclaw-weixin@2.4.8 \
    && chown -R node:node /opt/dealclaw/plugins \
    # Jenkins builders run in mainland China; use the Aliyun Debian mirror to avoid
    # multi-minute stalls against deb.debian.org while retaining apt retries.
    && sed -ri 's#https?://deb.debian.org/debian#https://mirrors.aliyun.com/debian#g; s#https?://security.debian.org/debian-security#https://mirrors.aliyun.com/debian-security#g' \
      /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-venv python3-pip python3-flask python3-openpyxl python3-requests rsync \
    # Feishu official CLI — required by lark/feishu skills (docs, base, drive).
    # Pinned; bump together with skills that reference new CLI capabilities.
    && npm install -g @larksuite/cli@1.0.68 \
    && rm -rf /var/lib/apt/lists/*

# 小元 CLI — 直连 blade-agent-adapter 的接口命令（替代 find-buyers 零散脚本）。
# venv 隔离：Debian python3 是 externally-managed（PEP 668），不能直接 pip install。
COPY blade_agent_cli-0.1.2-py3-none-any.whl /tmp/blade_agent_cli-0.1.2-py3-none-any.whl
RUN python3 -m venv /opt/xiaoyuan-venv \
    && /opt/xiaoyuan-venv/bin/pip install --no-cache-dir \
        -i https://mirrors.aliyun.com/pypi/simple/ /tmp/blade_agent_cli-0.1.2-py3-none-any.whl \
    && rm /tmp/blade_agent_cli-0.1.2-py3-none-any.whl

# 3. 复制构建产物和文件（从 bridge-build 阶段复制的内容不会触发上面的缓存失效）
COPY --from=bridge-build /build/dist /opt/dealclaw/bridge/dist
COPY --from=bridge-build /build/node_modules /opt/dealclaw/bridge/node_modules
COPY --from=bridge-build /build/package.json /opt/dealclaw/bridge/package.json
COPY payload /opt/dealclaw/payload
COPY runtime /opt/dealclaw/runtime

# 4. Keep only the newest pending Feishu streaming-card frame. This is a
# build-time compatibility patch for the pinned @openclaw/feishu@2026.7.1
# bundle; it does not change Feishu's native typing animation parameters.
RUN node /opt/dealclaw/runtime/patch-feishu-latest-frame.mjs
RUN node /opt/dealclaw/runtime/patch-feishu-footer.mjs

# 5. 安装 runtime 依赖 + 设置权限（使用缓存挂载）
# 注意：同样用 npm install 而非 npm ci，兼容 runtime/dependencies 没有 lockfile 的情况
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --omit=dev --legacy-peer-deps \
      --prefix /opt/dealclaw/runtime/dependencies \
    && chmod 0755 /opt/dealclaw/runtime/entrypoint.sh \
    && mkdir -p /data/home /data/state /data/workspace \
    && chown -R node:node /data /opt/dealclaw

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
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

