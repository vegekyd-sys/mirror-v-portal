import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 2026-09-15 改造后的契约：
 *   · 绑定必须显式给 phoneNumbers（归属只落在手机号上）；
 *   · 一个 WABA 可被多个 tenant 共享（不再有 WABA 级独占）；
 *   · 手机号全局唯一：被别家占用的号一律 409，且不写任何数据。
 */

type OwnershipRow = { phoneNumber: string; supplierId: string };
type ConflictRow = { phoneNumber: string };

type MockTransaction = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]) => Promise<unknown>;
  wabaOnboarding: {
    findFirst: (_args: unknown) => Promise<{ id: string } | null>;
    update: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  wabaPhone: {
    findMany: (args: unknown) => Promise<Array<OwnershipRow | ConflictRow>>;
    upsert: (args: unknown) => Promise<unknown>;
  };
};

describe("existing-WABA import (shared WABA / phone-level ownership)", { concurrency: false }, () => {
  const mutablePrisma = prisma as unknown as {
    $transaction: (
      callback: (tx: MockTransaction) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => Promise<unknown>;
  };

  const tx: MockTransaction = {
    $queryRaw: async () => {
      lockCount += 1;
      return [{ locked: true }];
    },
    wabaOnboarding: {
      findFirst: async () => (existingId ? { id: existingId } : null),
      update: async (args: unknown) => {
        writes.push({ operation: "update", args });
        return {};
      },
      create: async (args: unknown) => {
        writes.push({ operation: "create", args });
        return {};
      },
    },
    wabaPhone: {
      findMany: async (args: unknown) => {
        const where = (args as { where?: Record<string, unknown> }).where || {};
        // 两条查询共用同一个 delegate：带 wabaId.not 的是「跨 WABA 冲突」查询
        const wabaWhere = where.wabaId as { not?: string } | undefined;
        if (wabaWhere?.not !== undefined) return crossWabaConflicts;
        return ownershipRows;
      },
      upsert: async (args: unknown) => {
        writes.push({ operation: "phone-upsert", args });
        return {};
      },
    },
  };

  const originals = {
    transaction: mutablePrisma.$transaction,
    fetch: globalThis.fetch,
    apiKey: config.ycloud.apiKey,
  };

  let ownershipRows: OwnershipRow[] = [];
  let crossWabaConflicts: ConflictRow[] = [];
  let existingId: string | undefined;
  let fetchCount = 0;
  let transactionCount = 0;
  let lockCount = 0;
  let writes: Array<{ operation: string; args: unknown }> = [];

  before(() => {
    config.ycloud.apiKey = "test-ycloud-api-key";
    mutablePrisma.$transaction = async (callback, options) => {
      transactionCount += 1;
      assert.equal(options?.isolationLevel, "Serializable");
      return callback(tx);
    };
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      assert.equal(url.pathname.endsWith("/whatsapp/phoneNumbers"), true);
      const requested = url.searchParams.get("filter.wabaId");
      if (requested === "99999999999") {
        return Response.json({ error: "upstream-private-detail" }, { status: 503 });
      }
      if (requested === "88888888888") return Response.json({ items: [] });
      return Response.json({
        items: [
          { phoneNumber: "+852 5111 1111" },
          { displayPhoneNumber: "+85252222222" },
          { phoneNumber: "+852 5111 1111" },
        ],
      });
    };
  });

  beforeEach(() => {
    ownershipRows = [];
    crossWabaConflicts = [];
    existingId = undefined;
    fetchCount = 0;
    transactionCount = 0;
    lockCount = 0;
    writes = [];
  });

  after(() => {
    mutablePrisma.$transaction = originals.transaction;
    globalThis.fetch = originals.fetch;
    config.ycloud.apiKey = originals.apiKey;
  });

  async function request(payload?: unknown) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/admin/whatsapp/import-existing-waba`,
      payload: payload ?? {
        partnerCustomerId: "tenant-a",
        wabaId: "12345678901",
        phoneNumbers: ["+85251111111"],
      },
    });
    await app.close();
    return response;
  }

  it("rejects malformed tenant/WABA/phone input before YCloud", async () => {
    for (const payload of [
      { partnerCustomerId: "tenant a", wabaId: "12345678901", phoneNumbers: ["+85251111111"] },
      { partnerCustomerId: "tenant-a", wabaId: "not-a-waba", phoneNumbers: ["+85251111111"] },
      { partnerCustomerId: "tenant-a", wabaId: "01234567890", phoneNumbers: ["+85251111111"] },
      { partnerCustomerId: "tenant-a", wabaId: "12345678901", shared: true },
      // 手机号必填：缺省 / 空数组 / 非法值 都不该打到 YCloud
      { partnerCustomerId: "tenant-a", wabaId: "12345678901" },
      { partnerCustomerId: "tenant-a", wabaId: "12345678901", phoneNumbers: [] },
      { partnerCustomerId: "tenant-a", wabaId: "12345678901", phoneNumbers: ["not-a-phone"] },
    ]) {
      const response = await request(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
    assert.equal(fetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("binds only the requested phones and writes phone-level ownership", async () => {
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      partnerCustomerId: "tenant-a",
      status: "CONNECTED",
      phones: ["+85251111111"],
    });
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(response.body.includes("wabaId"), false);
    assert.equal(transactionCount, 1);
    // 锁：waba:<id> + 本次每个手机号各一把
    assert.equal(lockCount, 2);

    const create = writes.find((write) => write.operation === "create");
    assert.ok(create, "首次绑定应创建 onboarding 行");
    const createData = (create.args as { data: Record<string, unknown> }).data;
    assert.equal(createData.partnerCustomerId, "tenant-a");
    assert.equal(createData.wabaId, "12345678901");
    assert.equal(createData.status, "CONNECTED");

    const phoneWrites = writes.filter((write) => write.operation === "phone-upsert");
    assert.equal(phoneWrites.length, 1, "只写本次请求的手机号，不再一把梭全部号");
    const upsertArgs = phoneWrites[0].args as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    assert.deepEqual(upsertArgs.where, { phoneNumber: "+85251111111" });
    assert.equal(upsertArgs.create.supplierId, "tenant-a", "归属必须写进去");
  });

  it("upserts an existing onboarding row for the same tenant", async () => {
    existingId = "existing-onboarding";
    ownershipRows = [{ phoneNumber: "+85251111111", supplierId: "tenant-a" }];
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.equal(writes.filter((write) => write.operation === "update").length, 1);
    assert.equal(writes.filter((write) => write.operation === "create").length, 0);
  });

  it("allows a second tenant to share the same WABA with a different phone", async () => {
    // 关键改造点：以前这里会 409 ADMIN_IMPORT_WABA_OWNED（WABA 独占），现在必须成功
    const response = await request({
      partnerCustomerId: "tenant-b",
      wabaId: "12345678901",
      phoneNumbers: ["+85252222222"],
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().phones, ["+85252222222"]);
    const phoneWrites = writes.filter((write) => write.operation === "phone-upsert");
    assert.equal(phoneWrites.length, 1);
    assert.equal(
      (phoneWrites[0].args as { create: Record<string, unknown> }).create.supplierId,
      "tenant-b",
    );
  });

  it("rejects a phone already owned by another tenant without writing", async () => {
    ownershipRows = [{ phoneNumber: "+85251111111", supplierId: "tenant-other" }];
    const response = await request({
      partnerCustomerId: "tenant-a",
      wabaId: "12345678901",
      phoneNumbers: ["+85251111111"],
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "ADMIN_IMPORT_PHONE_OWNED_BY_OTHER_TENANT");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(writes.length, 0, "拒绝时不能写任何归属");
  });

  it("rejects phone mappings owned by another WABA without writing", async () => {
    crossWabaConflicts = [{ phoneNumber: "+85251111111" }];
    const response = await request();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "ADMIN_IMPORT_PHONE_CONFLICT");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(writes.length, 0);
  });

  it("rejects phones that are not on that WABA", async () => {
    const response = await request({
      partnerCustomerId: "tenant-a",
      wabaId: "12345678901",
      phoneNumbers: ["+8613800000000"],
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "ADMIN_IMPORT_PHONE_NOT_ON_WABA");
    assert.equal(writes.length, 0);
  });

  it("maps YCloud failures and empty phone verification to safe errors", async () => {
    const failed = await request({
      partnerCustomerId: "tenant-a",
      wabaId: "99999999999",
      phoneNumbers: ["+8613800000000"],
    });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "ADMIN_IMPORT_YCLOUD_FAILED");
    assert.equal(failed.body.includes("upstream-private-detail"), false);
    assert.equal(failed.body.includes("99999999999"), false);

    const empty = await request({
      partnerCustomerId: "tenant-a",
      wabaId: "88888888888",
      phoneNumbers: ["+8613800000000"],
    });
    assert.equal(empty.statusCode, 404);
    assert.equal(empty.json().code, "ADMIN_IMPORT_WABA_NOT_FOUND");
    assert.equal(empty.body.includes("88888888888"), false);
    assert.equal(transactionCount, 0);
  });
});
