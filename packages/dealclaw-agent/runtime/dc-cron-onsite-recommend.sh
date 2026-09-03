#!/bin/bash
# dc-cron-onsite-recommend.sh — 幂等注入 DealClaw 现场推荐 cron（当地时间 10/14/16 点）
#
# 展会开展期间，每天展会当地时间 10:00 / 14:00 / 16:00 各跑一次「现场未邀约匹配买家推荐」。
# 时区从当前展会国家（orderRecords state=3）映射；10/14/16 点当地时间转成北京时间注册 cron。
# 脚本内部会判断当天是否正在开展，没有则 NO_RUN 直接跳过。
#
# 用法:
#   dc-cron-onsite-recommend.sh            # 自动从当前展会国家映射时区
#   dc-cron-onsite-recommend.sh --tz Europe/Berlin
#
# 环境变量:
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
SUPPLIER_ID="${MIO_CDP_SUPPLIER_ID:-}"
OPEN_ID="${MIO_V_OPEN_ID:-}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
DECL_KEY_PREFIX="dealclaw-onsite-recommend"
XIAOYUAN="$(command -v xiaoyuan 2>/dev/null || echo /opt/xiaoyuan-venv/bin/xiaoyuan)"

# 国家 → IANA 时区（覆盖米奥主要展会国家）
COUNTRY_TZ='{
  "Brazil": "America/Sao_Paulo",
  "India": "Asia/Kolkata",
  "Saudi Arabia": "Asia/Riyadh",
  "Indonesia": "Asia/Jakarta",
  "Vietnam": "Asia/Ho_Chi_Minh",
  "South Africa": "Africa/Johannesburg",
  "Mexico": "America/Mexico_City",
  "Poland": "Europe/Warsaw",
  "United Arab Emirates": "Asia/Dubai",
  "Dubai": "Asia/Dubai",
  "Japan": "Asia/Tokyo",
  "United States": "America/New_York",
  "Germany": "Europe/Berlin",
  "Turkey": "Europe/Istanbul",
  "Russia": "Europe/Moscow",
  "Egypt": "Africa/Cairo",
  "Kazakhstan": "Asia/Almaty"
}'

TZ_ARG="${1:-}"

# 解析时区：显式 --tz 优先；否则从当前展会国家映射；兜底 Asia/Shanghai
resolve_tz() {
  local arg1="${1:-}"
  local arg2="${2:-}"
  if [[ "$arg1" == --tz=* ]]; then
    echo "${arg1#--tz=}"; return
  elif [[ "$arg1" == --tz ]]; then
    echo "${arg2:-Asia/Shanghai}"; return
  fi
  if [[ -n "$OPEN_ID" && -n "$SUPPLIER_ID" ]]; then
    local country
    country=$("$XIAOYUAN" --open-id "$OPEN_ID" --supplier-id "$SUPPLIER_ID" company info 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ors = (d.get('response', {}).get('data', {}) or {}).get('orderRecords') or []
    for r in ors:
        if r.get('state') == 3 and r.get('websiteCountry'):
            print(r['websiteCountry']); break
except Exception:
    pass
")
    if [[ -n "$country" ]]; then
      echo "$COUNTRY_TZ" | python3 -c "
import sys, json
tzmap = json.load(sys.stdin)
print(tzmap.get('''$country'''.strip(), 'Asia/Shanghai'))
"
      return
    fi
  fi
  echo "Asia/Shanghai"
}

TZ="$(resolve_tz "$1" "$2")"

# 校验时区合法
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-onsite-recommend] 非法时区: $TZ" >&2; exit 1; }

# 10/14/16 点当地时间 → 北京时间 cron「分 时」列表
BJ_CRONS=$(python3 - "$TZ" <<'PY'
import sys, datetime, zoneinfo
tz = sys.argv[1]
t = zoneinfo.ZoneInfo(tz)
bj = zoneinfo.ZoneInfo("Asia/Shanghai")
for hh in ("10", "14", "16"):
    local = datetime.datetime(2026, 1, 1, int(hh), 0, tzinfo=t)
    bjdt = local.astimezone(bj)
    print(f"{bjdt.minute} {bjdt.hour}")
PY
)

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

# 幂等注册 3 条 cron（对应当地时间 10/14/16 点）
idx=0
for slot in 10 14 16; do
  idx=$((idx + 1))
  read -r M H <<< "$(echo "$BJ_CRONS" | sed -n "${idx}p")"
  decl_key="${DECL_KEY_PREFIX}-${slot}h"
  if [[ "$(has_cron "$decl_key")" == "True" ]]; then
    echo "[dc-cron-onsite-recommend] 已存在，跳过: ${slot}h"
    continue
  fi
  openclaw cron add \
    --cron "${M} ${H} * * *" \
    --tz "Asia/Shanghai" \
    --command "python3 dc_onsite_recommend.py run" \
    --command-cwd "$MIO_DIR" \
    --command-env "MIO_CDP_SUPPLIER_ID=$SUPPLIER_ID" \
    --command-env "MIO_V_OPEN_ID=$OPEN_ID" \
    --command-env "OPENCLAW_WORKSPACE_DIR=$WORKSPACE_DIR" \
    --no-deliver \
    --declaration-key "$decl_key" \
    --name "dealclaw-onsite-recommend-${slot}h" \
    --description "DealClaw 现场推荐（展会当地时间 ${slot}:00 @ ${TZ}，北京时间 ${H}:${M}）"
  echo "[dc-cron-onsite-recommend] 已注入 ${slot}h（${H}:${M} 北京时间）"
done

echo "[dc-cron-onsite-recommend] 完成（时区: $TZ）"
