import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { VercelProvider } from "../src/provider.js";
const c = loadConfig(),
  s = new Store(c),
  override = JSON.parse(
    fs.readFileSync(path.join(c.dataDir, "profile/config.json"), "utf8"),
  );
const t = (
  await s.pool.query(
    "SELECT * FROM elastic_tenants WHERE id=$1 AND app_id IS NULL AND state='sleeping'",
    [
      process.env.NEXUS_DIAGNOSTIC_TENANT_ID ||
        (() => {
          throw Error("NEXUS_DIAGNOSTIC_TENANT_ID required");
        })(),
    ],
  )
).rows[0];
if (!t) throw Error("ISOLATED_SLEEPING_TENANT_REQUIRED");
process.env.NEXUS_CPU_PROFILE = "1";
const p = new VercelProvider({
  ...c,
  model: override.model,
  optimizeRuntime: true,
});
await s.pool.query("UPDATE elastic_tenants SET state='profiling' WHERE id=$1", [
  t.id,
]);
try {
  console.log("READY", await p.ensure(t));
  const events: any[] = [];
  const out = await p.execute(
    t,
    "backup-acceptance",
    "请调用文件工具，将 profile-backup-914 写到工作目录的 nexus-profile-proof.txt，再读取该文件验证，只回复文件内容。",
    async (kind, data) => {
      if (kind !== "delta") events.push({ kind, data });
    },
  );
  console.log("TOOL_PROOF", out.includes("profile-backup-914"), events);
  const b = await p.get(t, false);
  const stop = await b.runCommand({
    cmd: "node",
    args: ["/vercel/sandbox/nexus/quiesce.mjs"],
  });
  console.log("QUIESCE", stop.exitCode);
  if (stop.exitCode === 0) {
    const list = await b.runCommand({
      cmd: "find",
      args: ["/tmp", "-maxdepth", "1", "-name", "CPU.*.cpuprofile"],
    });
    const files = (await list.stdout()).trim().split("\n").filter(Boolean);
    for (const file of files) {
      const bytes = await b.readFileToBuffer({ path: file });
      if (bytes)
        fs.writeFileSync(
          path.join(c.dataDir, "profile", path.basename(file)),
          bytes,
          { mode: 0o600 },
        );
    }
    console.log("CPU_PROFILES", files.length);
  }
  fs.writeFileSync(
    path.join(c.dataDir, "profile/diagnostics.json"),
    JSON.stringify(
      { events, toolProof: out.includes("profile-backup-914") },
      null,
      2,
    ),
  );
  await b.stop();
  await s.pool.query(
    "UPDATE elastic_tenants SET state='sleeping' WHERE id=$1",
    [t.id],
  );
} finally {
  await s.pool.end();
}
