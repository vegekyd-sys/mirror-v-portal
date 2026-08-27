/**
 * 飞书通知 —— 自定义机器人 webhook。
 *
 * 需求表「飞书通知规则」一节为空，按验收标准第 6 条实现：
 * opened / clicked / bounced / complained 四类事件推送，其余静默。
 * 通过 NOTIFY_EVENTS 环境变量可覆盖这个清单。
 */

import { logger } from "./logger.js";
import { createHmac } from "node:crypto";
import type { Settings } from "./config.js";
import { feishuEnabled } from "./config.js";
import { EmailContent } from "./emailContent.js";
import type { ResendEmailClient } from "./emailContent.js";
import type { InboundEvent } from "./events.js";
import { EVENT_PRESENTATION } from "./events.js";
import type { Binding, BindingStore } from "./bindings.js";
import { channelOf } from "./bindings.js";
import type { FeishuAppClient, SendResult } from "./feishuApp.js";

/** 飞书签名：以 "{timestamp}\n{secret}" 为 key 对空串做 HMAC-SHA256。 */
function sign(secret: string, timestamp: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

function field(label: string, value: string, short = true): Record<string, unknown> {
  return {
    is_short: short,
    text: { tag: "lark_md", content: `**${label}**\n${value || "-"}` },
  };
}

/** 构造安全的 @ 用户元素；拒绝把任意文本插入 lark_md。 */
function mentionElement(openId: string): Record<string, unknown> | null {
  if (!/^ou_[a-zA-Z0-9]+$/.test(openId)) return null;
  return {
    tag: "div",
    text: { tag: "lark_md", content: `请及时跟进：<at id=${openId}></at>` },
  };
}

export function buildCard(
  event: InboundEvent,
  content: EmailContent | null = null,
  mentionOpenId = "",
): Record<string, unknown> {
  const [template, title] = EVENT_PRESENTATION[event.eventType] ?? ["grey", event.eventType];

  const fields: Array<Record<string, unknown>> = event.isInbound
    ? [
        // 买家回信：线索在 from 侧，收件的是我们自己的代理邮箱
        field("回复人（线索）", event.leadEmail),
        field("线索状态", event.status ?? "-"),
        field("代理邮箱", event.receivedFor.join(", ") || event.primaryRecipient),
        field("附件", event.attachments ? `${event.attachments} 个` : "无"),
        field("主题", event.subject, false),
      ]
    : [
        field("收件人", event.leadEmail),
        field("线索状态", event.status ?? "-"),
        field("主题", event.subject, false),
      ];

  // 点击事件带链接、退信带原因，这些是运营最关心的信息
  const link = event.detail["link"];
  if (link) fields.push(field("点击链接", String(link), false));
  const bounceReason = event.detail["message"] ?? event.detail["reason"];
  if (bounceReason) fields.push(field("原因", String(bounceReason), false));

  const elements: Array<Record<string, unknown>> = [{ tag: "div", fields }];

  const mention = mentionElement(mentionOpenId);
  if (mention !== null) elements.push(mention);

  if (content !== null && content.included) {
    const suffix = content.truncated ? "（内容已截断）" : "";
    elements.push({
      tag: "div",
      // 邮件正文不可信，必须走 plain_text，绝不能进 lark_md
      text: { tag: "plain_text", content: `邮件内容${suffix}\n${content.preview}` },
    });
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "note",
      elements: [
        {
          tag: "lark_md",
          content:
            `事件 \`${event.eventType}\` · 邮件 \`${event.emailId || "-"}\` · ` +
            `发生于 ${event.occurredAt || event.receivedAt}`,
        },
      ],
    },
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: "plain_text", content: `[DealClaw] ${title}` },
    },
    elements,
  };
}

/** 路由顺序：先按代理邮箱查绑定的应用机器人，没有再用全局自定义机器人。 */
export class FeishuNotifier {
  private readonly settings: Settings;
  private readonly bindingStore: BindingStore | null;
  private readonly appClient: FeishuAppClient | null;
  private readonly contentClient: ResendEmailClient | null;

  constructor(
    settings: Settings,
    options: {
      bindingStore?: BindingStore | null;
      appClient?: FeishuAppClient | null;
      contentClient?: ResendEmailClient | null;
    } = {},
  ) {
    this.settings = settings;
    this.bindingStore = options.bindingStore ?? null;
    this.appClient = options.appClient ?? null;
    this.contentClient = options.contentClient ?? null;
  }

  /** 往一个自定义机器人 webhook 发卡片。全局配置和按邮箱绑定共用这段。 */
  async postCustomBot(url: string, secret: string, card: unknown): Promise<SendResult> {
    const body: Record<string, unknown> = { msg_type: "interactive", card };
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body["timestamp"] = timestamp;
      body["sign"] = sign(secret, timestamp);
    }

    let response: Response;
    let payload: Record<string, unknown>;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.feishuTimeoutSeconds * 1000),
      });
      payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      logger.error("飞书通知发送失败:", err);
      return { sent: false, via: "custom_bot", reason: `request failed: ${(err as Error).message}` };
    }

    // 飞书 HTTP 200 也可能返回业务错误码，必须看 body 里的 code
    const code = payload["code"] ?? payload["StatusCode"] ?? 0;
    if (response.status !== 200 || (code !== 0 && code !== null)) {
      logger.error(`飞书返回异常: http=${response.status} body=${JSON.stringify(payload)}`);
      return { sent: false, via: "custom_bot", reason: `feishu rejected: ${JSON.stringify(payload)}` };
    }

    return { sent: true, via: "custom_bot", reason: "" };
  }

  /** 按绑定选定的通道发送。 */
  async sendViaBinding(binding: Binding, card: unknown): Promise<SendResult> {
    const channel = channelOf(binding);
    let result: SendResult;
    if (channel === "custom") {
      result = await this.postCustomBot(binding.webhook_url, binding.webhook_secret, card);
    } else if (channel === "app" && this.appClient !== null) {
      result = await this.appClient.sendCard(binding, card);
    } else {
      return { sent: false, via: "none", reason: `binding has no usable channel (${channel})` };
    }
    result["bound"] = true;
    return result;
  }

  async send(event: InboundEvent): Promise<SendResult> {
    const s = this.settings;
    // 先判事件类型再判配置：这样「该不该推」始终可观测，
    // 不会被「飞书没配」这个原因盖掉，排查时能一眼看出是规则过滤还是配置缺失。
    if (!event.shouldNotify(s.notifyEvents)) {
      return { sent: false, reason: `${event.eventType} not in NOTIFY_EVENTS` };
    }

    const content =
      this.contentClient !== null
        ? await this.contentClient.fetch(event)
        : new EmailContent({ reason: "content client not configured" });

    const fallbackMentionOpenId = s.feishuMentionEvents.has(event.eventType)
      ? s.feishuMentionOpenId
      : "";

    // --- 1. 按代理邮箱查绑定 ---
    if (this.bindingStore !== null) {
      const binding = await this.bindingStore.get(event.agentEmail);
      if (binding !== null) {
        const mentionOpenId = s.feishuMentionEvents.has(event.eventType)
          ? binding.mention_open_id || fallbackMentionOpenId
          : "";
        const card = buildCard(event, content, mentionOpenId);
        const result = await this.sendViaBinding(binding, card);
        result["agent_email"] = event.agentEmail;
        result["email_content"] = content.metadata();
        return result;
      }
    }

    // --- 2. 回落到全局自定义机器人 ---
    if (!feishuEnabled(s)) {
      return {
        sent: false,
        via: "none",
        bound: false,
        agent_email: event.agentEmail,
        reason:
          `no binding for ${event.agentEmail || "(unknown)"} ` +
          "and FEISHU_WEBHOOK_URL not configured",
        email_content: content.metadata(),
      };
    }

    const card = buildCard(event, content, fallbackMentionOpenId);
    const result = await this.postCustomBot(s.feishuWebhookUrl, s.feishuSecret, card);
    result["bound"] = false;
    result["agent_email"] = event.agentEmail;
    result["email_content"] = content.metadata();
    return result;
  }
}
