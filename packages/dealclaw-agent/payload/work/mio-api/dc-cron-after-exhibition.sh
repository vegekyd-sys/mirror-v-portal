#!/usr/bin/env bash
# dc-cron-after-exhibition.sh — 展后买家推荐运行时薄启动脚本
#
# 只做三件事：
#   1. 单实例锁（每次只启动一个 worker）
#   2. 解析参数（--dry-run / --exhibition-id / --company-id / --manual）
#   3. 调用 Python Worker（dc_after_exhibition_runtime.py），透传返回码
#
# 不在 shell 中解析 JSON，主要逻辑全在 Python。
# 返回码约定：
#   0  成功 / 无需执行 / 无展会 / 延迟
#   1  失败（发送失败 / 配置错误 / 异常）
#   2  已有 worker 在运行（本次跳过）
#
# 用法:
#   dc-cron-after-exhibition.sh [--dry-run] [--exhibition-id <id>] [--company-id <sid>] [--manual]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIO_API_DIR="${WS_ROOT}/work/mio-api"
LOCK_FILE="${WS_ROOT}/data/after-exhibition/.cron.lock"
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p "$(dirname "${LOCK_FILE}")"

# ── 单实例锁 ────────────────────────────────────────────────
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    echo '{"code":"locked","summary":[],"detail":"another worker is running"}' >&2
    exit 2
fi

# ── 参数透传 ────────────────────────────────────────────────
ARGS=()
COMPANY_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) ARGS+=(--dry-run); shift ;;
        --manual)  ARGS+=(--manual); shift ;;
        --exhibition-id)
            ARGS+=(--exhibition-id "$2"); shift 2 ;;
        --company-id)
            COMPANY_ID="$2"; shift 2 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

# ── 调 Python Worker ────────────────────────────────────────
cd "${MIO_API_DIR}"
if [[ -n "${COMPANY_ID}" ]]; then
    "${PYTHON_BIN}" dc_after_exhibition_runtime.py --company-id "${COMPANY_ID}" "${ARGS[@]}"
else
    "${PYTHON_BIN}" dc_after_exhibition_runtime.py "${ARGS[@]}"
fi
exit $?
