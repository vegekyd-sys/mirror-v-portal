#!/bin/bash
# DealClaw 展会目录刷新 — 手动跑一次的包装脚本，生成 index.md。
#
# 定时不走这里：注册 Gateway cron 用 `bash inject_exhibition_index_cron.sh inject`
# （declaration-key `dealclaw-exhibition-index`，默认每天 08:00）。
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 dc_exhibition_index.py --company-id "${MIO_CDP_SUPPLIER_ID}" --write
