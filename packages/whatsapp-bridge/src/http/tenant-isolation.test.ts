import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { invalidateWabaPhoneCache } from "../core/onboarding";
import { prisma } from "../prisma";
import { buildServer } from "./server";

type Binding = {
  wabaId: string;
  partnerCustomerId: string;
  status: string;
};

const bindings: Binding[] = [
  { wabaId: "waba-single", partnerCustomerId: "tenant-single", status: "CONNECTED" },
  { wabaId: "waba-multi-a", partnerCustomerId: "tenant-multi", status: "CONNECTED" },
  { wabaId: "waba-multi-b", partnerCustomerId: "tenant-multi", status: "CONNECTED" },
  { wabaId: "waba-two-phones", partnerCustomerId: "tenant-two-phones", status: "CONNECTED" },
  { wabaId: "waba-other", partnerCustomerId: "tenant-other", status: "CONNECTED" },
];

const phonesByWaba: Record<string, string[]> = {
  "waba-single": ["+85251111111"],
  "waba-multi-a": ["+85252222221"],
  "waba-multi-b": ["+85252222222"],
  "waba-two-phones": ["+85254444441", "+85254444442"],
  "waba-other": ["+85253333333"],
};

describe("tenant-isolated WhatsApp APIs", { concurrency: false }, () => {
  const wabaDelegate = prisma.wabaOnboarding as unknown as {
    findMany: (args: Record<string, unknown>) => Promise<Binding[]>;
  };
  const wabaPhoneDelegate = prisma.wabaPhone as unknown as {
    upsert: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<unknown>;
    findMany: (
      args: unknown,
    ) => Promise<Array<{ phoneNumber: string; wabaId: string; supplierId: string }>>;
  };
  const customerDelegate = prisma.customer as unknown as {
    findFirst: (args: unknown) => Promise<unknown>;
  };
  const conversationDelegate = prisma.conversation as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    findUnique: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  const messageDelegate = prisma.message as unknown as {
    create: (args: unknown) => Promise<unknown>;
  };
  const feishuAppDelegate = prisma.feishuApp as unknown as {
    findFirst: (args: unknown) => Promise<unknown>;
  };

  const originals = {
    wabaFindMany: wabaDelegate.findMany,
    wabaPhoneUpsert: wabaPhoneDelegate.upsert,
    wabaPhoneUpdateMany: wabaPhoneDelegate.updateMany,
    wabaPhoneFindMany: wabaPhoneDelegate.findMany,
    customerFindFirst: customerDelegate.findFirst,
    conversationFindMany: conversationDelegate.findMany,
    conversationFindUnique: conversationDelegate.findUnique,
    conversationUpdate: conversationDelegate.update,
    messageCreate: messageDelegate.create,
    feishuAppFindFirst: feishuAppDelegate.findFirst,
    fetch: globalThis.fetch,
    apiKey: config.ycloud.apiKey,
  };

  let conversationArgs: unknown;
  let fetchUrls: URL[] = [];

  before(() => {
    config.ycloud.apiKey = "test-api-key";
    wabaDelegate.findMany = async (args) => {
      const where = (args.where || {}) as {
        partnerCustomerId?: string;
        status?: string;
        wabaId?: { in?: string[] };
      };
      if (where.partnerCustomerId) {
        return bindings.filter(
          (row) =>
            row.partnerCustomerId === where.partnerCustomerId &&
            (!where.status || row.status === where.status),
        );
      }
      if (where.wabaId?.in) {
        return bindings.filter(
          (row) => where.wabaId!.in!.includes(row.wabaId) && row.status === "CONNECTED",
        );
      }
      return [];
    };
    // 手机号级归属 fixture：由 bindings + phonesByWaba 推导（一号只归一家）
    const wabaByPhone: Record<string, string> = {};
    const ownerByPhone: Record<string, string> = {};
    for (const [wabaId, phones] of Object.entries(phonesByWaba)) {
      const owner = bindings.find((row) => row.wabaId === wabaId)?.partnerCustomerId || "";
      for (const phone of phones) {
        wabaByPhone[phone] = wabaId;
        ownerByPhone[phone] = owner;
      }
    }
    wabaPhoneDelegate.upsert = async () => ({});
    wabaPhoneDelegate.updateMany = async () => ({ count: 0 });
    // 读取收口（listTenantBusinessPhones 按 supplierId 过滤）与
    // 入站路由（resolveSupplierIdByBusinessPhone 按手机号取归属）都走这个 mock。
    wabaPhoneDelegate.findMany = async (args) => {
      const where =
        ((args as { where?: Record<string, unknown> }).where || {}) as {
          supplierId?: string;
          phoneNumber?: string | { in?: string[] };
        };
      const phoneFilter = where.phoneNumber;
      const phones =
        typeof phoneFilter === "string" ? [phoneFilter] : phoneFilter?.in || [];
      return phones
        .filter((phone) => phone in ownerByPhone)
        .filter((phone) => !where.supplierId || ownerByPhone[phone] === where.supplierId)
        .map((phone) => ({
          phoneNumber: phone,
          wabaId: wabaByPhone[phone] || "",
          supplierId: ownerByPhone[phone] || "",
        }));
    };
    customerDelegate.findFirst = async () => ({
      id: "customer-single",
      phoneNumber: "+85290000000",
      name: "Buyer",
      supplierId: "tenant-single",
    });
    conversationDelegate.findMany = async (args) => {
      conversationArgs = args;
      return [];
    };
    conversationDelegate.findUnique = async () => ({
      id: "conversation-single",
      customerId: "customer-single",
      businessPhone: "+85251111111",
      supplierId: "tenant-single",
      serviceWindowExpiresAt: new Date(Date.now() + 60_000),
      feishuAppId: null,
      customer: { id: "customer-single", phoneNumber: "+85290000000", name: "Buyer" },
    });
    conversationDelegate.update = async () => ({});
    messageDelegate.create = async () => ({});
    feishuAppDelegate.findFirst = async () => null;
    globalThis.fetch = async (input) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(raw);
      fetchUrls.push(url);
      if (url.pathname.endsWith("/whatsapp/phoneNumbers")) {
        const wabaId = url.searchParams.get("filter.wabaId") || "";
        return Response.json({
          items: (phonesByWaba[wabaId] || []).map((phoneNumber) => ({ phoneNumber })),
        });
      }
      if (url.pathname.endsWith("/whatsapp/templates")) {
        const wabaId = url.searchParams.get("filter.wabaId") || "";
        return Response.json({
          items: [
            {
              name: "approved_template",
              language: "en",
              status: "APPROVED",
              category: "MARKETING",
              wabaId,
              components: [{ type: "BODY", text: "Hello" }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/whatsapp/messages")) {
        return Response.json({ id: "msg-accepted" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  });

  beforeEach(() => {
    invalidateWabaPhoneCache();
    conversationArgs = undefined;
    fetchUrls = [];
  });

  after(() => {
    wabaDelegate.findMany = originals.wabaFindMany;
    wabaPhoneDelegate.upsert = originals.wabaPhoneUpsert;
    wabaPhoneDelegate.updateMany = originals.wabaPhoneUpdateMany;
    wabaPhoneDelegate.findMany = originals.wabaPhoneFindMany;
    customerDelegate.findFirst = originals.customerFindFirst;
    conversationDelegate.findMany = originals.conversationFindMany;
    conversationDelegate.findUnique = originals.conversationFindUnique;
    conversationDelegate.update = originals.conversationUpdate;
    messageDelegate.create = originals.messageCreate;
    feishuAppDelegate.findFirst = originals.feishuAppFindFirst;
    globalThis.fetch = originals.fetch;
    config.ycloud.apiKey = originals.apiKey;
    invalidateWabaPhoneCache();
  });

  it("auto-resolves one eligible phone for phones, conversations, templates, and messages", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const base = `${config.routePrefix}/api/whatsapp`;

    const phones = await app.inject({
      method: "GET",
      url: `${base}/phones?partnerCustomerId=tenant-single`,
    });
    assert.equal(phones.statusCode, 200);
    assert.deepEqual(phones.json(), {
      partnerCustomerId: "tenant-single",
      defaultFrom: "+85251111111",
      phones: [{ phoneNumber: "+85251111111", current: true }],
    });

    const conversations = await app.inject({
      method: "GET",
      url: `${base}/conversations?partnerCustomerId=tenant-single&phone=85290000000`,
    });
    assert.equal(conversations.statusCode, 200);
    assert.equal(
      (conversationArgs as { where: { supplierId: string; businessPhone: string } }).where.supplierId,
      "tenant-single",
    );
    assert.equal(
      (conversationArgs as { where: { supplierId: string; businessPhone: string } }).where.businessPhone,
      "+85251111111",
    );

    const templates = await app.inject({
      method: "GET",
      url: `${base}/templates?partnerCustomerId=tenant-single`,
    });
    assert.equal(templates.statusCode, 200);
    assert.equal(templates.json().templates[0].name, "approved_template");

    const message = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      payload: {
        partnerCustomerId: "tenant-single",
        to: "+85290000000",
        text: "isolated test",
      },
    });
    assert.equal(message.statusCode, 200);
    assert.equal(message.json().ok, true);
    assert.equal(message.json().from, "+85251111111");

    for (const response of [phones, conversations, templates, message]) {
      assert.equal(response.body.includes("wabaId"), false);
      assert.equal(response.body.includes("waba-single"), false);
    }
  });

  it("does not allow caller-supplied WABA IDs to steer routine APIs", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const base = `${config.routePrefix}/api/whatsapp`;

    const phones = await app.inject({
      method: "GET",
      url: `${base}/phones?partnerCustomerId=tenant-single&wabaId=waba-other`,
    });
    assert.equal(phones.statusCode, 200);
    assert.equal(phones.json().defaultFrom, "+85251111111");

    const templates = await app.inject({
      method: "GET",
      url: `${base}/templates?partnerCustomerId=tenant-single&wabaId=waba-other`,
    });
    assert.equal(templates.statusCode, 200);
    const templateRequest = fetchUrls.find((url) =>
      url.pathname.endsWith("/whatsapp/templates"),
    );
    assert.equal(templateRequest?.searchParams.get("filter.wabaId"), "waba-single");

    const conversations = await app.inject({
      method: "GET",
      url: `${base}/conversations?partnerCustomerId=tenant-single&wabaId=waba-other`,
    });
    assert.equal(conversations.statusCode, 200);
    assert.equal(
      (conversationArgs as { where: { supplierId: string; businessPhone: string } }).where
        .supplierId,
      "tenant-single",
    );
    assert.equal(
      (conversationArgs as { where: { supplierId: string; businessPhone: string } }).where
        .businessPhone,
      "+85251111111",
    );

    const message = await app.inject({
      method: "POST",
      url: `${base}/messages`,
      payload: {
        partnerCustomerId: "tenant-single",
        wabaId: "waba-other",
        to: "+85290000000",
        text: "routine routing test",
      },
    });
    assert.equal(message.statusCode, 200);
    assert.equal(message.json().from, "+85251111111");

    for (const response of [phones, templates, conversations, message]) {
      assert.equal(response.body.includes("wabaId"), false);
      assert.equal(response.body.includes("waba-single"), false);
      assert.equal(response.body.includes("waba-other"), false);
    }
  });

  it("requires explicit from when a tenant has multiple phones across multiple WABAs", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const base = `${config.routePrefix}/api/whatsapp`;

    for (const request of [
      { method: "GET" as const, url: `${base}/phones?partnerCustomerId=tenant-multi` },
      { method: "GET" as const, url: `${base}/templates?partnerCustomerId=tenant-multi` },
      { method: "GET" as const, url: `${base}/conversations?partnerCustomerId=tenant-multi` },
      {
        method: "POST" as const,
        url: `${base}/messages`,
        payload: { partnerCustomerId: "tenant-multi", to: "+85290000000", text: "test" },
      },
    ]) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, "WHATSAPP_FROM_SELECTION_REQUIRED");
      assert.deepEqual(response.json().phones, ["+85252222221", "+85252222222"]);
      assert.equal(response.body.includes("wabaId"), false);
      assert.equal(response.body.includes("waba-multi"), false);
    }

    const selected = await app.inject({
      method: "GET",
      url: `${base}/templates?partnerCustomerId=tenant-multi&from=%2B85252222222`,
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.body.includes("wabaId"), false);
    const templateRequest = fetchUrls.find((url) => url.pathname.endsWith("/whatsapp/templates"));
    assert.equal(templateRequest?.searchParams.get("filter.wabaId"), "waba-multi-b");
  });

  it("requires explicit from when one WABA has multiple business phones", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const response = await app.inject({
      method: "GET",
      url: `${config.routePrefix}/api/whatsapp/phones?partnerCustomerId=tenant-two-phones`,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "WHATSAPP_FROM_SELECTION_REQUIRED");
    assert.deepEqual(response.json().phones, ["+85254444441", "+85254444442"]);
    assert.equal(response.body.includes("wabaId"), false);
    assert.equal(response.body.includes("waba-two-phones"), false);
  });

  it("rejects a cross-tenant from without exposing either tenant's WABA ID", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const response = await app.inject({
      method: "GET",
      url: `${config.routePrefix}/api/whatsapp/templates?partnerCustomerId=tenant-single&from=%2B85253333333`,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "WHATSAPP_FROM_NOT_OWNED");
    assert.equal(response.body.includes("wabaId"), false);
    assert.equal(response.body.includes("waba-single"), false);
    assert.equal(response.body.includes("waba-other"), false);
  });

  it("returns an onboarding-safe error when the tenant has no connected binding", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const response = await app.inject({
      method: "GET",
      url: `${config.routePrefix}/api/whatsapp/phones?partnerCustomerId=tenant-none`,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "WHATSAPP_BINDING_REQUIRED");
    assert.equal(response.body.includes("wabaId"), false);
  });

  it("still requires tenant context", async (t) => {
    const app = await buildServer();
    t.after(() => app.close());
    const response = await app.inject({
      method: "GET",
      url: `${config.routePrefix}/api/whatsapp/conversations`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "TENANT_CONTEXT_REQUIRED");
  });
});
