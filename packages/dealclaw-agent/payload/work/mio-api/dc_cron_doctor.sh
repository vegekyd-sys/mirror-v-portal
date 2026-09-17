#!/bin/bash
# dc_cron_doctor.sh — 一眼看清 DealClaw 的定时任务到底有没有挂上
#
# 2026-09-16 那次 27 封定时邮件没发出去，事后才发现「pending-send 调度器压根没注册」。
# 当时没有任何地方能一眼看出这件事：inject 脚本跑完不报错，队列里静静堆着。
# 这个脚本就是补这个洞 —— 把「该有的定时任务」列成清单，逐条对着 Gateway 核。
#
# 用法:
#   bash dc_cron_doctor.sh            # 体检
#   bash dc_cron_doctor.sh --json     # 直接吐 openclaw cron list 的原始 JSON
#
# 退出码: 0 必需任务全部已注册/已启用/已排期；1 有必需任务出问题；2 读不到现状

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 镜像层 runtime/dc-cron-*.sh 注册，entrypoint 每次启动都会 converge。
# 少任何一条都说明镜像那边出事了（改动见 docs/cron-timers.md）。
REQUIRED="dealclaw-morning,dealclaw-evening,dealclaw-resend-poll,dealclaw-email-reply-poll,dealclaw-buyer-onsite-monitor,dealclaw-onsite-recommend,dealclaw-reflection-heartbeat,dealclaw-pending-send"

# payload 层 inject_*_cron.sh 按租户注册，不开就没有，缺失不算故障。
OPTIONAL="dealclaw-marketing-automation,dealclaw-marketing-inbound,dealclaw-exhibition-index"

command -v openclaw >/dev/null 2>&1 || {
  echo "[dc-cron-doctor] 找不到 openclaw CLI，无法读取 Gateway cron。" >&2
  exit 2
}

JOBS="$(openclaw cron list --all --json 2>&1)" || {
  echo "[dc-cron-doctor] openclaw cron list 失败（gateway 不通？）：${JOBS}" >&2
  exit 2
}

if [[ "${1:-}" == "--json" ]]; then
  printf '%s\n' "$JOBS"
  exit 0
fi

echo "DealClaw 定时任务体检（调度器：OpenClaw Gateway scheduler，非系统 crontab）"
echo ""

rc=0
printf '%s' "$JOBS" | python3 "$HERE/dc_cron_query.py" doctor \
  --required "$REQUIRED" --optional "$OPTIONAL" || rc=$?

# 顺手看一眼系统 crontab：镜像里本来就没有 crontab，真有残留说明是在别的机器上跑，
# 而那台机器上的老行会和 Gateway cron 双份并跑。
if command -v crontab >/dev/null 2>&1; then
  legacy="$(crontab -l 2>/dev/null | grep -F "DealClaw" || true)"
  if [[ -n "$legacy" ]]; then
    echo ""
    echo "⚠️ 系统 crontab 里还有 DealClaw 残留行（会和 Gateway cron 双份并跑）："
    printf '%s\n' "$legacy" | sed 's/^/    /'
    echo "    跑对应的 inject_*_cron.sh inject 会自动摘掉，或手动 crontab -e 删。"
  fi
fi

exit "$rc"
