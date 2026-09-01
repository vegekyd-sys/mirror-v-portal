import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import {
  redactSensitive,
  deriveAction,
  actorFromRequest,
  createAuditMiddleware,
  writeAuditLog,
  pruneAuditLogs,
} from '../services/audit.js';

function fakePool(impl?: (sql: string, params?: unknown[]) => Promise<any>) {
  return {
    query: vi.fn(impl ?? (async () => ({ rowCount: 1 }))),
  } as unknown as pg.Pool;
}

/** Drive the audit middleware against a fake req/res; returns the captured INSERT row. */
function runMiddleware(
  mw: ReturnType<typeof createAuditMiddleware>,
  opts: { method?: string; path?: string; body?: unknown; adminUser?: unknown; finishStatus?: number } = {},
) {
  const { method = 'POST', path = '/v1/tenants', body = {}, adminUser = { username: 'maqing' }, finishStatus = 200 } = opts;
  const req = {
    method,
    path,
    body,
    headers: { 'x-request-id': 'req-1' },
    ip: '10.0.0.1',
    adminUser,
  } as unknown as Request;
  const listeners: Record<string, () => void> = {};
  const res = {
    statusCode: finishStatus,
    on: (ev: string, fn: () => void) => {
      listeners[ev] = fn;
    },
  } as unknown as Response;
  const next: NextFunction = vi.fn() as unknown as NextFunction;
  mw(req, res, next);
  return { next, fire: () => listeners.finish?.() };
}

describe('redactSensitive', () => {
  it('masks values under sensitive key names (case/format variants)', () => {
    const out = redactSensitive({
      apiKey: 'sk-live',
      api_key: 'sk-live',
      password: 'hunter2',
      OPENCLAW_GATEWAY_TOKEN: 'hex',
      Authorization: 'Bearer x',
      name: 'tenant-a',
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('***');
    expect(out.api_key).toBe('***');
    expect(out.password).toBe('***');
    expect(out.OPENCLAW_GATEWAY_TOKEN).toBe('***');
    expect(out.Authorization).toBe('***');
    expect(out.name).toBe('tenant-a');
  });

  it('redacts recursively through nested objects and arrays', () => {
    const out = redactSensitive({
      providers: [{ apiKey: 'sk-1', model: 'deepseek-chat' }],
      meta: { nested: { secret: 'x', ok: 1 } },
    }) as any;
    expect(out.providers[0].apiKey).toBe('***');
    expect(out.providers[0].model).toBe('deepseek-chat');
    expect(out.meta.nested.secret).toBe('***');
    expect(out.meta.nested.ok).toBe(1);
  });

  it('truncates overly deep structures and long strings', () => {
    const deep: any = {};
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      cur.child = {};
      cur = cur.child;
    }
    const out = redactSensitive({ deep }) as any;
    expect(JSON.stringify(out)).toContain('[truncated]');
    expect(redactSensitive('x'.repeat(3000))).toBe('x'.repeat(2000) + '…');
  });

  it('preserves null/undefined and passes primitives through', () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
    expect(redactSensitive(42)).toBe(42);
  });
});

describe('deriveAction', () => {
  it.each([
    ['POST', '/v1/tenants', 'tenant.create'],
    ['DELETE', '/v1/tenants', 'tenant.delete'],
    ['PATCH', '/v1/tenants/:id/status', 'tenant.status.update'],
    ['DELETE', '/v1/tenants/:id', 'tenant.delete'],
    ['PUT', '/v1/tenants/:id/credentials', 'tenant.credentials.update'],
    ['POST', '/v1/admin/image-releases/promote', 'image-release.promote'],
    ['POST', '/v1/admin/image-releases/sync', 'image-release.sync'],
    ['PUT', '/v1/admin/llm-providers/:id', 'llm-provider.update'],
    ['DELETE', '/v1/admin/llm-providers/:id', 'llm-provider.delete'],
    ['PUT', '/v1/admin/runtime-configs/:key', 'runtime-config.update'],
    ['DELETE', '/v1/admin/external-api-keys/:id', 'external-api-key.delete'],
    ['POST', '/v1/tenants/batch/creds-push', 'tenant.batch-creds-push'],
  ])('%s %s → %s', (method, path, expected) => {
    expect(deriveAction(method, path)).toBe(expected);
  });
});

describe('actorFromRequest', () => {
  it('prefers adminUser.username', () => {
    const r = actorFromRequest({ adminUser: { username: 'wangqiang', sub: 'adm_1' } } as any);
    expect(r).toEqual({ actor: 'wangqiang', actorType: 'admin' });
  });
  it('falls back to sub, then service-token', () => {
    expect(actorFromRequest({ adminUser: { sub: 'adm_9' } } as any)).toEqual({ actor: 'adm_9', actorType: 'admin' });
    expect(actorFromRequest({} as any)).toEqual({ actor: 'service-token', actorType: 'service' });
  });
});

describe('createAuditMiddleware', () => {
  it('skips GET/HEAD/OPTIONS entirely', () => {
    const pool = fakePool();
    const mw = createAuditMiddleware(pool);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const r = runMiddleware(mw, { method });
      expect(r.next).toHaveBeenCalled();
      r.fire();
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('skips the chat-messages ingest endpoint (high volume)', () => {
    const pool = fakePool();
    const r = runMiddleware(createAuditMiddleware(pool), {
      method: 'POST',
      path: '/v1/tenants/abc123/chat-messages',
    });
    r.fire();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('records a POST with actor, derived action, tenant id and redacted body', async () => {
    const pool = fakePool();
    const r = runMiddleware(createAuditMiddleware(pool), {
      method: 'PATCH',
      path: '/v1/tenants/abc123/status',
      body: { status: 'disabled', note: 'x' },
    });
    r.fire();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalled());
    const [sql, params] = (pool.query as any).mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    // params: [actor, actorType, action, method, path, resourceType, resourceId,
    //          tenantId, oldValue, newValue, statusCode, durationMs, ip, requestId]
    const [actor, actorType, action, method, path, , , tenantId, , newValue, statusCode] = params;
    expect(actor).toBe('maqing');
    expect(actorType).toBe('admin');
    expect(action).toBe('tenant.status.update');
    expect(method).toBe('PATCH');
    expect(path).toBe('/v1/tenants/abc123/status');
    expect(tenantId).toBe('abc123');
    expect(JSON.parse(newValue)).toEqual({ status: 'disabled', note: 'x' });
    expect(statusCode).toBe(200);
  });

  it('masks isSecret runtime-config values and never mutates req.body', async () => {
    const pool = fakePool();
    const body = { key: 'DEEPSEEK_API_KEY', value: 'sk-plaintext', isSecret: true };
    const r = runMiddleware(createAuditMiddleware(pool), {
      method: 'PUT',
      path: '/v1/admin/runtime-configs',
      body,
    });
    r.fire();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalled());
    const params = (pool.query as any).mock.calls[0][1];
    const recorded = JSON.parse(params[9]);
    expect(recorded.value).toBe('***');
    // original body untouched
    expect(body.value).toBe('sk-plaintext');
  });

  it('masks sensitive keys in generic bodies (apiKey → ***)', async () => {
    const pool = fakePool();
    const r = runMiddleware(createAuditMiddleware(pool), {
      method: 'POST',
      path: '/v1/admin/llm-providers',
      body: { provider: 'deepseek', apiKey: 'sk-live' },
    });
    r.fire();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalled());
    const params = (pool.query as any).mock.calls[0][1];
    const recorded = JSON.parse(params[9]);
    expect(recorded.apiKey).toBe('***');
    expect(recorded.provider).toBe('deepseek');
  });
});

describe('writeAuditLog', () => {
  it('redacts old/new values before insert', async () => {
    const pool = fakePool();
    await writeAuditLog(pool, {
      actor: 'maqing',
      actorType: 'admin',
      action: 'image-release.promote',
      oldValue: { tag: 'master.6856a323.118' },
      newValue: { tag: 'master.e3d43339.7', apiKey: 'sk' },
    });
    const params = (pool.query as any).mock.calls[0][1];
    expect(JSON.parse(params[8])).toEqual({ tag: 'master.6856a323.118' });
    expect(JSON.parse(params[9]).apiKey).toBe('***');
  });

  it('never throws when the INSERT fails (fire-and-forget)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = fakePool(async () => {
      throw new Error('db down');
    });
    await expect(
      writeAuditLog(pool, { actor: 'x', actorType: 'service', action: 'a' }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('pruneAuditLogs', () => {
  it('deletes rows older than the retention window and returns rowCount', async () => {
    const pool = fakePool(async () => ({ rowCount: 42 }));
    const n = await pruneAuditLogs(pool, 180);
    expect(n).toBe(42);
    const [sql, params] = (pool.query as any).mock.calls[0];
    expect(sql).toContain('DELETE FROM audit_logs');
    expect(params).toEqual(['180']);
  });

  it('returns 0 on failure without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = fakePool(async () => {
      throw new Error('db down');
    });
    await expect(pruneAuditLogs(pool)).resolves.toBe(0);
    errSpy.mockRestore();
  });
});
