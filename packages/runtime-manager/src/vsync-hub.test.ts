import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canRead, cleanPath, HubRepo, tenantAgentId, VsyncBroker, vsyncToken } from "./vsync-hub.js";

const KEY = "test-encryption-key";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

function hub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsync-test-"));
  const seed = path.join(root, "seed"), remote = path.join(root, "remote.git");
  const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(seed, p)), { recursive: true }); fs.writeFileSync(path.join(seed, p), s); };
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  write("README.md", "hub\n");
  write("agents/private-v/returns/mirror-a/pkg-1/SKILL.md", "skill for a\n");
  write("agents/private-v/returns/mirror-b/pkg-2/SKILL.md", "skill for b (secret)\n");
  write("agents/private-v/return-manifest.jsonl", `${JSON.stringify({ package_id: "pkg-1", to: "mirror-a" })}\n${JSON.stringify({ package_id: "pkg-2", to: "mirror-b", note: "b only" })}\n`);
  write("agents/mirror-a/inbox.jsonl", `${JSON.stringify({ id: "m1", to: "mirror-a" })}\n`);
  write("agents/mirror-b/inbox.jsonl", `${JSON.stringify({ id: "m2", to: "mirror-b" })}\n`);
  write("agents/private-v/ack.jsonl", `${JSON.stringify({ id: "k1", to: "mirror-a" })}\n${JSON.stringify({ id: "k2", to: "mirror-b" })}\n`);
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "seed");
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  git(remote, "config", "uploadpack.allowFilter", "true");
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  const cfg = { enabled: true, repo: `file://${remote}`, dir: path.join(root, "work", "repo"), counterparts: ["private-v"], deployments: ["cust-x"] };
  const repo = new HubRepo(cfg);
  const broker = new VsyncBroker(cfg, KEY, repo, async (agent) => ["mirror-a", "mirror-b"].includes(agent));
  return { root, seed, remote, cfg, broker, show: (p: string) => git(remote, "show", `main:${p}`) };
}

describe("vsync policy", () => {
  it("lets an agent read only its own directory and packages addressed to it", () => {
    expect(canRead("mirror-a", "agents/mirror-a/inbox.jsonl")).toBe(true);
    expect(canRead("mirror-a", "agents/private-v/returns/mirror-a/pkg/SKILL.md")).toBe(true);
    expect(canRead("mirror-a", "agents/private-v/returns/mirror-b/pkg/SKILL.md")).toBe(false);
    expect(canRead("mirror-a", "agents/private-v/return-manifest.jsonl")).toBe(false);
    expect(canRead("mirror-a", "agents/mirror-b/inbox.jsonl")).toBe(false);
    expect(canRead("mirror-a", "README.md")).toBe(false);
    for (const bad of ["../x", "agents/../agents/mirror-b/x", "/agents/mirror-a/x", "agents//x", "agents/mirror-a/.git/x"]) expect(() => cleanPath(bad)).toThrow("PATH_INVALID");
  });
  it("derives agent ids for tenants, keeps fixed ones", () => {
    expect(tenantAgentId({ repo: "", dir: "" }, "99591967-b93f-4254-8661-53c4dd734362")).toBe("mirror-99591967");
    expect(tenantAgentId({ repo: "", dir: "" }, "mvfull-vsync-03")).toBe("mirror-mvfull-vsync-03");
    expect(tenantAgentId({ repo: "", dir: "", tenantAgents: { t1: "mirror-v-004" } }, "t1")).toBe("mirror-v-004");
  });
  it("refuses wrong tokens, counterparts, unknown and revoked agents", async () => {
    const { broker, cfg } = hub();
    await expect(broker.authenticate("mirror-a", vsyncToken(KEY, "mirror-b"))).rejects.toThrow("VSYNC_UNAUTHORIZED");
    await expect(broker.authenticate("private-v", vsyncToken(KEY, "private-v"))).rejects.toThrow("VSYNC_UNAUTHORIZED");
    await expect(broker.authenticate("mirror-zzz", vsyncToken(KEY, "mirror-zzz"))).rejects.toThrow("VSYNC_UNAUTHORIZED");
    await expect(broker.authenticate("cust-x", vsyncToken(KEY, "cust-x"))).resolves.toEqual({ agent: "cust-x" });
    cfg.revoked = ["mirror-a"];
    await expect(broker.authenticate("mirror-a", vsyncToken(KEY, "mirror-a"))).rejects.toThrow("VSYNC_UNAUTHORIZED");
  });
});

describe("vsync broker against a git hub", () => {
  it("receives only its own packages, manifest rows, inbox and replies", async () => {
    const { broker } = hub();
    const a = { agent: "mirror-a" };
    const { packages } = await broker.packages(a);
    expect(packages).toEqual([{ from: "private-v", packageId: "pkg-1", files: [{ path: "agents/private-v/returns/mirror-a/pkg-1/SKILL.md", size: 12 }], manifest: { package_id: "pkg-1", to: "mirror-a" } }]);
    expect((await broker.file(a, "agents/private-v/returns/mirror-a/pkg-1/SKILL.md")).toString()).toBe("skill for a\n");
    await expect(broker.file(a, "agents/private-v/returns/mirror-b/pkg-2/SKILL.md")).rejects.toThrow("PATH_FORBIDDEN");
    expect((await broker.inbox(a)).rows).toEqual([{ id: "m1", to: "mirror-a" }]);
    expect((await broker.replies(a)).rows.map((r) => r.id)).toEqual(["k1"]);
  });
  it("appends ACKs as itself and sends packages to a counterpart only", async () => {
    const { broker, show } = hub();
    const a = { agent: "mirror-a" };
    await expect(broker.ack(a, { in_reply_to: "m1", from: "mirror-b" })).rejects.toThrow("ACK_FROM_MISMATCH");
    const ack = await broker.ack(a, { in_reply_to: "m1", status: "applied", summary: "installed" });
    expect(ack.row.from).toBe("mirror-a");
    expect(ack.row.to).toBe("private-v");
    expect(show("agents/mirror-a/ack.jsonl")).toContain('"in_reply_to":"m1"');
    await expect(broker.send(a, { to: "mirror-b", subject: "x", files: [] })).rejects.toThrow("RECIPIENT_FORBIDDEN");
    const sent = await broker.send(a, { to: "private-v", subject: "A skill back", body: "please review", files: [{ path: "skills/demo/SKILL.md", contentBase64: Buffer.from("demo\n").toString("base64") }] });
    expect(sent.packageId).toMatch(/^mirror-a_to_private-v_\d{8}T\d{6}\+0800_a-skill-back$/);
    expect(show(`agents/mirror-a/returns/private-v/${sent.packageId}/skills/demo/SKILL.md`)).toBe("demo\n");
    expect(show("agents/mirror-a/return-manifest.jsonl")).toContain(sent.packageId!);
    const inbox = show("agents/private-v/inbox.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    expect(inbox.at(-1)).toMatchObject({ from: "mirror-a", to: "private-v", type: "package", refs: { package_id: sent.packageId, sha256: sent.sha256 } });
    await expect(broker.send(a, { subject: "../escape", files: [{ path: "../../x", contentBase64: "" }] })).rejects.toThrow("PATH_INVALID");
  });
  it("retries when another writer pushed first, keeping both writes", async () => {
    const { broker, remote, root, show } = hub();
    const a = { agent: "mirror-a" };
    await broker.inbox(a); // clone and fetch
    const other = path.join(root, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    fs.appendFileSync(path.join(other, "agents/mirror-a/inbox.jsonl"), `${JSON.stringify({ id: "m3", to: "mirror-a" })}\n`);
    git(other, "commit", "-qam", "V writes"); git(other, "push", "-q", "origin", "main");
    await broker.ack(a, { in_reply_to: "m3", status: "received" });
    expect(show("agents/mirror-a/inbox.jsonl")).toContain('"m3"');
    expect(show("agents/mirror-a/ack.jsonl")).toContain('"in_reply_to":"m3"');
    expect((await broker.inbox(a)).rows.map((r) => r.id)).toEqual(["m1", "m3"]);
  });
});
