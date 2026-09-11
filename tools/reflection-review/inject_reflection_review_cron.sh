#!/usr/bin/env bash
# inject_reflection_review_cron.sh — 注入「仅测试母体运行」的每日候选调度（幂等）
#
# - 每 30 分钟唤起一次；脚本内部按 knight.config.json 业务时区判断是否到 21:30 窗口，
#   且仅当 environment=test_mother 且 enabled=true 才真正运行（否则静默 skip）。
# - 幂等：同名标记重复注入不重复添加。
set -euo pipefail

MOTHER="${1:-/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw}"
SCRIPT="$MOTHER/tools/reflection-review/reflection_scheduler.py"
MARK="# reflection-review daily candidates (test-mother only)"
LINE="*/30 * * * * cd $MOTHER && python3 $SCRIPT --workspace $MOTHER >> /tmp/reflection-review.log 2>&1 $MARK"

if crontab -l 2>/dev/null | grep -qF "$MARK"; then
  echo "[inject] 已存在，跳过"
else
  (crontab -l 2>/dev/null; echo "$LINE") | crontab -
  echo "[inject] 已注入：$LINE"
fi
echo "[inject] 当前相关 cron："; crontab -l 2>/dev/null | grep -F "$MARK" || true
