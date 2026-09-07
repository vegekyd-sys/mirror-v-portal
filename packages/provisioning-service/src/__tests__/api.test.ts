import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { TestContext } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import type { ProvisioningConfig } from '../config.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/dealclaw_test';

let pool: pg.Pool;
let config: ProvisioningConfig;
let app: ReturnType<typeof createApp>;

let dbAvailable = false;

const dbIt = (name: string, fn: (ctx: TestContext) => Promise<void> | void) => {
  it(name, async (ctx) => {
    if (!dbAvailable) { ctx.skip(); return; }
    await fn(ctx);
  });
};

// NB FIX: Shared auth headers for protected tenant routes
const authHeader = { Authorization: 'Bearer test-token' };

beforeAll(async () => {
  // NB FIX: Set provisioning API token for test auth
  process.env.PROVISIONING_API_TOKEN = 'test-token';

  try {
    pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
    await migrate(pool);
    dbAvailable = true;
  } catch {
    console.warn('[provisioning-service tests] Database unavailable — skipping DB-dependent tests');
    return;
  }

  // NB FIX: No credits-ledger service exists in the local test environment.
  // Every POST /v1/tenants (with or without bot credentials) calls
  // createCreditsAccount() → fetch('http://credits-ledger:8081/v1/admin/customers'),
  // which would fail with ECONNREFUSED and turn every tenant-creation test
  // into a 500. Intercept only credits-ledger calls with a fake 201 (the
  // real createCreditsAccount code path still runs — URL building, JSON body,
  // ok/DUPLICATE handling) and delegate everything else to the real fetch.
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url.includes('credits-ledger') && method === 'POST' && url.endsWith('/v1/admin/customers')) {
      return new Response(JSON.stringify({ ok: true, accountId: 'acct_test-mock' }), { status: 201 });
    }
    return realFetch(input, init);
  });

  config = {
    port: 0,
    databaseUrl: TEST_DB,
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
    backupImage: 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/video-editor/ossutil:2.2.1',
    creditsLedgerUrl: 'http://credits-ledger:8081',
    creditsLedgerToken: '',
    llmPushWorkerIntervalMs: 100,
    llmPushLeaseSeconds: 600,

  };
  app = createApp(pool, config);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('GET /healthz', () => {
  it('returns service info', async () => {
    // healthz test: works without DB if app was created, else skip
    if (!app) {
      // Create minimal app without DB
      const minimalPool = new pg.Pool({ connectionString: TEST_DB, max: 1 });
      app = createApp(minimalPool, {
        port: 0, databaseUrl: TEST_DB, k8sDryRun: true,
        runtimeNamespace: 'dealclaw-test', imageRegistry: 'test-registry/dealclaw',
        nexusGatewayImageTag: 'test', dealclawAgentImageTag: 'test',
        agentPvcSize: '10Gi', agentPvcStorageClass: 'alibabacloud-cnfs-nas', agentPvcAccessMode: 'ReadWriteOnce',
        ossEndpoint: 'oss-cn-shanghai.aliyuncs.com', ossBucket: 'dealclaw-backup', ossSecretName: 'dealclaw-oss', backupImage: 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/video-editor/ossutil:2.2.1', creditsLedgerUrl: 'http://credits-ledger:8081', creditsLedgerToken: '', llmPushWorkerIntervalMs: 100, llmPushLeaseSeconds: 600,
      });
    }
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('provisioning-service');
  });
});

describe('POST /v1/tenants — create', () => {
  dbIt('creates a tenant with bot credentials and provisions k8s resources (openclaw plane)', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: '测试科技公司',
        contactEmail: 'test@example.com',
        contactPhone: '+86-13800138000',
        planTier: 'pro',
        quotaAgents: 5,
        quotaCreditsMonthly: 5_000_000,
        botAppId: 'cli_test0000000001',
        botAppSecret: 'test-secret-12345678',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant.tenantId).toHaveLength(32);
    expect(res.body.tenant.companyName).toBe('测试科技公司');
    // Bot credentials present → provisioned immediately and activated
    expect(res.body.provisioned).toBe(true);
    expect(res.body.tenant.status).toBe('active');
    expect(res.body.tenant.planTier).toBe('pro');
    expect(res.body.tenant.k8sNamespace).toMatch(/^dealclaw-/);
    expect(res.body.tenant.messagePlane).toBe('openclaw');
    expect(res.body.provisioning.secrets.length).toBeGreaterThanOrEqual(3);
    expect(res.body.provisioning.pods).toContain(`nexus-gateway-${res.body.tenant.tenantId}`);
    expect(res.body.provisioning.pods).toContain(`dealclaw-agent-${res.body.tenant.tenantId}`);
  });

  dbIt('without Feishu credentials → customer-only record, NO agent provisioned', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: '无凭据客户',
        contactEmail: 'nocreds@example.com',
        planTier: 'starter',
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.provisioned).toBe(false);
    expect(res.body.provisioning).toBeNull();
    // Stays pending until credentials are bound (PUT /credentials auto-provisions)
    expect(res.body.tenant.status).toBe('pending');
    expect(res.body.tenant.k8sNamespace).toMatch(/^dealclaw-/);
    // DB plane pinned to the desired end state, never 'gateway'
    expect(res.body.tenant.messagePlane).toBe('openclaw');

    // GET detail confirms the deferred state is recorded in the status log
    const getRes = await request(app)
      .get(`/v1/tenants/${res.body.tenant.tenantId}`)
      .set(authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.tenant.messagePlane).toBe('openclaw');
    expect(getRes.body.statusLog[0].reason).toContain('deferred');
  });

  dbIt('accepts missing companyName as optional (QR-flow support)', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ contactEmail: 'test@example.com' });
    // NB2 FIX: companyName is optional for QR-flow tenants — defaults to 'new-tenant'
    expect(res.status).toBe(201);
    expect(res.body.tenant.companyName).toBe('new-tenant');
  });

  dbIt('accepts invalid email with fallback', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'Test', contactEmail: 'not-an-email' });
    // NB2 FIX: invalid email gets replaced with pending-<id>@dealclaw.cn fallback
    expect(res.status).toBe(201);
    expect(res.body.tenant.contactEmail).toMatch(/^pending-/);
  });

  dbIt('sanitizes script tags in company name', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: '<script>alert("xss")</script>上海有限公司',
        contactEmail: 'xss@example.com',
      });
    expect(res.status).toBe(201);
    expect(res.body.tenant.companyName).not.toContain('<script>');
    expect(res.body.tenant.companyName).toContain('上海有限公司');
  });

  dbIt('defaults to starter plan for invalid plan', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: 'DefaultPlan Co',
        contactEmail: 'default@example.com',
        planTier: 'super_premium',
      });
    expect(res.status).toBe(201);
    expect(res.body.tenant.planTier).toBe('starter');
  });

  dbIt('clamps quota values to safe ranges', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: 'QuotaTest',
        contactEmail: 'quota@example.com',
        quotaAgents: 999,
        quotaCreditsMonthly: 999_999_999,
      });
    expect(res.status).toBe(201);
    expect(res.body.tenant.quotaAgents).toBeLessThanOrEqual(100); // clamped
  });
});

describe('GET /v1/tenants/:id', () => {
  let tenantId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'GetTest Co', contactEmail: 'get@example.com' });
    tenantId = res.body.tenant.tenantId;
  });

  dbIt('returns tenant details', async () => {
    const res = await request(app)
      .get(`/v1/tenants/${tenantId}`)
      .set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.tenant.tenantId).toBe(tenantId);
    expect(res.body.tenant.companyName).toBe('GetTest Co');
    // Created without bot credentials → customer-only record: the deferred
    // status log entry follows the initial "Tenant created" entry.
    expect(res.body.statusLog.length).toBe(2);
    expect(res.body.statusLog[0].to).toBe('pending');
    expect(res.body.statusLog[0].reason).toContain('deferred');
    expect(res.body.tenant.messagePlane).toBe('openclaw');
  });

  dbIt('returns dry-run runtime status without querying K8s', async () => {
    const res = await request(app)
      .get(`/v1/tenants/${tenantId}/runtime`)
      .set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.tenantId).toBe(tenantId);
  });

  dbIt('returns 404 for unknown tenant', async () => {
    const res = await request(app)
      .get('/v1/tenants/nonexist')
      .set(authHeader);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/tenants — list', () => {
  dbIt('returns tenant list', async () => {
    const res = await request(app)
      .get('/v1/tenants')
      .set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenants.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tenants[0].tenantId).toBeDefined();
  });
});

describe('PATCH /v1/tenants/:id/status', () => {
  let tenantId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'StatusTest Co', contactEmail: 'status@example.com' });
    tenantId = res.body.tenant.tenantId;
  });

  dbIt('transitions status with log', async () => {
    const res = await request(app)
      .patch(`/v1/tenants/${tenantId}/status`)
      .set(authHeader)
      .send({ status: 'active', reason: 'Payment verified' });
    expect(res.status).toBe(200);
    expect(res.body.toStatus).toBe('active');

    // Verify status persisted
    const getRes = await request(app)
      .get(`/v1/tenants/${tenantId}`)
      .set(authHeader);
    expect(getRes.body.tenant.status).toBe('active');
    // 2 creation/deferral entries + 1 manual patch entry
    expect(getRes.body.statusLog.length).toBe(3);
  });

  dbIt('rejects invalid status', async () => {
    const res = await request(app)
      .patch(`/v1/tenants/${tenantId}/status`)
      .set(authHeader)
      .send({ status: 'unknown_state' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/tenants/:id', () => {
  let tenantId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'DeleteMe Co', contactEmail: 'delete@example.com' });
    tenantId = res.body.tenant.tenantId;
  });

  dbIt('destroys tenant and deprovisions', async () => {
    const res = await request(app)
      .delete(`/v1/tenants/${tenantId}`)
      .set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify status is destroyed
    const getRes = await request(app)
      .get(`/v1/tenants/${tenantId}`)
      .set(authHeader);
    expect(getRes.body.tenant.status).toBe('destroyed');
  });

  dbIt('returns 404 for non-existent tenant', async () => {
    const res = await request(app)
      .delete('/v1/tenants/nonexist')
      .set(authHeader);
    expect(res.status).toBe(404);
  });
});

describe('PUT /v1/tenants/:id/credentials — deferred provisioning', () => {
  dbIt('auto-provisions a pending (customer-only) tenant when credentials are bound', async () => {
    // Create without credentials → customer-only record (no agent)
    const created = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'Deferred Co', contactEmail: 'deferred@example.com' });
    expect(created.body.provisioned).toBe(false);
    const tid = created.body.tenant.tenantId;

    // Bind credentials → agent gets auto-provisioned on the openclaw plane
    const res = await request(app)
      .put(`/v1/tenants/${tid}/credentials`)
      .set(authHeader)
      .send({ appId: 'cli_deferred00001', appSecret: 'deferred-secret-1234' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.provisioned).toBe(true);
    expect(res.body.plane).toBe('openclaw');
    expect(res.body.pods).toContain(`nexus-gateway-${tid}`);
    expect(res.body.pods).toContain(`dealclaw-agent-${tid}`);

    // Tenant activated and plane persisted
    const getRes = await request(app)
      .get(`/v1/tenants/${tid}`)
      .set(authHeader);
    expect(getRes.body.tenant.status).toBe('active');
    expect(getRes.body.tenant.messagePlane).toBe('openclaw');
  });

  dbIt('rejects missing credentials', async () => {
    const created = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({ companyName: 'NoCreds Body Co', contactEmail: 'nobody@example.com' });
    const tid = created.body.tenant.tenantId;
    const res = await request(app)
      .put(`/v1/tenants/${tid}/credentials`)
      .set(authHeader)
      .send({ appId: 'cli_abc' });
    expect(res.status).toBe(400);
  });

  dbIt('is a no-op credential update for already-provisioned tenants', async () => {
    // Created WITH credentials → provisioned + active immediately
    const created = await request(app)
      .post('/v1/tenants')
      .set(authHeader)
      .send({
        companyName: 'Active Co',
        contactEmail: 'active@example.com',
        botAppId: 'cli_active000001',
        botAppSecret: 'active-secret-1234',
      });
    const tid = created.body.tenant.tenantId;
    expect(created.body.tenant.status).toBe('active');

    // Re-persisting (QR flow re-writes the same creds) must NOT re-provision
    const res = await request(app)
      .put(`/v1/tenants/${tid}/credentials`)
      .set(authHeader)
      .send({ appId: 'cli_active000001', appSecret: 'active-secret-1234' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.provisioned).toBe(false);
  });
});
