import crypto from "node:crypto";
import { sha256Hex, timingSafeEqualHex } from "../../lib/crypto";

export function decryptFeishuPayload(encrypt: string, encryptKey: string): string {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encrypt, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  let out = decipher.update(buf.subarray(16).toString("hex"), "hex", "utf8");
  out += decipher.final("utf8");
  return out;
}

export function verifyFeishuSignature(
  timestamp: string | undefined,
  nonce: string | undefined,
  rawBody: string,
  signature: string | undefined,
  encryptKey: string,
): boolean {
  if (!timestamp || !nonce || !signature) return false;
  const expected = sha256Hex(timestamp + nonce + encryptKey + rawBody);
  return timingSafeEqualHex(expected, signature);
}

export type FeishuInboundMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  threadId?: string;
  senderType?: string;
  senderAppId?: string;
  messageType: string;
  text?: string;
  /** 飞书图片消息的 image_key */
  imageKey?: string;
  /** 消息里 @ 到的人/机器人/所有人 */
  mentionCount: number;
};

function countMentions(message: Record<string, unknown>, text?: string): number {
  const listed = Array.isArray(message.mentions) ? message.mentions.length : 0;
  if (listed > 0) return listed;
  if (!text) return 0;
  const fromTags = text.match(/<at\s+[^>]+>/gi)?.length ?? 0;
  const fromPlaceholders = text.match(/@_user_\d+/g)?.length ?? 0;
  const fromAll = /@_all\b|<at\s+user_id=["']all["']/i.test(text) ? 1 : 0;
  return fromTags + fromPlaceholders + fromAll;
}

/** 客服在话题里 @ 同事/机器人/所有人：只留在飞书，不转 WhatsApp。 */
export function isFeishuAtMention(inbound: FeishuInboundMessage): boolean {
  if (inbound.mentionCount > 0) return true;
  const text = inbound.text || "";
  return /<at\s+[^>]+>/i.test(text) || /@_user_\d+/.test(text) || /@_all\b/i.test(text);
}

/**
 * 只有人工，以及 FEISHU_INVITE_APP_IDS 里的机器人/智能体，才能把话题回复同步到 WhatsApp。
 * 桥接自己的应用、其它未授权机器人一律忽略。
 */
export function isAllowedCsWhatsAppReply(
  inbound: FeishuInboundMessage,
  allow: { selfAppId?: string; inviteAppIds: string[] },
): boolean {
  const selfAppId = allow.selfAppId?.trim();
  const invite = new Set(allow.inviteAppIds.map((id) => id.trim()).filter(Boolean));
  if (selfAppId && inbound.senderAppId === selfAppId) return false;

  const isApp = inbound.senderType === "app" || Boolean(inbound.senderAppId);
  if (isApp) return Boolean(inbound.senderAppId && invite.has(inbound.senderAppId));
  if (!inbound.senderType || inbound.senderType === "user") return true;
  return Boolean(inbound.senderAppId && invite.has(inbound.senderAppId));
}

export function parseFeishuEvent(payload: unknown): {
  type?: string;
  challenge?: string;
  token?: string;
  inbound?: FeishuInboundMessage;
} {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (body.type === "url_verification") {
    return {
      type: "url_verification",
      challenge: typeof body.challenge === "string" ? body.challenge : undefined,
      token: typeof body.token === "string" ? body.token : undefined,
    };
  }

  const header = (body.header && typeof body.header === "object"
    ? body.header
    : {}) as Record<string, unknown>;
  const eventType =
    (typeof header.event_type === "string" && header.event_type) ||
    (typeof body.type === "string" ? body.type : undefined);
  const eventId =
    (typeof header.event_id === "string" && header.event_id) ||
    (typeof body.uuid === "string" ? body.uuid : undefined);

  const event = (body.event && typeof body.event === "object"
    ? body.event
    : {}) as Record<string, unknown>;
  const message = (event.message && typeof event.message === "object"
    ? event.message
    : {}) as Record<string, unknown>;
  const sender = (event.sender && typeof event.sender === "object"
    ? event.sender
    : {}) as Record<string, unknown>;
  const senderId = (sender.sender_id && typeof sender.sender_id === "object"
    ? sender.sender_id
    : {}) as Record<string, unknown>;

  if (eventType !== "im.message.receive_v1" || typeof message.message_id !== "string") {
    return { type: eventType };
  }

  let text: string | undefined;
  let imageKey: string | undefined;
  if (typeof message.content === "string") {
    try {
      const content = JSON.parse(message.content) as { text?: string; image_key?: string };
      text = content.text;
      imageKey = content.image_key;
    } catch {
      text = message.content;
    }
  }

  const senderAppId =
    (typeof senderId.app_id === "string" && senderId.app_id.trim()) ||
    (typeof sender.sender_id === "string" && sender.sender_id.startsWith("cli_") ? sender.sender_id : undefined) ||
    undefined;

  return {
    type: eventType,
    token: typeof body.token === "string" ? body.token : undefined,
    inbound: {
      eventId: eventId || message.message_id,
      messageId: message.message_id,
      chatId: typeof message.chat_id === "string" ? message.chat_id : "",
      threadId: typeof message.thread_id === "string" ? message.thread_id : undefined,
      senderType: typeof sender.sender_type === "string" ? sender.sender_type : undefined,
      senderAppId: senderAppId || undefined,
      messageType: typeof message.message_type === "string" ? message.message_type : "text",
      text,
      imageKey,
      mentionCount: countMentions(message, text),
    },
  };
}
