#!/bin/bash
# DealClaw Billing Recorder — DEPRECATED as a charging path.
#
# 计费已升级为「确定性触发」：dealclaw-billing 插件在 before_tool_call 做
# can-afford 预检、after_tool_call 做 estimate→settle（带幂等去重）。
#
# 本脚本保留为「意图信号」：插件检测到 exec 命令含 dealclaw-billing-record.sh
# 即触发计费（skillId + --group chat_id 从命令里解析）。脚本自身**不再**调用
# billing.mjs record，否则会与插件重复扣费。
#
# 兼容两种调用（仅作信号，不产生实际计费）：
#   1) bash scripts/dealclaw-billing-record.sh <tenantId> <skillId> [quantity]
#   2) bash scripts/dealclaw-billing-record.sh --group <chat_id> <skillId> [quantity]
set -uo pipefail
# Intentionally a no-op — billing is handled deterministically by the plugin.
exit 0
