import { beforeAll, afterAll, test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store, type Run } from "./store.js";
import { loadConfig } from "./config.js";
import { Scheduler, nextDue } from "./scheduler.js";
let store: Store, admin: pg.Pool, scheduler: Scheduler, run: Run;
const database = `nexus_schedule_test_${Date.now()}`;
beforeAll(async () => {
  const c = loadConfig();
  admin = new pg.Pool({ connectionString: c.databaseUrl });
  await admin.query(`CREATE DATABASE ${database}`);
  const u = new URL(c.databaseUrl);
  u.pathname = "/" + database;
  store = new Store({ ...c, databaseUrl: u.toString() });
  await store.init();
  scheduler = new Scheduler(store);
  await scheduler.init();
  const tenant = await store.createTenant(randomUUID(), "test");
  run = await store.enqueue(
    tenant.id,
    randomUUID(),
    tenant.id + ":oc_test",
    "test",
    "feishu",
    "msg_test",
  );
  await store.pool.query(
    "UPDATE elastic_runs SET status='succeeded' WHERE id=$1",
    [run.id],
  );
}, 30000);
afterAll(async () => {
  await store.close();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}, 30000);
test("cron timezone and interval validation", () => {
  expect(
    nextDue(
      { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
      new Date("2026-09-14T00:30:00Z"),
    ).toISOString(),
  ).toBe("2026-09-14T01:00:00.000Z");
  expect(() => nextDue({ kind: "every", everySeconds: 1 })).toThrow();
  expect(() => nextDue({ kind: "at", at: "invalid" })).toThrow();
});
test("durable idempotent commands, tenant isolation, cancel", async () => {
  const id = randomUUID(),
    args = {
      action: "add",
      name: "cancel-test",
      schedule: { kind: "every", everySeconds: 60 },
      prompt: "check",
    };
  const a = await scheduler.command(run, id, args);
  expect(await scheduler.command(run, id, args)).toEqual(a);
  expect(
    (await scheduler.command(run, randomUUID(), { action: "list" })).jobs
      .length,
  ).toBe(1);
  await expect(
    scheduler.command({ ...run, tenant_id: "other" }, randomUUID(), {
      action: "remove",
      id: a.id,
    }),
  ).rejects.toThrow("SCHEDULE_NOT_FOUND");
  await scheduler.command(run, randomUUID(), { action: "remove", id: a.id });
  expect(
    (
      await store.pool.query(
        "SELECT enabled FROM elastic_schedules WHERE id=$1",
        [a.id],
      )
    ).rows[0].enabled,
  ).toBe(false);
});
test("concurrent schedulers dispatch one durable turn and coalesce missed heartbeat", async () => {
  const a = await scheduler.command(run, randomUUID(), {
    action: "add",
    kind: "heartbeat",
    schedule: { kind: "every", everySeconds: 60 },
  });
  await store.pool.query(
    "UPDATE elastic_schedules SET next_at=now()-interval '10 minutes' WHERE id=$1",
    [a.id],
  );
  await Promise.all([scheduler.tick(), new Scheduler(store).tick()]);
  let rows = (
    await store.pool.query("SELECT * FROM elastic_runs WHERE schedule_id=$1", [
      a.id,
    ])
  ).rows;
  expect(rows.length).toBe(1);
  expect(rows[0].chat_id).toBe("oc_test");
  expect(rows[0].schedule_kind).toBe("heartbeat");
  await store.pool.query(
    "UPDATE elastic_schedules SET next_at=now()-interval '1 minute' WHERE id=$1",
    [a.id],
  );
  await scheduler.tick();
  expect(
    (
      await store.pool.query(
        "SELECT 1 FROM elastic_runs WHERE schedule_id=$1",
        [a.id],
      )
    ).rowCount,
  ).toBe(1);
  await store.pool.query(
    "UPDATE elastic_runs SET status='succeeded' WHERE id=$1",
    [rows[0].id],
  );
  await scheduler.command(run, randomUUID(), { action: "remove", id: a.id });
});
test("one-shot disables after durable enqueue and survives scheduler recreation", async () => {
  const a = await scheduler.command(run, randomUUID(), {
    action: "add",
    schedule: { kind: "at", at: new Date(Date.now() + 60000).toISOString() },
    prompt: "once",
  });
  await store.pool.query(
    "UPDATE elastic_schedules SET next_at=now()-interval '1 second' WHERE id=$1",
    [a.id],
  );
  await new Scheduler(store).tick();
  await scheduler.tick();
  expect(
    (
      await store.pool.query(
        "SELECT 1 FROM elastic_runs WHERE schedule_id=$1",
        [a.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await store.pool.query(
        "SELECT enabled FROM elastic_schedules WHERE id=$1",
        [a.id],
      )
    ).rows[0].enabled,
  ).toBe(false);
});

test("blocked tenant retains due work; cancellation stops queued work", async () => {
  const t = await store.createTenant(randomUUID(), "blocked test");
  const run = await store.enqueue(
    t.id,
    randomUUID(),
    t.id + ":oc_test",
    "test",
  );
  await store.pool.query(
    "UPDATE elastic_runs SET status='succeeded' WHERE id=$1",
    [run.id],
  );
  const job = await scheduler.command(run, randomUUID(), {
    action: "add",
    schedule: { kind: "every", everySeconds: 60 },
    prompt: "blocked check",
  });
  await store.pool.query(
    "UPDATE elastic_schedules SET next_at=now()-interval '1 minute' WHERE id=$1",
    [job.id],
  );
  await store.pool.query(
    "UPDATE elastic_tenants SET state='blocked' WHERE id=$1",
    [run.tenant_id],
  );
  await scheduler.tick();
  expect(
    (
      await store.pool.query(
        "SELECT 1 FROM elastic_runs WHERE schedule_id=$1",
        [job.id],
      )
    ).rowCount,
  ).toBe(0);
  await store.pool.query(
    "UPDATE elastic_tenants SET state='ready' WHERE id=$1",
    [run.tenant_id],
  );
  await scheduler.tick();
  const queued = (
    await store.pool.query("SELECT * FROM elastic_runs WHERE schedule_id=$1", [
      job.id,
    ])
  ).rows[0];
  expect(queued.status).toBe("queued");
  expect(queued.session_key).toBe(run.session_key + ":scheduled:" + job.id);
  const cancelled = await scheduler.command(run, randomUUID(), {
    action: "remove",
    id: job.id,
  });
  expect(cancelled.cancelledQueued).toBe(1);
  expect((await store.run(queued.id)).error).toBe("SCHEDULE_CANCELLED");
});
