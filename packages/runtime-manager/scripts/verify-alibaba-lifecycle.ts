import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Sandbox } from "e2b";
import { loadConfig } from "../src/config.js";
import { alibabaOptions } from "../src/alibaba-provider.js";

const config = loadConfig(), options = alibabaOptions(config);
const report: Record<string, unknown> = { region: config.alibaba!.region, startedAt: new Date().toISOString() };
const ids: string[] = [];
try {
  let at = Date.now();
  const a = await Sandbox.create(config.alibaba!.templateId || "base", { ...options, timeoutMs: 180_000 });
  ids.push(a.sandboxId); report.createMs = Date.now() - at;
  const marker = randomUUID();
  await a.files.write("/tmp/nexus-lifecycle-marker", marker);
  report.command = (await a.commands.run("printf NEXUS_ALIBABA_COMMAND_OK")).stdout;
  at = Date.now();
  if (!(await a.pause({ keepMemory: false }))) throw Error("PAUSE_NOT_CONFIRMED");
  report.pauseMs = Date.now() - at;
  if ((await Sandbox.getInfo(a.sandboxId, options)).state !== "paused") throw Error("PAUSE_STATE_MISMATCH");
  at = Date.now();
  const resumed = await Sandbox.connect(a.sandboxId, { ...options, timeoutMs: 180_000 });
  report.resumeMs = Date.now() - at;
  if (await resumed.files.read("/tmp/nexus-lifecycle-marker") !== marker) throw Error("MEMORY_RESTORE_FAILED");
  const b = await Sandbox.create(config.alibaba!.templateId || "base", {
    // FC rejects enableAutoPause below 600s idle timeout; 600s is the platform floor.
    ...options, timeoutMs: 600_000,
    lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
  });
  ids.push(b.sandboxId);
  if (b.sandboxId === a.sandboxId || await b.files.exists("/tmp/nexus-lifecycle-marker")) throw Error("TENANT_ISOLATION_FAILED");
  // Verify timeout expiry really pauses instead of trusting an accepted setting.
  for (let i = 0; i < 56; i++) {
    await new Promise(resolve => setTimeout(resolve, 15_000));
    if ((await Sandbox.getInfo(b.sandboxId, options)).state === "paused") { report.autoPause = true; break; }
  }
  if (!report.autoPause) throw Error("AUTO_PAUSE_NOT_CONFIRMED");
  report.lifecyclePassed = true;
} catch (error: any) {
  report.lifecyclePassed = false;
  report.error = String(error.message).replaceAll(config.alibaba!.apiKey, "[redacted]").slice(0, 2000);
  process.exitCode = 1;
} finally {
  report.testSandboxIds = ids;
  const cleanup = await Promise.allSettled(ids.map(id => Sandbox.kill(id, options)));
  report.cleanupPassed = cleanup.every(r => r.status === "fulfilled");
  fs.writeFileSync(path.join(config.dataDir, "alibaba-lifecycle.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
