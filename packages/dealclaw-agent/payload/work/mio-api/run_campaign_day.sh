#!/bin/bash
# INTEX Brazil 2026 邮件营销 — 每日批次发送（工作日 cron 调用）
# 幂等：send_next_batch.py 会自动跳过已发送的批次，发完 day9 后自动退出。
set -euo pipefail

# 读取 Resend API Key（两种 .env 位置兜底）
if [ -z "${RESEND_API_KEY:-}" ]; then
  for ENV in /home/openclaw/.openclaw/.env /home/openclaw/makaron-openclaw/.openclaw-local/workspace/.env; do
    if [ -f "$ENV" ]; then
      KEY=$(grep -E '^RESEND_API_KEY=' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
      if [ -n "$KEY" ]; then export RESEND_API_KEY="$KEY"; break; fi
    fi
  done
fi

cd /home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/work/mio-api
python3 send_next_batch.py
