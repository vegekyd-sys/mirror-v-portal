import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Sandbox, CommandExitError, NotFoundError } from "e2b";
import type { Config } from "./config.js";
import type { Tenant } from "./store.js";
import { VercelProvider, type RuntimeSandbox } from "./provider.js";

// Use explicit per-client endpoints: never mutate global E2B environment variables.
export function alibabaOptions(config: Config) {
  const c = config.alibaba;
  if (!c?.apiKey) throw Error("ALIBABA_SANDBOX_KEY_REQUIRED");
  if (!/^[a-z]+-[a-z]+-\d+$/.test(c.region)) throw Error("ALIBABA_REGION_INVALID");
  const domain = `${c.region}.e2b.fc.aliyuncs.com`;
  return { apiKey: c.apiKey, domain, apiUrl: `https://api.${domain}`, requestTimeoutMs: 60_000 };
}

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Wake-time bootstrap of the built-in base template. A custom FC image needs a
// subscription-billed ACR EE instance in the same account and region; measured in
// ap-southeast-1, bootstrapping base instead costs ~45s once per Agent and the
// result survives pause/resume, so the image is an optimization, not a dependency.
const BOOTSTRAP_ROOT = "/vercel/sandbox/nexus";
const BOOTSTRAP_NODE_DIR = `${BOOTSTRAP_ROOT}/node`;
const BOOTSTRAP_RUNTIME = `${BOOTSTRAP_ROOT}/runtime`;
const BOOTSTRAP_REVISION_PATH = `${BOOTSTRAP_ROOT}/bootstrap-revision.txt`;
// base ships node v20, below openclaw@2026.7.1 engines
// (>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0), and ensure() runs plain `node`.
export const BOOTSTRAP_NODE_VERSION = "v24.21.0";
export const BOOTSTRAP_OPENCLAW_VERSION = "2026.7.1";
// A single 32MB write is rejected with InvalidArgumentError; 16MB is verified good.
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

export class AlibabaSandbox implements RuntimeSandbox {
  status = "running";
  constructor(readonly sandbox: Sandbox) {}
  get name() { return this.sandbox.sandboxId; }
  async update({ timeout }: { timeout: number }) { await this.sandbox.setTimeout(timeout); }
  async readFileToBuffer({ path }: { path: string }) {
    try { return Buffer.from(await this.sandbox.files.read(path, { format: "bytes" })); }
    catch (e) { if (e instanceof NotFoundError) return null; throw Error("ALIBABA_FILE_READ_FAILED"); }
  }
  async writeFiles(files: { path: string; content: Buffer }[]) {
    for (const file of files) await this.sandbox.files.write(file.path, new Uint8Array(file.content).buffer);
  }
  async runCommand(options: Parameters<RuntimeSandbox["runCommand"]>[0]) {
    options.signal?.throwIfAborted();
    const handle = await this.sandbox.commands.run(
      [options.cmd, ...(options.args || [])].map(shellQuote).join(" "),
      {
        background: true, envs: options.env, timeoutMs: 650_000,
        onStdout: options.stdout ? (chunk) => new Promise<void>((resolve, reject) => {
          options.stdout!.write(chunk, (error) => error ? reject(error) : resolve());
        }) : undefined,
      },
    );
    const abort = () => { void handle.kill().catch(() => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      let result;
      try { result = await handle.wait(); }
      catch (e) { if (e instanceof CommandExitError) result = e; else throw Error("ALIBABA_COMMAND_FAILED"); }
      options.signal?.throwIfAborted();
      return { exitCode: result.exitCode, stdout: async () => result.stdout, stderr: async () => result.stderr };
    } finally { options.signal?.removeEventListener("abort", abort); }
  }
  async stop() {
    if (!(await this.sandbox.pause({ keepMemory: false }))) throw Error("ALIBABA_PAUSE_NOT_CONFIRMED");
    const info = await this.sandbox.getInfo();
    if (info.state !== "paused") throw Error("ALIBABA_PAUSE_NOT_CONFIRMED");
    this.status = "stopped";
    return { status: "stopped" };
  }
}

// Reuse the exact boot/invoke/stream/schedule RPC/backup contract already tested
// on Vercel. Only the infrastructure operations differ. The legacy filesystem
// path /vercel/sandbox is an image layout, not a request to Vercel.
export class AlibabaProvider extends VercelProvider {
  protected payloadArchivePath() {
    return path.join(this.config.dataDir, "alibaba-build", "payload.tar");
  }
  protected override checkConfiguration() {
    alibabaOptions(this.config);
    // Without a custom template the base template is bootstrapped at wake time,
    // which needs the payload archive that build-alibaba-template.ts produces.
    if (!this.config.alibaba!.templateId && !fs.existsSync(this.payloadArchivePath()))
      throw Error("ALIBABA_PAYLOAD_ARCHIVE_MISSING");
  }
  private async sh(box: AlibabaSandbox, step: string, script: string) {
    const result = await box.runCommand({ cmd: "sh", args: ["-c", script] });
    if (result.exitCode !== 0)
      throw Error(`ALIBABA_BOOTSTRAP_${step}_FAILED:${(await result.stderr()).slice(-600)}`);
    return result;
  }
  // Idempotent: the revision marker covers node, openclaw and the payload bytes,
  // so an unchanged Agent skips this entirely on resume.
  protected async bootstrap(box: AlibabaSandbox) {
    const archive = fs.readFileSync(this.payloadArchivePath());
    const revision = createHash("sha256")
      .update(`${BOOTSTRAP_NODE_VERSION}|${BOOTSTRAP_OPENCLAW_VERSION}|`)
      .update(archive).digest("hex");
    const installed = await box.readFileToBuffer({ path: BOOTSTRAP_REVISION_PATH });
    if (installed?.toString() === revision) return { bootstrapped: false };

    await this.sh(box, "LAYOUT",
      `sudo -n mkdir -p ${BOOTSTRAP_RUNTIME} ${BOOTSTRAP_NODE_DIR} ${BOOTSTRAP_ROOT}/payload /vercel/sandbox/agent-data` +
      ` && sudo -n chown -R user:user /vercel`);
    await this.sh(box, "NODE",
      `curl -fsSL https://nodejs.org/dist/${BOOTSTRAP_NODE_VERSION}/node-${BOOTSTRAP_NODE_VERSION}-linux-x64.tar.xz` +
      ` | tar -xJ -C ${BOOTSTRAP_NODE_DIR} --strip-components=1` +
      ` && sudo -n ln -sf ${BOOTSTRAP_NODE_DIR}/bin/node /usr/local/bin/node`);
    await this.sh(box, "OPENCLAW",
      `npm install --prefix ${BOOTSTRAP_RUNTIME} --omit=dev --no-audit --no-fund openclaw@${BOOTSTRAP_OPENCLAW_VERSION}`);

    const parts = Math.ceil(archive.length / UPLOAD_CHUNK_BYTES);
    for (let i = 0; i < parts; i++) {
      const slice = archive.subarray(i * UPLOAD_CHUNK_BYTES, Math.min((i + 1) * UPLOAD_CHUNK_BYTES, archive.length));
      await box.sandbox.files.write(`/tmp/nexus-payload.part${i}`, new Uint8Array(slice).buffer);
    }
    await this.sh(box, "PAYLOAD",
      `cat /tmp/nexus-payload.part* > /tmp/nexus-payload.tar && rm -f /tmp/nexus-payload.part*` +
      ` && tar -xf /tmp/nexus-payload.tar --strip-components=3 -C ${BOOTSTRAP_ROOT}/payload` +
      ` && rm -f /tmp/nexus-payload.tar`);

    // Written last: a partial bootstrap must not look complete on the next wake.
    await box.writeFiles([{ path: BOOTSTRAP_REVISION_PATH, content: Buffer.from(revision) }]);
    return { bootstrapped: true };
  }
  protected override async create(tenant: Tenant, _name: string): Promise<RuntimeSandbox> {
    this.checkConfiguration();
    const sandbox = await Sandbox.create(this.config.alibaba!.templateId || "base", {
      ...alibabaOptions(this.config), timeoutMs: 1_200_000,
      lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
      metadata: { purpose: "nexus-trial", tenant: tenant.id },
    });
    const box = new AlibabaSandbox(sandbox);
    // A custom template already embeds the runtime; the base template does not.
    if (!this.config.alibaba!.templateId) await this.bootstrap(box);
    return box;
  }
  override async get(tenant: Tenant): Promise<RuntimeSandbox> {
    if (!tenant.sandbox_name) throw Error("ALIBABA_SANDBOX_ID_REQUIRED");
    // No create fallback on 404: replacing an expired sandbox must be an explicit
    // recovery from a verified per-tenant backup, never a silent memory reset.
    try {
      return new AlibabaSandbox(await Sandbox.connect(tenant.sandbox_name, {
        ...alibabaOptions(this.config), timeoutMs: 1_200_000,
      }));
    } catch { throw Error("ALIBABA_RESUME_FAILED_REVIEW_REQUIRED"); }
  }
  override async stop(tenant: Tenant) {
    if (!tenant.sandbox_name) return { stopped: true };
    const info = await Sandbox.getInfo(tenant.sandbox_name, alibabaOptions(this.config));
    if (info.state === "paused") {
      this.handles.delete(tenant.id);
      return { stopped: true };
    }
    // Check state first: connecting to inspect an idle instance must not wake it.
    return super.stop(tenant);
  }
}
