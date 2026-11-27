/**
 * Who may start a turn in a Feishu chat.
 *
 * - Direct chats: the owner, as before.
 * - Groups: only messages that @ this bot (or @all). New apps hold im:message.group_msg, so
 *   Feishu now delivers every group message; without this gate the agent would answer all of them.
 * - Other bots (sender_type "app"), so Mirror V and V can talk in a group. Feishu itself only
 *   delivers another bot's message when it @s this bot. Our own messages are dropped, and each
 *   (chat, sending bot) pair is limited to OpenClaw's bot-loop default, 20 messages a minute, so
 *   two bots that keep @-ing each other stop instead of looping.
 */
export const BOT_PAIR_LIMIT = { count: 20, windowMs: 60_000 };

export type SenderVerdict = "accept" | "self" | "not-mentioned" | "bot-unknown" | "bot-loop";

interface Mention { key?: string; id?: { open_id?: string } }

export function mentionsBot(mentions: unknown, botOpenId: string | undefined): boolean {
  const list: Mention[] = Array.isArray(mentions) ? mentions : [];
  if (list.some((m) => m?.key === "@_all")) return true;
  // Bot identity unknown (lookup failed): any mention counts, which is what Feishu delivered
  // before apps could read every group message.
  if (!botOpenId) return list.length > 0;
  return list.some((m) => m?.id?.open_id === botOpenId);
}

export class BotLoopGuard {
  private seen = new Map<string, number[]>();
  constructor(private limit = BOT_PAIR_LIMIT) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.seen.get(key) ?? []).filter((t) => now - t < this.limit.windowMs);
    const ok = recent.length < this.limit.count;
    if (ok) recent.push(now);
    this.seen.set(key, recent);
    if (this.seen.size > 5000) for (const [k, v] of this.seen) if (!v.some((t) => now - t < this.limit.windowMs)) this.seen.delete(k);
    return ok;
  }
}

export function judgeSender(
  input: { tenantId: string; chatId: string; chatType?: string; senderType?: string; senderOpenId?: string; mentions?: unknown; botOpenId?: string },
  guard: BotLoopGuard,
  now = Date.now(),
): SenderVerdict {
  const fromBot = input.senderType === "app";
  if (fromBot && !input.botOpenId) return "bot-unknown"; // cannot tell our own messages apart: fail closed
  if (fromBot && input.senderOpenId === input.botOpenId) return "self";
  if (input.chatType === "group" && !mentionsBot(input.mentions, input.botOpenId)) return "not-mentioned";
  if (fromBot && !guard.allow(`${input.tenantId}:${input.chatId}:${input.senderOpenId ?? "?"}`, now)) return "bot-loop";
  return "accept";
}
