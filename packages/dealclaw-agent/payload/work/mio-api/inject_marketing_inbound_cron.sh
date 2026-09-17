#!/bin/bash
# inject_marketing_inbound_cron.sh — 注册展自动营销「入站」触发桥（Gateway cron）
#
# 调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**——镜像里没有 cron
# 守护进程，往 crontab 写任务会静默失败（2026-09-16 的 27 封邮件就是这么丢的）。
#
# 归属：payload 层自注册，**镜像 entrypoint 不会自动挂它**（理由同出站编排：
# 会触发真实 smart-reply，开不开是租户决定）。换 Pod / 换租户记得重新 inject。
#
# 用法: ./inject_marketing_inbound_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="marketing-inbound"
DC_CRON_DECL_KEY="dealclaw-marketing-inbound"
DC_CRON_NAME="dealclaw-marketing-inbound"
DC_CRON_SUMMARY="DealClaw 展自动营销入站触发桥"

DC_CRON_REQUIRE_SUPPLIER=1
DC_CRON_COMMAND="python3 dc_marketing_automation_inbound.py --company-id $(dc_cron::supplier_id) --no-dry-run"
DC_CRON_DEFAULT_EXPR="*/15 * * * *"        # 每 15 分钟（回复时效性优先）
DC_CRON_TIMEOUT_SECONDS=900
DC_CRON_DUP_MATCH="dc_marketing_automation_inbound"
DC_CRON_ENV=(
  "MIO_CDP_SUPPLIER_ID=$(dc_cron::supplier_id)"
  "DC_DATA_DIR=${DEALCLAW_MIO_DIR:-$DC_CRON_LIB_DIR}/data"
  "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
)
DC_CRON_LEGACY_MATCH=("run_marketing_inbound.sh" "# DealClaw marketing inbound bridge")

dc_cron::main "$@"
