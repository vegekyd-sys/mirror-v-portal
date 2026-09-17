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

import { TenantSelectionV2Service } from '../services/tenant-selection-v2.js';
import type { TenantModelSelection } from '../services/llm-providers.js';

// ── Fake pool ──────────────────────────────────────────────────────────

interface FakeRow {
  [key: string]: unknown;
}

interface FakePoolConfig {
  v2Rows?: FakeRow[];
  tenants?: FakeRow[];
  legacySelections?: Map<string, string>; // tenantId → encrypted JSON
  catalog?: Array<{ provider: Record<string, unknown>; models: Array<Record<string, unknown>> }>;
  runtimeConfigUpserts?: Array<{ tenantId: string | null; key: string; value: string }>;
}

function makeFakePool(opts: FakePoolConfig = {}) {
  const v2Rows = opts.v2Rows ?? [];
  const tenants = [...(opts.tenants ?? [])];
  const legacySelections = opts.legacySelections ?? new Map<string, string>();
  const catalog = opts.catalog ?? [];
  const upserts = opts.runtimeConfigUpserts ?? [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const lower = sql.toLowerCase();

      // SELECT from llm_tenant_selection_v2
      if (lower.includes('select') && lower.includes('llm_tenant_selection_v2') && lower.includes('where tenant_id = $1')) {
        if (lower.includes('for update')) {
          const tid = String(params?.[0]);
          const row = v2Rows.find((r) => r.tenant_id === tid);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        const tid = String(params?.[0]);
        const row = v2Rows.find((r) => r.tenant_id === tid);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // INSERT/UPSERT into llm_tenant_selection_v2
      if (lower.includes('insert into llm_tenant_selection_v2')) {
        const tid = String(params?.[0]);
        const newRow: FakeRow = {
          tenant_id: tid,
          default_model_id: params?.[1] ?? null,
          image_model_id: params?.[2] ?? null,
          compaction_model_id: params?.[3] ?? null,
          fallback_model_ids: params?.[4] ?? [],
          direct_mode: params?.[5] ?? false,
          revision: params?.[6] ?? 1,
          updated_by: params?.[7] ?? null,
          updated_at: new Date(),
        };
        // Replace existing or add new
        const idx = v2Rows.findIndex((r) => r.tenant_id === tid);
        if (idx >= 0) {
          v2Rows[idx] = newRow;
        } else {
          v2Rows.push(newRow);
        }
        return { rows: [newRow], rowCount: 1 };
      }

      // SELECT tenant_id FROM tenants WHERE status NOT IN ('destroyed')
      if (lower.includes('select tenant_id from tenants') && lower.includes('status not in')) {
        return { rows: tenants, rowCount: tenants.length };
      }

      // SELECT k8s_namespace FROM tenants WHERE tenant_id = $1
      if (lower.includes('select k8s_namespace from tenants where tenant_id = $1')) {
        return { rows: [{ k8s_namespace: 'test-ns' }], rowCount: 1 };
      }

      // SELECT encrypted_value FROM runtime_configs WHERE tenant_id IS NULL AND config_key
      if (lower.includes('select encrypted_value from runtime_configs') && lower.includes('tenant_id is null')) {
        return { rows: [], rowCount: 0 };
      }

      // SELECT encrypted_value FROM runtime_configs WHERE tenant_id = $1 AND config_key
      if (lower.includes('select encrypted_value from runtime_configs') && lower.includes('config_key = $2')) {
        const tid = String(params?.[0]);
        const enc = legacySelections.get(tid);
        return { rows: enc ? [{ encrypted_value: enc }] : [], rowCount: enc ? 1 : 0 };
      }

      // SELECT * FROM runtime_configs WHERE config_key = $1 AND tenant_id = ANY
      if (lower.includes('select tenant_id, encrypted_value from runtime_configs') && lower.includes('any')) {
        return { rows: [], rowCount: 0 };
      }

      // UPSERT runtime_configs (dual-write in updateSelection)
      if (lower.includes('insert into runtime_configs')) {
        const tenantId = params?.[0] ?? null;
        const key = String(params?.[1]);
        const value = String(params?.[2]);
        upserts.push({ tenantId: tenantId as string | null, key, value });
        return { rows: [], rowCount: 1 };
      }

      // listRuntimeCatalog — return the mock catalog
      if (lower.includes('select') && lower.includes('llm_provider_instances') && lower.includes('llm_provider_models') && lower.includes('jsonb_build_object')) {
        return {
          rows: catalog.map((item) => ({
            ...item.provider,
            models: item.models,
          })),
          rowCount: catalog.length,
        };
      }

      // SELECT * FROM llm_global_model_policy
      if (lower.includes('select * from llm_global_model_policy where id=')) {
        return { rows: [{ id: 'current', default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(), updated_by: null }] };
      }

      // Default
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          const lower = sql.toLowerCase();

          if (lower === 'begin') return { rows: [], rowCount: 0 };
          if (lower === 'commit') return { rows: [], rowCount: 0 };
          if (lower === 'rollback') return { rows: [], rowCount: 0 };

          // SELECT * FROM llm_tenant_selection_v2 WHERE tenant_id = $1 FOR UPDATE
          if (lower.includes('select') && lower.includes('llm_tenant_selection_v2') && lower.includes('for update')) {
            const tid = String(params?.[0]);
            const row = v2Rows.find((r) => r.tenant_id === tid);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          // INSERT INTO llm_tenant_selection_v2 (UPSERT)
          if (lower.includes('insert into llm_tenant_selection_v2')) {
            const tid = String(params?.[0]);
            const newRow: FakeRow = {
              tenant_id: tid,
              default_model_id: params?.[1] ?? null,
              image_model_id: params?.[2] ?? null,
              compaction_model_id: params?.[3] ?? null,
              fallback_model_ids: params?.[4] ?? [],
              direct_mode: params?.[5] ?? false,
              revision: params?.[6] ?? 1,
              updated_by: params?.[7] ?? null,
              updated_at: new Date(),
            };
            const idx = v2Rows.findIndex((r) => r.tenant_id === tid);
            if (idx >= 0) v2Rows[idx] = newRow;
            else v2Rows.push(newRow);
            return { rows: [newRow], rowCount: 1 };
          }

          // INSERT INTO runtime_configs (dual-write)
          if (lower.includes('insert into runtime_configs')) {
            const tenantId = params?.[0] ?? null;
            const key = String(params?.[1]);
            const value = String(params?.[2]);
            upserts.push({ tenantId: tenantId as string | null, key, value });
            return { rows: [], rowCount: 1 };
          }

          // listRuntimeCatalog
          if (lower.includes('select') && lower.includes('llm_provider_instances') && lower.includes('llm_provider_models') && lower.includes('jsonb_build_object')) {
            return {
              rows: catalog.map((item) => ({
                ...item.provider,
                models: item.models,
              })),
              rowCount: catalog.length,
            };
          }

          // SELECT * FROM llm_global_model_policy
          if (lower.includes('select * from llm_global_model_policy where id=')) {
            return { rows: [{ id: 'current', default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(), updated_by: null }] };
          }

          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
      return client;
    },
  };
  return pool;
}

function makeCatalog(): Array<{ provider: Record<string, unknown>; models: Array<Record<string, unknown>> }> {
  return [
    {
      provider: {
        id: 'lpi_provider1',
        legacy_provider_name: 'provider1',
        template_key: 'custom-openai',
        protocol: 'openai-completions',
        base_url: 'https://api.provider1.com/v1',
        encrypted_api_key: 'enc:key1',
        source: 'manual',
        enabled: true,
        revision: 0,
      },
      models: [
        {
          id: 'lpm_model1',
          provider_instance_id: 'lpi_provider1',
          model_id: 'model1',
          model_type: 'chat',
          runtime_enabled: true,
          effective_params: { inputModalities: ['text'], outputModalities: ['text'] },
          params_status: 'complete',
          params_schema_version: 1,
          revision: 0,
          snapshot_approved: true,
        },
        {
          id: 'lpm_model2',
          provider_instance_id: 'lpi_provider1',
          model_id: 'model2',
          model_type: 'chat',
          runtime_enabled: true,
          effective_params: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
          params_status: 'complete',
          params_schema_version: 1,
          revision: 0,
          snapshot_approved: true,
        },
      ],
    },
  ];
}

function encodeLegacySelection(sel: TenantModelSelection): string {
  return `enc:${JSON.stringify(sel)}`;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TenantSelectionV2Service — getSelection', () => {
  it('returns null for a tenant with no V2 row', async () => {
    const pool = makeFakePool();
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.getSelection('tenant-1');
    expect(result).toBeNull();
  });

  it('returns the V2 selection when it exists', async () => {
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: ['lpm_model2'],
        direct_mode: false,
        revision: 3,
      }],
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.getSelection('tenant-1');
    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-1');
    expect(result!.defaultModelId).toBe('lpm_model1');
    expect(result!.fallbackModelIds).toEqual(['lpm_model2']);
    expect(result!.revision).toBe(3);
  });
});

describe('TenantSelectionV2Service — getSelectionAsLegacy', () => {
  it('converts V2 stable IDs to legacy providerName/modelId refs', async () => {
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: 'lpm_model2',
        compaction_model_id: null,
        fallback_model_ids: [],
        direct_mode: false,
        revision: 0,
      }],
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.getSelectionAsLegacy('tenant-1');
    expect(result).not.toBeNull();
    expect(result!.defaultModel).toBe('provider1/model1');
    expect(result!.imageModel).toBe('provider1/model2');
    expect(result!.compactionModel).toBeNull();
    expect(result!.directMode).toBe(false);
  });

  it('returns null when no V2 row exists', async () => {
    const pool = makeFakePool();
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.getSelectionAsLegacy('tenant-1');
    expect(result).toBeNull();
  });
});

describe('TenantSelectionV2Service — updateSelection', () => {
  it('creates a new V2 row with revision=1 when none exists', async () => {
    const pool = makeFakePool({ catalog: makeCatalog() });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.updateSelection(
      'tenant-1',
      { defaultModelId: 'lpm_model1', directMode: true },
      0,
      'admin',
    );
    expect(result.tenantId).toBe('tenant-1');
    expect(result.defaultModelId).toBe('lpm_model1');
    expect(result.directMode).toBe(true);
    expect(result.revision).toBe(1);
  });

  it('throws STALE_REVISION when CAS mismatch', async () => {
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: [],
        direct_mode: false,
        revision: 5,
      }],
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    await expect(
      svc.updateSelection('tenant-1', { directMode: true }, 0, 'admin'),
    ).rejects.toThrow('STALE_REVISION');
  });

  it('updates with correct CAS revision', async () => {
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: [],
        direct_mode: false,
        revision: 2,
      }],
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.updateSelection(
      'tenant-1',
      { imageModelId: 'lpm_model2' },
      2,
      'admin',
    );
    expect(result.revision).toBe(3);
    expect(result.imageModelId).toBe('lpm_model2');
    // defaultModelId should be preserved (not in input)
    expect(result.defaultModelId).toBe('lpm_model1');
  });

  it('dual-writes to legacy runtime_configs (LLM_MODEL_SELECTION)', async () => {
    const upserts: Array<{ tenantId: string | null; key: string; value: string }> = [];
    const pool = makeFakePool({ catalog: makeCatalog(), runtimeConfigUpserts: upserts });
    const svc = new TenantSelectionV2Service(pool as any);
    await svc.updateSelection(
      'tenant-1',
      { defaultModelId: 'lpm_model1', directMode: false },
      0,
      'admin',
    );
    // The dual-write should have inserted a runtime_configs row.
    // The value is encrypted by upsertRuntimeConfig → decrypt before asserting.
    const dualWrite = upserts.find(
      (u) => u.tenantId === 'tenant-1' && u.key === 'LLM_MODEL_SELECTION',
    );
    expect(dualWrite).toBeDefined();
    const decrypted = dualWrite!.value.startsWith('enc:')
      ? dualWrite!.value.slice(4)
      : dualWrite!.value;
    const legacyValue = JSON.parse(decrypted);
    expect(legacyValue.defaultModel).toBe('provider1/model1');
    expect(legacyValue.directMode).toBe(false);
  });

  it('preserves existing values for keys not in input (partial update)', async () => {
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: 'lpm_model2',
        compaction_model_id: null,
        fallback_model_ids: ['lpm_model2'],
        direct_mode: true,
        revision: 1,
      }],
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.updateSelection(
      'tenant-1',
      { directMode: false },
      1,
      'admin',
    );
    expect(result.directMode).toBe(false);
    expect(result.defaultModelId).toBe('lpm_model1');
    expect(result.imageModelId).toBe('lpm_model2');
    expect(result.fallbackModelIds).toEqual(['lpm_model2']);
  });
});

describe('TenantSelectionV2Service — backfillFromLegacy', () => {
  it('dryRun generates report without writing', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: 'provider1/model1',
      imageModel: null,
      compactionModel: null,
      fallbackModels: null,
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      tenants: [{ tenant_id: 'tenant-1' }, { tenant_id: 'tenant-2' }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const report = await svc.backfillFromLegacy({ dryRun: true, actor: 'admin' });

    expect(report.totalTenants).toBe(2);
    expect(report.migrated).toBe(1); // tenant-1 has a valid legacy selection
    expect(report.skipped).toBe(1); // tenant-2 has no legacy selection
    expect(report.missing).toBe(0);
    expect(report.details).toHaveLength(2);

    const detail1 = report.details.find((d) => d.tenantId === 'tenant-1');
    expect(detail1).toBeDefined();
    expect(detail1!.v2Selection!.defaultModelId).toBe('lpm_model1');
    expect(detail1!.missingRefs).toEqual([]);

    const detail2 = report.details.find((d) => d.tenantId === 'tenant-2');
    expect(detail2).toBeDefined();
    expect(detail2!.legacySelection).toBeNull();
  });

  it('marks missing refs when legacy ref cannot be resolved', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: 'nonexistent/model-x',
      imageModel: null,
      compactionModel: null,
      fallbackModels: null,
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      tenants: [{ tenant_id: 'tenant-1' }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const report = await svc.backfillFromLegacy({ dryRun: true, actor: 'admin' });

    expect(report.missing).toBe(1);
    const detail = report.details[0];
    expect(detail.missingRefs).toContain('nonexistent/model-x');
    expect(detail.v2Selection!.defaultModelId).toBeNull();
  });

  it('actual run writes V2 rows for tenants with valid legacy selections', async () => {
    const v2Rows: FakeRow[] = [];
    const legacySel: TenantModelSelection = {
      defaultModel: 'provider1/model1',
      imageModel: 'provider1/model2',
      compactionModel: null,
      fallbackModels: ['provider1/model2'],
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      v2Rows,
      tenants: [{ tenant_id: 'tenant-1' }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const report = await svc.backfillFromLegacy({ dryRun: false, actor: 'admin' });

    expect(report.migrated).toBe(1);
    expect(report.totalTenants).toBe(1);
    // Verify the V2 row was written
    const written = v2Rows.find((r) => r.tenant_id === 'tenant-1');
    expect(written).toBeDefined();
    expect(written!.default_model_id).toBe('lpm_model1');
    expect(written!.image_model_id).toBe('lpm_model2');
    expect(written!.fallback_model_ids).toEqual(['lpm_model2']);
  });

  it('skips tenants with no legacy selection', async () => {
    const pool = makeFakePool({
      tenants: [{ tenant_id: 'tenant-1' }, { tenant_id: 'tenant-2' }],
      legacySelections: new Map(), // no legacy selections at all
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const report = await svc.backfillFromLegacy({ dryRun: false, actor: 'admin' });

    expect(report.totalTenants).toBe(2);
    expect(report.skipped).toBe(2);
    expect(report.migrated).toBe(0);
  });
});

describe('TenantSelectionV2Service — compareSelections', () => {
  it('returns match=true when V1 and V2 are identical', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: 'provider1/model1',
      imageModel: 'provider1/model2',
      compactionModel: null,
      fallbackModels: ['provider1/model2'],
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: 'lpm_model2',
        compaction_model_id: null,
        fallback_model_ids: ['lpm_model2'],
        direct_mode: false,
        revision: 0,
      }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.compareSelections('tenant-1');
    expect(result.match).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it('returns differences when defaultModel differs', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: 'provider1/model2',
      imageModel: null,
      compactionModel: null,
      fallbackModels: null,
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: 'lpm_model1',
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: [],
        direct_mode: false,
        revision: 0,
      }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.compareSelections('tenant-1');
    expect(result.match).toBe(false);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.differences.some((d) => d.includes('defaultModel'))).toBe(true);
  });

  it('returns differences when directMode differs', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: null,
      imageModel: null,
      compactionModel: null,
      fallbackModels: null,
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: null,
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: [],
        direct_mode: true,
        revision: 0,
      }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.compareSelections('tenant-1');
    expect(result.match).toBe(false);
    expect(result.differences.some((d) => d.includes('directMode'))).toBe(true);
  });

  it('returns match=true when both V1 and V2 have no selection', async () => {
    const pool = makeFakePool({
      v2Rows: [],
      legacySelections: new Map(),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.compareSelections('tenant-1');
    expect(result.match).toBe(true);
    expect(result.legacySelection).toBeNull();
    expect(result.v2SelectionAsLegacy).toBeNull();
  });

  it('returns differences when fallbackModels differ', async () => {
    const legacySel: TenantModelSelection = {
      defaultModel: null,
      imageModel: null,
      compactionModel: null,
      fallbackModels: ['provider1/model1'],
      directMode: false,
      runtimeContractMode: 'v1',
    };
    const pool = makeFakePool({
      v2Rows: [{
        tenant_id: 'tenant-1',
        default_model_id: null,
        image_model_id: null,
        compaction_model_id: null,
        fallback_model_ids: ['lpm_model2'],
        direct_mode: false,
        revision: 0,
      }],
      legacySelections: new Map([
        ['tenant-1', encodeLegacySelection(legacySel)],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const result = await svc.compareSelections('tenant-1');
    expect(result.match).toBe(false);
    expect(result.differences.some((d) => d.includes('fallbackModels'))).toBe(true);
  });
});

describe('TenantSelectionV2Service — backfill report stats', () => {
  it('correctly counts missing refs across multiple tenants', async () => {
    const pool = makeFakePool({
      tenants: [
        { tenant_id: 'tenant-ok' },
        { tenant_id: 'tenant-missing' },
        { tenant_id: 'tenant-nosel' },
      ],
      legacySelections: new Map([
        ['tenant-ok', encodeLegacySelection({
          defaultModel: 'provider1/model1',
          imageModel: null,
          compactionModel: null,
          fallbackModels: null,
          directMode: false,
          runtimeContractMode: 'v1',
        })],
        ['tenant-missing', encodeLegacySelection({
          defaultModel: 'gone/model-x',
          imageModel: null,
          compactionModel: null,
          fallbackModels: null,
          directMode: false,
          runtimeContractMode: 'v1',
        })],
      ]),
      catalog: makeCatalog(),
    });
    const svc = new TenantSelectionV2Service(pool as any);
    const report = await svc.backfillFromLegacy({ dryRun: true, actor: 'admin' });

    expect(report.totalTenants).toBe(3);
    expect(report.migrated).toBe(1); // tenant-ok
    expect(report.missing).toBe(1); // tenant-missing
    expect(report.skipped).toBe(1); // tenant-nosel
    expect(report.errors).toEqual([]);
  });
});
