#!/usr/bin/env bash
# Import the V001 sample memory (an early company-knowledge example of V) as
# read-only raw material under memory/imports/v001/. The owner chooses this
# during bootstrap; delete the directory to remove it again.
set -euo pipefail
seed=/vercel/sandbox/nexus/seeds/v001.tar
ws=/vercel/sandbox/agent-data/workspace
test -f "$seed" || { echo "V001 sample is not available in this runtime" >&2; exit 2; }
test -e "$ws/memory/imports/v001" && { echo "already imported at memory/imports/v001" >&2; exit 0; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tar -xf "$seed" -C "$tmp" --wildcards 'memory/*'
mkdir -p "$ws/memory/imports"
mv "$tmp/memory" "$ws/memory/imports/v001"
count="$(find "$ws/memory/imports/v001" -type f | wc -l | tr -d ' ')"
cat > "$ws/memory/imports/v001/README.md" <<NOTE
# V001 示范记忆（导入于 $(date +%F)）

V 早期的一份公司知识示范，只读参考，不代表主人的事实。Librarian 不编译这里的内容；需要用到时引用原文件。删除整个目录即可移除。
NOTE
cd "$ws"
git add -- memory/imports/v001 >/dev/null
git commit -qm "memory: import V001 sample ($count files)" || true
node /vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs memory index --agent "${NEXUS_AGENT_ID:-mirror-v-full}" >/dev/null 2>&1 || true
echo "imported $count files into memory/imports/v001"
