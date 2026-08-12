#!/bin/bash
# DealClaw Shadow Billing Recorder
# Records skill execution to credits-ledger in shadow mode (NO actual charge).
# Usage: bash scripts/dealclaw-billing-record.sh <tenantId> <skillId> [quantity]
#
# Group → Tenant mapping:
#   小元01 → xiaoyuan_01    小元03 → xiaoyuan_03    小元04 → xiaoyuan_04
#   小元07 → xiaoyuan_07    内测群 → xiaoyuan_neice  Agent测试 → xiaoyuan_agent_test

set -euo pipefail

TENANT_ID="${1:-}"
SKILL_ID="${2:-}"
QUANTITY="${3:-1}"
BASE_URL="https://dealclaw-test.ultronx.tech"
TASK_ID="agent:${TENANT_ID}:$(date +%s):${RANDOM}"

if [ -z "$TENANT_ID" ] || [ -z "$SKILL_ID" ]; then
  exit 0
fi

ACCOUNT_ID="acct_${TENANT_ID}"

# Step 1: Estimate (creates billing event with status='estimated')
ESTIMATE=$(curl -s -X POST "${BASE_URL}/v1/billing/estimate" \
  --connect-timeout 5 --max-time 10 \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"${TENANT_ID}\",\"accountId\":\"${ACCOUNT_ID}\",\"taskId\":\"${TASK_ID}\",\"skillId\":\"${SKILL_ID}\",\"quantity\":${QUANTITY},\"metadata\":{\"source\":\"agent_skill_hook\"}}" \
  2>/dev/null) || true

# Extract eventId from JSON response without jq
EVENT_ID=$(echo "$ESTIMATE" | sed -n 's/.*"eventId":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$EVENT_ID" ]; then
  exit 0
fi

# Step 2: Settle (shadow mode: status→settled, billing_mode→shadow, no debit)
curl -s -X POST "${BASE_URL}/v1/billing/settle" \
  --connect-timeout 5 --max-time 10 \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"${TENANT_ID}\",\"accountId\":\"${ACCOUNT_ID}\",\"skillId\":\"${SKILL_ID}\",\"quantity\":${QUANTITY},\"estimatedEventId\":\"${EVENT_ID}\",\"resultSummary\":\"agent_skill_completed\"}" \
  > /dev/null 2>&1 || true

exit 0
