#!/usr/bin/env bash
# Bring V's evolution into the Mirror V full payload — repeatably, without losing
# what Mirror changed on top. Runbook: docs/mirror-v-sync-from-v.md.
#
# V keeps evolving its Librarian / heartbeat / skills; Mirror adapts some of the
# same files (the onboarding import queue in librarian-daily-queue.py, lint
# without V's private scripts in wiki-maintenance.py, the owner's memory page in
# memory-graph.*, …). Overwriting would drop those adaptations, so every
# V-owned file is merged three ways:
#
#   base   = V at the commit recorded in V_WORKSPACE_COMMIT (what Mirror last took)
#   theirs = V at HEAD now
#   ours   = the file in this payload
#
# base and theirs go through the same sanitising (sandbox paths, agent id, no
# owner name) before the merge, so Mirror's earlier sanitising never shows up as
# a difference. A file Mirror never touched simply becomes V's new version; a new
# V file is added; a conflict leaves standard markers.
#
# Which V paths are synced is v-sync-paths.txt; what V changed but Mirror does
# not take is v-sync-skip.txt (with the reason). Every skills/<name> and
# scripts/<entry> V changed since the base must be in one of the two, otherwise
# the run stops with UNREVIEWED — nothing new is shipped or missed silently.
#
# Read-only on V (git HEAD only, never uncommitted files).
#
# Usage (from anywhere):
#   sync-from-v.sh --dry-run      what would change; writes nothing
#   sync-from-v.sh                merge into payload/. With conflicts it exits 1 and
#                                 leaves .v-sync-pending; fix the markers, then:
#   sync-from-v.sh --resolved     check no markers are left, record V's commit
#   --base <rev>                  override the recorded base (only to repair a wrong record)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload="$here/payload"
pending="$here/.v-sync-pending"
ws=/home/openclaw/makaron-openclaw/.openclaw-local/workspace
dry=0; resolved=0; base_rev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --resolved) resolved=1 ;;
    --base) base_rev="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

mapfile_compat() { grep -v '^[[:space:]]*\(#\|$\)' "$1" | awk '{print $1}'; }
paths=($(mapfile_compat "$here/v-sync-paths.txt"))

markers() {  # conflict markers left in synced paths
  local p hits=0
  for p in "${paths[@]}"; do
    [ -e "$payload/$p" ] || continue
    grep -rIln -e '^<<<<<<< mirror' -e '^>>>>>>> v@' "$payload/$p" && hits=1
  done
  return $((1 - hits))
}

if [ $resolved = 1 ]; then
  [ -f "$pending" ] || { echo "nothing pending (no .v-sync-pending)"; exit 2; }
  if markers; then echo "conflict markers still present (above)"; exit 1; fi
  head_rev="$(sed -n 1p "$pending")"
  echo "$head_rev" > "$here/V_WORKSPACE_COMMIT"; rm "$pending"
  echo "recorded V workspace $head_rev — now run: node gen-manifest.mjs mirror-v-full.<next>"
  exit 0
fi
[ -f "$pending" ] && [ $dry = 0 ] && { echo ".v-sync-pending exists: finish the last sync (--resolved) or delete it first"; exit 2; }

tmp="$(mktemp -d)"; trap 'ssh -O exit -o ControlPath="$tmp/cm" v 2>/dev/null || true; rm -rf "$tmp"' EXIT
rv() { ssh -o ControlMaster=auto -o ControlPath="$tmp/cm" -o ControlPersist=120 v "cd /tmp; $*"; }
git_v="sudo -n -u openclaw git -C $ws"

[ -n "$base_rev" ] || base_rev="$(cat "$here/V_WORKSPACE_COMMIT")"
head_rev="$(rv "$git_v rev-parse HEAD")"
base_rev="$(rv "$git_v rev-parse --verify $base_rev^{commit}")"
echo "V: $base_rev -> $head_rev ($(rv "$git_v rev-list --count $base_rev..$head_rev") commits)"

# Review gate: everything V changed under skills/ and scripts/ is either synced or skipped with a reason.
skip_globs=($(mapfile_compat "$here/v-sync-skip.txt"))
skipped() {  # $1 matches a v-sync-skip.txt glob (an entry, or a single file inside a synced directory)
  local g
  for g in "${skip_globs[@]}"; do [[ "$1" == $g ]] && return 0; done
  return 1
}
covered() {  # $1 = skills/<name> or scripts/<entry>
  local p
  for p in "${paths[@]}"; do
    [ "$p" = "$1" ] || [[ "$p" == "$1/"* ]] || [[ "$1" == "$p/"* ]] && return 0
  done
  skipped "$1"
}
unreviewed=()
while IFS= read -r e; do
  covered "$e" || unreviewed+=("$e")
done < <(rv "$git_v -c core.quotepath=off diff --name-only $base_rev $head_rev -- skills scripts" | awk -F/ '{print $1"/"$2}' | sort -u)

mkdir -p "$tmp/base" "$tmp/theirs"
for rev in base theirs; do
  r=$([ $rev = base ] && echo "$base_rev" || echo "$head_rev")
  existing="$(rv "$git_v ls-tree -r --name-only $r -- ${paths[*]}")"
  [ -n "$existing" ] && rv "$git_v archive --format=tar $r -- $(echo $existing)" | tar -xf - -C "$tmp/$rev"
done

sanitise() {  # same rewriting the payload has always received
  find "$1" -type f \( -name '*.py' -o -name '*.md' -o -name '*.sh' -o -name '*.json' -o -name '*.html' \) -print0 | xargs -0 sed -i '' \
    -e 's#/home/openclaw/makaron-openclaw/.openclaw-local/workspace#/vercel/sandbox/agent-data/workspace#g' \
    -e 's#/home/openclaw/.openclaw/logs/memory-auto-index.log#/vercel/sandbox/agent-data/state/logs/memory-auto-index.log#g' \
    -e 's#agent:makaron:#agent:mirror-v-full:#g' \
    -e "s/Tianyi's/the owner's/g" -e 's/Tianyi/the owner/g' \
    -e 's|https://versa-ai\.feishu\.cn/[a-z]*/[A-Za-z0-9_#-]*|（V 内部飞书文档，未随附）|g' \
    -e 's/ou_15273b08310b914c5f97b27af680c149/ou_SENDER_V/g'
  [ -f "$1/scripts/heartbeat-dispatch.py" ] && sed -i '' 's#^DEFAULT_REPORT_CHAT_ID = ".*"#DEFAULT_REPORT_CHAT_ID = ""#' "$1/scripts/heartbeat-dispatch.py"
  return 0
}
sanitise "$tmp/base"; sanitise "$tmp/theirs"

added=(); updated=(); merged=(); conflicts=(); removed=(); excluded=()
while IFS= read -r -d '' f; do
  rel="${f#"$tmp/theirs/"}"; ours="$payload/$rel"; base="$tmp/base/$rel"
  skipped "$rel" && { excluded+=("$rel"); continue; }
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
[ $dry = 0 ] && rv "sudo -n -u openclaw tar -cf - -C $ws artifacts/memory-graph/vendor/force-graph.min.js" | tar -xf - -C "$payload"

show() { local t=$1; shift; [ $# -gt 0 ] && { echo "$t ($#):"; printf '  %s\n' "$@"; }; return 0; }
show "added" "${added[@]+"${added[@]}"}"; show "updated (Mirror unchanged)" "${updated[@]+"${updated[@]}"}"
show "merged" "${merged[@]+"${merged[@]}"}"; show "removed" "${removed[@]+"${removed[@]}"}"
show "not taken (v-sync-skip.txt)" "${excluded[@]+"${excluded[@]}"}"
show "CONFLICTS" "${conflicts[@]+"${conflicts[@]}"}"
show "UNREVIEWED (add to v-sync-paths.txt or v-sync-skip.txt with a reason)" "${unreviewed[@]+"${unreviewed[@]}"}"
if [ $dry = 1 ]; then echo "(dry run, nothing written)"; exit 0; fi
[ ${#unreviewed[@]} -gt 0 ] && echo "note: the payload was merged, but review the entries above before releasing"
# No V host paths, V's Feishu ids, owner identity or V's public endpoints in what we ship.
leaks="$(for p in "${paths[@]}"; do [ -e "$payload/$p" ] && grep -rIn -e '/home/openclaw' -e 'ou_[0-9a-f]\{20,\}' -e 'oc_[0-9a-f]\{20,\}' \
  -e 'Tianyi' -e 'tianyi\.live' -e 'vegekyd' -e 'agentmail\.to' -e 'versa-ai\.' -e 'feishu\.cn/\(docx\|wiki\|base\|sheets\)/' "$payload/$p"; done || true)"
[ -n "$leaks" ] && { echo "PRIVATE CONTENT in synced paths (sanitise or drop before release):"; echo "$leaks" | head -30; }
if [ ${#conflicts[@]} -gt 0 ]; then
  printf '%s\n%s\n' "$head_rev" "$base_rev" > "$pending"
  echo "resolve the conflicts above, then run: $0 --resolved"; exit 1
fi
echo "$head_rev" > "$here/V_WORKSPACE_COMMIT"
echo "synced from V workspace $head_rev — now run: node gen-manifest.mjs mirror-v-full.<next>"
