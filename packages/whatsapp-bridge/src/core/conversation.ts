import { prisma } from "../prisma";
import { toE164, windowExpiresFromNow } from "../lib/phone";
import { resolveSupplierIdByBusinessPhone } from "./onboarding";
import { webhookTenantKey } from "./tenant";
import type { NormalizedInbound } from "./types";

export async function claimWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  context?: { supplierId?: string; fallbackScope?: string },
): Promise<boolean> {
  const supplierId = context?.supplierId?.trim() || undefined;
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: JSON.stringify(payload),
        processStatus: "PENDING",
        supplierId: supplierId || null,
        tenantKey: webhookTenantKey(supplierId, context?.fallbackScope),
      },
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") return false;
    throw error;
  }
}

export async function markWebhookProcessed(
  provider: string,
  eventId: string,
  context?: { supplierId?: string; fallbackScope?: string },
  errorMessage?: string,
) {
  const tenantKey = webhookTenantKey(context?.supplierId, context?.fallbackScope);
  await prisma.webhookEvent.update({
    where: { provider_tenantKey_eventId: { provider, tenantKey, eventId } },
    data: {
      processStatus: errorMessage ? "FAILED" : "PROCESSED",
      errorMessage,
      processedAt: new Date(),
    },
  });
}

export async function resolveConversation(inbound: NormalizedInbound) {
  const phoneNumber = toE164(inbound.customerPhone);
  const businessPhone = toE164(inbound.businessPhone);
  // inbound 消息按企业号反查租户；查不到（历史数据 / WabaPhone 未回填）则为 null。
  const supplierId = await resolveSupplierIdByBusinessPhone(inbound.businessPhone);
  const tenantWhere = supplierId ? { supplierId } : { supplierId: null };

  let customer =
    (inbound.whatsappUserId
      ? await prisma.customer.findFirst({
          where: { whatsappUserId: inbound.whatsappUserId, ...tenantWhere },
        })
      : null) ??
    (inbound.whatsappParentUserId
      ? await prisma.customer.findFirst({
          where: { whatsappParentUserId: inbound.whatsappParentUserId, ...tenantWhere },
        })
      : null) ??
    (phoneNumber
      ? await prisma.customer.findFirst({ where: { phoneNumber, ...tenantWhere } })
      : null);

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        phoneNumber,
        whatsappUserId: inbound.whatsappUserId,
        whatsappParentUserId: inbound.whatsappParentUserId,
        name: inbound.customerName,
        supplierId,
      },
    });
  } else {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: {
        phoneNumber: customer.phoneNumber || phoneNumber,
        whatsappUserId: customer.whatsappUserId || inbound.whatsappUserId,
        whatsappParentUserId: customer.whatsappParentUserId || inbound.whatsappParentUserId,
        name: inbound.customerName || customer.name,
        ...(supplierId ? { supplierId } : {}),
      },
    });
  }

  return prisma.conversation.upsert({
    where: {
      customerId_businessPhone: {
        customerId: customer.id,
        businessPhone,
      },
    },
    update: {
      status: "OPEN",
      lastInboundAt: new Date(),
      serviceWindowExpiresAt: windowExpiresFromNow(),
      ...(supplierId ? { supplierId } : {}),
    },
    create: {
      customerId: customer.id,
      businessPhone,
      status: "OPEN",
      lastInboundAt: new Date(),
      serviceWindowExpiresAt: windowExpiresFromNow(),
      supplierId,
    },
    include: { customer: true },
  });
}

export async function saveInboundMessage(
  conversationId: string,
  inbound: NormalizedInbound,
  supplierId?: string,
) {
  if (inbound.ycloudMessageId) {
    const existing = await prisma.message.findUnique({
      where: { ycloudMessageId: inbound.ycloudMessageId },
    });
    if (existing) return existing;
  }

  return prisma.message.create({
    data: {
      conversationId,
      direction: "inbound",
      source: "whatsapp",
      messageType: inbound.messageType,
      status: "received",
      content: inbound.text ?? JSON.stringify({ type: inbound.messageType }),
      ycloudMessageId: inbound.ycloudMessageId,
      wamid: inbound.wamid,
      supplierId: supplierId || null,
    },
  });
}

export async function getOrCreateConversation(
  customerPhone: string,
  businessPhoneRaw: string,
  supplierId: string,
) {
  const phoneNumber = toE164(customerPhone);
  const businessPhone = toE164(businessPhoneRaw);

  let customer = phoneNumber
    ? await prisma.customer.findFirst({ where: { phoneNumber, supplierId } })
    : null;
  if (!customer) {
    customer = await prisma.customer.create({ data: { phoneNumber, supplierId } });
  }

  const existing = await prisma.conversation.findUnique({
    where: {
      customerId_businessPhone: {
        customerId: customer.id,
        businessPhone,
      },
    },
    include: { customer: true },
  });
  if (existing) {
    if (existing.supplierId !== supplierId) {
      throw new Error("existing conversation tenant mismatch");
    }
    return existing;
  }

  return prisma.conversation.create({
    data: {
      customerId: customer.id,
      businessPhone,
      status: "OPEN",
      supplierId,
    },
    include: { customer: true },
  });
}
