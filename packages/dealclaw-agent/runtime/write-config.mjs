import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/state';
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
const model = process.env.DEALCLAW_MODEL || 'deepseek/deepseek-chat';
const timezone = process.env.DEALCLAW_TIMEZONE || 'Asia/Shanghai';
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18790);

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

const config = {
  models: {
    mode: 'merge',
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com',
        api: 'openai-completions',
        apiKey: { source: 'env', provider: 'default', id: 'DEEPSEEK_API_KEY' },
        models: deepseekModels,
      },
    },
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
      model: { primary: model },
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
  logging: {
    redactSensitive: 'tools',
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`[dealclaw-runtime] wrote OpenClaw config: ${configPath}`);
