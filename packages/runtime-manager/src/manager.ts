import { InboundMediaError } from "./inbound-media.js";
import { Scheduler } from './scheduler.js';
import { randomUUID } from "node:crypto";
import type { Store, Run } from "./store.js";
import type { RuntimeProvider , MediaFile } from "./provider.js";

/**
 * The turn text for Manager.greet. It reaches the agent as the first message in
 * the owner's chat; the payload's BOOTSTRAP.md decides what the agent actually
 * says, so this only states the situation and points at it.
 */
export const GREETING_PROMPT =
  "【平台消息，不是主人说的话】主人刚刚扫码创建了你，还没有开口。现在由你先说话：" +
  "工作区里有 BOOTSTRAP.md 就严格按它的第一步开场；没有就用一两句话打个招呼，说明你能做什么。" +
  "不要提到这条平台消息。";

/** Failures the runtime reported after ending the turn itself (e.g. a model timeout). */
export const RUNTIME_REPORTED_FAILURES = new Set([
  "OPENCLAW_RESPONSE_FAILED",
  "OPENCLAW_INCOMPLETE_RESPONSE",
  "STATE_BACKUP_FAILED",
  "STATE_BACKUP_EMPTY",
]);

export class RuntimeManager {
  private timer?: NodeJS.Timeout;
  private collecting = false;
  constructor(
    readonly store: Store,
    readonly provider: RuntimeProvider,
    readonly onDelta?: (run: Run, text: string) => void,
    readonly onProgress?: (run: Run, kind: string, data: any) => void,
    readonly onMedia?: (run: Run, media: MediaFile[]) => void | Promise<void>,
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
      // A stopped controller may leave idle release in progress. This is not
      // evidence of an executed message; finish the idempotent stop under lock.
      if (tenant.state === "quiescing" && current.status === "queued") {
        const active = await db.query("SELECT 1 FROM elastic_runs WHERE tenant_id=$1 AND status='running' LIMIT 1", [tenant.id]);
        if (!active.rowCount) {
          const stopped = await this.provider.stop(tenant);
          tenant.state = stopped.stopped ? "sleeping" : "ready";
          await db.query("UPDATE elastic_tenants SET state=$2,snapshot_id=coalesce($3,snapshot_id),last_error=NULL WHERE id=$1", [tenant.id,tenant.state,stopped.snapshotId || null]);
          await this.store.event(tenant.id,"idle-release-recovered",{stopped:stopped.stopped},runId);
        }
      }
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
        if (current.channel === "feishu") {
          await db.query("UPDATE elastic_runs SET delivery='pending' WHERE id=$1", [runId]);
          await this.store.boss.send("feishu-reply", {runId}, {singletonKey:runId});
        }
        return true;
      }
      // Preserve arrival order across the parallel queue workers.
      const earlier = await db.query(
        "SELECT 1 FROM elastic_runs WHERE tenant_id=$1 AND status='queued' AND (created_at,id)<(SELECT created_at,id FROM elastic_runs WHERE id=$2) LIMIT 1",
        [tenant.id, runId],
      );
      if (earlier.rowCount) throw new Error("EARLIER_TURN_PENDING");
      let submitted = false;
      try {
        await db.query(
          "UPDATE elastic_tenants SET state='waking',last_error=NULL WHERE id=$1",
          [tenant.id],
        );
        await this.store.event(
          tenant.id,
          "waking",
          {
            at: Date.now(),
            queueMs: Date.now() - new Date(current.created_at).getTime(),
          },
          runId,
        );
        this.onProgress?.(current, "waking", {});
        tenant.runtime_env = await this.store.tenantSecretEnv(tenant.id);
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
            ...handle.timings,
          },
          runId,
        );
        const attachments = current.attachments?.length ? current.attachments : current.inherit_attachments === false ? [] : await this.store.previousAttachments(current);
        submitted = true;
        // Preview frames are not persisted; keep when the first one came and how many (eval A2/A3).
        const preview = { frames: 0, firstAt: 0, lastAt: 0 };
        const { output, media } = await this.provider.execute(
          tenant,
          current.session_key,
          current.text,
          async (kind, data) => {
            if(kind === "schedule-request") {
              try {data.result=await new Scheduler(this.store).command(current,data.id,data.args);}
              catch(e){data.result={error:e instanceof Error?e.message:"SCHEDULE_ERROR"};}
              await this.store.event(tenant.id,"schedule-command",{action:data.args?.action,ok:!data.result.error},runId);
              return;
            }
            // Previews are throttled snapshots of the same text: route them, never persist them.
            if (kind === "preview") {
              preview.lastAt = Date.now();
              if (!preview.frames++) {
                preview.firstAt = preview.lastAt;
                await this.store.event(tenant.id, "first-preview", { at: preview.firstAt }, runId);
              }
            } else await this.store.event(tenant.id, kind, data, runId);
            if (kind === "delta") this.onDelta?.(current, data.text);
            else this.onProgress?.(current, kind, data);
          },
          { channel: current.channel, attachments, attachmentsFromPreviousTurn: !current.attachments?.length && attachments.length > 0 },
        );
        if (preview.frames) await this.store.event(tenant.id, "preview-stats", preview, runId);
        // Persist outbound files before queuing the reply. Channel delivery can
        // then retry after a restart without repeating the creative turn.
        if (media?.length) await this.onMedia?.(current, media);
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
        try {
          const added = await new Scheduler(this.store).ensureSystemSchedules(current, this.store.config.templates?.[tenant.template_id]?.systemSchedules);
          if (added.length) await this.store.event(tenant.id, "system-schedules", { added }, runId);
        } catch (e) {
          await this.store.event(tenant.id, "system-schedules-failed", { error: e instanceof Error ? e.message : "SYSTEM_SCHEDULE_ERROR" }, runId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "RUNTIME_ERROR";
        const sent = submitted && !(e instanceof InboundMediaError);
        const status = sent ? "uncertain" : "failed";
        await db.query(
          "UPDATE elastic_runs SET status=$2,error=$3,completed_at=now() WHERE id=$1",
          [runId, status, message],
        );
        // The run stays uncertain (its tools may have acted), but when the runtime
        // itself reported the turn finished, nothing is still in flight: the next
        // message may run. Only a turn the controller lost track of blocks the agent.
        await db.query(
          "UPDATE elastic_tenants SET state=$2,last_error=$3,last_activity=now() WHERE id=$1",
          [tenant.id, sent && !RUNTIME_REPORTED_FAILURES.has(message) ? "blocked" : "ready", message],
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
  /**
   * An owner opened a signed link to a public service (the voice page): wake the
   * sandbox if it sleeps, keep it from idling out right away, and return where
   * the service is reachable now. A running turn already holds the sandbox up.
   */
  async open(tenantId: string, service: string, signature: string): Promise<string> {
    const tenant = await this.store.tenant(tenantId);
    if (!this.provider.openSignatureValid?.(tenant, service, signature)) throw Error("OPEN_LINK_INVALID");
    if (tenant.state === "blocked") throw Error("AGENT_NEEDS_REVIEW");
    const running = ["busy", "waking"].includes(tenant.state) ? await this.provider.runningPublicUrls?.(tenant) : null;
    if (running) return this.provider.serviceUrl!(tenant, service, running);
    const woken = await this.store.locked(tenant.id, async (db) => {
      const current = await this.store.tenant(tenant.id, db);
      if (current.state === "blocked") throw Error("AGENT_NEEDS_REVIEW");
      const previous = current.state;
      await db.query("UPDATE elastic_tenants SET state='waking',last_error=NULL WHERE id=$1", [current.id]);
      try {
        current.runtime_env = await this.store.tenantSecretEnv(current.id);
        const handle = await this.provider.ensure(current, async (name) => {
          await db.query("UPDATE elastic_tenants SET sandbox_name=$2 WHERE id=$1", [current.id, name]);
        });
        await db.query("UPDATE elastic_tenants SET state='ready',sandbox_name=$2,last_activity=now(),last_wake_ms=$3,wake_count=wake_count+1 WHERE id=$1", [current.id, handle.name, handle.wakeMs]);
        await this.store.event(current.id, "opened", { service, wakeMs: handle.wakeMs, reused: handle.reused });
        return this.provider.serviceUrl!(current, service, handle.publicUrls ?? {});
      } catch (e) {
        await db.query("UPDATE elastic_tenants SET state=$2,last_error=$3 WHERE id=$1", [current.id, previous === "sleeping" ? "sleeping" : "ready", e instanceof Error ? e.message : "OPEN_FAILED"]);
        throw e;
      }
    });
    if (woken) return woken;
    // A turn holds the lock: the sandbox is up.
    const urls = await this.provider.runningPublicUrls?.(tenant);
    if (!urls) throw Error("AGENT_BUSY");
    return this.provider.serviceUrl!(tenant, service, urls);
  }
  /**
   * Continue a conversation on behalf of a component inside the sandbox (the
   * takeover page's 交还给 V): queue a normal turn in the original chat, so the
   * reply leaves through the channel edge like any other.
   */
  async wakeSession(tenantId: string, signature: string, input: { sessionKey?: unknown; text?: unknown; requestKey?: unknown }) {
    const tenant = await this.store.tenant(tenantId);
    if (!this.provider.wakeSignatureValid?.(tenant, signature)) throw Error("WAKE_LINK_INVALID");
    const prefix = `agent:${tenant.template_id || "dealclaw"}:`;
    const internal = String(input.sessionKey ?? "");
    const sessionKey = internal.startsWith(prefix) ? internal.slice(prefix.length) : "";
    if (!sessionKey || sessionKey.length > 256 || /:scheduled:/.test(sessionKey)) throw Error("WAKE_SESSION_INVALID");
    const text = String(input.text ?? "").slice(0, 2000);
    const requestKey = `wake:${String(input.requestKey ?? "").slice(0, 200)}`;
    if (!text.trim() || requestKey === "wake:") throw Error("WAKE_INPUT_INVALID");
    const chat = sessionKey.startsWith(`${tenant.id}:oc_`) ? sessionKey.slice(tenant.id.length + 1) : null;
    const id = randomUUID();
    const inserted = await this.store.pool.query(
      "INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,chat_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING id",
      [id, tenant.id, requestKey, sessionKey, text, chat ? "feishu" : "browser-trial", chat],
    );
    if (!inserted.rowCount) return { queued: false, duplicate: true };
    await this.store.boss.send("agent-turn", { runId: id }, { group: { id: tenant.id } });
    await this.store.event(tenant.id, "session-woken", { requestKey }, id);
    return { queued: true, runId: id };
  }
  /**
   * Let the agent speak first right after a scan: the owner has not written
   * anything yet, so queue one turn in their chat with a platform prompt and let
   * the reply go out like any other. Called once per tenant by the onboarding
   * orchestrator after it has learned the chat id from its first message;
   * idempotent by request key, so a retried call never greets twice.
   */
  async greet(tenantId: string, chatId: unknown) {
    const tenant = await this.store.tenant(tenantId);
    const chat = String(chatId ?? "");
    if (!/^oc_[A-Za-z0-9_-]{1,128}$/.test(chat)) throw Error("GREET_CHAT_INVALID");
    const id = randomUUID();
    const inserted = await this.store.pool.query(
      "INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,chat_id) VALUES($1,$2,$3,$4,$5,'feishu',$6) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING id",
      [id, tenant.id, `greet:${tenant.id}`, `${tenant.id}:${chat}`, GREETING_PROMPT, chat],
    );
    if (!inserted.rowCount) return { queued: false, duplicate: true };
    await this.store.boss.send("agent-turn", { runId: id }, { group: { id: tenant.id } });
    await this.store.event(tenant.id, "greeting-queued", { chatId: chat }, id);
    return { queued: true, runId: id };
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
                ...(result.detail ? { detail: result.detail } : {}),
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
            // No turn is in flight when an idle VM fails to stop: retry on the next
            // pass rather than refusing every later message (one stop timeout once
            // locked an owner out for three days).
            const message = e instanceof Error ? e.message : "STOP_FAILED";
            await db.query(
              "UPDATE elastic_tenants SET state='ready',last_activity=now(),last_error=$2 WHERE id=$1",
              [tenant.id, message],
            );
            await this.store.event(tenant.id, "idle-stop-failed", { error: message.slice(0, 200) });
          }
        });
    } finally {
      this.collecting = false;
    }
  }
  async drainCollector() {
    this.stopTimer();
    while (this.collecting) await new Promise(resolve => setTimeout(resolve, 50));
  }
  stopTimer() {
    if (this.timer) clearInterval(this.timer);
  }
}
