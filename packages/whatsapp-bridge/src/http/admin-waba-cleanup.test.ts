import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { CLEANUP_CONFIRM, CLEANUP_WITH_CONFIG_CONFIRM } from "../core/adminWabaCleanup";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 测试期清库接口的安全回归：
 *   · 环境开关 + 独立 token 不满足，连 dry-run 计数都不能泄露；
 *   · 默认 dryRun（不删）；真删要求确认串；
 *   · supplierId 只删该租户的行；
 *   · FeishuApp/AppSetting 默认保留，includeConfig 只能做全局清理且确认串更强。
 */

type Delegate = {
  count: (args?: unknown) => Promise<number>;
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
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

const TOKEN = "test-cleanup-token";
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
    allow: config.admin.allowDbCleanup,
    token: config.admin.cleanupToken,
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
  const calls: Array<{ op: "count" | "delete"; table: Name; args: unknown }> = [];

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
  });

  beforeEach(() => {
    calls.length = 0;
    config.admin.allowDbCleanup = true;
    config.admin.cleanupToken = TOKEN;
  });

  after(() => {
    db.$transaction = originals.transaction;
    for (const name of names) {
      db[name].count = originals.delegates[name].count;
      db[name].deleteMany = originals.delegates[name].deleteMany;
    }
    config.admin.allowDbCleanup = originals.allow;
    config.admin.cleanupToken = originals.token;
  });

  async function post(body: Record<string, unknown>, token = TOKEN) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/admin/whatsapp/cleanup`,
      headers: token ? { "x-whatsapp-cleanup-token": token } : {},
      payload: body,
    });
    await app.close();
    return response;
  }

  it("refuses cleanup when the environment safety gate is off", async () => {
    config.admin.allowDbCleanup = false;
    const response = await post({});
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "CLEANUP_DISABLED");
    assert.equal(calls.length, 0, "disabled endpoint must not disclose counts");
  });

  it("refuses cleanup with missing/wrong independent cleanup token", async () => {
    for (const token of ["", "wrong-token"]) {
      const response = await post({}, token);
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "CLEANUP_UNAUTHORIZED");
    }
    assert.equal(calls.length, 0);
  });

  it("defaults to dry-run and keeps Feishu/config tables", async () => {
    const response = await post({});
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dryRun, true);
    assert.deepEqual(body.scope, { all: true });
    assert.equal(body.wouldDelete.messages, 11);
    assert.equal(body.wouldDelete.feishuApps, 0);
    assert.equal(body.wouldDelete.appSettings, 0);
    assert.equal(calls.some((call) => call.op === "delete"), false);
  });

  it("deletes one supplier in FK-safe order after explicit confirmation", async () => {
    const response = await post({
      supplierId: "tenant-a",
      dryRun: false,
      confirm: CLEANUP_CONFIRM,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dryRun, false);
    assert.deepEqual(body.scope, { supplierId: "tenant-a" });
    assert.equal(body.deleted.messages, 11);
    assert.equal(body.deleted.feishuApps, 0);

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
    assert.deepEqual(deleted[0].args, { where: { supplierId: "tenant-a" } });
    assert.deepEqual(deleted[1].args, { where: { conversation: { supplierId: "tenant-a" } } });
    assert.deepEqual(deleted[6].args, { where: { partnerCustomerId: "tenant-a" } });
  });

  it("requires a stronger global confirmation before deleting credentials/settings", async () => {
    const weak = await post({
      dryRun: false,
      includeConfig: true,
      confirm: CLEANUP_CONFIRM,
    });
    assert.equal(weak.statusCode, 400);
    assert.equal(weak.json().code, "CLEANUP_CONFIRMATION_REQUIRED");

    const scoped = await post({
      supplierId: "tenant-a",
      includeConfig: true,
    });
    assert.equal(scoped.statusCode, 400);
    assert.equal(scoped.json().code, "CLEANUP_CONFIG_REQUIRES_GLOBAL");

    const full = await post({
      dryRun: false,
      includeConfig: true,
      confirm: CLEANUP_WITH_CONFIG_CONFIRM,
    });
    assert.equal(full.statusCode, 200);
    assert.equal(full.json().deleted.feishuApps, 1);
    assert.equal(full.json().deleted.appSettings, 1);
  });
});
