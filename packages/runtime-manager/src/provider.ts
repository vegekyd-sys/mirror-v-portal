import fs from "node:fs";
import path from "node:path";
import { createHmac, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import { parseReply, resolveRef, mediaKind } from "./media-directive.js";
import type { Config } from "./config.js";
import type { Tenant } from "./store.js";

export async function finishOutput(sink: Writable) {
  sink.end();
  await finished(sink);
}

export interface RuntimeHandle {
  name: string;
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
  ): Promise<{ stopped: boolean; snapshotId?: string; reason?: string }>;
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
  update(options: { timeout: number }): Promise<unknown>;
  readFileToBuffer(options: { path: string }): Promise<Buffer | null>;
  writeFiles(files: { path: string; content: Buffer }[]): Promise<unknown>;
  runCommand(options: { cmd: string; args?: string[]; env?: Record<string, string>; stdout?: Writable; signal?: AbortSignal }): Promise<{ exitCode: number; stdout(): Promise<string>; stderr(): Promise<string> }>;
  stop(options?: { signal?: AbortSignal }): Promise<{ status: string; snapshot?: { id: string } }>;
}

export class VercelProvider implements RuntimeProvider {
  protected handles = new Map<string, RuntimeSandbox>();
  constructor(readonly config: Config) {}
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
  protected checkConfiguration() {
    if (!this.config.snapshotId) throw new Error("SNAPSHOT_NOT_READY");
  }
  protected async create(tenant: Tenant, name: string): Promise<RuntimeSandbox> {
    return Sandbox.getOrCreate({
      ...this.config.vercel, name,
      source: { type: "snapshot", snapshotId: this.config.snapshotId! },
      persistent: true, snapshotExpiration: 0,
      keepLastSnapshots: { count: 2, expiration: 0 },
      resources: { vcpus: 2 }, timeout: 1_200_000,
      tags: { purpose: "nexus-trial", tenant: tenant.id },
    });
  }
  async ensure(
    tenant: Tenant,
    onProvision?: (name: string) => Promise<void>,
  ): Promise<RuntimeHandle> {
    this.checkConfiguration();
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
    await sbx.update({ timeout: 1_200_000 });
    const setupStart = Date.now();
    if (!this.handles.has(tenant.id)) {
      const files = [
        "boot.mjs",
        "invoke.mjs",
        "quiesce.mjs",
        "model-proxy.mjs",
        "backup.mjs",
        "progress-patch.mjs",
        "scheduler-plugin.mjs",
      ].map((file) => ({
        path: `/vercel/sandbox/nexus/${file}`,
        content: fs.readFileSync(
          new URL(`../runtime/${file}`, import.meta.url),
        ),
      }));
      const revision = createHash("sha256")
        .update(Buffer.concat(files.map((f) => f.content)))
        .digest("hex");
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
    const scriptDeployMs = Date.now() - setupStart;
    const bootCommandStart = Date.now();
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/boot.mjs"],
      env: {
        NEXUS_GATEWAY_TOKEN: this.token(tenant.id),
        NEXUS_MODEL_KEY: this.config.model.apiKey,
        NEXUS_MODEL_BASE_URL: this.config.model.baseUrl,
        NEXUS_MODEL_ID: this.config.model.id,
        NEXUS_OPTIMIZE: this.config.optimizeRuntime === false ? "0" : "1",
        NEXUS_CPU_PROFILE: process.env.NEXUS_CPU_PROFILE || "0",
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
            if(event.type === "nexus.schedule.request") {
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
            } else if (event.type === "response.completed") {
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
        NEXUS_REQUEST_B64: Buffer.from(
          JSON.stringify({
            sessionKey,
            text,
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
    if (result.exitCode || !completed || !output.trim())
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
    const media = await this.collectMedia(sbx, output, onEvent);
    if (media.length) await onEvent("media-ready", { count: media.length, refs: media.map((m) => m.ref) });
    return { output, media };
  }

  private async collectMedia(
    sbx: RuntimeSandbox,
    output: string,
    onEvent: (kind: string, data: any) => Promise<void>,
  ): Promise<MediaFile[]> {
    const { media } = parseReply(output);
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
  async stop(tenant: Tenant) {
    if (!tenant.sandbox_name) return { stopped: true };
    const sbx = await this.get(tenant, false);
    if (sbx.status === "stopped") return { stopped: true };
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/quiesce.mjs"],
      signal: AbortSignal.timeout(30000),
    });
    if (result.exitCode !== 0)
      return { stopped: false, reason: "ACTIVE_BACKGROUND_WORK" };
    this.handles.delete(tenant.id);
    const stopped = await sbx.stop({ signal: AbortSignal.timeout(120000) });
    if (stopped.status !== "stopped")
      throw new Error("SANDBOX_STOP_NOT_CONFIRMED");
    return { stopped: true, snapshotId: stopped.snapshot?.id };
  }
}
