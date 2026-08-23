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
#   DEALCLAW_PRELOAD_TIMEOUT      超时秒（默认 300）

set -euo pipefail

AGENT_ID="${DEALCLAW_AGENT_ID:-dealclaw}"
SESSION_KEY="${DEALCLAW_PRELOAD_SESSION_KEY:-agent:dealclaw:preload}"
TIMEOUT="${DEALCLAW_PRELOAD_TIMEOUT:-300}"

openclaw agent \
  --agent "$AGENT_ID" \
  --session-key "$SESSION_KEY" \
  --message "执行company_info.py获取企业基本信息和企业邀约记录，将相关信息分别汇总到画像和线索池中" \
  --timeout "$TIMEOUT"
