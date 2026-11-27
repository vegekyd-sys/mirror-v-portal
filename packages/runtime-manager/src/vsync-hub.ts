// VSync broker: Mirror V instances reach the private v-sync-hub repository only
// through here. The Portal holds the one hub credential (a deploy key on the
// server); each Mirror V — a Portal sandbox tenant or a customer's own
// deployment — gets an agent id and a token derived from the server key. With
// that token it can read what is addressed to it and write its own ACKs and
// packages, nothing else: no other agent's packages, no repository admin.
//
// Hub layout (v-sync-hub README / V's vsync skill):
//   agents/<sender>/returns/<target>/<package>/...   packages
//   agents/<sender>/return-manifest.jsonl            package manifests (one row each)
//   agents/<target>/inbox.jsonl                      A2A messages to the target
//   agents/<target>/ack.jsonl                        the target's acknowledgements
import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface VsyncConfig {
  enabled?: boolean;
  /** git URL of the hub, e.g. git@github.com:<owner>/v-sync-hub.git */
  repo: string;
  branch?: string;
  /** Server directory holding the partial clone. */
  dir: string;
  /** Deploy key with write access to the hub (server only, mode 600). */
  sshKeyPath?: string;
  /** Agents a Mirror V may send packages / messages to. */
  counterparts?: string[];
  /** Templates whose tenants get a hub identity. */
  templates?: string[];
  /** Fixed agent ids for tenants that already have one in the hub (e.g. "mirror-v-004"). */
  tenantAgents?: Record<string, string>;
  /** Agent ids of customer deployments outside the Portal (tokens issued by scripts/vsync-token.ts). */
  deployments?: string[];
  revoked?: string[];
}

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,180}$/;
export const SEND_LIMIT_BYTES = 700 * 1024; // Nginx / Gateway accept 1 MB bodies; base64 costs a third.
const FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const ROW_LIMIT_BYTES = 16 * 1024;

export class VsyncError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

/** Token for an agent id; derived from the server key, never stored. */
export function vsyncToken(encryptionKey: string, agentId: string) {
  return createHmac("sha256", encryptionKey).update(`vsync:${agentId}`).digest("hex");
}

/** The hub agent id of a Portal tenant. */
export function tenantAgentId(cfg: VsyncConfig, tenantId: string) {
  const fixed = cfg.tenantAgents?.[tenantId];
  if (fixed) return fixed;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(tenantId);
  const slug = (uuid ? tenantId.slice(0, 8) : tenantId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")).replace(/^-+|-+$/g, "").slice(0, 50);
  return `mirror-${slug}`;
}

export function tokenMatches(encryptionKey: string, agentId: string, token: string) {
  const want = Buffer.from(vsyncToken(encryptionKey, agentId));
  const got = Buffer.from(String(token));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A repository path, normalised; anything that could escape agents/ is refused. */
export function cleanPath(p: unknown) {
  if (typeof p !== "string" || !p || p.length > 400) throw new VsyncError("PATH_INVALID");
  const parts = p.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || s.startsWith(".git") || /[\0\\]/.test(s))) throw new VsyncError("PATH_INVALID");
  return parts.join("/");
}

/** What an agent may read: its own directory, and packages other agents addressed to it. */
export function canRead(agent: string, p: string) {
  const s = p.split("/");
  if (s[0] !== "agents" || s.length < 3) return false;
  if (s[1] === agent) return true;
  return s.length >= 5 && s[2] === "returns" && s[3] === agent;
}

const parseRows = (text: string) =>
  text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === "object" ? [v] : []; } catch { return []; } });

const rowLine = (row: Record<string, unknown>) => {
  const line = JSON.stringify(row);
  if (Buffer.byteLength(line) > ROW_LIMIT_BYTES) throw new VsyncError("ROW_TOO_LARGE");
  return line;
};

const stamp = () => {
  // Hub rows carry Shanghai time, as V writes them.
  const d = new Date(Date.now() + 8 * 3600_000).toISOString().replace("Z", "");
  return { iso: `${d.slice(0, 19)}+08:00`, compact: d.slice(0, 19).replace(/[-:]/g, "") };
};

type Change = { path: string; content?: Buffer; append?: string[] };

/** A depth-1, blob-less clone of the hub: trees come with each fetch, blobs on demand. */
export class HubRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private fetchedAt = 0;
  constructor(readonly cfg: VsyncConfig, private readonly author = { name: "Mirror V VSync broker", email: "vsync-broker@mirror-v.invalid" }) {}

  private get branch() { return this.cfg.branch || "main"; }
  private env(extra: Record<string, string> = {}) {
    const ssh = this.cfg.sshKeyPath
      ? `ssh -i ${this.cfg.sshKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(this.cfg.dir, "..", "known_hosts")}`
      : "ssh -o BatchMode=yes";
    return { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: "0", ...extra };
  }
  private async git(args: string[], opts: { input?: Buffer | string; env?: Record<string, string>; encoding?: "buffer" } = {}) {
    const child = run("git", ["-C", this.cfg.dir, ...args], { env: this.env(opts.env), maxBuffer: FILE_LIMIT_BYTES * 2, encoding: (opts.encoding ?? "utf8") as any, timeout: 120_000 });
    if (opts.input !== undefined) { child.child.stdin!.end(opts.input); }
    const { stdout } = await child;
    return stdout as unknown as string;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async ensure() {
    if (fs.existsSync(path.join(this.cfg.dir, ".git")) || fs.existsSync(path.join(this.cfg.dir, "HEAD"))) return;
    fs.mkdirSync(path.dirname(this.cfg.dir), { recursive: true });
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", "--branch", this.branch, this.cfg.repo, this.cfg.dir], { env: this.env(), timeout: 300_000 });
  }
  private async fetch(force = false) {
    if (!force && Date.now() - this.fetchedAt < 15_000) return;
    await this.ensure();
    await this.git(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`]);
    this.fetchedAt = Date.now();
  }
  private get ref() { return `refs/remotes/origin/${this.branch}`; }

  list(prefix: string) {
    return this.serial(async () => {
      await this.fetch();
      const out = await this.git(["ls-tree", "-r", "-l", "--full-tree", this.ref, "--", prefix]);
      return out.split("\n").filter(Boolean).map((l) => {
        const [meta, p] = l.split("\t");
        const [, type, sha, size] = meta.split(/\s+/);
        return { path: p, type, sha, size: Number(size) };
      }).filter((e) => e.type === "blob");
    });
  }
  dirs(prefix: string) {
    return this.serial(async () => {
      await this.fetch();
      const out = await this.git(["ls-tree", "--full-tree", this.ref, "--", prefix.endsWith("/") ? prefix : `${prefix}/`]);
      return out.split("\n").filter(Boolean).filter((l) => l.split(/\s+/)[1] === "tree").map((l) => l.split("\t")[1]);
    });
  }
  read(p: string, fresh = false): Promise<Buffer | null> {
    return this.serial(async () => {
      await this.fetch(fresh);
      return this.blob(p);
    });
  }
  private async blob(p: string): Promise<Buffer | null> {
    const exists = await this.git(["ls-tree", "--full-tree", this.ref, "--", p]);
    if (!exists.trim()) return null;
    return Buffer.from(await this.git(["cat-file", "blob", `${this.ref}:${p}`], { encoding: "buffer" }) as unknown as Buffer);
  }

  /** Commit changes on top of the hub's branch tip and push; retried when someone else pushed first. */
  commit(changes: Change[], message: string, check?: (exists: (p: string) => Promise<boolean>) => Promise<void>) {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        await this.fetch(true);
        if (check) await check(async (p) => (await this.git(["ls-tree", "--full-tree", this.ref, "--", p])).trim() !== "");
        const index = path.join(os.tmpdir(), `vsync-index-${process.pid}-${Date.now()}`);
        const env = { GIT_INDEX_FILE: index };
        try {
          await this.git(["read-tree", this.ref], { env });
          for (const c of changes) {
            let body = c.content;
            if (c.append) {
              const old = (await this.blob(c.path))?.toString("utf8") ?? "";
              body = Buffer.from(`${old}${old && !old.endsWith("\n") ? "\n" : ""}${c.append.map((l) => `${l}\n`).join("")}`);
            }
            const sha = (await this.git(["hash-object", "-w", "--stdin"], { input: body! })).trim();
            await this.git(["update-index", "--add", "--cacheinfo", `100644,${sha},${c.path}`], { env });
          }
          const tree = (await this.git(["write-tree", "--missing-ok"], { env })).trim();
          const parent = (await this.git(["rev-parse", this.ref])).trim();
          const who = { GIT_AUTHOR_NAME: this.author.name, GIT_AUTHOR_EMAIL: this.author.email, GIT_COMMITTER_NAME: this.author.name, GIT_COMMITTER_EMAIL: this.author.email };
          const commit = (await this.git(["commit-tree", tree, "-p", parent, "-m", message], { env: who })).trim();
          try {
            await this.git(["push", "--quiet", "origin", `${commit}:refs/heads/${this.branch}`]);
            return commit;
          } catch (e) {
            if (attempt >= 4) throw new VsyncError("HUB_PUSH_FAILED", 503);
          }
        } finally {
          fs.rmSync(index, { force: true });
        }
      }
    });
  }
}

/** Hub identity handed to a tenant sandbox (only for templates with VSync enabled). */
export function vsyncEnv(config: { vsync?: VsyncConfig; encryptionKey: string; publicBaseUrl?: string }, tenant: { id: string; template_id: string }): Record<string, string> {
  const cfg = config.vsync;
  if (!cfg?.enabled || !(cfg.templates?.length ? cfg.templates : ["mirror-v-full"]).includes(tenant.template_id)) return {};
  const agent = tenantAgentId(cfg, tenant.id);
  if (!AGENT_ID.test(agent) || cfg.revoked?.includes(agent)) return {};
  return {
    NEXUS_VSYNC_URL: `${(config.publicBaseUrl || "https://mirror-v-portal.vercel.app").replace(/\/$/, "")}/onboard/vsync/v1`,
    NEXUS_VSYNC_AGENT: agent,
    NEXUS_VSYNC_TOKEN: vsyncToken(config.encryptionKey, agent),
  };
}

export interface Caller { agent: string }

/** The operations a Mirror V can perform, each confined to its own part of the hub. */
export class VsyncBroker {
  readonly counterparts: string[];
  constructor(readonly cfg: VsyncConfig, readonly encryptionKey: string, readonly hub: HubRepo, private readonly tenantExists: (agent: string) => Promise<boolean>) {
    this.counterparts = cfg.counterparts?.length ? cfg.counterparts : ["private-v"];
  }

  async authenticate(agent: unknown, token: unknown): Promise<Caller> {
    if (!this.cfg.enabled) throw new VsyncError("VSYNC_DISABLED", 404);
    if (typeof agent !== "string" || !AGENT_ID.test(agent) || typeof token !== "string") throw new VsyncError("VSYNC_UNAUTHORIZED", 401);
    if (!tokenMatches(this.encryptionKey, agent, token)) throw new VsyncError("VSYNC_UNAUTHORIZED", 401);
    if (this.counterparts.includes(agent) || this.cfg.revoked?.includes(agent)) throw new VsyncError("VSYNC_UNAUTHORIZED", 401);
    if (!this.cfg.deployments?.includes(agent) && !(await this.tenantExists(agent))) throw new VsyncError("VSYNC_UNAUTHORIZED", 401);
    return { agent };
  }

  whoami(c: Caller) {
    return { agent: c.agent, counterparts: this.counterparts, sendLimitBytes: SEND_LIMIT_BYTES };
  }

  async inbox(c: Caller) {
    return { rows: parseRows((await this.hub.read(`agents/${c.agent}/inbox.jsonl`))?.toString("utf8") ?? "") };
  }

  async acks(c: Caller) {
    return { rows: parseRows((await this.hub.read(`agents/${c.agent}/ack.jsonl`))?.toString("utf8") ?? "") };
  }

  /** Counterparts' acknowledgements of what this agent sent (rows addressed to it only). */
  async replies(c: Caller) {
    const rows = [];
    for (const who of this.counterparts) {
      const text = (await this.hub.read(`agents/${who}/ack.jsonl`))?.toString("utf8") ?? "";
      rows.push(...parseRows(text).filter((r) => r.to === c.agent));
    }
    return { rows };
  }

  /** Packages addressed to this agent, with the senders' manifest rows for them (and nobody else's). */
  async packages(c: Caller) {
    const senders = (await this.hub.dirs("agents")).map((d) => d.split("/")[1]).filter((d) => d && d !== c.agent && AGENT_ID.test(d));
    const out = [];
    for (const from of senders) {
      const files = await this.hub.list(`agents/${from}/returns/${c.agent}`);
      if (!files.length) continue;
      const manifest = parseRows((await this.hub.read(`agents/${from}/return-manifest.jsonl`))?.toString("utf8") ?? "").filter((r) => r.to === c.agent);
      const byId = new Map<string, { path: string; size: number }[]>();
      const base = `agents/${from}/returns/${c.agent}/`;
      for (const f of files) {
        const id = f.path.slice(base.length).split("/")[0];
        byId.set(id, [...(byId.get(id) ?? []), { path: f.path, size: f.size }]);
      }
      for (const [id, list] of byId) {
        const pkgId = id.replace(/\.(tar\.gz|tgz|tar\.zst|zip)$/, "");
        out.push({ from, packageId: pkgId, files: list, manifest: manifest.find((r) => r.package_id === pkgId) ?? null });
      }
    }
    return { packages: out };
  }

  async file(c: Caller, p: unknown) {
    const clean = cleanPath(p);
    if (!canRead(c.agent, clean)) throw new VsyncError("PATH_FORBIDDEN", 403);
    const body = await this.hub.read(clean);
    if (!body) throw new VsyncError("NOT_FOUND", 404);
    if (body.length > FILE_LIMIT_BYTES) throw new VsyncError("FILE_TOO_LARGE", 413);
    return body;
  }

  async ack(c: Caller, input: unknown) {
    const row = (input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : null);
    if (!row) throw new VsyncError("ACK_INVALID");
    if (row.from !== undefined && row.from !== c.agent) throw new VsyncError("ACK_FROM_MISMATCH", 403);
    if (typeof row.in_reply_to !== "string" || !row.in_reply_to) throw new VsyncError("ACK_IN_REPLY_TO_REQUIRED");
    if (row.status !== undefined && !["applied", "blocked", "BLOCKED", "received", "rejected", "partial"].includes(String(row.status))) throw new VsyncError("ACK_STATUS_INVALID");
    const now = stamp();
    const full: Record<string, unknown> = { schema: "v-sync.a2a-ack.v1", id: `ack_${now.compact}_${c.agent}`, created_at: now.iso, ...row, from: c.agent, recorded_by: c.agent, via: "mirror-v-vsync-broker" };
    // An ACK answers a message in my inbox: by default it goes back to whoever sent that message.
    if (typeof full.to !== "string") {
      const inbox = parseRows((await this.hub.read(`agents/${c.agent}/inbox.jsonl`, true))?.toString("utf8") ?? "");
      const asked = inbox.find((r) => r.id === row.in_reply_to);
      full.to = typeof asked?.from === "string" && AGENT_ID.test(asked.from) ? asked.from : this.counterparts[0];
    }
    const line = rowLine(full);
    const commit = await this.hub.commit([{ path: `agents/${c.agent}/ack.jsonl`, append: [line] }], `ack(${c.agent}): ${String(row.in_reply_to).slice(0, 80)}`);
    return { ok: true, commit, row: full };
  }

  /**
   * Send a package (files, may be empty for a plain message) to a counterpart:
   * files under agents/<me>/returns/<to>/<package>/, a manifest row in my
   * return-manifest.jsonl, and a message in the counterpart's inbox.
   */
  async send(c: Caller, input: any) {
    const to = input?.to ?? this.counterparts[0];
    if (!this.counterparts.includes(to)) throw new VsyncError("RECIPIENT_FORBIDDEN", 403);
    const subject = typeof input?.subject === "string" ? input.subject.slice(0, 300) : "";
    const body = typeof input?.body === "string" ? input.body.slice(0, 8000) : "";
    // A CLI flag mistaken for a subject ("--help") must not reach a counterpart's inbox.
    if (subject.trim().length < 3 || subject.startsWith("-")) throw new VsyncError("SUBJECT_REQUIRED");
    const now = stamp();
    const slug = (typeof input?.packageId === "string" && input.packageId ? input.packageId : subject).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "message";
    const files: { path: string; content: Buffer }[] = [];
    let total = 0;
    for (const f of Array.isArray(input?.files) ? input.files : []) {
      const rel = cleanPath(f?.path);
      if (typeof f?.contentBase64 !== "string") throw new VsyncError("FILE_CONTENT_INVALID");
      const content = Buffer.from(f.contentBase64, "base64");
      total += content.length;
      files.push({ path: rel, content });
    }
    if (total > SEND_LIMIT_BYTES) throw new VsyncError("PACKAGE_TOO_LARGE", 413);
    if (new Set(files.map((f) => f.path)).size !== files.length) throw new VsyncError("PATH_DUPLICATE");
    const packageId = files.length ? `${c.agent}_to_${to}_${now.compact}+0800_${slug}` : null;
    if (packageId && !PACKAGE_ID.test(packageId)) throw new VsyncError("PACKAGE_ID_INVALID");
    const dir = packageId ? `agents/${c.agent}/returns/${to}/${packageId}` : null;
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const fileRows = files.map((f) => ({ path: `${dir}/${f.path}`, sha256: sha(f.content), bytes: f.content.length }));
    const packageSha = fileRows.length ? createHash("sha256").update(fileRows.map((f) => `${f.sha256}  ${f.path}`).sort().join("\n")).digest("hex") : null;
    const message = {
      schema: "v-sync.a2a-message.v1", id: `a2a_${now.compact}_${c.agent}_${slug}`.slice(0, 160), created_at: now.iso,
      from: c.agent, to, type: packageId ? "package" : "message", subject, body,
      refs: packageId ? { package_id: packageId, sha256: packageSha, return_manifest: `agents/${c.agent}/return-manifest.jsonl`, files: fileRows, ack_path: `agents/${to}/ack.jsonl` } : { ack_path: `agents/${to}/ack.jsonl` },
      requires_ack: input?.requiresAck !== false, via: "mirror-v-vsync-broker",
    };
    const changes: Change[] = files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content }));
    if (packageId) {
      changes.push({ path: `agents/${c.agent}/return-manifest.jsonl`, append: [rowLine({
        schema: "v-sync.return-package-manifest.v1", package_id: packageId, created_at: now.iso, from: c.agent, to,
        format: "dir", sha256: packageSha, files: fileRows.map((f) => f.path), file_sha256: Object.fromEntries(fileRows.map((f) => [f.path, f.sha256])),
        counts: { files: fileRows.length }, note: typeof input?.note === "string" ? input.note.slice(0, 500) : subject,
      })] });
    }
    changes.push({ path: `agents/${to}/inbox.jsonl`, append: [rowLine(message)] });
    const commit = await this.hub.commit(changes, `${packageId ? "package" : "message"}(${c.agent} → ${to}): ${subject.slice(0, 80)}`, async (exists) => {
      if (dir && await exists(dir)) throw new VsyncError("PACKAGE_EXISTS", 409);
    });
    return { ok: true, commit, message, packageId, sha256: packageSha };
  }
}
