// Verify the wake-time bootstrap through AlibabaProvider itself, not a standalone
// script: create must produce a runnable runtime, and a second bootstrap on the
// same sandbox (including across pause/resume) must be a no-op.
import fs from "node:fs";
import path from "node:path";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { AlibabaProvider, AlibabaSandbox, alibabaOptions } from "../src/alibaba-provider.js";
import type { Tenant } from "../src/store.js";

class Probe extends AlibabaProvider {
  createSandbox(tenant: Tenant) { return this.create(tenant, ""); }
  runBootstrap(box: AlibabaSandbox) { return this.bootstrap(box); }
}

const config = loadConfig();
const options = alibabaOptions(config);
const provider = new Probe(config);
const report: Record<string, unknown> = { region: config.alibaba!.region, startedAt: new Date().toISOString() };
const ids: string[] = [];
const sh = async (box: AlibabaSandbox, cmd: string) => {
  const r = await box.runCommand({ cmd: "sh", args: ["-c", cmd] });
  return { exitCode: r.exitCode, stdout: (await r.stdout()).trim() };
};
try {
  const tenant = { id: `probe-${Date.now()}` } as Tenant;
  let at = Date.now();
  const box = await provider.createSandbox(tenant) as AlibabaSandbox;
  ids.push(box.name);
  report.createWithBootstrapMs = Date.now() - at;

  report.node = (await sh(box, "node --version")).stdout;
  report.openclaw = (await sh(box, "node /vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs --version")).stdout;
  report.payloadFiles = (await sh(box, "find /vercel/sandbox/nexus/payload -type f | wc -l")).stdout;
  report.payloadSample = (await sh(box, "ls /vercel/sandbox/nexus/payload | head -5 | tr '\\n' ' '")).stdout;

  if (report.node !== "v24.21.0") throw Error(`NODE_NOT_TAKEN_OVER:${report.node}`);
  if (!String(report.openclaw).includes("2026.7.1")) throw Error(`OPENCLAW_MISSING:${report.openclaw}`);
  if (Number(report.payloadFiles) < 600) throw Error(`PAYLOAD_INCOMPLETE:${report.payloadFiles}`);

  // Idempotence: same sandbox, unchanged inputs -> no work.
  at = Date.now();
  report.secondBootstrap = await provider.runBootstrap(box);
  report.secondBootstrapMs = Date.now() - at;
  if ((report.secondBootstrap as any).bootstrapped !== false) throw Error("BOOTSTRAP_NOT_IDEMPOTENT");

  // And it must still be a no-op after the instance has actually slept.
  at = Date.now();
  await box.stop();
  report.pauseMs = Date.now() - at;
  at = Date.now();
  const resumed = new AlibabaSandbox(await Sandbox.connect(box.name, { ...options, timeoutMs: 600_000 }));
  report.resumeMs = Date.now() - at;
  at = Date.now();
  report.bootstrapAfterResume = await provider.runBootstrap(resumed);
  report.bootstrapAfterResumeMs = Date.now() - at;
  if ((report.bootstrapAfterResume as any).bootstrapped !== false) throw Error("BOOTSTRAP_REPEATED_AFTER_RESUME");
  report.openclawAfterResume = (await sh(resumed, "node /vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs --version")).stdout;
  if (report.openclawAfterResume !== report.openclaw) throw Error("RUNTIME_LOST_ON_RESUME");

  report.passed = true;
} catch (error: any) {
  report.passed = false;
  report.errorType = error?.constructor?.name;
  report.error = String(error?.message ?? "").replaceAll(config.alibaba!.apiKey, "[redacted]").slice(0, 2000);
  process.exitCode = 1;
} finally {
  report.testSandboxIds = ids;
  const cleanup = await Promise.allSettled(ids.map(id => Sandbox.kill(id, options)));
  report.cleanupPassed = cleanup.every(r => r.status === "fulfilled");
  fs.writeFileSync(path.join(config.dataDir, "alibaba-bootstrap.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
