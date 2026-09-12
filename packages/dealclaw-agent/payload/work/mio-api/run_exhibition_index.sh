#!/bin/bash
# DealClaw 展会目录刷新 — 生成 index.md（A：接到流程，每天刷）
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_exhibition_index.py --company-id "${MIO_CDP_SUPPLIER_ID}" --write
