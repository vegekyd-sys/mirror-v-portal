import { describe, it, expect, vi } from 'vitest';

// Mock crypto with the same enc: prefix passthrough as llm-push-task.test.ts
const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
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

import { CatalogRolloutService } from '../services/catalog-rollout-service.js';
import { analyzeTenantLlmRestart, type LlmProvidersConfig, type TenantModelSelection } from '../services/llm-providers.js';

// ── Test fixtures ──

const libraryV1: LlmProvidersConfig = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-old-key',
      models: [
        { id: 'qwen-max', modelType: 'chat', protocol: 'openai-completions' },
        { id: 'qwen-vl-max', modelType: 'chat', protocol: 'openai-completions', vision: true },
      ],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: 'qwen/qwen-vl-max',
  compactionModel: null,
  fallbackModels: [],
};

const libraryV2: LlmProvidersConfig = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-new-key', // credential changed
      models: [
        { id: 'qwen-max', modelType: 'chat', protocol: 'openai-completions' },
        { id: 'qwen-vl-max', modelType: 'chat', protocol: 'openai-completions', vision: true },
      ],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: 'qwen/qwen-vl-max',
  compactionModel: null,
  fallbackModels: [],
};

const libraryV1Copy: LlmProvidersConfig = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-old-key',
      models: [
        { id: 'qwen-max', modelType: 'chat', protocol: 'openai-completions' },
        { id: 'qwen-vl-max', modelType: 'chat', protocol: 'openai-completions', vision: true },
      ],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: 'qwen/qwen-vl-max',
  compactionModel: null,
  fallbackModels: [],
};

const defaultSelection: TenantModelSelection = {
  defaultModel: null,
  imageModel: null,
  compactionModel: null,
  fallbackModels: null,
  directMode: false,
};

// ── Fake pool ──

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

interface QueryResponder {
  match: (sql: string, params?: unknown[]) => boolean;
  respond: (params?: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };
}

function makeFakePool(responders: QueryResponder[] = []) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      for (const r of responders) {
        if (r.match(sql, params)) {
          return r.respond(params);
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function rowsResponder(
  pattern: string | RegExp,
  rows: Record<string, unknown>[],
): QueryResponder {
  const regex = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern;
  return {
    match: (sql) => regex.test(sql),
    respond: () => ({ rows, rowCount: rows.length }),
  };
}

// Helper: build a fake pool for computeImpactManifest with given tenants
function makeImpactPreviewPool(opts: {
  tenants: Array<{ tenant_id: string; company_name: string; agent_endpoint: string | null }>;
  selections?: Map<string, TenantModelSelection>;
  overrides?: Map<string, string>; // tenantId → image (for nexus-agent)
  gatewayOverrides?: Map<string, string>;
  releaseStatuses?: Array<{ tenant_id: string; applied_release_id: string | null; delivery_status: string | null }>;
  desiredReleaseId?: string | null;
}) {
  const tenants = opts.tenants;
  const selections = opts.selections ?? new Map();
  const overrides = opts.overrides ?? new Map();
  const gatewayOverrides = opts.gatewayOverrides ?? new Map();
  const releaseStatuses = opts.releaseStatuses ?? [];
  const desiredReleaseId = opts.desiredReleaseId ?? null;

  return makeFakePool([
    // Tenant query
    rowsResponder(
      'SELECT tenant_id, company_name, k8s_namespace, agent_endpoint',
      tenants.map((t) => ({
        tenant_id: t.tenant_id,
        company_name: t.company_name,
        k8s_namespace: 'ns-' + t.tenant_id,
        agent_endpoint: t.agent_endpoint,
      })),
    ),
    // Tenant model selection query (per-tenant)
    {
      match: (sql) => sql.includes('FROM runtime_configs') && sql.includes('LLM_MODEL_SELECTION'),
      respond: (params) => {
        const tenantId = params?.[0] as string;
        const sel = selections.get(tenantId);
        if (!sel) return { rows: [], rowCount: 0 };
        return {
          rows: [{ encrypted_value: `enc:${JSON.stringify(sel)}` }],
          rowCount: 1,
        };
      },
    },
    // Image overrides — nexus-agent
    {
      match: (sql, params) => sql.includes('FROM tenant_image_overrides') && params?.[0] === 'nexus-agent',
      respond: () => ({
        rows: [...overrides.entries()].map(([tenant_id, image]) => ({ tenant_id, image })),
        rowCount: overrides.size,
      }),
    },
    // Image overrides — nexus-gateway
    {
      match: (sql, params) => sql.includes('FROM tenant_image_overrides') && params?.[0] === 'nexus-gateway',
      respond: () => ({
        rows: [...gatewayOverrides.entries()].map(([tenant_id, image]) => ({ tenant_id, image })),
        rowCount: gatewayOverrides.size,
      }),
    },
    // Per-tenant release status (bulk)
    {
      match: (sql) => sql.includes('FROM llm_tenant_release_status') && sql.includes('ANY'),
      respond: () => ({
        rows: releaseStatuses.map((r) => ({
          tenant_id: r.tenant_id,
          applied_release_id: r.applied_release_id,
          delivery_status: r.delivery_status,
        })),
        rowCount: releaseStatuses.length,
      }),
    },
    // Release pointer
    rowsResponder(
      'FROM llm_catalog_release_pointer',
      [{ release_id: desiredReleaseId }],
    ),
  ]);
}

// ── Tests ──

describe('analyzeTenantLlmRestart — reason codes', () => {
  it('returns empty reasons when nothing changed', () => {
    const result = analyzeTenantLlmRestart(libraryV1, libraryV1Copy, defaultSelection);
    expect(result.restart).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('detects credential change with correct reason', () => {
    const result = analyzeTenantLlmRestart(libraryV1, libraryV2, defaultSelection);
    expect(result.restart).toBe(true);
    expect(result.reasons).toContain('default_model_credential_changed');
    expect(result.reasons).toContain('image_model_credential_changed');
  });

  it('detects default model ref change', () => {
    const libraryDifferentDefault: LlmProvidersConfig = {
      ...libraryV1,
      defaultModel: 'qwen/qwen-vl-max',
    };
    const result = analyzeTenantLlmRestart(libraryV1, libraryDifferentDefault, defaultSelection);
    expect(result.restart).toBe(true);
    expect(result.reasons).toContain('default_model_ref_changed');
  });

  it('detects fallback chain change', () => {
    const libraryWithFallback: LlmProvidersConfig = {
      ...libraryV1,
      fallbackModels: ['qwen/qwen-vl-max'],
    };
    const result = analyzeTenantLlmRestart(libraryV1, libraryWithFallback, defaultSelection);
    expect(result.restart).toBe(true);
    expect(result.reasons).toContain('fallback_chain_changed');
  });
});

describe('CatalogRolloutService.computeImpactManifest', () => {
  it('returns affectedTenants=0 when library is unchanged', async () => {
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Tenant 1', agent_endpoint: null },
        { tenant_id: 't2', company_name: 'Tenant 2', agent_endpoint: null },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV1Copy, null);

    expect(manifest.totalTenants).toBe(2);
    expect(manifest.affectedTenants).toBe(0);
    expect(manifest.unaffectedTenants).toBe(2);
    expect(manifest.releaseId).toBeNull();
    expect(manifest.fingerprint).toBeTruthy();
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].affected).toBe(false);
    expect(manifest.entries[0].affectedReasons).toEqual([]);
  });

  it('detects affected tenants with correct reasons on credential change', async () => {
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Tenant 1', agent_endpoint: null },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    expect(manifest.affectedTenants).toBe(1);
    expect(manifest.entries[0].affected).toBe(true);
    expect(manifest.entries[0].agentRestart).toBe(true);
    expect(manifest.entries[0].gatewayRestart).toBe(true);
    expect(manifest.entries[0].affectedReasons).toContain('default_model_credential_changed');
  });

  it('marks pinned tenants correctly', async () => {
    const overrides = new Map([['t1', 'custom-image:v1']]);
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Tenant 1', agent_endpoint: null },
        { tenant_id: 't2', company_name: 'Tenant 2', agent_endpoint: null },
      ],
      overrides,
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV1Copy, null);

    expect(manifest.pinnedTenants).toBe(1);
    const t1 = manifest.entries.find((e) => e.tenantId === 't1');
    const t2 = manifest.entries.find((e) => e.tenantId === 't2');
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    // pinned doesn't affect the 'affected' flag — it's metadata
    expect(t1!.affected).toBe(false);
  });

  it('marks internal tenants (agent_endpoint set) as not affected', async () => {
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Internal', agent_endpoint: 'https://custom.example.com' },
        { tenant_id: 't2', company_name: 'Standard', agent_endpoint: null },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    const internal = manifest.entries.find((e) => e.tenantId === 't1');
    const standard = manifest.entries.find((e) => e.tenantId === 't2');
    expect(internal!.internal).toBe(true);
    expect(internal!.affected).toBe(false); // no agent deployment → can't be affected
    expect(standard!.internal).toBe(false);
    expect(standard!.affected).toBe(true);
  });

  it('populates current/desired effective selections', async () => {
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Tenant 1', agent_endpoint: null },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    const entry = manifest.entries[0];
    expect(entry.currentDefaultModel).toBe('qwen/qwen-max');
    expect(entry.desiredDefaultModel).toBe('qwen/qwen-max');
    expect(entry.currentImageModel).toBe('qwen/qwen-vl-max');
    expect(entry.desiredImageModel).toBe('qwen/qwen-vl-max');
  });

  it('includes release status info from the DB', async () => {
    const pool = makeImpactPreviewPool({
      tenants: [
        { tenant_id: 't1', company_name: 'Tenant 1', agent_endpoint: null },
      ],
      releaseStatuses: [
        { tenant_id: 't1', applied_release_id: 'rel-old', delivery_status: 'delivered' },
      ],
      desiredReleaseId: 'rel-new',
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV1Copy, null);

    const entry = manifest.entries[0];
    expect(entry.currentAppliedReleaseId).toBe('rel-old');
    expect(entry.desiredReleaseId).toBe('rel-new');
    expect(entry.deliveryStatus).toBe('delivered');
  });
});

describe('CatalogRolloutService.enqueueScopedRollout', () => {
  const releaseRow = {
    fingerprint: 'fp-123',
    compat_payload: `enc:${JSON.stringify(libraryV2)}`,
  };

  function makeRolloutPool(opts: {
    tenantsForFull?: Array<{ tenant_id: string }>;
  } = {}): ReturnType<typeof makeFakePool> {
    const tenantsForFull = opts.tenantsForFull ?? [];
    return makeFakePool([
      // Release lookup
      rowsResponder('FROM llm_catalog_releases', [releaseRow]),
      // Global LLM providers (prev library) — return null (empty library)
      rowsResponder('FROM runtime_configs', []),
      // Explicit-scope tenant eligibility query
      {
        match: (sql) => sql.includes('SELECT tenant_id, status, k8s_namespace, agent_endpoint'),
        respond: (params) => ({
          rows: ((params?.[0] as string[]) ?? []).map((tenantId) => ({
            tenant_id: tenantId,
            status: 'active',
            k8s_namespace: `ns-${tenantId}`,
            agent_endpoint: null,
          })),
          rowCount: ((params?.[0] as string[]) ?? []).length,
        }),
      },
      // Full-scope tenant query
      rowsResponder(
        'SELECT tenant_id FROM tenants',
        tenantsForFull.map((t) => ({ tenant_id: t.tenant_id })),
      ),
      // Impact preview tenant query (for affected scope)
      rowsResponder(
        'SELECT tenant_id, company_name',
        tenantsForFull.map((t) => ({
          tenant_id: t.tenant_id,
          company_name: 'Test',
          k8s_namespace: 'ns',
          agent_endpoint: null,
        })),
      ),
      // Image overrides (empty)
      rowsResponder('FROM tenant_image_overrides', []),
      // Release status bulk
      rowsResponder('FROM llm_tenant_release_status WHERE tenant_id = ANY', []),
      // Release pointer
      rowsResponder('FROM llm_catalog_release_pointer', [{ release_id: null }]),
      // INSERT llm_push_tasks — accept and return nothing
      rowsResponder('INSERT INTO llm_push_tasks', []),
      // INSERT llm_tenant_release_status — accept and return nothing
      rowsResponder('INSERT INTO llm_tenant_release_status', []),
    ]);
  }

  it('scope=single enqueues a tenant_push task', async () => {
    const pool = makeRolloutPool();
    const service = new CatalogRolloutService(pool as any);
    const result = await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'single',
      tenantIds: ['t42'],
      actor: 'admin@example.com',
      actorType: 'admin',
    });

    expect(result.taskId).toBeTruthy();
    expect(result.status).toBe('pending');
    expect(result.total).toBe(1);

    // Verify the push task insert used tenant_push kind
    const pushInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![1]).toBe('tenant_push'); // kind
    expect(pushInsert!.params![2]).toBe('t42'); // scope
    expect(pushInsert!.params![8]).toBe('rel-123'); // release_id
    expect(pushInsert!.params![9]).toBe('single'); // scope_type
  });

  it('scope=allowlist enqueues a global_push with allowlist scopeType', async () => {
    const pool = makeRolloutPool();
    const service = new CatalogRolloutService(pool as any);
    const result = await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'allowlist',
      tenantIds: ['t1', 't2', 't3'],
      actor: 'admin@example.com',
      actorType: 'admin',
    });

    expect(result.total).toBe(3);

    const pushInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![1]).toBe('global_push'); // kind
    expect(pushInsert!.params![2]).toBeNull(); // scope=null
    expect(pushInsert!.params![9]).toBe('allowlist'); // scope_type

    // Verify initTenantReleaseStatus was called with all 3 tenants
    const statusInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_tenant_release_status'));
    expect(statusInsert).toBeTruthy();
    // params: [releaseId, tenantId1, tenantId2, tenantId3]
    expect(statusInsert!.params).toHaveLength(4);
    expect(statusInsert!.params![0]).toBe('rel-123');
  });

  it('deduplicates eligible explicit targets and rejects ineligible targets', async () => {
    const eligiblePool = makeRolloutPool();
    const result = await new CatalogRolloutService(eligiblePool as any).enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'allowlist',
      tenantIds: ['t1', 't1', 't2'],
      actor: 'admin',
      actorType: 'admin',
    });
    expect(result.total).toBe(2);

    const ineligiblePool = makeFakePool([
      rowsResponder('FROM llm_catalog_releases', [releaseRow]),
      rowsResponder('FROM runtime_configs', []),
      rowsResponder('SELECT tenant_id, status, k8s_namespace, agent_endpoint', [
        { tenant_id: 'active', status: 'active', k8s_namespace: 'ns', agent_endpoint: null },
        { tenant_id: 'destroyed', status: 'destroyed', k8s_namespace: 'ns', agent_endpoint: null },
        { tenant_id: 'external', status: 'active', k8s_namespace: null, agent_endpoint: 'https://external' },
      ]),
    ]);
    await expect(new CatalogRolloutService(ineligiblePool as any).enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'allowlist',
      tenantIds: ['missing', 'destroyed', 'external'],
      actor: 'admin',
      actorType: 'admin',
    })).rejects.toThrow('INVALID_ROLLOUT_TARGETS: missing,destroyed,external');
  });

  it('scope=affected only targets tenants with affected=true', async () => {
    // Use libraryV1 as prev and libraryV2 (changed credentials) as next
    // so all standard tenants will be affected
    const pool = makeFakePool([
      // Release lookup
      rowsResponder('FROM llm_catalog_releases', [{
        fingerprint: 'fp-123',
        compat_payload: `enc:${JSON.stringify(libraryV2)}`,
      }]),
      // Global LLM providers (prev library) — return libraryV1
      {
        match: (sql) => sql.includes('FROM runtime_configs') && sql.includes('LLM_PROVIDERS'),
        respond: () => ({
          rows: [{ encrypted_value: `enc:${JSON.stringify(libraryV1)}` }],
          rowCount: 1,
        }),
      },
      // Impact preview tenant query (for affected scope in computeImpactManifest)
      rowsResponder(
        'SELECT tenant_id, company_name',
        [
          { tenant_id: 't1', company_name: 'T1', k8s_namespace: 'ns', agent_endpoint: null },
          { tenant_id: 't2', company_name: 'T2', k8s_namespace: 'ns', agent_endpoint: 'https://ext.com' },
        ],
      ),
      // Tenant selection (per-tenant)
      {
        match: (sql) => sql.includes('FROM runtime_configs') && sql.includes('LLM_MODEL_SELECTION'),
        respond: () => ({ rows: [], rowCount: 0 }),
      },
      // Image overrides (empty)
      rowsResponder('FROM tenant_image_overrides', []),
      // Release status bulk
      rowsResponder('FROM llm_tenant_release_status WHERE tenant_id = ANY', []),
      // Release pointer
      rowsResponder('FROM llm_catalog_release_pointer', [{ release_id: null }]),
      // INSERT llm_push_tasks
      rowsResponder('INSERT INTO llm_push_tasks', []),
      // INSERT llm_tenant_release_status
      rowsResponder('INSERT INTO llm_tenant_release_status', []),
    ]);

    const service = new CatalogRolloutService(pool as any);
    const result = await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'affected',
      actor: 'admin@example.com',
      actorType: 'admin',
    });

    // t1 is standard (agent_endpoint=null) → affected (credential changed)
    // t2 is internal (agent_endpoint set) → NOT affected
    expect(result.total).toBe(1);

    // Verify initTenantReleaseStatus was called with only t1
    const statusInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_tenant_release_status'));
    expect(statusInsert).toBeTruthy();
    expect(statusInsert!.params).toHaveLength(2); // releaseId + t1
    expect(statusInsert!.params![1]).toBe('t1');
  });

  it('throws when release is not found', async () => {
    const pool = makeFakePool([
      rowsResponder('FROM llm_catalog_releases', []), // no release
    ]);
    const service = new CatalogRolloutService(pool as any);
    await expect(
      service.enqueueScopedRollout({
        releaseId: 'nonexistent',
        scopeType: 'full',
        actor: 'admin',
        actorType: 'admin',
      }),
    ).rejects.toThrow(/not found or not active/);
  });

  it('throws when scope=single without tenantIds', async () => {
    const pool = makeRolloutPool();
    const service = new CatalogRolloutService(pool as any);
    await expect(
      service.enqueueScopedRollout({
        releaseId: 'rel-123',
        scopeType: 'single',
        actor: 'admin',
        actorType: 'admin',
      }),
    ).rejects.toThrow(/requires at least one tenantId/);
  });
});

describe('CatalogRolloutService.updateTenantAppliedStatus', () => {
  it('upserts the tenant release status with correct fields', async () => {
    const pool = makeFakePool([
      rowsResponder('INSERT INTO llm_tenant_release_status', []),
    ]);
    const service = new CatalogRolloutService(pool as any);
    await service.updateTenantAppliedStatus({
      tenantId: 't1',
      releaseId: 'rel-123',
      fingerprint: 'fp-abc',
      deliveryStatus: 'delivered',
      restartReason: 'default_model_credential_changed',
      error: null,
    });

    const upsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_tenant_release_status'));
    expect(upsert).toBeTruthy();
    expect(upsert!.params![0]).toBe('t1');       // tenant_id
    expect(upsert!.params![1]).toBe('rel-123');   // desired_release_id
    expect(upsert!.params![1]).toBe('rel-123');   // applied_release_id (same)
    expect(upsert!.params![2]).toBe('fp-abc');    // applied_fingerprint
    expect(upsert!.params![3]).toBe('default_model_credential_changed'); // restart_reason
    expect(upsert!.params![4]).toBe('delivered'); // delivery_status
    expect(upsert!.params![5]).toBeNull();        // error

    // Verify ON CONFLICT clause for upsert
    expect(upsert!.sql).toContain('ON CONFLICT');
    expect(upsert!.sql).toContain('DO UPDATE SET');
  });

  it('supports failed delivery status with error message', async () => {
    const pool = makeFakePool([
      rowsResponder('INSERT INTO llm_tenant_release_status', []),
    ]);
    const service = new CatalogRolloutService(pool as any);
    await service.updateTenantAppliedStatus({
      tenantId: 't2',
      releaseId: 'rel-456',
      fingerprint: 'fp-def',
      deliveryStatus: 'failed',
      restartReason: null,
      error: 'deployment not found',
    });

    const upsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_tenant_release_status'));
    expect(upsert).toBeTruthy();
    expect(upsert!.params![4]).toBe('failed');
    expect(upsert!.params![5]).toBe('deployment not found');
  });
});

describe('CatalogRolloutService.initTenantReleaseStatus', () => {
  it('batch-inserts desired release status for multiple tenants', async () => {
    const pool = makeFakePool([
      rowsResponder('INSERT INTO llm_tenant_release_status', []),
    ]);
    const service = new CatalogRolloutService(pool as any);
    await service.initTenantReleaseStatus('rel-789', ['t1', 't2', 't3']);

    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_tenant_release_status'));
    expect(insert).toBeTruthy();
    // params: [releaseId, t1, t2, t3]
    expect(insert!.params).toHaveLength(4);
    expect(insert!.params![0]).toBe('rel-789');
    expect(insert!.params![1]).toBe('t1');
    expect(insert!.params![2]).toBe('t2');
    expect(insert!.params![3]).toBe('t3');
    // Verify ON CONFLICT for idempotent upsert
    expect(insert!.sql).toContain('ON CONFLICT');
  });

  it('is a no-op when tenantIds is empty', async () => {
    const pool = makeFakePool([]);
    const service = new CatalogRolloutService(pool as any);
    await service.initTenantReleaseStatus('rel-789', []);
    // No queries should have been made
    expect(pool.queries).toHaveLength(0);
  });
});
