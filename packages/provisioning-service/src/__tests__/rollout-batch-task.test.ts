import { describe, it, expect, vi, beforeEach } from 'vitest';

const k8sMocks = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  updateDeploymentImageRecreate: vi.fn(),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

const overrideMocks = vi.hoisted(() => ({
  getOverrideMap: vi.fn(),
}));
vi.mock('../services/tenant-image-overrides.js', () => overrideMocks);

import {
  enqueueRolloutBatch,
  executeRolloutBatchTask,
  reapStaleRolloutBatchTasks,
  pruneOldRolloutBatchTasks,
  getRolloutBatchDetail,
  listRolloutBatchTasks,
} from '../services/rollout-batch-task.js';
import type { ProvisioningConfig } from '../config.js';

function makeConfig(overrides: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
  return {
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
    llmPushWorkerIntervalMs: 100,
    llmPushLeaseSeconds: 600,
    ...overrides,
  };
}

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    service: 'dealclaw-agent',
    image: 'test-registry/dealclaw/dealclaw-agent:new',
    tag: 'new',
    status: 'pending',
    total_count: 0,
    succeeded_count: 0,
    already_current_count: 0,
    pinned_count: 0,
    skipped_count: 0,
    failed_count: 0,
    error: null,
    actor: 'service-token',
    actor_type: 'service',
    lease_owner: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: new Date('2026-09-12T10:00:00Z'),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

function makeRolloutPool(opts: {
  task?: Record<string, unknown> | null;
  tenants?: Array<{ tenant_id: string; k8s_namespace: string }>;
  pendingItems?: Array<Record<string, unknown>>;
  existingTaskId?: string | null;
  recount?: Record<string, unknown>;
} = {}) {
  const queries: FakeQuery[] = [];
  const task = opts.task ?? null;
  const pending = [...(opts.pendingItems ?? [])];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });

      // enqueue 去重查询（幂等）——多行 SQL，用宽松匹配
      if (sql.includes('SELECT id FROM rollout_batch_tasks')) {
        return { rows: opts.existingTaskId ? [{ id: opts.existingTaskId }] : [], rowCount: opts.existingTaskId ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO rollout_batch_tasks') && sql.includes('ON CONFLICT')) {
        return { rows: [{ id: params![0] }], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM rollout_batch_task_items')) {
        const n = (opts.tenants ?? []).length; // enumerate 后 = tenants 数
        return { rows: [{ n }], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM rollout_batch_tasks')) {
        return { rows: [{ n: task ? 1 : 0 }], rowCount: 1 };
      }
      if (sql.includes('SELECT tenant_id, k8s_namespace FROM tenants')) {
        const rows = (opts.tenants ?? []).map((t) => ({ tenant_id: t.tenant_id, k8s_namespace: t.k8s_namespace }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('SELECT * FROM rollout_batch_tasks WHERE id = $1')) {
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('SELECT * FROM rollout_batch_task_items WHERE task_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT * FROM rollout_batch_tasks')) {
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('COUNT(*) FILTER')) {
        const r = opts.recount ?? {};
        return { rows: [{
          succeeded_count: String(r.succeeded_count ?? 0),
          already_current_count: String(r.already_current_count ?? 0),
          pinned_count: String(r.pinned_count ?? 0),
          skipped_count: String(r.skipped_count ?? 0),
          failed_count: String(r.failed_count ?? 0),
        }], rowCount: 1 };
      }
      if (sql.includes('WITH next AS')) {
        if (sql.includes('rollout_batch_task_items')) {
          // claimNextItem — 依次弹出 pending item，空了返回 null
          const item = pending.shift();
          return { rows: item ? [item] : [], rowCount: item ? 1 : 0 };
        }
        // claimNextTask
        return { rows: task && task.status === 'pending' ? [task] : [], rowCount: task && task.status === 'pending' ? 1 : 0 };
      }
      if (sql.includes('UPDATE rollout_batch_task_items')) {
        if (sql.includes('lease_expires_at < NOW()')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM rollout_batch_tasks')) {
        return { rows: [], rowCount: 5 };
      }
      if (sql.includes('UPDATE rollout_batch_tasks')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

beforeEach(() => {
  k8sMocks.getDeployment.mockReset();
  k8sMocks.updateDeploymentImageRecreate.mockReset();
  overrideMocks.getOverrideMap.mockReset();
  overrideMocks.getOverrideMap.mockResolvedValue(new Map());
});

describe('enqueueRolloutBatch', () => {
  it('inserts a pending task and returns a fresh id', async () => {
    const pool = makeRolloutPool({ existingTaskId: null });
    const r = await enqueueRolloutBatch(pool, {
      service: 'dealclaw-agent',
      image: 'test-registry/dealclaw/dealclaw-agent:new',
      tag: 'new',
      actor: 'service-token',
      actorType: 'service',
    });
    expect(r.taskId).toBeTruthy();
    expect(r.reused).toBe(false);
  });

  it('reuses an in-flight task for the same service+image (idempotent)', async () => {
    const pool = makeRolloutPool({ existingTaskId: 'existing-task' });
    const r = await enqueueRolloutBatch(pool, {
      service: 'dealclaw-agent',
      image: 'test-registry/dealclaw/dealclaw-agent:new',
      tag: 'new',
      actor: 'service-token',
      actorType: 'service',
    });
    expect(r.taskId).toBe('existing-task');
    expect(r.reused).toBe(true);
  });
});

describe('executeRolloutBatchTask', () => {
  it('recreates each tenant and finishes succeeded when none fail', async () => {
    k8sMocks.getDeployment.mockResolvedValue({
      spec: { template: { spec: { containers: [{ name: 'dealclaw-agent-t1', image: 'old' }] } } },
    });
    k8sMocks.updateDeploymentImageRecreate.mockResolvedValue(true);

    const pool = makeRolloutPool({
      task: makeTaskRow({ status: 'running' }),
      tenants: [
        { tenant_id: 't1', k8s_namespace: 'dealclaw-t1' },
        { tenant_id: 't2', k8s_namespace: 'dealclaw-t2' },
      ],
      pendingItems: [
        { id: 1, task_id: 'task-1', tenant_id: 't1', namespace: 'dealclaw-t1', deployment: 'dealclaw-agent-t1', status: 'pending', error: null, attempts: 0, started_at: null, finished_at: null, updated_at: new Date() },
        { id: 2, task_id: 'task-1', tenant_id: 't2', namespace: 'dealclaw-t2', deployment: 'dealclaw-agent-t2', status: 'pending', error: null, attempts: 0, started_at: null, finished_at: null, updated_at: new Date() },
      ],
    });
    const broker = { publish: vi.fn(), close: vi.fn() };
    await executeRolloutBatchTask(pool, makeConfig(), broker as any, makeTaskRow({ status: 'running' }) as any);

    // 每个 tenant 各一次 recreate，使用 item.namespace（非 dealclaw-<id> 硬编码）
    expect(k8sMocks.updateDeploymentImageRecreate).toHaveBeenCalledTimes(2);
    expect(k8sMocks.updateDeploymentImageRecreate.mock.calls[0][0]).toBe('dealclaw-t1');

    const events = broker.publish.mock.calls.map((c: unknown[]) => c[1]);
    expect(events.filter((e) => e === 'item')).toHaveLength(2);
    expect(events).toContain('snapshot');
    expect(events).toContain('task');
    expect(events).toContain('done');
    expect(broker.close).toHaveBeenCalledWith('task-1');

    const finish = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE rollout_batch_tasks') && q.sql.includes('finished_at = NOW()'),
    );
    expect(finish).toBeTruthy();
    expect(finish!.params![0]).toBe('succeeded');
  });

  it('marks a tenant failed when recreate throws', async () => {
    k8sMocks.getDeployment.mockResolvedValue({
      spec: { template: { spec: { containers: [{ name: 'dealclaw-agent-t1', image: 'old' }] } } },
    });
    k8sMocks.updateDeploymentImageRecreate.mockRejectedValue(new Error('boom'));

    const pool = makeRolloutPool({
      task: makeTaskRow({ status: 'running' }),
      tenants: [{ tenant_id: 't1', k8s_namespace: 'dealclaw-t1' }],
      pendingItems: [
        { id: 1, task_id: 'task-1', tenant_id: 't1', namespace: 'dealclaw-t1', deployment: 'dealclaw-agent-t1', status: 'pending', error: null, attempts: 0, started_at: null, finished_at: null, updated_at: new Date() },
      ],
    });
    const broker = { publish: vi.fn(), close: vi.fn() };
    await executeRolloutBatchTask(pool, makeConfig(), broker as any, makeTaskRow({ status: 'running' }) as any);

    // failed item 落库
    const itemUpdate = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE rollout_batch_task_items') && q.sql.includes("status = $1"),
    );
    expect(itemUpdate).toBeTruthy();
    expect(itemUpdate!.params![0]).toBe('failed');
  });
});

describe('reap / prune / queries', () => {
  it('reaps stale tasks', async () => {
    const pool = makeRolloutPool({});
    expect(await reapStaleRolloutBatchTasks(pool)).toBe(0);
  });

  it('prunes old finished tasks', async () => {
    const pool = makeRolloutPool({});
    expect(await pruneOldRolloutBatchTasks(pool, 30)).toBe(5);
  });

  it('returns null for an unknown task detail', async () => {
    const pool = makeRolloutPool({ task: null });
    expect(await getRolloutBatchDetail(pool, 'nope')).toBeNull();
  });

  it('lists tasks', async () => {
    const pool = makeRolloutPool({ task: makeTaskRow({ status: 'succeeded', total_count: 3, succeeded_count: 3 }) });
    const r = await listRolloutBatchTasks(pool, {});
    expect(r.total).toBe(1);
    expect(r.tasks[0].status).toBe('succeeded');
  });
});
