import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 测试期清库接口回归（测试阶段口径：无请求侧校验，调用即执行）。
 *   · 应急开关打开时 403，且不泄露计数；
 *   · 空 body 直接真删，且保留 FeishuApp/AppSetting；
 *   · dryRun:true 只要预览，不删；
 *   · supplierId 只删该租户的行，并按 FK 安全顺序；
 *   · includeConfig 只能做全局清理。
 */

type Delegate = {
  count: (args?: unknown) => Promise<number>;
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
  findMany?: (args?: unknown) => Promise<unknown[]>;
};

type MutablePrisma = {
  $transaction: (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
  message: Delegate;
  platformThread: Delegate;
  conversation: Delegate;
  customer: Delegate;
  webhookEvent: Delegate;
  wabaPhone: Delegate;
  wabaOnboarding: Delegate;
  feishuApp: Delegate;
  appSetting: Delegate;
};

const names = [
  "message",
  "platformThread",
  "conversation",
  "customer",
  "webhookEvent",
  "wabaPhone",
  "wabaOnboarding",
  "feishuApp",
  "appSetting",
] as const;

type Name = (typeof names)[number];

describe("WhatsApp DB cleanup admin endpoint", { concurrency: false }, () => {
  const db = prisma as unknown as MutablePrisma;
  const originals = {
    transaction: db.$transaction,
    delegates: Object.fromEntries(
      names.map((name) => [name, { count: db[name].count, deleteMany: db[name].deleteMany }]),
    ) as Record<Name, Delegate>,
    disabled: config.admin.dbCleanupDisabled,
    wabaOnboardingFindMany: db.wabaOnboarding.findMany,
  };

  const counts: Record<Name, number> = {
    message: 11,
    platformThread: 7,
    conversation: 6,
    customer: 5,
    webhookEvent: 4,
    wabaPhone: 3,
    wabaOnboarding: 2,
    feishuApp: 1,
    appSetting: 1,
  };
  const calls: Array<{ op: "count" | "delete" | "find"; table: Name; args: unknown }> = [];

  before(() => {
    for (const name of names) {
      db[name].count = async (args?: unknown) => {
        calls.push({ op: "count", table: name, args });
        return counts[name];
      };
      db[name].deleteMany = async (args?: unknown) => {
        calls.push({ op: "delete", table: name, args });
        return { count: counts[name] };
      };
    }
    db.$transaction = async (callback, options) => {
      assert.deepEqual(options, { isolationLevel: "Serializable" });
      return callback(db);
    };
    // 回滚后 WabaPhone 没有 supplierId：按租户清理要先解析该租户名下的 WABA。
    db.wabaOnboarding.findMany = async (args?: unknown) => {
      calls.push({ op: "find", table: "wabaOnboarding", args });
      return [{ wabaId: "waba-a" }];
    };
  });

  beforeEach(() => {
    calls.length = 0;
    config.admin.dbCleanupDisabled = false;
  });

  after(() => {
    db.$transaction = originals.transaction;
    for (const name of names) {
      db[name].count = originals.delegates[name].count;
      db[name].deleteMany = originals.delegates[name].deleteMany;
    }
    config.admin.dbCleanupDisabled = originals.disabled;
    db.wabaOnboarding.findMany = originals.wabaOnboardingFindMany;
  });

  async function post(payload?: Record<string, unknown>) {
    const app = await buildServer();
    const request =
      payload === undefined
        ? { method: "POST" as const, url: `${config.routePrefix}/api/admin/whatsapp/debugCleanup` }
        : {
            method: "POST" as const,
            url: `${config.routePrefix}/api/admin/whatsapp/debugCleanup`,
            payload,
          };
    const response = await app.inject(request);
    await app.close();
    return response;
  }

  it("cleans everything with a bare POST and no token", async () => {
    const response = await post();
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dryRun, false);
    assert.deepEqual(body.scope, { all: true });
    assert.equal(body.deleted.messages, 11);
    assert.equal(body.deleted.conversations, 6);
    assert.equal(body.deleted.customers, 5);
    assert.equal(body.deleted.feishuApps, 0, "credentials stay by default");
    assert.equal(body.deleted.appSettings, 0, "global settings stay by default");

    const deleted = calls.filter((call) => call.op === "delete");
    assert.deepEqual(
      deleted.map((call) => call.table),
      [
        "message",
        "platformThread",
        "conversation",
        "customer",
        "webhookEvent",
        "wabaPhone",
        "wabaOnboarding",
      ],
      "message/thread must be deleted before conversation/customer",
    );
    assert.deepEqual(deleted[0].args, { where: {} });
  });

  it("stays off while the emergency kill switch is on", async () => {
    config.admin.dbCleanupDisabled = true;
    const response = await post({});
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "CLEANUP_DISABLED");
    assert.equal(calls.length, 0, "disabled endpoint must not disclose counts");
  });

  it("previews without deleting when dryRun is true", async () => {
    const response = await post({ dryRun: true });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.scope, { all: true });
    assert.equal(body.wouldDelete.messages, 11);
    assert.equal(body.wouldDelete.feishuApps, 0);
    assert.equal(calls.some((call) => call.op === "delete"), false);
  });

  it("deletes one supplier in FK-safe order", async () => {
    const response = await post({ supplierId: "tenant-a" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dryRun, false);
    assert.deepEqual(body.scope, { supplierId: "tenant-a" });
    assert.equal(body.deleted.messages, 11);
    assert.equal(body.deleted.feishuApps, 0);

    const deleted = calls.filter((call) => call.op === "delete");
    assert.deepEqual(deleted[0].args, { where: { supplierId: "tenant-a" } });
    assert.deepEqual(deleted[1].args, { where: { conversation: { supplierId: "tenant-a" } } });
    assert.deepEqual(deleted[5].args, { where: { wabaId: { in: ["waba-a"] } } });
    assert.deepEqual(deleted[6].args, { where: { partnerCustomerId: "tenant-a" } });
  });

  it("only clears credentials/settings in a global run", async () => {
    const scoped = await post({ supplierId: "tenant-a", includeConfig: true });
    assert.equal(scoped.statusCode, 400);
    assert.equal(scoped.json().code, "CLEANUP_CONFIG_REQUIRES_GLOBAL");

    const full = await post({ includeConfig: true });
    assert.equal(full.statusCode, 200);
    assert.equal(full.json().deleted.feishuApps, 1);
    assert.equal(full.json().deleted.appSettings, 1);
  });

  it("rejects supplierId that is not a tenant identifier", async () => {
    const response = await post({ supplierId: "tenant a!" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "CLEANUP_INVALID_INPUT");
    assert.equal(calls.length, 0);
  });
});
