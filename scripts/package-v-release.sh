#!/usr/bin/env bash
# Package one V release for a v-release template snapshot:
#   core/   platform repo release/captured/<tag>          (dist bytes over npm openclaw@<upstream>)
#   worker/ platform repo release/captured/<tag>.worker   (vlab-agent-worker-isolation plugin)
#   codex/  deploy/v-release/codex-<upstream>             (V's hand-applied @openclaw/codex changes)
#   v-memory-indexer.mjs  platform repo scripts/v-memory-indexer.mjs
#   desktop/  platform repo apps/v-desktop-handoff        (virtual desktop, takeover page, plugin)
#   vbrowser/ vegekyd-sys/v-browser at VBROWSER_COMMIT    (broker, extension zip, plugin in single-owner mode)
#   voice/    platform repo lab/ voice entry at VOICE_COMMIT, made owner-neutral (voice-mirror.mjs)
#   features.json  where each part came from
# Usage: VBROWSER_REPO=<v-browser checkout> scripts/package-v-release.sh <platform-repo> <tag> <out.tgz>
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
# Virtual desktop + takeover page + desktop_handoff plugin (no tests).
mkdir -p "$tmp/desktop"
cp -R "$platform/apps/v-desktop-handoff/desktop" "$platform/apps/v-desktop-handoff/service" "$platform/apps/v-desktop-handoff/plugin" "$tmp/desktop/"
rm -rf "$tmp/desktop/service/tests" "$tmp/desktop/plugin/tests"
desktop_commit="$(git -C "$platform" rev-parse HEAD)"
# V Browser from a pinned v-browser commit, plugin switched to single-owner mode.
vbrowser_repo="${VBROWSER_REPO:?VBROWSER_REPO is required}"
vbrowser_commit="${VBROWSER_COMMIT:-$(git -C "$vbrowser_repo" rev-parse HEAD)}"
mkdir -p "$tmp/vbrowser"
git -C "$vbrowser_repo" archive "$vbrowser_commit" broker assets openclaw-plugin skill extension scripts/package-extension.sh package.json | tar -xf - -C "$tmp/vbrowser"
rm -rf "$tmp/vbrowser/broker/tests" "$tmp/vbrowser/openclaw-plugin/tests" "$tmp/vbrowser/extension/tests"
(cd "$tmp/vbrowser" && bash scripts/package-extension.sh >/dev/null)
rm -rf "$tmp/vbrowser/extension" "$tmp/vbrowser/scripts"
node "$repo_root/deploy/v-release/v-browser-mirror.mjs" "$tmp/vbrowser/openclaw-plugin" >/dev/null
# Voice entry (Grok Voice / Doubao) from V's released voice commit.
voice_commit="${VOICE_COMMIT:-dd5e4cdb389148e39ca81c9130a61f77287fa557}"
mkdir -p "$tmp/voice"
git -C "$platform" archive "$voice_commit" lab/gpt-live-h5 lab/realtime-direct-tools lab/seeduplex-realtime-provider.mjs lab/gpt-live-consult-progress.mjs lab/gpt-live-candidate-native/private-pulse.mjs lab/rtc-h5/assets | tar -xf - -C "$tmp/voice"
find "$tmp/voice" -name '*.test.mjs' -delete
node "$repo_root/deploy/v-release/voice-mirror.mjs" "$tmp/voice" >/dev/null
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({desktop:{repo:"vegekyd-sys/v-openclaw-platform",commit:process.argv[2],path:"apps/v-desktop-handoff"},vbrowser:{repo:"vegekyd-sys/v-browser",commit:process.argv[3],plugin:"single-owner"},voice:{repo:"vegekyd-sys/v-openclaw-platform",commit:process.argv[4],patch:"voice-mirror.mjs"}},null,1))' "$tmp/features.json" "$desktop_commit" "$vbrowser_commit" "$voice_commit"
# Test fixtures in the Worker capture are not needed at runtime.
find "$tmp/worker/dist" -name '*.test.mjs' -delete
node -e '
const m=require(process.argv[1]+"/worker/manifest.json"); const fs=require("fs");
m.files=m.files.filter(f=>fs.existsSync(process.argv[1]+"/worker/dist/"+f.path.replace(/^\.\//,"")));
fs.writeFileSync(process.argv[1]+"/worker/manifest.json",JSON.stringify(m,null,1));' "$tmp"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$tmp" .
echo "$out $(wc -c < "$out") bytes, release $tag (upstream $upstream)"
