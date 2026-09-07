import { describe, it, expect, vi } from 'vitest';

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

import {
  enqueueLlmPush,
  claimNextTask,
  executeTask,
  listTasks,
  getTaskDetail,
  retryFailedItems,
  requestCancel,
  reapStaleTasks,
  pruneOldLlmPushTasks,
} from '../services/llm-push-task.js';
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
    kind: 'global_push',
    scope: null,
    trigger: 'save',
    status: 'pending',
    prev_library: 'enc:{}',
    next_library: 'enc:{}',
    total_count: 0,
    succeeded_count: 0,
    failed_count: 0,
    skipped_count: 0,
    error: null,
    actor: 'admin',
    actor_type: 'admin',
    lease_owner: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: new Date('2026-09-04T10:00:00Z'),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function makeItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: 'task-1',
    tenant_id: 't123',
    status: 'succeeded',
    restarted: true,
    gateway_restarted: false,
    skip_restart: false,
    error: null,
    attempts: 1,
    started_at: new Date('2026-09-04T10:00:01Z'),
    finished_at: new Date('2026-09-04T10:00:02Z'),
    updated_at: new Date('2026-09-04T10:00:02Z'),
    ...overrides,
  };
}

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

/**
 * pg.Pool 替身：记录所有 SQL 并按模式返回 canned 结果。覆盖 worker 的
 * countItems / enumerateTargets / claimNextItem / recount / finishTask，
 * 以及 reap / retry / cancel 的两条 UPDATE。crypto 已被 mock 为 `enc:` 前缀
 * 透传，与 llm-providers.test.ts 一致。
 */
function makePushPool(opts: {
  task?: Record<string, unknown> | null;
  allTenants?: string[];
  items?: Record<string, unknown>[];
  claimTask?: Record<string, unknown> | null;
  reapItems?: number;
  reapTasks?: number;
  retryReset?: number;
  pruneDeleted?: number;
} = {}) {
  const queries: FakeQuery[] = [];
  const task = opts.task ?? null;
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes('SELECT COUNT(*)::int AS n FROM llm_push_task_items')) {
        return { rows: [{ n: (opts.items ?? []).length }], rowCount: 1 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM llm_push_tasks')) {
        return { rows: [{ n: task ? 1 : 0 }], rowCount: 1 };
      }
      if (sql.includes('SELECT tenant_id FROM tenants')) {
        const ids = opts.allTenants ?? [];
        return { rows: ids.map((id) => ({ tenant_id: id })), rowCount: ids.length };
      }
      if (sql.includes('SELECT cancel_requested FROM llm_push_tasks')) {
        return { rows: [{ cancel_requested: false }], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM llm_push_tasks WHERE id = $1')) {
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('SELECT * FROM llm_push_task_items WHERE task_id')) {
        return { rows: opts.items ?? [], rowCount: (opts.items ?? []).length };
      }
      if (sql.includes('SELECT * FROM llm_push_tasks')) {
        // listTasks (no WHERE id) / getTaskById fallback
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('COUNT(*) FILTER')) {
        const items = opts.items ?? [];
        return {
          rows: [
            {
              succeeded_count: items.filter((i) => i.status === 'succeeded').length,
              failed_count: items.filter((i) => i.status === 'failed').length,
              skipped_count: items.filter((i) => i.status === 'skipped').length,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('WITH next AS')) {
        if (sql.includes('llm_push_task_items')) {
          // claimNextItem — no pending items left
          return { rows: [], rowCount: 0 };
        }
        // claimNextTask
        return { rows: opts.claimTask ? [opts.claimTask] : [], rowCount: opts.claimTask ? 1 : 0 };
      }
      if (sql.includes('UPDATE llm_push_task_items')) {
        if (sql.includes('lease_expires_at < NOW()')) {
          return { rows: [], rowCount: opts.reapItems ?? 0 };
        }
        return { rows: [], rowCount: opts.retryReset ?? 0 };
      }
      if (sql.includes('DELETE FROM llm_push_tasks')) {
        return { rows: [], rowCount: opts.pruneDeleted ?? 0 };
      }
      if (sql.includes('UPDATE llm_push_tasks')) {
        if (sql.includes('lease_expires_at < NOW()')) {
          return { rows: [], rowCount: opts.reapTasks ?? 0 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

const goodLibrary = {
  providers: [
    { name: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', apiKey: 'sk', models: [{ id: 'qwen-max' }] },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
};

describe('enqueueLlmPush', () => {
  it('encrypts the prev/next library snapshots and inserts a pending task', async () => {
    const pool = makePushPool();
    const { taskId, status } = await enqueueLlmPush(pool, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: null,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
    });
    expect(taskId).toBeTruthy();
    expect(status).toBe('pending');

    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();
    // prev/next snapshots are encrypted (enc: prefix), never plaintext JSON.
    expect(String(insert!.params![5])).toMatch(/^enc:/);
    expect(String(insert!.params![5])).not.toBe(JSON.stringify(goodLibrary));
    // null prev stays null (clear-library case).
    expect(insert!.params![4]).toBeNull();
  });
});

describe('claimNextTask', () => {
  it('claims the oldest pending task with SKIP LOCKED and a lease', async () => {
    const pool = makePushPool({ claimTask: makeTaskRow({ status: 'pending' }) });
    const claimed = await claimNextTask(pool, 600);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe('task-1');

    const q = pool.queries.find((x: FakeQuery) => x.sql.includes('FOR UPDATE SKIP LOCKED'));
    expect(q).toBeTruthy();
    expect(q!.params![0]).toEqual(expect.any(String));
    expect(q!.params![1]).toBe(600);
  });

  it('returns null when no pending task exists', async () => {
    const pool = makePushPool({ claimTask: null });
    expect(await claimNextTask(pool, 600)).toBeNull();
  });
});

describe('executeTask (dry-run, 0 tenants)', () => {
  it('runs a 0-tenant task to completion and publishes snapshot→task→done', async () => {
    const pool = makePushPool({ task: makeTaskRow({ status: 'running' }), allTenants: [] });
    const broker = { publish: vi.fn(), close: vi.fn() };
    await executeTask(pool, makeConfig(), broker as any, makeTaskRow({ status: 'running' }) as any);

    const events = broker.publish.mock.calls.map((c: unknown[]) => c[1]);
    expect(events).toContain('snapshot');
    expect(events).toContain('task');
    expect(events).toContain('done');
    expect(events).not.toContain('item'); // no tenants → no per-tenant events
    expect(broker.close).toHaveBeenCalledWith('task-1');

    // 0 failed items → task finishes as succeeded (not partial/failed).
    const finish = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_tasks') && q.sql.includes('finished_at = NOW()'),
    );
    expect(finish).toBeTruthy();
    expect(finish!.params![0]).toBe('succeeded');
  });

  it('fails closed (status=failed) when the library snapshot cannot be decrypted', async () => {
    // Corrupted snapshot: decryptValue returns non-enc garbage → JSON.parse throws.
    const pool = makePushPool({
      task: makeTaskRow({ status: 'running', prev_library: 'garbage', next_library: 'garbage' }),
      allTenants: [],
    });
    const broker = { publish: vi.fn(), close: vi.fn() };
    await executeTask(
      pool,
      makeConfig(),
      broker as any,
      makeTaskRow({ status: 'running', prev_library: 'garbage', next_library: 'garbage' }) as any,
    );

    const events = broker.publish.mock.calls.map((c: unknown[]) => c[1]);
    expect(events).toContain('done');
    const finish = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_tasks') && q.sql.includes('finished_at = NOW()'),
    );
    expect(finish).toBeTruthy();
    expect(finish!.params![0]).toBe('failed');
  });
});

describe('reapStaleTasks (crash recovery)', () => {
  it('resets in-flight items and re-queues expired running tasks', async () => {
    const pool = makePushPool({ reapItems: 1, reapTasks: 2 });
    const n = await reapStaleTasks(pool);
    expect(n).toBe(2);

    const itemReset = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_task_items') && q.sql.includes('lease_expires_at < NOW()'),
    );
    expect(itemReset).toBeTruthy();

    const taskReset = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_tasks') && q.sql.includes('lease_expires_at < NOW()'),
    );
    expect(taskReset).toBeTruthy();
  });
});

describe('retryFailedItems', () => {
  it('resets failed items and reopens a terminal task', async () => {
    const pool = makePushPool({ retryReset: 3 });
    const n = await retryFailedItems(pool, 'task-1');
    expect(n).toBe(3);

    const itemUpdate = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_task_items') && q.sql.includes("status = 'pending'"),
    );
    expect(itemUpdate).toBeTruthy();
    expect(itemUpdate!.params![0]).toBe('task-1');

    const taskUpdate = pool.queries.find(
      (q: FakeQuery) => q.sql.includes('UPDATE llm_push_tasks') && q.sql.includes("status = 'pending'"),
    );
    expect(taskUpdate).toBeTruthy();
  });
});

describe('requestCancel', () => {
  it('marks a pending task cancelled', async () => {
    const pool = makePushPool({ task: makeTaskRow({ status: 'pending' }) });
    expect(await requestCancel(pool, 'task-1')).toBe(true);
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes("SET status = 'cancelled'"))).toBe(true);
  });

  it('flags a running task for cooperative cancel', async () => {
    const pool = makePushPool({ task: makeTaskRow({ status: 'running' }) });
    expect(await requestCancel(pool, 'task-1')).toBe(true);
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('SET cancel_requested = TRUE'))).toBe(true);
  });

  it('returns false for an unknown task', async () => {
    const pool = makePushPool({ task: null });
    expect(await requestCancel(pool, 'nope')).toBe(false);
  });
});

describe('pruneOldLlmPushTasks', () => {
  it('deletes only finished tasks older than the retention window', async () => {
    const pool = makePushPool({ pruneDeleted: 5 });
    const n = await pruneOldLlmPushTasks(pool, 30);
    expect(n).toBe(5);

    const del = pool.queries.find((q: FakeQuery) => q.sql.includes('DELETE FROM llm_push_tasks'));
    expect(del).toBeTruthy();
    expect(del!.sql).toContain("status IN ('succeeded','partial','failed','cancelled')");
    expect(del!.sql).toContain('finished_at < NOW()');
    expect(del!.params![0]).toBe(30);
  });
});

describe('listTasks / getTaskDetail', () => {
  it('maps rows to a public view', async () => {
    const pool = makePushPool({
      task: makeTaskRow({ status: 'succeeded', total_count: 5, succeeded_count: 5 }),
    });
    const r = await listTasks(pool, {});
    expect(r.total).toBe(1);
    expect(r.tasks[0].id).toBe('task-1');
    expect(r.tasks[0].status).toBe('succeeded');
    expect(r.tasks[0].totalCount).toBe(5);
    expect(r.tasks[0].createdAt).toBeTruthy();
  });

  it('returns task + per-tenant items', async () => {
    const pool = makePushPool({
      task: makeTaskRow(),
      items: [makeItemRow({ tenant_id: 't123', status: 'succeeded' })],
    });
    const d = await getTaskDetail(pool, 'task-1');
    expect(d).not.toBeNull();
    expect(d!.items).toHaveLength(1);
    expect(d!.items[0].tenantId).toBe('t123');
    expect(d!.items[0].restarted).toBe(true);
  });

  it('returns null for an unknown task', async () => {
    const pool = makePushPool({ task: null });
    expect(await getTaskDetail(pool, 'nope')).toBeNull();
  });
});
