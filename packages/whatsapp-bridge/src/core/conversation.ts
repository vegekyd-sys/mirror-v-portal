import { prisma } from "../prisma";
import { toE164, windowExpiresFromNow } from "../lib/phone";
import type { NormalizedInbound } from "./types";

export async function claimWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: JSON.stringify(payload),
        processStatus: "PENDING",
      },
    });
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") return false;
    throw error;
  }
}

export async function markWebhookProcessed(provider: string, eventId: string, errorMessage?: string) {
  await prisma.webhookEvent.update({
    where: { provider_eventId: { provider, eventId } },
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

  let customer =
    (inbound.whatsappUserId
      ? await prisma.customer.findFirst({ where: { whatsappUserId: inbound.whatsappUserId } })
      : null) ??
    (inbound.whatsappParentUserId
      ? await prisma.customer.findFirst({
          where: { whatsappParentUserId: inbound.whatsappParentUserId },
        })
      : null) ??
    (phoneNumber ? await prisma.customer.findFirst({ where: { phoneNumber } }) : null);

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        phoneNumber,
        whatsappUserId: inbound.whatsappUserId,
        whatsappParentUserId: inbound.whatsappParentUserId,
        name: inbound.customerName,
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
    },
    create: {
      customerId: customer.id,
      businessPhone,
      status: "OPEN",
      lastInboundAt: new Date(),
      serviceWindowExpiresAt: windowExpiresFromNow(),
    },
    include: { customer: true },
  });
}

export async function saveInboundMessage(conversationId: string, inbound: NormalizedInbound) {
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
    },
  });
}

export async function getOrCreateConversation(customerPhone: string, businessPhoneRaw: string) {
  const phoneNumber = toE164(customerPhone);
  const businessPhone = toE164(businessPhoneRaw);

  let customer = phoneNumber
    ? await prisma.customer.findFirst({ where: { phoneNumber } })
    : null;
  if (!customer) {
    customer = await prisma.customer.create({ data: { phoneNumber } });
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
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      customerId: customer.id,
      businessPhone,
      status: "OPEN",
    },
    include: { customer: true },
  });
}

