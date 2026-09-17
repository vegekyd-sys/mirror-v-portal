#!/bin/bash
# DealClaw 展自动营销「出站」全链路 — 手动跑一次的包装脚本。
# 复用 dc_marketing_automation_cron.run_all（run_cycle → dispatch_pending → run_send_cycle）
#
# 定时不走这里：注册 Gateway cron 用 `bash inject_marketing_automation_cron.sh inject`
# （declaration-key `dealclaw-marketing-automation`，默认每 30 分钟）。
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_marketing_automation_cron.py --company-id "${MIO_CDP_SUPPLIER_ID}" --no-dry-run
