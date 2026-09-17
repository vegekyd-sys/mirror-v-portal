#!/bin/bash
# dc-cron-pending-send.sh — 幂等注入 DealClaw 待发队列调度器 cron（command 类型）
#
# 每 30 分钟扫 data/pending_sends.jsonl 里「到点且未发」的项 → 真实发送 → 回执。
# 用 openclaw cron add 动态注册，幂等（declaration-key）。
#
# 为什么必须在镜像层注册：
#   dc_email_send 发现不在买家当地工作日 8-18 窗口，就把邮件 enqueue 进待发队列，
#   全靠这条 cron 去扫。2026-09-16 它只被 payload 侧的 inject_pending_send_cron.sh
#   往**系统 crontab** 写过 —— 而镜像里既没有 crontab 命令也没有 cron 守护进程，
#   注入静默失败，27 封葡语开发信在 pending 卡了一夜。
#   结论：队列型任务的调度器必须跟着镜像走，不能指望有人手工 inject。
#
# 用法:
#   dc-cron-pending-send.sh            # 默认 Asia/Shanghai + /data/workspace/work/mio-api
#   dc-cron-pending-send.sh --tz America/Sao_Paulo
#
# 环境变量:
#   DEALCLAW_CRON_TZ        默认时区（优先级低于 --tz）
#   DEALCLAW_MIO_DIR        mio-api 目录（默认 /data/workspace/work/mio-api）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
DECL_KEY="dealclaw-pending-send"

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-pending-send] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-pending-send] 非法时区: $TZ" >&2; exit 1; }

# 租户身份：entrypoint 已 source .env，这里直接继承进程环境；Secret 未挂载时为空。
# 注意**不传** DC_NOTIFY_ALLOWED_COMPANIES：回执走 dc_notify，白名单比对的是待发项里的
# enterprise（公司标识），传租户号会对不上而被强制 dry-run，回执静默丢失。不配=全部允许。
SUPPLIER_ID="${MIO_CDP_SUPPLIER_ID:-}"

# ── schedule 三方合并：镜像默认值 vs 用户手改（见 dc-cron-converge.py）──
CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"
DEFAULT_CRON="*/30 * * * *"
sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ")" || {
  echo "[dc-cron-pending-send] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
}
eval "$sched_env"

openclaw cron add \
  --cron "$DC_CRON_EXPR" \
  --tz "$DC_CRON_TZ" \
  --command "python3 dc_pending_send.py run" \
  --command-cwd "$MIO_DIR" \
  --command-env "MIO_CDP_SUPPLIER_ID=$SUPPLIER_ID" \
  --command-env "DC_DATA_DIR=$MIO_DIR/data" \
  --command-env "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}" \
  --no-deliver \
  --timeout-seconds 900 \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-pending-send" \
  --description "DealClaw 待发队列调度器（${DC_CRON_EXPR} @ ${DC_CRON_TZ}）"

python3 "$CONVERGE" record --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ" \
  || echo "[dc-cron-pending-send] 基线记录失败（不影响本次注册，但下次升级可能误判）" >&2

echo "[dc-cron-pending-send] 已同步（${DC_CRON_EXPR} @ ${DC_CRON_TZ}，schedule 来源: ${DC_CRON_SOURCE}）"
