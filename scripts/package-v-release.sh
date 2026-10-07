#!/usr/bin/env bash
# Package one V release for a v-release template snapshot:
#   core/   platform repo release/captured/<tag>          (dist bytes over npm openclaw@<upstream>)
#   worker/ platform repo release/captured/<tag>.worker   (vlab-agent-worker-isolation plugin)
#   codex/  deploy/v-release/codex-<upstream>             (V's hand-applied @openclaw/codex changes)
#   v-memory-indexer.mjs  platform repo scripts/v-memory-indexer.mjs
# Usage: scripts/package-v-release.sh <platform-repo> <tag> <out.tgz>
set -euo pipefail
platform="$1"; tag="$2"; out="$3"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
captured="$platform/release/captured"
test -f "$captured/$tag/manifest.json" && test -f "$captured/$tag.worker/manifest.json"
upstream="$(node -e 'console.log(require(process.argv[1]).upstream)' "$captured/$tag/manifest.json")"
codex="$repo_root/deploy/v-release/codex-$upstream"
test -f "$codex/manifest.json"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp -R "$captured/$tag" "$tmp/core"
cp -R "$captured/$tag.worker" "$tmp/worker"
cp -R "$codex" "$tmp/codex"
cp "$platform/scripts/v-memory-indexer.mjs" "$tmp/v-memory-indexer.mjs"
# Test fixtures in the Worker capture are not needed at runtime.
find "$tmp/worker/dist" -name '*.test.mjs' -delete
node -e '
const m=require(process.argv[1]+"/worker/manifest.json"); const fs=require("fs");
m.files=m.files.filter(f=>fs.existsSync(process.argv[1]+"/worker/dist/"+f.path.replace(/^\.\//,"")));
fs.writeFileSync(process.argv[1]+"/worker/manifest.json",JSON.stringify(m,null,1));' "$tmp"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$tmp" .
echo "$out $(wc -c < "$out") bytes, release $tag (upstream $upstream)"
