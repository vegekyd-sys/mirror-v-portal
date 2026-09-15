import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/state';
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
const timezone = process.env.DEALCLAW_TIMEZONE || 'Asia/Shanghai';
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18790);
const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();

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

function defaultModelSpec(id, reasoning, vision) {
  // deepseek models align with V's spec: 1M context / 384K output,
  // native reasoning_effort + deepseek thinking format (lets
  // reasoningDefault/thinkingDefault actually reach the model instead of
  // falling back to default reasoning).
  const isDeepseek = id.startsWith('deepseek');
  return {
    id,
    name: id,
    ...(reasoning ? { reasoning: true } : {}),
    input: vision ? ['text', 'image'] : ['text'],
    contextWindow: isDeepseek ? 1_000_000 : 131_072,
    maxTokens: isDeepseek ? 384_000 : (reasoning ? 65_536 : 8_192),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsUsageInStreaming: true,
      ...(isDeepseek ? { supportsReasoningEffort: true, thinkingFormat: 'deepseek' } : {}),
      maxTokensField: 'max_tokens',
    },
  };
}

  // No built-in fallback provider: with an empty library the agent boots with
  // no model configured (admin must add providers in the console first).
  const providers = {};
  let primaryModel = null;
  let imageModel = null;
  let compactionModel = null;
  const fallbackModels = [];

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
    const compatibleModels = p.models.flatMap((m) => {
      const spec = typeof m === 'string' ? { id: m } : m;
      if (!spec || typeof spec.id !== 'string' || !spec.id) {
        fail(`LLM_PROVIDERS: provider ${p.name} has an invalid model entry`);
      }
      // Missing fields are legacy-compatible; explicit non-chat/non-supported
      // entries stay in the catalog but never enter OpenClaw's chat list.
      if ((spec.modelType && spec.modelType !== 'chat') ||
          (spec.protocol && spec.protocol !== 'openai-completions')) return [];
      const fallback = defaultModelSpec(spec.id, spec.reasoning === true, spec.vision === true);
      const contextWindow = Number.isSafeInteger(spec.contextWindow) && spec.contextWindow > 0
        ? spec.contextWindow : fallback.contextWindow;
      const maxTokens = Number.isSafeInteger(spec.maxOutputTokens) && spec.maxOutputTokens > 0
        ? spec.maxOutputTokens : fallback.maxTokens;
      const input = Array.isArray(spec.inputModalities) &&
        spec.inputModalities.length > 0 &&
        spec.inputModalities.every((value) => ['text', 'image', 'audio', 'video'].includes(value))
        ? [...new Set(spec.inputModalities)]
        : fallback.input;
      return [{ ...fallback, name: typeof spec.displayName === 'string' ? spec.displayName : spec.id, contextWindow, maxTokens, input }];
    });
    if (compatibleModels.length === 0) {
      console.warn(`[dealclaw-runtime] LLM_PROVIDERS: provider ${p.name} has no chat-compatible models — skipped`);
      continue;
    }
    nextProviders[p.name] = {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      api: 'openai-completions',
      apiKey: { source: 'env', provider: 'default', id: envName },
      // Per-request idle timeout: cloud default is 120s which trips on slow
      // upstreams; raise to 600s so transient stalls fall through to the
      // fallback chain instead of hard-failing the turn.
      timeoutSeconds: Number(process.env.DEALCLAW_LLM_PROVIDER_TIMEOUT_SECONDS || 600),
      models: compatibleModels,
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
    // No explicit default → first chat-compatible provider model.
    const firstProviderName = Object.keys(nextProviders)[0];
    const firstModel = firstProviderName ? nextProviders[firstProviderName].models[0] : null;
    primaryModel = firstProviderName && firstModel ? `${firstProviderName}/${firstModel.id}` : null;
  }

  // ── Fallback chain (OpenClaw model failover) ───────────────────────
  // llmDoc.fallbackModels: ordered '<provider>/<model>' refs. Fail-open:
  // entries that no longer resolve are skipped with a warning (the blob is
  // materialised server-side already filtered, this is belt-and-braces for
  // hand-edited Secrets). The primary itself is excluded (no-op retry).
  if (Array.isArray(llmDoc.fallbackModels)) {
    for (const ref of llmDoc.fallbackModels) {
      if (typeof ref !== 'string' || !ref || ref === primaryModel) continue;
      const [pName, ...rest] = ref.split('/');
      const modelId = rest.join('/');
      if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
        console.warn(`[dealclaw-runtime] LLM_PROVIDERS: fallbackModel ${ref} not found in configured providers — skipped`);
        continue;
      }
      if (!fallbackModels.includes(ref)) fallbackModels.push(ref);
    }
    if (fallbackModels.length > 0) {
      console.log(`[dealclaw-runtime] model fallback chain: ${fallbackModels.join(' -> ')}`);
    }
  }

  // ── Image (vision) model ────────────────────────────────────────────
  // llmDoc.imageModel is a '<provider>/<modelId>' ref; it must resolve to a
  // model marked vision: true, otherwise we fail closed (a mis-configured
  // imageModel must never silently point at a text-only model).
  if (typeof llmDoc.imageModel === 'string' && llmDoc.imageModel) {
    const [pName, ...rest] = llmDoc.imageModel.split('/');
    const modelId = rest.join('/');
    const model = nextProviders[pName]?.models.find((m) => m.id === modelId);
    if (!model) {
      fail(`LLM_PROVIDERS: imageModel ${llmDoc.imageModel} not found in configured providers`);
    }
    if (!Array.isArray(model.input) || !model.input.includes('image')) {
      fail(`LLM_PROVIDERS: imageModel ${llmDoc.imageModel} is not vision-capable (add :vision to its model entry)`);
    }
    imageModel = llmDoc.imageModel;
  }

  // ── Compaction model ─────────────────────────────────────────────────
  // llmDoc.compactionModel is a '<provider>/<modelId>' ref for the context-
  // engine's safeguard compaction (history summarisation). Compaction prompts
  // are long-context, so a tenant whose primary is a slow heavyweight model
  // may point compaction at a faster one (see the 2026-09-01 foldin
  // incident: 6-minute compaction timeouts). Fail-open: an unresolvable ref
  // falls back to the primary with a warning instead of blocking boot.
  if (typeof llmDoc.compactionModel === 'string' && llmDoc.compactionModel) {
    const [pName, ...rest] = llmDoc.compactionModel.split('/');
    const modelId = rest.join('/');
    if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
      console.warn(`[dealclaw-runtime] LLM_PROVIDERS: compactionModel ${llmDoc.compactionModel} not found in configured providers — falling back to primary`);
    } else {
      compactionModel = llmDoc.compactionModel;
    }
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
// from the nexus-gateway bridge to the official @openclaw/feishu plugin.
// Preferred source: the trusted install managed by entrypoint.sh
// (`openclaw plugins install` into the PVC state dir — trusted plugins get
// openKeyedStore access, i.e. persistent feishu-dedup). Fallback: the
// image-baked sideload copy at /opt/dealclaw/plugins/feishu (load.paths —
// no trusted identity, dedup degrades to in-memory). Credentials come
// from the tenant's bot Secret (envFrom); the appSecret is referenced by
// env id, never inlined into the config file.
const FEISHU_PLUGIN_DIR = '/opt/dealclaw/plugins/feishu/node_modules/@openclaw/feishu';
const WECHAT_PLUGIN_DIR = '/opt/dealclaw/plugins/weixin/node_modules/@tencent-weixin/openclaw-weixin';
const WECOM_PLUGIN_DIR = '/opt/dealclaw/plugins/wecom/node_modules/@wecom/wecom-openclaw-plugin';
const DINGTALK_PLUGIN_DIR = '/opt/dealclaw/plugins/dingtalk/node_modules/@dingtalk-real-ai/dingtalk-connector';
const messagePlane = process.env.DEALCLAW_MESSAGE_PLANE || 'gateway';
const feishuAppId = (process.env.DEALCLAW_APP_ID || '').trim();
const feishuAppSecret = (process.env.DEALCLAW_APP_SECRET || '').trim();
const feishuDirect =
  messagePlane === 'openclaw' &&
  feishuAppId &&
  feishuAppSecret &&
  !feishuAppId.startsWith('placeholder-');

// ── WeChat (personal WeChat direct connection) ────────────────────────
// DEALCLAW_WECHAT_BOUND=1 + openclaw plane → enable channels["openclaw-weixin"].
// Unlike Feishu, WeChat account credentials are obtained via QR login (not
// appId/appSecret) and stored by the plugin in the PVC state directory.
// write-config only needs to declare the channel enabled; the plugin reads
// account files from $OPENCLAW_STATE_DIR/openclaw-weixin/accounts.json.
const wechatBound = process.env.DEALCLAW_WECHAT_BOUND === '1' && messagePlane === 'openclaw';

// Enterprise channel credentials originate from Kubernetes Secrets. DingTalk
// supports an env SecretRef; WeCom 2026.7.2 only accepts a string, so its secret
// is materialized into the 0600 openclaw.json. A BOUND flag without complete
// credentials is treated as disabled to avoid a half-configured channel.
const wecomBotId = (process.env.DEALCLAW_WECOM_BOT_ID || '').trim();
const wecomSecret = (process.env.DEALCLAW_WECOM_SECRET || '').trim();
const wecomBound =
  process.env.DEALCLAW_WECOM_BOUND === '1' &&
  messagePlane === 'openclaw' &&
  Boolean(wecomBotId && wecomSecret);
const dingtalkClientId = (process.env.DEALCLAW_DINGTALK_CLIENT_ID || '').trim();
const dingtalkClientSecret = (process.env.DEALCLAW_DINGTALK_CLIENT_SECRET || '').trim();
const dingtalkBound =
  process.env.DEALCLAW_DINGTALK_BOUND === '1' &&
  messagePlane === 'openclaw' &&
  Boolean(dingtalkClientId && dingtalkClientSecret);

// ── Shared DM session (Feishu + WeChat cross-channel merge) ──────────
// Three-state, DEFAULT ON (v0.10): DEALCLAW_SHARED_DM_SESSION
//   '1'        → explicitly enabled  → dmScope 'main'
//   '0'        → explicitly disabled → falls through to wechatBound /
//                escape-hatch / per-channel-peer
//   <unset>    → DEFAULT enabled     → dmScope 'main'
// The per-tenant admin toggle materialises '1'/'0'; a tenant that has never
// touched the toggle leaves the env unset and therefore defaults to merged.
const sharedDmSession = process.env.DEALCLAW_SHARED_DM_SESSION !== '0';

if (messagePlane === 'openclaw' && !feishuDirect && !wechatBound && !wecomBound && !dingtalkBound) {
  console.warn('[dealclaw-runtime] DEALCLAW_MESSAGE_PLANE=openclaw but no channel credentials — channels NOT enabled');
}

const pluginLoadPaths = [
  path.join(workspace, 'plugins', 'dealclaw-billing'),
  path.join(workspace, 'plugins', 'dealclaw-contact'),
  path.join(workspace, 'plugins', 'dealclaw-chatlog'),
];
if (feishuDirect && process.env.DEALCLAW_FEISHU_TRUSTED !== '1') pluginLoadPaths.push(FEISHU_PLUGIN_DIR);
if (wechatBound && process.env.DEALCLAW_WECHAT_TRUSTED !== '1') pluginLoadPaths.push(WECHAT_PLUGIN_DIR);
if (wecomBound && process.env.DEALCLAW_WECOM_TRUSTED !== '1') pluginLoadPaths.push(WECOM_PLUGIN_DIR);
if (dingtalkBound && process.env.DEALCLAW_DINGTALK_TRUSTED !== '1') pluginLoadPaths.push(DINGTALK_PLUGIN_DIR);

const deniedTools = [
  'message',
  'gateway',
  // cron is intentionally ALLOWED: without it the agent has no durable way to
  // honour 「明天提醒我跟进」 and falls back to backgrounding `sleep`, which dies
  // on the next pod restart / image upgrade — the reminder is then lost
  // silently. AGENTS.md 「延时提醒一律走调度器」 assumes this tool exists.
  // Safe to expose: the agent cron tool hard-rejects payload.kind="command"
  // (assertNoCronCommandPayload), so it can only schedule systemEvent/agentTurn
  // jobs, never shell. The six product crons stay on the CLI path in
  // runtime/dc-cron-*.sh, which the tool can neither create nor edit.
  'nodes',
  // sessions_* orchestration tools are intentionally ALLOWED (full set):
  // - sessions_spawn: delegate long multi-tool tasks (find-buyers crawls) to an
  //   isolated sub-session with its own runTimeoutSeconds, escaping the 1800s
  //   run ceiling without blocking the Feishu reply (P1 async).
  // - sessions_list: enumerate spawned sub-sessions and their status.
  // - sessions_history: read a sub-session's transcript.
  // - sessions_send: append follow-up instructions to a running sub-session.
  // Together they give the main agent the full orchestration surface it needs to
  // manage long-running delegated work. Spawned sub-agents still do NOT inherit
  // these (they run in leaf mode), so only the main orchestrator can fan out.
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
    // Shared-token auth so the CLI (cron add / agent) authenticates as an
    // operator.admin client instead of triggering device-pairing scope-upgrade
    // (which needs manual approval and blocks unattended tenant startup).
    // Falls back to none when no token is injected.
    auth: gatewayToken ? { mode: 'token', token: gatewayToken } : { mode: 'none' },
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
      ...(primaryModel
        ? {
            model: {
              primary: primaryModel,
              // OpenClaw model failover: on failover-worthy errors (timeout /
              // rate limit / auth failure / provider outage) the turn retries
              // with the next candidate; turn-local — next turn back to primary.
              ...(fallbackModels.length > 0 ? { fallbacks: fallbackModels } : {}),
            },
          }
        : {}),
      ...(imageModel ? { imageModel: { primary: imageModel } } : {}),
      // Run-level ceiling (upstream OpenClaw default is 48h; we cap it lower
      // to bound runaway tool loops). 1800s accommodates long multi-tool
      // tasks (e.g. find-buyers crawls); provider idle timeouts stay lower
      // (see provider timeoutSeconds below).
      timeoutSeconds: Number(process.env.DEALCLAW_AGENT_RUN_TIMEOUT_SECONDS || 1800),
      // reasoning off (skip reasoning tokens — faster first-token + streaming)
      reasoningDefault: 'off',
      // Reasoning model + high thinking caused "思考过载" (b4083949 / 158a70e):
      // every tool step re-reasoned, final turn spent 6281 thinking chars to
      // emit 8 chars of answer, hitting the 15min run ceiling. Drop one notch
      // (high → medium) to bound thinking without disabling it.
      thinkingDefault: 'medium',
      // Sub-agent delegation: 'prefer' strongly instructs the main agent to
      // hand non-trivial work (find-buyers / 开发信 crawls) to sessions_spawn
      // sub-agents instead of grinding through it inline and hitting the run
      // ceiling. Sub-agents run with their own runTimeoutSeconds and push
      // results back via completion events.
      // - maxConcurrent: cap concurrent sub-agents per main session (fan-out bound).
      // - maxSpawnDepth: 1 = no nesting (default) — sub-agents cannot spawn
      //   further sub-agents, so only the main orchestrator can fan out.
      // - runTimeoutSeconds: sub-agent default run ceiling (7200s = 2h), 4x the
      //   main run ceiling (1800s) so delegated long tasks outlive the parent turn.
      subagents: {
        delegationMode: 'prefer',
        maxConcurrent: 4,
        maxSpawnDepth: 1,
        runTimeoutSeconds: 7200,
      },
      contextTokens: 1_000_000,
      typingMode: 'instant',
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
      // the context overflows. Uses the dedicated compaction model when
      // configured, else the primary model (tenant gateway proxy).
      compaction: {
        mode: 'safeguard',
        reserveTokens: 50_000,
        keepRecentTokens: 8_000,
        reserveTokensFloor: 50_000,
        maxHistoryShare: 0.35,
        recentTurnsPreserve: 3,
        truncateAfterCompaction: true,
        timeoutSeconds: 360,
        ...((compactionModel || primaryModel) ? { model: compactionModel || primaryModel } : {}),
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
        identity: { name: '出海精灵小元', emoji: '🤝' },
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
    // Preserve the existing allow-list behavior for Feishu and personal Weixin;
    // append enterprise channel plugin IDs only when the tenant enables them.
    allow: [
      'feishu',
      'openclaw-weixin',
      ...(wecomBound ? ['wecom-openclaw-plugin'] : []),
      ...(dingtalkBound ? ['dingtalk-connector'] : []),
    ],
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
      'dealclaw-chatlog': {
        enabled: true,
        // agent_end 属会话级钩子（读完整对话消息）：非 bundled 插件必须显式
        // 声明 allowConversationAccess=true，否则注册时被安全门静默拦截
        // （2026-08-31 Build #142 实证：typed hook "agent_end" blocked）。
        hooks: { allowConversationAccess: true },
      },
      ...(feishuDirect ? { feishu: { enabled: true } } : {}),
      ...(wechatBound ? { 'openclaw-weixin': { enabled: true } } : {}),
      ...(wecomBound ? { 'wecom-openclaw-plugin': { enabled: true } } : {}),
      ...(dingtalkBound ? { 'dingtalk-connector': { enabled: true } } : {}),
    },
  },
  ...(feishuDirect || wechatBound || wecomBound || dingtalkBound
    ? {
        channels: {
          ...(feishuDirect ? {
            feishu: {
              enabled: true,
              appId: feishuAppId,
              appSecret: { source: 'env', provider: 'default', id: 'DEALCLAW_APP_SECRET' },
              // D1: per-tenant isolated Feishu app — open DMs, zero onboarding.
              dmPolicy: 'open',
              allowFrom: ['*'],
              // Group policy: 'open' (respond in all groups) by default; set
              // DEALCLAW_FEISHU_GROUP_POLICY=allowlist to restrict to whitelist.
              groupPolicy: process.env.DEALCLAW_FEISHU_GROUP_POLICY || 'open',
              // Respond in groups without an explicit @mention by default;
              // set DEALCLAW_FEISHU_REQUIRE_MENTION=true to restore mention-gating.
              requireMention: process.env.DEALCLAW_FEISHU_REQUIRE_MENTION === 'true',
              streaming: true,
              // Show "typing…" indicator while the agent run is in flight.
              // Set DEALCLAW_FEISHU_TYPING_INDICATOR=false to disable (quota optimisation).
              typingIndicator: process.env.DEALCLAW_FEISHU_TYPING_INDICATOR !== 'false',
              // D2: full workplace tool suite (requires app scopes).
              tools: { doc: true, chat: true, wiki: true, drive: true, perm: true, bitable: true },
            },
          } : {}),
          ...(wechatBound ? {
            'openclaw-weixin': {
              enabled: true,
              // Account list comes from PVC state dir (accounts.json);
              // no appId/appSecret here — plugin manages credentials via QR login.
            },
          } : {}),
          ...(wecomBound ? {
            wecom: {
              enabled: true,
              connectionMode: 'websocket',
              botId: wecomBotId,
              // Plugin 2026.7.2 only accepts a string here; OpenClaw SecretRef is
              // not supported by this plugin version. openclaw.json is written 0600.
              secret: wecomSecret,
              dmPolicy: 'open',
              allowFrom: ['*'],
              groupPolicy: 'open',
            },
          } : {}),
          ...(dingtalkBound ? {
            'dingtalk-connector': {
              enabled: true,
              clientId: dingtalkClientId,
              clientSecret: { source: 'env', provider: 'default', id: 'DEALCLAW_DINGTALK_CLIENT_SECRET' },
              dmPolicy: 'open',
              allowFrom: ['*'],
              groupPolicy: 'open',
            },
          } : {}),
        },
      }
    : {}),
  // Group-chat history/visibility (mirrors the V/Makaron workstation): keep
  // a 50-message window and auto-publish replies in groups.
  messages: {
    groupChat: {
      historyLimit: 50,
      visibleReplies: 'automatic',
    },
    // In-flight user messages steer the current run (merged after a 1s
    // debounce) instead of queueing behind it — mirrors the workstation
    // config; kills the "second message waits minutes" UX. Set
    // DEALCLAW_MESSAGE_QUEUE_MODE=off to restore strict FIFO queueing.
    ...(process.env.DEALCLAW_MESSAGE_QUEUE_MODE !== 'off'
      ? {
          queue: {
            mode: process.env.DEALCLAW_MESSAGE_QUEUE_MODE || 'steer',
            debounceMs: 1_000,
            cap: 20,
            drop: 'summarize',
          },
        }
      : {}),
  },
  // DM session scope (priority order):
  //   1. sharedDmSession → 'main': all Feishu + WeChat DMs merge into one
  //      session (agent:dealclaw:main). DEFAULT ON unless
  //      DEALCLAW_SHARED_DM_SESSION is explicitly '0'. Highest priority.
  //   2. wechatBound → 'per-account-channel-peer': WeChat multi-account
  //      isolates DM sessions by account + channel + peer (reached only when
  //      the shared session is explicitly disabled).
  //   3. DEALCLAW_SESSION_DM_SCOPE escape-hatch → overrides the Feishu-only
  //      default (e.g. 'main' for legacy single-session behaviour).
  //   4. Default → 'per-channel-peer': each Feishu user gets an independent
  //      conversation.
  // Sessions are pruned after 14d to bound PVC growth.
  session: {
    dmScope: sharedDmSession
      ? 'main'
      : wechatBound
        ? 'per-account-channel-peer'
        : (process.env.DEALCLAW_SESSION_DM_SCOPE || 'per-channel-peer'),
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
// writeFileSync's mode only applies when creating a file. Enforce owner-only
// permissions after every rewrite because WeCom's plugin schema requires its
// secret to be materialized as a string in this file.
fs.chmodSync(configPath, 0o600);
console.log(`[dealclaw-runtime] wrote OpenClaw config: ${configPath}`);
