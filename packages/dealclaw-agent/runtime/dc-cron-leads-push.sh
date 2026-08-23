#!/bin/bash
# dc-cron-leads-push.sh — 幂等注入 DealClaw「AI猎客」定时推送 cron（单租户，command 类型）
#
# 单租户：主接收方 chat_id 由运行时动态解析（notify_routes.json 的 default 键），
# 不传 --chat-id。到点执行命令：source .env → 取 default 主群 → 跑 buyer_leads_daily.py。
#
# 用法:
#   dc-cron-leads-push.sh            # 默认 Asia/Shanghai + 每天 14:00
#   dc-cron-leads-push.sh --tz Europe/Berlin
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）
#   DEALCLAW_PUSH_CRON      cron 表达式（默认 0 14 * * *）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
CRON_EXPR="${DEALCLAW_PUSH_CRON:-0 14 * * *}"
DECL_KEY="dealclaw-leads-push"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-leads-push] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-leads-push] 非法时区: $TZ" >&2; exit 1; }

# ── 判断 declarationKey 是否已存在 ──
has_cron() {
  local key="$1"
  openclaw cron list --json 2>/dev/null | python3 -c "
import sys, json
try:
    jobs = json.load(sys.stdin).get('jobs', [])
except Exception:
    jobs = []
print('True' if any(j.get('declarationKey') == '$key' for j in jobs) else 'False')
"
}

# ── 幂等注入 ──
if [[ "$(has_cron "$DECL_KEY")" == "True" ]]; then
  echo "[dc-cron-leads-push] 已存在，跳过"
  exit 0
fi

# 运行时命令：source .env → 取 default 主群 → 跑 buyer_leads_daily.py
# 单引号保证 $CHAT_ID 在 cron 运行时才展开，而不是脚本构建时。
CMD='set -a; . .env; set +a; CHAT_ID=$(python3 -c "from dc_notify import get_default_target; print(get_default_target())"); [ -n "$CHAT_ID" ] && python3 buyer_leads_daily.py "$CHAT_ID"'

openclaw cron add \
  --cron "$CRON_EXPR" \
  --tz "$TZ" \
  --command "$CMD" \
  --command-cwd "$MIO_DIR" \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-leads-push" \
  --description "AI猎客定时推送（$CRON_EXPR @ $TZ）"

echo "[dc-cron-leads-push] 已注入（$CRON_EXPR @ $TZ）"
