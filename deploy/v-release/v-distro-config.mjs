#!/usr/bin/env node
// openclaw.json for an installed V distro (distro/CONTRACT.md section 4).
//
//   node config/openclaw-config.mjs --profile standalone|sandbox --release-dir <dir>
//        [--env-file <install.env>]... [--state-dir <dir>] [--workspace <dir>]
//
// Writes JSON to stdout. Secrets are written only as ${NAME} references that
// OpenClaw resolves from the service environment; this file reads the
// environment only to decide whether an optional provider or channel is set up.
// Based on production V's live config (2026-11-27) and Mirror V's v-config.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES = ['standalone', 'sandbox'];
export const MODEL_PRESETS = ['deepseek', 'vercel'];

/** KEY=VALUE lines; '#' comments; optional surrounding quotes. */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return env;
}

const ref = (name) => `\${${name}}`;

// V's DeepSeek models (models.providers.deepseek on V, 2026-11-27).
const deepseekModel = (id, name, input = ['text', 'image']) => ({
  id, name, reasoning: true, input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 980000, maxTokens: 64000, api: 'openai-completions',
  compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
});

function modelSetup(preset, env, codex) {
  if (preset === 'deepseek') {
    const models = {
      'deepseek/deepseek-flash': { alias: 'deepseek', agentRuntime: { id: 'vlab-worker' }, params: { thinking: 'high' } },
      'deepseek/deepseek-v4-pro': { alias: 'ds-pro', agentRuntime: { id: 'vlab-worker' } },
      ...(codex ? { 'deepseek/vds-deepseek-flash': { alias: 'vds', agentRuntime: { id: 'codex' }, params: { thinking: 'high', codexAppServerRuntimeModel: 'deepseek-flash' } } } : {}),
    };
    return {
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1', apiKey: ref('DEEPSEEK_API_KEY'), api: 'openai-completions', timeoutSeconds: 90,
          agentRuntime: { id: 'vlab-worker' },
          models: [
            deepseekModel('deepseek-flash', 'DeepSeek V4.1 Flash'),
            deepseekModel('deepseek-v4-pro', 'DeepSeek V4 Pro', ['text']),
            ...(codex ? [deepseekModel('vds-deepseek-flash', 'DeepSeek V4.1 Flash (Codex vds alias)')] : []),
          ],
        },
      },
      // As on V: DeepSeek Flash through the Codex harness (/vds), falling back to the Worker pool.
      model: codex ? { primary: 'deepseek/vds-deepseek-flash', fallbacks: ['deepseek/deepseek-flash'] } : { primary: 'deepseek/deepseek-flash' },
      models,
      fastModel: 'deepseek/deepseek-flash',
      pluginIds: ['deepseek'],
      webProvider: 'deepseek',
    };
  }
  if (preset === 'vercel') {
    // Vercel AI Gateway (OpenAI-compatible). Worker pool only: the Codex harness
    // talks to DeepSeek's own Responses API.
    const id = env.V_MODEL_ID || 'deepseek/deepseek-v4.1-flash-1017-ultrafast';
    return {
      providers: {
        aigw: {
          baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: ref('AI_GATEWAY_API_KEY'), api: 'openai-completions', timeoutSeconds: 90,
          agentRuntime: { id: 'vlab-worker' },
          models: [{
            id, name: `${id} (Vercel AI Gateway)`, reasoning: true, input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 980000, maxTokens: 64000, api: 'openai-completions',
            compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
          }],
        },
      },
      model: { primary: `aigw/${id}` },
      models: { [`aigw/${id}`]: { alias: 'v', agentRuntime: { id: 'vlab-worker' }, params: { thinking: 'high' } } },
      fastModel: `aigw/${id}`,
      pluginIds: [],
      webProvider: null,
    };
  }
  throw new Error(`V_MODEL_PRESET must be one of ${MODEL_PRESETS.join(', ')}`);
}

/**
 * @param {object} o
 * @param {'standalone'|'sandbox'} o.profile
 * @param {string} o.releaseDir   /opt/v/current (stable path, not the versioned one)
 * @param {string} o.stateDir     ~/.openclaw
 * @param {string} o.workspace
 * @param {Record<string,string>} o.env  install.env + secrets.env merged; values are only tested for presence
 * @param {string|null} [o.codexCommand] native codex binary, when the codex CLI is installed
 */
export function createConfig(o) {
  if (!PROFILES.includes(o.profile)) throw new Error(`profile must be one of ${PROFILES.join(', ')}`);
  const env = o.env ?? {};
  const has = (k) => typeof env[k] === 'string' && env[k].length > 0;
  const preset = env.V_MODEL_PRESET || 'deepseek';
  const codex = preset === 'deepseek' && !!o.codexCommand;
  const m = modelSetup(preset, env, codex);
  const standalone = o.profile === 'standalone';
  const feishu = standalone && has('FEISHU_APP_ID') && has('FEISHU_APP_SECRET');
  const ownerOpenId = env.V_OWNER_FEISHU_OPEN_ID || '';
  if (ownerOpenId && !/^ou_[0-9a-zA-Z]+$/.test(ownerOpenId)) throw new Error('V_OWNER_FEISHU_OPEN_ID must look like ou_...');
  const embeddings = has('GOOGLE_API_KEY');
  const xai = has('XAI_API_KEY');
  const maxWorkers = Math.max(1, Math.min(48, Number(env.V_WORKERS_MAX || 4) || 4));
  const plugin = (p) => path.join(o.releaseDir, p);

  if (xai) {
    m.providers.xai = {
      baseUrl: 'https://api.x.ai/v1', apiKey: ref('XAI_API_KEY'), api: 'openai-responses',
      models: [{ id: 'grok-4.7', name: 'Grok 4.7', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 500000, maxTokens: 64000 }],
    };
  }

  const pluginAllow = [
    'vlab-agent-worker-isolation', 'v-session-relay', 'memory-core', ...m.pluginIds,
    ...(codex ? ['codex'] : []), ...(feishu ? ['feishu'] : []), ...(embeddings ? ['google'] : []), ...(xai ? ['xai'] : []),
    'browser', 'document-extract', 'web-readability', 'file-transfer',
  ];
  // Only V's own plugins load by path. Official plugins (feishu, codex, providers) must
  // come from OpenClaw's own npm install: a path-loaded copy has origin "config" and the
  // feishu channel is then refused its ingress queue. The installer lays V's bytes over them.
  const loadPaths = [plugin('plugins/worker'), plugin('plugins/session-relay')];

  const cfg = {
    gateway: {
      mode: 'local', bind: 'loopback', port: Number(env.V_GATEWAY_PORT || 18789),
      auth: { mode: 'token', token: ref('OPENCLAW_GATEWAY_TOKEN') },
      http: { endpoints: { responses: { enabled: true } } },
      // A sandbox never hot-reloads: the Portal rewrites the file and restarts on its own terms,
      // and a reload here closes the Worker pool for good (V, 2026-09-20).
      ...(standalone ? {} : { reload: { mode: 'off' } }),
    },
    models: { mode: 'merge', providers: m.providers },
    agents: {
      defaults: {
        workspace: o.workspace,
        model: m.model,
        models: m.models,
        modelPolicy: { allow: Object.keys(m.models) },
        ...(xai ? { imageModel: { primary: 'xai/grok-4.7' } } : {}),
        thinkingDefault: 'high',
        typingMode: 'instant',
        reasoningDefault: 'off',
        maxConcurrent: 8,
        heartbeat: { every: '0m' },
        contextPruning: { mode: 'cache-ttl', ttl: '1m' },
        compaction: { mode: 'safeguard', keepRecentTokens: 8000, recentTurnsPreserve: 3, midTurnPrecheck: { enabled: true }, timeoutSeconds: 360, model: m.fastModel, notifyUser: true },
        subagents: { maxConcurrent: 8, runTimeoutSeconds: 21600, announceTimeoutMs: 21600000 },
        modelSelectionScope: 'session',
      },
      // 2026.9.1 keys agents by id (agents.list is migrated on every start, with a warning).
      entries: { [o.agentId ?? 'makaron']: { workspace: o.workspace } },
    },
    memory: {
      search: embeddings
        ? { provider: 'gemini', model: 'gemini-embedding-2-preview', outputDimensionality: 3072, fallback: 'none', sources: ['memory'], remote: { apiKey: ref('GOOGLE_API_KEY') }, store: { fts: { tokenizer: 'trigram' } } }
        : { provider: 'none', fallback: 'none', sources: ['memory'], store: { fts: { tokenizer: 'trigram' } } },
    },
    session: {
      dmScope: 'per-channel-peer',
      maintenance: { mode: 'enforce', pruneAfter: '30d', maxEntries: 2000, maxDiskBytes: '16gb' },
      reset: { mode: 'idle', idleMinutes: 43200 },
    },
    messages: {
      visibleReplies: 'automatic',
      groupChat: { historyLimit: 50, visibleReplies: 'automatic' },
      queue: { mode: 'steer', cap: 20, drop: 'summarize', debounceMsByChannel: { feishu: 1000 } },
    },
    commands: {
      native: 'auto', nativeSkills: 'auto', restart: true,
      ...(feishu && ownerOpenId ? { ownerAllowFrom: [`feishu:${ownerOpenId}`] } : {}),
    },
    tools: {
      profile: 'full',
      // A sandbox has no channel to answer an approval or a detached result on (Mirror V's list).
      // `message` too: with no channel the agent's message tool posts to internal-ui and the
      // image or text is lost (Mirror V, 2026-11-27). Standalone has Feishu and keeps it.
      deny: standalone ? [] : ['gateway', 'cron', 'ask_user', 'sessions_yield', 'message', 'image_generate', 'video_generate', 'music_generate'],
      sessions: { visibility: 'all' },
      web: m.webProvider ? { search: { enabled: true, provider: m.webProvider }, fetch: { provider: m.webProvider } } : { search: { enabled: true } },
      elevated: { enabled: false },
      // One owner's own machine: no approval prompt the channel could not answer.
      exec: { host: 'gateway', security: 'full', ask: 'off' },
    },
    skills: { install: { nodeManager: 'npm' } },
    plugins: {
      enabled: true,
      allow: pluginAllow,
      load: { paths: loadPaths },
      entries: {
        'memory-core': { enabled: true, config: { dreaming: { enabled: false } } },
        ...Object.fromEntries(m.pluginIds.map((id) => [id, { enabled: true }])),
        ...(embeddings ? { google: { enabled: true } } : {}),
        ...(xai ? { xai: { enabled: true } } : {}),
        ...(feishu ? { feishu: { enabled: true } } : {}),
        ...(codex ? { codex: { enabled: true, config: { codexPlugins: { enabled: false }, codexDynamicToolsLoading: 'searchable', codexDynamicToolsExclude: ['openclaw'], appServer: { mode: 'yolo', approvalPolicy: 'never', sandbox: 'danger-full-access', command: o.codexCommand } } } } : {}),
        'v-session-relay': { enabled: true, config: { workerGuard: true, ...(env.V_OWNER_NAME ? { ownerName: env.V_OWNER_NAME } : {}) } },
        'vlab-agent-worker-isolation': {
          enabled: true,
          config: {
            minWorkers: 1, maxWorkers, sessionsPerWorker: 3,
            idleTimeoutMs: 180000, requestTimeoutMs: 600000, requestStallTimeoutMs: 120000, gatewayOwnedToolTimeoutMs: 310000,
            fastCompactionModel: m.fastModel,
            workerConfigPath: path.join(o.stateDir, 'worker-openclaw.json'),
            gatewayConfigPath: path.join(o.stateDir, 'openclaw.json'),
            nativeRequestTimeoutMs: 21600000,
          },
        },
      },
    },
  };
  if (feishu) {
    // V's channels.feishu, one bot for one owner: websocket, streaming card, no tool groups.
    cfg.channels = {
      feishu: {
        enabled: true, appId: ref('FEISHU_APP_ID'), appSecret: ref('FEISHU_APP_SECRET'),
        domain: env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu', connectionMode: 'websocket',
        requireMention: true,
        dmPolicy: ownerOpenId ? 'allowlist' : 'pairing',
        ...(ownerOpenId ? { allowFrom: [ownerOpenId] } : {}),
        groupPolicy: 'disabled',
        streaming: { mode: 'partial', block: { enabled: false } },
        reactionNotifications: 'own', typingIndicator: true, resolveSenderNames: true,
        capabilities: ['inlineButtons'], renderMode: 'auto',
        tools: { doc: false, chat: false, wiki: false, drive: false, perm: false, scopes: false, bitable: false },
        actions: { reactions: true },
      },
    };
  }
  return cfg;
}

/** Codex's own config for the /vds harness (V's codex-home/config.toml, minus V's projects and plugins). */
export function codexHomeToml(workspace) {
  return [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    `[projects.${JSON.stringify(workspace)}]`,
    'trust_level = "trusted"',
    '',
    '[model_providers.deepseek]',
    'request_max_retries = 1',
    'stream_max_retries = 1',
    'name = "DeepSeek"',
    'base_url = "https://api.deepseek.com/v1"',
    'wire_api = "responses"',
    'env_key = "DEEPSEEK_API_KEY"',
    '',
    '[features]',
    'remote_plugin = false',
    '',
  ].join('\n');
}

function main(argv) {
  const opts = { envFiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--profile') { opts.profile = v; i += 1; }
    else if (a === '--release-dir') { opts.releaseDir = v; i += 1; }
    else if (a === '--state-dir') { opts.stateDir = v; i += 1; }
    else if (a === '--workspace') { opts.workspace = v; i += 1; }
    else if (a === '--codex-command') { opts.codexCommand = v; i += 1; }
    else if (a === '--env-file') { opts.envFiles.push(v); i += 1; }
    else if (a === '--codex-home-toml') { opts.codexToml = true; }
    else throw new Error(`unexpected argument ${a}`);
  }
  const env = {};
  for (const f of opts.envFiles) Object.assign(env, parseEnvFile(fs.readFileSync(f, 'utf8')));
  const stateDir = opts.stateDir ?? '/home/openclaw/.openclaw';
  const workspace = opts.workspace ?? path.join(stateDir, 'workspace');
  if (opts.codexToml) { process.stdout.write(codexHomeToml(workspace)); return; }
  if (!opts.releaseDir) throw new Error('--release-dir is required');
  const cfg = createConfig({
    profile: opts.profile ?? 'standalone', releaseDir: opts.releaseDir, stateDir, workspace, env,
    codexCommand: opts.codexCommand || null,
  });
  process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
}

// Compare real paths: installed scripts run through the /opt/v/current symlink.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`openclaw-config: ${err.message}`); process.exit(2); }
}
