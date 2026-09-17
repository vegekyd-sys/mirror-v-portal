#!/bin/bash
# DealClaw 待发队列调度器 — 手动跑一次的包装脚本（补发 / 排查用）。
# 幂等：dc_pending_send.run 用文件锁 + status 状态机，重复扫描不重发。
#
# 定时不走这里：线上是 Gateway cron `dealclaw-pending-send`（每 30 分钟直接跑
# `python3 dc_pending_send.py run`），由 runtime/dc-cron-pending-send.sh 注册。
# 查状态 / 补跑：bash inject_pending_send_cron.sh status|run-now
cd "$(dirname "$0")"
python3 dc_pending_send.py run
