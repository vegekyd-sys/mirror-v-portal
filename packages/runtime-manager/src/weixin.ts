import { randomUUID } from "node:crypto";
import type { ChannelEdge } from "./channel-edge.js";
import type { Run, Store, Tenant } from "./store.js";
import { isSilentReply } from "./reply-sentinel.js";
import { ilinkBaseInfo, ilinkBaseUrl, ilinkPostHeaders } from "./ilink-protocol.js";

/**
 * Personal WeChat via iLink (Tencent's official ClawBot protocol).
 *
 * OpenClaw ships a weixin channel plugin, but it cannot be used here: the
 * plugin lives inside the agent process, and this runtime pauses the sandbox
 * between messages, which would drop the long poll and lose every message that
 * arrives while asleep. So the poll runs in the manager — the one process that
 * stays up — and a sandbox is woken only once a message has landed.
 *
 * iLink is a long poll, not a socket: getupdates holds for up to ~35s, returns
 * whatever arrived, and hands back a cursor to resume from. The cursor is
 * persisted per binding so a manager restart neither replays nor skips.
 */
const POLL_TIMEOUT_MS = 45_000; // server holds ~35s; allow margin before aborting
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

interface WeixinCredentials {
  botToken: string;
  baseUrl?: string;
}
interface ILinkItem {
  type?: number;
  text_item?: { text?: string };
}
interface ILinkMessage {
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: ILinkItem[];
}
interface ILinkUpdates {
  ret?: number;
  errmsg?: string;
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
}

/** Reply target, carried on the run so it survives a manager restart. */
interface ReplyTarget {
  to: string;
  ctx: string;
  group?: string;
}

export function encodeReplyTarget(t: ReplyTarget) {
  return JSON.stringify(t);
}
export function decodeReplyTarget(value: string | null): ReplyTarget | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.to && parsed?.ctx ? (parsed as ReplyTarget) : null;
  } catch {
    return null;
  }
}

/** Text lives in item_list entries of type 1; anything else is ignored for now. */
export function extractText(msg: ILinkMessage): string {
  return (msg.item_list ?? [])
    .filter((i) => i.type === 1 && i.text_item?.text)
    .map((i) => i.text_item!.text!)
    .join("")
    .trim();
}

export class WeixinEdge implements ChannelEdge {
  readonly channel = "weixin";
  private polls = new Map<string, AbortController>();
  private buffers = new Map<string, string[]>();
  constructor(readonly store: Store) {}

  private headers(token: string) {
    return ilinkPostHeaders(token);
  }

  private async call<T>(token: string, path: string, body: Record<string, unknown>, signal?: AbortSignal, baseUrl?: string): Promise<T> {
    const res = await fetch(`${ilinkBaseUrl(baseUrl)}${path}`, {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({ ...body, base_info: ilinkBaseInfo() }),
      signal,
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("ILINK_UNAUTHORIZED"), { fatal: true });
    if (!res.ok) throw new Error(`ILINK_HTTP_${res.status}`);
    return (await res.json()) as T;
  }

  async start() {
    for (const binding of await this.store.channelBindings(this.channel)) {
      const { botToken, baseUrl } = this.store.channelCredentials<WeixinCredentials>(binding);
      this.spawnPoll(binding.tenant_id, botToken, binding.cursor ?? "", baseUrl);
    }
  }

  async connect(tenant: Tenant) {
    if (this.polls.has(tenant.id)) return;
    const binding = await this.store.channelBinding(tenant.id, this.channel);
    if (!binding || binding.state !== "active") return;
    const { botToken, baseUrl } = this.store.channelCredentials<WeixinCredentials>(binding);
    this.spawnPoll(tenant.id, botToken, binding.cursor ?? "", baseUrl);
  }

  private spawnPoll(tenantId: string, token: string, cursor: string, baseUrl?: string) {
    if (this.polls.has(tenantId)) return;
    const abort = new AbortController();
    this.polls.set(tenantId, abort);
    void this.pollLoop(tenantId, token, cursor, abort.signal, baseUrl).finally(() => {
      this.polls.delete(tenantId);
    });
  }

  private async pollLoop(tenantId: string, token: string, cursor: string, signal: AbortSignal, baseUrl?: string) {
    let failures = 0;
    while (!signal.aborted) {
      const timer = AbortSignal.timeout(POLL_TIMEOUT_MS);
      const merged = AbortSignal.any([signal, timer]);
      try {
        const res = await this.call<ILinkUpdates>(
          token,
          "/ilink/bot/getupdates",
          { get_updates_buf: cursor },
          merged,
          baseUrl,
        );
        if (res.ret && res.ret !== 0) throw new Error(`ILINK_GETUPDATES_RET_${res.ret}`);
        failures = 0;
        for (const msg of res.msgs ?? []) await this.ingest(tenantId, msg);
        // Advance only after the batch is durably enqueued, so a crash re-reads it.
        if (res.get_updates_buf && res.get_updates_buf !== cursor) {
          cursor = res.get_updates_buf;
          await this.store.saveChannelCursor(tenantId, this.channel, cursor);
        }
      } catch (error: any) {
        if (signal.aborted) return;
        if (error?.fatal) {
          // A revoked token never recovers by retrying; surface it instead of looping.
          await this.store.revokeChannel(tenantId, this.channel, "ILINK_UNAUTHORIZED");
          await this.store.event(tenantId, "weixin-revoked", { reason: "unauthorized" });
          return;
        }
        if (error?.name !== "TimeoutError" && error?.name !== "AbortError") {
          const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
          await this.store.event(tenantId, "weixin-poll-error", {
            message: String(error?.message ?? error).slice(0, 200),
            retryInMs: wait,
          });
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
  }

  private async ingest(tenantId: string, msg: ILinkMessage) {
    const text = extractText(msg);
    const from = msg.from_user_id;
    const ctx = msg.context_token;
    // Without a context_token a reply cannot be threaded, so the turn is unanswerable.
    if (!text || !from || !ctx) return;
    const target: ReplyTarget = { to: from, ctx, ...(msg.group_id ? { group: msg.group_id } : {}) };
    const session = `${tenantId}:${msg.group_id || from}`;
    try {
      await this.store.enqueue(tenantId, ctx, session, text, this.channel, encodeReplyTarget(target));
    } catch (error: any) {
      await this.store.event(tenantId, "weixin-ingress-rejected", {
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  }

  /**
   * iLink has no message editing, so a reply cannot be revised as it streams.
   * Fragments accumulate and are sent once, when the turn completes.
   */
  delta(run: Run, text: string) {
    if (run.channel !== this.channel || !text) return;
    const buffer = this.buffers.get(run.id) ?? [];
    buffer.push(text);
    this.buffers.set(run.id, buffer);
  }

  progress(run: Run, kind: string, _data: unknown) {
    if (run.channel !== this.channel) return;
    if (kind === "runtime-completed") void this.flush(run);
  }

  private async flush(run: Run) {
    const buffer = this.buffers.get(run.id);
    this.buffers.delete(run.id);
    const text = (buffer ?? []).join("").trim();
    const target = decodeReplyTarget(run.message_id);
    if (!text || !target) return;
    // The agent asked to stay silent; delivering the marker would put the word
    // "NO_REPLY" in the user's chat.
    if (isSilentReply(text, run.schedule_kind)) {
      await this.store.event(run.tenant_id, "reply-suppressed", { marker: text.slice(0, 32) }, run.id);
      return;
    }
    const binding = await this.store.channelBinding(run.tenant_id, this.channel);
    if (!binding || binding.state !== "active") return;
    const { botToken, baseUrl } = this.store.channelCredentials<WeixinCredentials>(binding);
    try {
      const sent = await this.call<{ ret?: number }>(botToken, "/ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: target.to,
          client_id: randomUUID(),
          ...(target.group ? { group_id: target.group } : {}),
          message_type: 2,
          message_state: 2,
          context_token: target.ctx,
          item_list: [{ type: 1, text_item: { text } }],
        },
      }, undefined, baseUrl);
      if (sent.ret && sent.ret !== 0) throw new Error(`ILINK_SEND_RET_${sent.ret}`);
      await this.store.event(run.tenant_id, "weixin-reply-sent", { chars: text.length }, run.id);
    } catch (error: any) {
      await this.store.event(run.tenant_id, "weixin-reply-failed", {
        message: String(error?.message ?? error).slice(0, 200),
      }, run.id);
    }
  }

  close() {
    for (const abort of this.polls.values()) abort.abort();
    this.polls.clear();
    this.buffers.clear();
  }

  /** Called by the login flow once a QR scan yields a bot token. */
  async bind(tenantId: string, botToken: string, accountId?: string, baseUrl?: string) {
    const verifiedBaseUrl = ilinkBaseUrl(baseUrl);
    await this.store.bindChannel(tenantId, this.channel, { botToken, baseUrl: verifiedBaseUrl }, accountId);
    this.polls.get(tenantId)?.abort();
    this.polls.delete(tenantId);
    this.spawnPoll(tenantId, botToken, "", verifiedBaseUrl);
  }

  /** Exposed for tests and diagnostics. */
  get activeTenants() {
    return [...this.polls.keys()];
  }
}
