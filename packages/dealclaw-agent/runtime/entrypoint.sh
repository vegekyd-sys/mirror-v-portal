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

if [[ "${DEALCLAW_MODEL:-deepseek/deepseek-chat}" == deepseek/* && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "[dealclaw-runtime] DEALCLAW_MODEL requires DEEPSEEK_API_KEY" >&2
  exit 1
fi

openclaw gateway run --port "$OPENCLAW_GATEWAY_PORT" --bind loopback --auth none &
gateway_pid=$!

node /opt/dealclaw/bridge/dist/index.js &
bridge_pid=$!

terminate() {
  kill -TERM "$bridge_pid" "$gateway_pid" 2>/dev/null || true
  wait "$bridge_pid" "$gateway_pid" 2>/dev/null || true
}
trap terminate TERM INT EXIT

set +e
wait -n "$gateway_pid" "$bridge_pid"
status=$?
set -e
echo "[dealclaw-runtime] a supervised process exited (status=$status)" >&2
exit "$status"
