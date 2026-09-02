#!/bin/bash
# dc-cron-email-poll.sh — 幂等注入 DealClaw 个人邮箱回复轮询 cron（command 类型）
#
# 每 5 分钟 IMAP 拉取个人邮箱（163 等），有买家回复则推群卡片。
# 用 openclaw cron add 动态注册，幂等（declaration-key）。
#
# 用法:
#   dc-cron-email-poll.sh            # 默认 Asia/Shanghai + /data/workspace/work/mio-api
#   dc-cron-email-poll.sh --tz America/Sao_Paulo
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
DECL_KEY="dealclaw-email-reply-poll"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-email-poll] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-email-poll] 非法时区: $TZ" >&2; exit 1; }

# ── 判断 declarationKey 是否已存在 ──
has_cron() {
  openclaw cron list --json 2>/dev/null | python3 -c "
import sys, json
try:
    jobs = json.load(sys.stdin).get('jobs', [])
except Exception:
    jobs = []
print('True' if any(j.get('declarationKey') == '$DECL_KEY' for j in jobs) else 'False')
"
}

# ── 幂等注入 ──
if [[ "$(has_cron)" == "True" ]]; then
  echo "[dc-cron-email-poll] 已存在，跳过"
  exit 0
fi

# 命令跑在 MIO_DIR，email_gateway 从 DC_DATA_DIR（默认 <MIO_DIR>/data）读 account/binding
openclaw cron add \
  --cron "*/5 * * * *" \
  --tz "$TZ" \
  --command "python3 -m email_gateway.cron_notify --all" \
  --command-cwd "$MIO_DIR" \
  --command-env "DC_DATA_DIR=$MIO_DIR/data" \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-email-reply-poll" \
  --description "DealClaw 个人邮箱回复轮询（*/5 @ $TZ）"

echo "[dc-cron-email-poll] 已注入（*/5 @ $TZ）"
