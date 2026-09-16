import { describe, it, expect, vi } from 'vitest';

// Mock crypto with the same enc: prefix passthrough as catalog-release-foundation.test.ts
const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
  isEncrypted: (v: string) => v.startsWith('enc:'),
  maskValue: (v: string) => '••••••••',
}));
vi.mock('../services/crypto.js', () => cryptoMocks);

// Mock k8s-client (required by llm-providers which is imported transitively)
const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

import { CatalogReleaseService } from '../services/catalog-release-service.js';

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

interface FakeClient {
  queries: FakeQuery[];
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  release: () => void;
}

/**
 * Minimal fake that satisfies both pg.Pool and pg.PoolClient shapes.
 * The `.query()` method records all calls so tests can assert which SQL
 * ran on the transaction client vs. the pool.
 */
function makeFakeClient(): FakeClient {
  const queries: FakeQuery[] = [];
  return {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
}

/**
 * Fake pool that returns a specific client from .connect() and tracks
 * whether queries go through the pool (non-transactional) or the client
 * (transactional).
 */
function makeFakePool(client: FakeClient) {
  return {
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => {
      // Pool-level queries (outside transactions) are tracked separately.
      return { rows: [], rowCount: 0 };
    },
  };
}

const goodLibrary = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk',
      models: [{ id: 'qwen-max' }],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
};

describe('CatalogReleaseService — atomicPublish', () => {
  it('creates a release, updates pointer, upserts config, and enqueues push task all in one transaction', async () => {
    const client = makeFakeClient();
    // Simulate: runtime_configs row exists, pointer exists with a release_id,
    // and the parent release exists.
    let callIdx = 0;
    const queryImpl = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      callIdx++;
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return {
          rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }],
          rowCount: 1,
        };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: 'parent-release-id' }], rowCount: 1 };
      }
      if (sql.includes('FROM llm_catalog_releases WHERE id = $1')) {
        return {
          rows: [{ version: '3', fingerprint: 'parent-fp' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    client.query = queryImpl;

    const pool = makeFakePool(client);
    const service = new CatalogReleaseService(pool as any);

    const result = await service.atomicPublish({
      expectedParentFingerprint: 'parent-fp',
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: { addedProviders: [] },
      warnings: [],
      actor: 'admin-user',
      actorType: 'admin',
    });

    expect(result).not.toBeNull();
    expect(result!.release.version).toBe(4);
    expect(result!.release.status).toBe('active');
    expect(result!.release.parentId).toBe('parent-release-id');
    expect(result!.release.parentFingerprint).toBe('parent-fp');
    expect(result!.taskId).toBeTruthy();

    // Verify transaction control.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');

    // Verify Release INSERT.
    const releaseInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_catalog_releases'));
    expect(releaseInsert).toBeTruthy();
    expect(releaseInsert!.params![1]).toBe(4); // version

    // Verify old release marked superseded.
    const supersedeUpdate = client.queries.find(
      (q) => q.sql.includes('UPDATE llm_catalog_releases SET status') && q.sql.includes('superseded'),
    );
    expect(supersedeUpdate).toBeTruthy();
    expect(supersedeUpdate!.params![0]).toBe('parent-release-id');

    // Verify pointer updated.
    const pointerUpdate = client.queries.find(
      (q) => q.sql.includes('UPDATE llm_catalog_release_pointer SET release_id'),
    );
    expect(pointerUpdate).toBeTruthy();

    // Verify backup INSERT uses old value fingerprint (not new snapshot fingerprint).
    const backupInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_catalog_snapshot_backups'));
    expect(backupInsert).toBeTruthy();
    const backupFingerprint = backupInsert!.params![2]; // source_fingerprint is $3 (index 2)
    // The old fingerprint should NOT be 'new-fp' (the new snapshot's fingerprint).
    expect(backupFingerprint).not.toBe('new-fp');

    // Verify push task enqueued ON THE CLIENT (not the pool).
    const pushInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![8]).toBe(result!.release.id); // release_id at $9 (index 8)
    expect(pushInsert!.params![9]).toBe('full'); // scope_type at $10 (index 9)
  });

  it('publishes atomically without creating a push task for no-rollout', async () => {
    const client = makeFakeClient();
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return { rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }], rowCount: 1 };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const service = new CatalogReleaseService(makeFakePool(client) as any);
    const result = await service.atomicPublish({
      expectedParentFingerprint: null,
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: {},
      warnings: [],
      actor: 'admin',
      actorType: 'admin',
      idempotencyKey: 'publish-no-rollout',
      rollout: { mode: 'no-rollout' },
    });
    expect(result?.taskId).toBeNull();
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO llm_catalog_releases'))).toBe(true);
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO llm_push_tasks'))).toBe(false);
    expect(client.queries.map((query) => query.sql)).toContain('COMMIT');
  });

  it('returns null on CAS failure (expectedParentFingerprint does not match)', async () => {
    const client = makeFakeClient();
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return {
          rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }],
          rowCount: 1,
        };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: 'parent-release-id' }], rowCount: 1 };
      }
      if (sql.includes('FROM llm_catalog_releases WHERE id = $1')) {
        return { rows: [{ version: '1', fingerprint: 'actual-parent-fp' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const pool = makeFakePool(client);
    const service = new CatalogReleaseService(pool as any);

    // Caller expects parent fingerprint 'stale-fp' but actual is 'actual-parent-fp'.
    const result = await service.atomicPublish({
      expectedParentFingerprint: 'stale-fp',
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: {},
      warnings: [],
      actor: 'admin',
      actorType: 'admin',
    });

    expect(result).toBeNull();

    // Verify ROLLBACK was called (no partial state).
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');

    // No release INSERT should have happened.
    const releaseInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_catalog_releases'));
    expect(releaseInsert).toBeUndefined();
  });

  it('handles first publish (no current release, expectedParentFingerprint null)', async () => {
    const client = makeFakeClient();
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return { rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }], rowCount: 1 };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const pool = makeFakePool(client);
    const service = new CatalogReleaseService(pool as any);

    const result = await service.atomicPublish({
      expectedParentFingerprint: null,
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: {},
      warnings: [],
      actor: 'admin',
      actorType: 'admin',
    });

    expect(result).not.toBeNull();
    expect(result!.release.version).toBe(1);
    expect(result!.release.parentId).toBeNull();
    expect(result!.release.parentFingerprint).toBeNull();
  });

  it('returns existing release on idempotency key conflict', async () => {
    // First call: pool-level query finds the existing release.
    // Simulate the findReleaseByIdempotencyKey returning a release.
    const pool = {
      connect: async () => {
        throw new Error('should not connect for idempotent replay');
      },
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('idempotency_key = $1')) {
          return {
            rows: [{
              id: 'existing-release',
              version: '2',
              parent_id: 'parent-id',
              canonical_snapshot: 'enc:snap',
              compat_payload: 'enc:compat',
              fingerprint: 'existing-fp',
              parent_fingerprint: 'parent-fp',
              diff_summary: {},
              warnings: [],
              actor: 'admin',
              actor_type: 'admin',
              status: 'active',
              idempotency_key: 'idem-1',
              created_at: new Date('2025-01-01'),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM llm_push_tasks WHERE release_id')) {
          return { rows: [{ id: 'existing-task-id' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const service = new CatalogReleaseService(pool as any);

    const result = await service.atomicPublish({
      expectedParentFingerprint: 'parent-fp',
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: {},
      warnings: [],
      actor: 'admin',
      actorType: 'admin',
      idempotencyKey: 'idem-1',
    });

    expect(result).not.toBeNull();
    expect(result!.release.id).toBe('existing-release');
    expect(result!.taskId).toBe('existing-task-id');
  });
});

describe('CatalogReleaseService — atomicRestore', () => {
  it('creates a new release from a backup snapshot with push task on the transaction client', async () => {
    const client = makeFakeClient();
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return {
          rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }],
          rowCount: 1,
        };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: 'current-release-id' }], rowCount: 1 };
      }
      if (sql.includes('FROM llm_catalog_releases WHERE id = $1')) {
        return { rows: [{ version: '5', fingerprint: 'current-fp' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    // Pool-level query for the backup read.
    const pool = {
      connect: async () => client,
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM llm_catalog_snapshot_backups WHERE id = $1')) {
          return {
            rows: [{
              encrypted_value: `enc:${JSON.stringify(goodLibrary)}`,
              source_fingerprint: 'old-backup-fp',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const service = new CatalogReleaseService(pool as any);

    const result = await service.atomicRestore({
      backupId: 'backup-1',
      actor: 'admin',
      actorType: 'admin',
    });

    expect(result).not.toBeNull();
    expect(result!.release.version).toBe(6);
    expect(result!.release.status).toBe('rolled-back');
    expect(result!.release.parentId).toBe('current-release-id');
    expect(result!.taskId).toBeTruthy();

    // Verify transaction control.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');

    // Verify push task on transaction client.
    const pushInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(pushInsert).toBeTruthy();
    expect(pushInsert!.params![3]).toBe('retry'); // trigger at $4 (index 3)
  });

  it('restores atomically without creating a push task for no-rollout', async () => {
    const client = makeFakeClient();
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return { rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }], rowCount: 1 };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => sql.includes('FROM llm_catalog_snapshot_backups WHERE id = $1')
        ? { rows: [{ encrypted_value: `enc:${JSON.stringify(goodLibrary)}`, source_fingerprint: 'old' }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    };
    const result = await new CatalogReleaseService(pool as any).atomicRestore({
      backupId: 'backup-1', actor: 'admin', actorType: 'admin',
      idempotencyKey: 'restore-no-rollout', rollout: { mode: 'no-rollout' },
    });
    expect(result?.taskId).toBeNull();
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO llm_push_tasks'))).toBe(false);
    expect(client.queries.map((query) => query.sql)).toContain('COMMIT');
  });

  it('returns null when backup is not found', async () => {
    const pool = {
      connect: async () => { throw new Error('should not connect'); },
      query: async (sql: string, params?: unknown[]) => {
        return { rows: [], rowCount: 0 };
      },
    };

    const service = new CatalogReleaseService(pool as any);
    const result = await service.atomicRestore({
      backupId: 'nonexistent',
      actor: 'admin',
      actorType: 'admin',
    });

    expect(result).toBeNull();
  });
});

describe('CatalogReleaseService — atomicity verification', () => {
  it('enqueueLlmPush is called on the PoolClient (transaction client), not the pool', async () => {
    const client = makeFakeClient();
    const poolQueries: FakeQuery[] = [];
    client.query = async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes('FOR UPDATE') && sql.includes('runtime_configs')) {
        return { rows: [{ id: 'rc-1', encrypted_value: `enc:${JSON.stringify(goodLibrary)}` }], rowCount: 1 };
      }
      if (sql.includes('llm_catalog_release_pointer') && sql.includes('FOR UPDATE')) {
        return { rows: [{ release_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const pool = {
      connect: async () => client,
      query: async (sql: string, params?: unknown[]) => {
        poolQueries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };

    const service = new CatalogReleaseService(pool as any);
    const result = await service.atomicPublish({
      expectedParentFingerprint: null,
      snapshot: goodLibrary,
      fingerprint: 'new-fp',
      diffSummary: {},
      warnings: [],
      actor: 'admin',
      actorType: 'admin',
    });

    expect(result).not.toBeNull();

    // The push task INSERT must be on the client (transactional), not the pool.
    const clientPushInsert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    const poolPushInsert = poolQueries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(clientPushInsert).toBeTruthy();
    expect(poolPushInsert).toBeUndefined();
  });
});
