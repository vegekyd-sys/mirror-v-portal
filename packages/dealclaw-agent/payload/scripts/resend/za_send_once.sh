#!/bin/bash
# 一次性触发：今晚20:30发送南非户外家具邮件，发完自删 cron。
# 显式设置完整环境。
set -u

export HOME=/home/openclaw
export PATH=/usr/bin:/bin:/opt/node-v22.23.1/bin:/usr/local/bin:/usr/sbin:/sbin
export LARK_CLI_CONFIG_PATH=/home/openclaw/.lark-cli/openclaw
export LANG=en_US.UTF-8

cd /home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw || exit 1

# 防重复
if [ -f /tmp/za_email_results.json ] && grep -q '"ok": true' /tmp/za_email_results.json 2>/dev/null; then
  echo "$(date) 已发送过，跳过" >> /tmp/za-send.log
else
  /usr/bin/python3 scripts/resend/za_email_sender.py >> /tmp/za-send.log 2>&1
fi

# 发送完成后删除本条一次性 cron
( crontab -l 2>/dev/null | grep -v 'za_send_once.sh' ) | crontab -
