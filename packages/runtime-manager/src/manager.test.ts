import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { RuntimeManager } from "./manager.js";
import type { RuntimeProvider } from "./provider.js";
import type { InboundAttachment } from "./inbound-media.js";
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
  execute: RuntimeProvider["execute"] = async () => ({ output: "ok", media: [] }),
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
const imageReceipt = (tenantId: string, marker = "a"): InboundAttachment => ({
  kind: "image", mimeType: "image/jpeg", bytes: 123,
  sha256: marker.repeat(64),
  storagePath: `inbound/${tenantId}/${"b".repeat(64)}/${marker.repeat(64)}.jpg`,
});
test("persists image-only receipts and never rewrites or replays duplicate completed messages", async () => {
  const t = await tenant(), image = imageReceipt(t.id);
  const [a,b] = await Promise.all([
    s.enqueue(t.id,"photo-wire-id","chat","","weixin","wire-id",[image]),
    s.enqueue(t.id,"photo-wire-id","chat","","weixin","wire-id",[image]),
  ]);
  expect(a.id).toBe(b.id);
  expect((await s.run(a.id)).attachments).toEqual([image]);
  let executions = 0;
  const m = new RuntimeManager(s,provider(async (_t,_session,_text,_emit,context) => {
    executions++; expect(context?.attachments).toEqual([image]);
    return {output:"received",media:[]};
  }));
  await m.process(a.id);
  const duplicate = await s.enqueue(t.id,"photo-wire-id","chat","changed","weixin","wire-id",[imageReceipt(t.id,"c")],{inheritAttachments:false});
  expect(duplicate.status).toBe("succeeded");
  expect(duplicate.text).toBe("");
  expect(duplicate.attachments).toEqual([image]);
  expect(duplicate.inherit_attachments).toBe(true);
  await m.process(duplicate.id);
  expect(executions).toBe(1);
});
test("inherits images only within the exact tenant, session and channel using PostgreSQL timestamp precision", async () => {
  const t = await tenant(), other = await tenant(), image = imageReceipt(t.id);
  const received = await s.enqueue(t.id,"image","chat","","weixin",undefined,[image]);
  await s.pool.query("UPDATE elastic_runs SET status='succeeded',created_at='2026-10-03 00:00:00.000123+00' WHERE id=$1",[received.id]);
  const followup = await s.enqueue(t.id,"caption","chat","用上一张照片","weixin");
  await s.pool.query("UPDATE elastic_runs SET created_at='2026-10-03 00:00:00.000789+00' WHERE id=$1",[followup.id]);
  expect(await s.previousAttachments(await s.run(followup.id))).toEqual([image]);
  for (const [owner,session,channel,key] of [
    [other.id,"chat","weixin","other-tenant"],
    [t.id,"different-chat","weixin","other-session"],
    [t.id,"chat","web","other-channel"],
  ]) {
    const isolated = await s.enqueue(owner,key,session,"text",channel);
    expect(await s.previousAttachments(isolated)).toEqual([]);
  }
});
test("failed new-image reception blocks the old image on that turn and later captions", async () => {
  const t = await tenant(), image = imageReceipt(t.id);
  const contexts: unknown[] = [];
  const m = new RuntimeManager(s,provider(async (_t,_session,_text,_emit,context) => {
    contexts.push(context);return {output:"ok",media:[]};
  }));
  const received = await s.enqueue(t.id,"photo-a","chat","","weixin",undefined,[image]);
  await m.process(received.id);
  const firstCaption = await s.enqueue(t.id,"caption-a","chat","处理上一张","weixin");
  await m.process(firstCaption.id);
  expect(contexts[1]).toMatchObject({attachments:[image],attachmentsFromPreviousTurn:true});
  const failed = await s.enqueue(t.id,"photo-b-failed","chat","图片接收失败，请重发","weixin",undefined,[],{inheritAttachments:false});
  await m.process(failed.id);
  expect(contexts[2]).toMatchObject({attachments:[],attachmentsFromPreviousTurn:false});
  const laterCaption = await s.enqueue(t.id,"caption-b","chat","把这张图改成贴纸","weixin");
  expect(await s.previousAttachments(laterCaption)).toEqual([]);
  await m.process(laterCaption.id);
  expect(contexts[3]).toMatchObject({attachments:[],attachmentsFromPreviousTurn:false});
  const newPhoto = await s.enqueue(t.id,"photo-c","chat","","weixin",undefined,[imageReceipt(t.id,"c")]);
  await m.process(newPhoto.id);
  const newCaption = await s.enqueue(t.id,"caption-c","chat","处理新的图","weixin");
  expect(await s.previousAttachments(newCaption)).toEqual([imageReceipt(t.id,"c")]);
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
        return { output: "ok", media: [] };
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
      return { output: "ok", media: [] };
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
test("tenant secrets are sealed at rest, replaced as a set, and reach ensure", async () => {
  const t = await tenant();
  await s.setTenantSecrets(t.id, { XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw-1" });
  const raw = await s.pool.query("SELECT value FROM elastic_tenant_secrets WHERE tenant_id=$1", [t.id]);
  expect(raw.rows.map((row) => row.value).join()).not.toContain("pw-1");
  await s.setTenantSecrets(t.id, { XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw-2" });
  expect(await s.tenantSecretEnv(t.id)).toEqual({ XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw-2" });
  expect((await s.tenantSecretStatus(t.id)).names).toEqual(["XINGQING_PASSWORD", "XINGQING_USERNAME"]);
  let seen: Record<string, string> | undefined;
  const m = new RuntimeManager(s, {
    ...provider(),
    ensure: async (booted) => { seen = booted.runtime_env; return { name: "test-" + randomUUID(), wakeMs: 1, reused: false }; },
  });
  const run = await s.enqueue(t.id, "secret-run", "main", "hello");
  await m.process(run.id);
  expect(seen).toEqual({ XINGQING_USERNAME: "acme", XINGQING_PASSWORD: "pw-2" });
  await s.setTenantSecrets(t.id, {});
  expect(await s.tenantSecretEnv(t.id)).toEqual({});
});
test("real queue drains concurrent messages in tenant order", async () => {
  const t = await tenant();
  let active = 0,
    max = 0;
  const seen: string[] = [];
  const m = new RuntimeManager(
    s,
    provider(async (_t, _session, text) => {
      if (_t.id !== t.id) return { output: text, media: [] };
      active++;
      max = Math.max(max, active);
      seen.push(text);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return { output: text, media: [] };
    }),
  );
  const runs = [];
  for (let i = 0; i < 5; i++)
    runs.push(await s.enqueue(t.id, "q" + i, "session", String(i)));
  await m.start();
  try {
    // Waits on the whole batch reaching a terminal state, not just the last row:
    // under a full-suite run this shares postgres with other files and the
    // queue drains slower than a fixed poll count assumed. On timeout the
    // actual statuses are surfaced so a real regression is not read as flake.
    const deadline = Date.now() + 40_000;
    let statuses: string[] = [];
    while (Date.now() < deadline) {
      statuses = await Promise.all(runs.map(async (r) => (await s.run(r.id)).status));
      if (statuses.every((st) => st === "succeeded" || st === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(statuses, `runs did not drain in time: ${statuses.join(",")}`).toEqual(
      ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"],
    );
    expect(max).toBe(1);
    expect(seen).toEqual(["0", "1", "2", "3", "4"]);
  } finally {
    m.stopTimer();
  }
}, 60000);
test("queued message recovers interrupted idle release without being marked uncertain",async()=>{
 const t=await tenant(),r=await s.enqueue(t.id,'idle-crash','session','hihi');
 await s.pool.query("UPDATE elastic_tenants SET state='quiescing' WHERE id=$1",[t.id]);
 let stops=0,executions=0;
 const m=new RuntimeManager(s,provider(async()=>{executions++;return {output:'hi',media:[]};},async()=>{stops++;return {stopped:true};}));
 await m.process(r.id);
 expect(stops).toBe(1);expect(executions).toBe(1);
 expect((await s.run(r.id)).status).toBe('succeeded');
});
test("shutdown waits for an in-flight idle release before closing storage",async()=>{
 const t=await tenant();
 await s.pool.query("UPDATE elastic_tenants SET state='ready',last_activity=now()-interval '1 hour' WHERE id=$1",[t.id]);
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 const m=new RuntimeManager(s,provider(undefined,async()=>{entered();await gate;return {stopped:true};}));
 const collecting=m.collect(t.id);await started;
 let drained=false;const draining=m.drainCollector().then(()=>{drained=true;});
 await new Promise(r=>setTimeout(r,20));expect(drained).toBe(false);
 release();await collecting;await draining;
 expect((await s.tenant(t.id)).state).toBe('sleeping');
});
