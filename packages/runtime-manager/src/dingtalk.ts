import { DWClient, EventAck, TOPIC_ROBOT } from "dingtalk-stream";
import type { ChannelEdge } from "./channel-edge.js";
import { isSilentReply } from "./reply-sentinel.js";
import type { Run, Store, Tenant } from "./store.js";

/**
 * DingTalk via Stream Mode.
 *
 * Stream Mode is an outbound WebSocket the bot holds open, which is why this
 * lives in the manager rather than the sandbox: the sandbox is paused between
 * messages and the socket would die with it. It also means DingTalk needs no
 * inbound callback URL, so this works without a filed domain.
 *
 * Replies go to the sessionWebhook carried on each inbound message. That URL
 * expires (~1.5h), so it is stored on the run and used once; a turn that takes
 * longer than the webhook's life simply fails to deliver rather than being
 * silently dropped.
 */
interface DingtalkCredentials {
  clientId: string;
  clientSecret: string;
}
interface DingtalkInbound {
  msgtype?: string;
  text?: { content?: string };
  msgId?: string;
  conversationId?: string;
  conversationType?: string;
  senderStaffId?: string;
  senderNick?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  isAdmin?: boolean;
}

/** Reply address, kept on the run so a manager restart can still deliver. */
export interface DingtalkTarget {
  webhook: string;
  expiresAt?: number;
}
export const encodeTarget = (t: DingtalkTarget) => JSON.stringify(t);
export function decodeTarget(value: string | null): DingtalkTarget | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.webhook === "string" && parsed.webhook.startsWith("https://")
      ? (parsed as DingtalkTarget)
      : null;
  } catch {
    return null;
  }
}

export function inboundText(msg: DingtalkInbound): string {
  if (msg.msgtype && msg.msgtype !== "text") return "";
  return (msg.text?.content ?? "").trim();
}

export class DingtalkEdge implements ChannelEdge {
  readonly channel = "dingtalk";
  private clients = new Map<string, DWClient>();
  private buffers = new Map<string, string[]>();
  constructor(readonly store: Store) {}

  async start() {
    for (const binding of await this.store.channelBindings(this.channel)) {
      const creds = this.store.channelCredentials<DingtalkCredentials>(binding);
      this.spawn(binding.tenant_id, creds);
    }
  }

  async connect(tenant: Tenant) {
    if (this.clients.has(tenant.id)) return;
    const binding = await this.store.channelBinding(tenant.id, this.channel);
    if (!binding || binding.state !== "active") return;
    this.spawn(tenant.id, this.store.channelCredentials<DingtalkCredentials>(binding));
  }

  private spawn(tenantId: string, creds: DingtalkCredentials) {
    if (this.clients.has(tenantId)) return;
    // The SDK derives its subscriptions from the registered listeners and owns
    // reconnection; keepAlive drives its heartbeat.
    const client = new DWClient({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      keepAlive: true,
    });
    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      // Acknowledge on the socket regardless of what the turn does; a failed
      // enqueue must not make DingTalk redeliver and duplicate the message.
      try {
        await this.ingest(tenantId, res);
      } finally {
        try {
          client.socketCallBackResponse(res?.headers?.messageId, { status: EventAck.SUCCESS });
        } catch {}
      }
    });
    this.clients.set(tenantId, client);
    void Promise.resolve(client.connect()).catch(async (error: any) => {
      this.clients.delete(tenantId);
      const message = String(error?.message ?? error);
      // Bad credentials never recover by reconnecting.
      if (/401|403|invalid|unauthor/i.test(message))
        await this.store.revokeChannel(tenantId, this.channel, "DINGTALK_UNAUTHORIZED");
      await this.store.event(tenantId, "dingtalk-connect-failed", { message: message.slice(0, 200) });
    });
  }

  private async ingest(tenantId: string, res: any) {
    let msg: DingtalkInbound;
    try {
      msg = typeof res?.data === "string" ? JSON.parse(res.data) : res?.data;
    } catch {
      return;
    }
    const text = inboundText(msg ?? {});
    const webhook = msg?.sessionWebhook;
    // Without a sessionWebhook there is no way to answer, so do not wake a sandbox.
    if (!text || !webhook) return;
    const key = msg.msgId || `${msg.conversationId}:${Date.now()}`;
    const session = `${tenantId}:${msg.conversationId || msg.senderStaffId || "dm"}`;
    const target: DingtalkTarget = {
      webhook,
      ...(msg.sessionWebhookExpiredTime ? { expiresAt: msg.sessionWebhookExpiredTime } : {}),
    };
    try {
      await this.store.enqueue(tenantId, key, session, text, this.channel, encodeTarget(target));
    } catch (error: any) {
      await this.store.event(tenantId, "dingtalk-ingress-rejected", {
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  }

  /** The session webhook posts whole messages; fragments are joined at the end. */
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
    const target = decodeTarget(run.message_id);
    if (!text || !target) return;
    if (isSilentReply(text, run.schedule_kind)) {
      await this.store.event(run.tenant_id, "reply-suppressed", { marker: text.slice(0, 32) }, run.id);
      return;
    }
    if (target.expiresAt && Date.now() > target.expiresAt) {
      await this.store.event(run.tenant_id, "dingtalk-webhook-expired", {}, run.id);
      return;
    }
    try {
      const res = await fetch(target.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || (body?.errcode && body.errcode !== 0))
        throw new Error(`DINGTALK_SEND_${body?.errcode ?? res.status}`);
      await this.store.event(run.tenant_id, "dingtalk-reply-sent", { chars: text.length }, run.id);
    } catch (error: any) {
      await this.store.event(run.tenant_id, "dingtalk-reply-failed", {
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
  }

  /** Bind console-supplied credentials and start receiving. */
  async bind(tenantId: string, clientId: string, clientSecret: string) {
    await this.store.bindChannel(tenantId, this.channel, { clientId, clientSecret }, clientId);
    this.clients.get(tenantId)?.disconnect?.();
    this.clients.delete(tenantId);
    this.spawn(tenantId, { clientId, clientSecret });
  }

  get activeTenants() {
    return [...this.clients.keys()];
  }
}
