#!/usr/bin/env node
// Mirror adaptations of V's core capture, applied to the packaged core/ (dist + manifest).
//
// v-feishu-voice-runtime.mjs: V's Gateway authorizes voice calls started from a Feishu phone tab
// against its own installed Feishu plugin, imported by a path into V's npm project directory
// (../../npm/projects/openclaw-feishu-<hash>/...). Mirror's Gateway has no Feishu channel (the
// Portal owns it), that path does not exist, and the static import stops the Gateway from
// starting. The replacement keeps the same middleware: a request without a voiceActor passes
// through unchanged; one with a voiceActor is rejected, because no Feishu account resolves.
//
// Each replacement is bound to V's exact bytes: a different capture fails until reviewed.
// Usage: core-mirror.mjs <core dir>
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export const CORE_REPLACEMENTS = Object.freeze({
  "v-feishu-voice-runtime.mjs": {
    v: "4be65ba00e2cacf356cff59fefc616ed018c74902491861fc9f54dcf808594ff",
    mirror: `// Mirror V (deploy/v-release/core-mirror.mjs): the Gateway has no Feishu channel, so no Feishu
// voice actor can be authorized. Requests without a voiceActor pass through unchanged, as on V.
import {createVoiceActorMiddleware} from "./v-feishu-voice-actor.mjs";
export const prepareVoiceActor=createVoiceActorMiddleware({resolveAccount:async()=>null,resolvePolicy:async()=>({admitted:false})});
`,
  },
});

export function adaptCore(coreDir) {
  const manifestFile = path.join(coreDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const applied = [];
  for (const [rel, { v, mirror }] of Object.entries(CORE_REPLACEMENTS)) {
    const entry = manifest.files.find((f) => f.path === `./${rel}`);
    if (!entry) continue;
    const file = path.join(coreDir, "dist", rel);
    const have = sha256(fs.readFileSync(file));
    const want = sha256(Buffer.from(mirror));
    if (have === want && entry.sha256 === want) { applied.push(rel); continue; }
    if (have !== v || entry.sha256 !== v) throw Error(`CORE_MIRROR_UNREVIEWED_BYTES:${rel}:${have.slice(0, 12)}`);
    fs.writeFileSync(file, mirror);
    entry.vSha256 = v;
    entry.sha256 = want;
    entry.mirror = "deploy/v-release/core-mirror.mjs";
    applied.push(rel);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [coreDir] = process.argv.slice(2);
  if (!coreDir) throw Error("usage: core-mirror.mjs <core dir>");
  console.log(JSON.stringify({ mirrored: adaptCore(coreDir) }));
}
