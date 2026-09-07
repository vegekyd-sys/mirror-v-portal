import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

type Owner = { partnerCustomerId: string };
type PhoneConflict = { phoneNumber: string };
type MockTransaction = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]) => Promise<unknown>;
  tenantMachineAssertionReplay: {
    deleteMany: (_args: unknown) => Promise<unknown>;
    create: (args: { data: { supplierId: string; nonceHash: string; expiresAt: Date } }) => Promise<unknown>;
  };
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

describe("tenant-machine Skill existing-WABA binding", { concurrency: false }, () => {
  const mutablePrisma = prisma as unknown as {
    $transaction: (
      callback: (tx: MockTransaction) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => Promise<unknown>;
  };
  const usedNonces = new Set<string>();
  const tx: MockTransaction = {
    $queryRaw: async () => {
      lockCount += 1;
      return [{ locked: true }];
    },
    tenantMachineAssertionReplay: {
      deleteMany: async () => ({}),
      create: async ({ data }) => {
        const key = `${data.supplierId}:${data.nonceHash}`;
        if (usedNonces.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError("duplicate assertion", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        usedNonces.add(key);
        replayWrites.push(data);
        return {};
      },
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
    provisioningUrl: config.provisioning.baseUrl,
    provisioningToken: config.provisioning.apiToken,
    apiKey: config.ycloud.apiKey,
  };

  let owners: Owner[] = [];
  let phoneConflicts: PhoneConflict[] = [];
  let ycloudFetchCount = 0;
  let verifierFetchCount = 0;
  let verifierValid = true;
  let verifierStatus = 200;
  let verifierBody: Record<string, unknown> | null = null;
  let transactionCount = 0;
  let lockCount = 0;
  let writes: Array<{ operation: string; args: unknown }> = [];
  let replayWrites: Array<{ supplierId: string; nonceHash: string; expiresAt: Date }> = [];

  before(() => {
    config.adminToken = undefined;
    config.provisioning.baseUrl = "http://provisioning.test";
    config.provisioning.apiToken = "test-provisioning-token";
    config.ycloud.apiKey = "test-ycloud-api-key";
    mutablePrisma.$transaction = async (callback, options) => {
      transactionCount += 1;
      if (options) assert.equal(options.isolationLevel, "Serializable");
      return callback(tx);
    };
    globalThis.fetch = async (input, init) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(raw);
      if (url.hostname === "provisioning.test") {
        verifierFetchCount += 1;
        assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer test-provisioning-token");
        verifierBody = JSON.parse(String(init?.body));
        return Response.json({ valid: verifierValid }, { status: verifierStatus });
      }
      ycloudFetchCount += 1;
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
    owners = [];
    phoneConflicts = [];
    ycloudFetchCount = 0;
    verifierFetchCount = 0;
    verifierValid = true;
    verifierStatus = 200;
    verifierBody = null;
    transactionCount = 0;
    lockCount = 0;
    writes = [];
    replayWrites = [];
    usedNonces.clear();
  });

  after(() => {
    mutablePrisma.$transaction = originals.transaction;
    globalThis.fetch = originals.fetch;
    config.adminToken = originals.adminToken;
    config.provisioning.baseUrl = originals.provisioningUrl;
    config.provisioning.apiToken = originals.provisioningToken;
    config.ycloud.apiKey = originals.apiKey;
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      supplierId: "123456",
      wabaId: "12345678901",
      assertion: {
        version: "v1",
        issuedAt: Math.floor(Date.now() / 1000),
        nonce: "nonce_abcdefghijklmnopqrstuvwxyz",
        signature: "A".repeat(43),
      },
      ...overrides,
    };
  }

  async function request(body: Record<string, unknown> = payload()) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/whatsapp/bind-existing-waba`,
      payload: body,
    });
    await app.close();
    return response;
  }

  it("binds every verified supplier machine without an admin token and hides the WABA ID", async () => {
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
    assert.equal(verifierFetchCount, 1);
    assert.equal(ycloudFetchCount, 1);
    assert.equal(transactionCount, 2);
    assert.equal(replayWrites.length, 1);
    assert.equal(lockCount, 3);
    assert.deepEqual(verifierBody, payload({ assertion: (verifierBody as any)?.assertion }));
  });

  it("rejects stale/future assertions before server verification or YCloud", async () => {
    for (const issuedAt of [
      Math.floor(Date.now() / 1000) - 121,
      Math.floor(Date.now() / 1000) + 31,
    ]) {
      const response = await request(payload({
        assertion: {
          version: "v1",
          issuedAt,
          nonce: "nonce_abcdefghijklmnopqrstuvwxyz",
          signature: "A".repeat(43),
        },
      }));
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_ASSERTION_EXPIRED");
    }
    assert.equal(verifierFetchCount, 0);
    assert.equal(ycloudFetchCount, 0);
  });

  it("rejects an assertion not bound by provisioning to the exact supplier and WABA", async () => {
    verifierValid = false;
    const response = await request();
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_INVALID_ASSERTION");
    assert.equal(ycloudFetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("fails closed when machine verification is unavailable", async () => {
    verifierStatus = 503;
    const response = await request();
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_ASSERTION_UNAVAILABLE");
    assert.equal(ycloudFetchCount, 0);
    assert.equal(transactionCount, 0);
  });

  it("atomically rejects replay before a second YCloud import", async () => {
    const body = payload();
    assert.equal((await request(body)).statusCode, 200);
    const replay = await request(body);
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().code, "WHATSAPP_SKILL_BIND_ASSERTION_REPLAYED");
    assert.equal(verifierFetchCount, 2);
    assert.equal(ycloudFetchCount, 1);
  });

  it("rejects aliases, authority fields, and malformed assertions", async () => {
    for (const body of [
      { ...payload(), partnerCustomerId: "123456" },
      { ...payload(), adminToken: "must-not-be-accepted" },
      { ...payload(), assertion: { ...(payload().assertion as object), role: "admin" } },
      { ...payload(), assertion: { ...(payload().assertion as object), signature: "short" } },
    ]) {
      const response = await request(body);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "WHATSAPP_SKILL_BIND_INVALID_INPUT");
    }
    assert.equal(verifierFetchCount, 0);
    assert.equal(ycloudFetchCount, 0);
  });

  it("returns safe YCloud verification failures without importer writes", async () => {
    const failed = await request(payload({ wabaId: "99999999999" }));
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "WHATSAPP_SKILL_BIND_YCLOUD_FAILED");
    assert.equal(failed.body.includes("upstream-private-detail"), false);
    assert.equal(failed.body.includes("99999999999"), false);

    usedNonces.clear();
    const empty = await request(payload({ wabaId: "88888888888" }));
    assert.equal(empty.statusCode, 404);
    assert.equal(empty.json().code, "WHATSAPP_SKILL_BIND_WABA_NOT_FOUND");
    assert.equal(empty.body.includes("88888888888"), false);
    assert.equal(writes.length, 0);
  });

  it("preserves atomic WABA ownership and phone conflict checks", async () => {
    owners = [{ partnerCustomerId: "supplier-other" }];
    const owned = await request();
    assert.equal(owned.statusCode, 409);
    assert.equal(owned.json().code, "WHATSAPP_SKILL_BIND_WABA_OWNED");
    assert.equal(writes.length, 0);

    usedNonces.clear();
    owners = [];
    phoneConflicts = [{ phoneNumber: "+85251111111" }];
    const phone = await request();
    assert.equal(phone.statusCode, 409);
    assert.equal(phone.json().code, "WHATSAPP_SKILL_BIND_PHONE_CONFLICT");
    assert.equal(writes.length, 0);
  });
});
