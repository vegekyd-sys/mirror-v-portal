import { expect, test, vi } from "vitest";
import { StreamingReply } from "./streaming-reply.js";
function fixture() {
  const events: any[] = [];
  let row: any;
  const contents: string[] = [];
  const settings: any[] = [];
  const store: any = {
    event: async (...x: any[]) => events.push(x),
    pool: {
      query: async (sql: string, args: any[]) => {
        if (sql.startsWith("SELECT")) return { rows: row ? [row] : [] };
        if (sql.startsWith("INSERT")) row = { card_id: args[1], sequence: 0 };
        if (sql.includes("SET message_id")) row.message_id = args[1];
        if (sql.includes("SET sequence")) row.sequence = args[1];
        return { rows: [] };
      },
    },
  };
  const api: any = {
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async () => ({ code: 0, data: { card_id: "card1" } })),
          settings: async (x: any) => {
            settings.push(x);
            return { code: 0 };
          },
          update: async (x: any) => {
            settings.push({ data: { settings: x.data.card.data } });
            contents.push(
              JSON.parse(x.data.card.data).body.elements[0].content,
            );
            return { code: 0 };
          },
        },
        cardElement: {
          content: async (x: any) => {
            contents.push(x.data.content);
            return { code: 0 };
          },
        },
      },
    },
    im: {
      message: {
        reply: vi.fn(async () => ({
          code: 0,
          data: { message_id: "message1" },
        })),
      },
    },
  };
  return { store, api, events, contents, settings };
}
test("sends actual partial content before finish and closes the same card", async () => {
  const f = fixture(),
    stream = new StreamingReply(f.store, f.api, "run", "tenant", "parent");
  stream.push("首字");
  await new Promise((r) => setTimeout(r, 20));
  expect(f.api.im.message.reply).toHaveBeenCalledTimes(1);
  expect(f.events.some((x) => x[1] === "feishu-first-content")).toBe(true);
  stream.push("后续");
  expect(await stream.finish("首字后续")).toBe(true);
  expect(f.contents.at(-1)).toBe("首字后续");
  expect(f.settings.at(-1).data.settings).toContain("false");
  expect(f.api.im.message.reply).toHaveBeenCalledTimes(1);
});
test("reopens persisted card after process restart without a duplicate reply", async () => {
  const f = fixture();
  const a = new StreamingReply(f.store, f.api, "run", "tenant", "parent");
  a.push("前半");
  await new Promise((r) => setTimeout(r, 20));
  await a.finish("前半");
  const b = new StreamingReply(f.store, f.api, "run", "tenant", "parent");
  expect(await b.finish("前半及后半")).toBe(true);
  expect(f.api.im.message.reply).toHaveBeenCalledTimes(1);
  expect(f.contents.at(-1)).toBe("前半及后半");
});
test("stream API failures allow durable final fallback", async () => {
  const f = fixture();
  f.api.cardkit.v1.card.create.mockResolvedValue({ code: 999 });
  const a = new StreamingReply(f.store, f.api, "run", "tenant", "parent");
  a.push("test");
  expect(await a.finish("test")).toBe(false);
});
