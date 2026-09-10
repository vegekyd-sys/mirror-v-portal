#!/bin/bash
# DealClaw 展自动营销「入站」触发桥 — 买家回复 → 触发 smart-reply（DC-IQ）
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_marketing_automation_inbound.py --company-id "${MIO_CDP_SUPPLIER_ID}" --no-dry-run
