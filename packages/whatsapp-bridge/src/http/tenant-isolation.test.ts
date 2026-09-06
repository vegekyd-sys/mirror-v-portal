import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

describe("tenant-isolated WhatsApp APIs", { concurrency: false }, () => {
  it("requires tenant context, rejects WABA mismatch, and scopes conversation queries", async (t) => {
    const wabaDelegate = prisma.wabaOnboarding as unknown as {
      findMany: (args: unknown) => Promise<unknown[]>;
    };
    const conversationDelegate = prisma.conversation as unknown as {
      findMany: (args: unknown) => Promise<unknown[]>;
    };
    const originalWabaFindMany = wabaDelegate.findMany;
    const originalConversationFindMany = conversationDelegate.findMany;
    let conversationArgs: unknown;

    wabaDelegate.findMany = async () => [
      { wabaId: "waba-a", partnerCustomerId: "tenant-a", status: "CONNECTED" },
    ];
    conversationDelegate.findMany = async (args: unknown) => {
      conversationArgs = args;
      return [];
    };

    const app = await buildServer();
    t.after(async () => {
      wabaDelegate.findMany = originalWabaFindMany;
      conversationDelegate.findMany = originalConversationFindMany;
      await app.close();
    });
    const prefix = config.routePrefix;

    const missingTenant = await app.inject({
      method: "GET",
      url: `${prefix}/api/whatsapp/conversations`,
    });
    assert.equal(missingTenant.statusCode, 400);
    assert.equal(missingTenant.json().code, "TENANT_CONTEXT_REQUIRED");

    const phoneMismatch = await app.inject({
      method: "GET",
      url: `${prefix}/api/whatsapp/phones?wabaId=waba-a&partnerCustomerId=tenant-b`,
    });
    assert.equal(phoneMismatch.statusCode, 403);
    assert.equal(phoneMismatch.json().code, "WABA_TENANT_MISMATCH");

    const templateMismatch = await app.inject({
      method: "GET",
      url: `${prefix}/api/whatsapp/templates?wabaId=waba-a&partnerCustomerId=tenant-b`,
    });
    assert.equal(templateMismatch.statusCode, 403);
    assert.equal(templateMismatch.json().code, "WABA_TENANT_MISMATCH");

    const messageMismatch = await app.inject({
      method: "POST",
      url: `${prefix}/api/whatsapp/messages`,
      payload: {
        partnerCustomerId: "tenant-b",
        wabaId: "waba-a",
        to: "+85290000000",
        text: "isolated test",
      },
    });
    assert.equal(messageMismatch.statusCode, 403);
    assert.equal(messageMismatch.json().code, "WABA_TENANT_MISMATCH");

    const scopedConversations = await app.inject({
      method: "GET",
      url: `${prefix}/api/whatsapp/conversations?partnerCustomerId=tenant-a`,
    });
    assert.equal(scopedConversations.statusCode, 200);
    assert.equal(scopedConversations.json().supplierId, "tenant-a");
    assert.deepEqual(
      (conversationArgs as { where: { supplierId: string } }).where.supplierId,
      "tenant-a",
    );
  });
});
