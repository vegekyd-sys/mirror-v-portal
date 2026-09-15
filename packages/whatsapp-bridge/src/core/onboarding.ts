import { prisma } from "../prisma";
import type { WabaAccountUpdate } from "./types";
import {
  createEmbeddedSignupLink,
  listWhatsAppPhones,
  normalizeEmbeddedSignupInput,
} from "../channel/whatsapp/ycloud";
import { toE164 } from "../lib/phone";
import { ensureCsChatId } from "../platform/feishu/adapter";
import { ensureBotInChat, sendGroupText, sendUserText } from "../platform/feishu/client";
import { withFeishuApp } from "../platform/feishu/context";
import { lockWabaOwnershipKeys } from "./wabaOwnershipLock";

export class WhatsAppBindingError extends Error {
  readonly code:
    | "WHATSAPP_BINDING_REQUIRED"
    | "WHATSAPP_PHONE_REQUIRED"
    | "WHATSAPP_PHONE_LOOKUP_FAILED"
    | "WHATSAPP_FROM_SELECTION_REQUIRED"
    | "WHATSAPP_FROM_NOT_OWNED"
    | "WHATSAPP_FROM_AMBIGUOUS";
  readonly statusCode: number;
  readonly phones?: string[];

  constructor(
    code: WhatsAppBindingError["code"],
    message: string,
    statusCode = 409,
    phones?: string[],
  ) {
    super(message);
    this.name = "WhatsAppBindingError";
    this.code = code;
    this.statusCode = statusCode;
    this.phones = phones;
  }
}

type OnboardingRow = {
  id: string;
  partnerCustomerId: string;
  onboardingType: string;
  locale: string | null;
  onboardingUrl: string | null;
  expiresAt: Date | null;
  status: string;
  wabaId: string | null;
  wabaName: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
  businessName: string | null;
  accountReviewStatus: string | null;
  businessVerificationStatus: string | null;
  ownershipType: string | null;
  messagingLimit: string | null;
  paymentMethodAttached: boolean | null;
  updateEvent: string | null;
  sourceChatId: string | null;
  sourceOpenId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function publicOnboarding(row: OnboardingRow, opts?: { includeUrl?: boolean }) {
  const now = Date.now();
  const pendingUnexpired =
    row.status === "PENDING" && Boolean(row.expiresAt && row.expiresAt.getTime() > now);
  const includeUrl = opts?.includeUrl !== false && pendingUnexpired;
  return {
    id: row.id,
    partnerCustomerId: row.partnerCustomerId,
    onboardingType: row.onboardingType,
    locale: row.locale,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    expiresAtIso: row.expiresAt ? row.expiresAt.toISOString() : null,
    onboardingUrl: includeUrl ? row.onboardingUrl : undefined,
    wabaId: row.wabaId,
    wabaName: row.wabaName,
    phoneNumberId: row.phoneNumberId,
    businessId: row.businessId,
    businessName: row.businessName,
    accountReviewStatus: row.accountReviewStatus,
    businessVerificationStatus: row.businessVerificationStatus,
    ownershipType: row.ownershipType,
    messagingLimit: row.messagingLimit,
    paymentMethodAttached: row.paymentMethodAttached,
    updateEvent: row.updateEvent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function listConnectedWabas() {
  const connected = await prisma.wabaOnboarding.findMany({
    where: { status: "CONNECTED", wabaId: { not: null } },
    select: { wabaId: true, wabaName: true, partnerCustomerId: true },
    orderBy: { updatedAt: "desc" },
  });
  return [
    ...new Map(
      connected
        .filter((row): row is typeof row & { wabaId: string } => Boolean(row.wabaId))
        .map((row) => [row.wabaId, row]),
    ).values(),
  ];
}

export async function wabaHealth() {
  const unique = await listConnectedWabas();
  return {
    wabaCount: unique.length,
  };
}

const PHONE_CACHE_MS = 60_000;
const phoneCache = new Map<string, { numbers: string[]; at: number }>();

export function invalidateWabaPhoneCache(wabaId?: string) {
  if (wabaId) phoneCache.delete(wabaId);
  else phoneCache.clear();
}

/**
 * 刷新 WabaPhone 的 updatedAt —— **不再创建归属行**。
 *
 * 2026-09-15 起归属只能由显式绑定（POST /api/admin/whatsapp/import-existing-waba）建立：
 * 一个 WABA 可被多个 supplier 共享，YCloud 的号码列表只回答「这个 WABA 有哪些号」，
 * 而「哪个号归谁」只有绑定表说了算。这里若继续 create，就会把别家的号重新插回来
 * （全局唯一键冲突）或写出无归属的行。
 */
export async function upsertWabaPhones(wabaId: string, numbers: string[]): Promise<void> {
  if (!wabaId || !numbers.length) return;
  try {
    for (const phoneNumber of numbers) {
      await prisma.wabaPhone.updateMany({
        where: { wabaId, phoneNumber },
        data: { updatedAt: new Date() },
      });
    }
  } catch (error) {
    console.error("refresh WabaPhone mapping failed", error);
  }
}

/** 按 wabaId 反查租户 supplierId（= partnerCustomerId）。 */
export async function resolveSupplierIdByWabaId(wabaId: string): Promise<string | undefined> {
  if (!wabaId) return undefined;
  const rows = await prisma.wabaOnboarding.findMany({
    where: { wabaId, status: "CONNECTED" },
    select: { partnerCustomerId: true },
  });
  const owners = [...new Set(rows.map((row) => row.partnerCustomerId).filter(Boolean))];
  return owners.length === 1 ? owners[0] : undefined;
}

/** inbound 消息按 businessPhone（E.164 企业号）反查租户 supplierId。 */
/**
 * businessPhone → supplierId（**手机号级归属**，2026-09-15）。
 *
 * 共享 WABA 后不能再靠「这个 WABA 的 owner 是谁」推断租户 —— 一个 WABA 会有多个 owner。
 * 归属唯一定在手机号上：直接读 WabaPhone.supplierId，再校验该 supplier 在这个 WABA 上
 * 仍是 CONNECTED（解绑最后一个号后会置 DISCONNECTED，避免继续路由到已解绑的号）。
 */
export async function resolveSupplierIdByBusinessPhone(
  businessPhone: string,
): Promise<string | undefined> {
  const phone = toE164(businessPhone);
  if (!phone) return undefined;
  const rows = await prisma.wabaPhone.findMany({
    where: { phoneNumber: phone },
    select: { wabaId: true, supplierId: true },
  });
  const owners = [...new Set(rows.map((row) => row.supplierId).filter(Boolean))];
  if (owners.length !== 1) return undefined;
  const supplierId = owners[0];
  const connected = await prisma.wabaOnboarding.findMany({
    where: {
      wabaId: { in: [...new Set(rows.map((row) => row.wabaId))] },
      partnerCustomerId: supplierId,
      status: "CONNECTED",
    },
    select: { id: true },
  });
  return connected.length ? supplierId : undefined;
}

export async function listCurrentWabaPhoneNumbers(wabaId: string): Promise<string[]> {
  const cached = phoneCache.get(wabaId);
  if (cached && Date.now() - cached.at < PHONE_CACHE_MS) {
    return cached.numbers;
  }
  const { phones } = await listWhatsAppPhones(wabaId);
  const numbers = [
    ...new Set(
      phones
        .map((item) => (item.phoneNumber ? toE164(item.phoneNumber) : ""))
        .filter(Boolean),
    ),
  ];
  phoneCache.set(wabaId, { numbers, at: Date.now() });
  // cache miss 时同步回填 WabaPhone，保证 inbound 能反查到租户。
  await upsertWabaPhones(wabaId, numbers);
  return numbers;
}

export type TenantBusinessPhone = {
  /** Internal-only routing key. Never include this field in routine HTTP responses. */
  wabaId: string;
  from: string;
};

/**
 * Resolve every eligible business phone for a supplier from its CONNECTED onboarding rows.
 * YCloud is queried per WABA (with a short cache), and the WabaPhone table is refreshed as a
 * side effect so webhook and Feishu-reply routing keep using the same mapping.
 */
export async function listTenantBusinessPhones(supplierId: string): Promise<TenantBusinessPhone[]> {
  const connected = await prisma.wabaOnboarding.findMany({
    where: { partnerCustomerId: supplierId, status: "CONNECTED", wabaId: { not: null } },
    select: { wabaId: true, partnerCustomerId: true, status: true },
    orderBy: { updatedAt: "desc" },
  });
  const wabaIds = [
    ...new Set(connected.map((row) => row.wabaId).filter((id): id is string => Boolean(id))),
  ];
  if (!wabaIds.length) {
    throw new WhatsAppBindingError(
      "WHATSAPP_BINDING_REQUIRED",
      "当前租户没有 CONNECTED WhatsApp 绑定，请先完成嵌入式注册。",
    );
  }

  // 共享 WABA（2026-09-15）：一个 WABA 会有多个 CONNECTED 的 supplier，
  // 因此这里**不再**要求「WABA 只有唯一 owner」（那会直接拒掉正当共享）。
  // 隔离改由手机号级归属保证 —— 见下面 scoped 过滤。

  const candidates: TenantBusinessPhone[] = [];
  for (const wabaId of wabaIds) {
    let phones: string[];
    try {
      phones = await listCurrentWabaPhoneNumbers(wabaId);
    } catch (error) {
      console.error("resolve tenant WhatsApp business phones failed", error);
      throw new WhatsAppBindingError(
        "WHATSAPP_PHONE_LOOKUP_FAILED",
        "暂时无法解析当前租户的 WhatsApp 企业号，请稍后重试。",
        502,
      );
    }
    for (const from of phones) candidates.push({ wabaId, from });
  }
  if (!candidates.length) {
    throw new WhatsAppBindingError(
      "WHATSAPP_PHONE_REQUIRED",
      "当前租户没有可用 WhatsApp 企业号，请先在 Meta / YCloud 完成号码接入。",
    );
  }

  // 只保留**归本租户所有**的号（WabaPhone.supplierId）。
  // 共享 WABA 下 YCloud 返回的号码列表包含别家的号 —— 不过滤就会跨租户泄漏/误发。
  const owned = await prisma.wabaPhone.findMany({
    where: { supplierId, phoneNumber: { in: candidates.map((candidate) => candidate.from) } },
    select: { phoneNumber: true },
  });
  const ownedSet = new Set(owned.map((row) => row.phoneNumber));
  const scoped = candidates.filter((candidate) => ownedSet.has(candidate.from));
  if (!scoped.length) {
    throw new WhatsAppBindingError(
      "WHATSAPP_BINDING_REQUIRED",
      "当前租户没有已绑定的 WhatsApp 手机号，请先绑定（绑定必须指定手机号）。",
    );
  }
  return scoped;
}

/** Select one internal WABA/phone route without exposing WABA identity to the caller. */
export async function resolveTenantBusinessPhone(
  supplierId: string,
  requestedFrom?: string,
): Promise<{ selected: TenantBusinessPhone; phones: string[] }> {
  const candidates = await listTenantBusinessPhones(supplierId);
  const phones = [...new Set(candidates.map((candidate) => candidate.from))].sort();
  const requested = requestedFrom?.trim() ? toE164(requestedFrom) : "";

  if (requested) {
    const matches = candidates.filter((candidate) => candidate.from === requested);
    if (matches.length === 0) {
      throw new WhatsAppBindingError(
        "WHATSAPP_FROM_NOT_OWNED",
        "from 不是当前租户已绑定的 WhatsApp 企业号。",
        403,
        phones,
      );
    }
    if (matches.length > 1) {
      throw new WhatsAppBindingError(
        "WHATSAPP_FROM_AMBIGUOUS",
        "from 在当前租户内匹配多个 WhatsApp 绑定，已拒绝操作。",
        409,
        phones,
      );
    }
    return { selected: matches[0], phones };
  }

  if (candidates.length > 1) {
    throw new WhatsAppBindingError(
      "WHATSAPP_FROM_SELECTION_REQUIRED",
      "当前租户有多个可用 WhatsApp 企业号，请从 phones 中选择并传入 from。",
      409,
      phones,
    );
  }
  return { selected: candidates[0], phones };
}

/**
 * WABA 账号更新（PARTNER_ADDED）后的企业号回查。
 *
 * 共享 WABA 下不能取「该 WABA 的第一个号」—— 那可能是别家的号，
 * 会出现在给本租户的通知文案里（跨租户信息泄露）。只回本租户拥有的号。
 */
async function syncWabaPhoneBinding(
  wabaId: string,
  supplierId: string,
): Promise<string | undefined> {
  try {
    invalidateWabaPhoneCache(wabaId);
    const phones = await listCurrentWabaPhoneNumbers(wabaId);
    if (!phones.length || !supplierId) return undefined;
    const owned = await prisma.wabaPhone.findMany({
      where: { wabaId, supplierId, phoneNumber: { in: phones } },
      select: { phoneNumber: true },
    });
    const ownedSet = new Set(owned.map((row) => row.phoneNumber));
    return phones.find((phone) => ownedSet.has(phone));
  } catch (error) {
    console.error("sync WABA phone binding after PARTNER_ADDED failed", error);
    return undefined;
  }
}

export async function createOnboardingLink(input: {
  partnerCustomerId?: string;
  onboardingType?: string;
  locale?: string;
  sourceChatId?: string;
  sourceOpenId?: string;
}) {
  const normalized = normalizeEmbeddedSignupInput(input);
  if (!normalized.ok) {
    const error = new Error(normalized.error);
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  const created = await createEmbeddedSignupLink({
    partnerCustomerId: normalized.partnerCustomerId,
    onboardingType: normalized.onboardingType,
    locale: normalized.locale,
  });

  const row = await prisma.wabaOnboarding.create({
    data: {
      partnerCustomerId: normalized.partnerCustomerId,
      onboardingType: normalized.onboardingType,
      locale: normalized.locale,
      onboardingUrl: created.onboardingUrl,
      expiresAt: new Date(created.expiresAt),
      status: "PENDING",
      sourceChatId: input.sourceChatId?.trim() || null,
      sourceOpenId: input.sourceOpenId?.trim() || null,
    },
  });

  return {
    ok: true as const,
    partnerCustomerIdSource: normalized.partnerCustomerIdSource,
    ...publicOnboarding(row, { includeUrl: true }),
    hint: "把 onboardingUrl 交给该客户：2 小时内打开并点击 Continue with Meta。一链一次 WABA，不要公开分享。绑定结果以 Webhook / GET /api/whatsapp/wabas 为准。",
  };
}

export async function listWabaOnboardings(query: {
  partnerCustomerId?: string;
  wabaId?: string;
  status?: string;
}) {
  const partnerCustomerId = query.partnerCustomerId?.trim();
  const wabaId = query.wabaId?.trim();
  const status = query.status?.trim();
  const rows = await prisma.wabaOnboarding.findMany({
    where: {
      ...(partnerCustomerId ? { partnerCustomerId } : {}),
      ...(wabaId ? { wabaId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return {
    partnerCustomerId: partnerCustomerId || undefined,
    wabas: rows.map((row) => publicOnboarding(row)),
  };
}

export async function applyWabaAccountUpdate(update: WabaAccountUpdate) {
  const partnerAdded = update.updateEvent === "PARTNER_ADDED" && Boolean(update.wabaId);
  const data = {
    wabaId: update.wabaId,
    wabaName: update.wabaName,
    phoneNumberId: update.phoneNumberId,
    businessId: update.businessId,
    businessName: update.businessName,
    accountReviewStatus: update.accountReviewStatus,
    businessVerificationStatus: update.businessVerificationStatus,
    ownershipType: update.ownershipType,
    messagingLimit: update.messagingLimit,
    paymentMethodAttached: update.paymentMethodAttached,
    updateEvent: update.updateEvent,
    lastEventId: update.eventId,
    ...(partnerAdded ? { status: "CONNECTED" as const } : {}),
  };

  const row = await prisma.$transaction(
    async (tx) => {
      if (partnerAdded && update.wabaId) {
        await lockWabaOwnershipKeys(tx, update.wabaId, []);
        if (update.partnerCustomerId) {
          const existingOwners = await tx.wabaOnboarding.findMany({
            where: { wabaId: update.wabaId, status: "CONNECTED" },
            select: { partnerCustomerId: true },
          });
          if (existingOwners.some((owner) => owner.partnerCustomerId !== update.partnerCustomerId)) {
            throw new Error("PARTNER_ADDED WABA is already connected to another tenant");
          }
        }
      }

      let current =
        (update.wabaId && update.partnerCustomerId
          ? await tx.wabaOnboarding.findFirst({
              where: {
                wabaId: update.wabaId,
                partnerCustomerId: update.partnerCustomerId,
              },
              orderBy: { updatedAt: "desc" },
            })
          : null) ??
        (update.partnerCustomerId
          ? await tx.wabaOnboarding.findFirst({
              where: { partnerCustomerId: update.partnerCustomerId, status: "PENDING" },
              orderBy: { createdAt: "desc" },
            })
          : null) ??
        (update.wabaId && !update.partnerCustomerId
          ? await tx.wabaOnboarding.findFirst({
              where: { wabaId: update.wabaId },
              orderBy: { updatedAt: "desc" },
            })
          : null);

      if (current) {
        current = await tx.wabaOnboarding.update({
          where: { id: current.id },
          data,
        });
      } else if (update.wabaId || update.partnerCustomerId) {
        current = await tx.wabaOnboarding.create({
          data: {
            partnerCustomerId: update.partnerCustomerId || `waba_${update.wabaId}`,
            onboardingType: "WHATSAPP_BUSINESS_PLATFORM",
            status: partnerAdded ? "CONNECTED" : "UPDATED",
            ...data,
          },
        });
      }
      return current;
    },
    { isolationLevel: "Serializable" },
  );

  if (row && partnerAdded && row.wabaId) {
    const businessPhone = await syncWabaPhoneBinding(row.wabaId, row.partnerCustomerId);
    try {
      await notifyWabaConnected(row, businessPhone);
    } catch (error) {
      console.error("notify WABA connected failed", error);
    }
  }
}

async function notifyWabaConnected(row: OnboardingRow, businessPhone?: string) {
  const credit =
    row.paymentMethodAttached === true
      ? "授信已完成，WABA 可使用"
      : row.paymentMethodAttached === false
        ? "授信尚未完成，WABA 可能还不能发消息"
        : "授信状态未知";
  const text = [
    "系统：WhatsApp WABA 已通过嵌入式注册绑定",
    `客户：${row.partnerCustomerId}`,
    row.wabaName || row.wabaId ? `WABA：${row.wabaName || "-"}（${row.wabaId || "-"}）` : undefined,
    businessPhone ? `企业号：${businessPhone}` : undefined,
    row.businessName ? `业务：${row.businessName}` : undefined,
    credit,
  ]
    .filter(Boolean)
    .join("\n");

  await withFeishuApp(undefined, async () => {
  let groupOk = false;
  const chatIds: string[] = [];
  if (row.sourceChatId?.trim()) chatIds.push(row.sourceChatId.trim());
  try {
    chatIds.push(await ensureCsChatId(row.sourceOpenId ? [row.sourceOpenId] : []));
  } catch (error) {
    console.error("resolve CS chat for WABA notify failed", error);
  }

  for (const chatId of [...new Set(chatIds)]) {
    try {
      await ensureBotInChat(chatId);
      await sendGroupText(chatId, text);
      groupOk = true;
    } catch (error) {
      console.error(`notify WABA connected chat ${chatId} failed`, error);
    }
  }

  if (!groupOk && row.sourceOpenId?.trim()) {
    try {
      await sendUserText(row.sourceOpenId.trim(), `${text}\n（桥接未能进群，已私聊提醒）`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("99992361") || msg.includes("open_id cross app")) return;
      console.error("notify WABA connected DM failed", msg);
    }
  }
  });
}
