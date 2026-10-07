import { installProgress } from "./progress-patch.mjs";
import fs from "node:fs";
import { readAgentKitProfile, seedWorkspace, createOpenClawConfig, assertAgentKitNode, agentKitFingerprint } from "./agent-config.mjs";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readVRelease, applyCodexCapture, ensureCodexHome, V_RELEASE_ROOT } from "./v-release.mjs";
import { createVReleaseConfig } from "./v-config.mjs";

const bootStart = Date.now();
const agentId = process.env.NEXUS_AGENT_ID || "dealclaw";
// Templates whose payload ships Markdown memory (MEMORY.md + memory/**) to index and search.
const profile = readAgentKitProfile("/vercel/sandbox/nexus/agent-kit-runtime.json", agentId, process.env.NEXUS_TEMPLATE_VERSION);
if (!profile && (process.env.NEXUS_EXPECT_AGENT_KIT === "1" || agentId === "makaron" ||
  (fs.existsSync("/vercel/sandbox/nexus/payload/payload-manifest.json") &&
    JSON.parse(fs.readFileSync("/vercel/sandbox/nexus/payload/payload-manifest.json", "utf8")).layout === "agent-kit-v1"))) throw Error("AGENT_KIT_PROFILE_MISSING");
if (profile) {
  assertAgentKitNode();
  for (const key of profile.runtime.envKeys) if (!process.env[key]) throw Error(`RUNTIME_ENV_KEY_MISSING:${key}`);
}
// A v-release snapshot runs V's patched build (Worker pool, memory system, harnesses).
const vRelease = readVRelease();
if (vRelease && profile) throw Error("V_RELEASE_AGENT_KIT_UNSUPPORTED");
if (vRelease && !/api\.deepseek\.com/.test(process.env.NEXUS_MODEL_BASE_URL ?? "")) throw Error("V_RELEASE_REQUIRES_DEEPSEEK_MODEL");
const memoryAgent = !!vRelease || ["mirror-v", "xingqing"].includes(agentId);
const fingerprint = createHash("sha256")
  .update(
    [
      process.env.NEXUS_MODEL_ID,
      process.env.NEXUS_MODEL_BASE_URL,
      process.env.NEXUS_MODEL_KEY,
      process.env.NEXUS_OPTIMIZE,
      // Preserve the existing DealClaw fingerprint for already-running VMs.
      ...(agentId === "dealclaw" ? [] : [agentId]),
      "runtime-v4-scheduler",
      ...(vRelease ? [`v-release:${vRelease.release}`] : []),
      ...agentKitFingerprint(profile),
    ].join("\0"),
  )
  .digest("hex");
const base = "/vercel/sandbox/nexus";
const data = "/vercel/sandbox/agent-data";
const state = `${data}/state`;
const workspace = `${data}/workspace`;
const token = process.env.NEXUS_GATEWAY_TOKEN;
if (!token || !process.env.NEXUS_MODEL_KEY)
  throw new Error("Missing ephemeral runtime credentials");
fs.mkdirSync(state, { recursive: true });
if (profile) seedWorkspace(`${base}/payload`, data, profile.runtime);
else if (!fs.existsSync(`${data}/seeded`)) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(`${base}/payload`, workspace, { recursive: true });
  fs.writeFileSync(`${data}/seeded`, agentId);
}
// First boot of a v-release workspace: the Librarian's queues start today, the
// archive lives outside the indexed tree, and the workspace is a git repo (the
// Librarian commits every batch).
function initVReleaseWorkspace() {
  if (!vRelease || fs.existsSync(`${workspace}/.git`)) return;
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  const librarian = `${workspace}/memory/librarian`;
  fs.mkdirSync(librarian, { recursive: true });
  const seedJson = (file, value) => { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 1) + "\n"); };
  seedJson(`${librarian}/daily-queue.json`, { since: today, backfill_days: [], done: {} });
  seedJson(`${librarian}/reflections-cursor.json`, { new_since: now.toISOString(), backlog: {}, done_ids: [] });
  for (const dir of ["archive", "proposals"]) {
    fs.mkdirSync(`${workspace}/memory-archive/${dir}`, { recursive: true });
    fs.writeFileSync(`${workspace}/memory-archive/${dir}/.gitkeep`, "");
    if (!fs.existsSync(`${workspace}/memory/${dir}`)) fs.symlinkSync(`../memory-archive/${dir}`, `${workspace}/memory/${dir}`);
  }
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Mirror V");
  git("config", "user.email", "mirror-v@localhost");
  git("config", "core.quotepath", "off");
  git("add", "-A");
  git("commit", "-qm", `seed: ${agentId} ${process.env.NEXUS_TEMPLATE_VERSION || "payload"} (${vRelease.release})`);
}
initVReleaseWorkspace();
const toolsBin = `${base}/tools/bin`;
const env = {
  ...process.env,
  // Template CLIs installed by the snapshot builder (e.g. xingqing-cli).
  PATH: [profile?.runtime.mediaBinaries ? `${base}/runtime/bin` : undefined, fs.existsSync(toolsBin) ? toolsBin : undefined, process.env.PATH ?? ""].filter(Boolean).join(":"),
  // A customer who binds by chat logs in through xingqing-cli, which caches only
  // a session token. Keep it in agent-data so backups carry it across sleeps.
  ...(agentId === "xingqing" ? { XINGQING_CONFIG_DIR: `${data}/xingqing` } : {}),
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: `${data}/openclaw.json`,
  OPENCLAW_WORKSPACE_DIR: workspace,
  OPENCLAW_SKIP_CHANNELS: "1",
  // The codex harness reads DeepSeek's key under its own name (codex-home config.toml).
  ...(vRelease ? { DEEPSEEK_API_KEY: process.env.NEXUS_MODEL_KEY } : {}),
  ...(process.env.NEXUS_OPTIMIZE === "1"
    ? {
        NODE_COMPILE_CACHE: `${base}/compile-cache`,
        OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
      }
    : {}),
};
// No credentials in the filesystem snapshot. Values resolve from process env.
installProgress(`${base}/runtime/node_modules/openclaw`);
const pluginDir = base + "/scheduler-plugin";
fs.mkdirSync(pluginDir, { recursive: true });
fs.copyFileSync(base + "/scheduler-plugin.mjs", pluginDir + "/index.mjs");
fs.writeFileSync(
  pluginDir + "/openclaw.plugin.json",
  JSON.stringify({
    id: "nexus-scheduler",
    name: "Nexus schedules",
    version: "1.0.0",
    contracts: { tools: ["nexus_schedule"] },
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
const cfg = vRelease ? createVReleaseConfig({
  agentId, workspace, dataDir: data, schedulerPath: pluginDir, env: process.env,
  workerPluginPath: `${V_RELEASE_ROOT}/worker/dist`, workers: vRelease.workers,
  pluginPaths: (vRelease.plugins ?? []).filter((plugin) => plugin.path).map((plugin) => `${base}/${plugin.path}`), pluginIds: (vRelease.plugins ?? []).map((plugin) => plugin.id),
  codexCommand: vRelease.codexCommand ? `${base}/${vRelease.codexCommand}` : undefined,
}) : profile ? createOpenClawConfig({
  runtime: profile.runtime, workspace, payloadRoot: `${base}/payload`, schedulerPath: pluginDir, modelId: process.env.NEXUS_MODEL_ID,
}) : {
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 18790,
    auth: { mode: "token", token: "${NEXUS_GATEWAY_TOKEN}" },
    http: { endpoints: { responses: { enabled: true } } },
  },
  models: {
    mode: "merge",
    providers: {
      nexus: {
        baseUrl: "http://127.0.0.1:18791/v1",
        api: "openai-completions",
        apiKey: "${NEXUS_MODEL_KEY}",
        models: [
          {
            id: process.env.NEXUS_MODEL_ID,
            name: "Nexus Trial",
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      workspace,
      thinkingDefault: "off",
      model: { primary: `nexus/${process.env.NEXUS_MODEL_ID}` },
      timeoutSeconds: 600,
      maxConcurrent: 1,
      heartbeat: { every: "0m" },
      // Mirror V inherits V001's Markdown memory; 星擎 ships its knowledge base
      // as base memory. The isolated sandbox has no embedding credential, so
      // index with OpenClaw's built-in FTS mode.
      memorySearch: memoryAgent
        ? { provider: "none", fallback: "none" }
        : { enabled: false },
      compaction: { mode: "safeguard" },
    },
    list: [{ id: agentId, default: true, workspace }],
  },
  // Customers should not see "Source: memory/…#L" footers from memory search.
  ...(agentId === "xingqing" ? { memory: { citations: "off" } } : {}),
  tools: {
    profile: "coding",
    alsoAllow: ["nexus_schedule"],
    deny: ["cron", "gateway", "sessions_spawn", "sessions_send"],
    elevated: { enabled: false },
  },
  plugins: {
    enabled: true,
    allow: memoryAgent ? ["nexus-scheduler", "memory-core"] : ["nexus-scheduler"],
    slots: memoryAgent ? { memory: "memory-core" } : undefined,
    load: { paths: [pluginDir] },
    entries: {
      "nexus-scheduler": { enabled: true },
      ...(memoryAgent ? { "memory-core": { enabled: true, config: { dreaming: { enabled: false } } } } : {}),
    },
  },
};
const configHash = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
fs.writeFileSync(`${data}/openclaw.json`, JSON.stringify(cfg));
if (vRelease) {
  ensureCodexHome(state, agentId);
  applyCodexCapture(state);
}
function indexMemory() {
  if (!memoryAgent) return;
  try {
    execFileSync("node", [
      `${base}/runtime/node_modules/openclaw/openclaw.mjs`,
      "memory", "index", "--agent", agentId,
    ], { env, timeout: 90_000, stdio: "pipe" });
  } catch {
    // A v-release keeps indexing in its own daemon; a slow first embedding pass must not fail the turn.
    if (vRelease) return;
    throw new Error(agentId === "mirror-v" ? "MIRROR_V_MEMORY_INDEX_FAILED" : "MEMORY_INDEX_FAILED");
  }
}
// V's real-time memory indexer: watches memory/ and syncs outside the Gateway event loop.
function startMemoryIndexer() {
  if (!vRelease || !fs.existsSync(`${V_RELEASE_ROOT}/v-memory-indexer.mjs`)) return;
  const indexer = spawn("node", [`${V_RELEASE_ROOT}/v-memory-indexer.mjs`, agentId], {
    // One owner, a small memory: index 5 s after the last write instead of V's 15 s.
    env: { ...env, OPENCLAW_DIST: `${base}/runtime/node_modules/openclaw/dist`, QUIET_SECONDS: "5" },
    detached: true, stdio: ["ignore", fs.openSync("/tmp/nexus-memory-indexer.log", "a"), fs.openSync("/tmp/nexus-memory-indexer.log", "a")],
  });
  indexer.unref();
  fs.writeFileSync("/tmp/nexus-memory-indexer.pid", String(indexer.pid));
}
// A repeated ensure call must reuse the healthy process within this VM boot.
try {
  const r = await fetch("http://127.0.0.1:18790/healthz", {
    signal: AbortSignal.timeout(1000),
  });
  if (r.ok) {
    const changed =
      !fs.existsSync("/tmp/nexus-runtime-fingerprint") ||
      fs.readFileSync("/tmp/nexus-runtime-fingerprint", "utf8") !== fingerprint ||
      (vRelease && (!fs.existsSync("/tmp/nexus-runtime-config-hash") || fs.readFileSync("/tmp/nexus-runtime-config-hash", "utf8") !== configHash));
    // A v-release restarts its own Gateway (and with it the Worker pool) on a
    // runtime or config change; reload is off, so nothing changed underneath it.
    if (changed && vRelease) throw new Error("V_RELEASE_RESTART");
    if (changed)
      throw new Error("RUNTIME_CONFIGURATION_CHANGED_RESTART_REQUIRED");
    console.log(
      JSON.stringify({
        marker: "NEXUS_RUNTIME_READY",
        processReused: true,
        openclawBootMs: 0,
        bootScriptMs: Date.now() - bootStart,
      }),
    );
    process.exit(0);
  }
} catch (error) {
  if (error?.message === "RUNTIME_CONFIGURATION_CHANGED_RESTART_REQUIRED")
    throw error;
  if (error?.message === "V_RELEASE_RESTART") {
    for (const file of ["/tmp/nexus-memory-indexer.pid", "/tmp/nexus-gateway.pid"]) {
      try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGTERM"); } catch {}
    }
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { await fetch("http://127.0.0.1:18790/healthz", { signal: AbortSignal.timeout(500) }); } catch { break; }
    }
  }
}
const log = fs.openSync("/tmp/nexus-gateway.log", "a");
// V's runtime calls DeepSeek directly with V's own thinking settings.
if (!vRelease) {
  const proxy = spawn("node", [`${base}/model-proxy.mjs`], {
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  proxy.unref();
  fs.writeFileSync("/tmp/nexus-model-proxy.pid", String(proxy.pid));
}
fs.writeFileSync("/tmp/nexus-runtime-fingerprint", fingerprint);
fs.writeFileSync("/tmp/nexus-runtime-config-hash", configHash);
const gatewayStart = Date.now();
const startGateway = () => spawn(
  "node",
  [
    ...(process.env.NEXUS_CPU_PROFILE === "1"
      ? ["--cpu-prof", "--cpu-prof-dir=/tmp"]
      : []),
    `${base}/runtime/node_modules/openclaw/openclaw.mjs`,
    "gateway",
    "run",
    "--port",
    "18790",
    "--bind",
    "loopback",
    "--allow-unconfigured",
  ],
  { env, detached: true, stdio: ["ignore", log, log] },
);
let child = startGateway();
let exited = false;
child.on("exit", () => { exited = true; });
child.unref();
fs.writeFileSync("/tmp/nexus-gateway.pid", String(child.pid));
let convergeRestarts = 0;
for (let i = 0; i < 360; i++) {
  // 2026.9.1 installs missing external plugins (deepseek, codex) on first start,
  // then exits asking for a restart so state migrations see the final inventory.
  if (exited && vRelease && convergeRestarts < 2 && /Restart OpenClaw so state migrations run/.test(fs.readFileSync("/tmp/nexus-gateway.log", "utf8").slice(-20000))) {
    convergeRestarts++;
    applyCodexCapture(state);
    exited = false;
    child = startGateway();
    child.on("exit", () => { exited = true; });
    child.unref();
    fs.writeFileSync("/tmp/nexus-gateway.pid", String(child.pid));
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch("http://127.0.0.1:18790/healthz", {
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) {
      indexMemory();
      startMemoryIndexer();
      // Record the runtime's baseline process tree. Quiesce blocks on later background processes.
      fs.writeFileSync(
        "/tmp/nexus-baseline-pids",
        execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }),
      );
      console.log(
        JSON.stringify({
          marker: "NEXUS_RUNTIME_READY",
          processReused: false,
          openclawBootMs: Date.now() - gatewayStart,
          ...(vRelease ? { vRelease: vRelease.release, convergeRestarts } : {}),
          bootScriptMs: Date.now() - bootStart,
        }),
      );
      process.exit(0);
    }
  } catch {}
}
console.error(fs.readFileSync("/tmp/nexus-gateway.log", "utf8").slice(-6000));
process.exit(1);
