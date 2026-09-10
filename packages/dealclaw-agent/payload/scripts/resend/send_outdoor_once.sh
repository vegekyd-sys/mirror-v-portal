#!/bin/bash
# 户外家具邮件定时发送（读本地 JSON，不依赖 lark-cli）
# 用法: send_outdoor_once.sh 南非|巴西
set -u
export HOME=/home/openclaw
export PATH=/usr/bin:/bin:/opt/node-v22.23.1/bin:/usr/local/bin:/usr/sbin:/sbin
export LANG=en_US.UTF-8
cd /home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw || exit 1
COUNTRY="$1"
RESULT="/tmp/${COUNTRY}_email_results.json"
if [ -f "$RESULT" ] && grep -q '"ok": true' "$RESULT" 2>/dev/null; then
  echo "$(date) ${COUNTRY}已发送过，跳过" >> /tmp/${COUNTRY}-send.log
else
  /usr/bin/python3 scripts/resend/send_outdoor_email.py "$COUNTRY" >> /tmp/${COUNTRY}-send.log 2>&1
fi
