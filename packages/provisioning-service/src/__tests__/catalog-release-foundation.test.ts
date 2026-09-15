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

import { enqueueLlmPush } from '../services/llm-push-task.js';

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

/**
 * Minimal fake that satisfies both pg.Pool and pg.PoolClient shapes.
 * The `.query()` method is identical on both — that is the whole point
 * of the signature change: a transaction-bound PoolClient can be passed
 * where a Pool was previously expected.
 */
function makeFakeClient() {
  const queries: FakeQuery[] = [];
  const client = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
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

describe('enqueueLlmPush — PoolClient support', () => {
  it('accepts a pg.PoolClient (transaction-bound client)', async () => {
    const client = makeFakeClient();
    const result = await enqueueLlmPush(client as any, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: null,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
    });
    expect(result.taskId).toBeTruthy();
    expect(result.status).toBe('pending');

    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();
    // The query was executed on the client — proving PoolClient works.
    expect(client.queries.length).toBeGreaterThanOrEqual(1);
  });

  it('still accepts a pg.Pool (backward compatibility)', async () => {
    const pool = makeFakeClient();
    const result = await enqueueLlmPush(pool as any, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: null,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
    });
    expect(result.taskId).toBeTruthy();
    expect(result.status).toBe('pending');

    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();
  });
});

describe('enqueueLlmPush — new release fields in INSERT', () => {
  it('includes release_id, scope_type, and idempotency_key columns in the INSERT', async () => {
    const client = makeFakeClient();
    await enqueueLlmPush(client as any, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: null,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
      releaseId: 'rel-123',
      scopeType: 'canary',
      idempotencyKey: 'idem-key-001',
    });

    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();

    // The SQL must reference all 11 columns
    expect(insert!.sql).toContain('release_id');
    expect(insert!.sql).toContain('scope_type');
    expect(insert!.sql).toContain('idempotency_key');
    expect(insert!.sql).toMatch(/\$9/);
    expect(insert!.sql).toMatch(/\$10/);
    expect(insert!.sql).toMatch(/\$11/);

    // The params array must have exactly 11 values
    expect(insert!.params).toHaveLength(11);

    // release_id is at position $9 (index 8)
    expect(insert!.params![8]).toBe('rel-123');
    // scope_type at $10 (index 9)
    expect(insert!.params![9]).toBe('canary');
    // idempotency_key at $11 (index 10)
    expect(insert!.params![10]).toBe('idem-key-001');
  });

  it('defaults release_id to null, scope_type to "full", and idempotency_key to null when omitted', async () => {
    const client = makeFakeClient();
    await enqueueLlmPush(client as any, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: null,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
    });

    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();
    expect(insert!.params).toHaveLength(11);

    // release_id defaults to null
    expect(insert!.params![8]).toBeNull();
    // scope_type defaults to 'full'
    expect(insert!.params![9]).toBe('full');
    // idempotency_key defaults to null
    expect(insert!.params![10]).toBeNull();
  });

  it('encrypts the prev/next library snapshots (enc: prefix, never plaintext)', async () => {
    const client = makeFakeClient();
    await enqueueLlmPush(client as any, {
      kind: 'global_push',
      scope: null,
      trigger: 'save',
      prevLibrary: goodLibrary,
      nextLibrary: goodLibrary,
      actor: 'admin',
      actorType: 'admin',
    });

    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO llm_push_tasks'));
    expect(insert).toBeTruthy();

    // prev_library at $5 (index 4), next_library at $6 (index 5)
    expect(String(insert!.params![4])).toMatch(/^enc:/);
    expect(String(insert!.params![5])).toMatch(/^enc:/);
    // Must NOT be plaintext JSON
    expect(String(insert!.params![4])).not.toBe(JSON.stringify(goodLibrary));
    expect(String(insert!.params![5])).not.toBe(JSON.stringify(goodLibrary));
  });
});
