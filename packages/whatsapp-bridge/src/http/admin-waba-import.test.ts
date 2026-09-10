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

describe("existing-WABA import", { concurrency: false }, () => {
  const mutablePrisma = prisma as unknown as {
    $transaction: (
      callback: (tx: MockTransaction) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => Promise<unknown>;
  };
  const tx: MockTransaction = {
    $queryRaw: async (_query: TemplateStringsArray, ..._values: unknown[]) => {
      lockCount += 1;
      return [{ locked: true }];
    },
    wabaOnboarding: {
      findMany: async (_args: unknown): Promise<Owner[]> => owners,
      findFirst: async (_args: unknown): Promise<{ id: string } | null> =>
        existingId ? { id: existingId } : null,
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
      findMany: async (_args: unknown): Promise<PhoneConflict[]> => phoneConflicts,
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

  let owners: Owner[] = [];
  let phoneConflicts: PhoneConflict[] = [];
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
          { phoneNumber: "+852 5111 1111" },
        ],
      });
    };
  });

  beforeEach(() => {
    owners = [];
    phoneConflicts = [];
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
      },
    });
    await app.close();
    return response;
  }

  it("rejects malformed tenant/WABA input before YCloud", async () => {
    for (const payload of [
      { partnerCustomerId: "tenant a", wabaId: "12345678901" },
      { partnerCustomerId: "tenant-a", wabaId: "not-a-waba" },
      { partnerCustomerId: "tenant-a", wabaId: "01234567890" },
      { partnerCustomerId: "tenant-a", wabaId: "12345678901", shared: true },
    ]) {
      const response = await request(payload);
      assert.equal(response.statusCode, 400);
    }
    assert.equal(fetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("verifies phones in YCloud, then transactionally creates one-tenant ownership", async () => {
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      partnerCustomerId: "tenant-a",
      status: "CONNECTED",
      phones: ["+85251111111", "+85252222222"],
    });
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(response.body.includes("wabaId"), false);
    assert.equal(transactionCount, 1);
    assert.equal(lockCount, 3);
    const create = writes.find((write) => write.operation === "create");
    assert.ok(create);
    const createData = (create.args as { data: Record<string, unknown> }).data;
    assert.equal(createData.partnerCustomerId, "tenant-a");
    assert.equal(createData.wabaId, "12345678901");
    assert.equal(createData.status, "CONNECTED");
    assert.equal(writes.filter((write) => write.operation === "phone-upsert").length, 2);
  });

  it("upserts an existing row for the same tenant", async () => {
    owners = [{ partnerCustomerId: "tenant-a" }];
    existingId = "existing-onboarding";
    const response = await request();
    assert.equal(response.statusCode, 200);
    assert.equal(writes.filter((write) => write.operation === "update").length, 1);
    assert.equal(writes.filter((write) => write.operation === "create").length, 0);
  });

  it("rejects a WABA already connected to another tenant without writing", async () => {
    owners = [{ partnerCustomerId: "tenant-other" }];
    const response = await request();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "ADMIN_IMPORT_WABA_OWNED");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(writes.length, 0);
  });

  it("rejects phone mappings owned by another WABA without writing", async () => {
    phoneConflicts = [{ phoneNumber: "+85251111111" }];
    const response = await request();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "ADMIN_IMPORT_PHONE_CONFLICT");
    assert.equal(response.body.includes("12345678901"), false);
    assert.equal(writes.length, 0);
  });

  it("maps YCloud failures and empty phone verification to safe errors", async () => {
    const failed = await request({ partnerCustomerId: "tenant-a", wabaId: "99999999999" });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "ADMIN_IMPORT_YCLOUD_FAILED");
    assert.equal(failed.body.includes("upstream-private-detail"), false);
    assert.equal(failed.body.includes("99999999999"), false);

    const empty = await request({ partnerCustomerId: "tenant-a", wabaId: "88888888888" });
    assert.equal(empty.statusCode, 404);
    assert.equal(empty.json().code, "ADMIN_IMPORT_WABA_NOT_FOUND");
    assert.equal(empty.body.includes("88888888888"), false);
    assert.equal(transactionCount, 0);
  });
});
