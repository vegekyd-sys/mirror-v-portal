import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

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

import { createLlmPushRoutes } from '../routes/llm-push.js';
import { SseBroker } from '../services/sse-broker.js';

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    kind: 'global_push',
    scope: null,
    trigger: 'save',
    status: 'succeeded',
    prev_library: 'enc:{}',
    next_library: 'enc:{}',
    total_count: 5,
    succeeded_count: 4,
    failed_count: 1,
    skipped_count: 0,
    error: null,
    actor: 'admin',
    actor_type: 'admin',
    lease_owner: null,
    lease_expires_at: null,
    cancel_requested: false,
    created_at: new Date('2026-09-04T10:00:00Z'),
    started_at: new Date('2026-09-04T10:00:01Z'),
    finished_at: new Date('2026-09-04T10:00:02Z'),
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

function makePool(task: Record<string, unknown> | null, items: Record<string, unknown>[] = []) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM llm_push_tasks WHERE id = $1')) {
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('SELECT * FROM llm_push_task_items WHERE task_id')) {
        return { rows: items, rowCount: items.length };
      }
      if (sql.includes('SELECT * FROM llm_push_tasks')) {
        return { rows: task ? [task] : [], rowCount: task ? 1 : 0 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS n FROM llm_push_tasks')) {
        return { rows: [{ n: task ? 1 : 0 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE llm_push_task_items')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE llm_push_tasks')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

function makeApp(task: Record<string, unknown> | null, items?: Record<string, unknown>[]) {
  const app = express();
  app.use(express.json());
  app.use(createLlmPushRoutes(makePool(task, items), new SseBroker()));
  return app;
}

describe('GET /v1/admin/llm-push-tasks', () => {
  it('lists tasks', async () => {
    const app = makeApp(makeTaskRow());
    const res = await request(app).get('/v1/admin/llm-push-tasks');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tasks[0].id).toBe('task-1');
    expect(res.body.tasks[0].status).toBe('succeeded');
  });
});

describe('GET /v1/admin/llm-push-tasks/:taskId', () => {
  it('returns task + items', async () => {
    const app = makeApp(makeTaskRow(), [makeItemRow()]);
    const res = await request(app).get('/v1/admin/llm-push-tasks/task-1');
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe('task-1');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].tenantId).toBe('t123');
  });

  it('404s for an unknown task', async () => {
    const app = makeApp(null);
    const res = await request(app).get('/v1/admin/llm-push-tasks/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/admin/llm-push-tasks/:taskId/stream (SSE)', () => {
  it('emits snapshot + done and closes immediately for a terminal task', async () => {
    const app = makeApp(makeTaskRow({ status: 'succeeded' }), [makeItemRow()]);
    const res = await request(app).get('/v1/admin/llm-push-tasks/task-1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('retry: 3000');
    expect(res.text).toContain('event: snapshot');
    expect(res.text).toContain('event: done');
    expect(res.text).toContain('"taskId":"task-1"');
    expect(res.text).toContain('"status":"succeeded"');
  });

  it('404s for an unknown task', async () => {
    const app = makeApp(null);
    const res = await request(app).get('/v1/admin/llm-push-tasks/nope/stream');
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/admin/llm-push-tasks/:taskId/retry', () => {
  it('resets failed items', async () => {
    const app = makeApp(makeTaskRow(), [makeItemRow({ status: 'failed' })]);
    const res = await request(app).post('/v1/admin/llm-push-tasks/task-1/retry').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resetCount).toBe(1);
  });
});

describe('POST /v1/admin/llm-push-tasks/:taskId/cancel', () => {
  it('requests cancel', async () => {
    const app = makeApp(makeTaskRow({ status: 'running' }));
    const res = await request(app).post('/v1/admin/llm-push-tasks/task-1/cancel').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('404s for an unknown task', async () => {
    const app = makeApp(null);
    const res = await request(app).post('/v1/admin/llm-push-tasks/nope/cancel').send({});
    expect(res.status).toBe(404);
  });
});
