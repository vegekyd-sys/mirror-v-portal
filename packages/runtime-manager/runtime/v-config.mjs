// OpenClaw config for a "v-release" template: V's patched 2026.9.1 runtime with
// its Worker pool, memory system and harnesses, minus V's channels, people and
// credentials. Channels stay at the Nexus edge; every secret is an env reference
// resolved from the process environment at boot, never written to a file.
import path from "node:path";

export const V_RELEASE_PROVIDER_KEYS = Object.freeze({
  deepseek: "NEXUS_MODEL_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
});

const deepseekModel = (id) => ({
  id, name: id, reasoning: true, input: ["text"],
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
 */
export function createVReleaseConfig(o) {
  const env = o.env ?? {};
  const has = (key) => typeof env[key] === "string" && env[key].length > 0;
  const workers = { minWorkers: 1, maxWorkers: 3, sessionsPerWorker: 3, ...(o.workers ?? {}) };
  const harnessModels = {
    "deepseek/deepseek-flash": { alias: "deepseek", agentRuntime: { id: "vlab-worker" }, params: { thinking: "high" } },
    "deepseek/deepseek-v4-pro": { alias: "ds-pro", agentRuntime: { id: "vlab-worker" } },
    ...(o.codexCommand ? { "deepseek/vds-deepseek-flash": { alias: "vds", agentRuntime: { id: "codex" }, params: { thinking: "high", codexAppServerRuntimeModel: "deepseek-flash" } } } : {}),
    ...(has("XAI_API_KEY") ? { "xai/grok-4.7": { alias: "Grok", agentRuntime: { id: "vlab-worker" } } } : {}),
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
  return {
    gateway: { mode: "local", bind: "loopback", port: 18790, auth: { mode: "token", token: "${NEXUS_GATEWAY_TOKEN}" }, http: { endpoints: { responses: { enabled: true } } } },
    models: { mode: "merge", providers },
    agents: {
      defaults: {
        workspace: o.workspace,
        model: { primary: "deepseek/deepseek-flash", ...(has("XAI_API_KEY") ? { fallbacks: ["xai/grok-4.7"] } : {}) },
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
      // replaced by nexus_schedule because a sleeping sandbox runs no timers.
      deny: ["gateway", "cron"],
      sessions: { visibility: "all" },
      web: { search: pluginIds.includes("parallel") ? { enabled: true, provider: "parallel-free" } : { enabled: true } },
      elevated: { enabled: false },
    },
    plugins: {
      enabled: true,
      allow: ["nexus-scheduler", "vlab-agent-worker-isolation", "memory-core", "deepseek", ...(has("XAI_API_KEY") ? ["xai"] : []), ...(o.codexCommand ? ["codex"] : []), "browser", "document-extract", "web-readability", "file-transfer", ...pluginIds],
      load: { paths: [o.schedulerPath, o.workerPluginPath, ...(o.pluginPaths ?? [])] },
      entries: {
        "nexus-scheduler": { enabled: true },
        "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
        deepseek: { enabled: true },
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
}
