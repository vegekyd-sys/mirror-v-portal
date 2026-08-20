#!/usr/bin/env bash
# 回写公司名到 provisioning（经 nexus-gateway 转发，agent 不持有 provisioning token）
# 用法: writeback.sh "<公司名>"
set -euo pipefail

COMPANY_NAME="${1:-}"
TENANT_ID="${DEALCLAW_TENANT_ID:-}"
GATEWAY_URL="${NEXUS_GATEWAY_URL:-http://nexus-gateway-${TENANT_ID}:8080}"

if [[ -z "$COMPANY_NAME" ]]; then
  echo "用法: writeback.sh \"<公司名>\"" >&2
  exit 1
fi

if [[ -z "$TENANT_ID" ]]; then
  echo "错误: DEALCLAW_TENANT_ID 未设置" >&2
  exit 1
fi

# JSON 转义（双引号、反斜杠、换行）
escaped=$(printf '%s' "$COMPANY_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')

resp=$(curl -sS -X PATCH "${GATEWAY_URL}/v1/agent/profile" \
  -H 'Content-Type: application/json' \
  -d "{\"companyName\": \"${escaped}\"}" \
  --max-time 8 2>&1) || {
  echo "错误: 回写请求失败: ${resp}" >&2
  exit 1
}

echo "已回写公司名: ${COMPANY_NAME}"
