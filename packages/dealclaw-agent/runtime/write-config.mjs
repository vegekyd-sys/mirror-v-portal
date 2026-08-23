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

// No built-in fallback provider: with an empty library the agent boots with
// no model configured (admin must add providers in the console first).
const providers = {};
let primaryModel = null;

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
  // No providers configured — remove any stale exports file so a
  // previously-configured key can never linger on disk. The gateway still
  // starts, but with no model: conversations will fail until an admin
  // configures providers in the console.
  try { fs.unlinkSync(llmEnvPath); } catch { /* not present */ }
  console.warn('[dealclaw-runtime] no LLM providers configured — agent starts WITHOUT a model');
}

// ── Feishu channel (P2 direct connection) ─────────────────────────────
// DEALCLAW_MESSAGE_PLANE=openclaw switches the tenant's message plane
// from the nexus-gateway bridge to the official @openclaw/feishu plugin
// (pre-baked at /opt/dealclaw/plugins/feishu — version-pinned to the base
// image). Credentials come from the tenant's bot Secret (envFrom); the
// appSecret is referenced by env id, never inlined into the config file.
const FEISHU_PLUGIN_DIR = '/opt/dealclaw/plugins/feishu/node_modules/@openclaw/feishu';
const messagePlane = process.env.DEALCLAW_MESSAGE_PLANE || 'gateway';
const feishuAppId = (process.env.DEALCLAW_APP_ID || '').trim();
const feishuAppSecret = (process.env.DEALCLAW_APP_SECRET || '').trim();
const feishuDirect =
  messagePlane === 'openclaw' &&
  feishuAppId &&
  feishuAppSecret &&
  !feishuAppId.startsWith('placeholder-');

if (messagePlane === 'openclaw' && !feishuDirect) {
  console.warn('[dealclaw-runtime] DEALCLAW_MESSAGE_PLANE=openclaw but bot credentials missing/placeholder — feishu channel NOT enabled');
}

const pluginLoadPaths = [
  path.join(workspace, 'plugins', 'dealclaw-billing'),
  path.join(workspace, 'plugins', 'dealclaw-contact'),
];
if (feishuDirect) pluginLoadPaths.push(FEISHU_PLUGIN_DIR);

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
      ...(primaryModel ? { model: { primary: primaryModel } } : {}),
      // Long business runs (multi-round skill tooling + slow SSE generation)
      // blow past the 120s default and get killed mid-reply. 600s ceiling,
      // overridable per deployment via env.
      timeoutSeconds: Number(process.env.DEALCLAW_AGENT_RUN_TIMEOUT_SECONDS || 600),
      // Multi-user tenants: each Feishu peer gets its own concurrent budget
      // instead of one global run slot.
      maxConcurrent: Number(process.env.DEALCLAW_AGENT_MAX_CONCURRENT || 5),
      userTimezone: timezone,
      memorySearch: { enabled: true, provider: 'none' },
      // Trim stale cache-tagged tool results so long single sessions don't
      // balloon towards the 131k window (mirrors the V/Makaron workstation).
      contextPruning: {
        mode: 'cache-ttl',
        ttl: '1m',
        keepLastAssistants: 1,
        softTrimRatio: 0.15,
        hardClearRatio: 0.25,
        minPrunableToolChars: 12_000,
      },
      // Safeguard compaction: summarise history instead of hard-failing when
      // the context overflows. Uses the primary model (tenant gateway proxy).
      compaction: {
        mode: 'safeguard',
        reserveTokens: 16_384,
        keepRecentTokens: 8_192,
        reserveTokensFloor: 4_096,
        maxHistoryShare: 0.35,
        recentTurnsPreserve: 3,
        truncateAfterCompaction: true,
        timeoutSeconds: 360,
        ...(primaryModel ? { model: primaryModel } : {}),
        notifyUser: true,
        qualityGuard: { enabled: true, maxRetries: 1 },
      },
      contextLimits: {
        toolResultMaxChars: 32_000,
      },
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
      paths: pluginLoadPaths,
    },
    entries: {
      'dealclaw-billing': {
        enabled: true,
      },
      'dealclaw-contact': {
        enabled: true,
      },
      ...(feishuDirect ? { feishu: { enabled: true } } : {}),
    },
  },
  ...(feishuDirect
    ? {
        channels: {
          feishu: {
            enabled: true,
            appId: feishuAppId,
            appSecret: { source: 'env', provider: 'default', id: 'DEALCLAW_APP_SECRET' },
            // D1: per-tenant isolated Feishu app — open DMs, zero onboarding.
            dmPolicy: 'open',
            allowFrom: ['*'],
            // Groups off by default; enable per tenant via config push.
            groupPolicy: 'allowlist',
            requireMention: true,
            streaming: true,
            // Show "typing…" indicator while the agent run is in flight.
            // Set DEALCLAW_FEISHU_TYPING_INDICATOR=false to disable (quota optimisation).
            typingIndicator: process.env.DEALCLAW_FEISHU_TYPING_INDICATOR !== 'false',
            // D2: full workplace tool suite (requires app scopes).
            tools: { doc: true, chat: true, wiki: true, drive: true, perm: true, bitable: true },
          },
        },
      }
    : {}),
  // In-flight user messages steer the current run (merged after a 1s
  // debounce) instead of queueing behind it — mirrors the workstation
  // config; kills the "second message waits minutes" UX. Set
  // DEALCLAW_MESSAGE_QUEUE_MODE=off to restore strict FIFO queueing.
  ...(process.env.DEALCLAW_MESSAGE_QUEUE_MODE !== 'off'
    ? {
        messages: {
          queue: {
            mode: process.env.DEALCLAW_MESSAGE_QUEUE_MODE || 'steer',
            debounceMs: 1_000,
            cap: 20,
            drop: 'summarize',
          },
        },
      }
    : {}),
  // One session per channel peer: each Feishu user gets an independent
  // conversation instead of sharing agent:dealclaw:main. Sessions are pruned
  // after 14d to bound PVC growth. DEALCLAW_SESSION_DM_SCOPE=shared restores
  // the legacy single-session behaviour.
  session: {
    dmScope: process.env.DEALCLAW_SESSION_DM_SCOPE || 'per-channel-peer',
    maintenance: {
      mode: 'enforce',
      pruneAfter: '14d',
      maxEntries: 500,
      resetArchiveRetention: '14d',
    },
  },
  logging: {
    redactSensitive: 'tools',
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`[dealclaw-runtime] wrote OpenClaw config: ${configPath}`);
