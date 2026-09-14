// Full agent state + workspace differences against the immutable DealClaw base.
// Keep deletions explicit so restoring cannot resurrect user-deleted payload files.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = process.env.NEXUS_BACKUP_ROOT || "/vercel/sandbox",
  data = root + "/agent-data",
  workspace = data + "/workspace",
  base = root + "/nexus/payload";
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
const files = [];
for (const item of entries(data)) {
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
  JSON.stringify({ version: 2, basePayload: "dealclaw-2026-09-14", removed }),
);
if (!files.includes(manifest)) files.push(manifest);
const list = root + "/nexus-backup-files",
  archive = process.env.NEXUS_BACKUP_ARCHIVE || "/tmp/nexus-state.tgz";
fs.writeFileSync(list, files.join("\0") + "\0");
execFileSync("tar", [
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
