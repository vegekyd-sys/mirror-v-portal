#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/state}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-/data/home}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR}/openclaw.json}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18790}"
export OPENCLAW_RUNTIME_URL="${OPENCLAW_RUNTIME_URL:-http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-dealclaw}"

mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR/memory/customer" "$OPENCLAW_WORKSPACE_DIR/work/mio-api/data"

# Base payload is immutable in the image. Refresh it exactly on every start,
# while preserving only the declared customer-mutable paths.
rsync -a --delete \
  --exclude='/memory/customer/' \
  --exclude='/work/mio-api/data/' \
  --exclude='/work/mio-api/.env' \
  /opt/dealclaw/payload/ "$OPENCLAW_WORKSPACE_DIR/"
rm -rf "$OPENCLAW_WORKSPACE_DIR/node_modules"
ln -s /opt/dealclaw/runtime/dependencies/node_modules "$OPENCLAW_WORKSPACE_DIR/node_modules"

# Skill credentials (.env) are delivered via the skill-env Secret mounted at
# /run/secrets/skill-env and hot-reloaded by kubelet. Keep a stable symlink
# at the conventional path work/mio-api/.env so skill scripts (shell
# resolve_env helpers, Python clients, apify tooling) always find it — the
# symlink survives pod restarts because rsync excludes it above.
if [[ -f /run/secrets/skill-env/.env ]]; then
  ln -sfn /run/secrets/skill-env/.env "$OPENCLAW_WORKSPACE_DIR/work/mio-api/.env"
else
  # No Secret mounted (pre-provisioning or envFrom-only setups): leave any
  # existing file untouched rather than pointing at a dead target.
  echo "[dealclaw-runtime] skill-env Secret not mounted; work/mio-api/.env left as-is" >&2
fi

# A customer-specific ConfigMap/volume may supply company knowledge, but it
# cannot overwrite the immutable identity, safety rules, Skills, or scripts.
if [[ -d /overlay ]]; then
  rsync -a --delete /overlay/ "$OPENCLAW_WORKSPACE_DIR/memory/customer/"
fi

node /opt/dealclaw/runtime/write-config.mjs

# Custom LLM providers (managed from the admin console via the LLM_PROVIDERS
# envFrom blob): write-config.mjs materialised their API keys as shell
# exports in <stateDir>/llm-env.sh. Source them BEFORE starting the gateway
# so the config's env-referenced apiKeys resolve.
if [[ -f "${OPENCLAW_STATE_DIR}/llm-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${OPENCLAW_STATE_DIR}/llm-env.sh"
fi

# No built-in provider any more: with no LLM_PROVIDERS the gateway starts
# without a model (write-config.mjs warns); conversations fail until an
# admin configures providers in the console.

openclaw gateway run --port "$OPENCLAW_GATEWAY_PORT" --bind loopback --auth none &
gateway_pid=$!

node /opt/dealclaw/bridge/dist/index.js &
bridge_pid=$!

# ── 租户初始化（后台顺序执行，不阻塞 supervise 主流程）──
# 等 gateway 就绪 → 写 .env → 注册 cron → agent 预加载画像/线索池
init_runtime() {
  local url="http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/readyz"
  local max_attempts="${DEALCLAW_GATEWAY_READY_ATTEMPTS:-90}"
  local delay="${DEALCLAW_GATEWAY_READY_DELAY:-2}"
  local attempt=0

  # 1. 轮询等 gateway 就绪（/readyz 返回 200）
  while [[ $attempt -lt $max_attempts ]]; do
    if python3 -c "import urllib.request; urllib.request.urlopen('$url', timeout=2)" >/dev/null 2>&1; then
      echo "[dealclaw-runtime] gateway 就绪（${url}）"
      break
    fi
    attempt=$((attempt+1))
    sleep "$delay"
  done
  if [[ $attempt -ge $max_attempts ]]; then
    echo "[dealclaw-runtime] gateway 未就绪（${max_attempts} 次 × ${delay}s），跳过初始化" >&2
    return 1
  fi

  # 2. 写 work/mio-api/.env
  bash /opt/dealclaw/runtime/dc-env-config.sh || echo "[dealclaw-runtime] dc-env-config.sh 失败" >&2

  # 3. 注册 cron（幂等）
  bash /opt/dealclaw/runtime/dc-cron-daily.sh       || echo "[dealclaw-runtime] dc-cron-daily.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-resend-poll.sh || echo "[dealclaw-runtime] dc-cron-resend-poll.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-leads-push.sh  || echo "[dealclaw-runtime] dc-cron-leads-push.sh 失败" >&2

  # 4. agent 预加载：画像 + 线索池
  bash /opt/dealclaw/runtime/dc-ensure-agent-preload.sh || echo "[dealclaw-runtime] dc-ensure-agent-preload.sh 失败" >&2

  echo "[dealclaw-runtime] 初始化完成"
}
init_runtime &
init_pid=$!

terminate() {
  kill -TERM "$bridge_pid" "$gateway_pid" "$init_pid" 2>/dev/null || true
  wait "$bridge_pid" "$gateway_pid" 2>/dev/null || true
}
trap terminate TERM INT EXIT

set +e
wait -n "$gateway_pid" "$bridge_pid"
status=$?
set -e
echo "[dealclaw-runtime] a supervised process exited (status=$status)" >&2
exit "$status"
