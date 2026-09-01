import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => k8sMocks);

const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
}));

vi.mock('../services/crypto.js', () => cryptoMocks);

import {
  validateLlmProviders,
  modelExistsIn,
  visionModelExistsIn,
  getGlobalLlmProviders,
  getTenantModelSelection,
  resolveEffectiveLlmProviders,
  pushLlmProviders,
  effectiveRefIn,
  effectiveImageRefIn,
  effectiveFallbacksIn,
  effectiveFallbacksFor,
  providerCredentialSignature,
  tenantNeedsLlmRestart,
  LLM_PROVIDERS_KEY,
  LLM_MODEL_SELECTION_KEY,
} from '../services/llm-providers.js';
import { buildEnvFileContent } from '../services/skill-env.js';
import { createApp } from '../app.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-test',
  imageRegistry: 'test-registry/dealclaw',
  nexusGatewayImageTag: 'test',
  dealclawAgentImageTag: 'test',
  agentPvcSize: '10Gi',
  agentPvcStorageClass: 'alibabacloud-cnfs-nas',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
  ossBucket: 'dealclaw-backup',
  ossSecretName: 'dealclaw-oss',
  backupImage: 'test/ossutil',
  creditsLedgerUrl: 'http://credits-ledger:8081',
  creditsLedgerToken: '',
};
const prodConfig = { ...baseConfig, k8sDryRun: false, creditsLedgerToken: 'svc-token' };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const goodDoc = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk-qwen',
      models: [
        { id: 'qwen-max' },
        { id: 'qwq-plus', reasoning: true },
        { id: 'qwen-vl-plus', vision: true },
      ],
    },
    {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k-glm',
      models: ['glm-4.5'],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: 'qwen/qwen-vl-plus',
};

interface FakeQuery { sql: string; params?: unknown[] }

function makeFakePool(opts: {
  tenant?: Record<string, any> | null;
  allTenants?: Array<{ tenant_id: string }>;
  tenantSelectionRow?: { encrypted_value: string }[];
  globalLlmRow?: { encrypted_value: string }[];
  globalRows?: any[];
  tenantRows?: any[];
  deleteRowCount?: number;
} = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT 1 FROM tenants')) {
        return { rows: opts.tenant === null ? [] : [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT tenant_id FROM tenants')) {
        return { rows: opts.allTenants ?? [], rowCount: (opts.allTenants ?? []).length };
      }
      if (sql.includes('SELECT k8s_namespace FROM tenants')) {
        return { rows: opts.tenant ? [opts.tenant] : [], rowCount: opts.tenant ? 1 : 0 };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: opts.tenant ? [opts.tenant] : [], rowCount: opts.tenant ? 1 : 0 };
      }
      if (sql.includes('AND config_key = $1') || sql.includes('AND config_key = $2')) {
        if (sql.includes('tenant_id = $1')) {
          // tenant-scope lookup — distinguish selection vs legacy provider rows
          const key = params && params[1];
          if (key === LLM_MODEL_SELECTION_KEY) {
            return { rows: opts.tenantSelectionRow ?? [], rowCount: (opts.tenantSelectionRow ?? []).length };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: opts.globalLlmRow ?? [], rowCount: (opts.globalLlmRow ?? []).length };
      }
      if (sql.includes('INSERT INTO runtime_configs')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM runtime_configs')) {
        return { rows: [], rowCount: opts.deleteRowCount ?? 1 };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id IS NULL')) {
        return { rows: opts.globalRows ?? [], rowCount: (opts.globalRows ?? []).length };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id = $1')) {
        return { rows: opts.tenantRows ?? [], rowCount: (opts.tenantRows ?? []).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

const makeTenant = (overrides: Record<string, any> = {}) => ({
  tenant_id: 't123',
  status: 'active',
  k8s_namespace: 'dealclaw-t123',
  agent_endpoint: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  k8sMocks.getSecret.mockResolvedValue(null);
  k8sMocks.deploymentExists.mockResolvedValue(true);
  k8sMocks.restartDeployment.mockResolvedValue(true);
  k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(false);
});

// ── validateLlmProviders ─────────────────────────────────────────────

describe('validateLlmProviders', () => {
  it('normalises a good document (mixed model formats, trailing slash)', () => {
    const doc = validateLlmProviders(goodDoc);
    expect(doc.providers).toHaveLength(2);
    expect(doc.providers[0].baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(doc.providers[0].models[1]).toEqual({ id: 'qwq-plus', reasoning: true });
    expect(doc.providers[0].models[2]).toEqual({ id: 'qwen-vl-plus', vision: true });
    expect(doc.providers[1].models).toEqual([{ id: 'glm-4.5' }]);
    expect(doc.defaultModel).toBe('qwen/qwen-max');
    expect(doc.imageModel).toBe('qwen/qwen-vl-plus');
  });

  it('rejects duplicate provider names', () => {
    expect(() =>
      validateLlmProviders({
        providers: [
          { name: 'qwen', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'] },
          { name: 'qwen', baseUrl: 'https://b.com', apiKey: 'k', models: ['m'] },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('rejects invalid provider names', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'BadName', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'] }] }),
    ).toThrow(/提供商 ID/);
  });

  it('rejects non-http baseUrls', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'ftp://a.com', apiKey: 'k', models: ['m'] }] }),
    ).toThrow(/Base URL/);
  });

  it('rejects empty provider lists entries without apiKey or models', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'https://a.com', apiKey: '', models: ['m'] }] }),
    ).toThrow(/API Key/);
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'https://a.com', apiKey: 'k', models: [] }] }),
    ).toThrow(/至少需要 1 个模型/);
  });

  it('rejects a defaultModel outside the configured providers', () => {
    expect(() =>
      validateLlmProviders({ ...goodDoc, defaultModel: 'other/m9' }),
    ).toThrow(/默认模型/);
  });

  it('rejects an imageModel outside the library or not vision-marked', () => {
    expect(() =>
      validateLlmProviders({ ...goodDoc, imageModel: 'other/m9' }),
    ).toThrow(/视觉模型/);
    expect(() =>
      validateLlmProviders({ ...goodDoc, imageModel: 'qwen/qwen-max' }),
    ).toThrow(/未标记为视觉模型/);
  });

  it('modelExistsIn matches only real provider/model pairs', () => {
    const doc = validateLlmProviders(goodDoc);
    expect(modelExistsIn(doc, 'qwen/qwen-max')).toBe(true);
    expect(modelExistsIn(doc, 'glm/glm-4.5')).toBe(true);
    expect(modelExistsIn(doc, 'qwen/nope')).toBe(false);
    expect(modelExistsIn(doc, 'nope/qwen-max')).toBe(false);
    expect(modelExistsIn(doc, 'dangling')).toBe(false);
  });

  it('visionModelExistsIn requires the vision flag', () => {
    const doc = validateLlmProviders(goodDoc);
    expect(visionModelExistsIn(doc, 'qwen/qwen-vl-plus')).toBe(true);
    expect(visionModelExistsIn(doc, 'qwen/qwen-max')).toBe(false);
    expect(visionModelExistsIn(doc, 'qwen/nope')).toBe(false);
  });
});

// ── fallbackModels validation ────────────────────────────────────────

describe('validateLlmProviders fallbackModels', () => {
  it('defaults to an empty chain and preserves a valid ordered chain', () => {
    expect(validateLlmProviders(goodDoc).fallbackModels).toEqual([]);
    const doc = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['glm/glm-4.5', 'qwen/qwq-plus'],
    });
    expect(doc.fallbackModels).toEqual(['glm/glm-4.5', 'qwen/qwq-plus']);
  });

  it('deduplicates and drops blank entries', () => {
    const doc = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['glm/glm-4.5', '', 'glm/glm-4.5', 'qwen/qwq-plus'],
    });
    expect(doc.fallbackModels).toEqual(['glm/glm-4.5', 'qwen/qwq-plus']);
  });

  it('rejects references outside the configured providers', () => {
    expect(() =>
      validateLlmProviders({ ...goodDoc, fallbackModels: ['kimi/moonshot'] }),
    ).toThrow(/不在已配置的提供商\/模型列表中/);
    expect(() =>
      validateLlmProviders({ ...goodDoc, fallbackModels: ['qwen/nope'] }),
    ).toThrow(/不在已配置的提供商\/模型列表中/);
  });

  it('rejects the primary model inside the chain', () => {
    expect(() =>
      validateLlmProviders({ ...goodDoc, fallbackModels: ['qwen/qwen-max'] }),
    ).toThrow(/与默认模型相同/);
  });

  it('rejects more than 5 fallbacks and non-array values', () => {
    const sixModelDoc = {
      ...goodDoc,
      imageModel: null,
      providers: [
        {
          name: 'qwen',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'sk-qwen',
          models: ['qwen-max', 'm1', 'm2', 'm3', 'm4', 'm5'],
        },
        goodDoc.providers[1],
      ],
    };
    expect(() =>
      validateLlmProviders({
        ...sixModelDoc,
        fallbackModels: ['qwen/m1', 'qwen/m2', 'qwen/m3', 'qwen/m4', 'qwen/m5', 'glm/glm-4.5'],
      }),
    ).toThrow(/备用模型最多/);
    expect(() =>
      validateLlmProviders({ ...goodDoc, fallbackModels: 'glm/glm-4.5' } as any),
    ).toThrow(/fallbackModels 必须是数组/);
  });
});

// ── effectiveFallbacksIn ─────────────────────────────────────────────

describe('effectiveFallbacksIn', () => {
  const doc = validateLlmProviders({
    ...goodDoc,
    fallbackModels: ['glm/glm-4.5', 'qwen/qwq-plus', 'qwen/qwen-vl-plus'],
  });

  it('filters out the effective primary (selection wins)', () => {
    // selection=glm → glm removed from chain
    expect(effectiveFallbacksIn(doc, 'glm/glm-4.5')).toEqual(['qwen/qwq-plus', 'qwen/qwen-vl-plus']);
    // no selection → global default qwen/qwen-max stays out of the chain anyway
    expect(effectiveFallbacksIn(doc, null)).toEqual(['glm/glm-4.5', 'qwen/qwq-plus', 'qwen/qwen-vl-plus']);
  });

  it('drops refs that no longer resolve inside the document', () => {
    // 存量数据可能漂移（例如库曾被别处改写）：校验只发生在 PUT 时，
    // effectiveFallbacksIn 读取时必须防御性过滤失效引用。
    const stale = {
      providers: goodDoc.providers.filter((p) => p.name !== 'glm'),
      defaultModel: 'qwen/qwen-max',
      imageModel: 'qwen/qwen-vl-plus',
      fallbackModels: ['glm/glm-4.5', 'qwen/qwq-plus'],
    } as ReturnType<typeof validateLlmProviders>;
    expect(effectiveFallbacksIn(stale, null)).toEqual(['qwen/qwq-plus']);
  });

  it('returns an empty chain for null docs or empty chains', () => {
    expect(effectiveFallbacksIn(null, 'qwen/qwen-max')).toEqual([]);
    expect(effectiveFallbacksIn(validateLlmProviders(goodDoc), null)).toEqual([]);
  });
});

// ── effectiveFallbacksFor (tenant override) ─────────────────────────

describe('effectiveFallbacksFor', () => {
  const doc = validateLlmProviders({
    ...goodDoc,
    fallbackModels: ['glm/glm-4.5', 'qwen/qwq-plus'],
  });

  it('null selection falls back to the library chain', () => {
    expect(effectiveFallbacksFor(doc, null)).toEqual(['glm/glm-4.5', 'qwen/qwq-plus']);
    expect(effectiveFallbacksFor(doc, { defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: null, directMode: false }))
      .toEqual(['glm/glm-4.5', 'qwen/qwq-plus']);
  });

  it('a tenant chain overrides the library chain (even when empty)', () => {
    expect(
      effectiveFallbacksFor(doc, { defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: ['qwen/qwen-vl-plus'], directMode: false }),
    ).toEqual(['qwen/qwen-vl-plus']);
    // empty own chain = never fall back
    expect(
      effectiveFallbacksFor(doc, { defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [], directMode: false }),
    ).toEqual([]);
  });

  it('filters the tenant primary and unresolvable refs out of the tenant chain', () => {
    // primary = glm → dropped from chain; stale 'qwen/nope' dropped defensively
    expect(
      effectiveFallbacksFor(doc, { defaultModel: 'glm/glm-4.5', imageModel: null, compactionModel: null, fallbackModels: ['glm/glm-4.5', 'qwen/nope', 'qwen/qwq-plus'], directMode: false }),
    ).toEqual(['qwen/qwq-plus']);
  });
});

// ── library + selection resolution ───────────────────────────────────

describe('resolveEffectiveLlmProviders', () => {
  it('returns an empty result when no global library exists', async () => {
    const pool = makeFakePool();
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.globalConfig).toBeNull();
    expect(r.selection).toBeNull();
    expect(r.effectiveModel).toBeNull();
    expect(r.blob).toBeNull();
  });

  it('uses the global default when the tenant has no selection', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.selection).toBeNull();
    expect(r.effectiveModel).toBe('qwen/qwen-max');
    expect(JSON.parse(r.blob!).defaultModel).toBe('qwen/qwen-max');
    expect(JSON.parse(r.blob!).providers).toHaveLength(2);
    expect(r.effectiveFallbacks).toEqual([]);
  });

  it('materialises the fallback chain into the blob (minus the effective primary)', async () => {
    const pool = makeFakePool({
      globalLlmRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({ ...goodDoc, fallbackModels: ['glm/glm-4.5', 'qwen/qwq-plus'] }),
        },
      ],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.effectiveModel).toBe('glm/glm-4.5');
    // selection wins → primary glm removed from the chain
    expect(r.effectiveFallbacks).toEqual(['qwen/qwq-plus']);
    expect(JSON.parse(r.blob!).fallbackModels).toEqual(['qwen/qwq-plus']);
  });

  it('materialises the TENANT fallback chain when the tenant overrides it', async () => {
    const pool = makeFakePool({
      globalLlmRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({ ...goodDoc, fallbackModels: ['glm/glm-4.5'] }),
        },
      ],
      tenantSelectionRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({ defaultModel: 'qwen/qwen-max', fallbackModels: ['qwen/qwq-plus', 'qwen/qwen-vl-plus'] }),
        },
      ],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.fallbackSelection).toEqual(['qwen/qwq-plus', 'qwen/qwen-vl-plus']);
    // tenant chain (not the library's [glm]) is what gets baked
    expect(r.effectiveFallbacks).toEqual(['qwen/qwq-plus', 'qwen/qwen-vl-plus']);
    expect(JSON.parse(r.blob!).fallbackModels).toEqual(['qwen/qwq-plus', 'qwen/qwen-vl-plus']);
  });

  it('an EMPTY tenant chain disables fallbacks even when the library has one', async () => {
    const pool = makeFakePool({
      globalLlmRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({ ...goodDoc, fallbackModels: ['glm/glm-4.5'] }),
        },
      ],
      tenantSelectionRow: [
        { encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'qwen/qwen-max', fallbackModels: [] }) },
      ],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.fallbackSelection).toEqual([]);
    expect(r.effectiveFallbacks).toEqual([]);
    expect(JSON.parse(r.blob!).fallbackModels).toEqual([]);
  });

  it('prefers a resolvable tenant selection over the global default', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.selection).toBe('glm/glm-4.5');
    expect(r.effectiveModel).toBe('glm/glm-4.5');
  });

  it('ignores a selection whose provider was removed from the library', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'kimi/moonshot' }) }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.selection).toBeNull();
    expect(r.effectiveModel).toBe('qwen/qwen-max');
  });

  it('compaction follows the effective primary when no override is set', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.compactionSelection).toBeNull();
    expect(r.effectiveCompactionModel).toBe('glm/glm-4.5');
    // blob carries the resolved compaction model for write-config.mjs
    expect(JSON.parse(r.blob!).compactionModel).toBe('glm/glm-4.5');
  });

  it('a tenant compaction override wins over the primary and lands in the blob', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{
        encrypted_value: 'enc:' + JSON.stringify({
          defaultModel: 'qwen/qwen-max',
          compactionModel: 'glm/glm-4.5',
        }),
      }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.compactionSelection).toBe('glm/glm-4.5');
    expect(r.effectiveModel).toBe('qwen/qwen-max');
    expect(r.effectiveCompactionModel).toBe('glm/glm-4.5');
    expect(JSON.parse(r.blob!).compactionModel).toBe('glm/glm-4.5');
  });

  it('an unresolvable compaction override falls back to the effective primary', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{
        encrypted_value: 'enc:' + JSON.stringify({
          defaultModel: 'qwen/qwen-max',
          compactionModel: 'kimi/moonshot',
        }),
      }],
    });
    const r = await resolveEffectiveLlmProviders(pool, 't123');
    expect(r.compactionSelection).toBeNull();
    expect(r.effectiveCompactionModel).toBe('qwen/qwen-max');
  });

  it('getTenantModelSelection tolerates corrupt rows', async () => {
    const pool = makeFakePool({
      tenantSelectionRow: [{ encrypted_value: 'enc:not-json' }],
    });
    expect(await getTenantModelSelection(pool, 't123')).toBeNull();
  });

  it('getGlobalLlmProviders returns null for corrupt data', async () => {
    const pool = makeFakePool({ globalLlmRow: [{ encrypted_value: 'enc:{broken' }] });
    expect(await getGlobalLlmProviders(pool)).toBeNull();
  });
});

// ── differential restart decision ────────────────────────────────────

describe('tenantNeedsLlmRestart', () => {
  const prev = validateLlmProviders(goodDoc);
  const withExtraProvider = validateLlmProviders({
    ...goodDoc,
    providers: [
      ...goodDoc.providers,
      { name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-kimi', models: ['moonshot-v1-8k'] },
    ],
  });
  const withNewDefault = validateLlmProviders({ ...goodDoc, defaultModel: 'glm/glm-4.5' });
  const withRotatedQwenKey = validateLlmProviders({
    ...goodDoc,
    providers: goodDoc.providers.map((p) => (p.name === 'qwen' ? { ...p, apiKey: 'sk-qwen-v2' } : p)),
  });
  const withoutQwen = validateLlmProviders({
    providers: goodDoc.providers.filter((p) => p.name !== 'qwen'),
    defaultModel: 'glm/glm-4.5',
  });

  it('effectiveRefIn: selection wins, then global default, null for empty lib', () => {
    expect(effectiveRefIn(prev, 'glm/glm-4.5')).toBe('glm/glm-4.5');
    expect(effectiveRefIn(prev, null)).toBe('qwen/qwen-max');
    expect(effectiveRefIn(prev, 'kimi/nope')).toBe('qwen/qwen-max'); // unresolvable → default
    expect(effectiveRefIn(null, 'glm/glm-4.5')).toBeNull();
  });

  it('effectiveImageRefIn: tenant image selection wins, then global, null otherwise', () => {
    expect(effectiveImageRefIn(prev, null)).toBe('qwen/qwen-vl-plus');
    expect(effectiveImageRefIn(prev, 'qwen/qwen-vl-plus')).toBe('qwen/qwen-vl-plus');
    // non-vision model never qualifies as an image model
    expect(effectiveImageRefIn(prev, 'qwen/qwen-max')).toBe('qwen/qwen-vl-plus');
    expect(effectiveImageRefIn(null, 'qwen/qwen-vl-plus')).toBeNull();
  });

  it('providerCredentialSignature ignores models, tracks baseUrl+apiKey', () => {
    expect(providerCredentialSignature(prev, 'qwen/qwen-max')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1|sk-qwen',
    );
    // model id is not part of the signature
    expect(providerCredentialSignature(prev, 'qwen/qwq-plus')).toBe(
      providerCredentialSignature(prev, 'qwen/qwen-max'),
    );
    expect(providerCredentialSignature(null, 'qwen/qwen-max')).toBeNull();
  });

  const sel = (
    defaultModel: string | null,
    imageModel: string | null = null,
    fallbackModels: string[] | null = null,
    compactionModel: string | null = null,
  ) => ({ defaultModel, imageModel, compactionModel, fallbackModels, directMode: false });

  it('adding an unrelated provider does NOT require a restart', () => {
    expect(tenantNeedsLlmRestart(prev, withExtraProvider, null)).toBe(false);
    expect(tenantNeedsLlmRestart(prev, withExtraProvider, sel('glm/glm-4.5'))).toBe(false);
  });

  it('switching the global default requires a restart for followers', () => {
    expect(tenantNeedsLlmRestart(prev, withNewDefault, null)).toBe(true);
    // a tenant with its own selection is immune to the default switch
    expect(tenantNeedsLlmRestart(prev, withNewDefault, sel('qwen/qwen-max'))).toBe(false);
  });

  it('rotating the credentials of the selected provider requires a restart', () => {
    expect(tenantNeedsLlmRestart(prev, withRotatedQwenKey, sel('qwen/qwen-max'))).toBe(true);
    // a tenant on a different PRIMARY provider is still affected when its
    // image model follows the global qwen vision model (credentials rotate)
    expect(tenantNeedsLlmRestart(prev, withRotatedQwenKey, sel('glm/glm-4.5'))).toBe(true);
  });

  it('removing the selected provider falls back and requires a restart', () => {
    expect(tenantNeedsLlmRestart(prev, withoutQwen, sel('qwen/qwen-max'))).toBe(true);
    // glm primary is untouched, but the global qwen vision model is gone → fallback
    expect(tenantNeedsLlmRestart(prev, withoutQwen, sel('glm/glm-4.5'))).toBe(true);
  });

  it('switching the global image model requires a restart for followers', () => {
    const withNewImage = validateLlmProviders({ ...goodDoc, imageModel: 'qwen/qwen-vl-plus' });
    const withOtherImage = validateLlmProviders({
      ...goodDoc,
      providers: goodDoc.providers.map((p) =>
        p.name === 'qwen'
          ? { ...p, models: [...p.models, { id: 'qwen-vl-max', vision: true }] }
          : p,
      ),
      imageModel: 'qwen/qwen-vl-max',
    });
    expect(tenantNeedsLlmRestart(withNewImage, withOtherImage, null)).toBe(true);
    // a tenant that pinned its own image model is immune to the global switch
    expect(
      tenantNeedsLlmRestart(withNewImage, withOtherImage, sel(null, 'qwen/qwen-vl-plus')),
    ).toBe(false);
  });

  it('removing the vision model from the library requires a restart', () => {
    const noVision = validateLlmProviders({
      providers: goodDoc.providers.map((p) =>
        p.name === 'qwen'
          ? {
              ...p,
              models: (p.models as Array<{ id: string; reasoning?: boolean; vision?: boolean }>).filter(
                (m) => m.id !== 'qwen-vl-plus',
              ),
            }
          : p,
      ),
      defaultModel: 'qwen/qwen-max',
      imageModel: null,
    });
    expect(tenantNeedsLlmRestart(prev, noVision, null)).toBe(true);
  });

  it('identical libraries never require a restart; empty→empty neither', () => {
    expect(tenantNeedsLlmRestart(prev, prev, sel('glm/glm-4.5'))).toBe(false);
    expect(tenantNeedsLlmRestart(null, null, null)).toBe(false);
  });

  it('changing the fallback chain requires a restart for followers', () => {
    const withChain = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['glm/glm-4.5'],
    });
    // chain added → the baked fallbacks in openclaw.json change
    expect(tenantNeedsLlmRestart(prev, withChain, null)).toBe(true);
    // chain removed → also a restart
    expect(tenantNeedsLlmRestart(withChain, prev, null)).toBe(true);
  });

  it('a tenant whose selection equals a chain member is unaffected when the chain changes around it', () => {
    // prev chain [glm], now chain [qwq]: tenant on glm primary sees chain
    // [qwq] vs [] (glm filtered out as primary) → restart
    const withOtherChain = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['qwen/qwq-plus'],
    });
    const prevChain = validateLlmProviders({ ...goodDoc, fallbackModels: ['glm/glm-4.5'] });
    expect(tenantNeedsLlmRestart(prevChain, withOtherChain, sel('glm/glm-4.5'))).toBe(true);
    // same doc, tenant selection qwen-max: chain [glm] vs [qwq] differ → restart
    expect(tenantNeedsLlmRestart(prevChain, withOtherChain, sel('qwen/qwen-max'))).toBe(true);
  });

  it('rotating credentials of a fallback-chain provider requires a restart', () => {
    const prevChain = validateLlmProviders({ ...goodDoc, fallbackModels: ['glm/glm-4.5'] });
    const rotatedGlm = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['glm/glm-4.5'],
      providers: goodDoc.providers.map((p) => (p.name === 'glm' ? { ...p, apiKey: 'k-glm-v2' } : p)),
    });
    // primary is qwen with unchanged credentials; only the fallback provider rotated
    expect(tenantNeedsLlmRestart(prevChain, rotatedGlm, null)).toBe(true);
  });

  it('a tenant with its own chain is immune to GLOBAL chain changes', () => {
    const withGlobalChain = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['glm/glm-4.5'],
    });
    const withOtherGlobalChain = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['qwen/qwq-plus'],
    });
    const tenantChain = sel('qwen/qwen-max', null, ['glm/glm-4.5']);
    // library chain changed, but the tenant pinned its own chain → no restart
    expect(tenantNeedsLlmRestart(withGlobalChain, withOtherGlobalChain, tenantChain)).toBe(false);
    // same library, tenant chain present both sides → no restart
    expect(tenantNeedsLlmRestart(withGlobalChain, withGlobalChain, tenantChain)).toBe(false);
  });

  it('a tenant with its own chain restarts when a chain provider credential rotates', () => {
    const doc = validateLlmProviders({ ...goodDoc, fallbackModels: ['qwen/qwq-plus'] });
    const rotated = validateLlmProviders({
      ...goodDoc,
      fallbackModels: ['qwen/qwq-plus'],
      providers: goodDoc.providers.map((p) => (p.name === 'glm' ? { ...p, apiKey: 'k-glm-v2' } : p)),
    });
    // tenant chain [glm] (qwen/qwen-max primary); glm credentials rotated
    expect(tenantNeedsLlmRestart(doc, rotated, sel('qwen/qwen-max', null, ['glm/glm-4.5']))).toBe(true);
  });

  it('a tenant chain referencing a removed provider shrinks and requires a restart', () => {
    // library without glm; tenant chain [glm, qwq] → effective [qwq] → changed
    expect(tenantNeedsLlmRestart(prev, withoutQwen, sel('qwen/qwen-max', null, ['glm/glm-4.5', 'qwen/qwq-plus']))).toBe(true);
  });
});

// ── pushLlmProviders ─────────────────────────────────────────────────

describe('pushLlmProviders', () => {
  it('rewrites provider baseUrls to the proxy, writes the upstream map and rolls BOTH agent + gateway', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    k8sMocks.getSecret.mockResolvedValue({
      data: {
        DEEPSEEK_API_KEY: b64('sk-ds'),
        LLM_PROVIDERS: b64('{"providers":[{"name":"old"}]}'),
        APIFY_TOKEN: b64('stale-skill-key'),
      },
    });
    const r = await pushLlmProviders(pool, prodConfig, 't123');
    expect(r.tenants[0]).toMatchObject({ tenantId: 't123', ok: true, restarted: true, gatewayRestarted: true });

    // call 0: tenant-config — blob with PROXY baseUrls, apiKey untouched;
    // the deprecated DEEPSEEK_API_KEY is dropped (no longer envFrom-only)
    const tenantConfigArg = k8sMocks.putSecret.mock.calls[0][2];
    expect(tenantConfigArg.DEEPSEEK_API_KEY).toBeUndefined();
    expect(tenantConfigArg.APIFY_TOKEN).toBeUndefined();
    const blob = JSON.parse(tenantConfigArg.LLM_PROVIDERS);
    expect(blob.defaultModel).toBe('glm/glm-4.5'); // tenant selection wins
    expect(blob.providers).toHaveLength(2); // library providers, full credentials
    expect(blob.providers[0].baseUrl).toBe('http://nexus-gateway-t123:8080/v1/llm/qwen');
    expect(blob.providers[1].baseUrl).toBe('http://nexus-gateway-t123:8080/v1/llm/glm');
    expect(blob.providers[0].apiKey).toBe('sk-qwen'); // Authorization passthrough

    // call 1: llm-proxy-config — REAL baseUrls live here
    expect(k8sMocks.putSecret.mock.calls[1][1]).toBe('llm-proxy-config');
    const upstreams = JSON.parse(k8sMocks.putSecret.mock.calls[1][2].LLM_UPSTREAMS);
    expect(upstreams).toEqual({
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      glm: 'https://open.bigmodel.cn/api/paas/v4',
    });

    // call 2: credits backfill — shared ledger token for usage reports
    expect(k8sMocks.putSecret.mock.calls[2][1]).toBe('dealclaw-credits-t123');
    expect(k8sMocks.putSecret.mock.calls[2][2].CREDITS_LEDGER_TOKEN).toBeTruthy();

    // retro-fit envFrom for pre-proxy gateways (idempotent patch)
    expect(k8sMocks.patchDeploymentEnvFromSecret).toHaveBeenCalledWith(
      'dealclaw-t123', 'nexus-gateway-t123', 'llm-proxy-config',
    );
    // double roll: agent (new blob) + gateway (upstream map)
    expect(k8sMocks.restartDeployment).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-t123');
    expect(k8sMocks.restartDeployment).toHaveBeenCalledWith('dealclaw-t123', 'nexus-gateway-t123');
    expect(r.hint).toContain('滚动重启');
    expect(r.hint).toContain('网关已滚动');
  });

  it('removes the blob from tenant-config when the library is empty (upstream map cleared too)', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      // no global library → removal path (agent boots without a model)
    });
    k8sMocks.getSecret.mockResolvedValue({
      data: { DEEPSEEK_API_KEY: b64('sk-ds'), LLM_PROVIDERS: b64('{}') },
    });
    const r = await pushLlmProviders(pool, prodConfig, 't123');
    expect(r.tenants[0].ok).toBe(true);
    // envFrom-only keys = {LLM_PROVIDERS} only; DEEPSEEK_API_KEY is
    // deprecated and stripped — the secret is rewritten empty.
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'tenant-config', {});
    // stale upstream mappings must not linger in llm-proxy-config
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'llm-proxy-config', {
      LLM_UPSTREAMS: '{}',
    });
  });

  it('targets every live tenant for the global scope and purges legacy tenant rows', async () => {
    const pool = makeFakePool({
      allTenants: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      tenant: makeTenant({ tenant_id: 't1' }),
      globalRows: [{ config_key: LLM_PROVIDERS_KEY, encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    k8sMocks.getSecret.mockResolvedValue({ data: { DEEPSEEK_API_KEY: b64('sk-ds') } });
    const r = await pushLlmProviders(pool, prodConfig, null);
    expect(r.tenants).toHaveLength(2);
    // 2 tenants × 3 secrets (tenant-config + llm-proxy-config + credits backfill)
    expect(k8sMocks.putSecret).toHaveBeenCalledTimes(6);
    const legacyDelete = pool.queries.find(
      (q: FakeQuery) =>
        q.sql.includes('DELETE FROM runtime_configs') && q.sql.includes('tenant_id IS NOT NULL'),
    );
    expect(legacyDelete).toBeTruthy();
    expect(legacyDelete!.params![0]).toBe(LLM_PROVIDERS_KEY);
  });

  it('global write skips the roll for tenants whose live model is unchanged', async () => {
    // library gains an unrelated provider; tenant stays on glm with the same key
    const pool = makeFakePool({
      allTenants: [{ tenant_id: 't1' }],
      tenant: makeTenant({ tenant_id: 't1', k8s_namespace: 'dealclaw-t1' }),
      globalLlmRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({
              ...goodDoc,
              providers: [
                ...goodDoc.providers,
                { name: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-kimi', models: ['moonshot-v1-8k'] },
              ],
            }),
        },
      ],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    k8sMocks.getSecret.mockResolvedValue({ data: { DEEPSEEK_API_KEY: b64('sk-ds') } });
    const prev = validateLlmProviders(goodDoc);
    const r = await pushLlmProviders(pool, prodConfig, null, prev);
    expect(r.tenants[0]).toMatchObject({ tenantId: 't1', ok: true, restarted: false, gatewayRestarted: false });
    expect(k8sMocks.restartDeployment).not.toHaveBeenCalled();
    // Secret still materialised (invisible sync) + self-healing passes preserved
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t1', 'tenant-config', expect.anything());
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t1', 'dealclaw-credits-t1', expect.anything());
    expect(r.hint).toContain('跳过重启');
  });

  it('global write rolls a tenant whose selected provider credentials changed', async () => {
    const pool = makeFakePool({
      allTenants: [{ tenant_id: 't1' }],
      tenant: makeTenant({ tenant_id: 't1', k8s_namespace: 'dealclaw-t1' }),
      globalLlmRow: [
        {
          encrypted_value:
            'enc:' +
            JSON.stringify({
              ...goodDoc,
              providers: goodDoc.providers.map((p) =>
                p.name === 'qwen' ? { ...p, apiKey: 'sk-qwen-v2' } : p,
              ),
            }),
        },
      ],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'qwen/qwen-max' }) }],
    });
    k8sMocks.getSecret.mockResolvedValue({ data: { DEEPSEEK_API_KEY: b64('sk-ds') } });
    const prev = validateLlmProviders(goodDoc);
    const r = await pushLlmProviders(pool, prodConfig, null, prev);
    expect(r.tenants[0]).toMatchObject({ tenantId: 't1', ok: true, restarted: true, gatewayRestarted: true });
    expect(k8sMocks.restartDeployment).toHaveBeenCalledWith('dealclaw-t1', 'dealclaw-agent-t1');
    expect(r.hint).toContain('滚动重启');
  });
});

// ── .env isolation ───────────────────────────────────────────────────

describe('buildEnvFileContent excludes LLM keys', () => {
  it('never leaks the provider blob or the selection into the hot .env', () => {
    const r = buildEnvFileContent({
      APIFY_TOKEN: 'tok',
      LLM_PROVIDERS: JSON.stringify(goodDoc),
      LLM_MODEL_SELECTION: JSON.stringify({ defaultModel: 'qwen/qwen-max' }),
    });
    expect(r.content).toBe('APIFY_TOKEN=tok\n');
  });
});

// ── API (dry-run config) ─────────────────────────────────────────────

describe('llm-providers API', () => {
  const authHeader = { Authorization: 'Bearer test-token' };
  const savedToken = process.env.PROVISIONING_API_TOKEN;

  beforeEach(() => {
    process.env.PROVISIONING_API_TOKEN = 'test-token';
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.PROVISIONING_API_TOKEN;
    else process.env.PROVISIONING_API_TOKEN = savedToken;
  });

  it('requires bearer auth', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    expect((await request(app).get('/v1/admin/llm-providers')).status).toBe(401);
    expect((await request(app).put('/v1/admin/llm-providers').send(goodDoc)).status).toBe(401);
    expect((await request(app).delete('/v1/admin/llm-providers')).status).toBe(401);
    expect(
      (await request(app).get('/v1/admin/llm-providers/selection?tenantId=t123')).status,
    ).toBe(401);
    expect(
      (await request(app).put('/v1/admin/llm-providers/selection').send({ tenantId: 't123' }))
        .status,
    ).toBe(401);
  });

  it('PUT validates and stores the encrypted GLOBAL blob, returning a push hint', async () => {
    const pool = makeFakePool({ allTenants: [] });
    const app = createApp(pool, baseConfig);
    const res = await request(app).put('/v1/admin/llm-providers').set(authHeader).send(goodDoc);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.push.hint).toBeTruthy();
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    // stored via the crypto layer, never plaintext (mock prefixes enc:)
    const stored = String(insert!.params![1]);
    expect(stored).toMatch(/^enc:/);
    expect(JSON.parse(stored.slice(4)).providers[0].name).toBe('qwen');
  });

  it('PUT rejects invalid documents with 400', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers')
      .set(authHeader)
      .send({ providers: [{ name: 'X', baseUrl: 'nope', apiKey: '', models: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('GET returns the global library (null when unconfigured)', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app).get('/v1/admin/llm-providers').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ config: null, effectiveModel: null, selection: null });
  });

  it('DELETE 404s when no library row exists', async () => {
    const pool = makeFakePool({ deleteRowCount: 0 });
    const app = createApp(pool, baseConfig);
    const res = await request(app).delete('/v1/admin/llm-providers').set(authHeader);
    expect(res.status).toBe(404);
  });

  it('selection GET returns raw + effective view for a tenant', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{ encrypted_value: 'enc:' + JSON.stringify({ defaultModel: 'glm/glm-4.5' }) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .get('/v1/admin/llm-providers/selection?tenantId=t123')
      .set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 't123',
      rawSelection: 'glm/glm-4.5',
      selection: 'glm/glm-4.5',
      effectiveModel: 'glm/glm-4.5',
      rawCompactionSelection: null,
      effectiveCompactionModel: 'glm/glm-4.5',
      libraryEmpty: false,
      globalDefaultModel: 'qwen/qwen-max',
    });
  });

  it('selection GET 404s for an unknown tenant', async () => {
    const app = createApp(makeFakePool({ tenant: null }), baseConfig);
    const res = await request(app)
      .get('/v1/admin/llm-providers/selection?tenantId=nope')
      .set(authHeader);
    expect(res.status).toBe(404);
  });

  it('selection PUT stores a valid reference and pushes the tenant', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'glm/glm-4.5' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenantId: 't123', selection: 'glm/glm-4.5' });
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    // tenant-scope upsert params: [tenantId, key, encryptedValue, ...]
    expect(insert!.params![0]).toBe('t123');
    expect(insert!.params![1]).toBe(LLM_MODEL_SELECTION_KEY);
    expect(JSON.parse(String(insert!.params![2]).replace(/^enc:/, '')).defaultModel).toBe('glm/glm-4.5');
  });

  it('selection PUT stores a compaction model alongside the primary', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'qwen/qwen-max', compactionModel: 'glm/glm-4.5' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, compactionModel: 'glm/glm-4.5' });
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    const stored = JSON.parse(String(insert!.params![2]).replace(/^enc:/, ''));
    expect(stored.compactionModel).toBe('glm/glm-4.5');
  });

  it('selection PUT rejects a compaction model outside the library', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'qwen/qwen-max', compactionModel: 'kimi/moonshot' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('压缩模型');
  });

  it('selection PUT clears the compaction override with null (follow primary)', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      tenantSelectionRow: [{
        encrypted_value: 'enc:' + JSON.stringify({
          defaultModel: 'qwen/qwen-max',
          compactionModel: 'glm/glm-4.5',
        }),
      }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'qwen/qwen-max', compactionModel: null });
    expect(res.status).toBe(200);
    expect(res.body.compactionModel).toBeNull();
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    const stored = JSON.parse(String(insert!.params![2]).replace(/^enc:/, ''));
    expect(stored.compactionModel).toBeNull();
  });

  it('selection PUT rejects references outside the library', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'kimi/moonshot' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('不在全局供应商库中');
  });

  it('selection PUT rejects when the library is empty', async () => {
    const pool = makeFakePool({ tenant: makeTenant() });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: 'qwen/qwen-max' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('供应商库为空');
  });

  it('selection PUT with an empty model clears the selection', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: null });
    expect(res.status).toBe(200);
    expect(res.body.selection).toBeNull();
    const del = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('DELETE FROM runtime_configs') && q.sql.includes('config_key = $2'),
    );
    expect(del).toBeTruthy();
  });

  it('selection PUT keeps the row when directMode is set without a model', async () => {
    // Regression: enabling direct mode on a tenant that follows the global
    // default (no explicit model) used to hit the "clear" branch and silently
    // drop the row — directMode never stuck. It must persist the row instead.
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const app = createApp(pool, baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers/selection')
      .set(authHeader)
      .send({ tenantId: 't123', defaultModel: null, imageModel: null, directMode: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, selection: null, directMode: true });
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    const stored = JSON.parse(String(insert!.params![2]).replace(/^enc:/, ''));
    expect(stored).toMatchObject({ defaultModel: null, imageModel: null, directMode: true });
    const del = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('DELETE FROM runtime_configs') && q.sql.includes('config_key = $2'),
    );
    expect(del).toBeFalsy();
  });

  it('blocks the generic runtime-configs endpoints for LLM keys', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const put = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'LLM_PROVIDERS', value: '{}' });
    expect(put.status).toBe(400);
    const putSel = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'LLM_MODEL_SELECTION', value: '{}' });
    expect(putSel.status).toBe(400);
    const del = await request(app).delete(`/v1/admin/runtime-configs/LLM_PROVIDERS`).set(authHeader);
    expect(del.status).toBe(400);
  });
});

// ── LLM usage proxy ─────────────────────────────────────────────────

describe('llm-usage admin proxy', () => {
  const authHeader = { Authorization: 'Bearer test-token' };
  const savedToken = process.env.PROVISIONING_API_TOKEN;

  beforeEach(() => {
    process.env.PROVISIONING_API_TOKEN = 'test-token';
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.PROVISIONING_API_TOKEN;
    else process.env.PROVISIONING_API_TOKEN = savedToken;
    vi.unstubAllGlobals();
  });

  it('requires bearer auth', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    expect((await request(app).get('/v1/admin/llm-usage')).status).toBe(401);
    expect((await request(app).get('/v1/admin/llm-usage/summary?tenantId=t1')).status).toBe(401);
  });

  it('proxies the tenants aggregate to credits-ledger with the service token', async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      expect(String(url)).toBe('http://credits-ledger:8081/v1/billing/llm-usage/tenants?days=7');
      expect(init?.headers?.Authorization).toBe('Bearer ');
      return new Response(JSON.stringify({ ok: true, tenants: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app).get('/v1/admin/llm-usage').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('proxies the per-tenant summary and requires tenantId', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ ok: true, totals: { calls: 3 } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(makeFakePool(), baseConfig);
    const missing = await request(app).get('/v1/admin/llm-usage/summary').set(authHeader);
    expect(missing.status).toBe(400);
    const res = await request(app).get('/v1/admin/llm-usage/summary?tenantId=t1&days=30').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.totals.calls).toBe(3);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('tenantId=t1');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('days=30');
  });

  it('returns 502 when credits-ledger errors or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"message":"boom"}', { status: 500 })));
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app).get('/v1/admin/llm-usage').set(authHeader);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('LEDGER_ERROR');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res2 = await request(app).get('/v1/admin/llm-usage').set(authHeader);
    expect(res2.status).toBe(502);
    expect(res2.body.code).toBe('LEDGER_UNREACHABLE');
  });
});
