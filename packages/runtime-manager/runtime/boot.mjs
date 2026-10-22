import { installProgress } from "./progress-patch.mjs";
import { installStreamPreview } from "./stream-preview-patch.mjs";
import fs from "node:fs";
import { readAgentKitProfile, seedWorkspace, createOpenClawConfig, assertAgentKitNode, agentKitFingerprint } from "./agent-config.mjs";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readVRelease, applyCodexCapture, ensureCodexHome, V_RELEASE_ROOT } from "./v-release.mjs";
import { createVReleaseConfig } from "./v-config.mjs";
import { sandboxExecPolicy, sandboxExecEnv, ensureSandboxExecApprovals } from "./sandbox-exec.mjs";
import { writePortalEnvironment } from "./portal-environment.mjs";
import { availableFeatures, featureConfig, desktopEnv, OWNER_CHANNELS, startDesktop, startHandoff, startBroker, startVoice, startCuaNode, startNodeApprover } from "./v-features.mjs";

const bootStart = Date.now();
// A woken sandbox reads its disk lazily, block by block, and Node loads modules one after
// another, so every cold file costs a round trip. Read the runtime's hot files with high
// concurrency first: the Gateway and Workers then load from memory (v-release only).
if (fs.existsSync("/vercel/sandbox/nexus/v-release.json")) {
  const hot = [
    "/usr/local/bin/node", "/vercel/sandbox/nexus/compile-cache",
    "/vercel/sandbox/nexus/runtime/node_modules/openclaw/dist", "/vercel/sandbox/nexus/runtime/node_modules/@openclaw",
    "/vercel/sandbox/nexus/v/worker", "/vercel/sandbox/agent-data/state/cache",
    // The Gateway and every Worker open these databases on their first turn.
    "/vercel/sandbox/agent-data/state/state/openclaw.sqlite",
    ...(fs.existsSync("/vercel/sandbox/agent-data/state/agents") ? fs.readdirSync("/vercel/sandbox/agent-data/state/agents").map((id) => `/vercel/sandbox/agent-data/state/agents/${id}/agent/openclaw-agent.sqlite`) : []),
  ].filter((p) => fs.existsSync(p)).join(" ");
  spawn("sh", ["-c", `find ${hot} -type f -print0 2>/dev/null | xargs -0 -P 32 -n 16 cat >/dev/null 2>&1`], { detached: true, stdio: "ignore" }).unref();
}
// Milliseconds since boot start at each phase, reported with NEXUS_RUNTIME_READY (cold-start budget).
const bootPhases = {};
const mark = (name) => { bootPhases[name] = Date.now() - bootStart; };
// /tmp survives sleep but processes do not. After a resume, PID files from the
// previous life name PIDs the new boot reuses (boot order is deterministic), so a
// daemon would look alive and never start, and quiesce would signal a stranger.
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
if ((fs.existsSync("/tmp/nexus-boot-id") ? fs.readFileSync("/tmp/nexus-boot-id", "utf8") : "") !== bootId) {
  for (const name of fs.readdirSync("/tmp")) if (/^nexus-.+\.pid$/.test(name)) fs.rmSync(`/tmp/${name}`, { force: true });
  fs.writeFileSync("/tmp/nexus-boot-id", bootId);
}
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
mark("prelude");
initVReleaseWorkspace();
mark("workspace");
const toolsBin = `${base}/tools/bin`;
const execEnv = sandboxExecEnv(data, [profile?.runtime.mediaBinaries || vRelease ? `${base}/runtime/bin` : undefined, fs.existsSync(toolsBin) ? toolsBin : undefined, process.env.PATH ?? ""].filter(Boolean).join(":"));
const env = {
  ...process.env,
  // Template CLIs installed by the snapshot builder (e.g. xingqing-cli).
  ...execEnv,
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
// Desktop, V Browser and voice: present when the snapshot carries their packages.
const features = vRelease ? availableFeatures() : { desktop: false, vbrowser: false, voice: false };
let publicUrls = {};
try { publicUrls = JSON.parse(process.env.NEXUS_PUBLIC_URLS || "{}"); } catch {}
// Owner links the agent may hand out (the voice call page through the Portal).
if (vRelease) fs.writeFileSync(`${data}/links.json`, JSON.stringify({ ...JSON.parse(process.env.NEXUS_OPEN_LINKS || "{}"), public: publicUrls }, null, 1) + "\n");
if (features.desktop) Object.assign(env, desktopEnv(data));
if (features.vbrowser) Object.assign(env, { OPENCLAW_EXTENSION_COMMAND_TIMEOUT_MS: "180000", OPENCLAW_PERSISTENT_CDP_CONNECT_TIMEOUT_MS: "60000" });
// No credentials in the filesystem snapshot. Values resolve from process env.
installProgress(`${base}/runtime/node_modules/openclaw`);
mark("progressPatch");
// DeepSeek reasoning turns hold all visible text until the message ends; stream a provisional preview.
if (vRelease) installStreamPreview({ openclawRoot: `${base}/runtime/node_modules/openclaw`, workerDist: `${V_RELEASE_ROOT}/worker/dist` });
mark("streamPreviewPatch");
const pluginDir = base + "/scheduler-plugin";
fs.mkdirSync(pluginDir, { recursive: true });
fs.copyFileSync(base + "/scheduler-plugin.mjs", pluginDir + "/index.mjs");
fs.writeFileSync(
  pluginDir + "/openclaw.plugin.json",
  JSON.stringify({
    id: "nexus-scheduler",
    name: "Portal runtime",
    version: "1.0.0",
    contracts: { tools: ["portal_schedule", "portal_environment", "nexus_schedule"] },
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
const cfg = vRelease ? createVReleaseConfig({
  agentId, workspace, dataDir: data, schedulerPath: pluginDir, env: process.env,
  workerPluginPath: `${V_RELEASE_ROOT}/worker/dist`, workers: vRelease.workers,
  pluginPaths: (vRelease.plugins ?? []).filter((plugin) => plugin.path).map((plugin) => `${base}/${plugin.path}`), pluginIds: (vRelease.plugins ?? []).map((plugin) => plugin.id),
  codexCommand: vRelease.codexCommand ? `${base}/${vRelease.codexCommand}` : undefined,
  extra: featureConfig({ features, data, publicUrls }),
  ownerIds: OWNER_CHANNELS.map((channel) => `${channel}:owner`),
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
            name: "Portal Agent",
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
    alsoAllow: ["portal_schedule", "portal_environment"],
    deny: ["cron", "gateway", "sessions_spawn", "sessions_send"],
    elevated: { enabled: false },
    exec: sandboxExecPolicy(data),
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
writePortalEnvironment({ workspace, data, config: cfg });
fs.rmSync(`${base}/turn-instructions.mjs`, { force: true });
// Patch revisions count as configuration: a running Gateway restarts once to load new patch code.
const RUNTIME_PATCHES = vRelease ? "progress-v4+reasoning-preview-v1" : "";
const configHash = createHash("sha256").update(JSON.stringify(cfg) + JSON.stringify(execEnv) + RUNTIME_PATCHES).digest("hex");
fs.writeFileSync(`${data}/openclaw.json`, JSON.stringify(cfg));
if (vRelease) {
  ensureCodexHome(state, agentId);
  applyCodexCapture(state);
  mark("codexCapture");
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
  // The indexer refuses a full reindex at startup, so `memory index` must finish first.
  // Both run in the background: the first turn does not wait for the index (≈5 s cold).
  // Wait out the first turn too: on a just-woken disk every reader slows the Worker down.
  const indexer = spawn("nice", ["-n", "10", "sh", "-c", `sleep 15; node ${base}/runtime/node_modules/openclaw/openclaw.mjs memory index --agent "$1" >/dev/null 2>&1; exec node ${V_RELEASE_ROOT}/v-memory-indexer.mjs "$1"`, "sh", agentId], {
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
      !fs.existsSync("/tmp/nexus-runtime-config-hash") || fs.readFileSync("/tmp/nexus-runtime-config-hash", "utf8") !== configHash;
    // ensure runs at a turn boundary. Reloading config alone would leave the
    // Gateway/Worker process env pointing at the old npm prefix and policy.
    if (changed) throw new Error("RUNTIME_RESTART");
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
  if (error?.message === "RUNTIME_RESTART") {
    for (const file of ["/tmp/nexus-memory-indexer.pid", "/tmp/nexus-voice.pid", "/tmp/nexus-vbrowser-broker.pid", "/tmp/nexus-cua-node.pid", "/tmp/nexus-desktop-handoff.pid", "/tmp/nexus-gateway.pid", "/tmp/nexus-model-proxy.pid"]) {
      try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGTERM"); } catch {}
    }
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { await fetch("http://127.0.0.1:18790/healthz", { signal: AbortSignal.timeout(500) }); } catch { break; }
    }
  }
}
// The policy lives in the state dir and survives sleep: set it once, not on every boot
// (each check is a full CLI cold start, ≈3 s on a just-woken disk).
const execApprovalsMarker = `${state}/.nexus-exec-approvals-v1`;
if (!fs.existsSync(execApprovalsMarker)) {
  ensureSandboxExecApprovals(`${base}/runtime/node_modules/openclaw/openclaw.mjs`, env);
  fs.writeFileSync(execApprovalsMarker, new Date().toISOString());
}
mark("execApprovals");
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
fs.writeFileSync("/tmp/nexus-public-ports.json", process.env.NEXUS_PUBLIC_PORTS || "{}");
fs.writeFileSync("/tmp/nexus-runtime-config-hash", configHash);
const alive = (name) => { try { process.kill(Number(fs.readFileSync(`/tmp/nexus-${name}.pid`, "utf8")), 0); return true; } catch { return false; } };
// The Gateway does not need X to start, only browser/computer tools do: bring the
// desktop up alongside it (≈4 s) and confirm it before reporting ready.
let desktopReady = Promise.resolve();
if (features.desktop) {
  if (!alive("desktop")) desktopReady = startDesktop({ data, env });
  if (!alive("desktop-handoff")) startHandoff({ data, env, publicUrl: publicUrls.desktop });
}
mark("desktop");
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
      mark("gatewayHealthy");
      if (!vRelease) indexMemory();
      mark("memoryIndex");
      startMemoryIndexer();
      // Feature daemons that connect to the Gateway start once it is serving.
      const featureState = {};
      if (features.vbrowser && !alive("vbrowser-broker")) startBroker({ data, env, base, publicUrl: publicUrls.vbrowser });
      if (features.voice && !alive("voice") && process.env.NEXUS_VOICE_ACCESS_TOKEN)
        startVoice({ data, env, base, agentId, publicUrl: publicUrls.voice, accessToken: process.env.NEXUS_VOICE_ACCESS_TOKEN });
      if (features.desktop) {
        if (!alive("cua-node")) startCuaNode({ data, env, base });
        if (!alive("node-approver")) startNodeApprover({ env, base });
      }
      await desktopReady;
      mark("daemons");
      try { fs.writeFileSync("/tmp/nexus-boot-phases.json", JSON.stringify({ at: new Date().toISOString(), ...bootPhases })); } catch {}
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
          bootPhases: { ...bootPhases, ready: Date.now() - bootStart },
          ...(vRelease ? { vRelease: vRelease.release, convergeRestarts, features, ...featureState } : {}),
          bootScriptMs: Date.now() - bootStart,
        }),
      );
      process.exit(0);
    }
  } catch {}
}
console.error(fs.readFileSync("/tmp/nexus-gateway.log", "utf8").slice(-6000));
process.exit(1);
