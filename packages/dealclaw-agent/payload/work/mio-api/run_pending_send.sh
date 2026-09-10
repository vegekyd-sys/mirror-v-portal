#!/bin/bash
# DealClaw 待发队列调度器 — 每 30 分钟扫「到点且未发」的待发项 → 发送 → 回执
# 幂等：dc_pending_send.run 用文件锁 + status 状态机，重复扫描不重发。
cd "$(dirname "$0")"
python3 dc_pending_send.py run
