import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import { buildServer } from "./server";

/**
 * 解绑 supplierId ↔ wabaId 回归（WABA 级归属，回滚后的口径）：
 *   · CONNECTED 行被置 DISCONNECTED（只改这一处）；
 *   · 只按 partnerCustomerId 收范围，别人的绑定不碰；
 *   · 不触碰 WabaPhone（不删行、不调外部释放）；
 *   · 幂等：重复解绑/从未绑定都返回 200，只是如实回报；
 *   · 入参非法 → 400。
 */

const PARTNER = "tenant-a";
const WABA = "1234567890";

type Delegate = {
  findMany: (args?: unknown) => Promise<unknown[]>;
  updateMany: (args?: unknown) => Promise<{ count: number }>;
};

type FakeTx = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  wabaOnboarding: Delegate;
  wabaPhone: { findMany: (args?: unknown) => Promise<unknown[]>; deleteMany: (args?: unknown) => Promise<{ count: number }> };
};

describe("unbind-waba endpoint", { concurrency: false }, () => {
  const db = prisma as unknown as {
    $transaction: (cb: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
  };

  let rows: Array<{ id: string; status: string }> = [];
  const calls: Array<{ what: string; args?: unknown }> = [];

  const originalTransaction = db.$transaction;

  const tx: FakeTx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      calls.push({ what: "advisoryLock" });
      assert.match(String(strings[0]), /pg_advisory_xact_lock/);
      return [{ pg_advisory_xact_lock: "" }];
    },
    wabaOnboarding: {
      findMany: async (args?: unknown) => {
        calls.push({ what: "onboarding.findMany", args });
        return rows;
      },
      updateMany: async (args?: unknown) => {
        calls.push({ what: "onboarding.updateMany", args });
        return { count: rows.filter((r) => r.status === "CONNECTED").length };
      },
    },
    wabaPhone: {
      findMany: async (args?: unknown) => {
        calls.push({ what: "wabaPhone.findMany", args });
        return [];
      },
      deleteMany: async (args?: unknown) => {
        calls.push({ what: "wabaPhone.deleteMany", args });
        return { count: 0 };
      },
    },
  };

  before(() => {
    db.$transaction = async (callback) => callback(tx);
  });

  after(() => {
    db.$transaction = originalTransaction;
  });

  beforeEach(() => {
    calls.length = 0;
    rows = [{ id: "wob_1", status: "CONNECTED" }];
  });

  async function post(body: unknown) {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: `${config.routePrefix}/api/admin/whatsapp/unbind-waba`,
      payload: body as Record<string, unknown>,
    });
    await app.close();
    return response;
  }

  it("unbinds a CONNECTED binding by flipping status", async () => {
    const response = await post({ partnerCustomerId: PARTNER, wabaId: WABA });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.unbound, true);
    assert.equal(body.code, "WABA_UNBOUND");
    assert.equal(body.phonesTouched, false);

    const update = calls.find((c) => c.what === "onboarding.updateMany");
    assert.deepEqual(update?.args, {
      where: { id: { in: ["wob_1"] } },
      data: { status: "DISCONNECTED" },
    });
  });

  it("scopes strictly to the calling tenant", async () => {
    await post({ partnerCustomerId: PARTNER, wabaId: WABA });
    const find = calls.find((c) => c.what === "onboarding.findMany");
    assert.deepEqual(find?.args, {
      where: { wabaId: WABA, partnerCustomerId: PARTNER },
      select: { id: true, status: true },
    });
  });

  it("never touches phone rows", async () => {
    await post({ partnerCustomerId: PARTNER, wabaId: WABA });
    assert.equal(
      calls.some((c) => c.what.startsWith("wabaPhone.")),
      false,
      "unbind must not delete or read WabaPhone",
    );
  });

  it("is idempotent when already unbound", async () => {
    rows = [{ id: "wob_1", status: "DISCONNECTED" }];
    const response = await post({ partnerCustomerId: PARTNER, wabaId: WABA });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().unbound, false);
    assert.equal(response.json().code, "WABA_ALREADY_UNBOUND");
    assert.equal(
      calls.some((c) => c.what === "onboarding.updateMany"),
      false,
    );
  });

  it("reports never-bound honestly instead of claiming a successful unbind", async () => {
    rows = [];
    const response = await post({ partnerCustomerId: PARTNER, wabaId: WABA });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().unbound, false);
    assert.equal(response.json().code, "WABA_NOT_BOUND");
  });

  it("accepts supplierId as an alias for the tenant", async () => {
    const response = await post({ supplierId: PARTNER, wabaId: WABA });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().partnerCustomerId, PARTNER);
  });

  it("rejects invalid input", async () => {
    for (const bad of [
      {},
      { partnerCustomerId: PARTNER },
      { partnerCustomerId: PARTNER, wabaId: "abc" },
      { partnerCustomerId: "bad tenant!", wabaId: WABA },
      { partnerCustomerId: PARTNER, supplierId: "other", wabaId: WABA },
      { partnerCustomerId: PARTNER, wabaId: WABA, extra: 1 },
    ]) {
      const response = await post(bad);
      assert.equal(response.statusCode, 400, JSON.stringify(bad));
      assert.equal(response.json().code, "ADMIN_UNBIND_INVALID_INPUT");
    }
    assert.equal(calls.length, 0, "invalid input must not reach the database");
  });
});
