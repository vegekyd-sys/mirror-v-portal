import { describe, it, expect } from 'vitest';
import { backfillSenderNames } from '../services/sender-name-backfill.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 按 url 分发：token 接口 / batch_get 接口。 */
function fakeFetch(opts: {
  token?: any;
  batch?: (body: any) => any;
  tokenError?: any;
  batchError?: any;
} = {}) {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes('tenant_access_token')) {
      if (opts.tokenError) {
        return new Response(JSON.stringify(opts.tokenError), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(
        JSON.stringify(opts.token ?? { code: 0, msg: 'ok', tenant_access_token: 't-abc' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('batch_get')) {
      if (opts.batchError) {
        return new Response(JSON.stringify(opts.batchError), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify(opts.batch ? opts.batch(body) : { code: 0, data: { items: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ code: 99999, msg: 'unexpected url' }), { status: 200 });
  }) as FetchLike;
}

/** pg.Pool stand-in：按 SQL 模式返回 canned rows。 */
function makeFakePool(opts: {
  needs?: Array<{ tenant_id: string; sender_open_id: string }>;
  tenants?: Array<{ tenant_id: string; app_id: string; app_secret: string }>;
}) {
  const updates: Array<{ params: any[] }> = [];
  const pool = {
    updates,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM chat_messages')) {
        return { rows: opts.needs ?? [], rowCount: (opts.needs ?? []).length };
      }
      if (sql.includes('FROM tenants')) {
        return { rows: opts.tenants ?? [], rowCount: (opts.tenants ?? []).length };
      }
      if (sql.includes('UPDATE chat_messages SET sender_name')) {
        updates.push({ params: params ?? [] });
        return { rows: [], rowCount: 2 }; // 每 open_id 回填 2 行
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

describe('backfillSenderNames', () => {
  it('解析姓名并回填有凭据的租户', async () => {
    const pool = makeFakePool({
      needs: [
        { tenant_id: 't1', sender_open_id: 'ou_1' },
        { tenant_id: 't1', sender_open_id: 'ou_2' },
      ],
      tenants: [{ tenant_id: 't1', app_id: 'cli_a', app_secret: 's' }],
    });
    const fetchImpl = fakeFetch({
      batch: () => ({ code: 0, data: { items: [{ open_id: 'ou_1', name: '张三' }, { open_id: 'ou_2', name: '李四' }] } }),
    });

    const r = await backfillSenderNames(pool, { fetchImpl });

    expect(r.summary).toMatchObject({ total: 1, resolved: 2, unresolved: 0, updated: 4, failed: 0, skipped: 0 });
    expect(r.tenants[0]).toMatchObject({ tenantId: 't1', resolved: 2, unresolved: 0, updated: 4 });
    // 两次 UPDATE：ou_1 → 张三、ou_2 → 李四
    expect(pool.updates.map((u: any) => u.params[0])).toEqual(['张三', '李四']);
    expect(pool.updates.map((u: any) => u.params[2])).toEqual(['ou_1', 'ou_2']);
  });

  it('无凭据的租户跳过', async () => {
    const pool = makeFakePool({
      needs: [{ tenant_id: 't1', sender_open_id: 'ou_1' }],
      tenants: [], // 无凭据
    });
    const r = await backfillSenderNames(pool, { fetchImpl: fakeFetch() });
    expect(r.summary.skipped).toBe(1);
    expect(r.tenants[0]).toMatchObject({ tenantId: 't1', skipped: true, resolved: 0 });
    expect(pool.updates).toHaveLength(0);
  });

  it('未解析的 open_id 计入 unresolved，不报错', async () => {
    const pool = makeFakePool({
      needs: [
        { tenant_id: 't1', sender_open_id: 'ou_1' },
        { tenant_id: 't1', sender_open_id: 'ou_gone' },
      ],
      tenants: [{ tenant_id: 't1', app_id: 'cli_a', app_secret: 's' }],
    });
    const fetchImpl = fakeFetch({
      batch: () => ({ code: 0, data: { items: [{ open_id: 'ou_1', name: '张三' }] } }), // ou_gone 不存在
    });
    const r = await backfillSenderNames(pool, { fetchImpl });
    expect(r.summary).toMatchObject({ resolved: 1, unresolved: 1, updated: 2, failed: 0 });
  });

  it('token 获取失败时记录 error，不计入崩溃', async () => {
    const pool = makeFakePool({
      needs: [{ tenant_id: 't1', sender_open_id: 'ou_1' }],
      tenants: [{ tenant_id: 't1', app_id: 'cli_a', app_secret: 'bad' }],
    });
    const r = await backfillSenderNames(pool, {
      fetchImpl: fakeFetch({ tokenError: { code: 10003, msg: 'app secret is wrong' } }),
    });
    expect(r.summary.failed).toBe(1);
    expect(r.tenants[0].error).toContain('tenant_access_token');
    expect(pool.updates).toHaveLength(0);
  });

  it('批量解析分批（>BATCH_SIZE）也全量覆盖', async () => {
    // 构造 101 个 open_id，验证分成两批调用 batch_get。
    const openIds = Array.from({ length: 101 }, (_, i) => `ou_${i}`);
    const pool = makeFakePool({
      needs: openIds.map((id) => ({ tenant_id: 't1', sender_open_id: id })),
      tenants: [{ tenant_id: 't1', app_id: 'cli_a', app_secret: 's' }],
    });
    let batchCalls = 0;
    const fetchImpl = fakeFetch({
      batch: (body: any) => {
        batchCalls += 1;
        return { code: 0, data: { items: body.user_ids.map((id: string) => ({ open_id: id, name: `用户${id}` })) } };
      },
    });
    const r = await backfillSenderNames(pool, { fetchImpl });
    expect(batchCalls).toBe(2);
    expect(r.summary.resolved).toBe(101);
    expect(r.summary.updated).toBe(202);
  });
});
