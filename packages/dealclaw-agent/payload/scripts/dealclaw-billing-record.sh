#!/bin/bash
# DealClaw Billing Recorder — 正式计费埋点（单一事实源：billing.mjs）
#
# 兼容两种调用：
#   1) bash scripts/dealclaw-billing-record.sh <tenantId> <skillId> [quantity]
#   2) bash scripts/dealclaw-billing-record.sh --group <chat_id> <skillId> [quantity]
#      (或 --user <open_id>) — 由 billing.mjs 从 billing-config.json 自动解析租户
#
# 行为：estimate → settle 一次性后台记录（fire-and-forget），失败静默，不阻塞主流程。
# 说明：BASE_URL 不再写死；billing.mjs 默认连本机 credits-ledger (http://localhost:8081)。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --group/--user 模式：透传给 billing.mjs 自行解析租户（映射在 billing-config.json）
if [ "${1:-}" = "--group" ] || [ "${1:-}" = "--user" ]; then
  node "$SCRIPT_DIR/billing.mjs" record "$@" >/dev/null 2>&1 &
  exit 0
fi

# 老模式：<tenantId> <skillId> [quantity]，归一化 skillId
TENANT_ID="${1:-}"
SKILL_ID="${2:-}"
QUANTITY="${3:-1}"

[ -z "$TENANT_ID" ] || [ -z "$SKILL_ID" ] && exit 0

# 归一化分隔符（. / _ → -）
SKILL_ID="${SKILL_ID//./-}"
SKILL_ID="${SKILL_ID//_/-}"

# 旧命名 → 标准 skill_id（credits-ledger skill_prices 表）
case "$SKILL_ID" in
  dealclaw-company-profile)   SKILL_ID="dealclaw-analyze-company" ;;
  dealclaw-exhibition-match)  SKILL_ID="dealclaw-exhibition-leads" ;;
  dealclaw-send-email)        SKILL_ID="dealclaw-email-growth-send" ;;
esac

node "$SCRIPT_DIR/billing.mjs" record "$TENANT_ID" "$SKILL_ID" "$QUANTITY" >/dev/null 2>&1 &
exit 0
