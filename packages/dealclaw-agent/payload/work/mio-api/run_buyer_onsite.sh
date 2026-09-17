#!/bin/bash
# DealClaw 买家到场监控 — 手动跑一次的包装脚本。
# 拉「买家到场」通知（notice-list msg-type 3），有新到场 → 推展商群。
# 幂等：monitor_buyer_onsite.py 用 state 文件去重，重复轮询不重复推送。
#
# 定时不走这里：线上是 Gateway cron `dealclaw-buyer-onsite-monitor`（每 5 分钟），
# 由 runtime/dc-cron-buyer-onsite.sh 注册。查状态：bash inject_buyer_onsite_cron.sh status
cd "$(dirname "$0")"
set -a
[ -f .env ] && . .env
set +a
python3 monitor_buyer_onsite.py
