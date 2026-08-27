import { describe, expect, it } from "vitest";
import {
  EmailContent,
  ResendEmailClient,
  htmlToText,
  normalizePreview,
} from "../src/emailContent.js";
import { parse } from "../src/events.js";
import { buildCard } from "../src/notify.js";

function makeEvent(eventType: string, emailId = "email-123") {
  const data: Record<string, unknown> = {
    email_id: emailId,
    from: "Agent <agent@mail.dealclaw.io>",
    to: ["buyer@example.com"],
    subject: "测试邮件",
  };
  if (eventType === "email.received") {
    data["from"] = "Buyer <buyer@example.com>";
    data["to"] = ["agent@mail.dealclaw.io"];
    data["received_for"] = ["agent@mail.dealclaw.io"];
  }
  return parse({ type: eventType, data }, "msg-123");
}

/** 用一个假的 fetch 顶掉网络请求，同时断言请求本身是对的。 */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown },
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("ResendEmailClient", () => {
  it("收信事件走 receiving 端点，优先用纯文本", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = new ResendEmailClient("test-key", {
      fetchImpl: stubFetch((url, init) => {
        seenUrl = url;
        seenAuth = String((init?.headers as Record<string, string>)?.["Authorization"]);
        return {
          status: 200,
          body: { text: "  第一行  \r\n\r\n第二行  ", html: "<p>不应使用</p>" },
        };
      }),
    });

    const content = await client.fetch(makeEvent("email.received"));

    expect(new URL(seenUrl).pathname).toBe("/emails/receiving/email-123");
    expect(seenAuth).toBe("Bearer test-key");
    expect(content.included).toBe(true);
    expect(content.source).toBe("text");
    expect(content.preview).toBe("第一行\n\n第二行");
    expect(content.truncated).toBe(false);
  });

  it("出站事件走 emails 端点，只有 HTML 时转成纯文本", async () => {
    let seenUrl = "";
    const client = new ResendEmailClient("test-key", {
      fetchImpl: stubFetch((url) => {
        seenUrl = url;
        return {
          status: 200,
          body: {
            text: null,
            html: "<style>hidden</style><p>Hello &amp; welcome</p><script>bad()</script><p>Next</p>",
          },
        };
      }),
    });

    const content = await client.fetch(makeEvent("email.opened"));

    expect(new URL(seenUrl).pathname).toBe("/emails/email-123");
    expect(content.source).toBe("html");
    expect(content.preview).toBe("Hello & welcome\n\nNext");
    expect(content.preview).not.toContain("hidden");
    expect(content.preview).not.toContain("bad");
  });

  it("查询失败不影响主流程，且不回显响应体", async () => {
    const client = new ResendEmailClient("test-key", {
      fetchImpl: stubFetch(() => ({ status: 403, body: { message: "secret diagnostic" } })),
    });

    const content = await client.fetch(makeEvent("email.received"));

    expect(content.included).toBe(false);
    expect(content.reason).toBe("Resend API returned HTTP 403");
    expect(content.reason).not.toContain("secret diagnostic");
  });

  it("正文超长时截断到卡片安全长度", async () => {
    const client = new ResendEmailClient("test-key", {
      previewChars: 200,
      fetchImpl: stubFetch(() => ({ status: 200, body: { text: "x".repeat(300) } })),
    });

    const content = await client.fetch(makeEvent("email.received"));

    expect(content.truncated).toBe(true);
    expect([...content.preview].length).toBe(200);
    expect(content.preview.endsWith("…")).toBe(true);
  });

  it("没配 API Key 时直接降级，不发请求", async () => {
    const client = new ResendEmailClient("");
    const content = await client.fetch(makeEvent("email.received"));
    expect(content.included).toBe(false);
    expect(content.reason).toBe("RESEND_API_KEY not configured");
  });
});

describe("飞书卡片", () => {
  it("按配置 @ 负责人", () => {
    const card = buildCard(makeEvent("email.received"), null, "ou_123abc");
    const elements = card["elements"] as Array<Record<string, any>>;
    const mentions = elements
      .filter(
        (item) =>
          item["text"]?.tag === "lark_md" && String(item["text"]?.content).includes("<at id="),
      )
      .map((item) => item["text"].content);
    expect(mentions).toEqual(["请及时跟进：<at id=ou_123abc></at>"]);
  });

  it("非法 Open ID 一律不渲染 @，避免注入卡片标记", () => {
    const card = buildCard(makeEvent("email.received"), null, "ou_bad></at><at id=all");
    expect(JSON.stringify(card)).not.toContain("<at id=");
  });

  it("邮件正文走 plain_text，绝不进 lark_md", () => {
    const content = new EmailContent({
      preview: "**不是卡片 Markdown**\nhttps://example.com",
      source: "text",
    });
    const card = buildCard(makeEvent("email.received"), content);
    const elements = card["elements"] as Array<Record<string, any>>;
    const body = elements.find((item) =>
      String(item["text"]?.content ?? "").startsWith("邮件内容"),
    )?.["text"];

    expect(body.tag).toBe("plain_text");
    expect(body.content).toContain("**不是卡片 Markdown**");
  });
});

describe("正文归一化", () => {
  it("去掉控制字符并压缩空白", () => {
    const [preview, truncated] = normalizePreview("a\u0000b\r\n c", 100);
    expect(preview).toBe("ab\nc");
    expect(truncated).toBe(false);
  });

  it("HTML 实体会被解码", () => {
    expect(htmlToText("<p>A &amp; B</p>")).toContain("A & B");
  });
});
