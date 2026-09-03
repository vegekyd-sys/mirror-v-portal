#!/bin/bash
# dc-cron-buyer-onsite.sh — 幂等注入 DealClaw 买家到场监控 cron（command 类型）
#
# 每 5 分钟轮询 tradechina「买家到场」通知（notice-list --msg-type 3），
# 有新到场则推群卡片（复用 dc_notify routes 绑定）。
# 用 openclaw cron add 动态注册，幂等（declaration-key）。
#
# 用法:
#   dc-cron-buyer-onsite.sh            # 默认 Asia/Shanghai + /data/workspace/work/mio-api
#   dc-cron-buyer-onsite.sh --tz America/Sao_Paulo
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
DECL_KEY="dealclaw-buyer-onsite-monitor"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-buyer-onsite] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-buyer-onsite] 非法时区: $TZ" >&2; exit 1; }

# monitor_buyer_onsite.py 自行读 tenant-env.json 拿 MIO_V_OPEN_ID / MIO_CDP_SUPPLIER_ID；
# 这里显式传入，避免 cron 进程环境缺失导致身份读不到。
SUPPLIER_ID="${MIO_CDP_SUPPLIER_ID:-}"
OPEN_ID="${MIO_V_OPEN_ID:-}"

openclaw cron add \
  --cron "*/5 * * * *" \
  --tz "$TZ" \
  --command "python3 monitor_buyer_onsite.py" \
  --command-cwd "$MIO_DIR" \
  --command-env "MIO_CDP_SUPPLIER_ID=$SUPPLIER_ID" \
  --command-env "MIO_V_OPEN_ID=$OPEN_ID" \
  --command-env "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" \
  --no-deliver \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-buyer-onsite-monitor" \
  --description "DealClaw 买家到场监控（*/5 @ $TZ）"

echo "[dc-cron-buyer-onsite] 已同步（*/5 @ $TZ）"
