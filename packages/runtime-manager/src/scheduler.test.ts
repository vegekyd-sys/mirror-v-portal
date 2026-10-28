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

test("a scheduled run manages its own chat's schedules without reaching another chat", async () => {
  const tenant = await store.createTenant(randomUUID(), "scheduled command");
  // A plain Feishu run: store.enqueue leaves chat_id NULL, so the chat can only
  // come from the session key.
  const human = await store.enqueue(
    tenant.id,
    randomUUID(),
    tenant.id + ":oc_abc",
    "versa-ai.com",
    "feishu",
  );
  await store.pool.query(
    "UPDATE elastic_runs SET status='succeeded' WHERE id=$1",
    [human.id],
  );
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const dayOne = await scheduler.command(human, randomUUID(), {
    action: "add",
    name: "day-1",
    schedule: { kind: "at", at: tomorrow },
    prompt: "Day 1",
  });
  const owner = (
    await store.pool.query(
      "SELECT chat_id,session_key FROM elastic_schedules WHERE id=$1",
      [dayOne.id],
    )
  ).rows[0];
  // Regression: a plain run still derives its chat from the session key.
  expect(owner.chat_id).toBe("oc_abc");
  expect(owner.session_key).toBe(tenant.id + ":oc_abc");

  // A second chat of the same tenant — the isolation probe.
  const elsewhere = await store.enqueue(
    tenant.id,
    randomUUID(),
    tenant.id + ":oc_other",
    "另一个会话",
    "feishu",
  );
  await store.pool.query(
    "UPDATE elastic_runs SET status='succeeded' WHERE id=$1",
    [elsewhere.id],
  );
  const foreign = await scheduler.command(elsewhere, randomUUID(), {
    action: "add",
    name: "other-chat",
    schedule: { kind: "every", everySeconds: 3600 },
    prompt: "other chat",
  });

  // What tick() hands a scheduled run: suffixed session key, correct chat_id.
  const scheduled: Run = {
    ...human,
    id: randomUUID(),
    session_key: `${tenant.id}:oc_abc:scheduled:${dayOne.id}`,
    chat_id: "oc_abc",
    schedule_id: dayOne.id,
    schedule_kind: "cron",
  };

  const dayTwo = await scheduler.command(scheduled, randomUUID(), {
    action: "add",
    name: "day-2",
    schedule: { kind: "at", at: tomorrow },
    prompt: "Day 2",
  });
  const renewed = (
    await store.pool.query(
      "SELECT chat_id,session_key FROM elastic_schedules WHERE id=$1",
      [dayTwo.id],
    )
  ).rows[0];
  // The real chat, not `oc_abc:scheduled:<uuid>`; and owned by the chat's own key,
  // so the next scheduled run finds it too.
  expect(renewed.chat_id).toBe("oc_abc");
  expect(renewed.session_key).toBe(tenant.id + ":oc_abc");

  const listed = await scheduler.command(scheduled, randomUUID(), {
    action: "list",
  });
  expect(listed.jobs.map((job: any) => job.name)).toEqual(["day-1", "day-2"]);
  expect(listed.jobs.some((job: any) => job.id === foreign.id)).toBe(false);

  // Isolation holds: another chat's schedule stays out of reach.
  await expect(
    scheduler.command(scheduled, randomUUID(), {
      action: "remove",
      id: foreign.id,
    }),
  ).rejects.toThrow("SCHEDULE_NOT_FOUND");

  // Self-cancellation inside the same chat is the point of the change.
  await scheduler.command(scheduled, randomUUID(), {
    action: "remove",
    id: dayOne.id,
  });
  expect(
    (
      await store.pool.query(
        "SELECT enabled FROM elastic_schedules WHERE id=$1",
        [dayOne.id],
      )
    ).rows[0].enabled,
  ).toBe(false);
});
