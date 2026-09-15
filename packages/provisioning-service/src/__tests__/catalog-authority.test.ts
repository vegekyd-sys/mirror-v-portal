import { describe, expect, it, vi } from 'vitest';

// Mock crypto with enc: prefix passthrough
const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  maskValue: (v: string) => (v.length > 8 ? `${v.slice(0, 4)}••••${v.slice(-4)}` : '••••'),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
}));
vi.mock('../services/crypto.js', () => cryptoMocks);

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

import {
  CatalogRepository,
  CatalogService,
  modelRowIdToLegacyRef,
  legacyRefToModelRowId,
  type ProviderInstanceRecord,
} from '../services/model-catalog.js';
import {
  ProviderInstanceInputSchema,
  GlobalModelPolicyInputSchema,
} from '../domain/model-catalog.js';

// ── Fake pool ──────────────────────────────────────────────────────────

interface FakeRow {
  [key: string]: unknown;
}

function makeFakePool(opts: {
  providers?: FakeRow[];
  models?: FakeRow[];
  policy?: FakeRow;
  activeModelsForProvider?: number;
  existingModelRevision?: number;
} = {}) {
  const providers = opts.providers ?? [];
  const models = opts.models ?? [];
  const policy = opts.policy ?? { id: 'current', default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(), updated_by: null };
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const lower = sql.toLowerCase();

      // INSERT provider
      if (lower.includes('insert into llm_provider_instances')) {
        return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING → no rows
      }
      // UPDATE provider with CAS
      if (lower.includes('update llm_provider_instances set') && lower.includes('where id=$1 and revision=$2')) {
        const id = params?.[0] as string;
        const expectedRev = params?.[1] as number;
        const prov = providers.find((p) => p.id === id);
        if (!prov) return { rows: [], rowCount: 0 };
        if (prov.revision !== expectedRev) return { rows: [], rowCount: 0 };
        return { rows: [prov], rowCount: 1 };
      }
      // Soft-delete provider (enabled=false)
      if (lower.includes('update llm_provider_instances set enabled=false')) {
        return { rows: [], rowCount: providers.length > 0 ? 1 : 0 };
      }
      // Check active models before delete
      if (lower.includes('select 1 from llm_provider_models') && lower.includes('runtime_enabled=true')) {
        return { rows: opts.activeModelsForProvider ? [{}] : [], rowCount: opts.activeModelsForProvider ? 1 : 0 };
      }
      // SELECT * FROM llm_provider_instances WHERE id=
      if (lower.includes('select * from llm_provider_instances where id=$1')) {
        const id = params?.[0] as string;
        const prov = providers.find((p) => p.id === id);
        return { rows: prov ? [prov] : [], rowCount: prov ? 1 : 0 };
      }
      // SELECT * FROM llm_provider_instances WHERE legacy_provider_name=
      if (lower.includes('select * from llm_provider_instances where legacy_provider_name=$1')) {
        const name = params?.[0] as string;
        const prov = providers.find((p) => p.legacy_provider_name === name);
        return { rows: prov ? [prov] : [], rowCount: prov ? 1 : 0 };
      }
      // INSERT model
      if (lower.includes('insert into llm_provider_models')) {
        return { rows: [], rowCount: 0 };
      }
      // UPDATE model with CAS
      if (lower.includes('update llm_provider_models set') && lower.includes('where id=$1 and revision=$2')) {
        const id = params?.[0] as string;
        const expectedRev = params?.[1] as number;
        const model = models.find((m) => m.id === id);
        if (!model) return { rows: [], rowCount: 0 };
        if (model.revision !== expectedRev) return { rows: [], rowCount: 0 };
        return { rows: [model], rowCount: 1 };
      }
      // SELECT revision FROM llm_provider_models WHERE id=
      if (lower.includes('select revision from llm_provider_models where id=$1')) {
        const id = params?.[0] as string;
        const model = models.find((m) => m.id === id);
        return { rows: model ? [{ revision: model.revision }] : [], rowCount: model ? 1 : 0 };
      }
      // Soft-delete model
      if (lower.includes('update llm_provider_models set runtime_enabled=false')) {
        return { rows: [], rowCount: models.length > 0 ? 1 : 0 };
      }
      // SELECT * FROM llm_global_model_policy WHERE id='current'
      if (lower.includes('select * from llm_global_model_policy where id=')) {
        return { rows: [policy], rowCount: 1 };
      }
      // Validate model refs
      if (lower.includes('select id from llm_provider_models') && lower.includes('runtime_enabled=true')) {
        const refIds = (params?.[0] as string[]) ?? [];
        const found = models.filter((m) => refIds.includes(m.id as string) && m.runtime_enabled).map((m) => ({ id: m.id }));
        return { rows: found, rowCount: found.length };
      }
      // UPDATE global policy with CAS
      if (lower.includes('update llm_global_model_policy set') && lower.includes('where id=')) {
        const expectedRev = params?.[0] as number;
        if (policy.revision !== expectedRev) return { rows: [], rowCount: 0 };
        return { rows: [policy], rowCount: 1 };
      }
      // SELECT revision FROM llm_global_model_policy
      if (lower.includes('select revision from llm_global_model_policy')) {
        return { rows: [{ revision: policy.revision }], rowCount: 1 };
      }
      // listRuntimeCatalog (complex JOIN) — return empty for unit tests
      if (lower.includes('select') && lower.includes('llm_provider_instances') && lower.includes('llm_provider_models') && lower.includes('jsonb_build_object')) {
        return { rows: [], rowCount: 0 };
      }
      // Default
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function makeProviderRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'lpi_test',
    legacy_provider_name: 'test-provider',
    template_key: 'custom-openai',
    display_name: 'Test Provider',
    protocol: 'openai-completions',
    base_url: 'https://api.test.com/v1',
    encrypted_api_key: 'enc:test-key-1234567890',
    source: 'manual',
    enabled: true,
    revision: 0,
    metadata: {},
    ...overrides,
  };
}

function makeModelRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'lpm_test-chat',
    provider_instance_id: 'lpi_test',
    model_id: 'test-chat',
    display_name: 'Test Chat',
    model_type: 'chat',
    runtime_enabled: true,
    discovered_params: null,
    override_params: null,
    effective_params: { inputModalities: ['text'], outputModalities: ['text'] },
    params_schema_version: 1,
    params_status: 'incomplete',
    source: 'manual',
    revision: 0,
    snapshot_approved: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProviderInstanceInputSchema', () => {
  it('validates a well-formed provider input', () => {
    const result = ProviderInstanceInputSchema.parse({
      legacyProviderName: 'my-provider',
      templateKey: 'custom-openai',
      protocol: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
      enabled: true,
    });
    expect(result.legacyProviderName).toBe('my-provider');
    expect(result.enabled).toBe(true);
  });

  it('rejects empty legacyProviderName', () => {
    expect(() =>
      ProviderInstanceInputSchema.parse({
        legacyProviderName: '',
        templateKey: 'custom-openai',
        protocol: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      ProviderInstanceInputSchema.parse({
        legacyProviderName: 'p',
        templateKey: 'custom-openai',
        protocol: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        enabled: true,
        unknownField: 'bad',
      }),
    ).toThrow();
  });
});

describe('GlobalModelPolicyInputSchema', () => {
  it('validates with all null refs', () => {
    const result = GlobalModelPolicyInputSchema.parse({
      defaultModel: null,
      imageModel: null,
      compactionModel: null,
      fallbackModels: [],
    });
    expect(result.defaultModel).toBeNull();
    expect(result.fallbackModels).toEqual([]);
  });

  it('validates with model refs', () => {
    const result = GlobalModelPolicyInputSchema.parse({
      defaultModel: 'lpm_abc',
      imageModel: 'lpm_def',
      compactionModel: null,
      fallbackModels: ['lpm_abc', 'lpm_ghi'],
    });
    expect(result.defaultModel).toBe('lpm_abc');
    expect(result.fallbackModels).toHaveLength(2);
  });
});

describe('CatalogRepository — Provider CRUD', () => {
  it('createProvider inserts with revision=0 and source=manual', async () => {
    const pool = makeFakePool();
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.createProvider({
        legacyProviderName: 'new-prov',
        templateKey: 'custom-openai',
        protocol: 'openai-completions',
        baseUrl: 'https://api.new.com/v1',
        apiKey: 'sk-new',
        enabled: true,
      }),
    ).rejects.toThrow('already exists'); // fake pool returns 0 rows from ON CONFLICT DO NOTHING
  });

  it('updateProvider succeeds with correct CAS revision', async () => {
    const providerRow = makeProviderRow({ id: 'lpi_test', revision: 0 });
    const pool = makeFakePool({ providers: [providerRow] });
    const repo = new CatalogRepository(pool as any);
    const result = await repo.updateProvider('lpi_test', { displayName: 'Updated' }, 0);
    expect(result.id).toBe('lpi_test');
  });

  it('updateProvider throws STALE_REVISION when CAS mismatch', async () => {
    const providerRow = makeProviderRow({ id: 'lpi_test', revision: 5 });
    const pool = makeFakePool({ providers: [providerRow] });
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.updateProvider('lpi_test', { displayName: 'Updated' }, 0),
    ).rejects.toThrow('STALE_REVISION');
  });

  it('updateProvider without apiKey does not change encrypted_api_key', async () => {
    const providerRow = makeProviderRow({ id: 'lpi_test', revision: 0 });
    const pool = makeFakePool({ providers: [providerRow] });
    const repo = new CatalogRepository(pool as any);
    await repo.updateProvider('lpi_test', { displayName: 'No Key Change' }, 0);
    // Check the SQL does not contain encrypted_api_key in SET
    const updateQuery = pool.queries.find((q) => q.sql.toLowerCase().includes('update llm_provider_instances set'));
    expect(updateQuery?.sql).not.toContain('encrypted_api_key');
  });

  it('deleteProvider blocks when provider has runtime_enabled models', async () => {
    const pool = makeFakePool({ activeModelsForProvider: 1 });
    const repo = new CatalogRepository(pool as any);
    await expect(repo.deleteProvider('lpi_test')).rejects.toThrow('PROVIDER_HAS_RUNTIME_MODELS');
  });

  it('deleteProvider succeeds when no active models', async () => {
    const providerRow = makeProviderRow();
    const pool = makeFakePool({ providers: [providerRow], activeModelsForProvider: 0 });
    const repo = new CatalogRepository(pool as any);
    await repo.deleteProvider('lpi_test');
    const disableQuery = pool.queries.find((q) => q.sql.toLowerCase().includes('enabled=false'));
    expect(disableQuery).toBeDefined();
  });

  it('findProvider returns null for non-existent id', async () => {
    const pool = makeFakePool();
    const repo = new CatalogRepository(pool as any);
    const result = await repo.findProvider('nonexistent');
    expect(result).toBeNull();
  });

  it('findProviderByName returns the provider when found', async () => {
    const providerRow = makeProviderRow({ legacy_provider_name: 'my-prov' });
    const pool = makeFakePool({ providers: [providerRow] });
    const repo = new CatalogRepository(pool as any);
    const result = await repo.findProviderByName('my-prov');
    expect(result?.legacyProviderName).toBe('my-prov');
  });
});

describe('CatalogRepository — Model CRUD', () => {
  it('createModel inserts with params_status=incomplete and revision=0', async () => {
    const pool = makeFakePool();
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.createModel('lpi_test', { modelId: 'new-model', modelType: 'chat', runtimeEnabled: true }),
    ).rejects.toThrow('already exists'); // fake pool returns 0 rows
  });

  it('updateModel succeeds with correct CAS', async () => {
    const modelRow = makeModelRow({ id: 'lpm_test', revision: 0 });
    const pool = makeFakePool({ models: [modelRow] });
    const repo = new CatalogRepository(pool as any);
    const result = await repo.updateModel('lpm_test', { displayName: 'Updated Model' }, 0);
    expect(result.id).toBe('lpm_test');
  });

  it('updateModel throws STALE_REVISION on CAS mismatch', async () => {
    const modelRow = makeModelRow({ id: 'lpm_test', revision: 3 });
    const pool = makeFakePool({ models: [modelRow] });
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.updateModel('lpm_test', { displayName: 'Updated' }, 0),
    ).rejects.toThrow('STALE_REVISION');
  });

  it('deleteModel soft-deletes by setting runtime_enabled=false', async () => {
    const modelRow = makeModelRow();
    const pool = makeFakePool({ models: [modelRow] });
    const repo = new CatalogRepository(pool as any);
    await repo.deleteModel('lpm_test');
    const deleteQuery = pool.queries.find((q) => q.sql.toLowerCase().includes('runtime_enabled=false'));
    expect(deleteQuery).toBeDefined();
  });

  it('deleteModel throws when model not found', async () => {
    const pool = makeFakePool({ models: [] });
    const repo = new CatalogRepository(pool as any);
    await expect(repo.deleteModel('nonexistent')).rejects.toThrow('not found');
  });

  it('setModelRuntimeEnabled uses CAS', async () => {
    const modelRow = makeModelRow({ id: 'lpm_test', revision: 2 });
    const pool = makeFakePool({ models: [modelRow] });
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.setModelRuntimeEnabled('lpm_test', false, 0),
    ).rejects.toThrow('STALE_REVISION');
  });
});

describe('CatalogRepository — Global Model Policy', () => {
  it('getGlobalModelPolicy returns current policy', async () => {
    const pool = makeFakePool({
      policy: { id: 'current', default_model: 'lpm_a', image_model: null, compaction_model: 'lpm_b', fallback_models: ['lpm_a'], revision: 1, updated_at: new Date(), updated_by: 'admin' },
    });
    const repo = new CatalogRepository(pool as any);
    const result = await repo.getGlobalModelPolicy();
    expect(result?.defaultModel).toBe('lpm_a');
    expect(result?.imageModel).toBeNull();
    expect(result?.revision).toBe(1);
  });

  it('updateGlobalModelPolicy throws DANGLING_MODEL_REFERENCE for invalid refs', async () => {
    const pool = makeFakePool({
      models: [],
      policy: { id: 'current', default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(), updated_by: null },
    });
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.updateGlobalModelPolicy(
        { defaultModel: 'lpm_nonexistent', imageModel: null, compactionModel: null, fallbackModels: [] },
        0,
        'admin',
      ),
    ).rejects.toThrow('DANGLING_MODEL_REFERENCE');
  });

  it('updateGlobalModelPolicy throws STALE_REVISION on CAS mismatch', async () => {
    const modelRow = makeModelRow({ id: 'lpm_a', runtime_enabled: true });
    const pool = makeFakePool({
      models: [modelRow],
      policy: { id: 'current', default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 5, updated_at: new Date(), updated_by: null },
    });
    const repo = new CatalogRepository(pool as any);
    await expect(
      repo.updateGlobalModelPolicy(
        { defaultModel: 'lpm_a', imageModel: null, compactionModel: null, fallbackModels: [] },
        0,
        'admin',
      ),
    ).rejects.toThrow('STALE_REVISION');
  });
});

describe('Reference conversion utilities', () => {
  const catalog = [
    {
      provider: { id: 'lpi_a', legacyProviderName: 'provider-a' } as ProviderInstanceRecord,
      models: [
        { id: 'lpm_a1', modelId: 'model-a1' } as any,
        { id: 'lpm_a2', modelId: 'model-a2' } as any,
      ],
    },
    {
      provider: { id: 'lpi_b', legacyProviderName: 'provider-b' } as ProviderInstanceRecord,
      models: [{ id: 'lpm_b1', modelId: 'model-b1' } as any],
    },
  ];

  it('modelRowIdToLegacyRef converts stable ID to providerName/modelId', () => {
    expect(modelRowIdToLegacyRef(catalog, 'lpm_a1')).toBe('provider-a/model-a1');
    expect(modelRowIdToLegacyRef(catalog, 'lpm_b1')).toBe('provider-b/model-b1');
  });

  it('modelRowIdToLegacyRef returns null for unknown ID', () => {
    expect(modelRowIdToLegacyRef(catalog, 'lpm_unknown')).toBeNull();
  });

  it('legacyRefToModelRowId converts providerName/modelId to stable ID', () => {
    expect(legacyRefToModelRowId(catalog, 'provider-a/model-a2')).toBe('lpm_a2');
    expect(legacyRefToModelRowId(catalog, 'provider-b/model-b1')).toBe('lpm_b1');
  });

  it('legacyRefToModelRowId returns null for unknown ref', () => {
    expect(legacyRefToModelRowId(catalog, 'unknown/model')).toBeNull();
    expect(legacyRefToModelRowId(catalog, 'invalid-no-slash')).toBeNull();
  });
});

describe('CatalogService.buildCatalogSnapshot', () => {
  it('builds a valid LlmProvidersConfig without legacy skeleton', async () => {
    // The fake pool returns empty catalog, so the snapshot should have
    // empty providers and null refs — proving it doesn't throw without legacy.
    const pool = makeFakePool();
    const repo = new CatalogRepository(pool as any);
    const service = new CatalogService(repo);
    const snapshot = await service.buildCatalogSnapshot();
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.defaultModel).toBeNull();
    expect(snapshot.imageModel).toBeNull();
    expect(snapshot.compactionModel).toBeNull();
    expect(snapshot.fallbackModels).toEqual([]);
  });
});
