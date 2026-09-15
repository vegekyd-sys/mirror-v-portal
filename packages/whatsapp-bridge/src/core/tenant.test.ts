import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveTenantContext,
  selectConversationWaba,
  selectTenantOwnedWaba,
  webhookTenantKey,
} from "./tenant";
import { config } from "../config";

const bindings = [
  { wabaId: "waba-a", partnerCustomerId: "tenant-a", status: "CONNECTED" },
  { wabaId: "waba-b", partnerCustomerId: "tenant-b", status: "CONNECTED" },
];

describe("tenant isolation", () => {
  it("requires a tenant and rejects conflicting aliases", () => {
    assert.throws(() => resolveTenantContext({}), { code: "TENANT_CONTEXT_REQUIRED" });
    assert.throws(
      () => resolveTenantContext({ partnerCustomerId: "tenant-a", supplierId: "tenant-b" }),
      { code: "TENANT_CONTEXT_CONFLICT" },
    );
    assert.equal(resolveTenantContext({ supplierId: "tenant-a" }), "tenant-a");
  });

  it("rejects a WABA owned by another tenant", () => {
    assert.equal(
      selectTenantOwnedWaba("tenant-a", "waba-a", bindings).partnerCustomerId,
      "tenant-a",
    );
    assert.throws(() => selectTenantOwnedWaba("tenant-b", "waba-a", bindings), {
      code: "WABA_TENANT_MISMATCH",
    });
    // 共享 WABA：同一 WABA 有多个 CONNECTED owner 不再算冲突，各自都能认领自己的行
    assert.equal(
      selectTenantOwnedWaba("tenant-a", "waba-a", [
        ...bindings,
        { wabaId: "waba-a", partnerCustomerId: "tenant-b", status: "CONNECTED" },
      ]).partnerCustomerId,
      "tenant-a",
    );
  });

  it("resolves Feishu reply WABA only from the conversation tenant and business phone candidates", () => {
    assert.equal(
      selectConversationWaba("tenant-a", ["waba-a", "waba-b"], bindings),
      "waba-a",
    );
    assert.throws(() => selectConversationWaba("tenant-c", ["waba-a"], bindings), {
      code: "WABA_PHONE_BINDING_MISSING",
    });
    // 共享 WABA（2026-09-15）：同一个 WABA 有别的 CONNECTED owner 是正常状态，
    // 只要本租户自己也是 owner，就应该正常回发，不再判 WABA_TENANT_AMBIGUOUS。
    assert.equal(
      selectConversationWaba("tenant-a", ["waba-a"], [
        ...bindings,
        { wabaId: "waba-a", partnerCustomerId: "tenant-b", status: "CONNECTED" },
      ]),
      "waba-a",
    );
  });

  it("uses tenant-scoped webhook idempotency keys and a stable legacy scope", () => {
    assert.equal(webhookTenantKey("tenant-a"), "supplier:tenant-a");
    assert.equal(webhookTenantKey("tenant-b"), "supplier:tenant-b");
    assert.equal(webhookTenantKey(undefined), "legacy");
    assert.equal(webhookTenantKey(undefined, "feishu-app:cli-a"), "scope:feishu-app:cli-a");
  });

  it("does not expose a process-global current WABA binding", () => {
    assert.equal("wabaId" in config.ycloud, false);
    assert.equal("from" in config.ycloud, false);
  });
});
