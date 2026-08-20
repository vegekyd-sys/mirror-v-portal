#!/bin/bash
# dc-bindings.sh — DealClaw Email Notify Bindings CLI
# Usage: bash scripts/dc-bindings.sh [--supplier-id <id>] <action> [args...]
# Actions: list | upsert <agent_email> <webhook_url> <mention_open_id> [note] | delete <agent_email> | test <agent_email>
# 认证：X-Admin-Token（WEBHOOK_ADMIN_TOKEN）+ X-Supplier-Id（MIO_CDP_SUPPLIER_ID 或 --supplier-id），多租户隔离
set -euo pipefail

SERVER="114.55.150.21"
TOKEN_FILE="/etc/email-webhook/email-webhook.env"
BASE_URL="https://webhook.dealclaw.io"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

die() { echo "[dc-bindings] ERROR: $*" >&2; exit 1; }

usage() {
  sed -n '2,6p' "$0" >&2
  exit 1
}

# 从脚本目录向上逐级找 .env（单数 workspace/.env 或复数 work/mio-api/.env）里的指定 key
resolve_env() {
  local key="$1"
  local dir env_file val
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ "$dir" != "/" ]]; do
    for env_file in "$dir/work/mio-api/.env" "$dir/.env"; do
      [[ -f "$env_file" ]] || continue
      val=$(grep -m1 "^${key}=" "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
      [[ -n "$val" ]] && { echo "$val"; return; }
    done
    dir="$(dirname "$dir")"
  done
}

# X-Admin-Token：认证。缺了返回 401
resolve_token() {
  local t
  t=$(resolve_env WEBHOOK_ADMIN_TOKEN)
  [[ -n "$t" ]] && { echo "$t"; return; }
  # 兜底：SSH 到服务器读 token 文件
  t=$(ssh root@"$SERVER" "grep '^ADMIN_TOKEN=' $TOKEN_FILE" 2>/dev/null | cut -d= -f2- || true)
  [[ -n "$t" ]] || die "无法获取 admin token。请确认 .env 里的 WEBHOOK_ADMIN_TOKEN 或 SSH 可达 $SERVER"
  echo "$t"
}

# X-Supplier-Id：租户范围，多租户隔离必传。缺了返回 400
resolve_supplier_id() {
  local s
  s=$(resolve_env MIO_CDP_SUPPLIER_ID)
  [[ -n "$s" ]] || die "无法获取 supplier id。请确认 .env 里的 MIO_CDP_SUPPLIER_ID，或用 --supplier-id 显式指定"
  echo "$s"
}

do_request() {
  local method="$1" path="$2" body="${3:-}"
  local token supplier_id
  token=$(resolve_token)
  supplier_id="${SUPPLIER_ID_OVERRIDE:-$(resolve_supplier_id)}"
  if [[ -z "$body" ]]; then
    curl -s -X "$method" \
      -H "X-Admin-Token: $token" \
      -H "X-Supplier-Id: $supplier_id" \
      "$BASE_URL$path" | python3 -m json.tool
  else
    curl -s -X "$method" \
      -H "Content-Type: application/json" \
      -H "X-Admin-Token: $token" \
      -H "X-Supplier-Id: $supplier_id" \
      -d "$body" \
      "$BASE_URL$path" | python3 -m json.tool
  fi
}

# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------

cmd_list() {
  do_request GET /bindings
}

cmd_upsert() {
  local agent_email="$1" webhook_url="$2" mention_open_id="$3" note="${4:-}"
  if [[ -z "$agent_email" || -z "$webhook_url" || -z "$mention_open_id" ]]; then
    die "upsert 需要三个必填参数: <agent_email> <webhook_url> <mention_open_id> [note]"
  fi
  if [[ ! "$mention_open_id" =~ ^ou_ ]]; then
    die "mention_open_id 必须以 ou_ 开头，当前值: $mention_open_id"
  fi
  local body
  body=$(python3 -c "
import json
print(json.dumps({
  'agent_email': '${agent_email}',
  'webhook_url': '${webhook_url}',
  'webhook_secret': '',
  'app_id': '',
  'app_secret': '',
  'chat_id': '',
  'prefer': 'custom',
  'mention_open_id': '${mention_open_id}',
  'note': '${note}'
}))
")
  do_request POST /bindings "$body"
}

cmd_delete() {
  local agent_email="$1"
  [[ -z "$agent_email" ]] && die "delete 需要一个参数: <agent_email>"
  do_request DELETE "/bindings/$agent_email"
}

cmd_test() {
  local agent_email="$1"
  [[ -z "$agent_email" ]] && die "test 需要一个参数: <agent_email>"
  local body="{\"agent_email\":\"$agent_email\"}"
  do_request POST "/bindings/$agent_email/test" "$body"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

# 先解析可选 --supplier-id（多租户时显式指定租户）
SUPPLIER_ID_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --supplier-id) SUPPLIER_ID_OVERRIDE="${2:-}"; shift 2 ;;
    *) break ;;
  esac
done

[[ $# -lt 1 ]] && usage

case "$1" in
  list)                        cmd_list ;;
  upsert)                      cmd_upsert "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  delete|remove|rm)            cmd_delete "${2:-}" ;;
  test|check)                  cmd_test "${2:-}" ;;
  -h|--help|help)              usage ;;
  *)                           die "未知操作: $1。支持: list | upsert | delete | test" ;;
esac
