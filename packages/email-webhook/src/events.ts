/**
 * Resend 事件解析与线索状态映射。
 *
 * 需求表里「事件字段建议」「线索状态映射」两节是空的，这里按最小验收标准倒推：
 * delivered/opened/clicked/bounced/complained 必须能正确更新线索状态，
 * 其中 opened/clicked/bounced/complained 需要推送飞书。
 */

/** 买家主动回复的事件。方向和其余事件相反：线索在 from 侧，不在 to 侧。 */
import { nowIso } from "./time.js";

export const INBOUND_EVENTS: ReadonlySet<string> = new Set(["email.received"]);

/**
 * 线索状态。rank 用于保证状态只前进不倒退 —— webhook 到达顺序不保证，
 * 迟到的 delivered 不能把已经 clicked 的线索打回去。
 * bounced/complained 是负向终态，rank 很高，任何时候都能覆盖。
 *
 * REPLIED 排最高：买家亲自回信是最强的意向信号，不该被任何后续的
 * 投递类事件盖掉。若业务上认为「投诉」必须压过「已回复」（比如要据此
 * 停止发信），把 COMPLAINED 调到 200 以上即可，其余逻辑不用动。
 */
export const STATUS_RANK: Readonly<Record<string, number>> = {
  SENT: 10,
  DELAYED: 15,
  DELIVERED: 20,
  OPENED: 30,
  CLICKED: 40,
  BOUNCED: 90,
  COMPLAINED: 100,
  REPLIED: 200,
};

export const EVENT_TO_STATUS: Readonly<Record<string, string>> = {
  "email.sent": "SENT",
  "email.delivery_delayed": "DELAYED",
  "email.delivered": "DELIVERED",
  "email.opened": "OPENED",
  "email.clicked": "CLICKED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.received": "REPLIED",
};

/** 事件类型 -> 飞书卡片配色/标题，仅用于通知展示。 */
export const EVENT_PRESENTATION: Readonly<Record<string, [string, string]>> = {
  "email.received": ["purple", "买家回复了邮件"],
  "email.opened": ["blue", "邮件已打开"],
  "email.clicked": ["green", "邮件链接被点击"],
  "email.bounced": ["red", "邮件被退回"],
  "email.complained": ["orange", "收件人投诉为垃圾邮件"],
  "email.delivered": ["grey", "邮件已送达"],
  "email.sent": ["grey", "邮件已发出"],
  "email.delivery_delayed": ["yellow", "邮件投递延迟"],
};

export type JsonObject = Record<string, unknown>;

/**
 * 从 `Thia <thia@mail.dealclaw.io>` 这类字符串里取出裸邮箱地址。
 *
 * Resend 的 from 字段可能带显示名，也可能是裸地址；线索匹配必须用裸地址，
 * 否则同一个人会因为显示名不同被当成两条线索。
 */
export function extractAddress(value: string | undefined | null): string {
  if (!value) return "";
  let text = value.trim();
  if (text.includes("<") && text.includes(">")) {
    text = text.slice(text.lastIndexOf("<") + 1, text.lastIndexOf(">"));
  }
  // 对应 Python 的 .strip().strip('"').strip().lower()
  return text.trim().replace(/^"+|"+$/g, "").trim().toLowerCase();
}

function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  return [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** click/open/bounce 的附加字段放在 data 下的同名子对象里。 */
function extractDetail(eventType: string, data: JsonObject): JsonObject {
  for (const key of ["click", "open", "bounce", "complaint"]) {
    const nested = data[key];
    if (isObject(nested)) return nested;
  }
  if (eventType === "email.delivery_delayed") {
    const detail: JsonObject = {};
    for (const key of ["reason", "message"]) {
      if (key in data) detail[key] = data[key];
    }
    return detail;
  }
  return {};
}

/** 从 Resend 原始 payload 归一化出来的事件。 */
export class InboundEvent {
  /** Svix 消息 ID，用于幂等去重 */
  readonly messageId: string;
  /** 如 email.opened */
  readonly eventType: string;
  /** Resend 侧的邮件 ID */
  readonly emailId: string;
  readonly recipients: string[];
  readonly sender: string;
  readonly subject: string;
  /** ISO8601 */
  readonly occurredAt: string;
  /** 本服务收到的时间 */
  readonly receivedAt: string;
  /** click/open/bounce 的附加信息 */
  readonly detail: JsonObject;
  /** 收信事件：哪个代理邮箱收到的 */
  readonly receivedFor: string[];
  /** 收信事件：附件数量 */
  readonly attachments: number;
  /** 原始 payload，落盘/落库用 */
  readonly raw: JsonObject;

  constructor(init: {
    messageId: string;
    eventType: string;
    emailId?: string;
    recipients?: string[];
    sender?: string;
    subject?: string;
    occurredAt?: string;
    receivedAt?: string;
    detail?: JsonObject;
    receivedFor?: string[];
    attachments?: number;
    raw?: JsonObject;
  }) {
    this.messageId = init.messageId;
    this.eventType = init.eventType;
    this.emailId = init.emailId ?? "";
    this.recipients = init.recipients ?? [];
    this.sender = init.sender ?? "";
    this.subject = init.subject ?? "";
    this.occurredAt = init.occurredAt ?? "";
    this.receivedAt = init.receivedAt ?? "";
    this.detail = init.detail ?? {};
    this.receivedFor = init.receivedFor ?? [];
    this.attachments = init.attachments ?? 0;
    this.raw = init.raw ?? {};
  }

  get status(): string | undefined {
    return EVENT_TO_STATUS[this.eventType];
  }

  get primaryRecipient(): string {
    return this.recipients[0] ?? "";
  }

  get isInbound(): boolean {
    return INBOUND_EVENTS.has(this.eventType);
  }

  /**
   * 线索方（买家）的邮箱。
   *
   * 出站事件（sent/delivered/opened/...）里买家是收件人；
   * 收信事件（received）里买家是发件人，我们自己才是收件人。
   * 搞反了会把 thia@mail.dealclaw.io 当成线索。
   */
  get leadEmail(): string {
    return extractAddress(this.isInbound ? this.sender : this.primaryRecipient);
  }

  /**
   * 我方代理邮箱（发送链路的身份），和 leadEmail 正好相反。
   *
   * 收信事件里它是 received_for（Resend 明确告诉我们哪个地址收的），
   * 缺失时退回收件人；出站事件里它是发件人。
   * 通知路由按这个地址查绑定表。
   */
  get agentEmail(): string {
    const raw = this.isInbound
      ? (this.receivedFor[0] ?? this.primaryRecipient)
      : this.sender;
    return extractAddress(raw);
  }

  shouldNotify(notifyEvents: ReadonlySet<string>): boolean {
    return notifyEvents.has(this.eventType);
  }
}

export function parse(payload: JsonObject, messageId: string): InboundEvent {
  const rawData = payload["data"];
  const data: JsonObject = isObject(rawData) ? rawData : {};
  const eventType = String(payload["type"] ?? "").trim();
  const attachments = data["attachments"];

  return new InboundEvent({
    messageId,
    eventType,
    emailId: String(data["email_id"] ?? data["id"] ?? ""),
    recipients: asList(data["to"]),
    sender: String(data["from"] ?? ""),
    subject: String(data["subject"] ?? ""),
    occurredAt: String(payload["created_at"] ?? data["created_at"] ?? ""),
    receivedAt: nowIso(),
    detail: extractDetail(eventType, data),
    receivedFor: asList(data["received_for"]),
    attachments: Array.isArray(attachments) ? attachments.length : 0,
    raw: payload,
  });
}

/** 判断 incoming 状态是否应当覆盖 current。 */
export function isUpgrade(current: string | null | undefined, incoming: string): boolean {
  if (!incoming || !(incoming in STATUS_RANK)) return false;
  if (!current) return true;
  return (STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0);
}
