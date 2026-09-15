import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 解绑手机号（2026-09-15）：**
 *   · 只停路由（删我方 WabaPhone 归属行），不调 YCloud/Meta；
 *   · 只能解绑自己的号 —— 别人的号一律 rejected 且**不做任何改动**（隔离硬要求）；
 *   · 解掉某 supplier 在该 WABA 的最后一个号后，onboarding 置 DISCONNECTED。
 */

type PhoneRow = { phoneNumber: string; wabaId: string; supplierId: string };

type MockTx = {
  $queryRaw: (..._args: unknown[]) => Promise<unknown>;
  wabaPhone: {
    findMany: (args: unknown) => Promise<PhoneRow[]>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    count: (args: unknown) => Promise<number>;
  };
  wabaOnboarding: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
};

describe("unbind WABA phones (tenant isolation)", { concurrency: false }, () => {
  const mutablePrisma = prisma as unknown as {
    wabaPhone: { findMany: (args: unknown) => Promise<PhoneRow[]> };
    $transaction: (
      callback: (tx: MockTx) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => Promise<unknown>;
  };

  const originals = {
    findMany: mutablePrisma.wabaPhone.findMany,
    transaction: mutablePrisma.$transaction,
  };

  let rows: PhoneRow[] = [];
  let deleted: Array<Record<string, unknown>> = [];
  let remainingByOwner = 0;
  let onboardingMatches = 1;
  let disconnected = 0;
  let onboardingUpdateCalls = 0;
  let lockCount = 0;
  let lockKeys: string[] = [];

  const tx: MockTx = {
    $queryRaw: async (...args: unknown[]) => {
      lockCount += 1;
      const key = args[1];
      if (typeof key === "string") lockKeys.push(key);
      return [{ locked: true }];
    },
    wabaPhone: {
      // 归属判定必须读事务内（加锁后）的状态
      findMany: async () => rows,
      deleteMany: async (args: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where;
        deleted.push(where);
        const before = rows.length;
        rows = rows.filter(
          (row) =>
            !(
              row.phoneNumber === where.phoneNumber && row.supplierId === where.supplierId
            ),
        );
        return { count: before - rows.length };
      },
      count: async () => remainingByOwner,
    },
    wabaOnboarding: {
      updateMany: async () => {
        onboardingUpdateCalls += 1;
        // 真实语义：WHERE 没命中就返回 count=0（例如调用方在这个 WABA 本来就没有
        // onboarding 行 —— 「想解绑别人的号」就是这种情形）
        if (onboardingMatches === 0) return { count: 0 };
        disconnected += 1;
        return { count: 1 };
      },
    },
  };

  before(() => {
    // 事务外读归属 = 锁不住的 TOCTOU。真出现就直接炸，别让它悄悄通过。
    mutablePrisma.wabaPhone.findMany = async () => {
      throw new Error("ownership must be read inside the locked transaction");
    };
    mutablePrisma.$transaction = async (callback, options) => {
      assert.equal(options?.isolationLevel, "Serializable");
      return callback(tx);
    };
  });

  beforeEach(() => {
    rows = [];
    deleted = [];
    remainingByOwner = 0;
    onboardingMatches = 1;
    disconnected = 0;
    onboardingUpdateCalls = 0;
    lockCount = 0;
    lockKeys = [];
  });

  after(() => {
    mutablePrisma.wabaPhone.findMany = originals.findMany;
    mutablePrisma.$transaction = originals.transaction;
  });

  async function post(payload: Record<string, unknown>) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/admin/whatsapp/unbind-phones`,
      payload,
    });
    await app.close();
    return response;
  }

  it("unbinds own phone and disconnects when no phone remains", async () => {
    rows = [{ phoneNumber: "+8615895553765", wabaId: "12345678901", supplierId: "tenant-a" }];
    remainingByOwner = 0;
    const response = await post({
      partnerCustomerId: "tenant-a",
      phoneNumbers: ["+8615895553765"],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().unbound, ["+8615895553765"]);
    assert.deepEqual(response.json().rejected, []);
    assert.equal(response.json().disconnected, 1, "最后一个号解绑后应置 DISCONNECTED");
    assert.deepEqual(deleted, [
      { phoneNumber: "+8615895553765", supplierId: "tenant-a" },
    ]);
  });

  it("never unbinds another tenant's phone and writes nothing", async () => {
    rows = [{ phoneNumber: "+8615895553765", wabaId: "12345678901", supplierId: "tenant-other" }];
    // 故意让 onboarding 的 WHERE 可命中：真「零改动」应该压根不发这条 UPDATE，
    // 而不是靠 WHERE 恰好没命中侥幸过关。
    onboardingMatches = 1;
    const response = await post({
      partnerCustomerId: "tenant-a",
      phoneNumbers: ["+8615895553765"],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().unbound, []);
    assert.deepEqual(response.json().rejected, [
      { phoneNumber: "+8615895553765", reason: "not_owned_by_caller" },
    ]);
    assert.equal(response.json().ok, false);
    assert.deepEqual(deleted, [], "别人的号绝对不能删");
    assert.equal(disconnected, 0);
    assert.equal(
      onboardingUpdateCalls,
      0,
      "全部 rejected 时不得触碰 onboarding 状态（零改动）",
    );
    // 不泄露归属信息
    assert.equal(response.body.includes("tenant-other"), false);
    assert.equal(response.body.includes("12345678901"), false);
  });

  it("reports not_bound for unknown phone without touching anything", async () => {
    const response = await post({
      partnerCustomerId: "tenant-a",
      phoneNumbers: ["+8613000000000"],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().rejected, [
      { phoneNumber: "+8613000000000", reason: "not_bound" },
    ]);
    assert.deepEqual(deleted, []);
  });

  it("keeps the binding alive while other phones remain", async () => {
    rows = [
      { phoneNumber: "+8615895553765", wabaId: "12345678901", supplierId: "tenant-a" },
      { phoneNumber: "+8615895553766", wabaId: "12345678901", supplierId: "tenant-a" },
    ];
    remainingByOwner = 1;
    const response = await post({
      partnerCustomerId: "tenant-a",
      phoneNumbers: ["+8615895553765"],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().unbound, ["+8615895553765"]);
    assert.equal(response.json().disconnected, 0, "还有号就不该断开");
  });

  it("locks phones before WABAs so concurrent import/unbind cannot deadlock", async () => {
    // import 一次性把 phone:/waba: 排序后加锁，'p' < 'w' → 先号后 WABA。
    // unbind 必须落在同一个全局顺序上，否则两边并发命中同一 (waba, phone) 就是 ABBA 死锁。
    rows = [
      { phoneNumber: "+8615895553765", wabaId: "12345678901", supplierId: "tenant-a" },
      { phoneNumber: "+8615895553766", wabaId: "12345678902", supplierId: "tenant-a" },
    ];
    remainingByOwner = 0;
    const response = await post({
      partnerCustomerId: "tenant-a",
      phoneNumbers: ["+8615895553766", "+8615895553765"],
    });
    assert.equal(response.statusCode, 200);

    const firstWaba = lockKeys.findIndex((key) => key.startsWith("waba:"));
    const lastPhone = lockKeys.map((key) => key.startsWith("phone:")).lastIndexOf(true);
    assert.equal(lockKeys.length > 0, true, "必须真的加锁");
    assert.equal(firstWaba > lastPhone, true, `phone 锁必须全部先于 waba 锁：${lockKeys.join(",")}`);

    const phoneKeys = lockKeys.filter((key) => key.startsWith("phone:"));
    const wabaKeys = lockKeys.filter((key) => key.startsWith("waba:"));
    assert.deepEqual(phoneKeys, [...phoneKeys].sort(), "phone 锁必须按升序，避免互相死锁");
    assert.deepEqual(wabaKeys, [...wabaKeys].sort(), "waba 锁必须按升序，避免互相死锁");
  });

  it("rejects malformed input", async () => {
    for (const payload of [
      {},
      { partnerCustomerId: "tenant-a" },
      { partnerCustomerId: "tenant a", phoneNumbers: ["+8615895553765"] },
      { partnerCustomerId: "tenant-a", phoneNumbers: [] },
      { partnerCustomerId: "tenant-a", phoneNumbers: ["nope"] },
      { partnerCustomerId: "tenant-a", phoneNumbers: ["+8615895553765"], extra: 1 },
    ]) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });
});
