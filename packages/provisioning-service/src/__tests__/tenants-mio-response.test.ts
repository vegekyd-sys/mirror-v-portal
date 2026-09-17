import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTenantRoutes } from '../routes/tenants.js';
import type { ProvisioningConfig } from '../config.js';

function baseConfig(): ProvisioningConfig {
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
  };
}

interface FakeQuery { sql: string; params?: unknown[] }

/** pg.Pool + client 替身：只记录 SQL，不连库。 */
function makePool() {
  const queries: FakeQuery[] = [];
  const record = (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
  const client = {
    query: async (sql: string, params?: unknown[]) => record(sql, params),
    release: () => {},
  };
  const pool = {
    queries,
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => record(sql, params),
  };
  return pool as any;
}

function makeApp(pool: any) {
  const app = express();
  app.use(express.json());
  app.use(createTenantRoutes(pool, baseConfig()));
  return app;
}

/** credits-ledger 账户创建成功（本测试只关心 tenants 写入与响应结构）。 */
function stubCreditsLedger() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ accountId: 'acct_test' }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /v1/tenants — 米奥供应商向后兼容', () => {
  it('不传 mioCdpSupplierId：照旧建租户、响应 mioSupplier=null、不自动绑定', async () => {
    const pool = makePool();
    stubCreditsLedger();

    const res = await request(makeApp(pool))
      .post('/v1/tenants')
      .send({ companyName: 'Acme Ltd', contactEmail: 'ops@acme.test' });

    expect(res.status).toBe(201);
    expect(res.body.provisioned).toBe(false);
    expect(res.body.mioSupplier).toBeNull();
    expect(res.body.tenant.mioCdpSupplierId).toBeNull();
    expect(res.body.provisioning).toBeNull();

    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO tenants'));
    // (tenant_id, company_name, contact_email, contact_phone, plan_tier,
    //  k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly,
    //  app_id, app_secret, mio_cdp_supplier_id, message_plane)
    expect(insert?.params?.[11]).toBeNull();
    expect(insert?.params?.[12]).toBe('openclaw');
    // 没有任何自动绑定的写库动作。
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('UPDATE tenants SET mio_cdp_supplier_id'))).toBe(false);
  });

  it('传了 mioCdpSupplierId：沿用旧校验与落库，响应回显', async () => {
    const pool = makePool();
    stubCreditsLedger();

    const res = await request(makeApp(pool))
      .post('/v1/tenants')
      .send({ companyName: 'Acme Ltd', contactEmail: 'ops@acme.test', mioCdpSupplierId: '123456789012' });

    expect(res.status).toBe(201);
    expect(res.body.mioSupplier).toEqual({ supplierId: '123456789012' });
    expect(res.body.tenant.mioCdpSupplierId).toBe('123456789012');
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO tenants'));
    expect(insert?.params?.[11]).toBe('123456789012');
  });

  it('非法供应商 ID 仍然 400（格式未放松）', async () => {
    const pool = makePool();
    stubCreditsLedger();

    const res = await request(makeApp(pool))
      .post('/v1/tenants')
      .send({ companyName: 'Acme Ltd', contactEmail: 'ops@acme.test', mioCdpSupplierId: 'bad id!' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_SUPPLIER_ID');
    expect(pool.queries).toHaveLength(0);
  });
});
