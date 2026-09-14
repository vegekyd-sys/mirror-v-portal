import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";
import type { Config } from "./config.js";
import type { Tenant } from "./store.js";

export interface RuntimeHandle {
  name: string;
  reused: boolean;
  wakeMs: number;
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
  ): Promise<string>;
  stop(
    tenant: Tenant,
  ): Promise<{ stopped: boolean; snapshotId?: string; reason?: string }>;
}

export class VercelProvider implements RuntimeProvider {
  constructor(readonly config: Config) {}
  token(tenantId: string) {
    return createHmac("sha256", this.config.encryptionKey)
      .update(`gateway:${tenantId}`)
      .digest("hex");
  }
  name(tenantId: string) {
    return `${this.config.sandboxPrefix}-${tenantId}`;
  }
  async get(tenant: Tenant, resume = true) {
    return Sandbox.get({
      ...this.config.vercel,
      resume,
      name: tenant.sandbox_name || this.name(tenant.id),
    });
  }
  async ensure(
    tenant: Tenant,
    onProvision?: (name: string) => Promise<void>,
  ): Promise<RuntimeHandle> {
    if (!this.config.snapshotId) throw new Error("SNAPSHOT_NOT_READY");
    const start = Date.now();
    const name = tenant.sandbox_name || this.name(tenant.id);
    // Never silently recreate a previously provisioned tenant whose snapshot expired.
    // SDK getOrCreate can recreate an expired sandbox, which would lose user state.
    let sbx: Sandbox;
    if (tenant.sandbox_name) sbx = await this.get(tenant);
    else
      sbx = await Sandbox.getOrCreate({
        ...this.config.vercel,
        name,
        source: { type: "snapshot", snapshotId: this.config.snapshotId },
        persistent: true,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 2, expiration: 0 },
        resources: { vcpus: 2 },
        timeout: 1_200_000,
        tags: { purpose: "nexus-trial", tenant: tenant.id },
      });
    await onProvision?.(name);
    const reused = tenant.state === "ready";
    await sbx.update({ timeout: 1_200_000 });
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/boot.mjs"],
      env: {
        NEXUS_GATEWAY_TOKEN: this.token(tenant.id),
        NEXUS_MODEL_KEY: this.config.model.apiKey,
        NEXUS_MODEL_BASE_URL: this.config.model.baseUrl,
        NEXUS_MODEL_ID: this.config.model.id,
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
    return { name, reused, wakeMs: Date.now() - start };
  }
  async execute(
    tenant: Tenant,
    sessionKey: string,
    text: string,
    onEvent: (kind: string, data: any) => Promise<void>,
  ): Promise<string> {
    const sbx = await this.get(tenant);
    await sbx.update({ timeout: 1_200_000 });
    let buffer = "";
    let output = "";
    let completed = false;
    let chain = Promise.resolve();
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
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
            if (event.type === "response.output_text.delta") {
              output += event.delta || "";
              await onEvent("delta", { text: event.delta || "" });
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
    const result = await sbx.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/nexus/invoke.mjs"],
      env: {
        NEXUS_GATEWAY_TOKEN: this.token(tenant.id),
        NEXUS_REQUEST_B64: Buffer.from(
          JSON.stringify({ sessionKey, text }),
        ).toString("base64"),
      },
      stdout: sink,
      signal: AbortSignal.timeout(650000),
    });
    await chain;
    if (result.exitCode || !completed || !output.trim())
      throw new Error("OPENCLAW_INCOMPLETE_RESPONSE");
    // Persist session/files after EACH successful turn, before acknowledging success.
    // Snapshot on idle is additional protection, not the only durable boundary.
    const backup = await sbx.runCommand({
      cmd: "tar",
      args: [
        "-czf",
        "/tmp/nexus-state.tgz",
        "-C",
        "/vercel/sandbox",
        "agent-data",
      ],
    });
    if (backup.exitCode) throw new Error("STATE_BACKUP_FAILED");
    const bytes = await sbx.readFileToBuffer({ path: "/tmp/nexus-state.tgz" });
    if (!bytes) throw new Error("STATE_BACKUP_EMPTY");
    const directory = path.join(this.config.dataDir, "backups");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, `${tenant.id}.tgz`);
    fs.writeFileSync(destination + ".tmp", bytes, { mode: 0o600 });
    fs.renameSync(destination + ".tmp", destination);
    return output;
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
    const stopped = await sbx.stop({ signal: AbortSignal.timeout(120000) });
    if (stopped.status !== "stopped")
      throw new Error("SANDBOX_STOP_NOT_CONFIRMED");
    return { stopped: true, snapshotId: stopped.snapshot?.id };
  }
}
