import { describe, it, expect, vi } from "vitest";
import { DingtalkEdge, inboundText, encodeTarget, decodeTarget } from "./dingtalk.js";
import type { Run, Store } from "./store.js";

const store = (over: Partial<Store> = {}) =>
  ({
    enqueue: vi.fn(async () => ({ id: "run-1" })),
    event: vi.fn(async () => {}),
    channelBinding: vi.fn(async () => undefined),
    channelBindings: vi.fn(async () => []),
    channelCredentials: vi.fn(() => ({ clientId: "c", clientSecret: "s" })),
    revokeChannel: vi.fn(async () => {}),
    ...over,
  }) as unknown as Store;

const ingest = (edge: DingtalkEdge, res: unknown) =>
  (edge as unknown as { ingest(t: string, r: unknown): Promise<void> }).ingest("t1", res);

const WEBHOOK = "https://oapi.dingtalk.com/robot/sendBySession?session=abc";

describe("dingtalk inbound text", () => {
  it("reads text messages", () => {
    expect(inboundText({ msgtype: "text", text: { content: " 你好 " } })).toBe("你好");
  });
  it("ignores non-text message types rather than forwarding an empty turn", () => {
    expect(inboundText({ msgtype: "picture", text: { content: "x" } })).toBe("");
    expect(inboundText({ msgtype: "text" })).toBe("");
  });
});

describe("dingtalk reply target", () => {
  it("round-trips with the expiry", () => {
    const t = { webhook: WEBHOOK, expiresAt: 123 };
    expect(decodeTarget(encodeTarget(t))).toEqual(t);
  });
  it("rejects anything that is not an https webhook", () => {
    expect(decodeTarget(null)).toBeNull();
    expect(decodeTarget("{")).toBeNull();
    expect(decodeTarget(JSON.stringify({ webhook: "http://evil.local/x" }))).toBeNull();
    expect(decodeTarget(JSON.stringify({ other: 1 }))).toBeNull();
  });
});

describe("dingtalk ingest", () => {
  const frame = (over: Record<string, unknown> = {}) => ({
    headers: { messageId: "m1" },
    data: JSON.stringify({
      msgtype: "text",
      text: { content: "在吗" },
      msgId: "msg-1",
      conversationId: "cid-1",
      sessionWebhook: WEBHOOK,
      ...over,
    }),
  });

  it("enqueues keyed by msgId with the session webhook as the reply target", async () => {
    const s = store();
    await ingest(new DingtalkEdge(s), frame());
    expect(s.enqueue).toHaveBeenCalledWith(
      "t1", "msg-1", "t1:cid-1", "在吗", "dingtalk",
      encodeTarget({ webhook: WEBHOOK }),
    );
  });

  it("carries the webhook expiry so an undeliverable reply is not attempted", async () => {
    const s = store();
    await ingest(new DingtalkEdge(s), frame({ sessionWebhookExpiredTime: 999 }));
    expect(JSON.parse((s.enqueue as any).mock.calls[0][5])).toEqual({
      webhook: WEBHOOK, expiresAt: 999,
    });
  });

  // Waking a sandbox for a turn that can never be delivered wastes a cold start.
  it("drops messages with no webhook or no text", async () => {
    const s = store();
    const edge = new DingtalkEdge(s);
    await ingest(edge, frame({ sessionWebhook: undefined }));
    await ingest(edge, frame({ text: { content: "   " } }));
    await ingest(edge, frame({ msgtype: "picture" }));
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("survives a malformed frame", async () => {
    const s = store();
    await ingest(new DingtalkEdge(s), { headers: { messageId: "m" }, data: "not json" });
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("records rejection instead of throwing into the socket handler", async () => {
    const s = store({ enqueue: vi.fn(async () => { throw new Error("INVALID_MESSAGE"); }) as any });
    await ingest(new DingtalkEdge(s), frame());
    expect(s.event).toHaveBeenCalledWith("t1", "dingtalk-ingress-rejected", expect.anything());
  });
});

describe("dingtalk reply", () => {
  const run = (over: Partial<Run> = {}) =>
    ({ id: "r1", tenant_id: "t1", channel: "dingtalk", message_id: null, ...over }) as Run;
  const flush = (edge: DingtalkEdge, r: Run) =>
    (edge as unknown as { flush(r: Run): Promise<void> }).flush(r);

  it("does not post once the session webhook has expired", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const edge = new DingtalkEdge(s);
    const r = run({ message_id: encodeTarget({ webhook: WEBHOOK, expiresAt: Date.now() - 1000 }) });
    edge.delta(r, "答案");
    await flush(edge, r);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.event).toHaveBeenCalledWith("t1", "dingtalk-webhook-expired", {}, "r1");
    fetchSpy.mockRestore();
  });

  it("suppresses the silence marker instead of posting it", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const edge = new DingtalkEdge(s);
    const r = run({ message_id: encodeTarget({ webhook: WEBHOOK }) });
    edge.delta(r, "NO_REPLY");
    await flush(edge, r);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.event).toHaveBeenCalledWith("t1", "reply-suppressed", expect.anything(), "r1");
    fetchSpy.mockRestore();
  });

  it("treats a DingTalk errcode as a failure even on HTTP 200", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errcode: 300001, errmsg: "token invalid" }), { status: 200 }),
    );
    const edge = new DingtalkEdge(s);
    const r = run({ message_id: encodeTarget({ webhook: WEBHOOK }) });
    edge.delta(r, "答案");
    await flush(edge, r);
    expect(s.event).toHaveBeenCalledWith(
      "t1", "dingtalk-reply-failed", expect.objectContaining({ message: expect.stringContaining("300001") }), "r1",
    );
    fetchSpy.mockRestore();
  });
});
