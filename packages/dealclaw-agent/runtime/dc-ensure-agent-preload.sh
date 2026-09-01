#!/bin/bash
# dc-ensure-agent-preload.sh — 触发 dealclaw agent 预加载企业画像 + 线索池（agentTurn）
#
# 起一个 preload agent session，让 agent 执行 company_info.py：
#   1. getBasicInfo         → 企业基本信息 → 画像
#   2. getInvitationByPage  → 企业邀约记录 → 线索池
#
# 用法:
#   dc-ensure-agent-preload.sh
#
# 环境变量:
#   DEALCLAW_AGENT_ID             agent id（默认 dealclaw）
#   DEALCLAW_PRELOAD_SESSION_KEY  会话 key（默认 agent:dealclaw:preload）
#   DEALCLAW_PRELOAD_TIMEOUT      超时秒（默认 1800：全量分页拉邀约实测 ~20min，
#                                 300s 必超时且会留下待恢复的半截 session）
#   DEALCLAW_PRELOAD_VERSION      预加载内容版本（默认 1）。成功后写入 PVC marker；
#                                 pod 重启时 marker 版本一致 → 跳过，不再重跑、
#                                 不再重复扣 find-buyers 的 credit。改 payload 中
#                                 预加载口径时 bump 此值即可全量强制重刷。
#   DEALCLAW_PRELOAD_FORCE=1      忽略 marker 强制重跑一次（跑完会更新 marker）
#
# Marker 落在 OPENCLAW_STATE_DIR（PVC state 区，跨重启持久、不受 workspace
# rsync 影响）：${OPENCLAW_STATE_DIR}/.dc-agent-preload-done

set -euo pipefail

AGENT_ID="${DEALCLAW_AGENT_ID:-dealclaw}"
SESSION_KEY="${DEALCLAW_PRELOAD_SESSION_KEY:-agent:dealclaw:preload}"
TIMEOUT="${DEALCLAW_PRELOAD_TIMEOUT:-1800}"
VERSION="${DEALCLAW_PRELOAD_VERSION:-1}"
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/state}"
MARKER="${STATE_DIR}/.dc-agent-preload-done"

if [[ "${DEALCLAW_PRELOAD_FORCE:-}" != "1" && -f "$MARKER" && "$(cat "$MARKER" 2>/dev/null || true)" == "$VERSION" ]]; then
  echo "[dc-preload] 已完成（marker 版本 $VERSION），跳过；强制重跑: DEALCLAW_PRELOAD_FORCE=1 或 bump DEALCLAW_PRELOAD_VERSION"
  exit 0
fi

echo "[dc-preload] 开始预加载（timeout=${TIMEOUT}s, session=${SESSION_KEY}）"

openclaw agent \
  --agent "$AGENT_ID" \
  --session-key "$SESSION_KEY" \
  --message "执行company_info.py获取企业基本信息和企业邀约记录，将相关信息分别汇总到画像和线索池中" \
  --timeout "$TIMEOUT"

# 只有 CLI 成功退出才算完成：半截/超时的 run 不写 marker，下次重启会重试
# （重试会再次产生 find-buyers 调用费用，属重试语义；若不想重试请调大 TIMEOUT）
mkdir -p "$STATE_DIR"
printf '%s' "$VERSION" > "$MARKER"
echo "[dc-preload] 预加载完成，marker 已写入（$MARKER, 版本 $VERSION）"
