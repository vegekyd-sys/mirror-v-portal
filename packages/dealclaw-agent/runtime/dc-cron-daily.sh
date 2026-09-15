#!/bin/bash
# dc-cron-daily.sh — 注入 DealClaw 早晚报 cron（单租户，command 类型）
#
# 幂等由 `openclaw cron add --declaration-key` 原生保证：同名 declarationKey 重复
# add 会自动 converge——无差异 no-op、有差异原地更新、缺失则新建（id 与 run 状态
# 保持不变）。因此不需要自己先查「是否存在再跳过」，那反而会阻止脚本改动落地
# （改了 cron expr / command / tz / env 后旧 cron 永不更新）。
#
# 单租户：company_id 不再显式传参，由 dc_daily_cycle.py 从 work/mio-api/.env 的
# MIO_CDP_SUPPLIER_ID 自动读取。命令先 source .env 再跑。
#
# 用法:
#   dc-cron-daily.sh                  # 默认 Asia/Shanghai
#   dc-cron-daily.sh --tz Europe/Berlin
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
# 租户身份：entrypoint 已 source .env，这里直接继承进程环境；Secret 未挂载时为空
SUPPLIER_ID="${MIO_CDP_SUPPLIER_ID:-}"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-daily] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-daily] 非法时区: $TZ" >&2; exit 1; }

# ── 注入单个 cron（add 自带 converge，幂等）──
ensure() {
  local name="$1" cron_expr="$2" slot="$3" decl_key="$4"
  openclaw cron add \
    --cron "$cron_expr" \
    --tz "$TZ" \
    --command "python3 -m dc_daily_cycle run --slot $slot --execute --dispatch" \
    --command-cwd "$MIO_DIR" \
    --command-env "MIO_CDP_SUPPLIER_ID=$SUPPLIER_ID" \
    --command-env "DC_NOTIFY_ALLOWED_COMPANIES=$SUPPLIER_ID" \
    --command-env "DC_DATA_DIR=$MIO_DIR/data" \
    --no-deliver \
    --timeout-seconds 1800 \
    --declaration-key "$decl_key" \
    --name "$name" \
    --description "DealClaw ${slot} 报（${cron_expr} @ ${TZ}）"
  echo "[dc-cron-daily] 已同步: $name（${cron_expr} @ ${TZ}）"
}

# ── 早晚报（时区统一走 $TZ）──
ensure "dealclaw-morning" "30 9 * * *" "morning" "dealclaw-morning"
ensure "dealclaw-evening" "30 17 * * *" "evening" "dealclaw-evening"

echo "[dc-cron-daily] 完成（时区: $TZ）"
