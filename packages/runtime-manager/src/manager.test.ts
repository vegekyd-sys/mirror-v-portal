import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { RuntimeManager } from "./manager.js";
import type { RuntimeProvider } from "./provider.js";
let s: Store, admin: pg.Pool;
const database = `nexus_test_${Date.now()}`;
beforeAll(async () => {
  const c = loadConfig();
  admin = new pg.Pool({ connectionString: c.databaseUrl });
  await admin.query(`CREATE DATABASE ${database}`);
  const u = new URL(c.databaseUrl);
  u.pathname = "/" + database;
  s = new Store({ ...c, databaseUrl: u.toString() });
  await s.init();
}, 30000);
afterAll(async () => {
  await s.close();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}, 30000);
const provider = (
  execute: RuntimeProvider["execute"] = async () => "ok",
  stop: RuntimeProvider["stop"] = async () => ({ stopped: true }),
) => ({
  ensure: async () => ({
    name: "test-" + randomUUID(),
    wakeMs: 1,
    reused: false,
  }),
  execute,
  stop,
});
async function tenant() {
  return s.createTenant(randomUUID(), "test");
}
test("deduplicates concurrent inbound deliveries", async () => {
  const t = await tenant();
  const [a, b] = await Promise.all([
    s.enqueue(t.id, "same", "session", "hi"),
    s.enqueue(t.id, "same", "session", "hi"),
  ]);
  expect(a.id).toBe(b.id);
});
test("serializes turns and does not release while tools run", async () => {
  const t = await tenant();
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r)),
    hold = new Promise<void>((r) => (release = r));
  let calls = 0,
    stops = 0;
  const m = new RuntimeManager(
    s,
    provider(
      async () => {
        calls++;
        started();
        await hold;
        return "ok";
      },
      async () => {
        stops++;
        return { stopped: true };
      },
    ),
  );
  const a = await s.enqueue(t.id, "a", "session", "a"),
    b = await s.enqueue(t.id, "b", "session", "b");
  const first = m.process(a.id);
  await began;
  await expect(m.process(b.id)).rejects.toThrow("AGENT_BUSY");
  await m.collect(t.id);
  expect(stops).toBe(0);
  release();
  await first;
  await m.process(b.id);
  expect(calls).toBe(2);
  expect((await s.run(b.id)).status).toBe("succeeded");
});
test("idle release preserves a message arriving during stop", async () => {
  const t = await tenant();
  await s.pool.query(
    "UPDATE elastic_tenants SET state='ready',last_activity=now()-interval '1 hour' WHERE id=$1",
    [t.id],
  );
  let runId = "";
  const m = new RuntimeManager(
    s,
    provider(undefined, async () => {
      runId = (await s.enqueue(t.id, "during-stop", "session", "wake")).id;
      return { stopped: true };
    }),
  );
  await m.collect(t.id);
  expect((await s.run(runId)).status).toBe("queued");
  await m.process(runId);
  expect((await s.run(runId)).status).toBe("succeeded");
});
test("does not replay a turn after ambiguous controller failure", async () => {
  const t = await tenant(),
    r = await s.enqueue(t.id, "crash", "session", "external action");
  await s.pool.query("UPDATE elastic_runs SET status='running' WHERE id=$1", [
    r.id,
  ]);
  let executions = 0;
  const m = new RuntimeManager(
    s,
    provider(async () => {
      executions++;
      return "ok";
    }),
  );
  await m.process(r.id);
  expect(executions).toBe(0);
  expect((await s.run(r.id)).status).toBe("uncertain");
});
test("background work defers release", async () => {
  const t = await tenant();
  await s.pool.query(
    "UPDATE elastic_tenants SET state='ready',last_activity=now()-interval '1 hour' WHERE id=$1",
    [t.id],
  );
  const m = new RuntimeManager(
    s,
    provider(undefined, async () => ({
      stopped: false,
      reason: "ACTIVE_BACKGROUND_WORK",
    })),
  );
  await m.collect(t.id);
  expect((await s.tenant(t.id)).state).toBe("ready");
});
test("credentials are encrypted with authenticated encryption", () => {
  const value = s.seal("test-secret");
  expect(value).not.toContain("test-secret");
  expect(s.unseal(value)).toBe("test-secret");
  const bytes = Buffer.from(value, "base64");
  bytes[15] ^= 1;
  expect(() => s.unseal(bytes.toString("base64"))).toThrow();
});
test("real queue drains concurrent messages in tenant order", async () => {
  const t = await tenant();
  let active = 0,
    max = 0;
  const seen: string[] = [];
  const m = new RuntimeManager(
    s,
    provider(async (_t, _session, text) => {
      if (_t.id !== t.id) return text;
      active++;
      max = Math.max(max, active);
      seen.push(text);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return text;
    }),
  );
  const runs = [];
  for (let i = 0; i < 5; i++)
    runs.push(await s.enqueue(t.id, "q" + i, "session", String(i)));
  await m.start();
  try {
    for (let i = 0; i < 200; i++) {
      if ((await s.run(runs[4].id)).status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await s.run(runs[4].id)).status).toBe("succeeded");
    expect(max).toBe(1);
    expect(seen).toEqual(["0", "1", "2", "3", "4"]);
  } finally {
    m.stopTimer();
  }
}, 25000);
