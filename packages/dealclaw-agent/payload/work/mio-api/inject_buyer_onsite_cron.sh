#!/bin/bash
# 动态注入/移除 DealClaw 买家到场监控 cron（幂等）
# 用法: ./inject_buyer_onsite_cron.sh [inject|remove|status]
# 默认 inject；已存在则跳过，不重复注入。间隔 5 分钟（Tianyi 已确认）。

set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="run_buyer_onsite.sh"
LOG="/tmp/buyer-onsite.log"
INTERVAL="*/5"          # 每 5 分钟（Tianyi 明确允许）
MARKER="# DealClaw buyer onsite monitor"

CRON_LINE="${INTERVAL} * * * * bash ${WORKDIR}/${SCRIPT} >> ${LOG} 2>&1"

cmd="${1:-inject}"

case "$cmd" in
  inject)
    existing="$(crontab -l 2>/dev/null || true)"
    if echo "$existing" | grep -qF "${SCRIPT}"; then
      echo "已存在，跳过注入。"
      exit 0
    fi
    printf '%s\n%s\n%s\n' "$existing" "$MARKER" "$CRON_LINE" | crontab -
    echo "已注入：$CRON_LINE"
    ;;
  remove)
    existing="$(crontab -l 2>/dev/null || true)"
    if ! echo "$existing" | grep -qF "${SCRIPT}"; then
      echo "不存在，无需移除。"
      exit 0
    fi
    echo "$existing" | grep -vF "${SCRIPT}" | grep -vF "$MARKER" | crontab -
    echo "已移除。"
    ;;
  status)
    crontab -l 2>/dev/null | grep -F "${SCRIPT}" || echo "未注入。"
    ;;
  *)
    echo "用法: $0 [inject|remove|status]" >&2
    exit 2
    ;;
esac
