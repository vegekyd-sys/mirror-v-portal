#!/bin/bash
# DealClaw 展自动营销「出站」全链路 — 决策 → 路由 → 生成正文 → 发送
# 复用 dc_marketing_automation_cron.run_all（run_cycle → dispatch_pending → run_send_cycle）
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_marketing_automation_cron.py --company-id "${MIO_CDP_SUPPLIER_ID}" --no-dry-run
