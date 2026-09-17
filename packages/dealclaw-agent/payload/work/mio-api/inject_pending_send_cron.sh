#!/bin/bash
# inject_pending_send_cron.sh — 注册 DealClaw 待发队列调度器（Gateway cron）
#
# 这条 job 就是 2026-09-16 那 27 封定时开发信没发出去的当事人：老版本往**系统 crontab**
# 写任务，而镜像里没有 crontab 命令、也没有 cron 守护进程，注入静默失败，队列卡了一夜。
# 现在统一走 OpenClaw Gateway 内置 scheduler，注册后回读复查，挂不上就非零退出。
#
# 归属：镜像层 runtime/dc-cron-pending-send.sh 托管（容器每次启动都会自动注册）。
# 本脚本是人工运维入口：查状态 / 补跑 / 临时停用。在容器里 inject 会直接委托给 runtime 脚本。
#
# 用法: ./inject_pending_send_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="pending-send"
DC_CRON_DECL_KEY="dealclaw-pending-send"
DC_CRON_NAME="dealclaw-pending-send"
DC_CRON_SUMMARY="DealClaw 待发队列调度器"
DC_CRON_RUNTIME_SCRIPT="dc-cron-pending-send.sh"

# 非容器环境下自行注册时用的声明（与 runtime/dc-cron-pending-send.sh 保持一致）
DC_CRON_COMMAND="python3 dc_pending_send.py run"
DC_CRON_DEFAULT_EXPR="*/30 * * * *"        # 每 30 分钟扫一次「到点未发」（Tianyi 已确认）
DC_CRON_TIMEOUT_SECONDS=900
DC_CRON_DUP_MATCH="dc_pending_send"
DC_CRON_ENV=(
  "DC_DATA_DIR=${DEALCLAW_MIO_DIR:-$DC_CRON_LIB_DIR}/data"
  "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
)
# 老版本写进系统 crontab 的行（有 crontab 的机器上要摘掉，否则双调度器并跑）
DC_CRON_LEGACY_MATCH=("run_pending_send.sh" "# DealClaw pending-send scheduler")

dc_cron::main "$@"
