#!/bin/bash
# dc-cron-resend-poll.sh — 幂等注入 DealClaw Resend poller cron（command 类型）
#
# 每 5 分钟拉 Resend 投递状态 + 买家回复，驱动七信号引擎。
# 用 openclaw cron add 动态注册，幂等（declaration-key）。
#
# 用法:
#   dc-cron-resend-poll.sh            # 默认 Asia/Shanghai + /data/workspace/work/mio-api
#   dc-cron-resend-poll.sh --tz America/Sao_Paulo
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
DECL_KEY="dealclaw-resend-poll"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-resend-poll] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-resend-poll] 非法时区: $TZ" >&2; exit 1; }

# 命令跑在 MIO_DIR，dc_resend_source.py 会自行从 <MIO_DIR>/.env 读 RESEND_API_KEY
# ── schedule 三方合并：镜像默认值 vs 用户手改（见 dc-cron-converge.py）──
CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"
DEFAULT_CRON="*/5 * * * *"
sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ")" || {
  echo "[dc-cron-resend-poll] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
}
eval "$sched_env"

openclaw cron add \
  --cron "$DC_CRON_EXPR" \
  --tz "$DC_CRON_TZ" \
  --command "python3 -m dc_email_controller.dc_resend_source" \
  --command-cwd "$MIO_DIR" \
  --no-deliver \
  --timeout-seconds 240 \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-resend-poll" \
  --description "DealClaw Resend poller（${DC_CRON_EXPR} @ ${DC_CRON_TZ}）"

python3 "$CONVERGE" record --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ" \
  || echo "[dc-cron-resend-poll] 基线记录失败（不影响本次注册，但下次升级可能误判）" >&2

echo "[dc-cron-resend-poll] 已同步（${DC_CRON_EXPR} @ ${DC_CRON_TZ}，schedule 来源: ${DC_CRON_SOURCE}）"
