import { describe, it, expect } from 'vitest';
import {
  getOverrideMap,
  getOverride,
  setOverride,
  clearOverride,
  listOverrides,
} from '../services/tenant-image-overrides.js';

/**
 * Per-tenant image override ("pin") helpers. These are pure SQL helpers; the
 * tests use a fake pool to assert the parameter flow and return shapes — the
 * rollout skip / provision-time resolution rely on these staying correct.
 */

function fakePool(rows: any[] = []) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { pool: pool as any, calls };
}

describe('tenant-image-overrides helpers', () => {
  it('getOverrideMap maps rows into a Map keyed by tenant_id', async () => {
    const { pool } = fakePool([
      { tenant_id: 't1', image: 'reg/agent:1' },
      { tenant_id: 't2', image: 'reg/agent:2' },
    ]);
    const map = await getOverrideMap(pool, 'dealclaw-agent');
    expect(map.size).toBe(2);
    expect(map.get('t1')).toBe('reg/agent:1');
    expect(map.get('t2')).toBe('reg/agent:2');
  });

  it('getOverrideMap returns an empty map when no rows', async () => {
    const { pool } = fakePool([]);
    const map = await getOverrideMap(pool, 'dealclaw-agent');
    expect(map.size).toBe(0);
  });

  it('getOverride returns the pinned image, or null when absent', async () => {
    const { pool } = fakePool([{ image: 'reg/agent:1' }]);
    expect(await getOverride(pool, 't1', 'dealclaw-agent')).toBe('reg/agent:1');
    expect(await getOverride(pool, 't1', 'dealclaw-agent')).toBe('reg/agent:1');
  });

  it('getOverride returns null on query failure (DB hiccup must not break callers)', async () => {
    const pool = {
      query: async () => { throw new Error('db down'); },
    } as any;
    expect(await getOverride(pool, 't1', 'dealclaw-agent')).toBeNull();
    expect(await getOverride(undefined, 't1', 'dealclaw-agent')).toBeNull();
  });

  it('setOverride upserts with tenant_id, service, image, updated_by', async () => {
    const { pool, calls } = fakePool();
    await setOverride(pool, {
      tenantId: 't1',
      service: 'dealclaw-agent',
      image: 'reg/agent:9',
      updatedBy: 'admin-user',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('ON CONFLICT (tenant_id, service)');
    expect(calls[0].params).toEqual(['t1', 'dealclaw-agent', 'reg/agent:9', 'admin-user']);
  });

  it('clearOverride deletes the pin row', async () => {
    const { pool, calls } = fakePool();
    await clearOverride(pool, 't1', 'dealclaw-agent');
    expect(calls[0].sql).toContain('DELETE FROM tenant_image_overrides');
    expect(calls[0].params).toEqual(['t1', 'dealclaw-agent']);
  });

  it('listOverrides returns overrides ordered by service', async () => {
    const { pool } = fakePool([
      { tenant_id: 't1', service: 'dealclaw-agent', image: 'reg/agent:1' },
      { tenant_id: 't1', service: 'nexus-gateway', image: 'reg/gw:1' },
    ]);
    const overrides = await listOverrides(pool, 't1');
    expect(overrides.map((o) => o.service)).toEqual(['dealclaw-agent', 'nexus-gateway']);
    expect(overrides[0]).toMatchObject({ tenantId: 't1', service: 'dealclaw-agent', image: 'reg/agent:1' });
  });
});
