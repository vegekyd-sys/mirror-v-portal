#!/bin/bash
# dc-bindings.sh — DealClaw Email Notify Bindings CLI
# Usage: bash scripts/dc-bindings.sh <action> [args...]
# Actions: list | upsert <agent_email> <webhook_url> <mention_open_id> [note] | delete <agent_email> | test <agent_email>
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

# fetch token from server (SSH), or use env override
resolve_token() {
  if [[ -n "${WEBHOOK_DEALCLAW_ADMIN_TOKEN:-}" ]]; then
    echo "$WEBHOOK_DEALCLAW_ADMIN_TOKEN"
    return
  fi
  local t
  t=$(ssh root@"$SERVER" "grep '^ADMIN_TOKEN=' $TOKEN_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [[ -z "$t" ]]; then
    die "无法获取 admin token。请确认 SSH 可达 $SERVER 或设置环境变量 WEBHOOK_DEALCLAW_ADMIN_TOKEN"
  fi
  echo "$t"
}

do_request() {
  local method="$1" path="$2" body="${3:-}"
  local token
  token=$(resolve_token)
  if [[ -z "$body" ]]; then
    curl -s -X "$method" \
      -H "X-Admin-Token: $token" \
      "$BASE_URL$path" | python3 -m json.tool
  else
    curl -s -X "$method" \
      -H "Content-Type: application/json" \
      -H "X-Admin-Token: $token" \
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

[[ $# -lt 1 ]] && usage

case "$1" in
  list)                        cmd_list ;;
  upsert)                      cmd_upsert "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  delete|remove|rm)            cmd_delete "${2:-}" ;;
  test|check)                  cmd_test "${2:-}" ;;
  -h|--help|help)              usage ;;
  *)                           die "未知操作: $1。支持: list | upsert | delete | test" ;;
esac
