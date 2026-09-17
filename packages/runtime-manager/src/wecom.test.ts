import { describe, it, expect, vi } from "vitest";
import { WecomEdge, inboundText, encodeTarget, decodeTarget } from "./wecom.js";
import type { Run, Store } from "./store.js";

const store = (over: Partial<Store> = {}) =>
  ({
    enqueue: vi.fn(async () => ({ id: "run-1" })),
    event: vi.fn(async () => {}),
    channelBinding: vi.fn(async () => undefined),
    channelBindings: vi.fn(async () => []),
    channelCredentials: vi.fn(() => ({ botId: "b", secret: "s" })),
    revokeChannel: vi.fn(async () => {}),
    ...over,
  }) as unknown as Store;

const ingest = (edge: WecomEdge, frame: unknown) =>
  (edge as unknown as { ingest(t: string, f: unknown): Promise<void> }).ingest("t1", frame);
const flush = (edge: WecomEdge, r: Run) =>
  (edge as unknown as { flush(r: Run): Promise<void> }).flush(r);

const RESPONSE_URL = "https://qyapi.weixin.qq.com/cgi-bin/aibot/reply?token=x";

describe("wecom inbound text", () => {
  it("reads text messages", () => {
    expect(inboundText({ msgtype: "text", text: { content: " hi " } })).toBe("hi");
  });
  it("ignores non-text types", () => {
    expect(inboundText({ msgtype: "image", text: { content: "x" } })).toBe("");
  });
});

describe("wecom reply target", () => {
  it("round-trips", () => {
    const t = { responseUrl: RESPONSE_URL, chatId: "c1", chatType: "group" };
    expect(decodeTarget(encodeTarget(t))).toEqual(t);
  });
  it("tolerates missing or malformed values", () => {
    expect(decodeTarget(null)).toBeNull();
    expect(decodeTarget("{{")).toBeNull();
  });
});

describe("wecom ingest", () => {
  const frame = (over: Record<string, unknown> = {}) => ({
    headers: { req_id: "r-1" },
    body: {
      msgtype: "text",
      text: { content: "在吗" },
      msgid: "mid-1",
      chatid: "chat-1",
      chattype: "group",
      response_url: RESPONSE_URL,
      from: { userid: "u1" },
      ...over,
    },
  });

  it("dedups on WeCom's msgid and keeps the response_url for later delivery", async () => {
    const s = store();
    await ingest(new WecomEdge(s), frame());
    expect(s.enqueue).toHaveBeenCalledWith(
      "t1", "mid-1", "t1:chat-1", "在吗", "wecom",
      encodeTarget({ responseUrl: RESPONSE_URL, chatId: "chat-1", chatType: "group" }),
    );
  });

  it("falls back to the sender for a single chat session key", async () => {
    const s = store();
    await ingest(new WecomEdge(s), frame({ chatid: undefined, chattype: "single" }));
    expect((s.enqueue as any).mock.calls[0][2]).toBe("t1:u1");
  });

  it("drops messages with no text or no msgid", async () => {
    const s = store();
    const edge = new WecomEdge(s);
    await ingest(edge, frame({ text: { content: "  " } }));
    await ingest(edge, frame({ msgid: undefined }));
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("remembers the live frame so the reply can stream", async () => {
    const s = store();
    const edge = new WecomEdge(s);
    await ingest(edge, frame());
    expect((edge as any).frames.get("run-1")).toEqual({ tenantId: "t1", headers: { req_id: "r-1" } });
  });
});

describe("wecom reply", () => {
  const run = (over: Partial<Run> = {}) =>
    ({ id: "r1", tenant_id: "t1", channel: "wecom", message_id: null, ...over }) as Run;

  it("suppresses the silence marker on both routes", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const edge = new WecomEdge(s);
    const r = run({ message_id: encodeTarget({ responseUrl: RESPONSE_URL }) });
    edge.delta(r, "NO_REPLY");
    await flush(edge, r);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.event).toHaveBeenCalledWith("t1", "reply-suppressed", expect.anything(), "r1");
    fetchSpy.mockRestore();
  });

  // A manager restart mid-turn loses the socket frame; response_url is what
  // keeps that answer deliverable instead of silently lost.
  it("delivers over response_url when no live frame remains", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
    );
    const edge = new WecomEdge(s);
    const r = run({ message_id: encodeTarget({ responseUrl: RESPONSE_URL }) });
    edge.delta(r, "答案");
    await flush(edge, r);
    expect(fetchSpy).toHaveBeenCalledWith(RESPONSE_URL, expect.objectContaining({ method: "POST" }));
    expect(s.event).toHaveBeenCalledWith(
      "t1", "wecom-reply-sent", expect.objectContaining({ via: "response_url" }), "r1",
    );
    fetchSpy.mockRestore();
  });

  it("reports an undeliverable turn rather than dropping it quietly", async () => {
    const s = store();
    const edge = new WecomEdge(s);
    const r = run({ message_id: encodeTarget({ chatId: "c" }) });
    edge.delta(r, "答案");
    await flush(edge, r);
    expect(s.event).toHaveBeenCalledWith("t1", "wecom-reply-undeliverable", {}, "r1");
  });

  it("treats a WeCom errcode as failure even on HTTP 200", async () => {
    const s = store();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errcode: 40014 }), { status: 200 }),
    );
    const edge = new WecomEdge(s);
    const r = run({ message_id: encodeTarget({ responseUrl: RESPONSE_URL }) });
    edge.delta(r, "答案");
    await flush(edge, r);
    expect(s.event).toHaveBeenCalledWith(
      "t1", "wecom-reply-failed",
      expect.objectContaining({ message: expect.stringContaining("40014") }), "r1",
    );
    fetchSpy.mockRestore();
  });
});
