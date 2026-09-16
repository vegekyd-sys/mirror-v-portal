#!/bin/bash
# dc-cron-onsite-recommend.sh — 幂等注入 DealClaw 现场推荐 cron（每小时一次，时点判断在脚本里）
#
# 2026-09-16 改造：时区判断从「注册时」搬到「运行时」。
#
# 旧做法：注册时查一次展会国家 → 把当地 10/14/16 点换算成北京时间 → 注册 3 条 cron。
# 两个问题：
#   1. 只在容器启动时解析一次。巴西展换成美国展，pod 不重启就一直按巴西时间跑。
#   2. 换算探针写死 1 月 1 日，美国/欧洲展会在夏令时期间偏 1 小时（波兰/德国/
#      土耳其/俄罗斯同样中招；巴西 2019 年废除夏令时，不受影响）。
#
# 新做法：注册 1 条每小时的 cron，带 --slot-gate。dc_onsite_recommend.py 自己按
# 「有没有在展展会 → 哪个国家 → 展会当地几点」判断要不要跑，不到点就 NO_RUN。
# 展会换国家立即生效，夏令时由 ZoneInfo 自动处理，国家→时区表已搬进 py。
#
# 为什么每小时够：北京每小时一次，等价于任何时区每小时正好一次，每个「当地小时」
# 恰好覆盖一次，天然不会重复推送。印度这类 +5:30 的时区，北京整点对应当地 :30，
# 小时值仍然正确（10:30 的 hour 是 10），照样命中。
#
# API 成本：py 侧对 state=3 展会记录做了 6 小时缓存（空结果也缓存），实际 API 调用
# 约 4 次/天，和改造前 3 次/天基本持平。
#
# 用法:
#   dc-cron-onsite-recommend.sh
#
# 环境变量:
#   DEALCLAW_MIO_DIR              mio-api 目录（默认 /data/workspace/work/mio-api）
#   DEALCLAW_ONSITE_SLOTS         推荐时点（展会当地整点，逗号分隔；默认 py 侧的 10,14,16）

set -euo pipefail

MIO_DIR="${DEALCLAW_MIO_DIR:-/data/workspace/work/mio-api}"
SUPPLIER_ID="${MIO_CDP_SUPPLIER_ID:-}"
OPEN_ID="${MIO_V_OPEN_ID:-}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
DECL_KEY="dealclaw-onsite-recommend"
SLOTS="${DEALCLAW_ONSITE_SLOTS:-}"
CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"

# ── 清理旧的三条（10h/14h/16h）──────────────────────────────────
# declarationKey 变了，旧 job 不会自动消失，不删就会和新的每小时 job 重复推送。
# 用 cron list 按 declarationKey 反查 id 再删；查不到就跳过（全新租户/已清理过）。
cleanup_legacy() {
  local legacy_keys="${DECL_KEY}-10h ${DECL_KEY}-14h ${DECL_KEY}-16h"
  local listing
  listing="$(openclaw cron list --all --json 2>/dev/null)" || {
    echo "[dc-cron-onsite-recommend] 无法读取 cron 列表，跳过旧 job 清理（下次启动重试）" >&2
    return 0
  }
  local ids
  ids="$(printf '%s' "$listing" | LEGACY_KEYS="$legacy_keys" python3 -c "
import json, os, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
jobs = payload.get('jobs') if isinstance(payload, dict) else payload
if not isinstance(jobs, list):
    sys.exit(0)
legacy = set(os.environ.get('LEGACY_KEYS', '').split())
for job in jobs:
    if isinstance(job, dict) and job.get('declarationKey') in legacy and job.get('id'):
        print(job['id'])
")"
  [[ -z "$ids" ]] && return 0
  while read -r id; do
    [[ -z "$id" ]] && continue
    if openclaw cron rm "$id" >/dev/null 2>&1; then
      echo "[dc-cron-onsite-recommend] 已删除旧 job: $id"
    else
      echo "[dc-cron-onsite-recommend] 旧 job 删除失败（不阻断）: $id" >&2
    fi
  done <<< "$ids"
}

cleanup_legacy

# ── schedule 三方合并：镜像默认值 vs 用户手改（见 dc-cron-converge.py）──
# 注意：这里的 schedule 现在只是「多久轮询一次」，不再是「几点推荐」。
# 推荐时点由 --slots / DEALCLAW_ONSITE_SLOTS 控制，属于 payload，会随镜像覆盖。
if ! sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" --cron "0 * * * *" --tz "Asia/Shanghai")"; then
  echo "[dc-cron-onsite-recommend] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
fi
eval "$sched_env"

CMD="python3 dc_onsite_recommend.py run --slot-gate"
[[ -n "$SLOTS" ]] && CMD="$CMD --slots $SLOTS"

openclaw cron add \
  --cron "$DC_CRON_EXPR" \
  --tz "$DC_CRON_TZ" \
  --command "$CMD" \
  --command-cwd "$MIO_DIR" \
  --command-env "MIO_CDP_SUPPLIER_ID=$SUPPLIER_ID" \
  --command-env "MIO_V_OPEN_ID=$OPEN_ID" \
  --command-env "OPENCLAW_WORKSPACE_DIR=$WORKSPACE_DIR" \
  --no-deliver \
  --timeout-seconds 900 \
  --declaration-key "$DECL_KEY" \
  --name "dealclaw-onsite-recommend" \
  --description "DealClaw 现场推荐（每小时轮询，展会当地 ${SLOTS:-10,14,16} 点命中才推）"

python3 "$CONVERGE" record --decl-key "$DECL_KEY" --cron "0 * * * *" --tz "Asia/Shanghai" \
  || echo "[dc-cron-onsite-recommend] 基线记录失败（不影响本次注册，但下次升级可能误判）" >&2

echo "[dc-cron-onsite-recommend] 已同步（${DC_CRON_EXPR}，时点 ${SLOTS:-10,14,16} 按展会当地时间判断，schedule 来源: ${DC_CRON_SOURCE}）"
