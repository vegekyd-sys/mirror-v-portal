// Full agent state + workspace differences against the immutable DealClaw base.
// Keep deletions explicit so restoring cannot resurrect user-deleted payload files.
import fs from "node:fs";
import path from "node:path";
import { readAgentKitProfile, payloadWorkspace } from "./agent-config.mjs";
import { execFileSync } from "node:child_process";
import { readVRelease, isVReleaseBackupExcluded } from "./v-release.mjs";
const root = process.env.NEXUS_BACKUP_ROOT || "/vercel/sandbox",
  data = root + "/agent-data",
  workspace = data + "/workspace";
const profile = readAgentKitProfile(root + "/nexus/agent-kit-runtime.json", process.env.NEXUS_AGENT_ID || "dealclaw");
const base = profile ? payloadWorkspace(root + "/nexus/payload", profile.runtime) : root + "/nexus/payload";
function entries(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = path.posix.join(prefix, name),
      file = path.join(dir, name),
      st = fs.lstatSync(file);
    out.push({ rel, file, st });
    if (st.isDirectory()) out.push(...entries(file, rel));
  }
  return out;
}
const vRelease = readVRelease(root + "/nexus/v-release.json");
const files = [];
for (const item of entries(data)) {
  // Plugin installs come back with the snapshot; Codex logs and caches are disposable.
  if (vRelease && isVReleaseBackupExcluded(item.rel)) continue;
  if (item.rel === "workspace" || item.rel.startsWith("workspace/")) {
    const rel = item.rel.slice("workspace/".length),
      original = path.join(base, rel);
    if (
      item.st.isFile() &&
      fs.existsSync(original) &&
      fs.lstatSync(original).isFile() &&
      item.st.size === fs.statSync(original).size &&
      fs.readFileSync(item.file).equals(fs.readFileSync(original))
    )
      continue;
  }
  files.push("agent-data/" + item.rel);
}
function existsEntry(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
const removed = entries(base)
  .filter((x) => !existsEntry(path.join(workspace, x.rel)))
  .map((x) => x.rel);
const manifest = "agent-data/.nexus-backup.json";
fs.writeFileSync(
  root + "/" + manifest,
  JSON.stringify({ version: 2, basePayload: profile?.version || "dealclaw-2026-09-14", ...(profile ? { agentId: profile.templateId, payloadLayout: profile.runtime.payloadLayout, archiveSha256: profile.archiveSha256 } : {}), removed }),
);
if (!files.includes(manifest)) files.push(manifest);
const list = root + "/nexus-backup-files",
  archive = process.env.NEXUS_BACKUP_ARCHIVE || "/tmp/nexus-state.tgz";
fs.writeFileSync(list, files.join("\0") + "\0");
// GNU tar exits 1 when a file changed while it was read (a Worker or the indexer
// writing SQLite). That copy is still usable; the idle snapshot is the
// consistent one. Any other failure stays fatal.
const tar = (args) => {
  try { execFileSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (error) {
    if (!(vRelease && error.status === 1 && /file changed as we read it|changed as we read/.test(String(error.stderr)))) throw error;
  }
};
tar([
  "-czf",
  archive,
  "--no-recursion",
  "-C",
  root,
  "--null",
  "-T",
  list,
]);
console.log(
  JSON.stringify({
    bytes: fs.statSync(archive).size,
    files: files.length,
    removed: removed.length,
  }),
);
