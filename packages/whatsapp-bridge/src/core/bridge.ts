import { prisma } from "../prisma";
import { config } from "../config";
import { isWindowOpen, toE164 } from "../lib/phone";
import type { DeliveryUpdate, NormalizedInbound } from "./types";
import { getOrCreateConversation, resolveConversation, saveInboundMessage } from "./conversation";
import { WABA_REQUIRED_RESULT, resolveBusinessFrom } from "./onboarding";
import {
  assertTenantOwnsWaba,
  resolveConversationWabaId,
  resolveTenantContext,
} from "./tenant";
import { sendWhatsAppImage, sendWhatsAppTemplate, sendWhatsAppText, uploadWhatsAppMedia, buildTemplatePreview, downloadWhatsAppMedia } from "../channel/whatsapp/ycloud";
import {
  ensureFeishuThread,
  findThreadByFeishuId,
  markFeishuMessageRead,
  notifyWatchChats,
  postImageToFeishuThread,
  postToFeishuThread,
} from "../platform/feishu/adapter";
import { downloadMessageResource, ensureBotInChat } from "../platform/feishu/client";
import { isAllowedCsWhatsAppReply, isFeishuAtMention, type FeishuInboundMessage } from "../platform/feishu/crypto";
import { requireFeishuApp, withFeishuApp } from "../platform/feishu/context";
import { parseCliAppIds, saveFeishuInviteAppIds } from "../platform/feishu/apps";

function previewText(inbound: NormalizedInbound): string {
  if (inbound.messageType === "text" && inbound.text) return inbound.text;
  if (inbound.messageType === "image") {
    return inbound.media?.caption || inbound.text || "[图片]";
  }
  return `[${inbound.messageType}] 暂不支持同步此类型，请在 WhatsApp 查看原文`;
}

async function syncInboundImageToFeishu(
  thread: { chatId: string; threadId: string; rootMessageId: string },
  inbound: NormalizedInbound,
): Promise<string | undefined> {
  const file = await downloadWhatsAppMedia({
    link: inbound.media?.link,
    id: inbound.media?.id,
    mimeType: inbound.media?.mimeType,
  });
  return postImageToFeishuThread(thread, file);
}

export async function handleWhatsAppInbound(inbound: NormalizedInbound) {
  const conversation = await resolveConversation(inbound);
  await saveInboundMessage(conversation.id, inbound, conversation.supplierId || undefined);

  await withFeishuApp(conversation.feishuAppId || undefined, async () => {
    const app = requireFeishuApp();
    if (app.appId !== conversation.feishuAppId) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { feishuAppId: app.appId },
      });
    }

    const text = previewText(inbound);
    const customerPhone = conversation.customer.phoneNumber || inbound.customerPhone;
    const customerName = conversation.customer.name || inbound.customerName;
    const customerAlias =
      inbound.whatsappUserId || inbound.whatsappParentUserId || conversation.customer.whatsappUserId || undefined;
    const thread = await ensureFeishuThread({
      conversationId: conversation.id,
      customerPhone,
      businessPhone: conversation.businessPhone,
      customerName,
      customerAlias,
      firstText: `买家：${text}`,
      memberOpenIds: conversation.sourceOpenId ? [conversation.sourceOpenId] : undefined,
    });

  if (!thread.firstMessagePosted) {
    const feishuMessageId = await postToFeishuThread(thread, `买家：${text}`, { notify: true });
    if (inbound.ycloudMessageId && feishuMessageId) {
      await prisma.message.updateMany({
        where: { ycloudMessageId: inbound.ycloudMessageId },
        data: { feishuMessageId },
      });
    }
  }

  if (inbound.messageType === "image") {
    try {
      const imageMessageId = await syncInboundImageToFeishu(thread, inbound);
      if (inbound.ycloudMessageId && imageMessageId) {
        await prisma.message.updateMany({
          where: { ycloudMessageId: inbound.ycloudMessageId },
          data: { feishuMessageId: imageMessageId },
        });
      }
    } catch (error) {
      console.error("sync inbound WhatsApp image to Feishu failed", error);
      const reason = error instanceof Error ? error.message : String(error);
      await postToFeishuThread(
        thread,
        `系统：图片同步失败，请在 WhatsApp 查看原文。${reason.slice(0, 180)}`,
      );
    }
  }

  try {
    const origin = conversation as typeof conversation & {
      sourceChatId?: string | null;
      sourceOpenId?: string | null;
    };
    await notifyWatchChats({
      customerPhone,
      customerName,
      businessPhone: conversation.businessPhone,
      text,
      thread,
      isNewThread: thread.firstMessagePosted,
      sourceChatId: origin.sourceChatId,
      sourceOpenId: origin.sourceOpenId,
    });
  } catch (error) {
    console.error("notify watch chats failed", error);
  }
  });
}

export async function handleWhatsAppStatus(update: DeliveryUpdate) {
  const message = await prisma.message.findUnique({
    where: { ycloudMessageId: update.ycloudMessageId },
  });
  if (!message) return;

  const prevStatus = message.status.toLowerCase();
  const nextStatus = update.status.toLowerCase();
  const wasRead = prevStatus === "read" || Boolean(message.readAt);
  const nowRead = nextStatus === "read" || Boolean(update.readAt);
  const becameFailed = nextStatus === "failed" && prevStatus !== "failed";

  await prisma.message.update({
    where: { id: message.id },
    data: {
      status: update.status,
      wamid: update.wamid || message.wamid,
      errorCode: update.errorCode,
      errorMessage: update.errorMessage,
      sentAt: update.sentAt ? new Date(update.sentAt) : message.sentAt,
      deliveredAt: update.deliveredAt ? new Date(update.deliveredAt) : message.deliveredAt,
      readAt: update.readAt ? new Date(update.readAt) : message.readAt,
    },
  });

  if (update.expireTime) {
    await prisma.conversation.update({
      where: { id: message.conversationId },
      data: { serviceWindowExpiresAt: new Date(update.expireTime) },
    });
  }

  if (message.direction !== "outbound") return;

  const conv = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    select: { feishuAppId: true },
  });

  try {
    await withFeishuApp(conv?.feishuAppId || undefined, async () => {
    const mapping = await prisma.platformThread.findUnique({
      where: {
        conversationId_platform: {
          conversationId: message.conversationId,
          platform: "feishu",
        },
      },
    });
    if (!mapping) return;

    const thread = {
      chatId: mapping.chatId,
      threadId: mapping.threadId,
      rootMessageId: mapping.rootMessageId,
    };

    if (becameFailed) {
      const preview = message.content.trim();
      const short = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
      const reason = explainDeliveryFailure(update.errorCode, update.errorMessage);
      await postToFeishuThread(
        thread,
        [
          "系统：WhatsApp 发送失败（买家未收到）",
          short ? `内容：${short}` : undefined,
          update.errorCode ? `错误码：${update.errorCode}` : undefined,
          reason,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    if (!nowRead || wasRead) return;

    if (!message.feishuMessageId) {
      console.info(`skip Feishu read receipt: no feishuMessageId for ${message.id}`);
      return;
    }
    try {
      await markFeishuMessageRead(message.feishuMessageId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("230011") || msg.includes("already") || msg.includes("duplicate")) {
        return;
      }
      throw error;
    }
    });
  } catch (error) {
    console.error("sync WhatsApp status to Feishu failed", error);
  }
}

function explainDeliveryFailure(code?: string, message?: string): string {
  if (code === "131049" || message?.includes("healthy ecosystem engagement")) {
    return "原因：Meta 风控未投递（常见于营销模板 / 频控 / 用户互动质量）。这不代表桥接受理成功就算送达；请换模板、降低频率或换更活跃的买家号再试。";
  }
  if (code === "131026" || message?.toLowerCase().includes("undeliverable")) {
    return "原因：号码无法投递（未开通 WhatsApp / 无效号码等）。";
  }
  if (message) return `原因：${message}`;
  return "原因：未知，请查看 YCloud / Meta 投递日志。";
}

function ycloudSendErrorInfo(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("MESSAGING_REGION_UNSUPPORTED") || raw.includes("Mainland China (+86)")) {
    return {
      code: "MESSAGING_REGION_UNSUPPORTED",
      message: "YCloud 不支持向中国大陆（+86）号码发送 WhatsApp。请用非 +86 的买家号测试回发（如 +852 / +65）。收信不受此限制。",
    };
  }
  return { code: "YCLOUD_SEND_FAILED", message: `系统：回发 WhatsApp 失败。${raw}` };
}

export async function handleFeishuInbound(inbound: FeishuInboundMessage) {
  if (
    !isAllowedCsWhatsAppReply(inbound, {
      selfAppId: requireFeishuApp().appId,
      inviteAppIds: config.feishu.inviteAppIds.concat(requireFeishuApp().inviteAppIds),
    })
  ) {
    console.info(
      `skip Feishu sender not allowed to reply WhatsApp: type=${inbound.senderType || "unknown"} app=${inbound.senderAppId || "-"}`,
    );
    return;
  }
  if (!inbound.threadId) return;
  if (isFeishuAtMention(inbound)) {
    console.info(`skip Feishu @mention, not sending to WhatsApp: ${inbound.messageId}`);
    return;
  }

  const isText = inbound.messageType === "text" && Boolean(inbound.text?.trim());
  const isImage = inbound.messageType === "image" && Boolean(inbound.imageKey);
  if (!isText && !isImage) {
    if (inbound.messageType !== "text") {
      const mapping = await findThreadByFeishuId(inbound.threadId);
      if (mapping) {
        await postToFeishuThread(
          mapping,
          `系统：暂不支持把「${inbound.messageType}」同步到 WhatsApp，请发文字或图片。`,
        );
      }
    }
    return;
  }

  const mapping = await findThreadByFeishuId(inbound.threadId);
  if (!mapping) return;

  const conversation = mapping.conversation;
  const customerPhone = conversation.customer.phoneNumber;
  if (!customerPhone) {
    await postToFeishuThread(mapping, "系统：找不到买家手机号，无法回发 WhatsApp。");
    return;
  }

  try {
    await resolveConversationWabaId(conversation.supplierId, conversation.businessPhone);
  } catch (error) {
    console.error("resolve tenant WABA for Feishu reply failed", error);
    await postToFeishuThread(
      mapping,
      "系统：该话题缺少有效的租户 WABA 绑定，已阻止回发。请按当前 supplierId 重新确认 WABA 与企业号绑定。",
    );
    return;
  }

  if (!isWindowOpen(conversation.serviceWindowExpiresAt)) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "outbound",
        source: "feishu",
        messageType: isImage ? "image" : "text",
        status: "failed",
        content: isImage ? `[image]${inbound.imageKey}` : inbound.text!,
        feishuMessageId: inbound.messageId,
        errorCode: "WHATSAPP_TEMPLATE_REQUIRED",
        errorMessage: "24h service window closed",
        supplierId: conversation.supplierId || undefined,
      },
    });
    await postToFeishuThread(
      mapping,
      "系统：WhatsApp 24 小时会话窗口已关闭，不能发自由文本/图片。请改用已批准模板，或等买家再来一条消息。",
    );
    return;
  }

  try {
    let sent;
    let content: string;
    let messageType: string;

    if (isImage) {
      const file = await downloadMessageResource(inbound.messageId, inbound.imageKey!, "image");
      // WhatsApp 图片仅支持 jpeg/png；其它类型仍上传，失败时提示
      const mediaId = await uploadWhatsAppMedia(conversation.businessPhone, {
        buffer: file.buffer,
        filename: file.filename,
        contentType: file.contentType,
      });
      const caption = inbound.text?.trim() || undefined;
      sent = await sendWhatsAppImage(conversation.businessPhone, customerPhone, {
        id: mediaId,
        caption,
      });
      content = caption ? `[image] ${caption}` : "[image]";
      messageType = "image";
    } else {
      sent = await sendWhatsAppText(conversation.businessPhone, customerPhone, inbound.text!);
      content = inbound.text!;
      messageType = "text";
    }

    const ycloudMessageId =
      typeof sent.id === "string"
        ? sent.id
        : typeof sent.messageId === "string"
          ? sent.messageId
          : undefined;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "outbound",
        source: "feishu",
        messageType,
        status: "accepted",
        content,
        feishuMessageId: inbound.messageId,
        ycloudMessageId,
        supplierId: conversation.supplierId || undefined,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastOutboundAt: new Date() },
    });
  } catch (error) {
    const info = ycloudSendErrorInfo(error);
    const raw = error instanceof Error ? error.message : String(error);
    const hint =
      raw.includes("234009") || raw.includes("外部群")
        ? "（飞书外部群可能无法下载图片资源，请在内部客服群话题发图）"
        : "";
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "outbound",
        source: "feishu",
        messageType: isImage ? "image" : "text",
        status: "failed",
        content: isImage ? `[image]${inbound.imageKey}` : inbound.text || "",
        feishuMessageId: inbound.messageId,
        errorCode: info.code,
        errorMessage: `${info.message}${hint}`,
        supplierId: conversation.supplierId || undefined,
      },
    });
    await postToFeishuThread(mapping, `系统：${info.message}${hint}`);
  }
}

export async function handleAgentSend(input: {
  to: string;
  text?: string;
  from?: string;
  /** 当前租户上下文；两者可任选其一，同时传时必须一致 */
  partnerCustomerId?: string;
  supplierId?: string;
  /** 从当前租户 CONNECTED WABA 绑定查询后传入 */
  wabaId?: string;
  /** 智能体初始化注册的飞书应用 */
  feishuAppId?: string;
  /** 智能体所在飞书群 chat_id；买家回复时提醒该群 */
  sourceChatId?: string;
  /** 发起人 open_id；群提醒失败时私聊兜底 */
  sourceOpenId?: string;
  inviteAppIds?: string | string[];
  template?: { name: string; language: string; components?: unknown[] };
}) {
  const supplierId = resolveTenantContext(input);
  const wabaId = input.wabaId?.trim();
  if (!wabaId) {
    return WABA_REQUIRED_RESULT;
  }
  await assertTenantOwnsWaba(supplierId, wabaId);

  const fromResolved = await resolveBusinessFrom(input.from, wabaId, supplierId);
  if (!fromResolved.ok) return fromResolved;

  const businessPhone = fromResolved.from;
  const customerPhone = toE164(input.to);
  if (!customerPhone) throw new Error("缺少收件人 to（E.164）");

  const conversation = await getOrCreateConversation(customerPhone, businessPhone, supplierId);
  const useTemplate = Boolean(input.template?.name);
  const text = input.text?.trim() || "";
  const sourceChatId = input.sourceChatId?.trim() || undefined;
  const sourceOpenId = input.sourceOpenId?.trim() || undefined;

  const windowOpen = isWindowOpen(conversation.serviceWindowExpiresAt);

  if (!useTemplate && !text) throw new Error("缺少 text，或提供 template");

  if (!useTemplate && !windowOpen) {
    return {
      ok: false as const,
      code: "WHATSAPP_TEMPLATE_REQUIRED",
      message:
        "24 小时会话窗口已关闭，不能发自由文本。请带当前 partnerCustomerId 与 wabaId 查询模板，填好 template.components 后再发。",
      next: {
        listTemplates: `GET /api/whatsapp/templates?wabaId=${fromResolved.wabaId}&partnerCustomerId=${encodeURIComponent(supplierId)}`,
        listTemplateByName: `GET /api/whatsapp/templates?name=模板名&wabaId=${fromResolved.wabaId}&partnerCustomerId=${encodeURIComponent(supplierId)}`,
        sendWithTemplate: "POST /api/whatsapp/messages 带 partnerCustomerId、wabaId、from=当前租户WABA企业号以及 template",
      },
      windowOpen: false as const,
      from: businessPhone,
      wabaId: fromResolved.wabaId,
    };
  }

  let sent;
  try {
    sent = useTemplate
      ? await sendWhatsAppTemplate(conversation.businessPhone, customerPhone, {
          name: input.template!.name,
          language: input.template!.language || "en",
          components: input.template!.components,
        })
      : await sendWhatsAppText(conversation.businessPhone, customerPhone, text);
  } catch (error) {
    const info = ycloudSendErrorInfo(error);
    return { ok: false as const, code: info.code, message: info.message };
  }

  const ycloudMessageId =
    typeof sent.id === "string"
      ? sent.id
      : typeof sent.messageId === "string"
        ? sent.messageId
        : undefined;

  const preview = useTemplate
    ? await buildTemplatePreview({
        name: input.template!.name,
        language: input.template!.language || "en",
        components: input.template!.components,
        wabaId: fromResolved.wabaId,
      })
    : text;

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "outbound",
      source: "agent",
      messageType: useTemplate ? "template" : "text",
      status: "accepted",
      content: preview,
      ycloudMessageId,
      supplierId: conversation.supplierId || undefined,
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastOutboundAt: new Date(),
      ...(sourceChatId ? { sourceChatId } : {}),
      ...(sourceOpenId ? { sourceOpenId } : {}),
      ...(input.feishuAppId?.trim() ? { feishuAppId: input.feishuAppId.trim() } : {}),
    },
  });

  try {
    await withFeishuApp(input.feishuAppId || conversation.feishuAppId || undefined, async () => {
      const bots = parseCliAppIds(input.inviteAppIds);
      const app = requireFeishuApp();
      if (bots.length) {
        try {
          await saveFeishuInviteAppIds(app.appId, bots);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "P2025") console.error("save FEISHU_INVITE_APP_IDS failed", error);
        }
      }
      if (sourceChatId) {
        try {
          await ensureBotInChat(sourceChatId);
        } catch (error) {
          console.error("ensure bot in source chat on agent send failed", error);
        }
      }

      try {
        const thread = await ensureFeishuThread({
          conversationId: conversation.id,
          customerPhone,
          businessPhone: conversation.businessPhone,
          customerName: conversation.customer.name || undefined,
          firstText: "系统：智能体已向该买家发送 WhatsApp",
          memberOpenIds: sourceOpenId ? [sourceOpenId] : undefined,
          botAppIds: bots,
        });
        const feishuMessageId = thread.firstMessagePosted ? thread.firstReplyMessageId : undefined;
        if (ycloudMessageId && feishuMessageId) {
          await prisma.message.updateMany({
            where: { ycloudMessageId },
            data: { feishuMessageId },
          });
        }
      } catch (error) {
        console.error("sync outbound to Feishu failed", error);
      }
    });
  } catch (error) {
    console.error("sync outbound to Feishu failed", error);
  }

  return {
    ok: true as const,
    ycloudMessageId,
    conversationId: conversation.id,
    wabaId: fromResolved.wabaId,
    supplierId,
    from: businessPhone,
    windowOpen,
    sourceChatId,
    sourceOpenId,
  };
}
