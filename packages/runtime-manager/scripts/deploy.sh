#!/usr/bin/env bash
# Deploy runtime-manager without interrupting a conversation.
#
# Restarting mid-turn leaves the run 'uncertain': the manager deliberately does
# not silently redo it, so the user gets "本次执行未能安全完成" instead of an
# answer. This waits for in-flight turns to finish before restarting.
#
#   ./scripts/deploy.sh [max-wait-seconds]
set -euo pipefail

HOST="${NEXUS_DEPLOY_HOST:-vlab}"
APP="${NEXUS_DEPLOY_PATH:-/opt/nexus/app}"
CONFIG="${NEXUS_DEPLOY_CONFIG:-/opt/nexus/data/config.json}"
MAX_WAIT="${1:-180}"

cd "$(dirname "$0")/../../.."

echo "→ 传输代码"
git archive --format=tar HEAD packages/runtime-manager pnpm-lock.yaml \
  | ssh -o ConnectTimeout=15 "$HOST" "tar -x -C $APP"

echo "→ 构建"
ssh -o ConnectTimeout=15 "$HOST" "cd $APP && export PATH=/opt/nexus/node/bin:\$PATH \
  && pnpm install --frozen-lockfile >/dev/null 2>&1 \
  && cd packages/runtime-manager && pnpm build 2>&1 | tail -1"

echo "→ 等待进行中的对话结束（最多 ${MAX_WAIT}s）"
ssh -o ConnectTimeout=15 "$HOST" "
TOKEN=\$(python3 -c \"import json;print(json.load(open('$CONFIG'))['adminToken'])\")
deadline=\$(( \$(date +%s) + $MAX_WAIT ))
while [ \$(date +%s) -lt \$deadline ]; do
  busy=\$(curl -s -m 10 -H \"authorization: Bearer \$TOKEN\" http://127.0.0.1:8097/api/state \
    | python3 -c \"
import json,sys
try: d=json.load(sys.stdin)
except: print(-1); raise SystemExit
print(sum(1 for r in d.get('runs',[]) if r.get('status') in ('queued','running')))
\" 2>/dev/null)
  [ \"\$busy\" = \"0\" ] && { echo '  没有进行中的对话'; break; }
  echo \"  等待 \$busy 轮对话完成…\"
  sleep 5
done
# A turn that outlives the window is interrupted knowingly rather than blocking
# the deploy forever; it will surface as 'uncertain' for review.
systemctl restart nexus-runtime-manager
sleep 5
echo \"  服务: \$(systemctl is-active nexus-runtime-manager)\"
"
echo "✓ 完成"
