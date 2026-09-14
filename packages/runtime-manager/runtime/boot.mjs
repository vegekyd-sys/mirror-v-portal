import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const base = "/vercel/sandbox/nexus";
const data = "/vercel/sandbox/agent-data";
const state = `${data}/state`;
const workspace = `${data}/workspace`;
const token = process.env.NEXUS_GATEWAY_TOKEN;
if (!token || !process.env.NEXUS_MODEL_KEY)
  throw new Error("Missing ephemeral runtime credentials");
fs.mkdirSync(state, { recursive: true });
if (!fs.existsSync(`${data}/seeded`)) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(`${base}/payload`, workspace, { recursive: true });
  fs.writeFileSync(`${data}/seeded`, "dealclaw-2026-09-14");
}
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: `${data}/openclaw.json`,
  OPENCLAW_WORKSPACE_DIR: workspace,
  OPENCLAW_SKIP_CHANNELS: "1",
};
// No credentials in the filesystem snapshot. Values resolve from process env.
const cfg = {
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
        baseUrl: process.env.NEXUS_MODEL_BASE_URL,
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
      model: { primary: `nexus/${process.env.NEXUS_MODEL_ID}` },
      timeoutSeconds: 600,
      maxConcurrent: 1,
      heartbeat: { every: "0m" },
      memorySearch: { enabled: false },
      compaction: { mode: "safeguard" },
    },
    list: [{ id: "dealclaw", default: true, workspace }],
  },
  tools: {
    profile: "coding",
    deny: ["cron", "gateway", "sessions_spawn", "sessions_send"],
    elevated: { enabled: false },
  },
  plugins: { enabled: false },
};
fs.writeFileSync(`${data}/openclaw.json`, JSON.stringify(cfg));
// A repeated ensure call must reuse the healthy process within this VM boot.
try {
  const r = await fetch("http://127.0.0.1:18790/healthz", {
    signal: AbortSignal.timeout(1000),
  });
  if (r.ok) {
    console.log("NEXUS_RUNTIME_READY");
    process.exit(0);
  }
} catch {}
const log = fs.openSync("/tmp/nexus-gateway.log", "a");
const child = spawn(
  "node",
  [
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
child.unref();
fs.writeFileSync("/tmp/nexus-gateway.pid", String(child.pid));
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch("http://127.0.0.1:18790/healthz", {
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) {
      // Record the runtime's baseline process tree. Quiesce blocks on later background processes.
      fs.writeFileSync(
        "/tmp/nexus-baseline-pids",
        execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }),
      );
      console.log("NEXUS_RUNTIME_READY");
      process.exit(0);
    }
  } catch {}
}
console.error(fs.readFileSync("/tmp/nexus-gateway.log", "utf8").slice(-6000));
process.exit(1);
