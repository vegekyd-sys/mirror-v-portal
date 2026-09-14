import type { Store } from "./store.js";
import type { RuntimeProvider } from "./provider.js";

export class RuntimeManager {
  private timer?: NodeJS.Timeout;
  private collecting = false;
  constructor(
    readonly store: Store,
    readonly provider: RuntimeProvider,
  ) {}
  async start() {
    await this.store.boss.work<{ runId: string }>(
      "agent-turn",
      { localConcurrency: 4, groupConcurrency: 1, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await this.process(job.data.runId);
      },
    );
    this.timer = setInterval(
      () =>
        void this.collect().catch((e) =>
          console.error("[collector]", e.message),
        ),
      5000,
    );
  }
  async process(runId: string) {
    const run = await this.store.run(runId);
    if (["succeeded", "failed", "uncertain"].includes(run.status)) return;
    const processed = await this.store.locked(run.tenant_id, async (db) => {
      const current = await this.store.run(runId);
      if (["succeeded", "failed", "uncertain"].includes(current.status))
        return true;
      const tenant = await this.store.tenant(run.tenant_id, db);
      // A controller crash may have left a tool with an external side effect.
      // Never replay that turn merely because the queue lease expired.
      if (
        current.status === "running" ||
        ["busy", "waking", "quiescing", "blocked"].includes(tenant.state)
      ) {
        await db.query(
          "UPDATE elastic_runs SET status='uncertain',error='RECOVERY_REVIEW_REQUIRED',completed_at=now() WHERE id=$1",
          [runId],
        );
        await db.query(
          "UPDATE elastic_tenants SET state='blocked',last_error='RECOVERY_REVIEW_REQUIRED' WHERE id=$1",
          [tenant.id],
        );
        await this.store.event(tenant.id, "recovery-required", {}, runId);
        return true;
      }
      // Preserve arrival order across the parallel queue workers.
      const earlier = await db.query(
        "SELECT 1 FROM elastic_runs WHERE tenant_id=$1 AND status='queued' AND (created_at,id)<($2,$3) LIMIT 1",
        [tenant.id, current.created_at, runId],
      );
      if (earlier.rowCount) throw new Error("EARLIER_TURN_PENDING");
      let submitted = false;
      try {
        await db.query(
          "UPDATE elastic_tenants SET state='waking',last_error=NULL WHERE id=$1",
          [tenant.id],
        );
        await this.store.event(tenant.id, "waking", {}, runId);
        const handle = await this.provider.ensure(tenant, async (name) => {
          tenant.sandbox_name = name;
          await db.query(
            "UPDATE elastic_tenants SET sandbox_name=$2 WHERE id=$1",
            [tenant.id, name],
          );
        });
        tenant.sandbox_name = handle.name;
        await db.query(
          "UPDATE elastic_tenants SET state='busy',sandbox_name=$2,last_wake_ms=$3,wake_count=wake_count+1 WHERE id=$1",
          [tenant.id, handle.name, handle.wakeMs],
        );
        await db.query("UPDATE elastic_runs SET status='running' WHERE id=$1", [
          runId,
        ]);
        await this.store.event(
          tenant.id,
          "ready",
          {
            wakeMs: handle.wakeMs,
            reused: handle.reused,
            sandboxName: handle.name,
          },
          runId,
        );
        submitted = true;
        const output = await this.provider.execute(
          tenant,
          current.session_key,
          current.text,
          (kind, data) => this.store.event(tenant.id, kind, data, runId),
        );
        await db.query("BEGIN");
        try {
          await db.query(
            "UPDATE elastic_runs SET status='succeeded',output=$2,completed_at=now(),delivery=$3 WHERE id=$1",
            [runId, output, current.channel === "feishu" ? "pending" : "none"],
          );
          await db.query(
            "UPDATE elastic_tenants SET state='ready',last_activity=now(),last_error=NULL WHERE id=$1",
            [tenant.id],
          );
          if (current.channel === "feishu")
            await this.store.boss.send(
              "feishu-reply",
              { runId },
              {
                db: { executeSql: (sql, values) => db.query(sql, values) },
                singletonKey: runId,
              },
            );
          await db.query("COMMIT");
        } catch (e) {
          await db.query("ROLLBACK");
          throw e;
        }
        await this.store.event(tenant.id, "completed", { output }, runId);
      } catch (e) {
        const message = e instanceof Error ? e.message : "RUNTIME_ERROR";
        const status = submitted ? "uncertain" : "failed";
        await db.query(
          "UPDATE elastic_runs SET status=$2,error=$3,completed_at=now() WHERE id=$1",
          [runId, status, message],
        );
        await db.query(
          "UPDATE elastic_tenants SET state=$2,last_error=$3,last_activity=now() WHERE id=$1",
          [tenant.id, submitted ? "blocked" : "ready", message],
        );
        await this.store.event(tenant.id, status, { error: message }, runId);
        if (current.channel === "feishu") {
          await db.query(
            "UPDATE elastic_runs SET delivery='pending' WHERE id=$1",
            [runId],
          );
          await this.store.boss.send(
            "feishu-reply",
            { runId },
            { singletonKey: runId },
          );
        }
      }
      return true;
    });
    if (!processed) throw new Error("AGENT_BUSY");
  }
  async collect(tenantId?: string) {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const { rows } = await this.store.pool.query(
        "SELECT id FROM elastic_tenants WHERE state='ready' AND ($1::text IS NULL OR id=$1) AND last_activity + idle_seconds * interval '1 second' < now()",
        [tenantId || null],
      );
      for (const row of rows)
        await this.store.locked(row.id, async (db) => {
          const pending = await db.query(
            "SELECT 1 FROM elastic_runs WHERE tenant_id=$1 AND status IN ('queued','running') LIMIT 1",
            [row.id],
          );
          if (pending.rowCount) return;
          const eligible = await db.query(
            "UPDATE elastic_tenants SET state='quiescing' WHERE id=$1 AND state='ready' AND last_activity + idle_seconds * interval '1 second' < now() RETURNING *",
            [row.id],
          );
          const tenant = eligible.rows[0];
          if (!tenant) return;
          try {
            await this.store.event(tenant.id, "quiescing");
            const result = await this.provider.stop(tenant);
            if (!result.stopped) {
              await db.query(
                "UPDATE elastic_tenants SET state='ready',last_activity=now(),last_error=$2 WHERE id=$1",
                [tenant.id, result.reason],
              );
              await this.store.event(tenant.id, "idle-deferred", {
                reason: result.reason,
              });
              return;
            }
            await db.query(
              "UPDATE elastic_tenants SET state='sleeping',snapshot_id=coalesce($2,snapshot_id),last_error=NULL WHERE id=$1",
              [tenant.id, result.snapshotId || null],
            );
            await this.store.event(tenant.id, "sleeping", {
              snapshotId: result.snapshotId,
              computeReleased: true,
            });
          } catch (e) {
            await db.query(
              "UPDATE elastic_tenants SET state='blocked',last_error=$2 WHERE id=$1",
              [tenant.id, e instanceof Error ? e.message : "STOP_FAILED"],
            );
          }
        });
    } finally {
      this.collecting = false;
    }
  }
  stopTimer() {
    if (this.timer) clearInterval(this.timer);
  }
}
