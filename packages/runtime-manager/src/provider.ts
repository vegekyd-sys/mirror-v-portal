import type { TemplateRecord } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import { FinalMediaCollector, parseReply, resolveRef, mediaKind, type MediaDirective } from "./media-directive.js";
import { readInboundImage, normalizeInboundAttachments, InboundMediaError, type InboundAttachment } from "./inbound-media.js";
import type { Config } from "./config.js";
import type { Tenant } from "./store.js";

export async function finishOutput(sink: Writable) {
  sink.end();
  await finished(sink);
}

export interface RuntimeHandle {
  name: string;
  /** Public https origins of the template's named ports, when it exposes any. */
  publicUrls?: Record<string, string>;
  reused: boolean;
  wakeMs: number;
  timings?: Record<string, number | boolean>;
}
export interface RuntimeProvider {
  ensure(
    tenant: Tenant,
    onProvision?: (name: string) => Promise<void>,
  ): Promise<RuntimeHandle>;
  execute(
    tenant: Tenant,
    sessionKey: string,
    text: string,
    onEvent: (kind: string, data: any) => Promise<void>,
    context?: TurnContext,
  ): Promise<ExecuteResult>;
  stop(
    tenant: Tenant,
  ): Promise<{ stopped: boolean; snapshotId?: string; reason?: string; detail?: { reason: string; count?: number; commands?: string[] } }>;
  /** A component inside the sandbox asks to continue a conversation (Vercel only). */
  wakeSignatureValid?(tenant: Tenant, signature: string): boolean;
  /** Signed owner links to a public service of the sandbox (Vercel only). */
  openSignatureValid?(tenant: Tenant, service: string, signature: string): boolean;
  serviceUrl?(tenant: Tenant, service: string, publicUrls: Record<string, string>): string;
  runningPublicUrls?(tenant: Tenant): Promise<Record<string, string> | null>;
}

/** Reply text plus whatever the agent asked to deliver alongside it. */
export interface ExecuteResult {
  output: string;
  media: MediaFile[];
}

/** A file the agent asked to deliver, already read out of the sandbox. */
export interface MediaFile {
  ref: string;
  kind: "image" | "video" | "audio" | "file";
  buffer: Buffer;
}
/** Beyond this, channels reject the upload anyway; reading it would only waste time. */
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

/** What the agent needs to know about where this turn came from. */
export interface TurnContext {
  channel?: string;
  attachments?: InboundAttachment[];
  attachmentsFromPreviousTurn?: boolean;
}

/**
 * Our channel ids to the ones OpenClaw knows. Without this the runtime sees no
 * channel at all and treats every turn as webchat — which is why the agent
 * announced it was on webchat while answering someone in Feishu.
 */
const OPENCLAW_CHANNEL: Record<string, string> = {
  feishu: "feishu",
  weixin: "weixin",
  wecom: "wecom",
  dingtalk: "dingtalk",
  web: "webchat",
};
/** Scripts written to every sandbox; their hash is the runtime revision a VM must run. */
export const RUNTIME_SCRIPTS = [
  "boot.mjs", "invoke.mjs", "inbound-input.mjs", "quiesce.mjs", "model-proxy.mjs", "backup.mjs",
  "progress-patch.mjs", "stream-preview-patch.mjs", "scheduler-plugin.mjs", "agent-config.mjs",
  "v-release.mjs", "v-config.mjs", "v-features.mjs",
];
export function runtimeRevision() {
  return createHash("sha256")
    .update(Buffer.concat(RUNTIME_SCRIPTS.map((file) => fs.readFileSync(new URL(`../runtime/${file}`, import.meta.url)))))
    .digest("hex");
}

/** What quiesce.mjs said is still busy: its reason and process names only, never arguments. */
export function quiesceDetail(stdout: string): { reason: string; count?: number; commands?: string[] } | undefined {
  try {
    const out = JSON.parse(stdout.trim().split("\n").at(-1) || "");
    if (typeof out?.reason !== "string") return undefined;
    return {
      reason: out.reason.slice(0, 80),
      ...(Number.isInteger(out.count) ? { count: out.count } : {}),
      ...(Array.isArray(out.commands) ? { commands: out.commands.filter((c: unknown) => typeof c === "string").map((c: string) => c.slice(0, 40)).slice(0, 5) } : {}),
    };
  } catch {
    return undefined;
  }
}

export const openclawChannel = (channel?: string) =>
  channel ? (OPENCLAW_CHANNEL[channel] ?? channel) : undefined;

/**
 * What each surface can actually deliver, sent as x-openclaw-client-caps.
 *
 * Declared only where the edge really uploads attachments. Claiming a
 * capability the edge cannot honour is worse than claiming none: the agent
 * would emit MEDIA: believing the file was sent, and the user would receive
 * nothing. The other channels stay text-only until their upload path exists.
 */
const CHANNEL_CAPS: Record<string, string[]> = {
  feishu: ["media", "images", "files"],
};
export const channelCaps = (channel?: string) =>
  (channel && CHANNEL_CAPS[channel]?.join(",")) || undefined;

export interface RuntimeSandbox {
  name: string;
  status: string;
  update(options: { timeout: number; ports?: number[] }): Promise<unknown>;
  domain?(port: number): string;
  /** When the running session will be stopped by Vercel, and how to push that back. */
  expiresAt?: Date;
  extendTimeout?(duration: number): Promise<void>;
  readFileToBuffer(options: { path: string }): Promise<Buffer | null>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<unknown>;
  runCommand(options: { cmd: string; args?: string[]; env?: Record<string, string>; stdout?: Writable; signal?: AbortSignal }): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  stop(options?: { signal?: AbortSignal }): Promise<{ status: string; snapshot?: { id: string } }>;
}

/** 2 vCPUs unless the template asks for more (V's Worker pool wants 4). */
export function templateVcpus(template?: TemplateRecord): number {
  const vcpus = template?.resources?.vcpus;
  return Number.isInteger(vcpus) && vcpus! >= 1 && vcpus! <= 8 ? vcpus! : 2;
}

/** Named public ports of a template, validated; [] when it exposes none. */
export function templatePublicPorts(template?: TemplateRecord): [string, number][] {
  const entries = Object.entries(template?.publicPorts ?? {});
  if (entries.length > 15 || entries.some(([name, port]) => !/^[a-z][a-z0-9-]{0,31}$/.test(name) || !Number.isInteger(port) || port < 1024 || port > 65535))
    throw Error("TEMPLATE_PUBLIC_PORTS_INVALID");
  return entries;
}

/** Template-wide keys may never override NEXUS_* / OPENCLAW_* runtime variables. */
export function templateRuntimeEnv(template?: TemplateRecord): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(template?.runtimeEnv ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || key.startsWith("NEXUS_") || key.startsWith("OPENCLAW_")) throw Error("TEMPLATE_RUNTIME_ENV_INVALID");
    if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw Error("TEMPLATE_RUNTIME_ENV_INVALID");
    env[key] = value;
  }
  return env;
}

/**
 * A Vercel session stops at a fixed deadline counted from its start; update({timeout})
 * with the same value does not move it (2026-10-08: a takeover was cut at exactly
 * 20 minutes after the sandbox started). Keep at least minRemainingMs ahead.
 */
export async function keepSessionAlive(sbx: RuntimeSandbox, minRemainingMs = 900_000, now = Date.now()) {
  const expires = sbx.expiresAt instanceof Date ? sbx.expiresAt.getTime() : undefined;
  if (!expires || typeof sbx.extendTimeout !== "function") return false;
  const remaining = expires - now;
  if (remaining >= minRemainingMs) return false;
  await sbx.extendTimeout(minRemainingMs - remaining + 300_000).catch(() => undefined);
  return true;
}

export class VercelProvider implements RuntimeProvider {
  protected handles = new Map<string, RuntimeSandbox>();
  constructor(readonly config: Config) {}
  /** Per-tenant secret for a purpose (voice access, wake-link signature); derived, never stored. */
  tenantSecret(tenantId: string, purpose: string) {
    return createHmac("sha256", this.config.encryptionKey).update(`${purpose}:${tenantId}`).digest("hex");
  }
  /** Stable owner links through the Portal: they wake the sandbox, then redirect. */
  openLinks(tenant: Tenant): Record<string, string> {
    const ports = templatePublicPorts(this.config.templates?.[tenant.template_id]).map(([name]) => name);
    const base = (this.config.publicBaseUrl || "https://mirror-v-portal.vercel.app").replace(/\/$/, "");
    return Object.fromEntries(ports.filter((name) => name === "voice").map((name) => [name,
      `${base}/onboard/open/${encodeURIComponent(tenant.id)}/${this.tenantSecret(tenant.id, `open:${name}`).slice(0, 32)}/${name}`]));
  }
  wakeSignatureValid(tenant: Tenant, signature: string): boolean {
    const expected = Buffer.from(this.tenantSecret(tenant.id, "wake").slice(0, 32));
    const given = Buffer.from(String(signature));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  openSignatureValid(tenant: Tenant, service: string, signature: string): boolean {
    const expected = Buffer.from(this.tenantSecret(tenant.id, `open:${service}`).slice(0, 32));
    const given = Buffer.from(String(signature));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  /** Where a named service of a running sandbox is reachable now, with its access fragment. */
  serviceUrl(tenant: Tenant, service: string, publicUrls: Record<string, string>): string {
    const origin = publicUrls[service];
    if (!origin) throw Error("SERVICE_NOT_EXPOSED");
    if (service === "voice") return `${origin}/voice/#access=${this.tenantSecret(tenant.id, "voice-access")}`;
    return origin;
  }
  /** Public origins of a sandbox that is already running (no wake). */
  async runningPublicUrls(tenant: Tenant): Promise<Record<string, string> | null> {
    if (!tenant.sandbox_name) return null;
    const sbx = await this.get(tenant, false);
    if (sbx.status !== "running") return null;
    return Object.fromEntries(templatePublicPorts(this.config.templates?.[tenant.template_id]).flatMap(([name, port]) => {
      try { return sbx.domain ? [[name, sbx.domain(port)]] : []; } catch { return []; }
    }));
  }
  token(tenantId: string) {
    return createHmac("sha256", this.config.encryptionKey)
      .update(`gateway:${tenantId}`)
      .digest("hex");
  }
  name(tenantId: string) {
    return `${this.config.sandboxPrefix}-${tenantId}`;
  }
  async get(tenant: Tenant, resume = true): Promise<RuntimeSandbox> {
    return Sandbox.get({
      ...this.config.vercel,
      resume,
      name: tenant.sandbox_name || this.name(tenant.id),
    });
  }
  protected modelForTenant(tenant: Tenant) {
    const template = this.config.templates?.[tenant.template_id || "dealclaw"];
    if (template?.model) {
      const versions = template.modelVersions ?? [template.modelVersion || template.version];
      if (!Array.isArray(versions) || !versions.length || versions.some(version => typeof version !== "string" || (template.modelVersions !== undefined && !version.startsWith(`${tenant.template_id}.`))) || !versions.includes(tenant.template_version)) throw Error("TEMPLATE_MODEL_PROFILE_MISMATCH");
      if (!template.model.id || !template.model.baseUrl || !template.model.apiKey) throw Error("TEMPLATE_MODEL_NOT_CONFIGURED");
      return template.model;
    }
    if (template?.agentKit || tenant.template_id === "makaron") throw Error("TEMPLATE_MODEL_NOT_CONFIGURED");
    return this.config.model;
  }
  protected checkConfiguration(tenant: Tenant) {
    if (!tenant.template_snapshot_id && tenant.template_id !== "dealclaw") throw new Error("TEMPLATE_SNAPSHOT_NOT_READY");
    if (!tenant.template_snapshot_id && !this.config.snapshotId) throw new Error("SNAPSHOT_NOT_READY");
    this.modelForTenant(tenant);
    for (const key of this.config.templates?.[tenant.template_id]?.agentKit?.requiredEnvKeys || []) {
      // All customer service credentials come from the sealed tenant record;
      // never borrow a controller-process owner key for a public signup.
      if (!tenant.runtime_env?.[key]) throw Error(`RUNTIME_ENV_KEY_MISSING:${key}`);
    }
  }
  protected async create(tenant: Tenant, name: string): Promise<RuntimeSandbox> {
    const snapshotId = tenant.template_snapshot_id || (tenant.template_id === "dealclaw" ? this.config.snapshotId : undefined);
    if (!snapshotId) throw new Error("TEMPLATE_SNAPSHOT_NOT_READY");
    return Sandbox.getOrCreate({
      ...this.config.vercel, name,
      source: { type: "snapshot", snapshotId },
      persistent: true, snapshotExpiration: 0,
      keepLastSnapshots: { count: 2, expiration: 0 },
      resources: { vcpus: templateVcpus(this.config.templates?.[tenant.template_id]) }, timeout: 1_200_000,
      ...(templatePublicPorts(this.config.templates?.[tenant.template_id]).length ? { ports: templatePublicPorts(this.config.templates?.[tenant.template_id]).map(([, port]) => port) } : {}),
      tags: { purpose: "nexus-trial", tenant: tenant.id },
    });
  }
  async ensure(
    tenant: Tenant,
    onProvision?: (name: string) => Promise<void>,
  ): Promise<RuntimeHandle> {
    this.checkConfiguration(tenant);
    const start = Date.now();
    let name = tenant.sandbox_name || this.name(tenant.id);
    // Never silently recreate a previously provisioned tenant whose snapshot expired.
    // SDK getOrCreate can recreate an expired sandbox, which would lose user state.
    let sbx: RuntimeSandbox;
    if (this.config.optimizeRuntime !== false && this.handles.has(tenant.id))
      sbx = this.handles.get(tenant.id)!;
    else if (tenant.sandbox_name) sbx = await this.get(tenant);
    else sbx = await this.create(tenant, name);
    name = sbx.name;
    const sandboxAcquireMs = Date.now() - start;
    await onProvision?.(name);
    const reused = tenant.state === "ready";
    const publicPorts = templatePublicPorts(this.config.templates?.[tenant.template_id]);
    // The full port list each time: a template that added a port reaches existing tenants too.
    await sbx.update({ timeout: 1_200_000, ...(publicPorts.length ? { ports: publicPorts.map(([, port]) => port) } : {}) });
    await keepSessionAlive(sbx);
    const publicUrls = Object.fromEntries(publicPorts.flatMap(([name, port]) => {
      try { return sbx.domain ? [[name, sbx.domain(port)]] : []; } catch { return []; }
    }));
    const setupStart = Date.now();
    if (!this.handles.has(tenant.id)) await this.syncRuntimeScripts(sbx);
    const scriptDeployMs = Date.now() - setupStart;
    const bootCommandStart = Date.now();
    const model = this.modelForTenant(tenant);
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/boot.mjs"],
      env: {
        // Template-wide service keys, then operator-bound tenant secrets; neither can shadow runtime variables.
        ...templateRuntimeEnv(this.config.templates?.[tenant.template_id]),
        ...tenant.runtime_env,
        NEXUS_GATEWAY_TOKEN: this.token(tenant.id),
        NEXUS_MODEL_KEY: model.apiKey,
        NEXUS_MODEL_BASE_URL: model.baseUrl,
        NEXUS_MODEL_ID: model.id,
        NEXUS_AGENT_ID: tenant.template_id || "dealclaw",
        NEXUS_TEMPLATE_VERSION: tenant.template_version || "",
        NEXUS_EXPECT_AGENT_KIT: this.config.templates?.[tenant.template_id]?.agentKit ? "1" : "0",
        NEXUS_OPTIMIZE: this.config.optimizeRuntime === false ? "0" : "1",
        NEXUS_CPU_PROFILE: process.env.NEXUS_CPU_PROFILE || "0",
        NEXUS_PUBLIC_URLS: JSON.stringify(publicUrls),
        NEXUS_OPEN_LINKS: JSON.stringify(this.openLinks(tenant)),
        NEXUS_WAKE_URL: `${(this.config.publicBaseUrl || "https://mirror-v-portal.vercel.app").replace(/\/$/, "")}/onboard/wake/${encodeURIComponent(tenant.id)}/${this.tenantSecret(tenant.id, "wake").slice(0, 32)}`,
        ...(publicPorts.some(([name]) => name === "voice") ? { NEXUS_VOICE_ACCESS_TOKEN: this.tenantSecret(tenant.id, "voice-access") } : {}),
        NEXUS_PUBLIC_PORTS: JSON.stringify(Object.fromEntries(publicPorts)),
      },
      signal: AbortSignal.timeout(180000),
    });
    if (result.exitCode !== 0) {
      // Gateway log contains no model key (env references only); keep diagnostic output private.
      const diagnostic = `${await result.stdout()}\n${await result.stderr()}`;
      fs.writeFileSync(
        path.join(this.config.dataDir, "boot-error.log"),
        diagnostic,
        { mode: 0o600 },
      );
      throw new Error("OPENCLAW_BOOT_FAILED");
    }
    const bootCommandMs = Date.now() - bootCommandStart;
    let boot: any = {};
    try {
      boot = JSON.parse((await result.stdout()).trim().split("\n").at(-1)!);
    } catch {}
    this.handles.set(tenant.id, sbx);
    return {
      name,
      publicUrls,
      reused: !!boot.processReused,
      wakeMs: Date.now() - start,
      timings: {
        sandboxAcquireMs,
        scriptDeployMs,
        bootCommandMs,
        openclawBootMs: boot.openclawBootMs ?? -1,
        bootScriptMs: boot.bootScriptMs ?? -1,
        processReused: !!boot.processReused,
      },
    };
  }
  async execute(
    tenant: Tenant,
    sessionKey: string,
    text: string,
    onEvent: (kind: string, data: any) => Promise<void>,
    context?: TurnContext,
  ): Promise<ExecuteResult> {
    const executeStart = Date.now();
    const sbx =
      this.config.optimizeRuntime === false
        ? await this.get(tenant)
        : this.handles.get(tenant.id) || (await this.get(tenant));
    if (this.config.optimizeRuntime === false)
      await sbx.update({ timeout: 1_200_000 });
    let materialized: ReturnType<typeof readInboundImage>[] = [];
    try {
      const inbound = normalizeInboundAttachments(context?.attachments ?? [],tenant.id);
      materialized = inbound.map(item => readInboundImage(this.config.dataDir,tenant.id,item));
      if (materialized.length) {
        await sbx.writeFiles(materialized.map(({image,buffer}) => ({path:image.path,content:buffer})));
        await onEvent("inbound-materialized", { count: materialized.length, images: materialized.map(({image}) => image), fromPreviousTurn: !!context?.attachmentsFromPreviousTurn });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new InboundMediaError(/^(?:INVALID_INBOUND|INBOUND_ATTACHMENT)[A-Z_]*$/.test(message) ? message : "INBOUND_MEDIA_PREPARATION_FAILED");
    }
    await onEvent("dispatch", {
      at: Date.now(),
      executeSetupMs: Date.now() - executeStart,
    });
    let firstDeltaAt: number | undefined;
    const invokeStart = Date.now();
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let output = "";
    let completed = false;
    const finalMedia = new FinalMediaCollector();
    let chain = Promise.resolve();
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        buffer += decoder.write(chunk);
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        chain = chain.then(async () => {
          for (const frame of frames) {
            const raw = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!raw || raw === "[DONE]") continue;
            let event: any;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }
            if (finalMedia.accept(event)) await onEvent("media-announced", { count: event.mediaUrls.length, source: "openresponses-final" });
            if(event.type === "nexus.input_rejected") {
              const code = /^(?:INVALID_SANDBOX|SANDBOX_IMAGE)[A-Z_]*$/.test(event.code || "") ? event.code : "INBOUND_MEDIA_INPUT_REJECTED";
              throw new InboundMediaError(code);
            } else if(event.type === "nexus.schedule.request") {
              if(!/^[a-f0-9-]{36}$/.test(event.id))throw Error("INVALID_SCHEDULE_REQUEST_ID");
              await onEvent("schedule-request",event);
              await sbx.writeFiles([{path:`/tmp/nexus-schedule-rpc/${event.id}.response`,content:Buffer.from(JSON.stringify(event.result||{error:"SCHEDULER_UNAVAILABLE"}))}]);
            } else if (event.type === "response.output_text.delta") {
              if (event.delta && !firstDeltaAt) {
                firstDeltaAt = Date.now();
                await onEvent("first-delta", {
                  at: firstDeltaAt,
                  invokeToFirstDeltaMs: firstDeltaAt - invokeStart,
                });
              }
              output += event.delta || "";
              await onEvent("delta", { text: event.delta || "" });
            } else if (event.type === "nexus.tool") {
              await onEvent("tool-progress", { name: event.name, phase: event.phase, toolCallId: event.toolCallId });
            } else if (event.type === "nexus.public_snapshot") {
              await onEvent("public-progress", { text: event.text });
            } else if (event.type === "nexus.preview") {
              // Provisional text of the message being generated; output_text stays authoritative.
              if (typeof event.text === "string") await onEvent("preview", { seq: event.seq, text: event.text });
            } else if (event.type === "nexus.commentary") {
              // Narration before a tool call. When it already streamed into output_text,
              // `retract` is how many trailing UTF-16 units of the output it occupies.
              const retract = Number.isInteger(event.retract) && event.retract > 0 ? Math.min(event.retract, output.length) : 0;
              if (retract) output = output.slice(0, output.length - retract);
              if (typeof event.text === "string" && event.text.trim())
                await onEvent("commentary", { text: event.text.trim(), retract });
            } else if (event.type === "response.completed") {
              if (event.response?.status !== "completed") throw new Error("OPENCLAW_RESPONSE_FAILED");
              completed = true;
              await onEvent("runtime-completed", {
                responseId: event.response?.id,
              });
            } else if (
              event.type === "response.failed" ||
              event.type === "error"
            )
              throw new Error("OPENCLAW_RESPONSE_FAILED");
          }
        });
        chain.then(
          () => callback(),
          (error) => callback(error),
        );
      },
    });
    sink.on("error", () => {}); // observed by finishOutput, not an unhandled emitter error
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/invoke.mjs"],
      env: {
        NEXUS_GATEWAY_TOKEN: this.token(tenant.id),
        NEXUS_AGENT_ID: tenant.template_id || "dealclaw",
        NEXUS_REQUEST_B64: Buffer.from(
          JSON.stringify({
            sessionKey,
            text,
            ...(materialized.length ? { images: materialized.map(({image}) => image), imagesFromPreviousTurn: !!context?.attachmentsFromPreviousTurn } : {}),
            channel: openclawChannel(context?.channel),
            caps: channelCaps(context?.channel),
          }),
        ).toString("base64"),
      },
      stdout: sink,
      signal: AbortSignal.timeout(650000),
    });
    await finishOutput(sink);
    await chain;
    await onEvent("generation-finished", {
      at: Date.now(),
      invokeMs: Date.now() - invokeStart,
    });
    if (result.exitCode || !completed || (!output.trim() && !finalMedia.media.length))
      throw new Error("OPENCLAW_INCOMPLETE_RESPONSE");
    // Persist session/files after EACH successful turn, before acknowledging success.
    // Snapshot on idle is additional protection, not the only durable boundary.
    const backupStart = Date.now();
    const backup =
      this.config.optimizeRuntime === false
        ? await sbx.runCommand({
            cmd: "tar",
            args: [
              "-czf",
              "/tmp/nexus-state.tgz",
              "-C",
              "/vercel/sandbox",
              "agent-data",
            ],
          })
        : await sbx.runCommand({
            cmd: "node",
            args: ["/vercel/sandbox/nexus/backup.mjs"],
            env: { NEXUS_AGENT_ID: tenant.template_id || "dealclaw" },
          });
    if (backup.exitCode) throw new Error("STATE_BACKUP_FAILED");
    const bytes = await sbx.readFileToBuffer({ path: "/tmp/nexus-state.tgz" });
    if (!bytes) throw new Error("STATE_BACKUP_EMPTY");
    const directory = path.join(this.config.dataDir, "backups");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${tenant.id}.tgz`);
    fs.writeFileSync(destination + ".tmp", bytes, { mode: 0o600 });
    fs.renameSync(destination + ".tmp", destination);
    await onEvent("state-saved", {
      at: Date.now(),
      backupMs: Date.now() - backupStart,
    });
    const timingBytes = await sbx.readFileToBuffer({
      path: "/tmp/nexus-model-timings.jsonl",
    });
    if (timingBytes)
      for (const line of timingBytes.toString().trim().split("\n")) {
        try {
          const timing = JSON.parse(line);
          if (timing.start >= invokeStart - 2000)
            await onEvent("model-timing", timing);
        } catch {}
      }
    // The sandbox is about to go idle and its filesystem with it, so anything
    // the agent asked to deliver has to be read out now, while it still exists.
    const media = await this.collectMedia(sbx, output, onEvent, finalMedia.media);
    const localRefs = [...parseReply(output).media, ...finalMedia.media].filter(item => !item.remote);
    if (localRefs.length && !media.length) throw new Error("OUTBOUND_MEDIA_UNAVAILABLE");
    if (media.length) await onEvent("media-ready", { count: media.length, refs: media.map((m) => m.ref) });
    if (media.length && output.trim() === "No response from OpenClaw.") output = "";
    return { output, media };
  }

  private async collectMedia(
    sbx: RuntimeSandbox,
    output: string,
    onEvent: (kind: string, data: any) => Promise<void>,
    announced: MediaDirective[] = [],
  ): Promise<MediaFile[]> {
    const media = [...new Map([...parseReply(output).media, ...announced].map(item => [item.ref,item])).values()];
    const files: MediaFile[] = [];
    for (const directive of media) {
      // A URL needs no upload: the channel can reference it directly.
      if (directive.remote) continue;
      const path = resolveRef(directive.ref);
      try {
        const buffer = await sbx.readFileToBuffer({ path });
        if (!buffer) {
          await onEvent("media-missing", { ref: directive.ref, path });
          continue;
        }
        if (buffer.length > MAX_MEDIA_BYTES) {
          await onEvent("media-too-large", { ref: directive.ref, bytes: buffer.length });
          continue;
        }
        files.push({ ref: directive.ref, kind: mediaKind(directive.ref), buffer });
      } catch (error: any) {
        await onEvent("media-read-failed", {
          ref: directive.ref,
          message: String(error?.message ?? error).slice(0, 200),
        });
      }
    }
    return files;
  }
  /** Make the sandbox's runtime scripts match this release (written only when they differ). */
  private async syncRuntimeScripts(sbx: RuntimeSandbox) {
    const files = RUNTIME_SCRIPTS.map((file) => ({
      path: `/vercel/sandbox/nexus/${file}`,
      content: fs.readFileSync(new URL(`../runtime/${file}`, import.meta.url)),
    }));
    const revision = runtimeRevision();
    const revisionPath = "/vercel/sandbox/nexus/runtime-revision.txt";
    const installed = await sbx
      .readFileToBuffer({ path: revisionPath })
      .catch(() => null);
    if (installed?.toString() !== revision)
      await sbx.writeFiles([
        ...files,
        { path: revisionPath, content: Buffer.from(revision) },
      ]);
  }
  async stop(tenant: Tenant) {
    if (!tenant.sandbox_name) return { stopped: true };
    const sbx = await this.get(tenant, false);
    if (sbx.status === "stopped") return { stopped: true };
    // An idle VM gets no turns, so without this it would keep judging sleep with
    // the quiesce.mjs of whatever release last served it (a fixed bug kept one awake 19 h).
    await this.syncRuntimeScripts(sbx);
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/quiesce.mjs"],
      signal: AbortSignal.timeout(30000),
    });
    if (result.exitCode !== 0) {
      // Someone is on the takeover page or in a call: do not let the session deadline end it.
      await keepSessionAlive(sbx);
      return { stopped: false, reason: "ACTIVE_BACKGROUND_WORK", detail: quiesceDetail(await result.stdout().catch(() => "")) };
    }
    this.handles.delete(tenant.id);
    const stopped = await sbx.stop({ signal: AbortSignal.timeout(120000) });
    if (stopped.status !== "stopped")
      throw new Error("SANDBOX_STOP_NOT_CONFIRMED");
    return { stopped: true, snapshotId: stopped.snapshot?.id };
  }
}
