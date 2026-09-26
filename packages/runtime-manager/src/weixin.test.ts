import { describe, it, expect, vi } from "vitest";
import { WeixinEdge, extractText, encodeReplyTarget, decodeReplyTarget } from "./weixin.js";
import type { Run, Store } from "./store.js";

const store = (over: Partial<Store> = {}) =>
  ({
    enqueue: vi.fn(async () => ({ id: "run-1" })),
    event: vi.fn(async () => {}),
    channelBinding: vi.fn(async () => undefined),
    channelBindings: vi.fn(async () => []),
    channelCredentials: vi.fn(() => ({ botToken: "t" })),
    saveChannelCursor: vi.fn(async () => {}),
    revokeChannel: vi.fn(async () => {}),
    ...over,
  }) as unknown as Store;

const ingest = (edge: WeixinEdge, msg: unknown) =>
  (edge as unknown as { ingest(t: string, m: unknown): Promise<void> }).ingest("t1", msg);

describe("weixin text extraction", () => {
  it("joins type-1 text items and ignores other item types", () => {
    expect(
      extractText({
        item_list: [
          { type: 1, text_item: { text: "hello " } },
          { type: 3, text_item: { text: "IGNORED" } },
          { type: 1, text_item: { text: "world" } },
        ],
      }),
    ).toBe("hello world");
  });
  it("is empty for a message carrying no text", () => {
    expect(extractText({ item_list: [{ type: 3 }] })).toBe("");
    expect(extractText({})).toBe("");
  });
});

describe("weixin reply target", () => {
  it("round-trips", () => {
    const t = { to: "u@im.wechat", ctx: "ctx-1", group: "g1" };
    expect(decodeReplyTarget(encodeReplyTarget(t))).toEqual(t);
  });
  it("rejects malformed or incomplete values rather than half-addressing a reply", () => {
    expect(decodeReplyTarget(null)).toBeNull();
    expect(decodeReplyTarget("not json")).toBeNull();
    expect(decodeReplyTarget(JSON.stringify({ to: "u" }))).toBeNull();
    expect(decodeReplyTarget(JSON.stringify({ ctx: "c" }))).toBeNull();
  });
});

describe("weixin ingest", () => {
  it("enqueues with the context token as the dedup key and the target as message_id", async () => {
    const s = store();
    await ingest(new WeixinEdge(s), {
      from_user_id: "u@im.wechat",
      context_token: "ctx-9",
      item_list: [{ type: 1, text_item: { text: "在吗" } }],
    });
    expect(s.enqueue).toHaveBeenCalledWith(
      "t1", "ctx-9", "t1:u@im.wechat", "在吗", "weixin",
      encodeReplyTarget({ to: "u@im.wechat", ctx: "ctx-9" }),
    );
  });

  it("keys the session by group so a group chat is one conversation", async () => {
    const s = store();
    await ingest(new WeixinEdge(s), {
      from_user_id: "u@im.wechat",
      group_id: "g7",
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "hi" } }],
    });
    expect((s.enqueue as any).mock.calls[0][2]).toBe("t1:g7");
  });

  // Without a context_token the reply cannot be threaded, so accepting the turn
  // would wake a sandbox to produce an answer that can never be delivered.
  it("drops messages that could not be answered", async () => {
    const s = store();
    const edge = new WeixinEdge(s);
    await ingest(edge, { from_user_id: "u", item_list: [{ type: 1, text_item: { text: "hi" } }] });
    await ingest(edge, { context_token: "c", item_list: [{ type: 1, text_item: { text: "hi" } }] });
    await ingest(edge, { from_user_id: "u", context_token: "c", item_list: [] });
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("records rejection instead of killing the poll loop", async () => {
    const s = store({ enqueue: vi.fn(async () => { throw new Error("INVALID_MESSAGE"); }) as any });
    await ingest(new WeixinEdge(s), {
      from_user_id: "u", context_token: "c",
      item_list: [{ type: 1, text_item: { text: "hi" } }],
    });
    expect(s.event).toHaveBeenCalledWith("t1", "weixin-ingress-rejected", expect.anything());
  });
});

describe("weixin reply buffering", () => {
  const run = (over: Partial<Run> = {}) =>
    ({ id: "r1", tenant_id: "t1", channel: "weixin", message_id: null, ...over }) as Run;

  it("ignores deltas from other channels", () => {
    const edge = new WeixinEdge(store());
    edge.delta(run({ channel: "feishu" }), "x");
    expect((edge as any).buffers.size).toBe(0);
  });

  it("accumulates fragments, since iLink cannot edit a sent message", () => {
    const edge = new WeixinEdge(store());
    const r = run();
    edge.delta(r, "一");
    edge.delta(r, "二");
    expect((edge as any).buffers.get("r1")).toEqual(["一", "二"]);
  });

  it("sends nothing when the run carries no usable reply target", async () => {
    const s = store();
    const edge = new WeixinEdge(s);
    const r = run();
    edge.delta(r, "答案");
    edge.progress(r, "runtime-completed", {});
    await new Promise((res) => setTimeout(res, 0));
    expect(s.channelBinding).not.toHaveBeenCalled();
    expect((edge as any).buffers.size).toBe(0);
  });

  it("sends a completed reply with iLink's required message metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ret: 0 }));
    const s = store({
      channelBinding: vi.fn(async () => ({ state: "active" })) as any,
      channelCredentials: vi.fn(() => ({ botToken: "t", baseUrl: "https://region.weixin.qq.com" })) as any,
    });
    try {
      const edge = new WeixinEdge(s);
      const r = run({ message_id: encodeReplyTarget({ to: "u@im.wechat", ctx: "ctx-1" }) });
      edge.delta(r, "你好");
      edge.progress(r, "runtime-completed", {});
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://region.weixin.qq.com/ilink/bot/sendmessage");
      const body = JSON.parse(String(init.body));
      expect((init.headers as Record<string, string>)["iLink-App-Id"]).toBe("bot");
      expect(body.base_info).toMatchObject({ channel_version: "2.4.9", bot_agent: "MirrorVPortal/0.1.0" });
      expect(body.msg).toMatchObject({ from_user_id: "", to_user_id: "u@im.wechat", context_token: "ctx-1", message_state: 2 });
      expect(body.msg.client_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally { fetchMock.mockRestore(); }
  });
});
