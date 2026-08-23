import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/state';
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
const timezone = process.env.DEALCLAW_TIMEZONE || 'Asia/Shanghai';
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18790);

function fail(msg) {
  console.error(`[dealclaw-runtime] ${msg}`);
  process.exit(1);
}

// ── LLM providers (admin-console managed, injected via envFrom) ──────
// LLM_PROVIDERS is a JSON doc: { providers: [{name, baseUrl, apiKey,
// models: [{id, reasoning?}]}], defaultModel: '<name>/<modelId>' }.
// Provider API keys are materialised as shell exports in
// <stateDir>/llm-env.sh, which entrypoint.sh sources before starting the
// gateway — the OpenClaw config references them by env id (never inline).
const llmEnvPath = path.join(stateDir, 'llm-env.sh');
fs.mkdirSync(stateDir, { recursive: true });
let llmDoc = null;
const llmRaw = (process.env.LLM_PROVIDERS || '').trim();
if (llmRaw) {
  try {
    llmDoc = JSON.parse(llmRaw);
  } catch {
    fail('LLM_PROVIDERS is not valid JSON — refusing to start with a broken model config');
  }
  if (!llmDoc || !Array.isArray(llmDoc.providers)) {
    fail('LLM_PROVIDERS must contain a "providers" array');
  }
}

function defaultModelSpec(id, reasoning) {
  return {
    id,
    name: id,
    ...(reasoning ? { reasoning: true } : {}),
    input: ['text'],
    contextWindow: 131_072,
    maxTokens: reasoning ? 65_536 : 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsUsageInStreaming: true, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
  };
}

const deepseekModels = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    input: ['text'],
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
    compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    reasoning: true,
    input: ['text'],
    contextWindow: 131_072,
    maxTokens: 65_536,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
    compat: { supportsUsageInStreaming: true, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
  },
];

const providers = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
    apiKey: { source: 'env', provider: 'default', id: 'DEEPSEEK_API_KEY' },
    models: deepseekModels,
  },
};
let primaryModel = process.env.DEALCLAW_MODEL || 'deepseek/deepseek-chat';

if (llmDoc && llmDoc.providers.length > 0) {
  const exportLines = [];
  const nextProviders = {};
  for (const p of llmDoc.providers) {
    if (!p || typeof p.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(p.name)) {
      fail(`LLM_PROVIDERS: invalid provider name ${JSON.stringify(p?.name)}`);
    }
    if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs an http(s) baseUrl`);
    }
    if (typeof p.apiKey !== 'string' || !p.apiKey) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs an apiKey`);
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs at least one model`);
    }
    const envName = `LLM_KEY_${p.name.toUpperCase().replace(/-/g, '_')}`;
    nextProviders[p.name] = {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      api: 'openai-completions',
      apiKey: { source: 'env', provider: 'default', id: envName },
      models: p.models.map((m) => {
        const spec = typeof m === 'string' ? { id: m } : m;
        if (!spec || typeof spec.id !== 'string' || !spec.id) {
          fail(`LLM_PROVIDERS: provider ${p.name} has an invalid model entry`);
        }
        return defaultModelSpec(spec.id, spec.reasoning === true);
      }),
    };
    // Single-quote the secret; escape embedded quotes safely.
    const quoted = `'${p.apiKey.replace(/'/g, `'\\''`)}'`;
    exportLines.push(`export ${envName}=${quoted}`);
  }
  Object.keys(providers).forEach((k) => delete providers[k]);
  Object.assign(providers, nextProviders);
  fs.writeFileSync(llmEnvPath, `${exportLines.join('\n')}\n`, { mode: 0o600 });
  console.log(`[dealclaw-runtime] LLM providers configured: ${Object.keys(nextProviders).join(', ')}`);

  if (typeof llmDoc.defaultModel === 'string' && llmDoc.defaultModel) {
    const [pName, ...rest] = llmDoc.defaultModel.split('/');
    const modelId = rest.join('/');
    if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
      fail(`LLM_PROVIDERS: defaultModel ${llmDoc.defaultModel} not found in configured providers`);
    }
    primaryModel = llmDoc.defaultModel;
  } else {
    // No explicit default → first provider's first model.
    const first = llmDoc.providers[0];
    primaryModel = `${first.name}/${first.models[0]?.id ?? ''}`;
  }
} else {
  // No custom providers configured — remove any stale exports file so a
  // previously-configured key can never linger on disk.
  try { fs.unlinkSync(llmEnvPath); } catch { /* not present */ }
}

const deniedTools = [
  'message',
  'gateway',
  'cron',
  'nodes',
  'sessions_spawn',
  'sessions_send',
  'sessions_list',
  'sessions_history',
  'image_generate',
  'video_generate',
  'music_generate',
  'tts',
  'skill_workshop',
];

const config = {
  models: {
    mode: 'merge',
    providers,
  },
  gateway: {
    mode: 'local',
    bind: 'loopback',
    port: gatewayPort,
    auth: { mode: 'none' },
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 1_048_576,
          maxUrlParts: 0,
          files: { allowUrl: false, maxBytes: 5_242_880, maxChars: 60_000 },
          images: { allowUrl: false, maxBytes: 10_485_760 },
        },
      },
    },
  },
  agents: {
    defaults: {
      workspace,
      skipBootstrap: true,
      contextInjection: 'always',
      bootstrapMaxChars: 30_000,
      bootstrapTotalMaxChars: 100_000,
      model: { primary: primaryModel },
      timeoutSeconds: 120,
      userTimezone: timezone,
      memorySearch: { enabled: true, provider: 'none' },
    },
    list: [
      {
        id: 'dealclaw',
        name: 'DealClaw',
        workspace,
        // Auto-discover all skills from workspace skills/ directory
        skills: (() => {
          const skillsDir = path.join(workspace, 'skills');
          try {
            return fs.readdirSync(skillsDir).filter(name =>
              fs.statSync(path.join(skillsDir, name)).isDirectory()
            );
          } catch { return []; }
        })(),
        tools: {
          profile: 'coding',
          deny: deniedTools,
        },
      },
    ],
  },
  tools: {
    profile: 'coding',
    deny: deniedTools,
    elevated: { enabled: false },
  },
  plugins: {
    load: {
      paths: [path.join(workspace, 'plugins', 'dealclaw-billing')],
    },
    entries: {
      'dealclaw-billing': {
        enabled: true,
      },
    },
  },
  logging: {
    redactSensitive: 'tools',
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`[dealclaw-runtime] wrote OpenClaw config: ${configPath}`);
