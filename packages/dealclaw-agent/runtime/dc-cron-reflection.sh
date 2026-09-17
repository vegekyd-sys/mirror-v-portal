#!/bin/bash
# dc-cron-reflection.sh — 幂等注入 DealClaw reflection heartbeat cron（6h，command 类型）
#
# 设计（结合两处）：
#   - 对齐 V 的「Knight Heartbeat」：reflection 由 cron 控频（6h），不靠 agent heartbeat。
#   - 沿用 payload runtime 的 dc-cron-*.sh 风格：openclaw cron add + --declaration-key
#     （同名键自动 converge：无差异 no-op / 有差异原地更新 / 缺失新建）。
#
# 幂等：靠 --declaration-key，无需先查存在性。
# 开关：仅当 knight.config.json 的 heartbeat.enabled=true 才注入；
#       可用 DEALCLAW_REFLECTION_ENABLED=true|false 强制覆盖。
#
# 用法:
#   dc-cron-reflection.sh                       # 默认 6h @ Asia/Shanghai
#   dc-cron-reflection.sh --tz Europe/Berlin
#   dc-cron-reflection.sh --cron "0 */6 * * *"  # 用 cron 表达式替代 --every
#
# 环境变量:
#   DEALCLAW_CRON_TZ            默认时区（低于 --tz）
#   DEALCLAW_WORKSPACE          agent 工作区（默认 /data/workspace）
#   DEALCLAW_AGENT              agent id（默认 dealclaw）
#   DEALCLAW_REFLECTION_ENABLED 强制开关 true|false（覆盖 knight.config）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
WS="${DEALCLAW_WORKSPACE:-/data/workspace}"
AGENT="${DEALCLAW_AGENT:-dealclaw}"
DECL_KEY="dealclaw-reflection-heartbeat"
EVERY=""      # 留空表示未指定；稍后由 knight.config.heartbeat.interval_hours 或默认 6h 填充
CRON_EXPR=""

# ── 参数解析 ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    --every) EVERY="${2:-6h}"; shift 2 ;;
    --every=*) EVERY="${1#--every=}"; shift ;;
    --cron) CRON_EXPR="${2:-}"; shift 2 ;;
    --cron=*) CRON_EXPR="${1#--cron=}"; shift ;;
    *) echo "[dc-cron-reflection] 未知参数: $1" >&2; exit 1 ;;
  esac
done

# ── 校验时区合法（IANA）──
python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-reflection] 非法时区: $TZ" >&2; exit 1; }

# ── 读取开关与周期（knight.config.heartbeat.enabled / interval_hours）──
read -r enabled interval_hours <<<"$(python3 - "$WS" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1]) / "knight.config.json"
try:
    c = json.loads(p.read_text(encoding="utf-8"))
except Exception:
    c = {}
hb = c.get("heartbeat") or {}
iv = hb.get("interval_hours")
iv = str(int(iv)) if isinstance(iv, (int, float)) and iv > 0 else ""
print(("1" if hb.get("enabled") else "0") + " " + iv)
PY
)"
case "${DEALCLAW_REFLECTION_ENABLED:-}" in
  true)  enabled="1" ;;
  false) enabled="0" ;;
esac

if [[ "$enabled" != "1" ]]; then
  echo "[dc-cron-reflection] heartbeat.enabled 非 true，跳过注入（可 DEALCLAW_REFLECTION_ENABLED=true 强制）"
  exit 0
fi

# ── schedule 参数（--every 6h 或 --cron 表达式）──
# DECLARED_* 是本次镜像声明的默认值，交给 dc-cron-converge.py 与用户手改做三方合并
if [[ -n "$CRON_EXPR" ]]; then
  DECLARED_ARGS=(--cron "$CRON_EXPR" --tz "$TZ")
else
  # 周期优先级：CLI --every > knight.config.heartbeat.interval_hours > 6h
  [[ -z "$EVERY" ]] && EVERY="${interval_hours:+${interval_hours}h}"
  [[ -z "$EVERY" ]] && EVERY="6h"
  DECLARED_ARGS=(--every "$EVERY")
fi

CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"
if ! sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" "${DECLARED_ARGS[@]}")"; then
  echo "[dc-cron-reflection] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
fi
eval "$sched_env"

if [[ "$DC_CRON_KIND" == "cron" ]]; then
  SCHED_ARGS=(--cron "$DC_CRON_EXPR" --tz "$DC_CRON_TZ")
  SCHED_DESC="${DC_CRON_EXPR} @ ${DC_CRON_TZ}"
else
  SCHED_ARGS=(--every "$DC_CRON_EVERY")
  SCHED_DESC="每 ${DC_CRON_EVERY}ms"
fi

# ── 注入（add 自带 converge，幂等）──
openclaw cron add \
  "${SCHED_ARGS[@]}" \
  --agent "$AGENT" \
  --name "dealclaw-reflection-heartbeat" \
  --command "python3 scripts/heartbeat.py" \
  --command-cwd "$WS" \
  --command-env "DEALCLAW_WORKSPACE=$WS" \
  --no-deliver \
  --timeout-seconds 900 \
  --declaration-key "$DECL_KEY" \
  --description "DealClaw reflection heartbeat（${SCHED_DESC}）"

# 注册成功后才记录基线：提前记录会让 add 失败时把现状误判成用户修改
python3 "$CONVERGE" record --decl-key "$DECL_KEY" "${DECLARED_ARGS[@]}" \
  || echo "[dc-cron-reflection] 基线记录失败（不影响本次注册，但下次升级可能误判）" >&2

echo "[dc-cron-reflection] 已同步：dealclaw-reflection-heartbeat（${SCHED_DESC}，schedule 来源: ${DC_CRON_SOURCE}）"
