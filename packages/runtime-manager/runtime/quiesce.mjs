import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readVRelease, isVReleaseDaemon } from "./v-release.mjs";
const vRelease = readVRelease();

// Reject unknown live processes before stopping a VM. Kernel and Vercel supervisor
// processes present at boot are ignored; user-started background work pins the VM.
const baseline = new Set(
  fs
    .readFileSync("/tmp/nexus-baseline-pids", "utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0]),
);
const now = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const own = String(process.pid);
const extras = now.filter((line) => {
  const [pid, ppid, ...args] = line.trim().split(/\s+/);
  const command = args.join(" ");
  return (
    !baseline.has(pid) &&
    pid !== own &&
    ppid !== own &&
    !command.includes("quiesce.mjs") &&
    !command.startsWith("ps ") &&
    !command.includes("[defunct]") &&
    !command.includes("sshd:") &&
    !command.includes("envd") &&
    // V's own daemons (Worker pool, memory indexer, Codex app-server) idle with the Gateway.
    !(vRelease && isVReleaseDaemon(command))
  );
});
if (extras.length) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: "background-processes",
      count: extras.length,
    }),
  );
  process.exit(2);
}
// Stop the indexer first so its last sync commits before the filesystem snapshot.
if (vRelease && fs.existsSync("/tmp/nexus-memory-indexer.pid")) {
  try { process.kill(Number(fs.readFileSync("/tmp/nexus-memory-indexer.pid", "utf8")), "SIGTERM"); } catch {}
}
const pid = Number(fs.readFileSync("/tmp/nexus-gateway.pid", "utf8"));
try {
  process.kill(pid, "SIGTERM");
} catch {}
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    process.kill(pid, 0);
  } catch {
    execFileSync("sync");
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  }
}
console.log(JSON.stringify({ ok: false, reason: "gateway-still-running" }));
process.exit(2);
