import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 测试期只读调试接口回归：
 *   · 顶层按表名分组，`_meta` 汇总计数；
 *   · 凭据字段固定脱敏；
 *   · tables / limit 过滤生效，非法表名拒绝。
 */

type Delegate = { findMany: (args?: unknown) => Promise<unknown[]> };

const names = [
  "customer",
  "conversation",
  "message",
  "webhookEvent",
  "platformThread",
  "wabaPhone",
  "wabaOnboarding",
  "feishuApp",
  "appSetting",
] as const;

type Name = (typeof names)[number];

const rows: Record<Name, unknown[]> = {
  customer: [{ id: "cus_1", phoneNumber: "8613800000000", supplierId: "tenant-a" }],
  conversation: [{ id: "con_1", supplierId: "tenant-a" }],
  message: [{ id: "msg_1", conversationId: "con_1", content: "hi" }],
  webhookEvent: [{ id: "evt_1", eventType: "message.inbound" }],
  platformThread: [{ id: "thr_1", conversationId: "con_1" }],
  wabaPhone: [{ id: "wph_1", phoneNumber: "8613800000000", supplierId: "tenant-a" }],
  wabaOnboarding: [
    { id: "wob_1", partnerCustomerId: "tenant-a", onboardingUrl: "https://mio.example.test/abc" },
  ],
  feishuApp: [
    {
      appId: "cli_test",
      appSecret: "super-secret",
      verificationToken: "vt",
      encryptKey: "ek",
      csChatId: "oc_x",
    },
  ],
  appSetting: [{ key: "cs_chat:cli_test", value: "oc_x" }],
};

describe("debug table list endpoint", { concurrency: false }, () => {
  const db = prisma as unknown as Record<Name, Delegate>;
  const originals = Object.fromEntries(names.map((n) => [n, db[n].findMany])) as Record<
    Name,
    Delegate["findMany"]
  >;
  const calls: Array<{ table: Name; args: unknown }> = [];

  before(() => {
    for (const name of names) {
      db[name].findMany = async (args?: unknown) => {
        calls.push({ table: name, args });
        return rows[name];
      };
    }
  });

  after(() => {
    for (const name of names) db[name].findMany = originals[name];
  });

  async function get(url: string) {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url });
    await app.close();
    return response;
  }

  it("groups every table under its own top-level key", async () => {
    calls.length = 0;
    const response = await get(`${config.routePrefix}/api/admin/whatsapp/debugTableList`);
    assert.equal(response.statusCode, 200);
    const body = response.json();

    assert.equal(body._meta.ok, true);
    assert.equal(body._meta.tableCount, 9);
    assert.equal(body._meta.rowCount, 9);
    assert.equal(body._meta.counts.Message, 1);
    assert.deepEqual(body.Customer, rows.customer);
    assert.deepEqual(body.Conversation, rows.conversation);
    assert.deepEqual(body.AppSetting, rows.appSetting);
    assert.equal(calls.length, 9);
  });

  it("redacts credential fields but keeps the rest of the row", async () => {
    const response = await get(`${config.routePrefix}/api/admin/whatsapp/debugTableList`);
    const body = response.json();
    const app = body.FeishuApp[0];
    assert.equal(app.appId, "cli_test");
    assert.equal(app.csChatId, "oc_x");
    assert.equal(app.appSecret, "[redacted]");
    assert.equal(app.verificationToken, "[redacted]");
    assert.equal(app.encryptKey, "[redacted]");
    assert.equal(body.WabaOnboarding[0].onboardingUrl, "[redacted]");
  });

  it("supports table and limit filters", async () => {
    calls.length = 0;
    const response = await get(
      `${config.routePrefix}/api/admin/whatsapp/debugTableList?tables=Customer,Message&limit=5`,
    );
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(Object.keys(body).filter((k) => k !== "_meta"), ["Customer", "Message"]);
    assert.equal(body._meta.tableCount, 2);
    assert.equal(body._meta.limit, 5);
    for (const call of calls) {
      assert.equal((call.args as { take?: number }).take, 5);
    }
  });

  it("rejects unknown table names", async () => {
    const response = await get(
      `${config.routePrefix}/api/admin/whatsapp/debugTableList?tables=Customer,Nope`,
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "DEBUG_INVALID_INPUT");
  });
});
