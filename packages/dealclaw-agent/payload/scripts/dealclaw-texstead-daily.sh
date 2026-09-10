#!/usr/bin/env bash
# scripts/dealclaw-texstead-daily.sh
# DealClaw 每日定时任务：TexStead 买家发现 + 触达处理
# 路径全部相对脚本自身，workspace 单数 → workspaces 数空间同步后仍可用
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"   # workspace 根（scripts/ 的上一级）
SEARCH="$WORKSPACE/skills/dealclaw-find-buyers/scripts/search_aiv2.py"

TODAY=$(date +%Y%m%d)
RESULTS="$WORKSPACE/work/texstead-outreach/daily-$TODAY/buyers.jsonl"
CHAT_ID="oc_875378492c224d7265da689b4c902b38"

# 如果没有今日结果，跑一次发现
if [ ! -f "$RESULTS" ]; then
  python3 "$SEARCH" \
    --tag-keyword "home textile cushion pillow bedding" \
    --countries-json DE --page-size 3 > /dev/null 2>&1
  python3 "$SEARCH" \
    --tag-keyword "home decor cushion pillow wholesale" \
    --countries-json ES --page-size 3 > /dev/null 2>&1
  python3 "$SEARCH" \
    --tag-keyword "home textile bedding importer" \
    --countries-json FR --page-size 3 > /dev/null 2>&1
fi

# 发送触达结果到群
lark-cli im +messages-send --chat-id "$CHAT_ID" \
  --text "📬 DealClaw · TexStead 今日处理完成。@徐洋总 回复「看结果」查看触达。" \
  --as bot 2>/dev/null
