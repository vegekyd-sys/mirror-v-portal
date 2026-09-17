#!/bin/bash
# inject_exhibition_index_cron.sh — 注册展会目录刷新（Gateway cron）
#
# 调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**——镜像里没有 cron
# 守护进程，往 crontab 写任务会静默失败（2026-09-16 的 27 封邮件就是这么丢的）。
#
# 归属：payload 层自注册，镜像 entrypoint 不会自动挂它。换 Pod / 换租户记得重新 inject。
# 只写本地 index.md，不发外部消息，开着基本无副作用。
#
# 用法: ./inject_exhibition_index_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="exhibition-index"
DC_CRON_DECL_KEY="dealclaw-exhibition-index"
DC_CRON_NAME="dealclaw-exhibition-index"
DC_CRON_SUMMARY="DealClaw 展会目录刷新"

DC_CRON_REQUIRE_SUPPLIER=1
DC_CRON_COMMAND="python3 dc_exhibition_index.py --company-id $(dc_cron::supplier_id) --write"
DC_CRON_DEFAULT_EXPR="0 8 * * *"           # 每天 08:00 刷新 index.md
DC_CRON_TIMEOUT_SECONDS=600
DC_CRON_DUP_MATCH="dc_exhibition_index"
DC_CRON_ENV=(
  "MIO_CDP_SUPPLIER_ID=$(dc_cron::supplier_id)"
  "DC_DATA_DIR=${DEALCLAW_MIO_DIR:-$DC_CRON_LIB_DIR}/data"
  "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
)
DC_CRON_LEGACY_MATCH=("run_exhibition_index.sh" "# DealClaw exhibition index refresh")

dc_cron::main "$@"
