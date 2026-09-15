import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { config } from "../config";
import { prisma } from "../prisma";
import {
  applyWabaAccountUpdate,
  invalidateWabaPhoneCache,
  listTenantBusinessPhones,
  resolveSupplierIdByBusinessPhone,
} from "./onboarding";
import { resolveConversationWabaId } from "./tenant";

/**
 * 共享 WABA 的端到端路由契约（2026-09-15）。
 *
 * 场景固定为「一个 WABA、两家 supplier、各自一个号」：
 *   WABA 12345678901 —— tenant-a 拥有 +85251111111，tenant-b 拥有 +85252222222。
 *
 * 这一层以前完全没有覆盖，而「唯一 owner」假设正是散落在这条链路上的。
 */

const WABA = "12345678901";
const PHONE_A = "+85251111111";
const PHONE_B = "+85252222222";

type PhoneRow = { wabaId: string; phoneNumber: string; supplierId: string };
type OnboardingRow = {
  id: string;
  wabaId: string | null;
  partnerCustomerId: string;
  status: string;
  updatedAt: Date;
  wabaName?: string | null;
  businessName?: string | null;
  paymentMethodAttached?: boolean | null;
  sourceChatId?: string | null;
  sourceOpenId?: string | null;
};

/** 支持这条链路实际用到的几种 where：相等、{ in }、{ not }。 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const cond = condition as { in?: unknown[]; not?: unknown };
      if (Array.isArray(cond.in)) return cond.in.includes(value);
      if ("not" in cond) return value !== cond.not;
    }
    return value === condition;
  });
}

describe("shared WABA routing (two suppliers, one WABA)", { concurrency: false }, () => {
  let phones: PhoneRow[] = [];
  let onboardings: OnboardingRow[] = [];
  let nextId = 0;
  let fetchCalls = 0;

  const client = {
    $queryRaw: async () => [{ locked: true }],
    wabaPhone: {
      findMany: async (args: { where?: Record<string, unknown> }) =>
        phones.filter((row) => matches(row, args.where || {})).map((row) => ({ ...row })),
      create: async (args: { data: PhoneRow }) => {
        phones.push({ ...args.data });
        return { ...args.data };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = phones.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    wabaOnboarding: {
      findMany: async (args: { where?: Record<string, unknown> }) =>
        onboardings.filter((row) => matches(row, args.where || {})).map((row) => ({ ...row })),
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        const hit = onboardings.filter((row) => matches(row, args.where || {}));
        return hit.length ? { ...hit[0] } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = onboardings.find((item) => item.id === args.where.id)!;
        Object.assign(row, args.data);
        return { ...row };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `onb-${++nextId}`, updatedAt: new Date(), ...args.data } as OnboardingRow;
        onboardings.push(row);
        return { ...row };
      },
    },
    // 通知链路：让它立刻失败（调用方 try/catch 会吞掉），不要去连真实的飞书/DB
    feishuApp: {
      findFirst: async () => null,
      findMany: async () => [],
    },
  };

  const mutable = prisma as unknown as Record<string, unknown>;
  const originals = {
    wabaPhone: mutable.wabaPhone,
    wabaOnboarding: mutable.wabaOnboarding,
    feishuApp: mutable.feishuApp,
    transaction: mutable.$transaction,
    queryRaw: mutable.$queryRaw,
    fetch: globalThis.fetch,
    apiKey: config.ycloud.apiKey,
  };

  before(() => {
    config.ycloud.apiKey = "test-ycloud-api-key";
    mutable.wabaPhone = client.wabaPhone;
    mutable.wabaOnboarding = client.wabaOnboarding;
    mutable.feishuApp = client.feishuApp;
    mutable.$queryRaw = client.$queryRaw;
    mutable.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(client);
    // YCloud 只回答「这个 WABA 上有哪些号」—— 两家的号都在里面。
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return Response.json({ items: [{ phoneNumber: PHONE_A }, { phoneNumber: PHONE_B }] });
    };
  });

  beforeEach(() => {
    // 同时清掉号码缓存和补认领的重试冷却
    invalidateWabaPhoneCache();
    nextId = 0;
    fetchCalls = 0;
    phones = [
      { wabaId: WABA, phoneNumber: PHONE_A, supplierId: "tenant-a" },
      { wabaId: WABA, phoneNumber: PHONE_B, supplierId: "tenant-b" },
    ];
    onboardings = [
      {
        id: "onb-a",
        wabaId: WABA,
        partnerCustomerId: "tenant-a",
        status: "CONNECTED",
        updatedAt: new Date(),
      },
      {
        id: "onb-b",
        wabaId: WABA,
        partnerCustomerId: "tenant-b",
        status: "CONNECTED",
        updatedAt: new Date(),
      },
    ];
  });

  after(() => {
    mutable.wabaPhone = originals.wabaPhone;
    mutable.wabaOnboarding = originals.wabaOnboarding;
    mutable.feishuApp = originals.feishuApp;
    mutable.$transaction = originals.transaction;
    mutable.$queryRaw = originals.queryRaw;
    globalThis.fetch = originals.fetch;
    config.ycloud.apiKey = originals.apiKey;
    invalidateWabaPhoneCache();
  });

  it("routes inbound to the owner of that phone, not the owner of the WABA", async () => {
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_A), "tenant-a");
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_B), "tenant-b");
  });

  it("stops routing inbound once the owner unbinds its last phone", async () => {
    phones = phones.filter((row) => row.phoneNumber !== PHONE_A);
    onboardings.find((row) => row.id === "onb-a")!.status = "DISCONNECTED";
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_A), undefined);
    // 同一个 WABA 上另一家不受影响
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_B), "tenant-b");
  });

  it("offers each tenant only its own numbers for outbound", async () => {
    assert.deepEqual(
      (await listTenantBusinessPhones("tenant-a")).map((item) => item.from),
      [PHONE_A],
    );
    assert.deepEqual(
      (await listTenantBusinessPhones("tenant-b")).map((item) => item.from),
      [PHONE_B],
    );
  });

  it("lets a Feishu reply go out on the tenant's own number", async () => {
    assert.equal(await resolveConversationWabaId("tenant-a", PHONE_A), WABA);
    assert.equal(await resolveConversationWabaId("tenant-b", PHONE_B), WABA);
  });

  it("blocks a Feishu reply on a co-tenant's number even though the WABA is shared", async () => {
    // 回归：共享 WABA 下「本租户在这个 WABA 上 CONNECTED」对所有共同租户恒真，
    // 不按手机号归属查就等于没有隔离。
    await assert.rejects(() => resolveConversationWabaId("tenant-a", PHONE_B), {
      code: "WABA_PHONE_BINDING_MISSING",
    });
  });

  it("blocks a Feishu reply on a number that was unbound and re-bound by someone else", async () => {
    // tenant-a 解绑 PHONE_A（只停路由，旧会话仍带着这个号）→ tenant-b 绑走它
    phones.find((row) => row.phoneNumber === PHONE_A)!.supplierId = "tenant-b";
    await assert.rejects(() => resolveConversationWabaId("tenant-a", PHONE_A), {
      code: "WABA_PHONE_BINDING_MISSING",
    });
    assert.equal(await resolveConversationWabaId("tenant-b", PHONE_A), WABA);
  });

  it("connects a second tenant onto an already-connected WABA without auto-claiming", async () => {
    // 以前这里会抛 "PARTNER_ADDED WABA is already connected to another tenant" —— 第二家永远接不进来。
    // 现在接得进来（status CONNECTED），但**不自动认领任何号**：
    // PARTNER_ADDED 的 payload 没有任何号码字段（Partner Direct Link 指南 §6），
    // 没有信号能说明本次接入对应哪个号，只能「认领所有无主号」——
    // 而这个 WABA 已经有别家 CONNECTED，说明是运营手工拆分的，抢号会踩到还没分配的号。
    phones = [{ wabaId: WABA, phoneNumber: PHONE_A, supplierId: "tenant-a" }];
    onboardings = [
      {
        id: "onb-a",
        wabaId: WABA,
        partnerCustomerId: "tenant-a",
        status: "CONNECTED",
        updatedAt: new Date(),
      },
    ];

    await applyWabaAccountUpdate({
      partnerCustomerId: "tenant-c",
      wabaId: WABA,
      updateEvent: "PARTNER_ADDED",
      eventId: "evt-1",
    } as Parameters<typeof applyWabaAccountUpdate>[0]);

    // 接入本身成功
    assert.equal(
      onboardings.find((row) => row.partnerCustomerId === "tenant-c")?.status,
      "CONNECTED",
    );
    // 别家的号原样不动
    assert.equal(phones.find((row) => row.phoneNumber === PHONE_A)?.supplierId, "tenant-a");
    // 未分配的号没有被抢走 —— 留给运营 import
    assert.equal(
      phones.find((row) => row.phoneNumber === PHONE_B),
      undefined,
      "共享 WABA 上不得自动认领未分配的号",
    );
  });

  it("claims every free number when the WABA has no other connected tenant", async () => {
    // 自助注册的常态：这家刚把自己的 WABA 连上来，上面的号都是他的。
    // 没有这一步，租户会卡在「状态 CONNECTED 但收发全断」。
    phones = [];
    onboardings = [];

    await applyWabaAccountUpdate({
      partnerCustomerId: "tenant-c",
      wabaId: WABA,
      updateEvent: "PARTNER_ADDED",
      eventId: "evt-1",
    } as Parameters<typeof applyWabaAccountUpdate>[0]);

    assert.deepEqual(
      phones.filter((row) => row.supplierId === "tenant-c").map((row) => row.phoneNumber).sort(),
      [PHONE_A, PHONE_B],
    );
    assert.deepEqual(
      (await listTenantBusinessPhones("tenant-c")).map((item) => item.from).sort(),
      [PHONE_A, PHONE_B],
    );
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_A), "tenant-c");
  });

  it("self-heals outbound when the PARTNER_ADDED claim missed the numbers", async () => {
    // PARTNER_ADDED 时 YCloud 还列不出号（认领踩空），而它是唯一触发认领的事件、
    // 且 webhook 先回 200 再异步处理 —— 没有任何重试。租户会卡成 CONNECTED 但收发全断。
    phones = [];
    onboardings = [
      {
        id: "onb-c",
        wabaId: WABA,
        partnerCustomerId: "tenant-c",
        status: "CONNECTED",
        updatedAt: new Date(),
      },
    ];

    // 第一次出站就地自愈，不再抛 WHATSAPP_BINDING_REQUIRED
    assert.deepEqual(
      (await listTenantBusinessPhones("tenant-c")).map((item) => item.from).sort(),
      [PHONE_A, PHONE_B],
    );
    assert.equal(phones.length, 2, "补认领应真的写出归属行");
  });

  it("self-heals inbound routing after a missed claim", async () => {
    phones = [];
    onboardings = [
      {
        id: "onb-c",
        wabaId: WABA,
        partnerCustomerId: "tenant-c",
        status: "CONNECTED",
        updatedAt: new Date(),
      },
    ];
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_A), "tenant-c");
  });

  it("does not touch YCloud when every connected tenant already owns numbers", async () => {
    // 兜底的闸门必须是纯 DB 的 —— healthy 状态下不能因为查不到号就去打 YCloud。
    const before = fetchCalls;
    assert.equal(await resolveSupplierIdByBusinessPhone("+85259999999"), undefined);
    assert.equal(fetchCalls, before, "无缺失归属时不得调用 YCloud");
  });

  it("claims a migration-era ownerless row instead of leaving it unroutable", async () => {
    phones = [{ wabaId: WABA, phoneNumber: PHONE_B, supplierId: "" }];
    onboardings = [];
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_B), undefined);

    await applyWabaAccountUpdate({
      partnerCustomerId: "tenant-d",
      wabaId: WABA,
      updateEvent: "PARTNER_ADDED",
      eventId: "evt-2",
    } as Parameters<typeof applyWabaAccountUpdate>[0]);

    assert.equal(phones.find((row) => row.phoneNumber === PHONE_B)?.supplierId, "tenant-d");
    assert.equal(await resolveSupplierIdByBusinessPhone(PHONE_B), "tenant-d");
  });
});
