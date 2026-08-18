import { describe, it, expect, beforeAll } from 'vitest';
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
  };
  app = createApp(pool, config);
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
        ossEndpoint: 'oss-cn-shanghai.aliyuncs.com', ossBucket: 'dealclaw-backup', ossSecretName: 'dealclaw-oss', backupImage: 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/video-editor/ossutil:2.2.1', creditsLedgerUrl: 'http://credits-ledger:8081', creditsLedgerToken: '',
      });
    }
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('provisioning-service');
  });
});

describe('POST /v1/tenants — create', () => {
  dbIt('creates a tenant and provisions k8s resources', async () => {
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
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenant.tenantId).toHaveLength(32);
    expect(res.body.tenant.companyName).toBe('测试科技公司');
    expect(res.body.tenant.status).toBe('pending');
    expect(res.body.tenant.planTier).toBe('pro');
    expect(res.body.tenant.k8sNamespace).toMatch(/^dealclaw-/);
    expect(res.body.provisioning.secrets.length).toBeGreaterThanOrEqual(3);
    expect(res.body.provisioning.pods).toContain(`nexus-gateway-${res.body.tenant.tenantId}`);
    expect(res.body.provisioning.pods).toContain(`dealclaw-agent-${res.body.tenant.tenantId}`);
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
    expect(res.body.statusLog.length).toBe(1);
    expect(res.body.statusLog[0].to).toBe('pending');
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
    expect(getRes.body.statusLog.length).toBe(2);
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
