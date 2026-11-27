#!/usr/bin/env bash
# Package one V release for a v-release template snapshot, from the installable V package
# (v-distro, vegekyd-sys/v-openclaw-platform distro/CONTRACT.md) plus Mirror's own parts:
#   core/    v-distro runtime/core  (overlay over npm openclaw@<upstream>; V-host-only glue then
#            replaced by deploy/v-release/core-mirror.mjs, hash-bound)
#   worker/  v-distro runtime/worker (vlab-agent-worker-isolation plugin)
#   codex/   v-distro runtime/codex: V's whole running @openclaw/codex, reduced to an overlay over
#            npm @openclaw/codex@<upstream> (deploy/v-release/codex-delta.mjs)
#   ai/      V's patched files in core/node_modules/@openclaw/ai: v-distro runtime/core-ai when the
#            package has it, else deploy/v-release/ai-<release> (bytes in files/)
#   v-memory-indexer.mjs  v-distro runtime/ops (same bytes as V)
#   tools.json            v-distro runtime/tools.json (build-snapshot refuses other CLI versions)
#   desktop/  apps/v-desktop-handoff at DESKTOP_COMMIT (virtual desktop, takeover page, plugin)
#   vbrowser/ vegekyd-sys/v-browser at VBROWSER_COMMIT (broker, extension zip, plugin in single-owner mode)
#   voice/    lab/ voice entry at VOICE_COMMIT, made owner-neutral (voice-mirror.mjs)
#   features.json  where each part came from
# Not used from v-distro: feishu / session-relay (the Portal owns the channels), install/, config/
# (the sandbox's openclaw.json is runtime/v-config.mjs, kept in step by v-config-distro.test.ts),
# workspace/ (the payload comes from packages/agent-templates/mirror-v-full).
# Usage: VBROWSER_REPO=<v-browser checkout> scripts/package-v-release.sh <platform-repo> <v-distro.tgz> <out.tgz>
set -euo pipefail
platform="$1"; distro_tgz="$2"; out="$3"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_commit="${DESKTOP_COMMIT:-b0fd6a15a6bd532e6a6b4c2c2f46e357260a0d13}"
voice_commit="${VOICE_COMMIT:-dd5e4cdb389148e39ca81c9130a61f77287fa557}"
vbrowser_repo="${VBROWSER_REPO:?VBROWSER_REPO is required}"
vbrowser_commit="${VBROWSER_COMMIT:-3cc8ca277e6c80205f34f99b512a78565772f006}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src" "$tmp/pkg"
tar -xzf "$distro_tgz" -C "$tmp/src"
d="$(echo "$tmp"/src/v-distro-*)"
[ -f "$d/manifest.json" ] || { echo "NOT_A_V_DISTRO: $distro_tgz" >&2; exit 1; }
# Every file the package lists must be there with its bytes; release parts must be V's captures.
node -e '
const fs=require("fs"),c=require("crypto"),path=require("path"),[d]=process.argv.slice(1);
const m=JSON.parse(fs.readFileSync(path.join(d,"manifest.json"),"utf8"));
if(m.schema!=="v-distro/1")throw Error(`V_DISTRO_SCHEMA:${m.schema}`);
for(const f of m.files){const p=path.join(d,f.path);const h=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");if(h!==f.sha256)throw Error(`V_DISTRO_BYTES_MISMATCH:${f.path}`);}
for(const part of ["core","worker","codex",...(fs.existsSync(path.join(d,"runtime","core-ai"))?["core-ai"]:[])]){const cm=JSON.parse(fs.readFileSync(path.join(d,"runtime",part,"manifest.json"),"utf8"));
  for(const f of cm.files){const p=path.join(d,"runtime",part,"dist",f.path.replace(/^\.\//,""));const h=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");if(h!==f.sha256)throw Error(`CAPTURE_BYTES_MISMATCH:${part}:${f.path}`);}}
' "$d"
# The sandbox's openclaw.json is checked against the package's generator by v-config-distro.test.ts.
cmp -s "$d/config/openclaw-config.mjs" "$repo_root/deploy/v-release/v-distro-config.mjs" \
  || { echo "V_DISTRO_CONFIG_CHANGED: copy config/openclaw-config.mjs to deploy/v-release/v-distro-config.mjs and update v-config-distro.test.ts" >&2; exit 1; }
release="$(node -p 'require(process.argv[1]).release' "$d/manifest.json")"
upstream="$(node -p 'require(process.argv[1]).upstream.openclaw' "$d/manifest.json")"
cp -R "$d/runtime/core" "$tmp/pkg/core"
cp -R "$d/runtime/worker" "$tmp/pkg/worker"
# V-host-only glue inside the core capture, replaced for Mirror (hash-bound; see the script).
core_mirrored="$(node "$repo_root/deploy/v-release/core-mirror.mjs" "$tmp/pkg/core")"
(cd "$tmp/src" && npm pack --silent "@openclaw/codex@$upstream" >/dev/null && mkdir npm-codex && tar -xzf openclaw-codex-*.tgz -C npm-codex)
mkdir -p "$tmp/pkg/codex"
node "$repo_root/deploy/v-release/codex-delta.mjs" "$d/runtime/codex" "$tmp/src/npm-codex/package" "$tmp/pkg/codex" >/dev/null
ai_source=""
if [ -f "$d/runtime/core-ai/manifest.json" ]; then
  cp -R "$d/runtime/core-ai" "$tmp/pkg/ai"; ai_source="v-distro runtime/core-ai"
elif [ -f "$repo_root/deploy/v-release/ai-$release/manifest.json" ]; then
  mkdir -p "$tmp/pkg/ai" && cp "$repo_root/deploy/v-release/ai-$release/manifest.json" "$tmp/pkg/ai/" && cp -R "$repo_root/deploy/v-release/ai-$release/files" "$tmp/pkg/ai/dist"
  ai_source="deploy/v-release/ai-$release"
else
  echo "AI_OVERLAY_MISSING: neither v-distro runtime/ai nor deploy/v-release/ai-$release" >&2; exit 1
fi
cp "$d/runtime/ops/v-memory-indexer.mjs" "$tmp/pkg/v-memory-indexer.mjs"
cp "$d/runtime/tools.json" "$tmp/pkg/tools.json"
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
node -e '
const fs=require("fs"),c=require("crypto"),[out,d,tgz,desktop,vbrowser,voice,ai,mirrored]=process.argv.slice(1);
const m=JSON.parse(fs.readFileSync(d+"/manifest.json","utf8"));
let info={}; try { info=JSON.parse(fs.readFileSync(tgz+".json","utf8")); } catch {}
fs.writeFileSync(out,JSON.stringify({
  release:{repo:m.source.repo,tag:m.release,parts:["core","worker","codex"],ai,coreMirror:JSON.parse(mirrored).mirrored},
  distro:{version:m.version,commit:m.source.commit,capturedStore:m.source.capturedStore,tarSha256:info.tarSha256??null,tgzSha256:c.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex")},
  indexer:{from:"v-distro runtime/ops/v-memory-indexer.mjs"},
  desktop:{repo:"vegekyd-sys/v-openclaw-platform",commit:desktop,path:"apps/v-desktop-handoff"},
  vbrowser:{repo:"vegekyd-sys/v-browser",commit:vbrowser,plugin:"single-owner"},
  voice:{repo:"vegekyd-sys/v-openclaw-platform",commit:voice,patch:"voice-mirror.mjs"}},null,1))' \
  "$tmp/pkg/features.json" "$d" "$distro_tgz" "$desktop_commit" "$vbrowser_commit" "$voice_commit" "$ai_source" "$core_mirrored"
# Test fixtures in the Worker capture are not needed at runtime.
find "$tmp/pkg/worker/dist" -name '*.test.mjs' -delete
node -e '
const m=require(process.argv[1]+"/worker/manifest.json"); const fs=require("fs");
m.files=m.files.filter(f=>fs.existsSync(process.argv[1]+"/worker/dist/"+f.path.replace(/^\.\//,"")));
fs.writeFileSync(process.argv[1]+"/worker/manifest.json",JSON.stringify(m,null,1));' "$tmp/pkg"
COPYFILE_DISABLE=1 tar -czf "$out" -C "$tmp/pkg" .
echo "$out $(wc -c < "$out") bytes, release $release (upstream $upstream) from v-distro $(node -p 'require(process.argv[1]).version' "$d/manifest.json")"
