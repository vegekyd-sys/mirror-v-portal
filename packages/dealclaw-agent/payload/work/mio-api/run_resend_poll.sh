#!/bin/bash
# DealClaw Resend poller — 手动跑一次的包装脚本。幂等：cursor + canonical 去重。
#
# 定时不走这里：线上是 Gateway cron `dealclaw-resend-poll`（每 5 分钟只跑
# dc_resend_source），由 runtime/dc-cron-resend-poll.sh 注册。
# 下面多跑的 dc_signal_push 是**手动兜底**：线上的推送决策走买家回复到达时的内联
# 路径（dc_webhook_handler / imap_sync 调 evaluate_reply_for_push）。
cd "$(dirname "$0")"
python3 -m dc_email_controller.dc_resend_source
# 拉完数据后做 Push 决策（live 模式下退信风险/未回复自动推送）
python3 -m dc_email_controller.dc_signal_push run
