// Regenerate payload/payload-manifest.json for the Mirror V full template:
// every file under payload/ (the builder ships exactly this list) plus the
// background loops registered for each tenant. Run after editing the payload
// or after distro/import-workspace.mjs. Usage: node gen-manifest.mjs <version>
import fs from "node:fs";
import path from "node:path";
import { portalSchedules } from "./distro/schedules.mjs";
import { SANDBOX_VALUES } from "./distro/import-workspace.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const payload = path.join(here, "payload");
const version = process.argv[2];
if (!/^mirror-v-full\.[a-z0-9.-]+$/.test(version ?? "")) throw Error("usage: node gen-manifest.mjs mirror-v-full.<version>");
const files = [];
const walk = (dir, prefix = "") => {
  for (const name of fs.readdirSync(dir).sort()) {
    // Local tooling leftovers (python -m py_compile, Finder) are not payload.
    if (name === ".DS_Store" || name === "__pycache__" || name.endsWith(".pyc")) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(path.join(dir, name));
    if (stat.isSymbolicLink()) throw Error(`symlink not allowed in payload: ${rel}`);
    if (stat.isDirectory()) walk(path.join(dir, name), rel);
    else if (rel !== "payload-manifest.json") {
      if (/^(<<<<<<< mirror|>>>>>>> v@)/m.test(fs.readFileSync(path.join(dir, name), "latin1"))) throw Error(`merge conflict markers left in ${rel}`);
      files.push(rel);
    }
  }
};
walk(payload);
// The workspace's own schedule list (payload/schedules.json), registered by the Portal.
const systemSchedules = portalSchedules(JSON.parse(fs.readFileSync(path.join(payload, "schedules.json"), "utf8")), SANDBOX_VALUES.TIMEZONE);
const distro = JSON.parse(fs.readFileSync(path.join(here, "DISTRO_WORKSPACE.json"), "utf8"));
const manifest = {
  name: "mirror-v-full",
  version,
  description: "全功能的 V：V 的运行时、Worker 池、记忆系统和自我进化循环，不带 V 的记忆",
  // Where the payload came from: the installable V workspace (distro/workspace) at this commit.
  distroWorkspace: { repo: distro.repo, commit: distro.commit, payloadTree: distro.payloadTree, vCoreCommit: distro.vCoreCommit },
  files: [...files, "payload-manifest.json"],
  systemSchedules,
};
fs.writeFileSync(path.join(payload, "payload-manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`${version}: ${files.length} files, ${systemSchedules.length} system schedules`);
