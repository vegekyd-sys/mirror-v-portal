#!/bin/bash
# ensure-cron.sh — 幂等注入 DealClaw 早晚报 cron
#
# 判断 declarationKey 是否存在：不存在则注入，存在则跳过（不重复建）。
# 时区默认 Asia/Shanghai，可用 --tz 或环境变量 DEALCLAW_CRON_TZ 指定。
#
# 用法:
#   ensure-cron.sh                          # 默认 Asia/Shanghai + company=testco
#   ensure-cron.sh --tz America/Sao_Paulo   # 展会时区适配
#   ensure-cron.sh --company-id easter-glass --tz Europe/Berlin
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_COMPANY_ID     默认企业 ID（优先级低于 --company-id）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
COMPANY_ID="${DEALCLAW_COMPANY_ID:-testco}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    --company-id) COMPANY_ID="${2:-testco}"; shift 2 ;;
    --company-id=*) COMPANY_ID="${1#--company-id=}"; shift ;;
    *) echo "[ensure-cron] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[ensure-cron] 非法时区: $TZ" >&2; exit 1; }

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

# ── 注入单个 cron（幂等）──
ensure() {
  local name="$1" cron_expr="$2" slot="$3" decl_key="$4"
  if [[ "$(has_cron "$decl_key")" == "True" ]]; then
    echo "[ensure-cron] 已存在，跳过: $name"
    return 0
  fi
  openclaw cron add \
    --cron "$cron_expr" \
    --tz "$TZ" \
    --command "python3 -m dc_daily_cycle run --company-id $COMPANY_ID --slot $slot --execute --dispatch" \
    --command-cwd "$MIO_DIR" \
    --command-env "DC_NOTIFY_SENDER_MODE=feishu" \
    --command-env "DC_NOTIFY_SEND_ENABLED=1" \
    --command-env "DC_NOTIFY_ALLOWED_COMPANIES=$COMPANY_ID" \
    --command-env "DC_DATA_DIR=$MIO_DIR/data" \
    --declaration-key "$decl_key" \
    --name "$name" \
    --description "DealClaw ${slot} 报（${cron_expr} @ ${TZ}）"
  echo "[ensure-cron] 已注入: $name（${cron_expr} @ ${TZ}）"
}

# ── 早晚报（时区统一走 $TZ）──
ensure "dealclaw-${COMPANY_ID}-morning" "30 9 * * *" "morning" "dealclaw-${COMPANY_ID}-morning"
ensure "dealclaw-${COMPANY_ID}-evening" "30 17 * * *" "evening" "dealclaw-${COMPANY_ID}-evening"

echo "[ensure-cron] 完成（时区: $TZ，企业: $COMPANY_ID）"
