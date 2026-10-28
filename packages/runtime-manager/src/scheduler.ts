import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Store, Run } from "./store.js";
import type { SystemSchedule } from "./config.js";
export function nextDue(spec: any, from = new Date()): Date {
  if (spec.kind === "at") {
    const d = new Date(spec.at);
    if (!Number.isFinite(+d) || +d <= +from)
      throw Error("AT_MUST_BE_FUTURE_ISO_DATE");
    return d;
  }
  if (spec.kind === "every") {
    if (
      !Number.isInteger(spec.everySeconds) ||
      spec.everySeconds < 60 ||
      spec.everySeconds > 31536000
    )
      throw Error("INTERVAL_MUST_BE_60_TO_31536000_SECONDS");
    return new Date(+from + spec.everySeconds * 1000);
  }
  if (spec.kind === "cron") {
    if (
      typeof spec.expr !== "string" ||
      spec.expr.trim().split(/\s+/).length !== 5
    )
      throw Error("CRON_REQUIRES_FIVE_FIELDS");
    return CronExpressionParser.parse(spec.expr, {
      currentDate: from,
      tz: spec.tz || "Asia/Shanghai",
    })
      .next()
      .toDate();
  }
  throw Error("INVALID_SCHEDULE");
}
/**
 * The owning session key of a schedule row. tick() gives a scheduled run the
 * session key `${schedule.session_key}:scheduled:${schedule.id}`, while the row
 * itself stores the unsuffixed key. Without stripping, list/status (session_key=$2)
 * and remove/update (session_key=$3) issued from inside a scheduled run match no
 * row at all: a scheduled task can neither renew nor cancel itself, so a multi-day
 * script has to be created once up front and can never be adjusted afterwards.
 *
 * Isolation change, accepted deliberately: once the suffix is stripped, a scheduled
 * run can see and remove the other schedules of the same chat. That is exactly what
 * self-renewal and self-cancellation need, and it crosses neither tenant (queries
 * still carry tenant_id) nor chat (the key still carries the chat).
 */
const SCHEDULED_RUN_SUFFIX = /:scheduled:[0-9a-f-]{36}$/;
export function baseSessionKey(sessionKey: string): string {
  return sessionKey.replace(SCHEDULED_RUN_SUFFIX, "");
}
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(readonly store: Store) {}
  async init() {
    await this.store.pool.query(`
    CREATE TABLE IF NOT EXISTS elastic_schedules (
      id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES elastic_tenants(id), session_key text NOT NULL,
      name text NOT NULL, kind text NOT NULL CHECK(kind IN ('cron','heartbeat')), spec jsonb NOT NULL,
      prompt text NOT NULL, enabled boolean NOT NULL DEFAULT true, next_at timestamptz NOT NULL,
      chat_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS elastic_schedules_due ON elastic_schedules(next_at) WHERE enabled;
    CREATE TABLE IF NOT EXISTS elastic_schedule_commands (id uuid PRIMARY KEY, tenant_id text NOT NULL, result jsonb NOT NULL);
    ALTER TABLE elastic_runs ADD COLUMN IF NOT EXISTS schedule_id uuid;
    ALTER TABLE elastic_runs ADD COLUMN IF NOT EXISTS schedule_kind text;
    ALTER TABLE elastic_runs ADD COLUMN IF NOT EXISTS chat_id text;
  `);
  }
  start() {
    this.timer = setInterval(() => {
      if (!this.active)
        this.active = this.tick()
          .catch((e) => console.error("[scheduler]", e.message))
          .finally(() => {
            this.active = undefined;
          });
    }, 1000);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async command(run: Run, requestId: string, args: any) {
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw Error("INVALID_COMMAND_ID");
    const db = await this.store.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
      const prior = await db.query(
        "SELECT result FROM elastic_schedule_commands WHERE id=$1 AND tenant_id=$2",
        [requestId, run.tenant_id],
      );
      if (prior.rowCount) {
        await db.query("COMMIT");
        return prior.rows[0].result;
      }
      // The schedules this run owns; a scheduled run must drop its `:scheduled:<uuid>`
      // suffix to find its own group.
      const sessionKey = baseSessionKey(run.session_key);
      // Prefer the run's own chat_id. A plain Feishu run goes through store.enqueue,
      // which never writes that column (NULL), so it falls back to the chat sliced out
      // of the session key; a scheduled run gets a correct chat_id from tick()'s INSERT.
      // The slice must use the stripped key — slicing the raw one yields the broken
      // `oc_xxx:scheduled:<uuid>`, and a schedule created with it would address a chat
      // that does not exist.
      const chat = run.chat_id
        || (sessionKey.startsWith(run.tenant_id + ":oc_") ? sessionKey.slice(run.tenant_id.length + 1) : undefined);
      let result: any;
      if (args.action === "list" || args.action === "status")
        result = {
          jobs: (
            await db.query(
              "SELECT id,name,kind,spec,prompt,enabled,next_at FROM elastic_schedules WHERE tenant_id=$1 AND session_key=$2 ORDER BY created_at",
              [run.tenant_id, sessionKey],
            )
          ).rows,
        };
      else if (args.action === "add") {
        if (!chat) throw Error("CREATE_SCHEDULE_FROM_FEISHU_CHAT");
        if (
          (
            await db.query(
              "SELECT 1 FROM elastic_schedules WHERE tenant_id=$1 AND enabled",
              [run.tenant_id],
            )
          ).rowCount! >= 100
        )
          throw Error("SCHEDULE_LIMIT_100");
        const kind = args.kind === "heartbeat" ? "heartbeat" : "cron";
        const spec =
          args.schedule ||
          (kind === "heartbeat" ? { kind: "every", everySeconds: 1800 } : null);
        const next = nextDue(spec);
        const prompt = String(
          args.prompt ||
            (kind === "heartbeat"
              ? "检查工作目录 HEARTBEAT.md 中当前到期的事项。静默结果：HEARTBEAT_OK。"
              : ""),
        );
        if (!prompt.trim() || prompt.length > 16000)
          throw Error("INVALID_PROMPT");
        const name = String(args.name || kind).slice(0, 120);
        const id = randomUUID();
        await db.query(
          "INSERT INTO elastic_schedules(id,tenant_id,session_key,name,kind,spec,prompt,next_at,chat_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            run.tenant_id,
            sessionKey,
            name,
            kind,
            spec,
            prompt,
            next,
            chat,
          ],
        );
        result = { id, name, kind, nextAt: next.toISOString(), durable: true };
      } else if (["remove", "update"].includes(args.action)) {
        const old = (
          await db.query(
            "SELECT * FROM elastic_schedules WHERE id=$1 AND tenant_id=$2 AND session_key=$3 FOR UPDATE",
            [args.id, run.tenant_id, sessionKey],
          )
        ).rows[0];
        if (!old) throw Error("SCHEDULE_NOT_FOUND");
        if (args.action === "remove") {
          await db.query(
            "UPDATE elastic_schedules SET enabled=false,updated_at=now() WHERE id=$1",
            [old.id],
          );
          result = { id: old.id, enabled: false };
        } else {
          const spec = args.schedule || old.spec;
          const next = nextDue(spec);
          const prompt = String(args.prompt ?? old.prompt);
          if (!prompt.trim() || prompt.length > 16000)
            throw Error("INVALID_PROMPT");
          await db.query(
            "UPDATE elastic_schedules SET spec=$2,prompt=$3,enabled=$4,next_at=$5,updated_at=now() WHERE id=$1",
            [old.id, spec, prompt, args.enabled ?? old.enabled, next],
          );
          result = {
            id: old.id,
            nextAt: next.toISOString(),
            enabled: args.enabled ?? old.enabled,
          };
        }
        if (args.action === "remove" || args.enabled === false) {
          const cancelled = await db.query(
            "UPDATE elastic_runs SET status='failed',error='SCHEDULE_CANCELLED',completed_at=now() WHERE schedule_id=$1 AND status='queued' RETURNING id",
            [old.id],
          );
          result.cancelledQueued = cancelled.rowCount;
        }
      } else throw Error("INVALID_ACTION");
      await db.query(
        "INSERT INTO elastic_schedule_commands(id,tenant_id,result) VALUES($1,$2,$3)",
        [requestId, run.tenant_id, result],
      );
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  /**
   * Register a template's background loops into the chat of a successful user
   * turn. Idempotent by name, including disabled rows, so an owner's removal sticks.
   */
  async ensureSystemSchedules(run: Run, schedules: SystemSchedule[] | undefined): Promise<string[]> {
    if (!schedules?.length || run.schedule_id) return [];
    const chat = run.session_key.startsWith(run.tenant_id + ":oc_") ? run.session_key.slice(run.tenant_id.length + 1) : run.chat_id;
    if (!chat) return [];
    const added: string[] = [];
    for (const item of schedules) {
      const name = String(item.name).slice(0, 120);
      if (!name || typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 16000) throw Error("INVALID_SYSTEM_SCHEDULE");
      const next = nextDue(item.schedule);
      const inserted = await this.store.pool.query(
        `INSERT INTO elastic_schedules(id,tenant_id,session_key,name,kind,spec,prompt,next_at,chat_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE NOT EXISTS (SELECT 1 FROM elastic_schedules WHERE tenant_id=$2 AND name=$4)`,
        [randomUUID(), run.tenant_id, run.session_key, name, item.kind === "heartbeat" ? "heartbeat" : "cron", item.schedule, item.prompt, next, chat],
      );
      if (inserted.rowCount) added.push(name);
    }
    return added;
  }
  async tick() {
    const db = await this.store.pool.connect();
    try {
      await db.query("BEGIN");
      const jobs = (
        await db.query(
          `SELECT j.* FROM elastic_schedules j WHERE enabled AND next_at<=now() AND EXISTS (SELECT 1 FROM elastic_tenants t WHERE t.id=j.tenant_id AND t.state <> 'blocked') ORDER BY next_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
        )
      ).rows;
      for (const j of jobs) {
        // Coalesce missed intervals and never overlap scheduled work for one Agent.
        if (
          (
            await db.query(
              "SELECT 1 FROM elastic_runs WHERE tenant_id=$1 AND schedule_id IS NOT NULL AND status IN ('queued','running')",
              [j.tenant_id],
            )
          ).rowCount
        )
          continue;
        const id = randomUUID(),
          key = `schedule:${j.id}:${new Date(j.next_at).toISOString()}`;
        const prefix =
          j.kind === "heartbeat"
            ? "[Portal heartbeat trigger; quiet_reply=HEARTBEAT_OK]"
            : "[Portal scheduled task trigger]";
        const r = await db.query(
          `INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,schedule_id,schedule_kind,chat_id) VALUES($1,$2,$3,$4,$5,'feishu',$6,$7,$8) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING id`,
          [
            id,
            j.tenant_id,
            key,
            `${j.session_key}:scheduled:${j.id}`,
            `${prefix}\n${j.prompt}`,
            j.id,
            j.kind,
            j.chat_id,
          ],
        );
        if (r.rowCount) {
          await this.store.boss.send(
            "agent-turn",
            { runId: id },
            {
              db: { executeSql: (sql, v) => db.query(sql, v) },
              group: { id: j.tenant_id },
            },
          );
          await db.query(
            "UPDATE elastic_tenants SET last_activity=now() WHERE id=$1",
            [j.tenant_id],
          );
        }
        if (j.spec.kind === "at")
          await db.query(
            "UPDATE elastic_schedules SET enabled=false,updated_at=now() WHERE id=$1",
            [j.id],
          );
        else
          await db.query(
            "UPDATE elastic_schedules SET next_at=$2,updated_at=now() WHERE id=$1",
            [j.id, nextDue(j.spec)],
          );
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
}
