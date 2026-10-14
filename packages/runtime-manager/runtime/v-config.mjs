// OpenClaw config for a "v-release" template: V's patched 2026.9.1 runtime with
// its Worker pool, memory system and harnesses, minus V's channels, people and
// credentials. Channels stay at the Nexus edge; every secret is an env reference
// resolved from the process environment at boot, never written to a file.
import path from "node:path";
import { sandboxExecPolicy } from "./sandbox-exec.mjs";

export const V_RELEASE_PROVIDER_KEYS = Object.freeze({
  deepseek: "NEXUS_MODEL_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
});

// As on V: deepseek-flash (and its Codex alias) accept images, which also keeps
// the computer tool (screenshots) in the agent's tool list; v4-pro is text only.
const deepseekModel = (id) => ({
  id, name: id, reasoning: true, input: id === "deepseek-v4-pro" ? ["text"] : ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000, maxTokens: 384000, api: "openai-completions",
  compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
});

/**
 * @param {object} o
 * @param {string} o.agentId
 * @param {string} o.workspace
 * @param {string} o.dataDir           persistent agent-data root
 * @param {string} o.schedulerPath     nexus-scheduler plugin dir
 * @param {string} o.workerPluginPath  vlab-agent-worker-isolation plugin dir
 * @param {string[]} [o.pluginPaths]   further plugin dirs baked into the snapshot
 * @param {string[]} [o.pluginIds]     ids of those plugins
 * @param {Record<string,string>} [o.env] process env, only used to decide which optional providers exist
 * @param {object} [o.workers]
 * @param {string} [o.codexCommand]    codex binary for the codex harness, when installed
 * @param {boolean} [o.memoryEmbeddings]
 * @param {object} [o.extra]          featureConfig() output: desktop, browser, plugins, tools
 * @param {string[]} [o.ownerIds]     commands.ownerAllowFrom; the plugins resolve the single owner from it
 */
export function createVReleaseConfig(o) {
  const env = o.env ?? {};
  const has = (key) => typeof env[key] === "string" && env[key].length > 0;
  const workers = { minWorkers: 1, maxWorkers: 3, sessionsPerWorker: 3, ...(o.workers ?? {}) };
  const harnessModels = {
    "deepseek/deepseek-flash": { alias: "deepseek", agentRuntime: { id: "vlab-worker" }, params: { thinking: "high" } },
    "deepseek/deepseek-v4-pro": { alias: "ds-pro", agentRuntime: { id: "vlab-worker" } },
    ...(o.codexCommand ? { "deepseek/vds-deepseek-flash": { alias: "vds", agentRuntime: { id: "codex" }, params: { thinking: "high", codexAppServerRuntimeModel: "deepseek-flash" } } } : {}),
    // Grok is not offered as a chat model: through 2026.9.1's /v1/responses its
    // reasoning text streams as visible output (seen 2026-10-08). xAI stays for images.
  };
  const providers = {
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1", apiKey: "${NEXUS_MODEL_KEY}", api: "openai-completions", timeoutSeconds: 300,
      models: ["deepseek-flash", "deepseek-v4-pro", ...(o.codexCommand ? ["vds-deepseek-flash"] : [])].map(deepseekModel),
    },
    ...(has("XAI_API_KEY") ? { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "${XAI_API_KEY}", api: "openai-responses", models: [
      { id: "grok-4.7", name: "grok-4.7", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 500000, maxTokens: 64000 },
    ] } } : {}),
  };
  const pluginIds = o.pluginIds ?? [];
  const embeddings = o.memoryEmbeddings !== false && has("GOOGLE_API_KEY");
  const extra = o.extra ?? { plugins: { allow: [], loadPaths: [], entries: {} }, tools: { alsoAllow: [] } };
  const cfg = {
    // reload off: a config change must never hot-reload a Gateway that owns a Worker pool
    // (V 2026-09-20: a hot reload closed the pool for good); boot restarts it instead.
    gateway: { mode: "local", bind: "loopback", port: 18790, reload: { mode: "off" }, auth: { mode: "token", token: "${NEXUS_GATEWAY_TOKEN}" }, http: { endpoints: { responses: { enabled: true } } } },
    models: { mode: "merge", providers },
    agents: {
      defaults: {
        workspace: o.workspace,
        model: { primary: "deepseek/deepseek-flash" },
        models: harnessModels,
        modelPolicy: { allow: Object.keys(harnessModels) },
        ...(has("XAI_API_KEY") ? { imageModel: { primary: "xai/grok-4.7" } } : {}),
        thinkingDefault: "off",
        timeoutSeconds: 600,
        maxConcurrent: 4,
        heartbeat: { every: "0m" },
        contextPruning: { mode: "cache-ttl", ttl: "1m" },
        compaction: { mode: "safeguard", keepRecentTokens: 8000, recentTurnsPreserve: 3, midTurnPrecheck: { enabled: true }, timeoutSeconds: 360, model: "deepseek/deepseek-flash" },
        subagents: { maxConcurrent: 4, runTimeoutSeconds: 21600 },
      },
      list: [{ id: o.agentId, default: true, workspace: o.workspace }],
    },
    memory: {
      search: embeddings
        ? { provider: "gemini", model: "gemini-embedding-2-preview", outputDimensionality: 3072, fallback: "none", sources: ["memory"], remote: { apiKey: "${GOOGLE_API_KEY}" }, store: { fts: { tokenizer: "trigram" } } }
        : { provider: "none", fallback: "none", sources: ["memory"], store: { fts: { tokenizer: "trigram" } } },
    },
    session: { dmScope: "per-channel-peer", maintenance: { mode: "enforce", pruneAfter: "30d", maxEntries: 2000, maxDiskBytes: "8gb" }, reset: { mode: "idle", idleMinutes: 43200 } },
    tools: {
      profile: "full",
      alsoAllow: ["nexus_schedule"],
      // Config writes restart the Gateway and would kill the Worker pool; cron is
      // replaced by nexus_schedule because a sleeping sandbox runs no timers;
      // ask_user waits for a UI answer the channel edge cannot give (the turn hangs).
      // sessions_yield ends the turn and lets the Gateway wake the session later; that
      // wake has no channel to answer on behind the Portal, so subagent results would be
      // lost. Without it the agent waits for its subagents inside the same turn.
      deny: ["gateway", "cron", "ask_user", "sessions_yield"],
      sessions: { visibility: "all" },
      exec: sandboxExecPolicy(o.dataDir),
      web: { search: pluginIds.includes("parallel") ? { enabled: true, provider: "parallel-free" } : { enabled: true } },
      elevated: { enabled: false },
    },
    plugins: {
      enabled: true,
      // google serves the gemini memory embeddings; without it memory_search silently falls back to keywords.
      allow: ["nexus-scheduler", "vlab-agent-worker-isolation", "memory-core", "deepseek", ...(embeddings ? ["google"] : []), ...(has("XAI_API_KEY") ? ["xai"] : []), ...(o.codexCommand ? ["codex"] : []), "browser", "document-extract", "web-readability", "file-transfer", ...pluginIds],
      load: { paths: [o.schedulerPath, o.workerPluginPath, ...(o.pluginPaths ?? [])] },
      entries: {
        "nexus-scheduler": { enabled: true },
        "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
        deepseek: { enabled: true },
        ...(embeddings ? { google: { enabled: true } } : {}),
        ...(has("XAI_API_KEY") ? { xai: { enabled: true } } : {}),
        ...(o.codexCommand ? { codex: { enabled: true, config: { codexPlugins: { enabled: false }, codexDynamicToolsLoading: "searchable", appServer: { mode: "yolo", approvalPolicy: "never", sandbox: "danger-full-access", command: o.codexCommand } } } } : {}),
        ...Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
        "vlab-agent-worker-isolation": {
          enabled: true,
          config: {
            ...workers,
            idleTimeoutMs: 180000,
            requestTimeoutMs: 600000,
            requestStallTimeoutMs: 120000,
            gatewayOwnedToolTimeoutMs: 310000,
            fastCompactionModel: "deepseek/deepseek-flash",
            workerConfigPath: path.join(o.dataDir, "worker-openclaw.json"),
            gatewayConfigPath: path.join(o.dataDir, "openclaw.json"),
            nativeRequestTimeoutMs: 21600000,
          },
        },
      },
    },
  };
  if (extra.browser) cfg.browser = extra.browser;
  if (extra.desktop) cfg.desktop = extra.desktop;
  cfg.plugins.allow.push(...extra.plugins.allow.filter((id) => !cfg.plugins.allow.includes(id)));
  cfg.plugins.load.paths.push(...extra.plugins.loadPaths);
  Object.assign(cfg.plugins.entries, extra.plugins.entries);
  cfg.tools.alsoAllow.push(...extra.tools.alsoAllow);
  if (o.ownerIds?.length) cfg.commands = { ownerAllowFrom: [...o.ownerIds] };
  return cfg;
}
