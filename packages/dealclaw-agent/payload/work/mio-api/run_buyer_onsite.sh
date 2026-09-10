#!/bin/bash
# DealClaw 买家到场监控轮询 — 每 5 分钟拉「买家到场」通知（notice-list msg-type 3），
# 检测到新到场 → openclaw message 推到展商群。
# 幂等：monitor_buyer_onsite.py 用 state 文件去重，重复轮询不重复推送。
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 monitor_buyer_onsite.py
