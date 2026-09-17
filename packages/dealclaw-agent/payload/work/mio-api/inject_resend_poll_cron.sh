#!/bin/bash
# inject_resend_poll_cron.sh — 注册 DealClaw Resend poller（Gateway cron）
#
# 调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**——镜像里没有 cron
# 守护进程，往 crontab 写任务会静默失败（2026-09-16 的 27 封邮件就是这么丢的）。
#
# 归属：镜像层 runtime/dc-cron-resend-poll.sh 托管（容器每次启动都会自动注册）。
# 本脚本是人工运维入口；在容器里 inject 会直接委托给 runtime 脚本，避免两边声明漂移。
#
# ⚠️ 注意与 run_resend_poll.sh 的差异：那个手动包装脚本在拉完投递状态后还会跑一遍
#    `dc_email_controller.dc_signal_push run` 批量推送决策。线上这条 cron 只跑
#    dc_resend_source —— 推送决策走买家回复到达时的内联路径
#    （dc_webhook_handler / imap_sync 调 evaluate_reply_for_push）。要把批量兜底也
#    挂上定时，改 runtime/dc-cron-resend-poll.sh，别在这里另开一条 job（会双拉 Resend）。
#
# 用法: ./inject_resend_poll_cron.sh [inject|status|remove|enable|run-now|purge] [--tz <IANA>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc_cron_lib.sh"

DC_CRON_TAG="resend-poll"
DC_CRON_DECL_KEY="dealclaw-resend-poll"
DC_CRON_NAME="dealclaw-resend-poll"
DC_CRON_SUMMARY="DealClaw Resend poller"
DC_CRON_RUNTIME_SCRIPT="dc-cron-resend-poll.sh"

# 非容器环境下自行注册时用的声明（与 runtime/dc-cron-resend-poll.sh 保持一致）
# RESEND_API_KEY 由 dc_resend_source 自己从 <mio-api>/.env 读，不在这里传
DC_CRON_COMMAND="python3 -m dc_email_controller.dc_resend_source"
DC_CRON_DEFAULT_EXPR="*/5 * * * *"
DC_CRON_TIMEOUT_SECONDS=240
DC_CRON_DUP_MATCH="dc_resend_source"
DC_CRON_LEGACY_MATCH=("run_resend_poll.sh" "# DealClaw Resend poller")

dc_cron::main "$@"
