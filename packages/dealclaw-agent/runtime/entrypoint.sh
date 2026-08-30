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

# ── feishu 插件 trusted 安装（幂等）────────────────────────────────
# openKeyedStore（feishu-dedup 持久化去重）只对 trusted 插件开放，而 trusted
# 身份来自 `openclaw plugins install` 的安装记录（落在 PVC 的 state 目录，跨
# 重启持久）。镜像内 /opt/dealclaw/plugins/feishu 的 npm 拷贝走 load.paths
# sideload，拿不到 trusted 身份（上游 issue #92452）。
# 启动时幂等确保已安装：版本 marker 匹配 → 跳过（零开销）；不匹配/缺失 →
# 安装（首装约 15-20s，需 npm 出网）；失败 → 回退镜像内 sideload 副本
# （功能可用，仅 dedup 降级内存去重）。DEALCLAW_FEISHU_TRUSTED 告知
# write-config.mjs 是否需要把 sideload 路径写进 plugins.load.paths。
FEISHU_PLUGIN_VERSION="2026.7.1"
export DEALCLAW_FEISHU_TRUSTED=0
feishu_bot_ready() {
  [[ "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" \
     && -n "${DEALCLAW_APP_ID:-}" && -n "${DEALCLAW_APP_SECRET:-}" \
     && ! "${DEALCLAW_APP_ID}" == placeholder-* ]]
}
ensure_feishu_trusted() {
  local marker="${OPENCLAW_STATE_DIR}/npm/.dealclaw-feishu-version"
  if [[ -f "$marker" && "$(cat "$marker" 2>/dev/null || true)" == "$FEISHU_PLUGIN_VERSION" ]]; then
    return 0
  fi
  local force=""
  if compgen -G "${OPENCLAW_STATE_DIR}/npm/projects/openclaw-feishu-*" >/dev/null; then
    force="--force" # 已有安装（旧版本或无 marker）→ 替换升级
  fi
  if openclaw plugins install "npm:@openclaw/feishu@${FEISHU_PLUGIN_VERSION}" $force >/dev/null 2>&1; then
    mkdir -p "${OPENCLAW_STATE_DIR}/npm"
    printf '%s' "$FEISHU_PLUGIN_VERSION" > "$marker"
    echo "[dealclaw-runtime] feishu 插件 trusted 安装完成（v${FEISHU_PLUGIN_VERSION}）"
    return 0
  fi
  if [[ -n "$force" ]]; then
    # 升级失败但已有旧版 trusted 安装 → 继续用（避免回退 sideload 丢 dedup 持久化）
    echo "[dealclaw-runtime] feishu 插件升级到 v${FEISHU_PLUGIN_VERSION} 失败，保留旧 trusted 安装" >&2
    return 0
  fi
  echo "[dealclaw-runtime] feishu 插件 trusted 安装失败（无出网？），回退镜像内 sideload 副本" >&2
  return 1
}
# trusted 副本补丁：aochi Dockerfile 的 patch-feishu-latest-frame.mjs 只作用于
# 镜像内 /opt 副本；trusted install 后网关加载 PVC 副本，必须对它重放同一补丁
# （幂等：已打过则 markers 全中直接跳过）。失败仅告警不阻塞——插件功能不受
# 影响，只是流式卡片吐字可能变慢。
patch_feishu_trusted_copy() {
  local dir=""
  for d in "${OPENCLAW_STATE_DIR}"/npm/projects/openclaw-feishu-*/node_modules/@openclaw/feishu; do
    [[ -d "$d" ]] && dir="$d" && break
  done
  [[ -n "$dir" ]] || return 1
  if FEISHU_PLUGIN_ROOT="$dir" node /opt/dealclaw/runtime/patch-feishu-latest-frame.mjs; then
    echo "[dealclaw-runtime] feishu trusted 副本已应用 latest-frame 补丁（${dir}）"
  else
    echo "[dealclaw-runtime] feishu trusted 副本补丁失败（bundle 变更？吐字可能变慢）" >&2
  fi
}
if feishu_bot_ready && ensure_feishu_trusted; then
  export DEALCLAW_FEISHU_TRUSTED=1
  patch_feishu_trusted_copy || true
fi

node /opt/dealclaw/runtime/write-config.mjs

# ── lark-cli 初始化（bot 身份，非交互、幂等）─────────────────────────
# openclaw plane 下租户 bot 凭据已在 env 中：写入 lark-cli 配置，让
# lark-cli docs/base/drive 等技能可用（bot identity）。用户身份
# （--as user，设备码流程）无法自动开通，需租户管理员后续自行绑定。
# HOME 指向临时目录，配置不落 PVC，每次启动重建（幂等）。
if command -v lark-cli >/dev/null 2>&1 \
   && [[ -n "${DEALCLAW_APP_ID:-}" && -n "${DEALCLAW_APP_SECRET:-}" ]] \
   && [[ "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" ]] \
   && ! [[ "${DEALCLAW_APP_ID}" == placeholder-* ]]; then
  if printf '%s' "$DEALCLAW_APP_SECRET" \
      | lark-cli config init --app-id "$DEALCLAW_APP_ID" \
          --app-secret-stdin --brand feishu --force-init >/dev/null 2>&1; then
    echo "[dealclaw-runtime] lark-cli 已绑定租户 bot（appId=$DEALCLAW_APP_ID）"
  else
    echo "[dealclaw-runtime] lark-cli 初始化失败（不影响消息面启动）" >&2
  fi
else
  echo "[dealclaw-runtime] lark-cli 未初始化（非 openclaw plane 或凭据缺失）" >&2
fi


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

# Shared-token auth avoids device-pairing scope-upgrade for the CLI (cron add /
# agent). When OPENCLAW_GATEWAY_TOKEN is injected, run with token auth;
# otherwise fall back to none.
GATEWAY_AUTH_MODE="${OPENCLAW_GATEWAY_TOKEN:+token}"
GATEWAY_AUTH_MODE="${GATEWAY_AUTH_MODE:-none}"
openclaw gateway run --port "$OPENCLAW_GATEWAY_PORT" --bind loopback --auth "$GATEWAY_AUTH_MODE" &
gateway_pid=$!

node /opt/dealclaw/bridge/dist/index.js &
bridge_pid=$!

# ── 租户初始化（后台顺序执行，不阻塞 supervise 主流程）──
# 等 gateway 就绪 → 注册 cron → agent 预加载画像/线索池（.env 已由 skill-env Secret 提供，不再写）
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

  # 2. 注册 cron（幂等）
  bash /opt/dealclaw/runtime/dc-cron-daily.sh       || echo "[dealclaw-runtime] dc-cron-daily.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-resend-poll.sh || echo "[dealclaw-runtime] dc-cron-resend-poll.sh 失败" >&2

  # 3. agent 预加载：画像 + 线索池
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
