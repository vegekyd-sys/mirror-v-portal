import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WeixinEdge, extractText, encodeReplyTarget, decodeReplyTarget } from "./weixin.js";
import type { Run, Store } from "./store.js";
import type { ILinkDecodedImage } from "./ilink-media.js";

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

describe("weixin image ingress", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true,force:true}))); });
  const received = (): ILinkDecodedImage => {
    const buffer = Buffer.from("verified-downloaded-image-bytes");
    return {buffer,bytes:buffer.length,mimeType:"image/jpeg",filename:"wechat-image.jpg",sha256:createHash("sha256").update(buffer).digest("hex"),md5:createHash("md5").update(buffer).digest("hex"),encrypted:true};
  };
  const setup = async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-inbound-"));
    roots.push(dataDir);
    const s = store({config:{dataDir} as any});
    const download = vi.fn(async () => received());
    return {s,download,dataDir,edge:new WeixinEdge(s,download)};
  };
  const message = (id = 1, text?: string) => ({message_id:id,from_user_id:"u@im.wechat",context_token:"secret-reply-token",
    item_list:[{type:2,image_item:{aeskey:"secret-key",media:{encrypt_query_param:"secret-cdn-query"}}},...(text ? [{type:1,text_item:{text}}] : [])]});

  it("accepts image-only messages, saves exact private bytes, and asks only for acknowledgement", async () => {
    const {s,edge,dataDir,download} = await setup();
    await ingest(edge,message());
    expect(download).toHaveBeenCalledOnce();
    const call = (s.enqueue as any).mock.calls[0];
    expect(call[2]).toBe("t1:u@im.wechat");
    expect(call[3]).toContain("不要自行生成或编辑");
    expect(call[4]).toBe("weixin");
    expect(call[6]).toHaveLength(1);
    const attachment = call[6][0];
    expect(attachment).toMatchObject({kind:"image",sha256:received().sha256,bytes:received().bytes,mimeType:"image/jpeg"});
    expect(attachment.storagePath).toMatch(/^inbound\/t1\/[a-f0-9]{64}\/[a-f0-9]{64}\.jpg$/);
    expect(await fs.readFile(path.join(dataDir,attachment.storagePath))).toEqual(received().buffer);
    expect((await fs.stat(path.join(dataDir,attachment.storagePath))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(attachment)).not.toMatch(/secret-|aeskey|encrypt_query_param/);
    expect(s.event).toHaveBeenCalledWith("t1","weixin-images-received",expect.objectContaining({count:1,bytes:received().bytes}));
  });

  it("preserves text with an image and retains separate identities when image then caption share a reply context", async () => {
    const {s,edge} = await setup();
    await ingest(edge,message(1,"给这个小女孩做个海报"));
    await ingest(edge,{message_id:2,from_user_id:"u@im.wechat",context_token:"secret-reply-token",item_list:[{type:1,text_item:{text:"保持原来的脸"}}]});
    const calls = (s.enqueue as any).mock.calls;
    expect(calls[0][3]).toBe("给这个小女孩做个海报");
    expect(calls[0][0]).toBe(calls[1][0]);
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[0][1]).not.toBe(calls[1][1]);
    expect(calls[1][3]).toBe("保持原来的脸");
  });

  it("replays with the same dedup identity and one immutable byte file", async () => {
    const {s,edge,dataDir} = await setup();
    await ingest(edge,message());
    await ingest(edge,message());
    const calls = (s.enqueue as any).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    const directory = path.dirname(path.join(dataDir,calls[0][6][0].storagePath));
    expect(await fs.readdir(directory)).toEqual([`${received().sha256}.jpg`]);
  });

  it("enqueues image-only then a separate caption, including legacy messages without wire IDs", async () => {
    const {s,edge} = await setup();
    const photo = {...message(),message_id:undefined};
    await ingest(edge,photo);
    await ingest(edge,{from_user_id:photo.from_user_id,context_token:photo.context_token,item_list:[{type:1,text_item:{text:"给这个小女孩做个海报"}}]});
    await ingest(edge,photo);
    const calls = (s.enqueue as any).mock.calls;
    expect(calls[0][1]).not.toBe(calls[1][1]);
    expect(calls[0][1]).toBe(calls[2][1]);
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[0][6]).toHaveLength(1);
    expect(calls[1][3]).toBe("给这个小女孩做个海报");
  });

  it("prefers the server message identity over a changing client identity", async () => {
    const {s,edge} = await setup();
    await ingest(edge,{...message(),client_id:"client-a"});
    await ingest(edge,{...message(),client_id:"client-b"});
    const calls = (s.enqueue as any).mock.calls;
    expect(calls[0][1]).toBe(calls[1][1]);
  });

  it("keeps failures retryable without persisting or logging secret wire metadata", async () => {
    const {s,dataDir} = await setup();
    const download = vi.fn(async () => {throw Error("secret-cdn-query secret-key");});
    const edge = new WeixinEdge(s,download);
    await expect(ingest(edge,message())).rejects.toThrow("ILINK_IMAGE_INGRESS_RETRY");
    await expect(ingest(edge,message())).rejects.toThrow("ILINK_IMAGE_INGRESS_RETRY");
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(await fs.readdir(dataDir)).toEqual([]);
    await ingest(edge,message());
    const call = (s.enqueue as any).mock.calls[0];
    expect(call[3]).toContain("接收失败");
    expect(call[3]).toContain("不要调用生成工具");
    expect(call[6]).toEqual([]);
    expect(call[7]).toEqual({inheritAttachments:false});
    expect(JSON.stringify((s.event as any).mock.calls)).not.toMatch(/secret-cdn-query|secret-key/);
  });

  it("refuses oversized batches and cannot write through a controller symlink", async () => {
    const {s,edge,dataDir,download} = await setup();
    const over = message();
    over.item_list = Array.from({length:5},() => over.item_list[0]);
    await expect(ingest(edge,over)).rejects.toThrow("ILINK_IMAGE_INGRESS_RETRY");
    expect(download).not.toHaveBeenCalled();
    const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-private-"));
    roots.push(unrelated);
    await fs.symlink(unrelated,path.join(dataDir,"inbound"));
    await expect(ingest(edge,message(2))).rejects.toThrow("ILINK_IMAGE_INGRESS_RETRY");
    expect(await fs.readdir(unrelated)).toEqual([]);
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("ignores bot echoes instead of enqueueing its own images", async () => {
    const {s,edge,download} = await setup();
    await ingest(edge,{...message(),message_type:2});
    expect(download).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("advances the poll cursor only after image and subsequent caption are durably enqueued", async () => {
    const {s,edge} = await setup();
    const abort = new AbortController();
    const order: string[] = [];
    (s.enqueue as any).mockImplementation(async (...args: any[]) => {order.push(args[6]?.length ? "image" : "caption");return {id:"run-1"};});
    (s.saveChannelCursor as any).mockImplementation(async () => {order.push("cursor");abort.abort();});
    (edge as any).call = vi.fn(async () => ({msgs:[message(),{message_id:2,from_user_id:"u@im.wechat",context_token:"secret-reply-token",item_list:[{type:1,text_item:{text:"做海报"}}]}],get_updates_buf:"next-cursor"}));
    await (edge as any).pollLoop("t1","private-token","old-cursor",abort.signal);
    expect(order).toEqual(["image","caption","cursor"]);
    expect(s.saveChannelCursor).toHaveBeenCalledWith("t1","weixin","next-cursor");
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
