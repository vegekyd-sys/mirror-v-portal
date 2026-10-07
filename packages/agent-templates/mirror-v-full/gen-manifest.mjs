// Regenerate payload/payload-manifest.json for the Mirror V full template:
// every file under payload/ (the builder ships exactly this list) plus the
// background loops registered for each tenant. Run after editing the payload
// or after sync-from-v.sh. Usage: node gen-manifest.mjs <version>
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const payload = path.join(here, "payload");
const version = process.argv[2];
if (!/^mirror-v-full\.[a-z0-9.-]+$/.test(version ?? "")) throw Error("usage: node gen-manifest.mjs mirror-v-full.<version>");
const files = [];
const walk = (dir, prefix = "") => {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(path.join(dir, name));
    if (stat.isSymbolicLink()) throw Error(`symlink not allowed in payload: ${rel}`);
    if (stat.isDirectory()) walk(path.join(dir, name), rel);
    else if (rel !== "payload-manifest.json") files.push(rel);
  }
};
walk(payload);
const systemSchedules = JSON.parse(fs.readFileSync(path.join(here, "system-schedules.json"), "utf8"));
const manifest = {
  name: "mirror-v-full",
  version,
  description: "全功能的 V：V 的运行时、Worker 池、记忆系统和自我进化循环，不带 V 的记忆",
  vWorkspaceCommit: fs.readFileSync(path.join(here, "V_WORKSPACE_COMMIT"), "utf8").trim(),
  files: [...files, "payload-manifest.json"],
  systemSchedules,
};
fs.writeFileSync(path.join(payload, "payload-manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`${version}: ${files.length} files, ${systemSchedules.length} system schedules`);
