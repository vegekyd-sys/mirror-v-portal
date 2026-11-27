import { expect, test } from "vitest";
import { BotLoopGuard, judgeSender, mentionsBot } from "./feishu-senders.js";

const base = { tenantId: "t", chatId: "oc_group", botOpenId: "ou_me" };
const atMe = [{ key: "@_user_1", id: { open_id: "ou_me" } }];

test("direct chats pass; groups need an @ of this bot (or @all)", () => {
  const g = new BotLoopGuard();
  expect(judgeSender({ ...base, chatType: "p2p", senderType: "user" }, g)).toBe("accept");
  expect(judgeSender({ ...base, chatType: "group", senderType: "user" }, g)).toBe("not-mentioned");
  expect(judgeSender({ ...base, chatType: "group", senderType: "user", mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }] }, g)).toBe("not-mentioned");
  expect(judgeSender({ ...base, chatType: "group", senderType: "user", mentions: atMe }, g)).toBe("accept");
  expect(mentionsBot([{ key: "@_all" }], "ou_me")).toBe(true);
  // Unknown identity: any mention counts (what Feishu delivered before the group_msg scope).
  expect(mentionsBot([{ key: "@_user_1", id: { open_id: "ou_x" } }], undefined)).toBe(true);
  expect(mentionsBot([], undefined)).toBe(false);
});

test("other bots may talk when they @ us; our own messages and unknown identity are dropped", () => {
  const g = new BotLoopGuard();
  expect(judgeSender({ ...base, chatType: "group", senderType: "app", senderOpenId: "ou_v", mentions: atMe }, g)).toBe("accept");
  expect(judgeSender({ ...base, chatType: "group", senderType: "app", senderOpenId: "ou_me", mentions: atMe }, g)).toBe("self");
  expect(judgeSender({ ...base, botOpenId: undefined, chatType: "group", senderType: "app", senderOpenId: "ou_v", mentions: atMe }, g)).toBe("bot-unknown");
});

test("a bot pair is limited to 20 messages a minute, then recovers", () => {
  const g = new BotLoopGuard(), msg = { ...base, chatType: "group", senderType: "app", senderOpenId: "ou_v", mentions: atMe };
  const verdicts = Array.from({ length: 21 }, (_, i) => judgeSender(msg, g, 1000 + i));
  expect(verdicts.filter((v) => v === "accept")).toHaveLength(20);
  expect(verdicts[20]).toBe("bot-loop");
  expect(judgeSender({ ...msg, senderOpenId: "ou_other_bot" }, g, 1100)).toBe("accept"); // per pair
  expect(judgeSender(msg, g, 1000 + 61_000)).toBe("accept");
});
