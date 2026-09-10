import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * P2: write-config.mjs must emit channels.feishu ONLY when
 * DEALCLAW_MESSAGE_PLANE=openclaw AND real bot credentials are present.
 * The appSecret must be an env reference, never the raw value.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'runtime', 'write-config.mjs');

interface RunResult {
  config: any;
  stderr: string;
}

function runWriteConfig(env: Record<string, string>): RunResult {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wc-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ws-'));
  let stderr = '';
  const out = execFileSync('node', [script], {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
      ...env,
    },
    encoding: 'utf8',
  });
  stderr = out; // write-config logs to stdout; keep for debugging
  const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8'));
  return { config, stderr };
}

const PROVIDERS = JSON.stringify({
  providers: [{
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-x',
    models: [{ id: 'deepseek-chat' }],
  }],
  defaultModel: 'deepseek/deepseek-chat',
});
describe('write-config channels.feishu (P2)', () => {
  it('emits channels.feishu with env-referenced secret on the openclaw plane', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
      DEALCLAW_MESSAGE_PLANE: 'openclaw',
      DEALCLAW_APP_ID: 'cli_test123',
      DEALCLAW_APP_SECRET: 'sec-secret-value',
    });
    const feishu = config.channels?.feishu;
    expect(feishu).toBeTruthy();
    expect(feishu.enabled).toBe(true);
    expect(feishu.appId).toBe('cli_test123');
    expect(feishu.appSecret).toEqual({ source: 'env', provider: 'default', id: 'DEALCLAW_APP_SECRET' });
    expect(JSON.stringify(config)).not.toContain('sec-secret-value');
    expect(feishu.dmPolicy).toBe('open');
    expect(feishu.groupPolicy).toBe('open');
    expect(feishu.tools.bitable).toBe(true);
    // feishu plugin dir added to load paths
    expect(config.plugins.load.paths.some((p: string) => p.includes('@openclaw/feishu'))).toBe(true);
    expect(config.plugins.entries.feishu?.enabled).toBe(true);
  });

  it('emits NO channels on the default gateway plane', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
      DEALCLAW_APP_ID: 'cli_test123',
      DEALCLAW_APP_SECRET: 'sec-secret-value',
    });
    expect(config.channels).toBeUndefined();
    expect(config.plugins.entries.feishu).toBeUndefined();
    expect(config.plugins.load.paths.some((p: string) => p.includes('@openclaw/feishu'))).toBe(false);
  });

  it('emits NO channels with placeholder credentials even on the openclaw plane', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
      DEALCLAW_MESSAGE_PLANE: 'openclaw',
      DEALCLAW_APP_ID: 'placeholder-abc',
      DEALCLAW_APP_SECRET: 'ignored',
    });
    expect(config.channels).toBeUndefined();
  });

  it('still registers the dealclaw-contact plugin regardless of plane', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
    });
    expect(config.plugins.entries['dealclaw-contact']?.enabled).toBe(true);
    expect(config.plugins.load.paths.some((p: string) => p.includes('dealclaw-contact'))).toBe(true);
  });

  it('registers the dealclaw-chatlog plugin regardless of plane', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
    });
    expect(config.plugins.entries['dealclaw-chatlog']?.enabled).toBe(true);
    expect(config.plugins.load.paths.some((p: string) => p.includes('dealclaw-chatlog'))).toBe(true);
  });
});

describe('write-config runtime tuning (queue / pruning / compaction / session)', () => {
  it('emits steer message queue, per-peer sessions and context safeguards by default', () => {
    const { config } = runWriteConfig({ LLM_PROVIDERS: PROVIDERS });
    expect(config.messages?.queue).toEqual({
      mode: 'steer', debounceMs: 1000, cap: 20, drop: 'summarize',
    });
    expect(config.session?.dmScope).toBe('per-channel-peer');
    expect(config.session?.maintenance?.pruneAfter).toBe('14d');
    const d = config.agents.defaults;
    expect(d.contextPruning?.mode).toBe('cache-ttl');
    expect(d.compaction?.mode).toBe('safeguard');
    expect(d.compaction?.model).toBe('deepseek/deepseek-chat');
    expect(d.contextLimits?.toolResultMaxChars).toBe(32000);
    expect(d.maxConcurrent).toBeGreaterThan(0);
  });

  it('honours escape-hatch envs (queue off, shared dmScope)', () => {
    const { config } = runWriteConfig({
      LLM_PROVIDERS: PROVIDERS,
      DEALCLAW_MESSAGE_QUEUE_MODE: 'off',
      DEALCLAW_SESSION_DM_SCOPE: 'shared',
    });
    // groupChat (history/visibility) is independent of the message queue:
    // DEALCLAW_MESSAGE_QUEUE_MODE=off only disables queue steer → strict FIFO,
    // it must not strip groupChat visibility config.
    expect(config.messages?.queue).toBeUndefined();
    expect(config.messages?.groupChat).toEqual({ historyLimit: 50, visibleReplies: 'automatic' });
    expect(config.session?.dmScope).toBe('shared');
  });
});

describe('write-config compaction model', () => {
  it('defaults compaction.model to the primary when no override is configured', () => {
    const { config } = runWriteConfig({ LLM_PROVIDERS: PROVIDERS });
    expect(config.agents.defaults.compaction?.model).toBe('deepseek/deepseek-chat');
  });

  it('honours llmDoc.compactionModel for agents.defaults.compaction.model', () => {
    const doc = JSON.stringify({
      providers: [{
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
        models: [{ id: 'deepseek-chat' }, { id: 'deepseek-flash' }],
      }],
      defaultModel: 'deepseek/deepseek-chat',
      compactionModel: 'deepseek/deepseek-flash',
    });
    const { config } = runWriteConfig({ LLM_PROVIDERS: doc });
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    expect(config.agents.defaults.compaction?.model).toBe('deepseek/deepseek-flash');
  });

  it('falls back to the primary (fail-open) when compactionModel does not resolve', () => {
    const doc = JSON.stringify({
      providers: [{
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
        models: [{ id: 'deepseek-chat' }],
      }],
      defaultModel: 'deepseek/deepseek-chat',
      compactionModel: 'kimi/moonshot',
    });
    const { config } = runWriteConfig({ LLM_PROVIDERS: doc });
    expect(config.agents.defaults.compaction?.model).toBe('deepseek/deepseek-chat');
  });
});

describe('write-config vision models', () => {
  const VISION_PROVIDERS = JSON.stringify({
    providers: [{
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-x',
      models: [
        { id: 'qwen-max' },
        { id: 'qwen-vl-plus', vision: true },
      ],
    }],
    defaultModel: 'qwen/qwen-max',
    imageModel: 'qwen/qwen-vl-plus',
  });

  it('marks the vision model with image input and emits agents.defaults.imageModel', () => {
    const { config } = runWriteConfig({ LLM_PROVIDERS: VISION_PROVIDERS });
    const models = config.models.providers.qwen.models;
    const text = models.find((m: any) => m.id === 'qwen-max');
    const vision = models.find((m: any) => m.id === 'qwen-vl-plus');
    expect(text.input).toEqual(['text']);
    expect(vision.input).toEqual(['text', 'image']);
    expect(config.agents.defaults.imageModel).toEqual({ primary: 'qwen/qwen-vl-plus' });
  });

  it('omits imageModel when no vision model is configured', () => {
    const { config } = runWriteConfig({ LLM_PROVIDERS: PROVIDERS });
    expect(config.agents.defaults.imageModel).toBeUndefined();
  });

  it('fails closed when imageModel points at a non-vision model', () => {
    const bad = JSON.stringify({
      providers: [{
        name: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-x',
        models: [{ id: 'qwen-max' }],
      }],
      defaultModel: 'qwen/qwen-max',
      imageModel: 'qwen/qwen-max',
    });
    expect(() => runWriteConfig({ LLM_PROVIDERS: bad })).toThrow();
  });
});
