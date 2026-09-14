import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillTenantMioSuppliers, isExactCompanyNameMatch } from '../services/mio-supplier.js';
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
  requested?: { tenant_id: string; company_name: string | null; status: string; mio_cdp_supplier_id: string | null }[];
  tenantRow?: Record<string, unknown> | null;
} = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('btrim(company_name)')) {
        return { rows: opts.candidates ?? [], rowCount: (opts.candidates ?? []).length };
      }
      if (sql.includes('SELECT tenant_id, company_name, status, mio_cdp_supplier_id')) {
        return { rows: opts.requested ?? [], rowCount: (opts.requested ?? []).length };
      }
      if (sql.includes('WHERE mio_cdp_supplier_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: opts.tenantRow ? [opts.tenantRow] : [], rowCount: opts.tenantRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

/** 按搜索关键词返回米奥 records 的假 fetch。 */
function mockSearch(byKeyword: Record<string, { id: string; code?: string | null; name: string | null }[]>) {
  const fn = vi.fn(async (_input: any, init?: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const keyword = String(body?.data?.search ?? '');
    const records = byKeyword[keyword] ?? [];
    return new Response(
      JSON.stringify({ code: 200, success: true, data: { records, total: records.length } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('isExactCompanyNameMatch', () => {
  it('忽略大小写与首尾空格的完整名称相等才算命中', () => {
    expect(isExactCompanyNameMatch('  Acme Ltd ', 'acme ltd')).toBe(true);
    expect(isExactCompanyNameMatch('Acme Ltd', 'Acme Ltd Holdings')).toBe(false);
    expect(isExactCompanyNameMatch('', '')).toBe(false);
    expect(isExactCompanyNameMatch(null, 'Acme')).toBe(false);
  });
});

describe('backfillTenantMioSuppliers — dryRun（默认）', () => {
  it('唯一精确命中 → would_bind；多条命中 → skipped，且完全不写库', async () => {
    mockSearch({
      'Acme Ltd': [{ id: '111111111111', code: 'C-1', name: ' acme ltd ' }],
      'Beta Co': [
        { id: '222222222222', name: 'Beta Co' },
        { id: '333333333333', name: ' beta co ' },
      ],
    });
    const pool = makePool({
      candidates: [
        { tenant_id: 't1', company_name: 'Acme Ltd' },
        { tenant_id: 't2', company_name: 'Beta Co' },
      ],
    });

    const result = await backfillTenantMioSuppliers(pool, baseConfig());

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.entries).toEqual([
      {
        tenantId: 't1',
        companyName: 'Acme Ltd',
        supplierId: '111111111111',
        supplierName: ' acme ltd ',
        supplierCode: 'C-1',
        action: 'would_bind',
      },
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ tenantId: 't2', reason: 'multiple_matches' });
    expect(result.skipped[0].candidates?.map((c) => c.id)).toEqual(['222222222222', '333333333333']);
    // 绝不自动取第一条 → 没有任何 UPDATE。
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('UPDATE tenants SET mio_cdp_supplier_id'))).toBe(false);
  });

  it('0 条命中 → skipped: no_match', async () => {
    mockSearch({ Gamma: [{ id: '999999999999', name: 'Gamma Holdings' }] });
    const pool = makePool({ candidates: [{ tenant_id: 't1', company_name: 'Gamma' }] });

    const result = await backfillTenantMioSuppliers(pool, baseConfig());

    expect(result.entries).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ tenantId: 't1', reason: 'no_match' });
    expect(result.skipped[0].detail).toContain('模糊命中 1 条');
  });
});

describe('backfillTenantMioSuppliers — 实写（dryRun=false）', () => {
  it('唯一精确命中才写库，并回报 bound', async () => {
    mockSearch({ 'Acme Ltd': [{ id: '111111111111', code: 'C-1', name: 'Acme Ltd' }] });
    const pool = makePool({
      candidates: [{ tenant_id: 't1', company_name: 'Acme Ltd' }],
      tenantRow: {
        tenant_id: 't1',
        company_name: 'Acme Ltd',
        status: 'active',
        k8s_namespace: 'dealclaw-t1',
        agent_endpoint: null,
        plan_tier: 'starter',
        quota_credits_monthly: '1000000',
        credits_account_id: 'acct_t1',
        mio_cdp_supplier_id: null,
      },
    });

    const result = await backfillTenantMioSuppliers(pool, baseConfig(), { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.updated).toBe(1);
    expect(result.entries[0]).toMatchObject({ tenantId: 't1', supplierId: '111111111111', action: 'bound' });
    const update = pool.queries.find((q: FakeQuery) => q.sql.includes('UPDATE tenants SET mio_cdp_supplier_id'));
    expect(update?.params).toEqual(['111111111111', 't1']);
  });

  it('唯一命中但写库被唯一约束拦截 → skipped: bind_failed（不谎报成功）', async () => {
    mockSearch({ 'Acme Ltd': [{ id: '111111111111', name: 'Acme Ltd' }] });
    const pool = makePool({
      candidates: [{ tenant_id: 't1', company_name: 'Acme Ltd' }],
      tenantRow: {
        tenant_id: 't1',
        company_name: 'Acme Ltd',
        status: 'active',
        k8s_namespace: 'dealclaw-t1',
        agent_endpoint: null,
        plan_tier: 'starter',
        quota_credits_monthly: '1000000',
        credits_account_id: 'acct_t1',
        mio_cdp_supplier_id: null,
      },
    });
    // 让 UPDATE 抛唯一冲突（模拟并发写入）。
    const original = pool.query;
    pool.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE tenants SET mio_cdp_supplier_id')) {
        const err: any = new Error('duplicate key value violates unique constraint "tenants_mio_supplier_uq"');
        err.code = '23505';
        err.constraint = 'tenants_mio_supplier_uq';
        throw err;
      }
      return original(sql, params);
    };

    const result = await backfillTenantMioSuppliers(pool, baseConfig(), { dryRun: false });

    expect(result.updated).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ tenantId: 't1', reason: 'bind_failed' });
    expect(result.skipped[0].detail).toContain('一个供应商 ID 只能对应一个客户');
  });
});

describe('backfillTenantMioSuppliers — tenantIds 与失败路径', () => {
  it('被点名但不满足候选条件的租户如实回报 not_candidate', async () => {
    mockSearch({});
    const pool = makePool({
      candidates: [],
      requested: [
        {
          tenant_id: 't2',
          company_name: 'Bound Co',
          status: 'active',
          mio_cdp_supplier_id: '999999999999',
        },
      ],
    });

    const result = await backfillTenantMioSuppliers(pool, baseConfig(), { tenantIds: ['t2', 't9'] });

    expect(result.scanned).toBe(0);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: 't2', reason: 'not_candidate', detail: '已绑定供应商 ID 999999999999' }),
        expect.objectContaining({ tenantId: 't9', reason: 'not_candidate', detail: '租户不存在' }),
      ]),
    );
  });

  it('米奥调用失败按 lookup_failed 跳过，不中断整批', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const pool = makePool({ candidates: [{ tenant_id: 't1', company_name: 'Acme Ltd' }] });

    const result = await backfillTenantMioSuppliers(pool, baseConfig());

    expect(result.skipped[0]).toMatchObject({ tenantId: 't1', reason: 'lookup_failed' });
  });

  it('凭据缺失时扫描前就失败（fail-fast，不发请求、不查库）', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const pool = makePool({ candidates: [{ tenant_id: 't1', company_name: 'Acme Ltd' }] });

    await expect(
      backfillTenantMioSuppliers(pool, baseConfig({ mioBladeAuth: '' }), { dryRun: false }),
    ).rejects.toMatchObject({ kind: 'config', code: 'MIO_AUTH_NOT_CONFIGURED' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pool.queries).toHaveLength(0);
  });
});
