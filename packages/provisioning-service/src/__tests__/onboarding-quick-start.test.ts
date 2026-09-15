import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 替身：米奥客户端 / K8s / crypto / credits ─────────────────────────────
const mioMocks = vi.hoisted(() => ({
  searchMioSuppliers: vi.fn(),
  quickRegisterMioSupplier: vi.fn(),
  MioApiError: class MioApiError extends Error {
    constructor(
      public kind: string,
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
      this.name = 'MioApiError';
    }
  },
  MIO_REQUEST_TIMEOUT_MS: 10_000,
}));
vi.mock('../services/mio-supplier-client.js', () => mioMocks);

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(async () => null),
  putSecret: vi.fn(async () => undefined),
  getDeployment: vi.fn(async () => null),
  patchDeployment: vi.fn(async () => true),
  restartDeployment: vi.fn(async () => true),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

const cryptoMocks = vi.hoisted(() => ({
  encryptValue: vi.fn((v: string) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`),
  decryptValue: vi.fn((v: string) =>
    v.startsWith('enc:') ? Buffer.from(v.slice(4), 'base64').toString('utf8') : v,
  ),
  getMasterKey: vi.fn(() => Buffer.alloc(32, 7)),
  isEncrypted: vi.fn((v: string) => v.startsWith('enc:')),
  maskValue: vi.fn(() => '••••••••'),
  MasterKeyError: class MasterKeyError extends Error {},
}));
vi.mock('../services/crypto.js', () => cryptoMocks);

import { createOnboardingRoutes } from '../routes/onboarding.js';
import { createTenantRoutes } from '../routes/tenants.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
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

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

/** pg.Pool + client 替身：记录 SQL，不连库。 */
function makePool(opts: { tenants?: any[] } = {}) {
  const queries: FakeQuery[] = [];
  const respond = (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('FROM global_defaults')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM runtime_configs')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM tenants')) return { rows: opts.tenants ?? [], rowCount: (opts.tenants ?? []).length };
    return { rows: [], rowCount: 1 };
  };
  const client = { query: async (sql: string, params?: unknown[]) => respond(sql, params), release: () => {} };
  const pool = {
    queries,
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => respond(sql, params),
  };
  return pool as any;
}

/** 扫码会话替身：不触碰飞书网络。 */
function makeScanStore() {
  return {
    start: vi.fn(async () => ({
      deviceCode: 'dc_test_001',
      qrUrl: 'https://open.feishu.cn/open-apis/authen/qr/test',
      qrDataUri: 'data:image/png;base64,AAAA',
      expireIn: 600,
      status: 'pending' as const,
    })),
  };
}

function makeApp(pool: any, store: any) {
  const app = express();
  app.use(express.json());
  app.use(createOnboardingRoutes(pool, baseConfig, undefined, store));
  return app;
}

/** credits-ledger 账户创建成功（本测试只关心开通流水线本身）。 */
function stubCreditsLedger() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ accountId: 'acct_test' }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  k8sMocks.getSecret.mockResolvedValue(null);
  k8sMocks.getDeployment.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/admin/onboarding/quick-start', () => {
  it('唯一精确命中 → 用其 id，不再 quickRegister，建租户 + 出二维码', async () => {
    const pool = makePool();
    stubCreditsLedger();
    mioMocks.searchMioSuppliers.mockResolvedValue({
      total: 2,
      items: [
        { id: '999999999999', code: 'C1', name: 'Acme Ltd（分公司）' },
        { id: '123456789012', code: 'C2', name: '  acme ltd  ' },
      ],
    });

    const res = await request(makeApp(pool, makeScanStore()))
      .post('/v1/admin/onboarding/quick-start')
      .send({ companyName: 'Acme Ltd', contactPhone: '13800000000', intDialingCode: '+86', planTier: 'pro' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      supplierId: '123456789012',
      deviceCode: 'dc_test_001',
      qrUrl: 'https://open.feishu.cn/open-apis/authen/qr/test',
      status: 'pending',
    });
    expect(res.body.supplier).toMatchObject({ supplierId: '123456789012', created: false });
    expect(mioMocks.quickRegisterMioSupplier).not.toHaveBeenCalled();

    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO tenants'));
    expect(insert?.params?.[11]).toBe('123456789012'); // mio_cdp_supplier_id
    expect(insert?.params?.[3]).toBe('+8613800000000'); // 带国际区号的联系人手机
    expect(insert?.params?.[4]).toBe('pro'); // plan_tier
  });

  it('0 条精确命中 → quickRegister 新建供应商并绑定', async () => {
    const pool = makePool();
    stubCreditsLedger();
    mioMocks.searchMioSuppliers.mockResolvedValue({
      total: 1,
      items: [{ id: '111111111111', code: 'C9', name: 'Another Co' }],
    });
    mioMocks.quickRegisterMioSupplier.mockResolvedValue({ supplierId: '555555555555', name: 'New Co' });

    const res = await request(makeApp(pool, makeScanStore()))
      .post('/v1/admin/onboarding/quick-start')
      .send({ companyName: 'New Co', contactPhone: '13900000000', intDialingCode: '+86' });

    expect(res.status).toBe(201);
    expect(mioMocks.quickRegisterMioSupplier).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyName: 'New Co', mobile: '13900000000', intDialingCode: '+86' }),
    );
    expect(res.body.supplierId).toBe('555555555555');
    expect(res.body.supplier).toMatchObject({ created: true });
  });

  it('多条精确命中 → 409 + 候选列表，绝不自动取第一条，且不建租户', async () => {
    const pool = makePool();
    stubCreditsLedger();
    mioMocks.searchMioSuppliers.mockResolvedValue({
      total: 2,
      items: [
        { id: '111111111111', code: null, name: 'Acme Ltd' },
        { id: '222222222222', code: null, name: 'ACME LTD' },
      ],
    });

    const res = await request(makeApp(pool, makeScanStore()))
      .post('/v1/admin/onboarding/quick-start')
      .send({ companyName: 'acme ltd', contactPhone: '13800000000' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MULTIPLE_MATCHES');
    expect(res.body.candidates).toEqual([
      { id: '111111111111', code: null, name: 'Acme Ltd' },
      { id: '222222222222', code: null, name: 'ACME LTD' },
    ]);
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('INSERT INTO tenants'))).toBe(false);
    expect(mioMocks.quickRegisterMioSupplier).not.toHaveBeenCalled();
  });

  it('米奥业务失败（如同名重复）→ 409，原样透出上游 msg', async () => {
    const pool = makePool();
    stubCreditsLedger();
    mioMocks.searchMioSuppliers.mockResolvedValue({ total: 0, items: [] });
    mioMocks.quickRegisterMioSupplier.mockRejectedValue(
      new (mioMocks.MioApiError as any)('business', 409, 'MIO_BUSINESS_ERROR', '公司名称已存在'),
    );

    const res = await request(makeApp(pool, makeScanStore()))
      .post('/v1/admin/onboarding/quick-start')
      .send({ companyName: 'Dup Co', contactPhone: '13800000000' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('公司名称已存在');
  });

  it('校验：缺企业名 / 缺手机号 → 400，且不打米奥接口', async () => {
    const pool = makePool();
    const app = makeApp(pool, makeScanStore());

    const noName = await request(app).post('/v1/admin/onboarding/quick-start').send({ contactPhone: '138' });
    expect(noName.status).toBe(400);
    expect(noName.body.code).toBe('VALIDATION');

    const noPhone = await request(app).post('/v1/admin/onboarding/quick-start').send({ companyName: 'X' });
    expect(noPhone.status).toBe(400);

    expect(mioMocks.searchMioSuppliers).not.toHaveBeenCalled();
    expect(pool.queries).toHaveLength(0);
  });
});

describe('POST /v1/tenants — 抽取到 tenant-create 后仍向后兼容', () => {
  function makeTenantApp(pool: any) {
    const app = express();
    app.use(express.json());
    app.use(createTenantRoutes(pool, baseConfig));
    return app;
  }

  it('无飞书凭据：只建客户记录（provisioned=false，无 secretsCreated）', async () => {
    const pool = makePool();
    stubCreditsLedger();

    const res = await request(makeTenantApp(pool))
      .post('/v1/tenants')
      .send({ companyName: 'Acme Ltd', contactEmail: 'ops@acme.test' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, provisioned: false, provisioning: null });
    expect(res.body.mioSupplier).toBeNull();
    expect(res.body.tenant.messagePlane).toBe('openclaw');
    expect(res.body.tenant.secretsCreated).toBeUndefined();
  });

  it('有飞书凭据：走 provision（dry-run）并回 secretsCreated/podsScheduled', async () => {
    const pool = makePool();
    stubCreditsLedger();

    const res = await request(makeTenantApp(pool))
      .post('/v1/tenants')
      .send({
        companyName: 'Acme Ltd',
        contactEmail: 'ops@acme.test',
        botAppId: 'cli_test0001',
        botAppSecret: 'test-secret',
      });

    expect(res.status).toBe(201);
    expect(res.body.provisioned).toBe(true);
    expect(res.body.tenant.status).toBe('active');
    expect(Array.isArray(res.body.tenant.secretsCreated)).toBe(true);
    expect(Array.isArray(res.body.tenant.podsScheduled)).toBe(true);
    expect(res.body.provisioning.dryRun).toBeUndefined();
    expect(res.body.provisioning.warnings.join(' ')).toContain('DRY_RUN');
  });

  it('重复邮箱（23505）仍是 409 DUPLICATE', async () => {
    const pool = makePool();
    stubCreditsLedger();
    // 让 INSERT INTO tenants 抛唯一约束错误
    const dupPool = {
      ...pool,
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('INSERT INTO tenants')) {
            const e: any = new Error('duplicate key');
            e.code = '23505';
            e.constraint = 'tenants_contact_email_key';
            throw e;
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
      query: async () => ({ rows: [], rowCount: 1 }),
    };

    const res = await request(makeTenantApp(dupPool))
      .post('/v1/tenants')
      .send({ companyName: 'Acme Ltd', contactEmail: 'dup@acme.test' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });
});
