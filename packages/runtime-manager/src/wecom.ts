import { WSClient, WSAuthFailureError } from "@wecom/aibot-node-sdk";
import type { ChannelEdge } from "./channel-edge.js";
import { isSilentReply } from "./reply-sentinel.js";
import type { Run, Store, Tenant } from "./store.js";

/**
 * WeCom (企业微信) smart bots over the official AI-bot SDK.
 *
 * Like DingTalk, WeCom dials out over a WebSocket rather than calling an
 * inbound webhook, so this needs no public callback URL and no filed domain.
 * And like every other surface here, the socket must live in the manager: the
 * sandbox is paused between messages and would drop it.
 *
 * Replies have two routes. The live socket frame allows a streamed reply, but
 * it only exists while this process holds the connection that received the
 * message. Each inbound message also carries a response_url usable for a
 * later out-of-band reply, which is persisted on the run — so a turn whose
 * answer arrives after a manager restart is still delivered, just not streamed.
 */
interface WecomCredentials {
  botId: string;
  secret: string;
}

export interface WecomTarget {
  responseUrl?: string;
  chatId?: string;
  chatType?: string;
}
export const encodeTarget = (t: WecomTarget) => JSON.stringify(t);
export function decodeTarget(value: string | null): WecomTarget | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as WecomTarget) : null;
  } catch {
    return null;
  }
}

export function inboundText(body: any): string {
  if (body?.msgtype && body.msgtype !== "text") return "";
  return String(body?.text?.content ?? "").trim();
}

export class WecomEdge implements ChannelEdge {
  readonly channel = "wecom";
  private clients = new Map<string, WSClient>();
  private buffers = new Map<string, string[]>();
  /** Live frame headers by run, usable for a streamed reply while connected. */
  private frames = new Map<string, { tenantId: string; headers: any }>();
  constructor(readonly store: Store) {}

  async start() {
    for (const binding of await this.store.channelBindings(this.channel)) {
      this.spawn(binding.tenant_id, this.store.channelCredentials<WecomCredentials>(binding));
    }
  }

  async connect(tenant: Tenant) {
    if (this.clients.has(tenant.id)) return;
    const binding = await this.store.channelBinding(tenant.id, this.channel);
    if (!binding || binding.state !== "active") return;
    this.spawn(tenant.id, this.store.channelCredentials<WecomCredentials>(binding));
  }

  private spawn(tenantId: string, creds: WecomCredentials) {
    if (this.clients.has(tenantId)) return;
    const client = new WSClient({
      botId: creds.botId,
      secret: creds.secret,
      maxReconnectAttempts: -1, // a dropped socket is normal; never stop trying
    });
    client.on("message.text", (frame: any) => {
      void this.ingest(tenantId, frame);
    });
    client.on("error", async (error: any) => {
      const message = String(error?.message ?? error);
      // Bad credentials never recover by reconnecting; a dropped socket does.
      if (error instanceof WSAuthFailureError) {
        this.clients.delete(tenantId);
        try {
          client.disconnect();
        } catch {}
        await this.store.revokeChannel(tenantId, this.channel, "WECOM_AUTH_FAILED");
        await this.store.event(tenantId, "wecom-revoked", { message: message.slice(0, 200) });
        return;
      }
      await this.store.event(tenantId, "wecom-socket-error", { message: message.slice(0, 200) });
    });
    try {
      client.connect();
      this.clients.set(tenantId, client);
    } catch (error: any) {
      void this.store.event(tenantId, "wecom-connect-failed", {
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  }

  private async ingest(tenantId: string, frame: any) {
    const body = frame?.body;
    const text = inboundText(body);
    if (!text) return;
    // msgid is WeCom's own dedup key, which is exactly what enqueue wants.
    const key = String(body?.msgid ?? "");
    if (!key) return;
    const session = `${tenantId}:${body?.chatid || body?.from?.userid || "dm"}`;
    const target: WecomTarget = {
      ...(body?.response_url ? { responseUrl: body.response_url } : {}),
      ...(body?.chatid ? { chatId: body.chatid } : {}),
      ...(body?.chattype ? { chatType: body.chattype } : {}),
    };
    try {
      const run = await this.store.enqueue(tenantId, key, session, text, this.channel, encodeTarget(target));
      if (frame?.headers) this.frames.set(run.id, { tenantId, headers: frame.headers });
    } catch (error: any) {
      await this.store.event(tenantId, "wecom-ingress-rejected", {
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  }

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
    const frame = this.frames.get(run.id);
    this.frames.delete(run.id);
    const text = (buffer ?? []).join("").trim();
    if (!text) return;
    if (isSilentReply(text, run.schedule_kind)) {
      await this.store.event(run.tenant_id, "reply-suppressed", { marker: text.slice(0, 32) }, run.id);
      return;
    }

    const client = this.clients.get(run.tenant_id);
    if (frame && client) {
      try {
        await client.replyStream(frame.headers, run.id, text, true);
        await this.store.event(run.tenant_id, "wecom-reply-sent", { via: "stream", chars: text.length }, run.id);
        return;
      } catch (error: any) {
        await this.store.event(run.tenant_id, "wecom-stream-failed", {
          message: String(error?.message ?? error).slice(0, 200),
        }, run.id);
        // fall through to the out-of-band URL
      }
    }

    // No live frame — the socket reconnected or the manager restarted mid-turn.
    const target = decodeTarget(run.message_id);
    if (!target?.responseUrl) {
      await this.store.event(run.tenant_id, "wecom-reply-undeliverable", {}, run.id);
      return;
    }
    try {
      const res = await fetch(target.responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || (body?.errcode && body.errcode !== 0))
        throw new Error(`WECOM_SEND_${body?.errcode ?? res.status}`);
      await this.store.event(run.tenant_id, "wecom-reply-sent", { via: "response_url", chars: text.length }, run.id);
    } catch (error: any) {
      await this.store.event(run.tenant_id, "wecom-reply-failed", {
        message: String(error?.message ?? error).slice(0, 200),
      }, run.id);
    }
  }

  close() {
    for (const client of this.clients.values()) {
      try {
        client.disconnect();
      } catch {}
    }
    this.clients.clear();
    this.buffers.clear();
    this.frames.clear();
  }

  /** botId/secret come from WeCom's one-click bot creation scan. */
  async bind(tenantId: string, botId: string, secret: string) {
    await this.store.bindChannel(tenantId, this.channel, { botId, secret }, botId);
    try {
      this.clients.get(tenantId)?.disconnect();
    } catch {}
    this.clients.delete(tenantId);
    this.spawn(tenantId, { botId, secret });
  }

  get activeTenants() {
    return [...this.clients.keys()];
  }
}
