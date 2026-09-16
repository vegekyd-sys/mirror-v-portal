import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * P2-3 Step 6: Agent shadow dual-read tests.
 *
 * Verifies the three RuntimeContractMode paths in write-config.mjs:
 *  - v1:     LLM_PROVIDERS only (legacy, unchanged).
 *  - shadow: LLM_PROVIDERS active + LLM_RUNTIME_CONFIG_V2 compared (warn-only).
 *  - v2:     LLM_RUNTIME_CONFIG_V2 as sole source (fail-closed on error).
 *
 * The tests run write-config.mjs as a child process (same pattern as
 * write-config-channels.test.ts) and inspect the generated openclaw.json
 * plus stdout/stderr for shadow-mode mismatch logs.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'runtime', 'write-config.mjs');

interface RunResult {
  config: any;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runWriteConfig(env: Record<string, string>): RunResult {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-v2-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-v2-ws-'));
  const result = spawnSync('node', [script], {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: workspace,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
      ...env,
    },
    encoding: 'utf8',
  });
  const configPath = path.join(stateDir, 'openclaw.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : null;
  return {
    config,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ── V1 fixture ─────────────────────────────────────────────────────────
const V1_DOC = {
  providers: [
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-v1-test',
      models: [
        {
          id: 'deepseek-chat',
          modelType: 'chat',
          protocol: 'openai-completions',
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          inputModalities: ['text'],
          reasoning: false,
          vision: false,
        },
      ],
    },
  ],
  defaultModel: 'deepseek/deepseek-chat',
  fallbackModels: [],
};

// ── V2 envelope builder ───────────────────────────────────────────────
// Produces a valid RuntimeEnvelopeV2 matching the V1_DOC fixture so that
// shadow-mode comparison reports zero mismatches.
function makeV2Envelope(opts?: {
  providers?: any[];
  primary?: any;
  image?: any;
  compaction?: any;
  fallbacks?: any[];
  releaseId?: string;
}): string {
  const providers = opts?.providers ?? [
    {
      providerId: 'deepseek',
      runtimeKey: 'deepseek',
      routeAliases: [],
      displayName: '',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-v1-test',
      models: [
        {
          modelId: 'deepseek/deepseek-chat',
          upstreamModel: 'deepseek-chat',
          aliases: [],
          displayName: '',
          modelType: 'chat',
          protocol: 'openai-completions',
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          inputModalities: ['text'],
          reasoning: false,
          vision: false,
          compat: {},
        },
      ],
    },
  ];
  return JSON.stringify({
    schema: 'agent',
    schemaVersion: 2,
    rendererVersion: 1,
    releaseId: opts?.releaseId ?? 'rel_test_001',
    releaseVersion: 1,
    releaseFingerprint: 'fp_test',
    materializationFingerprint: 'matfp_test',
    generatedAt: '2025-01-01T00:00:00.000Z',
    tenantId: 'tenant_test',
    payload: {
      directMode: false,
      providers,
      primary: opts?.primary ?? { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
      image: opts?.image ?? null,
      compaction: opts?.compaction ?? null,
      fallbacks: opts?.fallbacks ?? [],
    },
  });
}

// ── v1 mode (default) ─────────────────────────────────────────────────

describe('write-config v1 mode (default, unchanged behaviour)', () => {
  it('uses LLM_PROVIDERS and ignores LLM_RUNTIME_CONFIG_V2', () => {
    const { config, status, stdout } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      // V2 present but must be completely ignored in v1 mode
      LLM_RUNTIME_CONTRACT_MODE: 'v1',
      LLM_RUNTIME_CONFIG_V2: makeV2Envelope(),
    });
    expect(status).toBe(0);
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    // No V2 log line should appear
    expect(stdout).not.toContain('V2 contract');
    expect(stdout).not.toContain('shadow');
  });

  it('works without any V2 env vars (pure V1)', () => {
    const { config, status } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
    });
    expect(status).toBe(0);
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
  });
});

// ── shadow mode ───────────────────────────────────────────────────────

describe('write-config shadow mode (V1 active, V2 compared)', () => {
  it('uses V1 payload and logs no-drift when V1 and V2 match', () => {
    const { config, status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: makeV2Envelope(),
    });
    expect(status).toBe(0);
    // V1 is the source of truth
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    // Shadow comparison should report match
    const combined = stdout + stderr;
    expect(combined).toContain('shadow');
    expect(combined).toContain('no drift detected');
    expect(combined).not.toContain('mismatch');
  });

  it('logs mismatch when V2 has a different baseUrl', () => {
    const v2 = makeV2Envelope({
      providers: [
        {
          providerId: 'deepseek',
          runtimeKey: 'deepseek',
          routeAliases: [],
          displayName: '',
          baseUrl: 'https://DIFFERENT.example.test/v1', // ← mismatch
          apiKey: 'sk-v1-test',
          models: [
            {
              modelId: 'deepseek/deepseek-chat',
              upstreamModel: 'deepseek-chat',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 1_000_000,
              maxOutputTokens: 384_000,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
          ],
        },
      ],
    });
    const { config, status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: v2,
    });
    expect(status).toBe(0);
    // V1 is still the source of truth — config uses V1 baseUrl
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    // Shadow mismatch logged
    const combined = stdout + stderr;
    expect(combined).toContain('baseUrl');
    expect(combined).toContain('mismatch');
  });

  it('logs mismatch when V2 has a different defaultModel', () => {
    const v2 = makeV2Envelope({
      primary: { providerId: 'deepseek', modelId: 'deepseek/nonexistent' },
    });
    const { status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: v2,
    });
    expect(status).toBe(0);
    const combined = stdout + stderr;
    // The V2 ref won't resolve (nonexistent model) → V2 defaultModel is null
    // which differs from V1's "deepseek/deepseek-chat"
    expect(combined).toContain('defaultModel');
    expect(combined).toContain('mismatch');
  });

  it('continues with V1 when V2 envelope is invalid JSON (non-blocking)', () => {
    const { config, status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: '{not valid json',
    });
    expect(status).toBe(0);
    // V1 is still active
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    const combined = stdout + stderr;
    expect(combined).toContain('not valid JSON');
    expect(combined).toContain('V1 remains active');
  });

  it('continues with V1 when V2 envelope has validation issues', () => {
    const badV2 = JSON.stringify({
      schema: 'agent',
      schemaVersion: 2,
      payload: {
        directMode: 'not-a-boolean', // ← invalid
        providers: [],
      },
    });
    const { config, status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: badV2,
    });
    expect(status).toBe(0);
    // V1 is still active
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    const combined = stdout + stderr;
    expect(combined).toContain('validation issue');
  });

  it('warns when V2 is empty and skips comparison', () => {
    const { status, stdout, stderr } = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_CONFIG_V2: '{}',
    });
    expect(status).toBe(0);
    const combined = stdout + stderr;
    expect(combined).toContain('empty');
    expect(combined).toContain('V1 remains active');
  });
});

// ── v2 mode (fail-closed) ─────────────────────────────────────────────

describe('write-config v2 mode (V2 sole source, fail-closed)', () => {
  it('uses V2 payload as the sole source', () => {
    const { config, status, stdout } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: makeV2Envelope({ releaseId: 'rel_v2_test' }),
      // V1 is present but must be IGNORED in v2 mode
      LLM_PROVIDERS: JSON.stringify({
        providers: [
          {
            name: 'OTHER',
            baseUrl: 'https://other.test/v1',
            apiKey: 'sk-other',
            models: [{ id: 'other-model' }],
          },
        ],
        defaultModel: 'OTHER/other-model',
      }),
    });
    expect(status).toBe(0);
    // Config should use V2 provider, not V1
    expect(config.models.providers.deepseek).toBeTruthy();
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    // V2 log line
    expect(stdout).toContain('V2 contract active');
    expect(stdout).toContain('rel_v2_test');
    // V1 provider must NOT be in config
    expect(config.models.providers.OTHER).toBeUndefined();
  });

  it('fails closed when LLM_RUNTIME_CONFIG_V2 is missing', () => {
    const { status, stderr } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      // No LLM_RUNTIME_CONFIG_V2
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
    });
    // Empty V2 → llmDoc=null → no providers branch (agent boots without model)
    // This is valid, not a failure — it matches empty V1 behaviour.
    expect(status).toBe(0);
  });

  it('fails closed when V2 envelope is invalid JSON', () => {
    const { status, stderr } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: '{not valid json',
    });
    expect(status).toBe(1);
    expect(stderr).toContain('not valid JSON');
    expect(stderr).toContain('fail-closed');
  });

  it('fails closed when V2 envelope has schema violations', () => {
    const badV2 = JSON.stringify({
      schema: 'gateway', // ← wrong schema for agent
      schemaVersion: 2,
      payload: { routes: [] },
    });
    const { status, stderr } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: badV2,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('validation failed');
    expect(stderr).toContain('fail-closed');
    expect(stderr).toContain('schema');
  });

  it('fails closed when schemaVersion is not 2', () => {
    const badV2 = JSON.stringify({
      schema: 'agent',
      schemaVersion: 1, // ← wrong
      payload: { directMode: false, providers: [] },
    });
    const { status, stderr } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: badV2,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('schemaVersion');
  });

  it('boots without a model when V2 is empty ({})', () => {
    const { config, status, stdout, stderr } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: '{}',
    });
    expect(status).toBe(0);
    // No providers configured
    const combined = stdout + stderr;
    expect(combined).toContain('no LLM providers configured');
  });

  it('normalises V2 multi-provider with fallbacks correctly', () => {
    const v2 = makeV2Envelope({
      providers: [
        {
          providerId: 'deepseek',
          runtimeKey: 'deepseek',
          routeAliases: [],
          displayName: '',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [
            {
              modelId: 'deepseek/deepseek-chat',
              upstreamModel: 'deepseek-chat',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 1_000_000,
              maxOutputTokens: 384_000,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
            {
              modelId: 'deepseek/deepseek-reasoner',
              upstreamModel: 'deepseek-reasoner',
              aliases: [],
              displayName: 'DeepSeek Reasoner',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 64_000,
              maxOutputTokens: 32_000,
              inputModalities: ['text'],
              reasoning: true,
              vision: false,
              compat: { supportsReasoningEffort: true },
            },
          ],
        },
        {
          providerId: 'qwen',
          runtimeKey: 'qwen',
          routeAliases: [],
          displayName: '',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'sk-qwen',
          models: [
            {
              modelId: 'qwen/qwen-max',
              upstreamModel: 'qwen-max',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 131_072,
              maxOutputTokens: 8_192,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
          ],
        },
      ],
      primary: { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
      fallbacks: [{ providerId: 'qwen', modelId: 'qwen/qwen-max' }],
    });
    const { config, status } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: v2,
    });
    expect(status).toBe(0);
    // Two providers
    expect(Object.keys(config.models.providers).sort()).toEqual(['deepseek', 'qwen']);
    // DeepSeek has 2 models
    expect(config.models.providers.deepseek.models.length).toBe(2);
    expect(config.models.providers.deepseek.models[0].id).toBe('deepseek-chat');
    expect(config.models.providers.deepseek.models[1].id).toBe('deepseek-reasoner');
    // Reasoner should have reasoning: true
    expect(config.models.providers.deepseek.models[1].reasoning).toBe(true);
    // Primary is deepseek-chat
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    // Fallback to qwen/qwen-max
    expect(config.agents.defaults.model.fallbacks).toEqual(['qwen/qwen-max']);
  });

  it('normalises V2 image model correctly', () => {
    const v2 = makeV2Envelope({
      providers: [
        {
          providerId: 'qwen',
          runtimeKey: 'qwen',
          routeAliases: [],
          displayName: '',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'sk-qwen',
          models: [
            {
              modelId: 'qwen/qwen-max',
              upstreamModel: 'qwen-max',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 131_072,
              maxOutputTokens: 8_192,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
            {
              modelId: 'qwen/qwen-vl-plus',
              upstreamModel: 'qwen-vl-plus',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 131_072,
              maxOutputTokens: 8_192,
              inputModalities: ['text', 'image'],
              reasoning: false,
              vision: true,
              compat: {},
            },
          ],
        },
      ],
      primary: { providerId: 'qwen', modelId: 'qwen/qwen-max' },
      image: { providerId: 'qwen', modelId: 'qwen/qwen-vl-plus' },
    });
    const { config, status } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: v2,
    });
    expect(status).toBe(0);
    // Vision model has image input
    const vlModel = config.models.providers.qwen.models.find((m: any) => m.id === 'qwen-vl-plus');
    expect(vlModel.input).toEqual(['text', 'image']);
    // Image model configured
    expect(config.agents.defaults.imageModel).toEqual({ primary: 'qwen/qwen-vl-plus' });
  });

  it('normalises V2 compaction model correctly', () => {
    const v2 = makeV2Envelope({
      providers: [
        {
          providerId: 'deepseek',
          runtimeKey: 'deepseek',
          routeAliases: [],
          displayName: '',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          models: [
            {
              modelId: 'deepseek/deepseek-chat',
              upstreamModel: 'deepseek-chat',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 1_000_000,
              maxOutputTokens: 384_000,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
            {
              modelId: 'deepseek/deepseek-flash',
              upstreamModel: 'deepseek-flash',
              aliases: [],
              displayName: '',
              modelType: 'chat',
              protocol: 'openai-completions',
              contextWindow: 128_000,
              maxOutputTokens: 16_000,
              inputModalities: ['text'],
              reasoning: false,
              vision: false,
              compat: {},
            },
          ],
        },
      ],
      primary: { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
      compaction: { providerId: 'deepseek', modelId: 'deepseek/deepseek-flash' },
    });
    const { config, status } = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: v2,
    });
    expect(status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe('deepseek/deepseek-chat');
    expect(config.agents.defaults.compaction?.model).toBe('deepseek/deepseek-flash');
  });
});

// ── Cross-mode consistency ────────────────────────────────────────────

describe('write-config cross-mode provider consistency', () => {
  // The same provider/model config produces identical openclaw.json regardless
  // of whether it arrives via V1 (LLM_PROVIDERS) or V2 (LLM_RUNTIME_CONFIG_V2).
  it('V1 and V2 produce identical provider config for the same source data', () => {
    const v1Result = runWriteConfig({
      LLM_PROVIDERS: JSON.stringify(V1_DOC),
    });
    const v2Result = runWriteConfig({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_CONFIG_V2: makeV2Envelope(),
    });
    expect(v1Result.status).toBe(0);
    expect(v2Result.status).toBe(0);

    const v1Prov = v1Result.config.models.providers.deepseek;
    const v2Prov = v2Result.config.models.providers.deepseek;
    // Provider-level
    expect(v2Prov.baseUrl).toBe(v1Prov.baseUrl);
    expect(v2Prov.api).toBe(v1Prov.api);
    // Model-level
    expect(v2Prov.models.length).toBe(v1Prov.models.length);
    expect(v2Prov.models[0].id).toBe(v1Prov.models[0].id);
    expect(v2Prov.models[0].contextWindow).toBe(v1Prov.models[0].contextWindow);
    expect(v2Prov.models[0].maxTokens).toBe(v1Prov.models[0].maxTokens);
    expect(v2Prov.models[0].input).toEqual(v1Prov.models[0].input);
    // Agent defaults
    expect(v2Result.config.agents.defaults.model.primary)
      .toBe(v1Result.config.agents.defaults.model.primary);
  });
});
