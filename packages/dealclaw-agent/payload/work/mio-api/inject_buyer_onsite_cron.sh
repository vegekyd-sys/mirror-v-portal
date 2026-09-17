#!/bin/bash
# inject_buyer_onsite_cron.sh — 注册 DealClaw 买家到场监控（Gateway cron）
#
# 调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**——镜像里没有 cron
# 守护进程，往 crontab 写任务会静默失败（2026-09-16 的 27 封邮件就是这么丢的）。
#
# 归属：镜像层 runtime/dc-cron-buyer-onsite.sh 托管（容器每次启动都会自动注册）。
# 本脚本是人工运维入口；在容器里 inject 会直接委托给 runtime 脚本，避免两边声明漂移。
#
# 用法: ./inject_buyer_onsite_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="buyer-onsite"
DC_CRON_DECL_KEY="dealclaw-buyer-onsite-monitor"
DC_CRON_NAME="dealclaw-buyer-onsite-monitor"
DC_CRON_SUMMARY="DealClaw 买家到场监控"
DC_CRON_RUNTIME_SCRIPT="dc-cron-buyer-onsite.sh"

# 非容器环境下自行注册时用的声明（与 runtime/dc-cron-buyer-onsite.sh 保持一致）
DC_CRON_COMMAND="python3 monitor_buyer_onsite.py"
DC_CRON_DEFAULT_EXPR="*/5 * * * *"         # 每 5 分钟（Tianyi 明确允许）
DC_CRON_TIMEOUT_SECONDS=240
DC_CRON_DUP_MATCH="monitor_buyer_onsite"
DC_CRON_ENV=(
  "MIO_CDP_SUPPLIER_ID=$(dc_cron::supplier_id)"
  "MIO_V_OPEN_ID=${MIO_V_OPEN_ID:-}"
  "OPENCLAW_WORKSPACE_DIR=${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
)
DC_CRON_LEGACY_MATCH=("run_buyer_onsite.sh" "# DealClaw buyer onsite monitor")

dc_cron::main "$@"
