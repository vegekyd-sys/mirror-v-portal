#!/usr/bin/env bash
# Bring V's evolution into the Mirror V full payload — repeatably, without losing
# what Mirror changed on top.
#
# V keeps evolving its Librarian / heartbeat / skills; Mirror adapts some of the
# same files (the onboarding import queue in librarian-daily-queue.py, lint
# without V's private scripts in wiki-maintenance.py, …). Overwriting would drop
# those adaptations, so every V-owned file is merged three ways:
#
#   base   = V at the commit recorded in V_WORKSPACE_COMMIT (what Mirror last took)
#   theirs = V at HEAD now
#   ours   = the file in this payload
#
# base and theirs go through the same sanitising (sandbox paths, agent id, no
# owner name) before the merge, so Mirror's earlier sanitising never shows up as
# a difference. A file Mirror never touched simply becomes V's new version; a new
# V file is added; a conflict leaves standard markers and the script exits 1
# listing the files — resolve them, then run `node gen-manifest.mjs …`.
#
# Read-only on V (git HEAD only, never uncommitted files). Identity documents,
# BOOTSTRAP / onboarding, and the memory skeleton are Mirror's and never synced.
# Usage: packages/agent-templates/mirror-v-full/sync-from-v.sh [--dry-run]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$here/payload"
ws=/home/openclaw/makaron-openclaw/.openclaw-local/workspace
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1

skills=(auto-travel-vlog corporate-video-script creative-production-orchestrator html-executive-pitch-deck-iteration
  html-poster-design image-production-routing-qc image-search-apify-first long-term-memory-update makaron-video
  makaron-remotion-materialize memory-promotion-audit meshy-3d-agent openclaw-harness-evaluation proactive-agent
  skill-creation-coach skill-gate social-search-apify-first technical-project-research tiktok-publish-copy
  viral-absurd-demo-video viral-extreme-product-demo viral-impossible-test-video
  librarian-semantic-reconcile)
scripts=(librarian-adopt-untracked.py librarian-reachability.py librarian-relations.py librarian-daily-queue.py
  librarian-corrections.py librarian-move-check.py librarian-reconcile.py librarian-rule-sources.py
  memory-graph.py memory-graph.template.html write-reflection.py reflection-analyzer.py reflection-capture.py
  write-skill-candidate.py compress-memory.py wiki-maintenance.py heartbeat.py heartbeat-dispatch.py
  memory-auto-index.py skill-candidate-rollback.py
  tests/test_librarian_corrections.py tests/test_librarian_reconcile.py)
docs=(memory/SCHEMA.md)
paths=("${skills[@]/#/skills/}" "${scripts[@]/#/scripts/}" "${docs[@]}"
  skills/makaron/SKILL.md skills/makaron/COMPOSITE.json skills/makaron/parts/official)

base_rev="$(cat "$here/V_WORKSPACE_COMMIT")"
head_rev="$(ssh v "cd /tmp; sudo -n -u openclaw git -C $ws rev-parse HEAD")"
echo "V: $base_rev -> $head_rev"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/base" "$tmp/theirs"
# Paths missing at the base (new in V since) are simply absent there.
for rev in base theirs; do
  r=$([ $rev = base ] && echo "$base_rev" || echo "$head_rev")
  existing="$(ssh v "cd /tmp; sudo -n -u openclaw git -C $ws ls-tree -r --name-only $r -- ${paths[*]}")"
  [ -n "$existing" ] && ssh v "cd /tmp; sudo -n -u openclaw git -C $ws archive --format=tar $r -- $(echo $existing)" | tar -xf - -C "$tmp/$rev"
done

sanitise() {  # same rewriting the payload has always received
  find "$1" -type f \( -name '*.py' -o -name '*.md' -o -name '*.sh' -o -name '*.json' \) -print0 | xargs -0 sed -i '' \
    -e 's#/home/openclaw/makaron-openclaw/.openclaw-local/workspace#/vercel/sandbox/agent-data/workspace#g' \
    -e 's#/home/openclaw/.openclaw/logs/memory-auto-index.log#/vercel/sandbox/agent-data/state/logs/memory-auto-index.log#g' \
    -e 's#agent:makaron:#agent:mirror-v-full:#g' \
    -e "s/Tianyi's/the owner's/g" -e 's/Tianyi/the owner/g'
  [ -f "$1/scripts/heartbeat-dispatch.py" ] && sed -i '' 's#^DEFAULT_REPORT_CHAT_ID = ".*"#DEFAULT_REPORT_CHAT_ID = ""#' "$1/scripts/heartbeat-dispatch.py"
  return 0
}
sanitise "$tmp/base"; sanitise "$tmp/theirs"

added=(); updated=(); merged=(); conflicts=(); removed=()
while IFS= read -r -d '' f; do
  rel="${f#"$tmp/theirs/"}"; ours="$payload/$rel"; base="$tmp/base/$rel"
  if [ ! -e "$ours" ]; then added+=("$rel"); [ $dry = 0 ] && mkdir -p "$(dirname "$ours")" && cp "$f" "$ours"; continue; fi
  cmp -s "$f" "$ours" && continue                                   # already identical
  if [ -e "$base" ] && cmp -s "$base" "$ours"; then                  # Mirror never touched it
    updated+=("$rel"); [ $dry = 0 ] && cp "$f" "$ours"; continue
  fi
  if [ -e "$base" ] && cmp -s "$base" "$f"; then continue; fi       # only Mirror changed it
  b="$base"; [ -e "$b" ] || b=/dev/null
  out="$tmp/merge.out"; cp "$ours" "$out"
  if git merge-file -L mirror -L "v@${base_rev:0:8}" -L "v@${head_rev:0:8}" "$out" "$b" "$f"; then
    merged+=("$rel")
  else
    conflicts+=("$rel")
  fi
  [ $dry = 0 ] && cp "$out" "$ours"
done < <(find "$tmp/theirs" -type f -print0)
# Files V deleted that Mirror still ships unchanged from the base.
while IFS= read -r -d '' f; do
  rel="${f#"$tmp/base/"}"
  [ -e "$tmp/theirs/$rel" ] || { [ -e "$payload/$rel" ] && cmp -s "$f" "$payload/$rel" && removed+=("$rel") && [ $dry = 0 ] && rm "$payload/$rel"; } || true
done < <(find "$tmp/base" -type f -print0)
# The graph viewer's vendored library is not tracked in V's git.
[ $dry = 0 ] && ssh v "cd /tmp; sudo -n -u openclaw tar -cf - -C $ws artifacts/memory-graph/vendor/force-graph.min.js" | tar -xf - -C "$payload"

show() { local t=$1; shift; [ $# -gt 0 ] && { echo "$t ($#):"; printf '  %s\n' "$@"; }; return 0; }
show "added" "${added[@]+"${added[@]}"}"; show "updated (Mirror unchanged)" "${updated[@]+"${updated[@]}"}"
show "merged" "${merged[@]+"${merged[@]}"}"; show "removed" "${removed[@]+"${removed[@]}"}"
show "CONFLICTS" "${conflicts[@]+"${conflicts[@]}"}"
if [ $dry = 1 ]; then echo "(dry run, nothing written)"; exit 0; fi
# No V host paths, no V's Feishu groups in what we ship.
grep -rn -e '/home/openclaw' -e 'ou_[0-9a-f]\{20,\}' -e 'oc_[0-9a-f]\{20,\}' "$payload/scripts" "$payload/skills" | head -20 || true
if [ ${#conflicts[@]} -gt 0 ]; then echo "resolve the conflicts above, then record $head_rev in V_WORKSPACE_COMMIT"; exit 1; fi
echo "$head_rev" > "$here/V_WORKSPACE_COMMIT"
echo "synced from V workspace $head_rev — now run: node gen-manifest.mjs mirror-v-full.<next>"
