import { describe, it, expect, vi } from 'vitest';

// Mock crypto with the same enc: prefix passthrough as existing tests.
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
import {
  maybePromoteNextBatch,
  pauseRolloutBatch,
  recountBatchStats,
  resumeRolloutBatch,
} from '../services/llm-push-task.js';
import type { LlmProvidersConfig, TenantModelSelection } from '../services/llm-providers.js';
import type { LlmPushTaskRecord } from '../services/llm-push-types.js';

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
      apiKey: 'sk-new-key',
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

// ── Fake pool infrastructure ──

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

// Helper: build a fake pool for enqueueScopedRollout with given tenants.
function makeRolloutPool(opts: {
  tenantsForFull?: Array<{ tenant_id: string }>;
  releasePayload?: LlmProvidersConfig;
} = {}): ReturnType<typeof makeFakePool> {
  const tenantsForFull = opts.tenantsForFull ?? [];
  const releasePayload = opts.releasePayload ?? libraryV2;
  return makeFakePool([
    // Release lookup
    rowsResponder('FROM llm_catalog_releases', [{
      fingerprint: 'fp-123',
      compat_payload: `enc:${JSON.stringify(releasePayload)}`,
    }]),
    // Global LLM providers (prev library) — return empty
    rowsResponder('FROM runtime_configs', []),
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
    // INSERT llm_push_tasks
    rowsResponder('INSERT INTO llm_push_tasks', []),
    // INSERT llm_push_task_items (batched items)
    rowsResponder('INSERT INTO llm_push_task_items', []),
    // INSERT llm_tenant_release_status
    rowsResponder('INSERT INTO llm_tenant_release_status', []),
    // UPDATE llm_push_tasks SET total_count
    rowsResponder('UPDATE llm_push_tasks SET total_count', []),
  ]);
}

// Helper: build a task record for batch testing.
function makeBatchTask(overrides: Partial<LlmPushTaskRecord> = {}): LlmPushTaskRecord {
  return {
    id: 'batch-task-1',
    kind: 'global_push',
    scope: null,
    trigger: 'save',
    status: 'running',
    prev_library: 'enc:{}',
    next_library: 'enc:{}',
    total_count: 12,
    succeeded_count: 0,
    failed_count: 0,
    skipped_count: 0,
    error: null,
    actor: 'admin',
    actor_type: 'admin',
    lease_owner: 'worker-1',
    lease_expires_at: null,
    cancel_requested: false,
    created_at: new Date('2026-09-16T10:00:00Z'),
    started_at: new Date('2026-09-16T10:00:01Z'),
    finished_at: null,
    release_id: null,
    scope_type: 'full',
    idempotency_key: null,
    batch_size: 5,
    batch_total: 3,
    batch_interval_ms: 0,
    auto_pause_thresholds: null,
    ...overrides,
  };
}

// ── Tests: enqueueScopedRollout batch control ──

describe('enqueueScopedRollout — unbatched (batchSize=0)', () => {
  it('enqueues all items as a single wave (no batch metadata)', async () => {
    const pool = makeRolloutPool({
      tenantsForFull: [
        { tenant_id: 't1' },
        { tenant_id: 't2' },
        { tenant_id: 't3' },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const result = await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'allowlist',
      tenantIds: ['t1', 't2', 't3'],
      actor: 'admin@example.com',
      actorType: 'admin',
    });

    expect(result.total).toBe(3);

    // Verify push task INSERT includes batch_size=0, batch_total=0.
    const pushInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    // batch_size is at $12 (index 11), batch_total at $13 (index 12)
    expect(pushInsert!.params![11]).toBe(0); // batch_size
    expect(pushInsert!.params![12]).toBe(0); // batch_total

    // No batched items INSERT should have happened (batchSize=0).
    const itemsInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_task_items'));
    expect(itemsInsert).toBeUndefined();
  });
});

describe('enqueueScopedRollout — batched (batchSize=5)', () => {
  it('splits 12 tenants into 3 batches: first pending, rest paused', async () => {
    const tenants = Array.from({ length: 12 }, (_, i) => ({
      tenant_id: `t${i + 1}`,
    }));
    const pool = makeRolloutPool({ tenantsForFull: tenants });
    const service = new CatalogRolloutService(pool as any);
    const result = await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'full',
      actor: 'admin@example.com',
      actorType: 'admin',
      batchSize: 5,
    });

    expect(result.total).toBe(12);

    // Verify push task INSERT has batch_size=5, batch_total=3.
    const pushInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![11]).toBe(5);  // batch_size
    expect(pushInsert!.params![12]).toBe(3);  // batch_total
    expect(pushInsert!.params![13]).toBe(0);  // batch_interval_ms
    expect(pushInsert!.params![14]).toBeNull(); // auto_pause_thresholds

    // Verify 3 batch INSERTs were executed (one per batch).
    const itemsInserts = pool.queries.filter((q) =>
      q.sql.includes('INSERT INTO llm_push_task_items'),
    );
    expect(itemsInserts).toHaveLength(3);

    // Batch 0 (t1..t5) — batch_status='pending'
    const batch0 = itemsInserts[0];
    expect(batch0.params).toContain('pending');
    // Last 3 params: batchIndex, batchTotal, batchStatus
    const batch0Status = batch0.params![batch0.params!.length - 1];
    expect(batch0Status).toBe('pending');
    const batch0Total = batch0.params![batch0.params!.length - 2];
    expect(batch0Total).toBe(3);
    const batch0Index = batch0.params![batch0.params!.length - 3];
    expect(batch0Index).toBe(0);

    // Batch 1 (t6..t10) — batch_status='paused'
    const batch1 = itemsInserts[1];
    const batch1Status = batch1.params![batch1.params!.length - 1];
    expect(batch1Status).toBe('paused');
    const batch1Index = batch1.params![batch1.params!.length - 3];
    expect(batch1Index).toBe(1);

    // Batch 2 (t11..t12) — batch_status='paused'
    const batch2 = itemsInserts[2];
    const batch2Status = batch2.params![batch2.params!.length - 1];
    expect(batch2Status).toBe('paused');
    const batch2Index = batch2.params![batch2.params!.length - 3];
    expect(batch2Index).toBe(2);

    // Verify total_count was updated.
    const totalUpdate = pool.queries.find((q) =>
      q.sql.includes('UPDATE llm_push_tasks SET total_count'),
    );
    expect(totalUpdate).toBeTruthy();
    expect(totalUpdate!.params![0]).toBe(12);
  });

  it('passes auto-pause thresholds through to the push task', async () => {
    const pool = makeRolloutPool({
      tenantsForFull: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
    });
    const service = new CatalogRolloutService(pool as any);
    await service.enqueueScopedRollout({
      releaseId: 'rel-123',
      scopeType: 'allowlist',
      tenantIds: ['t1', 't2'],
      actor: 'admin',
      actorType: 'admin',
      batchSize: 1,
      batchIntervalMs: 5000,
      autoPauseThresholds: { maxFailureRate: 0.5, minSuccessCount: 2 },
    });

    const pushInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![11]).toBe(1);     // batch_size
    expect(pushInsert!.params![12]).toBe(2);     // batch_total
    expect(pushInsert!.params![13]).toBe(5000);  // batch_interval_ms
    const thresholdsJson = pushInsert!.params![14];
    expect(thresholdsJson).toBe(JSON.stringify({ maxFailureRate: 0.5, minSuccessCount: 2 }));
  });
});

// ── Tests: auto-pause threshold logic ──

describe('maybePromoteNextBatch — auto-pause triggers', () => {
  it('pauses subsequent batches when failure rate exceeds threshold', async () => {
    // Batch 0: 3 succeeded, 2 failed → failure rate 0.4 > 0.3 → auto-pause
    const batchItems = [
      { task_id: 'batch-task-1', tenant_id: 't1', status: 'succeeded', batch_index: 0, batch_status: 'completed' },
      { task_id: 'batch-task-1', tenant_id: 't2', status: 'succeeded', batch_index: 0, batch_status: 'completed' },
      { task_id: 'batch-task-1', tenant_id: 't3', status: 'succeeded', batch_index: 0, batch_status: 'completed' },
      { task_id: 'batch-task-1', tenant_id: 't4', status: 'failed', batch_index: 0, batch_status: 'completed' },
      { task_id: 'batch-task-1', tenant_id: 't5', status: 'failed', batch_index: 0, batch_status: 'completed' },
      { task_id: 'batch-task-1', tenant_id: 't6', status: 'pending', batch_index: 1, batch_status: 'paused' },
      { task_id: 'batch-task-1', tenant_id: 't7', status: 'pending', batch_index: 1, batch_status: 'paused' },
    ];

    const pool = makeFakePool([
      // Batch status query (GROUP BY batch_index)
      {
        match: (sql) => sql.includes('GROUP BY batch_index') && sql.includes('batch_index IS NOT NULL'),
        respond: () => ({
          rows: [{ batch_index: 0, done_count: '5', total_count: '5' }],
          rowCount: 1,
        }),
      },
      // Next paused batch count query
      {
        match: (sql) => sql.includes('batch_index = $2') && sql.includes("batch_status = 'paused'"),
        respond: () => ({ rows: [{ n: 2 }], rowCount: 1 }),
      },
      // recountBatchStats (COUNT(*) FILTER)
      {
        match: (sql) => sql.includes('COUNT(*) FILTER') && sql.includes('batch_index = $2'),
        respond: () => ({
          rows: [{ succeeded_count: '3', failed_count: '2', skipped_count: '0' }],
          rowCount: 1,
        }),
      },
      // UPDATE llm_push_task_items SET batch_status='paused'
      rowsResponder("SET batch_status = 'paused'", []),
      // UPDATE llm_push_tasks SET error / status='partial'
      rowsResponder('SET error = $1, status', []),
    ]);

    const task = makeBatchTask({
      auto_pause_thresholds: { maxFailureRate: 0.3, minSuccessCount: 3 },
    });

    const result = await maybePromoteNextBatch(pool as any, task);
    expect(result.promoted).toBe(false);
    expect(result.autoPaused).toBe(true);

    // Verify task was set to 'partial' with AUTO_PAUSED error.
    const taskUpdate = pool.queries.find((q) =>
      q.sql.includes('UPDATE llm_push_tasks') && q.sql.includes('status') && q.sql.includes('error'),
    );
    expect(taskUpdate).toBeTruthy();
    expect(String(taskUpdate!.params![0])).toContain('AUTO_PAUSED');
    expect(taskUpdate!.params![0]).toContain('0.40');
  });

  it('promotes next batch when failure rate is below threshold', async () => {
    // Batch 0: 4 succeeded, 1 failed → failure rate 0.2 < 0.3 → promote
    const pool = makeFakePool([
      // Batch status query
      {
        match: (sql) => sql.includes('GROUP BY batch_index') && sql.includes('batch_index IS NOT NULL'),
        respond: () => ({
          rows: [{ batch_index: 0, done_count: '5', total_count: '5' }],
          rowCount: 1,
        }),
      },
      // Next paused batch count
      {
        match: (sql) => sql.includes('batch_index = $2') && sql.includes("batch_status = 'paused'"),
        respond: () => ({ rows: [{ n: 5 }], rowCount: 1 }),
      },
      // recountBatchStats
      {
        match: (sql) => sql.includes('COUNT(*) FILTER') && sql.includes('batch_index = $2'),
        respond: () => ({
          rows: [{ succeeded_count: '4', failed_count: '1', skipped_count: '0' }],
          rowCount: 1,
        }),
      },
      // Promote: UPDATE items SET batch_status='pending'
      {
        match: (sql) => sql.includes("SET batch_status = 'pending'") && sql.includes('batch_index = $2'),
        respond: () => ({ rows: [], rowCount: 5 }),
      },
    ]);

    const task = makeBatchTask({
      auto_pause_thresholds: { maxFailureRate: 0.3, minSuccessCount: 3 },
    });

    const result = await maybePromoteNextBatch(pool as any, task);
    expect(result.promoted).toBe(true);
    expect(result.autoPaused).toBe(false);

    // Verify the promote UPDATE ran.
    const promoteUpdate = pool.queries.find((q) =>
      q.sql.includes("SET batch_status = 'pending'") && q.sql.includes('batch_index = $2'),
    );
    expect(promoteUpdate).toBeTruthy();
    expect(promoteUpdate!.params![1]).toBe(1); // nextBatchIndex
  });

  it('does not auto-pause when totalAttempted < minSuccessCount', async () => {
    // Batch 0: 1 succeeded, 1 failed → failure rate 0.5 > 0.3, BUT only 2 attempts < 3 min
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('GROUP BY batch_index') && sql.includes('batch_index IS NOT NULL'),
        respond: () => ({
          rows: [{ batch_index: 0, done_count: '2', total_count: '2' }],
          rowCount: 1,
        }),
      },
      {
        match: (sql) => sql.includes('batch_index = $2') && sql.includes("batch_status = 'paused'"),
        respond: () => ({ rows: [{ n: 3 }], rowCount: 1 }),
      },
      {
        match: (sql) => sql.includes('COUNT(*) FILTER') && sql.includes('batch_index = $2'),
        respond: () => ({
          rows: [{ succeeded_count: '1', failed_count: '1', skipped_count: '0' }],
          rowCount: 1,
        }),
      },
      {
        match: (sql) => sql.includes("SET batch_status = 'pending'") && sql.includes('batch_index = $2'),
        respond: () => ({ rows: [], rowCount: 3 }),
      },
    ]);

    const task = makeBatchTask({
      auto_pause_thresholds: { maxFailureRate: 0.3, minSuccessCount: 3 },
    });

    const result = await maybePromoteNextBatch(pool as any, task);
    // minSuccessCount=3, but only 2 attempts → thresholds not checked → promote
    expect(result.promoted).toBe(true);
    expect(result.autoPaused).toBe(false);
  });

  it('returns promoted=false when no paused batch exists', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('GROUP BY batch_index') && sql.includes('batch_index IS NOT NULL'),
        respond: () => ({
          rows: [{ batch_index: 2, done_count: '5', total_count: '5' }],
          rowCount: 1,
        }),
      },
      {
        match: (sql) => sql.includes('batch_index = $2') && sql.includes("batch_status = 'paused'"),
        respond: () => ({ rows: [{ n: 0 }], rowCount: 1 }),
      },
    ]);

    const task = makeBatchTask();
    const result = await maybePromoteNextBatch(pool as any, task);
    expect(result.promoted).toBe(false);
    expect(result.autoPaused).toBe(false);
  });

  it('returns promoted=false when no completed batch exists', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('GROUP BY batch_index') && sql.includes('batch_index IS NOT NULL'),
        respond: () => ({
          rows: [{ batch_index: 0, done_count: '3', total_count: '5' }],
          rowCount: 1,
        }),
      },
    ]);

    const task = makeBatchTask();
    const result = await maybePromoteNextBatch(pool as any, task);
    expect(result.promoted).toBe(false);
    expect(result.autoPaused).toBe(false);
  });
});

// ── Tests: recountBatchStats ──

describe('recountBatchStats', () => {
  it('returns correct counts for a given batch', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('COUNT(*) FILTER') && sql.includes('batch_index = $2'),
        respond: () => ({
          rows: [{ succeeded_count: '7', failed_count: '2', skipped_count: '1' }],
          rowCount: 1,
        }),
      },
    ]);

    const stats = await recountBatchStats(pool as any, 'task-1', 0);
    expect(stats.succeeded).toBe(7);
    expect(stats.failed).toBe(2);
    expect(stats.skipped).toBe(1);
  });

  it('returns zeros when no items found', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('COUNT(*) FILTER') && sql.includes('batch_index = $2'),
        respond: () => ({
          rows: [{ succeeded_count: null, failed_count: null, skipped_count: null }],
          rowCount: 1,
        }),
      },
    ]);

    const stats = await recountBatchStats(pool as any, 'task-1', 99);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.skipped).toBe(0);
  });
});

// ── Tests: pause/resume API functions ──

describe('pauseRolloutBatch', () => {
  it('pauses all pending items with batch_status=pending', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('SET batch_status = \'paused\'') && sql.includes('batch_status = \'pending\''),
        respond: () => ({ rows: [], rowCount: 5 }),
      },
    ]);

    const count = await pauseRolloutBatch(pool as any, 'task-1');
    expect(count).toBe(5);

    const update = pool.queries[0];
    expect(update.sql).toContain('batch_status = \'paused\'');
    expect(update.sql).toContain("status = 'pending'");
    expect(update.params![0]).toBe('task-1');
  });

  it('returns 0 when no pending items to pause', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('SET batch_status = \'paused\''),
        respond: () => ({ rows: [], rowCount: 0 }),
      },
    ]);

    const count = await pauseRolloutBatch(pool as any, 'task-1');
    expect(count).toBe(0);
  });
});

describe('resumeRolloutBatch', () => {
  it('promotes the next paused batch to pending', async () => {
    let callIdx = 0;
    const pool = makeFakePool([
      // First query: find next paused batch_index
      {
        match: (sql) => sql.includes('SELECT DISTINCT batch_index') && sql.includes('paused'),
        respond: () => {
          callIdx++;
          return { rows: [{ batch_index: 2 }], rowCount: 1 };
        },
      },
      // Second query: promote items
      {
        match: (sql) => sql.includes('SET batch_status = \'pending\''),
        respond: () => ({ rows: [], rowCount: 5 }),
      },
    ]);

    const count = await resumeRolloutBatch(pool as any, 'task-1');
    expect(count).toBe(5);

    // Verify the promote UPDATE targeted batch_index=2.
    const promoteUpdate = pool.queries.find((q) =>
      q.sql.includes('SET batch_status = \'pending\''),
    );
    expect(promoteUpdate).toBeTruthy();
    expect(promoteUpdate!.params![1]).toBe(2); // nextBatch
  });

  it('returns 0 when no paused batch exists', async () => {
    const pool = makeFakePool([
      {
        match: (sql) => sql.includes('SELECT DISTINCT batch_index') && sql.includes('paused'),
        respond: () => ({ rows: [], rowCount: 0 }),
      },
    ]);

    const count = await resumeRolloutBatch(pool as any, 'task-1');
    expect(count).toBe(0);
  });
});

// ── Tests: External Agent marking in computeImpactManifest ──

describe('computeImpactManifest — External Agent marking', () => {
  function makeExternalAgentPool(opts: {
    tenants: Array<{
      tenant_id: string;
      company_name: string;
      agent_endpoint: string | null;
      k8s_namespace: string | null;
    }>;
  }) {
    const tenants = opts.tenants;
    return makeFakePool([
      // Tenant query — now includes all active tenants (no k8s_namespace filter)
      {
        match: (sql) => sql.includes('SELECT tenant_id, company_name, k8s_namespace, agent_endpoint'),
        respond: () => ({
          rows: tenants.map((t) => ({
            tenant_id: t.tenant_id,
            company_name: t.company_name,
            k8s_namespace: t.k8s_namespace,
            agent_endpoint: t.agent_endpoint,
          })),
          rowCount: tenants.length,
        }),
      },
      // Tenant model selection (per-tenant)
      {
        match: (sql) => sql.includes('FROM runtime_configs') && sql.includes('LLM_MODEL_SELECTION'),
        respond: () => ({ rows: [], rowCount: 0 }),
      },
      // Image overrides
      rowsResponder('FROM tenant_image_overrides', []),
      // Release status bulk
      rowsResponder('FROM llm_tenant_release_status WHERE tenant_id = ANY', []),
      // Release pointer
      rowsResponder('FROM llm_catalog_release_pointer', [{ release_id: null }]),
    ]);
  }

  it('marks External Agent tenants (agent_endpoint set, k8s_namespace null) as unsupported', async () => {
    const pool = makeExternalAgentPool({
      tenants: [
        {
          tenant_id: 't1',
          company_name: 'External Agent',
          agent_endpoint: 'https://external.example.com',
          k8s_namespace: null,
        },
        {
          tenant_id: 't2',
          company_name: 'Standard Tenant',
          agent_endpoint: null,
          k8s_namespace: 'ns-t2',
        },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    expect(manifest.totalTenants).toBe(2);

    const external = manifest.entries.find((e) => e.tenantId === 't1');
    const standard = manifest.entries.find((e) => e.tenantId === 't2');

    // External agent is marked as unsupported.
    expect(external).toBeTruthy();
    expect(external!.affected).toBe(false);
    expect(external!.agentRestart).toBe(false);
    expect(external!.gatewayRestart).toBe(false);
    expect(external!.deliveryStatus).toBe('unsupported');
    expect(external!.affectedReasons).toContain('external_agent: no k8s deployment to rollout');

    // Standard tenant is affected (credentials changed).
    expect(standard).toBeTruthy();
    expect(standard!.affected).toBe(true);
    expect(standard!.deliveryStatus).not.toBe('unsupported');
  });

  it('does not mark internal tenants (agent_endpoint set, k8s_namespace set) as unsupported', async () => {
    const pool = makeExternalAgentPool({
      tenants: [
        {
          tenant_id: 't1',
          company_name: 'Internal with endpoint',
          agent_endpoint: 'https://custom.example.com',
          k8s_namespace: 'ns-t1',
        },
        {
          tenant_id: 't2',
          company_name: 'Standard',
          agent_endpoint: null,
          k8s_namespace: 'ns-t2',
        },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    const internal = manifest.entries.find((e) => e.tenantId === 't1');
    expect(internal).toBeTruthy();
    // k8s_namespace is set → not external → not unsupported
    expect(internal!.deliveryStatus).not.toBe('unsupported');
    expect(internal!.affected).toBe(false); // hasAgent=false → not affected
  });

  it('counts only non-unsupported tenants in affectedTenants', async () => {
    const pool = makeExternalAgentPool({
      tenants: [
        {
          tenant_id: 'ext-1',
          company_name: 'External',
          agent_endpoint: 'https://ext.example.com',
          k8s_namespace: null,
        },
        {
          tenant_id: 'std-1',
          company_name: 'Standard 1',
          agent_endpoint: null,
          k8s_namespace: 'ns-std-1',
        },
        {
          tenant_id: 'std-2',
          company_name: 'Standard 2',
          agent_endpoint: null,
          k8s_namespace: 'ns-std-2',
        },
      ],
    });
    const service = new CatalogRolloutService(pool as any);
    const manifest = await service.computeImpactManifest(libraryV1, libraryV2, null);

    expect(manifest.totalTenants).toBe(3);
    expect(manifest.affectedTenants).toBe(2); // only std-1 and std-2
    expect(manifest.unaffectedTenants).toBe(1); // ext-1 (unsupported = not affected)

    const ext = manifest.entries.find((e) => e.tenantId === 'ext-1');
    expect(ext!.deliveryStatus).toBe('unsupported');
  });
});
