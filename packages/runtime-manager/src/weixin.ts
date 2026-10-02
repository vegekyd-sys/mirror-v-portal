import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelEdge } from "./channel-edge.js";
import type { Run, Store, Tenant } from "./store.js";
import { isSilentReply } from "./reply-sentinel.js";
import { ilinkBaseInfo, ilinkBaseUrl, ilinkPostHeaders } from "./ilink-protocol.js";
import { downloadIlinkImage, ILinkMediaError, type ILinkImageItem } from "./ilink-media.js";
import { IMAGE_EXTENSIONS, MAX_INBOUND_IMAGE_BYTES, MAX_INBOUND_IMAGES, normalizeInboundAttachments, type InboundAttachment } from "./inbound-media.js";

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
interface ILinkItem extends ILinkImageItem {
  type?: number;
  text_item?: { text?: string };
}
interface ILinkMessage {
  message_id?: number | string;
  client_id?: string;
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

/** Text and media are separate protocol items; an image needs no text caption. */
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
  private ingressFailures = new Map<string, number>();
  constructor(readonly store: Store, private readonly downloadImage = downloadIlinkImage) {}

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
        for (const msg of res.msgs ?? []) await this.ingest(tenantId, msg, signal);
        // Advance only after the batch is durably enqueued, so a crash re-reads it.
        if (res.get_updates_buf && res.get_updates_buf !== cursor) {
          await this.store.saveChannelCursor(tenantId, this.channel, res.get_updates_buf);
          cursor = res.get_updates_buf;
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

  private async receiptDirectory(tenantId: string, messageHash: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId) || !/^[a-f0-9]{64}$/.test(messageHash)) throw Error("INBOUND_ATTACHMENT_DIRECTORY_INVALID");
    const root = await fs.realpath(this.store.config.dataDir);
    let directory = root;
    // Every intermediate directory is private, tenant-scoped and never a symlink.
    for (const segment of ["inbound", tenantId, messageHash]) {
      directory = path.join(directory, segment);
      await fs.mkdir(directory, {mode: 0o700}).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("INBOUND_ATTACHMENT_DIRECTORY_INVALID");
    }
    return directory;
  }

  /** Keep a recoverable encrypted wire receipt before the cursor can move. Never send it to the sandbox. */
  private async persistEncryptedMessage(tenantId: string, messageHash: string, requestKey: string, message: ILinkMessage) {
    const raw = JSON.stringify({schemaVersion:1,tenantId,messageHash,requestKey,receivedAt:new Date().toISOString(),message});
    if (Buffer.byteLength(raw) > 512 * 1024) throw Error("INBOUND_RECEIPT_TOO_LARGE");
    const directory = await this.receiptDirectory(tenantId,messageHash);
    const filename = path.join(directory,"message.sealed");
    const previous = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {if(error.code !== "ENOENT") throw error; return undefined;});
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw Error("INBOUND_ATTACHMENT_DIRECTORY_INVALID");
    const temporary = path.join(directory,`.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary,"wx",0o600);
      try {await handle.writeFile(this.store.seal(raw)); await handle.sync();} finally {await handle.close();}
      await fs.rename(temporary,filename);
      const dirHandle = await fs.open(directory,"r");
      try {await dirHandle.sync();} finally {await dirHandle.close();}
    } finally {await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {if(error.code !== "ENOENT") throw error;});}
  }

  private async persistImage(tenantId: string, messageHash: string, image: Awaited<ReturnType<typeof downloadIlinkImage>>): Promise<InboundAttachment> {
    const storagePath = `inbound/${tenantId}/${messageHash}/${image.sha256}.${IMAGE_EXTENSIONS[image.mimeType]}`;
    const [attachment] = normalizeInboundAttachments([{kind: "image", mimeType: image.mimeType, storagePath, sha256: image.sha256, bytes: image.bytes, filename: image.filename}], tenantId);
    const directory = await this.receiptDirectory(tenantId,messageHash);
    const filename = path.join(directory,path.posix.basename(storagePath));
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(image.buffer); await handle.sync(); }
      finally { await handle.close(); }
      // Link a complete synced file atomically; a replay cannot replace existing bytes.
      await fs.link(temporary, filename).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.bytes) throw Error("INBOUND_ATTACHMENT_CONFLICT");
        const previous = await fs.readFile(filename);
        if (createHash("sha256").update(previous).digest("hex") !== image.sha256) throw Error("INBOUND_ATTACHMENT_CONFLICT");
      });
      const dirHandle = await fs.open(directory, "r");
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});
    }
    return attachment;
  }

  private async ingest(tenantId: string, msg: ILinkMessage, signal?: AbortSignal) {
    const text = extractText(msg);
    const images = (msg.item_list ?? []).filter(item => item.type === 2);
    const from = msg.from_user_id;
    const ctx = msg.context_token;
    // Without a context_token a reply cannot be threaded, so the turn is unanswerable.
    if ((!text && !images.length) || !from || !ctx || msg.message_type === 2) return;
    const target: ReplyTarget = { to: from, ctx, ...(msg.group_id ? { group: msg.group_id } : {}) };
    const session = `${tenantId}:${msg.group_id || from}`;
    // context_token addresses the reply and may be shared by consecutive messages.
    // Prefer the actual wire message identity; retain old clients' fallback key.
    const wireId = msg.message_id ?? msg.client_id;
    const requestKey = wireId === undefined
      ? images.length ? `weixin-media:${createHash("sha256").update(JSON.stringify([from, msg.group_id ?? "", ctx, text, images])).digest("hex")}` : ctx
      : `weixin:${createHash("sha256").update(JSON.stringify([from, msg.group_id ?? "", wireId])).digest("hex")}`;
    const messageHash = createHash("sha256").update(requestKey).digest("hex");
    const started = Date.now();
    let stage = "receipt";
    try {
      const attachments: InboundAttachment[] = [];
      if (images.length > MAX_INBOUND_IMAGES) throw Error("INBOUND_ATTACHMENTS_TOO_MANY");
      if (images.length) await this.persistEncryptedMessage(tenantId,messageHash,requestKey,msg);
      for (const image of images) {
        stage = "download";
        const received = await this.downloadImage(image, {signal, maxBytes: MAX_INBOUND_IMAGE_BYTES});
        stage = "persist";
        attachments.push(await this.persistImage(tenantId, messageHash, received));
      }
      stage = "validate";
      normalizeInboundAttachments(attachments, tenantId);
      const input = text || "本条消息只有用户图片，没有附带文字。请确认收到；若此前同会话已有明确且未完成的创作要求，请使用这份实际原图继续完成。否则仅确认收到，等待用户说明怎么处理，不要自行生成或编辑。";
      stage = "enqueue";
      await this.store.enqueue(tenantId, requestKey, session, input, this.channel, encodeReplyTarget(target), ...(attachments.length ? [attachments] as const : []));
      this.ingressFailures.delete(`${tenantId}:${messageHash}`);
      if (attachments.length) await this.store.event(tenantId, "weixin-images-received", {count: attachments.length, bytes: attachments.reduce((total, a) => total + a.bytes, 0), sha256: attachments.map(a => a.sha256)});
    } catch (error: any) {
      if (signal?.aborted) throw Error("ILINK_INGRESS_ABORTED");
      await this.store.event(tenantId, "weixin-ingress-rejected", {
        // Downloader errors and filesystem paths can contain credentials. Use no raw exception strings for media.
        message: images.length ? "ILINK_IMAGE_INGRESS_FAILED" : String(error?.message ?? error).slice(0, 200),
        ...(images.length ? {elapsedMs:Date.now()-started,imageCount:images.length,
          code:error instanceof ILinkMediaError && /^ILINK_MEDIA_[A-Z_]{1,80}$/.test(error.code) ? error.code :
            /^(?:INBOUND_ATTACHMENT|INBOUND_RECEIPT|INBOUND_ATTACHMENTS)[A-Z_]*$/.test(error?.message??"") ? error.message : "ILINK_IMAGE_INGRESS_FAILED",
          ...(error instanceof ILinkMediaError ? {...error.details,...(error.httpStatus ? {httpStatus:error.httpStatus} : {})} :
            {stage,...(["EACCES","ENOENT","EPERM","EIO","ENOSPC","EMFILE","EROFS","EXDEV"].includes(error?.code) ? {filesystemCode:error.code} : {})})} : {}),
      });
      if (images.length) {
        const failureKey = `${tenantId}:${messageHash}`;
        const failures = (this.ingressFailures.get(failureKey) ?? 0) + 1;
        this.ingressFailures.set(failureKey, failures);
        // Keep the cursor until retrying the download. A permanently bad attachment
        // receives a durable failure turn so the user can resend and the poll can progress.
        if (failures < 3) throw Error("ILINK_IMAGE_INGRESS_RETRY");
        await this.store.enqueue(tenantId, requestKey, session,
          "微信图片在本系统接收处理时失败，尚未得到可用图片。这是接入链路问题，未证实是用户图片的问题。请简短说明图片接收失败、系统正在排查；不要建议用户换图、保存原图或反复重发。不要根据旧图或猜测创作，也不要调用生成工具。",
          this.channel, encodeReplyTarget(target), [], {inheritAttachments: false});
        this.ingressFailures.delete(failureKey);
      }
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
    this.ingressFailures.clear();
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
