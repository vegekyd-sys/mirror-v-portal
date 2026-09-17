#!/bin/bash
# dc-cron-ai-hunter.sh — 注入 AI猎客每日推送定时任务（每天 10:00，agent-turn 类型）
#
# 需求（2026-09-17）：小元供应商若已开启 AI猎客服务，则每天早上 10:00 定时触发
# 每日推送。任务本体是 **agent-turn**（智能体按 dealclaw-ai-hunter 技能跑），不是
# shell 命令 —— 因为 AI猎客是 V4.4「纯适配器版」技能：payload 里没有任何可调脚本，
# 能力全在适配器（blade-agent-adapter）的 6 个 HTTP 端点上。
#
# 闸门放在 prompt 里而不是注册时：job 每天都触发，但智能体第一步先调
# hunter-status-get；status != 1（未开启 / 已停用 / 无记录）直接 NO_RUN ——
# 不推送、不发消息。这样「开启即生效、停用即静默」，不需要为每个租户改注册。
#
# 幂等：`openclaw cron add --declaration-key` 是声明式 converge；schedule 过
# dc-cron-converge.py 三方合并，避免把用户手改的时间打回镜像默认值。
# 注册后回读 `openclaw cron list --all --json` 复查（2026-09-16 漏挂事故的补丁）。
#
# 用法:
#   dc-cron-ai-hunter.sh                  # 默认 Asia/Shanghai
#   dc-cron-ai-hunter.sh --tz Asia/Shanghai
#
# 环境变量:
#   DEALCLAW_CRON_TZ   默认时区（优先级低于 --tz）

set -euo pipefail

TZ="${DEALCLAW_CRON_TZ:-Asia/Shanghai}"
DECL_KEY="dealclaw-ai-hunter-daily"
NAME="dealclaw-ai-hunter-daily"
EXPR="0 10 * * *"
CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tz) TZ="${2:-Asia/Shanghai}"; shift 2 ;;
    --tz=*) TZ="${1#--tz=}"; shift ;;
    *) echo "[dc-cron-ai-hunter] 未知参数: $1" >&2; exit 1 ;;
  esac
done

python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('$TZ')" 2>/dev/null \
  || { echo "[dc-cron-ai-hunter] 非法时区: $TZ" >&2; exit 1; }

# ── 任务 prompt（agent-turn）──
# 注意：本段不得出现单引号，否则下面的单引号赋值会断。
PROMPT='【AI猎客 · 每日推送】每天 10:00 的自动任务，在租户 agent 内运行，无需用户在场。

第一步（闸门）：读 dealclaw-ai-hunter 技能，只做一件事——调 hunter-status-get
（POST {ADAPTER}/agent/company/getHunterStatus.json，用飞书头对 X-Feishu-Open-Id + X-Supplier-Id 鉴权，
supplier_id 取当前群绑定值）。
- 若 status 不是 1（未开启 / 已停用 / 无记录；无记录按 0 处理）：本次不做任何推送、不向任何群发消息，直接结束（NO_RUN）。
- 若 status 是 1：继续第二步。

第二步（每日推送）：按 dealclaw-ai-hunter 技能的「每日九维打分推送」流程执行——
拉当日候选（leads-plaza-page）→ 按九维打分生成推荐卡片 → 推送到当前租户已绑定的飞书群。
所有卡片发完后，最后补发一条收尾消息（定制询盘引导 + 运营二维码，整批只发一次）。

硬约束：
- 严禁编造点数、价格、画像、二维码、联系方式；运营二维码只能来自 AI_HUNTER_OPS_QR_URL，未配置就省略该行。
- 本任务不得调用 lead-contact-detail（解锁扣 360 点，必须等用户明确确认后由对话内触发）。
- 无候选买家时不发空卡片、不发「今日无推荐」之类的噪声消息，直接结束。'

# ── schedule 三方合并（镜像默认值 vs 用户手改）──
sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" --cron "$EXPR" --tz "$TZ")" || {
  echo "[dc-cron-ai-hunter] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
}
eval "$sched_env"

openclaw cron add "$DC_CRON_EXPR" "$PROMPT" \
  --tz "$DC_CRON_TZ" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 1800 \
  --declaration-key "$DECL_KEY" \
  --name "$NAME" \
  --description "AI猎客每日推送（${DC_CRON_EXPR} @ ${DC_CRON_TZ}；仅当供应商已开启服务时执行，否则 NO_RUN）"

# 注册成功后才记录基线：提前记录会让 add 失败时把现状误判成用户修改
python3 "$CONVERGE" record --decl-key "$DECL_KEY" --cron "$EXPR" --tz "$TZ" \
  || echo "[dc-cron-ai-hunter] 基线记录失败（不影响本次注册，但下次升级可能误判）" >&2

# ── 回读复查（2026-09-16 事故的直接补丁，不允许省）──
out="$(openclaw cron list --all --json 2>&1)" || {
  echo "[dc-cron-ai-hunter] 回读失败（gateway 不通？）：${out:0:200}" >&2
  exit 1
}

if ! printf '%s' "$out" | python3 - "$DECL_KEY" <<'PY'
import json
import sys

key = sys.argv[1]
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(2)

if isinstance(data, dict):
    data = (
        data.get("jobs")
        or (data.get("result") or {}).get("jobs")
        or data.get("result")
        or []
    )
if not isinstance(data, list):
    sys.exit(2)

for job in data:
    if isinstance(job, dict) and job.get("declarationKey") == key:
        if job.get("enabled", True):
            print(f"[dc-cron-ai-hunter] 已确认: {key} 已注册且启用")
            sys.exit(0)
        print(f"[dc-cron-ai-hunter] {key} 存在但被停用（用户手改？保持停用，不覆盖）")
        sys.exit(0)
sys.exit(1)
PY
then
  echo "[dc-cron-ai-hunter] 回读复查未通过：$DECL_KEY 不在 Gateway cron 列表里" >&2
  exit 1
fi

echo "[dc-cron-ai-hunter] 完成（时区: $TZ）"
