#!/usr/bin/env bash
# Refresh the V-derived parts of the Mirror V full payload from V's live workspace
# (git HEAD only, never uncommitted files): generic Skills, the self-evolution and
# Librarian scripts, and the memory-graph viewer. Identity documents and the memory
# skeleton are maintained by hand in this directory and are not overwritten.
# Read-only on V. Usage: packages/agent-templates/mirror-v-full/sync-from-v.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$here/payload"
ws=/home/openclaw/makaron-openclaw/.openclaw-local/workspace
skills=(auto-travel-vlog corporate-video-script creative-production-orchestrator html-executive-pitch-deck-iteration
  html-poster-design image-production-routing-qc image-search-apify-first long-term-memory-update makaron-video
  makaron-remotion-materialize memory-promotion-audit meshy-3d-agent openclaw-harness-evaluation proactive-agent
  skill-creation-coach skill-gate social-search-apify-first technical-project-research tiktok-publish-copy
  viral-absurd-demo-video viral-extreme-product-demo viral-impossible-test-video)
scripts=(librarian-adopt-untracked.py librarian-reachability.py librarian-relations.py librarian-daily-queue.py
  memory-graph.py memory-graph.template.html write-reflection.py reflection-analyzer.py reflection-capture.py
  write-skill-candidate.py compress-memory.py wiki-maintenance.py heartbeat.py heartbeat-dispatch.py
  memory-auto-index.py skill-candidate-rollback.py)
# Makaron: only the official part (no Feishu cards or V worker integration).
paths=("${skills[@]/#/skills/}" "${scripts[@]/#/scripts/}" skills/makaron/SKILL.md skills/makaron/COMPOSITE.json skills/makaron/parts/official)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Only paths tracked at HEAD; a missing one fails the sync instead of shipping a partial payload.
ssh v "sudo -n -u openclaw git -C $ws archive --format=tar HEAD -- ${paths[*]}" | tar -xf - -C "$tmp"
ssh v "sudo -n -u openclaw git -C $ws rev-parse HEAD" > "$tmp/.v-workspace-commit"
# The graph viewer's vendored library is not tracked in V's git.
ssh v "sudo -n -u openclaw tar -cf - -C $ws artifacts/memory-graph/vendor/force-graph.min.js" | tar -xf - -C "$tmp"
for dir in skills artifacts; do rm -rf "$payload/$dir"; cp -R "$tmp/$dir" "$payload/$dir"; done
# scripts/ also holds Mirror-only scripts (import-v001-sample.sh); replace only V's files.
mkdir -p "$payload/scripts"; cp -R "$tmp/scripts/." "$payload/scripts/"
cp "$tmp/.v-workspace-commit" "$here/V_WORKSPACE_COMMIT"
# Sandbox paths and agent id instead of V's host layout.
find "$payload/scripts" "$payload/skills" -type f \( -name '*.py' -o -name '*.md' -o -name '*.sh' \) -print0 \
  | xargs -0 sed -i '' -e 's#/home/openclaw/makaron-openclaw/.openclaw-local/workspace#/vercel/sandbox/agent-data/workspace#g' -e 's#agent:makaron:#agent:mirror-v-full:#g'
# No V host paths, no V's Feishu groups, and no named owner in the shipped text.
sed -i '' 's#/home/openclaw/.openclaw/logs/memory-auto-index.log#/vercel/sandbox/agent-data/state/logs/memory-auto-index.log#' "$payload/scripts/memory-auto-index.py"
sed -i '' 's#^DEFAULT_REPORT_CHAT_ID = ".*"#DEFAULT_REPORT_CHAT_ID = ""#' "$payload/scripts/heartbeat-dispatch.py"
find "$payload/scripts" "$payload/skills" -type f \( -name '*.py' -o -name '*.md' -o -name '*.sh' \) -print0 \
  | xargs -0 sed -i '' -e "s/Tianyi's/the owner's/g" -e 's/Tianyi/the owner/g'
echo "synced from V workspace $(cat "$here/V_WORKSPACE_COMMIT")"
grep -rn -e '/home/openclaw' -e 'ou_[0-9a-f]\{20,\}' -e 'oc_[0-9a-f]\{20,\}' "$payload/scripts" "$payload/skills" | head -20 || true
