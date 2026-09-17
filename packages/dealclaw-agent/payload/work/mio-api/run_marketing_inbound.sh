#!/bin/bash
# DealClaw 展自动营销「入站」触发桥 — 手动跑一次的包装脚本。
# 买家回复 → 触发 smart-reply（DC-IQ）
#
# 定时不走这里：注册 Gateway cron 用 `bash inject_marketing_inbound_cron.sh inject`
# （declaration-key `dealclaw-marketing-inbound`，默认每 15 分钟）。
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_marketing_automation_inbound.py --company-id "${MIO_CDP_SUPPLIER_ID}" --no-dry-run
