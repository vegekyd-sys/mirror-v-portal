#!/bin/bash
# inject_marketing_automation_cron.sh — 注册展自动营销「出站」编排（Gateway cron）
#
# 调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**——镜像里没有 cron
# 守护进程，往 crontab 写任务会静默失败（2026-09-16 的 27 封邮件就是这么丢的）。
#
# 归属：payload 层自注册，**镜像 entrypoint 不会自动挂它**。
# 因为这条 job 会真实发营销邮件（--no-dry-run），要不要开是每个租户的决定，
# 不该跟着镜像滚给所有人。要让它在容器重启后依然在，靠的是 Gateway cron 本身持久化
# （/data/state 是 PVC），而不是每次启动重新注入 —— 但**换 Pod / 换租户要重新 inject 一次**。
# 若将来确定要全租户默认开，就照 docs/cron-timers.md 第四节加 runtime/dc-cron-*.sh + entrypoint 一行。
#
# 用法: ./inject_marketing_automation_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="marketing-automation"
DC_CRON_DECL_KEY="dealclaw-marketing-automation"
DC_CRON_NAME="dealclaw-marketing-automation"
DC_CRON_SUMMARY="DealClaw 展自动营销出站编排"

# company-id 在 dc_marketing_automation_cron.py 里是必填 CLI 参数，注册时就得定下来，
# 所以这里显式解析并校验非空（见 dc_cron_lib.sh 的 DC_CRON_REQUIRE_SUPPLIER）
DC_CRON_REQUIRE_SUPPLIER=1
DC_CRON_COMMAND="python3 dc_marketing_automation_cron.py --company-id $(dc_cron::supplier_id) --no-dry-run"
DC_CRON_DEFAULT_EXPR="*/30 * * * *"        # 每 30 分钟（对齐 pending-send 节奏）
DC_CRON_TIMEOUT_SECONDS=1800               # 出站全链路含正文生成 + 发送，给足时间
DC_CRON_DUP_MATCH="dc_marketing_automation_cron"
DC_CRON_ENV=(
  "MIO_CDP_SUPPLIER_ID=$(dc_cron::supplier_id)"
  "DC_DATA_DIR=${DEALCLAW_MIO_DIR:-$DC_CRON_LIB_DIR}/data"
  "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
)
DC_CRON_LEGACY_MATCH=("run_marketing_automation.sh" "# DealClaw marketing automation")

dc_cron::main "$@"
