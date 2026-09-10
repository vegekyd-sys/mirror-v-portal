#!/bin/bash
# DealClaw Balance Monitor — checks all tenant balances and alerts when low.
# Run daily via cron or heartbeat.
# Usage: bash scripts/dealclaw-balance-check.sh [--threshold 20000]

set -euo pipefail
THRESHOLD="${2:-20000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔍 DealClaw Balance Check — $(date '+%Y-%m-%d %H:%M')"
echo "Threshold: ${THRESHOLD} Credit"
echo ""

LOW_BALANCES=""
ALL_OK=true

while IFS= read -r line; do
  tenant=$(echo "$line" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).tenant))")
  balance=$(echo "$line" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).balance||0))")
  consumed=$(echo "$line" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).lifetimeConsumed||0))")
  
  if [ "$balance" = "ERR" ]; then
    echo "  ⚠️  $tenant — 无法查询余额"
    continue
  fi
  
  balance_fmt=$(printf "%'d" $balance 2>/dev/null || echo $balance)
  consumed_fmt=$(printf "%'d" $consumed 2>/dev/null || echo $consumed)
  
  if [ "$balance" -lt "$THRESHOLD" ]; then
    echo "  🚨 $tenant — 余额: $balance_fmt ⚠️ BELOW THRESHOLD"
    LOW_BALANCES="$LOW_BALANCES\n  - $tenant: $balance_fmt Credit (已消耗 $consumed_fmt)"
    ALL_OK=false
  else
    echo "  ✅ $tenant — 余额: $balance_fmt (已消耗 $consumed_fmt)"
  fi
done < <(cd "$SCRIPT_DIR/.." && node scripts/billing.mjs all-balances | node -e "
process.stdin.on('data', d => {
  JSON.parse(d).forEach(r => console.log(JSON.stringify(r)));
});")

echo ""
if $ALL_OK; then
  echo "✅ 全部账户余额正常（> ${THRESHOLD} Credit）"
else
  echo "🚨 以下账户余额低于阈值："
  echo -e "$LOW_BALANCES"
  echo ""
  echo "请通知 Tianyi。"
fi
