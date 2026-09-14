// Explicit, evidence-gated repair for the profiling stream-drain regression.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { VercelProvider } from "../src/provider.js";
const c = loadConfig(),
  s = new Store(c);
await s.init();
const runId = process.env.NEXUS_RECOVER_RUN_ID;
if (!runId) throw Error("NEXUS_RECOVER_RUN_ID required");
try {
  await s.locked((await s.run(runId)).tenant_id, async (db) => {
    const r = await s.run(runId);
    if (r.status !== "uncertain" || r.error !== "OPENCLAW_INCOMPLETE_RESPONSE")
      throw Error("UNEXPECTED_RUN_STATE");
    const done = await db.query(
      "SELECT 1 FROM elastic_events WHERE run_id=$1 AND kind='runtime-completed'",
      [runId],
    );
    if (done.rowCount !== 1) throw Error("NO_UNAMBIGUOUS_COMPLETION");
    const {
      rows: [{ output }],
    } = await db.query(
      "SELECT string_agg(data->>'text','' ORDER BY seq) AS output FROM elastic_events WHERE run_id=$1 AND kind='delta'",
      [runId],
    );
    if (!output) throw Error("NO_COMPLETE_OUTPUT");
    const t = await s.tenant(r.tenant_id),
      b = await new VercelProvider(c).get(t, false);
    const proof = await b.readFileToBuffer({
      path: "/vercel/sandbox/agent-data/workspace/nexus-profile-proof.txt",
    });
    if (proof?.toString().trim() !== "official-deepseek-stream-914")
      throw Error("FILE_PROOF_MISSING");
    const backup = await b.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/backup.mjs"],
    });
    if (backup.exitCode) throw Error("BACKUP_FAILED");
    const bytes = await b.readFileToBuffer({ path: "/tmp/nexus-state.tgz" });
    if (!bytes) throw Error("BACKUP_EMPTY");
    const dest = path.join(c.dataDir, "backups", t.id + ".tgz");
    fs.writeFileSync(dest + ".tmp", bytes, { mode: 0o600 });
    fs.renameSync(dest + ".tmp", dest);
    await db.query("BEGIN");
    try {
      await db.query(
        "UPDATE elastic_runs SET status='succeeded',output=$2,error=NULL,delivery='pending',completed_at=now() WHERE id=$1",
        [runId, output],
      );
      await db.query(
        "UPDATE elastic_tenants SET state='ready',last_error=NULL,last_activity=now() WHERE id=$1",
        [t.id],
      );
      await s.boss.send(
        "feishu-reply",
        { runId },
        { db: { executeSql: (sql, values) => db.query(sql, values) } },
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
    await s.event(
      t.id,
      "recovered-complete-stream",
      { toolReplayed: false, backupBytes: bytes.length },
      runId,
    );
    console.log("RECOVERED_WITHOUT_TOOL_REPLAY", runId);
  });
} finally {
  await s.close();
}
