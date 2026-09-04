import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedCsWhatsAppReply, isFeishuAtMention, parseFeishuEvent } from "./crypto";

function receiveEvent(message: Record<string, unknown>) {
  return {
    header: { event_type: "im.message.receive_v1", event_id: "evt_1" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_cs",
        thread_id: "omt_1",
        message_type: "text",
        ...message,
      },
    },
  };
}

describe("Feishu @mention skip", () => {
  it("detects mentions array from webhook", () => {
    const parsed = parseFeishuEvent(
      receiveEvent({
        content: JSON.stringify({ text: "@_user_1 帮我看下" }),
        mentions: [
          {
            key: "@_user_1",
            name: "Tom",
            mentioned_type: "user",
            id: { open_id: "ou_tom" },
          },
        ],
      }),
    );
    assert.equal(parsed.inbound?.mentionCount, 1);
    assert.equal(isFeishuAtMention(parsed.inbound!), true);
  });

  it("detects <at> tags without mentions array", () => {
    const parsed = parseFeishuEvent(
      receiveEvent({
        content: JSON.stringify({ text: '<at user_id="ou_tom">张三</at> 内部商量' }),
      }),
    );
    assert.ok((parsed.inbound?.mentionCount ?? 0) > 0);
    assert.equal(isFeishuAtMention(parsed.inbound!), true);
  });

  it("lets plain customer replies through", () => {
    const parsed = parseFeishuEvent(
      receiveEvent({
        content: JSON.stringify({ text: "好的，我们再约" }),
      }),
    );
    assert.equal(parsed.inbound?.mentionCount, 0);
    assert.equal(isFeishuAtMention(parsed.inbound!), false);
  });
});

describe("Feishu CS WhatsApp reply allowlist", () => {
  const allow = { selfAppId: "cli_bridge", inviteAppIds: ["cli_agent"] };

  it("allows human replies", () => {
    const parsed = parseFeishuEvent(
      receiveEvent({
        content: JSON.stringify({ text: "好的，我们再约" }),
      }),
    );
    assert.equal(isAllowedCsWhatsAppReply(parsed.inbound!, allow), true);
  });

  it("allows invite-list bots", () => {
    const parsed = parseFeishuEvent({
      header: { event_type: "im.message.receive_v1", event_id: "evt_bot" },
      event: {
        sender: {
          sender_type: "app",
          sender_id: { app_id: "cli_agent" },
        },
        message: {
          message_id: "om_bot",
          chat_id: "oc_cs",
          thread_id: "omt_1",
          message_type: "text",
          content: JSON.stringify({ text: "Dear David, ..." }),
        },
      },
    });
    assert.equal(isAllowedCsWhatsAppReply(parsed.inbound!, allow), true);
  });

  it("blocks other bots and the bridge itself", () => {
    const other = parseFeishuEvent({
      header: { event_type: "im.message.receive_v1", event_id: "evt_other" },
      event: {
        sender: { sender_type: "app", sender_id: { app_id: "cli_other" } },
        message: {
          message_id: "om_other",
          chat_id: "oc_cs",
          thread_id: "omt_1",
          message_type: "text",
          content: JSON.stringify({ text: "hi" }),
        },
      },
    });
    const self = parseFeishuEvent({
      header: { event_type: "im.message.receive_v1", event_id: "evt_self" },
      event: {
        sender: { sender_type: "app", sender_id: { app_id: "cli_bridge" } },
        message: {
          message_id: "om_self",
          chat_id: "oc_cs",
          thread_id: "omt_1",
          message_type: "text",
          content: JSON.stringify({ text: "买家：hi" }),
        },
      },
    });
    assert.equal(isAllowedCsWhatsAppReply(other.inbound!, allow), false);
    assert.equal(isAllowedCsWhatsAppReply(self.inbound!, allow), false);
  });
});
