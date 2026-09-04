import { prisma } from "../prisma";
import { config } from "../config";
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

export class WabaIdRequiredError extends Error {
  readonly code = "WABA_ID_REQUIRED";
  readonly wabas: { wabaId: string; wabaName?: string | null; partnerCustomerId: string }[] = [];

  constructor() {
    super("缺少 wabaId：请从环境变量 YCLOUD_WABA_ID 读取后传入 ?wabaId= 或 body.wabaId");
    this.name = "WabaIdRequiredError";
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

export async function resolveWabaId(explicit?: string): Promise<string> {
  const id = explicit?.trim();
  if (id) return id;
  throw new WabaIdRequiredError();
}

/** 飞书入站回发用：只读本进程环境变量 YCLOUD_WABA_ID，不读库、不替智能体猜。 */
export async function resolveCurrentWabaId(explicit?: string): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  return config.ycloud.wabaId;
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
  const wabaId = await resolveCurrentWabaId();
  const unique = await listConnectedWabas();
  return {
    wabaId,
    wabaBound: Boolean(wabaId),
    wabaCount: unique.length || (wabaId ? 1 : 0),
    from: config.ycloud.from,
  };
}

export const WABA_REQUIRED_RESULT = {
  ok: false as const,
  code: "WHATSAPP_WABA_REQUIRED" as const,
  message:
    "尚未绑定 WABA。请从环境变量 YCLOUD_WABA_ID 读取后，在请求里传入 wabaId；没有则先走嵌入式注册。",
  next: {
    health: "GET /health",
    listWabas: "GET /api/whatsapp/wabas",
    createLink: "POST /api/whatsapp/onboarding-links",
  },
};

const PHONE_CACHE_MS = 60_000;
let phoneCache: { wabaId: string; numbers: string[]; at: number } | null = null;

export function invalidateWabaPhoneCache() {
  phoneCache = null;
}

export async function listCurrentWabaPhoneNumbers(wabaId: string): Promise<string[]> {
  if (phoneCache && phoneCache.wabaId === wabaId && Date.now() - phoneCache.at < PHONE_CACHE_MS) {
    return phoneCache.numbers;
  }
  const { phones } = await listWhatsAppPhones(wabaId);
  const numbers = [
    ...new Set(
      phones
        .map((item) => (item.phoneNumber ? toE164(item.phoneNumber) : ""))
        .filter(Boolean),
    ),
  ];
  phoneCache = { wabaId, numbers, at: Date.now() };
  return numbers;
}

export async function resolveBusinessFrom(
  requestedFrom: string | undefined,
  wabaId: string,
): Promise<
  | { ok: true; from: string; wabaId: string; phones: string[] }
  | {
      ok: false;
      code: "WHATSAPP_WABA_REQUIRED" | "WHATSAPP_PHONE_REQUIRED" | "WHATSAPP_FROM_NOT_IN_WABA";
      message: string;
      wabaId?: string;
      phones?: string[];
      next?: Record<string, string>;
    }
> {
  const id = wabaId.trim();
  if (!id) return WABA_REQUIRED_RESULT;

  let phones: string[];
  try {
    phones = await listCurrentWabaPhoneNumbers(id);
  } catch (error) {
    return {
      ok: false,
      code: "WHATSAPP_PHONE_REQUIRED",
      wabaId: id,
      message: `无法列出当前 WABA 企业号：${error instanceof Error ? error.message : String(error)}`,
      next: { listPhones: `GET /api/whatsapp/phones?wabaId=${id}` },
    };
  }
  if (!phones.length) {
    return {
      ok: false,
      code: "WHATSAPP_PHONE_REQUIRED",
      wabaId: id,
      message: "当前 WABA 下没有可用企业号，无法发送。请在 Meta / YCloud 完成号码接入后再试。",
      next: { listPhones: `GET /api/whatsapp/phones?wabaId=${id}` },
    };
  }

  const requested = requestedFrom?.trim() ? toE164(requestedFrom) : "";
  if (requested) {
    if (!phones.includes(requested)) {
      return {
        ok: false,
        code: "WHATSAPP_FROM_NOT_IN_WABA",
        wabaId: id,
        phones,
        message: `from 必须是当前 WABA（${id}）下的企业号。可用号码：${phones.join("、")}`,
        next: { listPhones: `GET /api/whatsapp/phones?wabaId=${id}` },
      };
    }
    return { ok: true, from: requested, wabaId: id, phones };
  }

  return { ok: true, from: phones[0], wabaId: id, phones };
}

async function persistCurrentWabaBinding(wabaId: string) {
  config.ycloud.wabaId = wabaId;
  process.env.YCLOUD_WABA_ID = wabaId;

  let from = config.ycloud.from;
  try {
    invalidateWabaPhoneCache();
    const phones = await listCurrentWabaPhoneNumbers(wabaId);
    const configured = from ? toE164(from) : "";
    from = configured && phones.includes(configured) ? configured : phones[0];
    if (from) {
      config.ycloud.from = from;
      process.env.YCLOUD_FROM = from;
    }
  } catch (error) {
    console.error("list current WABA phones after bind failed", error);
  }

  // 这里原先还会把 YCLOUD_WABA_ID / YCLOUD_FROM 写回 .env 文件。已移除：
  //   1. 冗余 —— 上面两处 appSetting.upsert 已经把同样的值写进了数据库，
  //      hydrateYCloudBindingFromStore() 启动时会读回来，重启不丢
  //   2. 在容器里根文件系统是只读的，写必然失败（原来被 catch 吞掉，是静默的）；
  //      就算能写，容器重启也会丢，多副本还会各写各的
}

export async function createOnboardingLink(input: {
  partnerCustomerId?: string;
  onboardingType?: string;
  locale?: string;
  sourceChatId?: string;
  sourceOpenId?: string;
}) {
  const normalized = normalizeEmbeddedSignupInput(input, {
    defaultPartnerCustomerId: config.cdpSupplierId,
  });
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
  const partnerCustomerId = query.partnerCustomerId?.trim() || config.cdpSupplierId;
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

  let row =
    (update.wabaId
      ? await prisma.wabaOnboarding.findFirst({
          where: { wabaId: update.wabaId },
          orderBy: { updatedAt: "desc" },
        })
      : null) ??
    (update.partnerCustomerId
      ? await prisma.wabaOnboarding.findFirst({
          where: { partnerCustomerId: update.partnerCustomerId, status: "PENDING" },
          orderBy: { createdAt: "desc" },
        })
      : null);

  if (row) {
    row = await prisma.wabaOnboarding.update({
      where: { id: row.id },
      data,
    });
  } else if (update.wabaId || update.partnerCustomerId) {
    row = await prisma.wabaOnboarding.create({
      data: {
        partnerCustomerId: update.partnerCustomerId || `waba_${update.wabaId}`,
        onboardingType: "WHATSAPP_BUSINESS_PLATFORM",
        status: partnerAdded ? "CONNECTED" : "UPDATED",
        ...data,
      },
    });
  }

  if (row && partnerAdded && row.wabaId) {
    try {
      await persistCurrentWabaBinding(row.wabaId);
    } catch (error) {
      console.error("persist YCLOUD_WABA_ID after bind failed", error);
    }
    try {
      await notifyWabaConnected(row);
    } catch (error) {
      console.error("notify WABA connected failed", error);
    }
  }
}

async function notifyWabaConnected(row: OnboardingRow) {
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
    config.ycloud.from ? `企业号：${config.ycloud.from}` : undefined,
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
