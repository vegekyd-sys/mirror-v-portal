#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/state}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-/data/home}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR}/openclaw.json}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18790}"
export OPENCLAW_RUNTIME_URL="${OPENCLAW_RUNTIME_URL:-http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}}"
export OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-dealclaw}"

mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_WORKSPACE_DIR/memory/customer" "$OPENCLAW_WORKSPACE_DIR/work/mio-api/data" "$OPENCLAW_WORKSPACE_DIR/data"

# Base payload is immutable in the image. Refresh it exactly on every start,
# while preserving only the declared customer-mutable paths.
# NOTE: /memory/ is excluded here and seeded separately below — the agent
# writes runtime memories there (MEMORY.md hot index, decision-history,
# promotion-log, new notes) which must survive pod restarts.
rsync -a --delete \
  --exclude='/memory/' \
  --exclude='/work/mio-api/data/' \
  --exclude='/work/mio-api/.env' \
  --exclude='/data/' \
  /opt/dealclaw/payload/ "$OPENCLAW_WORKSPACE_DIR/"
# Memory template seed: copy ONLY files missing on the receiver
# (--ignore-existing, no --delete). Template files newly added to the payload
# still land on every restart; files the agent created or edited at runtime
# are never overwritten or deleted. Removing/renaming a template therefore
# requires an explicit migration, not just an image bump.
rsync -a --ignore-existing \
  /opt/dealclaw/payload/memory/ "$OPENCLAW_WORKSPACE_DIR/memory/"
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

# 把 .env 的 KEY=VALUE export 到进程环境，供 shell 命令直接引用（如小元 CLI
# 的 --open-id "$MIO_V_OPEN_ID"）。source 失败不阻断启动。
if [[ -f "$OPENCLAW_WORKSPACE_DIR/work/mio-api/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$OPENCLAW_WORKSPACE_DIR/work/mio-api/.env" 2>/dev/null || true
  set +a
fi

# tenant-env.json（租户可写，存 MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID 的租户真实值）
# 优先覆盖 .env 的全局默认值，使 $MIO_V_OPEN_ID 在 shell 里是租户值而非兜底值。
TENV="$OPENCLAW_WORKSPACE_DIR/data/memory/tenant-env.json"
if [[ -f "$TENV" ]]; then
  eval "$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
if isinstance(d, dict):
    for k, v in d.items():
        if v is not None:
            print("export " + k + "=" + json.dumps(str(v)))
' "$TENV")"
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
# trusted 副本补丁：业务仓库 Dockerfile 的 patch-feishu-latest-frame.mjs 只作用于
# 镜像内 /opt 副本；trusted install 后网关加载 PVC 副本，必须对它重放同一补丁
# （幂等：已打过则 markers 全中直接跳过）。失败仅告警不阻塞——插件功能不受
# 影响，只是流式卡片吐字可能变慢。
patch_feishu_trusted_copy() {
  local patched=0
  for d in "${OPENCLAW_STATE_DIR}"/npm/projects/openclaw-feishu-*/node_modules/@openclaw/feishu; do
    # 残缺目录（无 dist）直接跳过，避免误报
    [[ -d "$d/dist" ]] || continue
    if FEISHU_PLUGIN_ROOT="$d" node /opt/dealclaw/runtime/patch-feishu-latest-frame.mjs; then
      echo "[dealclaw-runtime] feishu trusted 副本已应用 latest-frame 补丁（${d}）"
      patched=1
    else
      echo "[dealclaw-runtime] feishu trusted 副本补丁失败：${d}（bundle 变更？吐字可能变慢）" >&2
    fi
  done
  [[ $patched -eq 1 ]]
}
if feishu_bot_ready && ensure_feishu_trusted; then
  export DEALCLAW_FEISHU_TRUSTED=1
  patch_feishu_trusted_copy || true
  # Unlike cosmetic streaming coalescing, a requested hidden footer must not
  # silently remain visible. Unknown bundle shapes abort startup for review.
  footer_patched=0
  for d in "${OPENCLAW_STATE_DIR}"/npm/projects/openclaw-feishu-*/node_modules/@openclaw/feishu; do
    [[ -d "$d/dist" ]] || continue
    FEISHU_PLUGIN_ROOT="$d" node /opt/dealclaw/runtime/patch-feishu-footer.mjs || exit 1
    footer_patched=1
  done
  if [[ "$footer_patched" != 1 ]]; then
    echo '[dealclaw-runtime] trusted Feishu plugin not found; footer patch cannot be verified' >&2
    exit 1
  fi
fi

# ── weixin 插件 trusted 安装（幂等）──────────────────────────────────
# 与 feishu 同模式：openclaw plugins install 写入 PVC state 目录，获得
# trusted 身份（openKeyedStore）；失败回退镜像内 /opt sideload 副本。
WECHAT_PLUGIN_VERSION="2.4.8"
export DEALCLAW_WECHAT_TRUSTED=0
wechat_bound() {
  [[ "${DEALCLAW_WECHAT_BOUND:-0}" == "1" \
     && "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" ]]
}
ensure_wechat_trusted() {
  local marker="${OPENCLAW_STATE_DIR}/npm/.dealclaw-weixin-version"
  if [[ -f "$marker" && "$(cat "$marker" 2>/dev/null || true)" == "$WECHAT_PLUGIN_VERSION" ]]; then
    return 0
  fi
  local force=""
  if compgen -G "${OPENCLAW_STATE_DIR}/npm/projects/openclaw-weixin-*" >/dev/null; then
    force="--force"
  fi
  if openclaw plugins install "npm:@tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION}" --accept-capabilities $force >/dev/null 2>&1; then
    mkdir -p "${OPENCLAW_STATE_DIR}/npm"
    printf '%s' "$WECHAT_PLUGIN_VERSION" > "$marker"
    echo "[dealclaw-runtime] weixin 插件 trusted 安装完成（v${WECHAT_PLUGIN_VERSION}）"
    return 0
  fi
  if [[ -n "$force" ]]; then
    echo "[dealclaw-runtime] weixin 插件升级失败，保留旧 trusted 安装" >&2
    return 0
  fi
  echo "[dealclaw-runtime] weixin 插件 trusted 安装失败（无出网？），回退镜像内 sideload 副本" >&2
  return 1
}
if wechat_bound && ensure_wechat_trusted; then
  export DEALCLAW_WECHAT_TRUSTED=1
fi

# ── enterprise channel plugins trusted 安装（幂等）──────────────────
# OpenClaw 2026.7.1 尚不支持 --accept-capabilities；两个固定版本都使用
# 该宿主支持的 plugins install 参数。
WECOM_PLUGIN_VERSION="2026.7.2"
DINGTALK_PLUGIN_VERSION="0.8.25"
export DEALCLAW_WECOM_TRUSTED=0
export DEALCLAW_DINGTALK_TRUSTED=0

wecom_bound() {
  [[ "${DEALCLAW_WECOM_BOUND:-0}" == "1" \
     && "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" ]]
}

dingtalk_bound() {
  [[ "${DEALCLAW_DINGTALK_BOUND:-0}" == "1" \
     && "${DEALCLAW_MESSAGE_PLANE:-gateway}" == "openclaw" ]]
}

ensure_enterprise_plugin_trusted() {
  local channel="$1"
  local package_spec="$2"
  local version="$3"
  local project_glob="$4"
  local accept_capabilities="$5"
  local marker="${OPENCLAW_STATE_DIR}/npm/.dealclaw-${channel}-version"
  local project_pattern="${OPENCLAW_STATE_DIR}/npm/projects/${project_glob}"
  local trusted_project_present=0
  if compgen -G "$project_pattern" >/dev/null; then
    trusted_project_present=1
  fi

  # A marker alone is insufficient: the PVC may have been partially restored or
  # manually cleaned. Skip only when the matching trusted project still exists.
  if [[ "$trusted_project_present" == "1" \
      && -f "$marker" \
      && "$(cat "$marker" 2>/dev/null || true)" == "$version" ]]; then
    return 0
  fi

  local force=""
  if [[ "$trusted_project_present" == "1" ]]; then
    force="--force"
  fi

  local install_args=(plugins install "npm:${package_spec}@${version}")
  if [[ "$accept_capabilities" == "1" ]]; then
    install_args+=(--accept-capabilities)
  fi
  if [[ -n "$force" ]]; then
    install_args+=("$force")
  fi

  if openclaw "${install_args[@]}" >/dev/null 2>&1; then
    mkdir -p "${OPENCLAW_STATE_DIR}/npm"
    printf '%s' "$version" > "$marker"
    echo "[dealclaw-runtime] ${channel} 插件 trusted 安装完成（v${version}）"
    return 0
  fi
  if [[ -n "$force" ]]; then
    echo "[dealclaw-runtime] ${channel} 插件升级到 v${version} 失败，保留旧 trusted 安装" >&2
    return 0
  fi
  echo "[dealclaw-runtime] ${channel} 插件 trusted 安装失败（无出网？），回退镜像内 sideload 副本" >&2
  return 1
}

if wecom_bound && ensure_enterprise_plugin_trusted \
    wecom '@wecom/wecom-openclaw-plugin' "$WECOM_PLUGIN_VERSION" \
    '*wecom-openclaw-plugin-*' 0; then
  export DEALCLAW_WECOM_TRUSTED=1
fi

if dingtalk_bound && ensure_enterprise_plugin_trusted \
    dingtalk '@dingtalk-real-ai/dingtalk-connector' "$DINGTALK_PLUGIN_VERSION" \
    '*dingtalk-connector-*' 0; then
  export DEALCLAW_DINGTALK_TRUSTED=1
fi

# ── weixin 账户ID normalize 迁移（幂等）──────────────────────────────
# 历史 bug：wechat-login-bridge 的 normalizeAccountId 只替换 @ 不替换 .，
# 导致 ilink_bot_id "1670eb1f7d67@im.bot" 被存成 "1670eb1f7d67-im.bot"
# （保留了 .）。但 gateway 加载时对 ID 再次 normalize 会把 . 也变成 -，
# 于是 loadWeixinAccount("1670eb1f7d67-im-bot") 找不到 "1670eb1f7d67-im.bot.json"
# → token 读不到 → isConfigured=false → 渠道不启动 → 消息不回复。
# 本段在启动时把存量账户文件名 + accounts.json 索引修正为与 OpenClaw
# canonicalizeAccountId 一致的形式（@ 和 . 都 → -）。幂等：对文件名已是规范
# 形式的（new_id == old_id）直接跳过，可安全重复执行，放在 write-config.mjs
# 之前，确保后续网关按规范 ID 加载到正确的账户文件。
migrate_weixin_account_ids() {
  local accounts_dir="${OPENCLAW_STATE_DIR}/openclaw-weixin/accounts"
  local index_path="${OPENCLAW_STATE_DIR}/openclaw-weixin/accounts.json"
  [[ -d "$accounts_dir" ]] || return 0

  local mapfile_tmp; mapfile_tmp="$(mktemp)"
  local changed=0

  for f in "$accounts_dir"/*.json; do
    [[ -e "$f" ]] || continue  # glob 无匹配 → 跳过（不依赖 nullglob）
    local base; base="$(basename "$f")"
    # 排除非账户文件：备份、同步游标、上下文 token（它们的 ID 前缀与主账户一致，
    # 但不应作为独立账户参与 normalize 计算；配套重命名在主文件变更后统一处理）
    case "$base" in
      *.bak|*.bak.json) continue ;;
      *.sync.json) continue ;;
      *.context-tokens.json) continue ;;
    esac
    local old_id="${base%.json}"
    # OpenClaw canonicalizeAccountId: lowercase + 非法字符→- + 去首尾- + 截64 + 空→default
    local new_id; new_id="$(node -e '
      const v = (process.argv[1] ?? "").trim().toLowerCase();
      if (!v) { console.log("default"); process.exit(0); }
      let c = v.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64);
      console.log(c || "default");
    ' "$old_id")"
    if [[ "$new_id" == "$old_id" ]]; then
      continue  # 已是规范形式，不动（幂等）
    fi
    # 重命名主账户文件（若目标已存在则覆盖——同一账户不会产生两个文件）
    mv -f "$f" "${accounts_dir}/${new_id}.json"
    # 同步重命名配套的 sync / context-tokens 文件（若存在，best-effort）
    local suf
    for suf in sync context-tokens; do
      local comp="${accounts_dir}/${old_id}.${suf}.json"
      [[ -f "$comp" ]] && mv -f "$comp" "${accounts_dir}/${new_id}.${suf}.json"
    done
    printf '%s\t%s\n' "$old_id" "$new_id" >> "$mapfile_tmp"
    changed=1
    echo "[dealclaw-runtime] weixin 账户ID迁移: ${old_id} → ${new_id}"
  done

  if [[ $changed -eq 0 ]]; then
    rm -f "$mapfile_tmp"
    return 0
  fi

  # 更新 accounts.json 索引：把旧 ID 替换为 normalize 后的新 ID，去重
  if [[ -f "$index_path" ]]; then
    node -e '
      const fs = require("fs");
      const idxPath = process.argv[1];
      const mapPath = process.argv[2];
      const map = {};
      for (const line of fs.readFileSync(mapPath, "utf-8").split("\n")) {
        const m = line.trim();
        if (!m) continue;
        const parts = m.split("\t");
        if (parts.length >= 2 && parts[0] && parts[1]) map[parts[0]] = parts[1];
      }
      let ids;
      try { ids = JSON.parse(fs.readFileSync(idxPath, "utf-8")); } catch { ids = []; }
      if (!Array.isArray(ids)) ids = [];
      const out = [];
      const seen = new Set();
      for (const id of ids) {
        const nid = map[id] || id;  // 旧ID→新ID；未在map里的保留原值
        if (!seen.has(nid)) { seen.add(nid); out.push(nid); }
      }
      fs.writeFileSync(idxPath, JSON.stringify(out, null, 2) + "\n", "utf-8");
    ' "$index_path" "$mapfile_tmp"
    echo "[dealclaw-runtime] weixin accounts.json 索引已更新（normalize 账户ID）"
  fi
  rm -f "$mapfile_tmp"
}
migrate_weixin_account_ids

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
  bash /opt/dealclaw/runtime/dc-cron-email-poll.sh  || echo "[dealclaw-runtime] dc-cron-email-poll.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-buyer-onsite.sh || echo "[dealclaw-runtime] dc-cron-buyer-onsite.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-onsite-recommend.sh || echo "[dealclaw-runtime] dc-cron-onsite-recommend.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-reflection.sh || echo "[dealclaw-runtime] dc-cron-reflection.sh 失败" >&2
  bash /opt/dealclaw/runtime/dc-cron-pending-send.sh || echo "[dealclaw-runtime] dc-cron-pending-send.sh 失败" >&2

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
