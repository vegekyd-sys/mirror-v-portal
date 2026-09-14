import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminOpsRoutes } from '../routes/admin-ops.js';
import type { ProvisioningConfig } from '../config.js';

// 假凭据占位符 —— 真实 MIO_BLADE_AUTH 只走 env，绝不写进测试。
const TEST_TOKEN = 'unit-test-blade-token-placeholder';

function baseConfig(overrides: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
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
    mioApiBaseUrl: 'https://mio.example.test',
    mioBladeAuth: TEST_TOKEN,
    ...overrides,
  };
}

interface FakeQuery { sql: string; params?: unknown[] }

function makePool(opts: {
  candidates?: { tenant_id: string; company_name: string | null }[];
  tenantRow?: Record<string, unknown> | null;
  conflicts?: { tenant_id: string; company_name: string | null }[];
} = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('btrim(company_name)')) {
        return { rows: opts.candidates ?? [], rowCount: (opts.candidates ?? []).length };
      }
      if (sql.includes('WHERE mio_cdp_supplier_id = $1')) {
        return { rows: opts.conflicts ?? [], rowCount: (opts.conflicts ?? []).length };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: opts.tenantRow ? [opts.tenantRow] : [], rowCount: opts.tenantRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

function makeApp(pool: any, config: ProvisioningConfig) {
  const app = express();
  app.use(express.json());
  app.use(createAdminOpsRoutes(pool, config));
  return app;
}

const MIO_TENANT_ROW = {
  tenant_id: 't1',
  company_name: 'Acme Ltd',
  status: 'active',
  k8s_namespace: 'dealclaw-t1',
  agent_endpoint: null,
  plan_tier: 'starter',
  quota_credits_monthly: '1000000',
  credits_account_id: 'acct_t1',
  mio_cdp_supplier_id: null,
};

function mockSearch(records: { id: string; code?: string | null; name: string | null }[], total?: number) {
  const fn = vi.fn(async () =>
    new Response(
      JSON.stringify({ code: 200, success: true, data: { records, total: total ?? records.length } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockUpstream(payload: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GET /v1/admin/mio-suppliers', () => {
  it('只回 {ok, items:[{id, code, name}], total}', async () => {
    mockSearch([{ id: '123456789012', code: 'C-1', name: 'Acme Ltd' }], 3);
    const res = await request(makeApp(makePool(), baseConfig()))
      .get('/v1/admin/mio-suppliers?search=Acme&page=0');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      items: [{ id: '123456789012', code: 'C-1', name: 'Acme Ltd' }],
      total: 3,
    });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['code', 'id', 'name']);
  });

  it('缺少 search 参数 → 400（不发上游请求）', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await request(makeApp(makePool(), baseConfig())).get('/v1/admin/mio-suppliers');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('上游业务失败 → 502 且原样带出上游 msg', async () => {
    mockUpstream({ code: 401, success: false, msg: 'Blade-Auth 无效' });
    const res = await request(makeApp(makePool(), baseConfig())).get('/v1/admin/mio-suppliers?search=Acme');

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'MIO_BUSINESS_ERROR', message: 'Blade-Auth 无效' });
  });

  it('未配置 MIO_BLADE_AUTH → 503，明确提示（不静默降级）', async () => {
    const res = await request(makeApp(makePool(), baseConfig({ mioBladeAuth: '' })))
      .get('/v1/admin/mio-suppliers?search=Acme');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'MIO_AUTH_NOT_CONFIGURED' });
    expect(String(res.body.message)).toContain('MIO_BLADE_AUTH');
    // 绝不回显凭据本身。
    expect(JSON.stringify(res.body)).not.toContain(TEST_TOKEN);
  });
});

describe('POST /v1/admin/mio-suppliers', () => {
  it('成功 → {ok, supplierId, name}，且不回显 password', async () => {
    const fetchFn = mockUpstream({
      code: 200,
      success: true,
      data: {
        supplierId: 123456789012,
        companyName: 'Acme Ltd',
        mobile: '13800000000',
        intDialingCode: '+86',
        password: 'PLAINTEXT-SHOULD-NEVER-BE-RETURNED',
      },
    });
    const res = await request(makeApp(makePool(), baseConfig()))
      .post('/v1/admin/mio-suppliers')
      .send({ companyName: 'Acme Ltd', mobile: '13800000000' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, supplierId: '123456789012', name: 'Acme Ltd' });
    expect(JSON.stringify(res.body)).not.toContain('PLAINTEXT-SHOULD-NEVER-BE-RETURNED');

    const body = JSON.parse(String((fetchFn.mock.calls[0] as any)[1].body));
    expect(body).toEqual({ companyName: 'Acme Ltd', mobile: '13800000000', intDialingCode: '+86' });
  });

  it('同名重复 → 409 + 米奥原始 msg', async () => {
    mockUpstream({ code: 500, success: false, msg: '该公司名称已存在' });
    const res = await request(makeApp(makePool(), baseConfig()))
      .post('/v1/admin/mio-suppliers')
      .send({ companyName: 'Acme Ltd', mobile: '13800000000' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MIO_BUSINESS_ERROR', message: '该公司名称已存在' });
  });

  it('缺手机号 → 400（不发上游请求）', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const res = await request(makeApp(makePool(), baseConfig()))
      .post('/v1/admin/mio-suppliers')
      .send({ companyName: 'Acme Ltd' });

    expect(res.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('POST /v1/admin/tenants/:tenantId/mio-supplier', () => {
  it('绑定成功 → 复用服务函数并写库', async () => {
    const pool = makePool({ tenantRow: MIO_TENANT_ROW });
    const res = await request(makeApp(pool, baseConfig()))
      .post('/v1/admin/tenants/t1/mio-supplier')
      .send({ supplierId: '123456789012' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tenantId: 't1', supplierId: '123456789012' });
    const update = pool.queries.find((q: FakeQuery) => q.sql.includes('UPDATE tenants SET mio_cdp_supplier_id'));
    expect(update?.params).toEqual(['123456789012', 't1']);
  });

  it('唯一冲突 → 409 + 可读中文（含冲突客户名）', async () => {
    const pool = makePool({
      tenantRow: MIO_TENANT_ROW,
      conflicts: [{ tenant_id: 'other', company_name: 'Other Co' }],
    });
    const res = await request(makeApp(pool, baseConfig()))
      .post('/v1/admin/tenants/t1/mio-supplier')
      .send({ supplierId: '123456789012' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUPPLIER_ID_TAKEN');
    expect(String(res.body.message)).toContain('Other Co');
    expect(String(res.body.message)).toContain('一个供应商 ID 只能对应一个客户');
  });

  it('supplierId 类型错误 → 400', async () => {
    const res = await request(makeApp(makePool(), baseConfig()))
      .post('/v1/admin/tenants/t1/mio-supplier')
      .send({ supplierId: 123 });

    expect(res.status).toBe(400);
  });
});

describe('POST /v1/admin/mio-suppliers/backfill', () => {
  it('默认 dryRun=true，只报告不写库', async () => {
    mockSearch([{ id: '111111111111', code: 'C-1', name: 'Acme Ltd' }]);
    const pool = makePool({ candidates: [{ tenant_id: 't1', company_name: 'Acme Ltd' }] });

    const res = await request(makeApp(pool, baseConfig())).post('/v1/admin/mio-suppliers/backfill').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dryRun: true, scanned: 1, matched: 1, updated: 0 });
    expect(res.body.entries[0]).toMatchObject({ tenantId: 't1', action: 'would_bind' });
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('UPDATE tenants SET mio_cdp_supplier_id'))).toBe(false);
  });

  it('tenantIds 非数组 → 400', async () => {
    const res = await request(makeApp(makePool(), baseConfig()))
      .post('/v1/admin/mio-suppliers/backfill')
      .send({ tenantIds: 't1' });

    expect(res.status).toBe(400);
  });
});
