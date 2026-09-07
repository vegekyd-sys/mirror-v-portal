import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

type Owner = { partnerCustomerId: string };
type PhoneConflict = { phoneNumber: string };
type MockTransaction = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]) => Promise<unknown>;
  wabaOnboarding: {
    findMany: (_args: unknown) => Promise<Owner[]>;
    findFirst: (_args: unknown) => Promise<{ id: string } | null>;
    update: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  wabaPhone: {
    findMany: (_args: unknown) => Promise<PhoneConflict[]>;
    upsert: (args: unknown) => Promise<unknown>;
  };
};

describe("allowlisted Skill existing-WABA binding", { concurrency: false }, () => {
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
      findMany: async () => owners,
      findFirst: async () => null,
      update: async (args) => {
        writes.push({ operation: "update", args });
        return {};
      },
      create: async (args) => {
        writes.push({ operation: "create", args });
        return {};
      },
    },
    wabaPhone: {
      findMany: async () => phoneConflicts,
      upsert: async (args) => {
        writes.push({ operation: "phone-upsert", args });
        return {};
      },
    },
  };

  const originals = {
    transaction: mutablePrisma.$transaction,
    fetch: globalThis.fetch,
    adminToken: config.adminToken,
    allowedSuppliers: config.skillBindAllowedSuppliers,
    apiKey: config.ycloud.apiKey,
  };

  let owners: Owner[] = [];
  let phoneConflicts: PhoneConflict[] = [];
  let fetchCount = 0;
  let transactionCount = 0;
  let lockCount = 0;
  let writes: Array<{ operation: string; args: unknown }> = [];

  before(() => {
    config.adminToken = undefined;
    config.ycloud.apiKey = "test-ycloud-api-key";
    mutablePrisma.$transaction = async (callback, options) => {
      transactionCount += 1;
      assert.equal(options?.isolationLevel, "Serializable");
      return callback(tx);
    };
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
        ],
      });
    };
  });

  beforeEach(() => {
    config.skillBindAllowedSuppliers = [];
    owners = [];
    phoneConflicts = [];
    fetchCount = 0;
    transactionCount = 0;
    lockCount = 0;
    writes = [];
  });

  after(() => {
    mutablePrisma.$transaction = originals.transaction;
    globalThis.fetch = originals.fetch;
    config.adminToken = originals.adminToken;
    config.skillBindAllowedSuppliers = originals.allowedSuppliers;
    config.ycloud.apiKey = originals.apiKey;
  });

  async function request(
    payload: Record<string, unknown> = { supplierId: "123456", wabaId: "12345678901" },
  ) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/whatsapp/bind-existing-waba`,
      payload,
    });
    await app.close();
    return response;
  }

  it("is disabled when the server allowlist is absent or empty", async () => {
    const response = await request();
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_DISABLED");
    assert.equal(fetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("binds an allowlisted supplier without an admin token and hides the WABA ID", async () => {
    config.skillBindAllowedSuppliers = ["123456"];
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      partnerCustomerId: "123456",
      status: "CONNECTED",
      phones: ["+85251111111", "+85252222222"],
    });
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(response.body.includes("wabaId"), false);
    assert.equal(fetchCount, 1);
    assert.equal(transactionCount, 1);
    assert.equal(lockCount, 3);
    assert.equal(writes.filter((write) => write.operation === "create").length, 1);
    assert.equal(writes.filter((write) => write.operation === "phone-upsert").length, 2);
  });

  it("rejects a supplier outside the allowlist before calling YCloud", async () => {
    config.skillBindAllowedSuppliers = ["supplier-other"];
    const response = await request();
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_SUPPLIER_NOT_ALLOWED");
    assert.equal(fetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("returns safe YCloud verification failures without writing", async () => {
    config.skillBindAllowedSuppliers = ["123456"];
    const failed = await request({ supplierId: "123456", wabaId: "99999999999" });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "WHATSAPP_SKILL_BIND_YCLOUD_FAILED");
    assert.equal(failed.body.includes("upstream-private-detail"), false);
    assert.equal(failed.body.includes("99999999999"), false);

    const empty = await request({ supplierId: "123456", wabaId: "88888888888" });
    assert.equal(empty.statusCode, 404);
    assert.equal(empty.json().code, "WHATSAPP_SKILL_BIND_WABA_NOT_FOUND");
    assert.equal(empty.body.includes("88888888888"), false);
    assert.equal(transactionCount, 0);
    assert.equal(writes.length, 0);
  });

  it("rejects WABA ownership conflicts atomically", async () => {
    config.skillBindAllowedSuppliers = ["123456"];
    owners = [{ partnerCustomerId: "supplier-other" }];
    const response = await request();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_WABA_OWNED");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(transactionCount, 1);
    assert.equal(writes.length, 0);
  });

  it("rejects phone conflicts atomically", async () => {
    config.skillBindAllowedSuppliers = ["123456"];
    phoneConflicts = [{ phoneNumber: "+85251111111" }];
    const response = await request();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_PHONE_CONFLICT");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(transactionCount, 1);
    assert.equal(writes.length, 0);
  });

  it("accepts the partnerCustomerId alias but rejects conflicting aliases and authority fields", async () => {
    config.skillBindAllowedSuppliers = ["123456"];
    const alias = await request({ partnerCustomerId: "123456", wabaId: "12345678901" });
    assert.equal(alias.statusCode, 200);

    for (const payload of [
      { partnerCustomerId: "123456", supplierId: "supplier-other", wabaId: "12345678901" },
      { supplierId: "123456", wabaId: "12345678901", adminToken: "must-not-be-accepted" },
    ]) {
      const response = await request(payload);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_INVALID_INPUT");
    }
    assert.equal(fetchCount, 1);
    assert.equal(transactionCount, 1);
  });
});
