#!/bin/bash
# DealClaw Resend poller — 定时拉投递状态 + 买家回复，驱动七信号引擎
# 每 30 分钟跑一次（Tianyi 已确认）。幂等：cursor + canonical 去重。
cd "$(dirname "$0")"
python3 -m dc_email_controller.dc_resend_source
