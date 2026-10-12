import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readVRelease, daemonTree, vReleaseKeepAwake, desktopHandoffBusy, processRemotePorts } from "./v-release.mjs";
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
const isDaemon = daemonTree(now.map((line) => {
  const [pid, ppid, ...args] = line.trim().split(/\s+/);
  return { pid, ppid, command: args.join(" ") };
}));
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
    !(vRelease && isDaemon(pid))
  );
});
if (vRelease) {
  let publicPorts = {};
  try { publicPorts = JSON.parse(fs.readFileSync("/tmp/nexus-public-ports.json", "utf8")); } catch {}
  // The V Browser extension and an idle voice page hold connections without
  // anything happening, so those ports never pin the VM by themselves.
  let reason = vReleaseKeepAwake({ publicPorts, idlePorts: ["vbrowser", "voice", ...(vRelease.idlePublicPorts ?? [])] })
    ?? await desktopHandoffBusy({ tokenFile: "/vercel/sandbox/agent-data/desktop-handoff/admin-token" });
  // A voice call is live while the voice server holds a provider WebSocket (TLS 443).
  if (!reason && fs.existsSync("/tmp/nexus-voice.pid")) {
    const voicePid = fs.readFileSync("/tmp/nexus-voice.pid", "utf8").trim();
    if (processRemotePorts(voicePid).includes(443)) reason = "voice-call";
  }
  if (reason) {
    console.log(JSON.stringify({ ok: false, reason }));
    process.exit(2);
  }
}
if (extras.length) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: "background-processes",
      count: extras.length,
      // Executable names only (no arguments: they can carry user data).
      commands: extras.slice(0, 5).map((line) => line.trim().split(/\s+/)[2]?.split("/").pop()?.slice(0, 40)),
    }),
  );
  process.exit(2);
}
// Stop the indexer first so its last sync commits before the filesystem snapshot.
if (vRelease) {
  for (const name of ["memory-indexer", "voice", "vbrowser-broker", "cua-node", "desktop-handoff"]) {
    try { process.kill(Number(fs.readFileSync(`/tmp/nexus-${name}.pid`, "utf8")), "SIGTERM"); } catch {}
  }
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
