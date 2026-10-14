import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// The Gateway host is already a per-tenant cloud VM. Do not introduce a second
// Docker sandbox or a host approval UI that the Portal cannot answer.
export function sandboxExecPolicy(dataDir) {
  return { host: "gateway", security: "full", ask: "off", pathPrepend: [path.join(dataDir, "npm", "bin")] };
}

export function sandboxExecEnv(dataDir, inheritedPath = "") {
  const prefix = path.join(dataDir, "npm");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  return {
    NPM_CONFIG_PREFIX: prefix,
    // Recent npm versions skip unapproved install scripts, leaving native CLIs
    // installed but unusable. Execution authority belongs to this tenant VM.
    NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
    PATH: [path.join(prefix, "bin"), inheritedPath].filter(Boolean).join(":"),
  };
}

/** Align the host-local policy too, including old per-agent overrides. */
export function ensureSandboxExecApprovals(openclawEntrypoint, env, run = execFileSync) {
  // The pinned 2026.7 runtime stores JSON; V's patched 2026.9 runtime stores
  // approvals in SQLite. Use the owning CLI instead of creating legacy files
  // that would trigger a migration gate in V.
  const cli = (...args) => run(process.execPath, [openclawEntrypoint, "approvals", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const prior = JSON.parse(cli("get", "--json")).file;
  if (!prior || prior.version !== 1) throw Error("SANDBOX_EXEC_APPROVALS_INVALID");
  const policy = { security: "full", ask: "off", askFallback: "full" };
  const approvals = {
    ...prior, version: 1, defaults: { ...prior.defaults, ...policy },
    agents: Object.fromEntries(Object.entries(prior.agents ?? {}).map(([id, value]) => [id, { ...value, ...policy }])),
  };
  if (JSON.stringify(prior) === JSON.stringify(approvals)) return false;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-exec-policy-"));
  try {
    const filename = path.join(temporary, "approvals.json");
    fs.writeFileSync(filename, JSON.stringify(approvals), { mode: 0o600 });
    cli("set", "--file", filename, "--json");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return true;
}
