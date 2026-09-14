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
  protected override checkConfiguration() {
    alibabaOptions(this.config);
    if (!this.config.alibaba?.templateId) throw Error("ALIBABA_TEMPLATE_NOT_READY");
  }
  protected override async create(tenant: Tenant, _name: string): Promise<RuntimeSandbox> {
    this.checkConfiguration();
    const sandbox = await Sandbox.create(this.config.alibaba!.templateId, {
      ...alibabaOptions(this.config), timeoutMs: 1_200_000,
      lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
      metadata: { purpose: "nexus-trial", tenant: tenant.id },
    });
    return new AlibabaSandbox(sandbox);
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
