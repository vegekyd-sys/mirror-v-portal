#!/usr/bin/env bash
# Package one V release for a v-release template snapshot. Everything is read from git refs of
# the platform repo (git archive), so the checkout's branch and working tree do not matter:
#   core/    release/captured/<tag>          on CAPTURED_REF (dist bytes over npm openclaw@<upstream>)
#   worker/  release/captured/<tag>.worker   on CAPTURED_REF (vlab-agent-worker-isolation plugin)
#   codex/   release/captured/<tag>.codex    on CAPTURED_REF: V's whole running @openclaw/codex,
#            reduced to an overlay over npm @openclaw/codex@<upstream> (deploy/v-release/codex-delta.mjs)
#            minus V-host-only glue, replaced by deploy/v-release/core-mirror.mjs (hash-bound)
#   ai/      deploy/v-release/ai-<tag>: V's patched files in core/node_modules/@openclaw/ai, which the
#            platform captures leave out (e.g. the DSML tool-call fix); bytes kept in files/
#   v-memory-indexer.mjs  scripts/v-memory-indexer.mjs at PLATFORM_REF (V runs the dev version)
#   desktop/  apps/v-desktop-handoff at DESKTOP_COMMIT (virtual desktop, takeover page, plugin)
#   vbrowser/ vegekyd-sys/v-browser at VBROWSER_COMMIT (broker, extension zip, plugin in single-owner mode)
#   voice/    lab/ voice entry at VOICE_COMMIT, made owner-neutral (voice-mirror.mjs)
#   features.json  where each part came from
# V's .feishu / .session-relay / channel captures are not packaged: the Portal owns the channels.
# Usage: VBROWSER_REPO=<v-browser checkout> scripts/package-v-release.sh <platform-repo> <tag> <out.tgz>
set -euo pipefail
platform="$1"; tag="$2"; out="$3"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
captured_ref="${CAPTURED_REF:-origin/captured-store}"
platform_ref="${PLATFORM_REF:-origin/dev}"
desktop_commit="${DESKTOP_COMMIT:-b0fd6a15a6bd532e6a6b4c2c2f46e357260a0d13}"
voice_commit="${VOICE_COMMIT:-dd5e4cdb389148e39ca81c9130a61f77287fa557}"
vbrowser_repo="${VBROWSER_REPO:?VBROWSER_REPO is required}"
vbrowser_commit="${VBROWSER_COMMIT:-3cc8ca277e6c80205f34f99b512a78565772f006}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" "$tmp/pkg"
# Byte captures: manifest + dist live together on the captured-store branch.
git -C "$platform" archive "$captured_ref" "release/captured/$tag" "release/captured/$tag.worker" "release/captured/$tag.codex" | tar -xf - -C "$tmp/src"
cap="$tmp/src/release/captured"
upstream="$(node -e 'console.log(require(process.argv[1]).upstream)' "$cap/$tag/manifest.json")"
# The release on dev must list the same files as the bytes on captured-store.
for part in "" .worker .codex; do
  cmp -s "$cap/$tag$part/manifest.json" <(git -C "$platform" show "$platform_ref:release/captured/$tag$part/manifest.json") \
    || { echo "MANIFEST_DIFFERS_FROM_${platform_ref}: $tag$part" >&2; exit 1; }
done
node -e '
const fs=require("fs"),c=require("crypto"),[root]=process.argv.slice(1);
for (const part of fs.readdirSync(root)) { const m=JSON.parse(fs.readFileSync(`${root}/${part}/manifest.json`,"utf8"));
  for (const f of m.files) { const h=c.createHash("sha256").update(fs.readFileSync(`${root}/${part}/dist/${f.path.replace(/^\.\//,"")}`)).digest("hex");
    if (h!==f.sha256) { console.error(`CAPTURE_BYTES_MISMATCH ${part} ${f.path}`); process.exit(1); } } }' "$cap"
mv "$cap/$tag" "$tmp/pkg/core"
# V-host-only glue inside the core capture, replaced for Mirror (hash-bound; see the script).
core_mirrored="$(node "$repo_root/deploy/v-release/core-mirror.mjs" "$tmp/pkg/core")"
mv "$cap/$tag.worker" "$tmp/pkg/worker"
(cd "$tmp/src" && npm pack --silent "@openclaw/codex@$upstream" >/dev/null && mkdir npm-codex && tar -xzf openclaw-codex-*.tgz -C npm-codex)
mkdir -p "$tmp/pkg/codex"
node "$repo_root/deploy/v-release/codex-delta.mjs" "$cap/$tag.codex" "$tmp/src/npm-codex/package" "$tmp/pkg/codex" >/dev/null
ai="$repo_root/deploy/v-release/ai-$tag"
if [ -f "$ai/manifest.json" ]; then
  mkdir -p "$tmp/pkg/ai" && cp "$ai/manifest.json" "$tmp/pkg/ai/" && cp -R "$ai/files" "$tmp/pkg/ai/dist"
elif [ "$tag" != "v2026.9.1-db91.6-firsttext-r4-20261007" ]; then
  echo "AI_OVERLAY_MISSING: deploy/v-release/ai-$tag (copy V's core/node_modules/@openclaw/ai files that differ from npm)" >&2; exit 1
fi
git -C "$platform" show "$platform_ref:scripts/v-memory-indexer.mjs" > "$tmp/pkg/v-memory-indexer.mjs"
indexer_commit="$(git -C "$platform" rev-parse "$platform_ref")"
# Virtual desktop + takeover page + desktop_handoff plugin (no tests).
mkdir -p "$tmp/pkg/desktop"
git -C "$platform" archive "$desktop_commit" apps/v-desktop-handoff/desktop apps/v-desktop-handoff/service apps/v-desktop-handoff/plugin | tar -xf - -C "$tmp/src"
mv "$tmp/src/apps/v-desktop-handoff/desktop" "$tmp/src/apps/v-desktop-handoff/service" "$tmp/src/apps/v-desktop-handoff/plugin" "$tmp/pkg/desktop/"
rm -rf "$tmp/pkg/desktop/service/tests" "$tmp/pkg/desktop/plugin/tests"
node "$repo_root/deploy/v-release/desktop-mirror.mjs" "$tmp/pkg/desktop/plugin" >/dev/null
# V Browser from a pinned v-browser commit, plugin switched to single-owner mode.
mkdir -p "$tmp/pkg/vbrowser"
git -C "$vbrowser_repo" archive "$vbrowser_commit" broker assets openclaw-plugin skill extension scripts/package-extension.sh package.json | tar -xf - -C "$tmp/pkg/vbrowser"
rm -rf "$tmp/pkg/vbrowser/broker/tests" "$tmp/pkg/vbrowser/openclaw-plugin/tests" "$tmp/pkg/vbrowser/extension/tests"
(cd "$tmp/pkg/vbrowser" && bash scripts/package-extension.sh >/dev/null)
rm -rf "$tmp/pkg/vbrowser/extension" "$tmp/pkg/vbrowser/scripts"
node "$repo_root/deploy/v-release/v-browser-mirror.mjs" "$tmp/pkg/vbrowser/openclaw-plugin" >/dev/null
# Voice entry (Grok Voice / Doubao) from V's released voice commit.
mkdir -p "$tmp/pkg/voice"
git -C "$platform" archive "$voice_commit" lab/gpt-live-h5 lab/realtime-direct-tools lab/seeduplex-realtime-provider.mjs lab/gpt-live-consult-progress.mjs lab/gpt-live-candidate-native/private-pulse.mjs lab/rtc-h5/assets | tar -xf - -C "$tmp/pkg/voice"
find "$tmp/pkg/voice" -name '*.test.mjs' -delete
node "$repo_root/deploy/v-release/voice-mirror.mjs" "$tmp/pkg/voice" >/dev/null
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({
  release:{repo:"vegekyd-sys/v-openclaw-platform",tag:process.argv[2],captured:process.argv[3],parts:["core","worker","codex"],ai:process.argv[8]||null,coreMirror:JSON.parse(process.argv[9]).mirrored},
  indexer:{repo:"vegekyd-sys/v-openclaw-platform",commit:process.argv[4],path:"scripts/v-memory-indexer.mjs"},
  desktop:{repo:"vegekyd-sys/v-openclaw-platform",commit:process.argv[5],path:"apps/v-desktop-handoff"},
  vbrowser:{repo:"vegekyd-sys/v-browser",commit:process.argv[6],plugin:"single-owner"},
  voice:{repo:"vegekyd-sys/v-openclaw-platform",commit:process.argv[7],patch:"voice-mirror.mjs"}},null,1))' \
  "$tmp/pkg/features.json" "$tag" "$(git -C "$platform" rev-parse "$captured_ref")" "$indexer_commit" "$desktop_commit" "$vbrowser_commit" "$voice_commit" "$([ -d "$tmp/pkg/ai" ] && echo "deploy/v-release/ai-$tag")" "$core_mirrored"
# Test fixtures in the Worker capture are not needed at runtime.
find "$tmp/pkg/worker/dist" -name '*.test.mjs' -delete
node -e '
const m=require(process.argv[1]+"/worker/manifest.json"); const fs=require("fs");
m.files=m.files.filter(f=>fs.existsSync(process.argv[1]+"/worker/dist/"+f.path.replace(/^\.\//,"")));
fs.writeFileSync(process.argv[1]+"/worker/manifest.json",JSON.stringify(m,null,1));' "$tmp/pkg"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$tmp/pkg" .
echo "$out $(wc -c < "$out") bytes, release $tag (upstream $upstream)"
