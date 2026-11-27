import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { AGENT_DB, applyCapture, codexHomeConfig, compactAgentDb, ensureCodexHome, installedCodexVersion, linkCoreAi, isVReleaseBackupExcluded, isVReleaseDaemon, readVRelease } from "../runtime/v-release.mjs";
import { createVReleaseConfig } from "../runtime/v-config.mjs";
import { templateRuntimeEnv, templateVcpus } from "./provider.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v-release-"));
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  fs.writeFileSync(path.join(pkg, "dist", "a.js"), "upstream-a");
  const capture = path.join(root, "capture");
  fs.mkdirSync(path.join(capture, "dist"), { recursive: true });
  fs.writeFileSync(path.join(capture, "dist", "a.js"), "patched-a");
  fs.writeFileSync(path.join(capture, "dist", "b.js"), "added-b");
  fs.writeFileSync(path.join(capture, "manifest.json"), JSON.stringify({
    release: "v-test", upstream: "2026.9.1", removedFromBase: [], files: [
      { path: "./a.js", kind: "modified", sha256: sha("patched-a"), baseSha256: sha("upstream-a") },
      { path: "./b.js", kind: "added", sha256: sha("added-b") },
    ],
  }));
  return { root, dist: path.join(pkg, "dist"), capture };
}

test("capture overlays exact upstream bytes and is idempotent", () => {
  const { root, dist, capture } = fixture();
  try {
    expect(applyCapture(capture, dist)).toEqual({ release: "v-test", modified: 1, added: 1, alreadyApplied: 0 });
    expect(fs.readFileSync(path.join(dist, "a.js"), "utf8")).toBe("patched-a");
    expect(applyCapture(capture, dist)).toEqual({ release: "v-test", modified: 0, added: 0, alreadyApplied: 2 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("capture fails closed on drifted upstream bytes or a different base version", () => {
  const { root, dist, capture } = fixture();
  try {
    fs.writeFileSync(path.join(dist, "a.js"), "someone-else-patched");
    expect(() => applyCapture(capture, dist)).toThrow("V_RELEASE_BASE_BYTES_MISMATCH:a.js");
    fs.writeFileSync(path.join(dist, "a.js"), "upstream-a");
    fs.writeFileSync(path.join(dist, "..", "package.json"), JSON.stringify({ version: "2026.9.2" }));
    expect(() => applyCapture(capture, dist)).toThrow("V_RELEASE_BASE_VERSION_MISMATCH");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("only V's own daemons are ignored when deciding whether a VM may sleep", () => {
  expect(isVReleaseDaemon("/usr/local/bin/node /vercel/sandbox/nexus/v/worker/dist/worker.mjs")).toBe(true);
  expect(isVReleaseDaemon("node /vercel/sandbox/nexus/v/v-memory-indexer.mjs mirror-v-full")).toBe(true);
  // The boot-time index pass and the shell that chains it into the indexer.
  expect(isVReleaseDaemon("node /vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs memory index --agent mirror-v-full")).toBe(true);
  expect(isVReleaseDaemon('sh -c nice -n 10 node /vercel/sandbox/nexus/runtime/node_modules/openclaw/openclaw.mjs memory index --agent "$1" >/dev/null 2>&1; exec node /vercel/sandbox/nexus/v/v-memory-indexer.mjs "$1" sh mirror-v-full')).toBe(true);
  expect(isVReleaseDaemon("/vercel/sandbox/nexus/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex app-server")).toBe(true);
  expect(isVReleaseDaemon("python3 long_job.py")).toBe(false);
  expect(isVReleaseDaemon("bash -c sleep 600")).toBe(false);
});

test("backups skip reinstallable plugins and Codex logs but keep sessions and memory", () => {
  expect(isVReleaseBackupExcluded("state/npm/projects/openclaw-codex-1/node_modules/x.js")).toBe(true);
  expect(isVReleaseBackupExcluded("state/agents/mirror-v-full/agent/codex-home/logs_2.sqlite-wal")).toBe(true);
  expect(isVReleaseBackupExcluded("state/agents/mirror-v-full/agent/codex-home/config.toml")).toBe(false);
  expect(isVReleaseBackupExcluded("state/agents/mirror-v-full/agent/codex-home/.tmp/plugins/.git/objects/pack/p.pack")).toBe(true);
  expect(isVReleaseBackupExcluded("state/browser/openclaw/user-data/BrowserMetrics/BrowserMetrics-1.pma")).toBe(true);
  expect(isVReleaseBackupExcluded("state/agents/mirror-v-full/agent/openclaw-agent.sqlite")).toBe(false);
  expect(isVReleaseBackupExcluded("workspace/memory/index.md")).toBe(false);
  expect(isVReleaseBackupExcluded("state/cache/control-ui-assets/x/mermaid.js")).toBe(true);
});

test("codex home is written with DeepSeek routing and no key value, and only our own file is upgraded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  try {
    const file = ensureCodexHome(root, "mirror-v-full");
    expect(fs.readFileSync(file, "utf8")).toBe(codexHomeConfig());
    expect(codexHomeConfig()).toContain('env_key = "DEEPSEEK_API_KEY"');
    // As on V: one retry each, so a DeepSeek outage reaches the fallback in seconds.
    expect(codexHomeConfig()).toMatch(/request_max_retries = 1\nstream_max_retries = 1\n/);
    expect(codexHomeConfig()).not.toContain("remote_plugin");
    expect(codexHomeConfig({ codexVersion: "0.169.1" })).toContain("[features]\nremote_plugin = false\n");
    expect(codexHomeConfig({ codexVersion: "0.159.2" })).not.toContain("remote_plugin");
    // The file written before 2026-11-27 is upgraded in place.
    fs.writeFileSync(file, 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "https://api.deepseek.com/v1"\nwire_api = "responses"\nenv_key = "DEEPSEEK_API_KEY"\n');
    ensureCodexHome(root, "mirror-v-full", { codexVersion: "0.169.1" });
    expect(fs.readFileSync(file, "utf8")).toBe(codexHomeConfig({ codexVersion: "0.169.1" }));
    // Codex appends its own trust entries; they stay, and our part is still upgraded.
    const trust = '[projects."/vercel/sandbox/agent-data/workspace"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, `${codexHomeConfig()}\n${trust}`);
    ensureCodexHome(root, "mirror-v-full", { codexVersion: "0.169.1" });
    expect(fs.readFileSync(file, "utf8")).toBe(`${codexHomeConfig({ codexVersion: "0.169.1" }).trimEnd()}\n\n${trust}`);
    ensureCodexHome(root, "mirror-v-full", { codexVersion: "0.169.1" });
    expect(fs.readFileSync(file, "utf8")).toBe(`${codexHomeConfig({ codexVersion: "0.169.1" }).trimEnd()}\n\n${trust}`);
    fs.writeFileSync(file, `${codexHomeConfig()}\n${trust}[mcp_servers.x]\ncommand = "y"\n`);
    ensureCodexHome(root, "mirror-v-full", { codexVersion: "0.169.1" });
    expect(fs.readFileSync(file, "utf8")).toContain("[mcp_servers.x]");
    expect(fs.readFileSync(file, "utf8")).not.toContain("remote_plugin");
    fs.writeFileSync(file, "owner edit");
    ensureCodexHome(root, "mirror-v-full");
    expect(fs.readFileSync(file, "utf8")).toBe("owner edit");
    expect(readVRelease(path.join(root, "missing.json"))).toBeNull();
    const prefix = path.join(root, "codex");
    fs.mkdirSync(path.join(prefix, "node_modules/@openai/codex"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "node_modules/@openai/codex/package.json"), JSON.stringify({ version: "0.169.1" }));
    expect(installedCodexVersion(`${prefix}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`)).toBe("0.169.1");
    expect(installedCodexVersion("/elsewhere/codex")).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("V's whole-package codex capture becomes a fail-closed overlay that reproduces it", async () => {
  // @ts-expect-error plain .mjs build helper without types
  const { codexDelta } = await import("../../../deploy/v-release/codex-delta.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-delta-"));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    const npm = path.join(root, "npm"), cap = path.join(root, "cap"), out = path.join(root, "out");
    const base = { "package.json": JSON.stringify({ name: "@openclaw/codex", version: "2026.9.1" }), "dist/a.js": "a0", "dist/b.js": "b0" };
    const v = { ...base, "dist/a.js": "a1", "dist/v.json": "{}" };
    for (const [rel, text] of Object.entries(base)) write(path.join(npm, rel), text);
    for (const [rel, text] of Object.entries(v)) write(path.join(cap, "dist", rel), text);
    const manifest = (files: Record<string, string>) => JSON.stringify({ release: "r.codex", upstream: "@openclaw/codex 2026.9.1", removedFromBase: [],
      files: Object.entries(files).map(([rel, text]) => ({ path: `./${rel}`, sha256: sha(text), kind: "added" })) });
    write(path.join(cap, "manifest.json"), manifest(v));
    fs.mkdirSync(out);
    expect(codexDelta(cap, npm, out)).toEqual({ release: "r.codex", modified: 1, added: 1 });
    const pkg = path.join(root, "pkg");
    fs.cpSync(npm, pkg, { recursive: true });
    applyCapture(out, path.join(pkg, "dist"));
    for (const [rel, text] of Object.entries(v)) expect(fs.readFileSync(path.join(pkg, rel), "utf8")).toBe(text);
    // A package-level difference or an npm file V does not have cannot be expressed as an overlay.
    write(path.join(npm, "dist/stale.js"), "x");
    expect(() => codexDelta(cap, npm, fs.mkdtempSync(path.join(root, "o")))).toThrow(/CODEX_DELTA_NPM_ONLY_FILES/);
    fs.rmSync(path.join(npm, "dist/stale.js"));
    write(path.join(cap, "dist/package.json"), JSON.stringify({ name: "@openclaw/codex", version: "2026.9.1", x: 1 }));
    write(path.join(cap, "manifest.json"), manifest({ ...v, "package.json": JSON.stringify({ name: "@openclaw/codex", version: "2026.9.1", x: 1 }) }));
    expect(() => codexDelta(cap, npm, fs.mkdtempSync(path.join(root, "o")))).toThrow(/CODEX_DELTA_PACKAGE_FILE_DIFFERS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v-release config routes models through the Worker pool and holds only env references", () => {
  const cfg = createVReleaseConfig({
    agentId: "mirror-v-full", workspace: "/w", dataDir: "/d", schedulerPath: "/s", workerPluginPath: "/wk",
    env: { GOOGLE_API_KEY: "g", XAI_API_KEY: "x" }, codexCommand: "/c/codex",
  });
  const text = JSON.stringify(cfg);
  expect(text).not.toMatch(/"(?:g|x)"/);
  expect(cfg.agents.defaults.models["deepseek/deepseek-flash"].agentRuntime.id).toBe("vlab-worker");
  expect(cfg.agents.defaults.models["deepseek/vds-deepseek-flash"].agentRuntime.id).toBe("codex");
  // V's default: the Codex harness, with the Worker pool on the same model as the fallback.
  expect(cfg.agents.defaults.model).toEqual({ primary: "deepseek/vds-deepseek-flash", fallbacks: ["deepseek/deepseek-flash"] });
  expect(cfg.plugins.entries["vlab-agent-worker-isolation"].config.workerConfigPath).toBe("/d/worker-openclaw.json");
  expect(cfg.memory.search.provider).toBe("gemini");
  expect(cfg.plugins.allow).toContain("google");
  expect(cfg.plugins.entries.google).toEqual({ enabled: true });
  expect(cfg.tools.deny).toEqual(["gateway", "cron", "ask_user", "sessions_yield", "message", "image_generate", "video_generate", "music_generate"]);
  expect(cfg.tools.exec).toEqual({ host: "gateway", security: "full", ask: "off", pathPrepend: ["/d/npm/bin"] });
  expect(cfg.gateway.reload).toEqual({ mode: "off" });
  const bare = createVReleaseConfig({ agentId: "a", workspace: "/w", dataDir: "/d", schedulerPath: "/s", workerPluginPath: "/wk", env: {} });
  expect(bare.memory.search.provider).toBe("none");
  expect(bare.agents.defaults.models["deepseek/vds-deepseek-flash"]).toBeUndefined();
  expect(bare.agents.defaults.model).toEqual({ primary: "deepseek/deepseek-flash" });
  // DeepSeek rejects history + max_tokens above 1,048,576; compaction only watches the window.
  const models = cfg.models.providers.deepseek.models;
  expect(models.map((model: any) => model.id)).toEqual(["deepseek-flash", "deepseek-v4-pro", "vds-deepseek-flash"]);
  for (const model of models) {
    expect(model).toMatchObject({ contextWindow: 980000, maxTokens: 64000 });
    expect(model.contextWindow + model.maxTokens).toBeLessThanOrEqual(1048576);
  }
  expect(cfg.plugins.entries.codex.config.codexDynamicToolsExclude).toEqual(["openclaw"]);
  // The DeepSeek timeout follows the snapshot's runtime: 90 s needs a core that falls back on it.
  expect(cfg.models.providers.deepseek.timeoutSeconds).toBe(300);
  expect(createVReleaseConfig({ agentId: "a", workspace: "/w", dataDir: "/d", schedulerPath: "/s", workerPluginPath: "/wk", env: {}, deepseekTimeoutSeconds: 90 })
    .models.providers.deepseek.timeoutSeconds).toBe(90);
});

test("template sandbox size and keys are bounded", () => {
  expect(templateVcpus(undefined)).toBe(2);
  expect(templateVcpus({ version: "v", snapshotId: "s", resources: { vcpus: 4 } })).toBe(4);
  expect(templateVcpus({ version: "v", snapshotId: "s", resources: { vcpus: 64 } })).toBe(2);
  expect(templateRuntimeEnv({ version: "v", snapshotId: "s", runtimeEnv: { GOOGLE_API_KEY: "k" } })).toEqual({ GOOGLE_API_KEY: "k" });
  expect(() => templateRuntimeEnv({ version: "v", snapshotId: "s", runtimeEnv: { NEXUS_MODEL_KEY: "k" } })).toThrow("TEMPLATE_RUNTIME_ENV_INVALID");
});

test("a person on a public page or a live keep-awake deadline keeps the VM up", async () => {
  const { vReleaseKeepAwake, establishedLocalPorts } = await import("../runtime/v-release.mjs");
  const tcp = "  sl  local_address rem_address   st\n   0: 00000000:4970 00000000:0000 0A\n   1: 0100007F:4970 0100007F:D431 01\n   2: 0100007F:4E20 0100007F:D432 01\n";
  const ports = establishedLocalPorts((file: string) => file.endsWith("tcp") ? tcp : "");
  expect([...ports].sort()).toEqual([18800, 20000]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepawake-"));
  try {
    expect(vReleaseKeepAwake({ publicPorts: { desktop: 18800 }, established: ports, dir })).toBe("public-connection:desktop");
    expect(vReleaseKeepAwake({ publicPorts: { browser: 18800 }, idlePorts: ["browser"], established: ports, dir })).toBeNull();
    fs.writeFileSync(path.join(dir, "handoff"), String(Date.now() + 60000));
    expect(vReleaseKeepAwake({ publicPorts: {}, established: ports, dir })).toBe("keep-awake:handoff");
    fs.writeFileSync(path.join(dir, "handoff"), String(Date.now() - 1));
    expect(vReleaseKeepAwake({ publicPorts: {}, established: ports, dir })).toBeNull();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the session deadline is pushed back only when it is near", async () => {
  const { keepSessionAlive } = await import("./provider.js");
  const calls: number[] = [];
  const sbx = (expiresIn: number) => ({ expiresAt: new Date(1_000_000 + expiresIn), extendTimeout: async (ms: number) => { calls.push(ms); } }) as any;
  expect(await keepSessionAlive(sbx(20 * 60_000), 900_000, 1_000_000)).toBe(false);
  expect(await keepSessionAlive(sbx(60_000), 900_000, 1_000_000)).toBe(true);
  expect(calls).toEqual([900_000 - 60_000 + 300_000]);
  expect(await keepSessionAlive({ update: async () => {} } as any, 900_000)).toBe(false);
});

test("helpers of V's daemons are daemons; an agent's own background job is not", async () => {
  const { daemonTree } = await import("../runtime/v-release.mjs");
  const isDaemon = daemonTree([
    { pid: "10", ppid: "1", command: "/opt/google/chrome/chrome --remote-debugging-port=18801" },
    { pid: "11", ppid: "10", command: "cat" },
    { pid: "20", ppid: "1", command: "openclaw" },
    { pid: "21", ppid: "20", command: "openclaw-node" },
    { pid: "30", ppid: "1", command: "openclaw-gateway" },
    { pid: "31", ppid: "30", command: "/usr/local/bin/node /vercel/sandbox/nexus/v/worker/dist/worker.mjs" },
    { pid: "32", ppid: "31", command: "bash -c sleep 600" },
  ]);
  expect(["10", "11", "20", "21", "31"].map(isDaemon)).toEqual([true, true, true, true, true]);
  expect(isDaemon("32")).toBe(false);
});

test("the native memory KNN helper does not pin idle VMs or exempt user jobs", async () => {
  const { daemonTree } = await import("../runtime/v-release.mjs");
  const helper = "/vercel/sandbox/nexus/runtime/node_modules/openclaw/dist/extensions/memory-core/memory-search-knn.child.js";
  expect(isVReleaseDaemon(`/usr/local/bin/node ${helper}`)).toBe(true);
  expect(isVReleaseDaemon(`node ${helper}`)).toBe(true);
  expect(isVReleaseDaemon("node /workspace/memory-search-knn.child.js")).toBe(false);
  expect(isVReleaseDaemon(`bash -c node ${helper}`)).toBe(false);
  expect(isVReleaseDaemon(`node ${helper}.user-job.js`)).toBe(false);
  const isDaemon = daemonTree([
    { pid: "10", ppid: "1", command: "openclaw-gateway" },
    { pid: "11", ppid: "10", command: `/usr/local/bin/node ${helper}` },
    { pid: "12", ppid: "10", command: "python3 long_job.py" },
    { pid: "13", ppid: "11", command: "bash -c sleep 600" },
  ]);
  expect(isDaemon("11")).toBe(true);
  expect(isDaemon("12")).toBe(false);
  expect(isDaemon("13")).toBe(false);
});

test("agent DB backups drop the rebuildable memory index and keep everything else", async () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-"));
  const src = path.join(dir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(src);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE transcript_events(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE memory_index_chunks(id TEXT, embedding TEXT); CREATE TABLE memory_index_meta(key TEXT, value TEXT); CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(text)");
  db.exec("INSERT INTO transcript_events(body) VALUES ('hello'); INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', '{}')");
  const insert = db.prepare("INSERT INTO memory_index_chunks VALUES (?, ?)");
  for (let i = 0; i < 200; i++) insert.run(String(i), "x".repeat(4096));
  db.exec("INSERT INTO memory_index_chunks_fts(text) VALUES ('chunk')");
  const dst = path.join(dir, "copy.sqlite");
  // The live connection stays open, as the Gateway's does.
  expect(await compactAgentDb(src, dst, "/missing/vec0.so", 0)).toBe(true);
  db.close();
  const copy = new DatabaseSync(dst, { readOnly: true });
  const count = (table: string) => (copy.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  expect([count("transcript_events"), count("memory_index_meta"), count("memory_index_chunks"), count("memory_index_chunks_fts")]).toEqual([1, 1, 0, 0]);
  copy.close();
  expect(fs.statSync(dst).size).toBeLessThan(fs.statSync(src).size / 4);
  expect(fs.existsSync(dst + "-wal")).toBe(false);
  // Small DBs and failures leave the raw file to the caller.
  expect(await compactAgentDb(src, path.join(dir, "small.sqlite"))).toBe(false);
  expect(await compactAgentDb(path.join(dir, "missing.sqlite"), path.join(dir, "x.sqlite"), "", 0)).toBe(false);
  expect(fs.existsSync(path.join(dir, "x.sqlite"))).toBe(false);
  expect(["state/agents/mirror-v-full/agent/openclaw-agent.sqlite", "state/agents/a/agent/openclaw-agent.sqlite-wal", "state/state/openclaw.sqlite"].map((rel) => AGENT_DB.exec(rel)?.[1] ?? (AGENT_DB.test(rel) ? "" : null))).toEqual(["", "-wal", null]);
});

test("a deferred sleep records what quiesce found, without process arguments", async () => {
  const { quiesceDetail } = await import("./provider.js");
  expect(quiesceDetail('noise\n{"ok":false,"reason":"background-processes","count":2,"commands":["python3","node"]}\n')).toEqual({ reason: "background-processes", count: 2, commands: ["python3", "node"] });
  expect(quiesceDetail('{"ok":false,"reason":"desktop-handoff"}')).toEqual({ reason: "desktop-handoff" });
  expect(quiesceDetail("garbage")).toBeUndefined();
});

test("the desktop session starts without xfwm4's software compositor and keeps other settings", async () => {
  const { disableCompositing } = await import("../runtime/v-features.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-"));
  const file = path.join(dir, "config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml");
  expect(disableCompositing(dir)).toBe(true);
  expect(fs.readFileSync(file, "utf8")).toContain('<property name="use_compositing" type="bool" value="false"/>');
  expect(disableCompositing(dir)).toBe(false);
  fs.writeFileSync(file, '<channel name="xfwm4" version="1.0">\n  <property name="general" type="empty">\n    <property name="theme" type="string" value="Default"/>\n    <property name="use_compositing" type="bool" value="true"/>\n  </property>\n</channel>\n');
  expect(disableCompositing(dir)).toBe(true);
  const xml = fs.readFileSync(file, "utf8");
  expect(xml).toContain('value="false"');
  expect(xml).toContain('name="theme"');
  expect(xml.match(/use_compositing/g)).toHaveLength(1);
});


test("V-host-only core glue is replaced only when it is V's reviewed bytes", async () => {
  // @ts-expect-error plain .mjs build helper without types
  const { adaptCore, CORE_REPLACEMENTS } = await import("../../../deploy/v-release/core-mirror.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-mirror-"));
  try {
    const rel = "v-feishu-voice-runtime.mjs";
    const { mirror } = CORE_REPLACEMENTS[rel];
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", rel), "changed by V");
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ files: [{ path: `./${rel}`, sha256: sha("changed by V"), kind: "added" }] }));
    expect(() => adaptCore(root)).toThrow(/CORE_MIRROR_UNREVIEWED_BYTES/);
    // Already adapted: unchanged, and the manifest matches the installed bytes.
    fs.writeFileSync(path.join(root, "dist", rel), mirror);
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ files: [{ path: `./${rel}`, sha256: sha(mirror), kind: "added" }] }));
    expect(adaptCore(root)).toEqual([rel]);
    expect(mirror).not.toContain("npm/projects");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the Worker finds @openclaw/ai under the core package, as in V's layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-ai-"));
  try {
    expect(linkCoreAi(root)).toBe(false);
    fs.mkdirSync(path.join(root, "node_modules/@openclaw/ai/dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/@openclaw/ai/package.json"), "{}");
    fs.writeFileSync(path.join(root, "node_modules/@openclaw/ai/dist/index.mjs"), "export const x = 1;");
    fs.mkdirSync(path.join(root, "node_modules/openclaw/dist/plugin-sdk"), { recursive: true });
    expect(linkCoreAi(root)).toBe(true);
    expect(linkCoreAi(root)).toBe(true);
    // worker.mjs: new URL("../../node_modules/@openclaw/ai/dist/index.mjs", <core>/dist/plugin-sdk/agent-runtime.js)
    const nested = new URL("../../node_modules/@openclaw/ai/dist/index.mjs", `file://${root}/node_modules/openclaw/dist/plugin-sdk/agent-runtime.js`);
    expect(fs.realpathSync(nested)).toBe(fs.realpathSync(path.join(root, "node_modules/@openclaw/ai/dist/index.mjs")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
