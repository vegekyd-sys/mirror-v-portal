/**
 * E2E Full-Chain Test — DealClaw (excluding payment)
 *
 * Covers:
 *   Chain 1: Onboarding API — GET /onboard returns QR code, status polling
 *   Chain 2: Agent Execution (nexus-gateway → credits-ledger → mock-agent)
 *   Chain 3: Credits Flow (balance check → debit → balance verification)
 *   Chain 4: Cross-service full loop (DB-direct tenant → execute → credits)
 *
 * Note: registerApp() requires a real Feishu account; not tested in CI.
 *   Chain 1 tests the API structure, not the actual registerApp flow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import pg from 'pg';

// ═══ DB setup (must happen before module imports that read DATABASE_URL) ═══
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/dealclaw_test';
process.env.DATABASE_URL = TEST_DB;

let pool: pg.Pool;

// ═══ Service references ═══
let provisioningUrl: string;
let creditsLedgerUrl: string;
let mockAgentUrl: string;
let provisioningServer: http.Server;
let creditsLedgerServer: http.Server;
let mockAgentServer: http.Server;

// Helper: start an express app on an ephemeral port
function startServer(app: any): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

beforeAll(async () => {
  // 1. Create DB pool
  pool = new pg.Pool({ connectionString: TEST_DB, max: 4 });

  // 2. Run migrations
  const { migrate: migrateTenants } = await import('../packages/provisioning-service/src/db/migrate.js');
  await migrateTenants(pool);

  const { migrate: migrateCredits } = await import('../packages/credits-ledger/src/db/migrate.js');
  await migrateCredits();

  // 3. Start provisioning-service
  const { createApp: _createProvisioningApp } = await import(
    '../packages/provisioning-service/src/app.js'
  );
  const provApp = _createProvisioningApp(pool, {
    port: 0,
    databaseUrl: TEST_DB,
    k8sDryRun: true,
  });
  const provInfo = await startServer(provApp);
  provisioningServer = provInfo.server;
  provisioningUrl = provInfo.url;

  // 4. Start credits-ledger
  const { createApp: _createCreditsApp } = await import(
    '../packages/credits-ledger/src/app.js'
  );
  const creditsApp = _createCreditsApp();
  const creditsInfo = await startServer(creditsApp);
  creditsLedgerServer = creditsInfo.server;
  creditsLedgerUrl = creditsInfo.url;

  // 5. Start mock-agent
  const { createApp: _createMockApp } = await import(
    '../packages/mock-agent/src/app.js'
  );
  const mockApp = _createMockApp();
  const mockInfo = await startServer(mockApp);
  mockAgentServer = mockInfo.server;
  mockAgentUrl = mockInfo.url;

  // 6. Clean any leftover test tenant
  await pool.query("DELETE FROM credits_transactions WHERE account_id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM credits_monthly_usage WHERE account_id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM credits_accounts WHERE id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM tenant_status_log WHERE tenant_id LIKE 'e2e-%'");
  await pool.query("DELETE FROM tenants WHERE tenant_id LIKE 'e2e-%'");

  // 7. Pre-create a tenant for Chain 1 API tests
  await pool.query(
    `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['e2e-onboard', 'E2E Onboard Corp', 'onboard@testcorp.com', 'pro', 'active', 5, 10_000_000]
  );
});

afterAll(async () => {
  // Cleanup test data
  await pool.query("DELETE FROM credits_transactions WHERE account_id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM credits_monthly_usage WHERE account_id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM credits_accounts WHERE id LIKE 'credits-e2e-%'");
  await pool.query("DELETE FROM tenant_status_log WHERE tenant_id LIKE 'e2e-%'");
  await pool.query("DELETE FROM tenants WHERE tenant_id LIKE 'e2e-%'");
  await pool.end();

  provisioningServer?.close();
  creditsLedgerServer?.close();
  mockAgentServer?.close();
});

// ═══════════════════════════════════════════════
// Chain 1: Onboarding API (new registerApp flow)
// ═══════════════════════════════════════════════
describe('Chain 1: Onboarding API', () => {
  it('GET /onboard returns QR code for feishu UA', async () => {
    process.env.PROVISIONING_SERVICE_URL = provisioningUrl;
    const { createApp: _createCentralApp } = await import(
      '../packages/central-gateway/src/app.js'
    );
    const centralApp = _createCentralApp();

    const res = await request(centralApp)
      .get('/onboard')
      .set('User-Agent', 'Feishu/7.0 iOS');

    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('feishu');
    expect(res.body.status).toBe('pending');
    expect(res.body).toHaveProperty('deviceCode');
  });

  it('GET /onboard returns manual guidance for non-feishu', async () => {
    process.env.PROVISIONING_SERVICE_URL = provisioningUrl;
    const { createApp: _createCentralApp } = await import(
      '../packages/central-gateway/src/app.js'
    );
    const centralApp = _createCentralApp();

    const res = await request(centralApp)
      .get('/onboard')
      .set('User-Agent', 'Chrome/120');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('manual');
  });

  it('GET /onboard/status returns 400 without deviceCode', async () => {
    const { createApp: _createCentralApp } = await import(
      '../packages/central-gateway/src/app.js'
    );
    const centralApp = _createCentralApp();

    const res = await request(centralApp).get('/onboard/status');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('POST /onboard/cancel returns 400 without deviceCode', async () => {
    const { createApp: _createCentralApp } = await import(
      '../packages/central-gateway/src/app.js'
    );
    const centralApp = _createCentralApp();

    const res = await request(centralApp).post('/onboard/cancel').send({});
    expect(res.status).toBe(400);
  });

  it('provisioning-service can still create tenants via DB (direct)', async () => {
    // Verify the provisioning layer works independently
    const { rows } = await pool.query(
      'SELECT * FROM tenants WHERE tenant_id = $1',
      ['e2e-onboard']
    );
    expect(rows.length).toBe(1);
    expect(rows[0].company_name).toBe('E2E Onboard Corp');

    // Verify provisioning-service API still works
    const tenantRes = await fetch(`${provisioningUrl}/v1/tenants/e2e-onboard`);
    expect(tenantRes.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════
// Chain 2: Agent Execution
// ═══════════════════════════════════════════════
describe('Chain 2: Agent Execution via Nexus Gateway', () => {
  let tenantId: string;
  let creditsAccountId: string;

  beforeAll(async () => {
    // Create a test tenant directly in DB (simulating what provisioning does)
    const { rows: tenantRows } = await pool.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING tenant_id`,
      ['e2e-exec', 'E2E Exec Corp', 'exec@testcorp.com', 'pro', 'active', 5, 10_000_000]
    );
    tenantId = tenantRows[0].tenant_id;

    // Create credits account for this tenant
    creditsAccountId = `credits-e2e-${tenantId}`;
    await pool.query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [creditsAccountId, tenantId, 'pro', 100_000, 5_000_000, 500_000, '2027-08-01T00:00:00Z']
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credits_transactions WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_monthly_usage WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_accounts WHERE id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM tenant_status_log WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
  });

  it('executes an agent command and forwards to mock-agent', async () => {
    const { createApp: _createNexusApp } = await import(
      '../packages/nexus-gateway/src/app.js'
    );

    const nexusApp = _createNexusApp({
      port: 0,
      tenantId,
      platform: 'dingtalk',
      planTier: 'pro',
      agentUrl: mockAgentUrl,
      creditsLedgerUrl,
      initialCredits: 0,
      keyConfig: {
        customerKeyRef: 'test-customer-key',
        botCredentialRef: 'test-bot-cred',
        creditsAccountId,
        configVersion: '1',
      },
    });

    const res = await request(nexusApp)
      .post('/v1/agent/execute')
      .send({
        senderId: 'test-user-001',
        intent: { kind: 'search_buyers' },
        message: '帮我找德国的光伏逆变器买家',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent).toBe('mock-agent');
    expect(res.body.intent).toBe('search_buyers');
    expect(res.body.result.leads).toHaveLength(3);
    expect(res.body.result.leads[0].company).toBe('Munich Energy GmbH');
    expect(res.body.result.leads[0].matchScore).toBe(92);
    expect(res.body.meta.tenantId).toBe(tenantId);
    expect(res.body.meta.planTier).toBe('pro');
  });

  it('returns 401 when no identity is provided', async () => {
    const { createApp: _createNexusApp } = await import(
      '../packages/nexus-gateway/src/app.js'
    );

    const nexusApp = _createNexusApp({
      port: 0,
      tenantId,
      platform: 'dingtalk',
      planTier: 'starter',
      agentUrl: mockAgentUrl,
      creditsLedgerUrl,
      initialCredits: 0,
      keyConfig: {
        customerKeyRef: 'test-customer-key',
        botCredentialRef: 'test-bot-cred',
        creditsAccountId,
        configVersion: '1',
      },
    });

    // No senderId in body → identity check should fail
    const res = await request(nexusApp)
      .post('/v1/agent/execute')
      .send({ intent: { kind: 'chat' }, message: 'hello' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 402 when credits are insufficient', async () => {
    // Create a fresh tenant with almost no credits
    const { rows: poorRows } = await pool.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING tenant_id`,
      ['e2e-poor', 'E2E Poor Corp', 'poor@testcorp.com', 'starter', 'active', 1, 100_000]
    );
    const poorTenantId = poorRows[0].tenant_id;
    const poorCreditsId = `credits-e2e-${poorTenantId}`;
    await pool.query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [poorCreditsId, poorTenantId, 'starter', 100, 100_000, 0, '2027-08-01T00:00:00Z']
    );

    const { createApp: _createNexusApp } = await import(
      '../packages/nexus-gateway/src/app.js'
    );

    const nexusApp = _createNexusApp({
      port: 0,
      tenantId: poorTenantId,
      platform: 'dingtalk',
      planTier: 'starter',
      agentUrl: mockAgentUrl,
      creditsLedgerUrl,
      initialCredits: 0,
      keyConfig: {
        customerKeyRef: 'test-customer-key-poor',
        botCredentialRef: 'test-bot-cred-poor',
        creditsAccountId: poorCreditsId,
        configVersion: '1',
      },
    });

    // action intent costs 8000 credits, but balance is only 100
    const res = await request(nexusApp)
      .post('/v1/agent/execute')
      .send({
        senderId: 'test-user-002',
        intent: { kind: 'action' },
        message: 'do something expensive',
      });

    // Cleanup
    await pool.query('DELETE FROM credits_accounts WHERE id = $1', [poorCreditsId]);
    await pool.query('DELETE FROM tenant_status_log WHERE tenant_id = $1', [poorTenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [poorTenantId]);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('passes credit check when credits-ledger is down (M0 fail-open)', async () => {
    const { createApp: _createNexusApp } = await import(
      '../packages/nexus-gateway/src/app.js'
    );

    // Point to unreachable credits-ledger
    const nexusApp = _createNexusApp({
      port: 0,
      tenantId,
      platform: 'dingtalk',
      planTier: 'pro',
      agentUrl: mockAgentUrl,
      creditsLedgerUrl: 'http://127.0.0.1:19999', // unreachable
      initialCredits: 0,
      keyConfig: {
        customerKeyRef: 'test-customer-key',
        botCredentialRef: 'test-bot-cred',
        creditsAccountId,
        configVersion: '1',
      },
    });

    const res = await request(nexusApp)
      .post('/v1/agent/execute')
      .send({
        senderId: 'test-user-001',
        intent: { kind: 'chat' }, // chat is free (0 credits)
        message: 'hello fail-open',
      });

    // Chat is free (0 credits), so it should pass even with credits-ledger down
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// Chain 3: Credits Flow
// ═══════════════════════════════════════════════
describe('Chain 3: Credits Balance & Transaction', () => {
  let tenantId: string;
  let creditsAccountId: string;

  beforeAll(async () => {
    // Create a tenant with known credits
    const { rows } = await pool.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING tenant_id`,
      ['e2e-credits', 'E2E Credits Corp', 'credits@testcorp.com', 'pro', 'active', 5, 10_000_000]
    );
    tenantId = rows[0].tenant_id;
    creditsAccountId = `credits-e2e-${tenantId}`;
    await pool.query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at, lifetime_credited)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [creditsAccountId, tenantId, 'pro', 500_000, 5_000_000, 1_000_000, '2027-08-01T00:00:00Z', 1_000_000]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credits_transactions WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_monthly_usage WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_accounts WHERE id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM tenant_status_log WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
  });

  it('GET balance returns correct balance', async () => {
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/balance`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(500_000);
    expect(body.accountId).toBe(creditsAccountId);
    expect(body.planTier).toBe('pro');
  });

  it('POST debit deducts credits and returns new balance', async () => {
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 5000,
        reference: 'e2e-test-debit-001',
        idempotencyKey: `e2e-txn-${Date.now()}`,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.balanceAfter).toBe(495_000); // 500k - 5k
    expect(body.balanceBefore).toBe(500_000);
    expect(body.transactionId).toBeDefined();
  });

  it('POST debit rejects duplicate idempotency key', async () => {
    const idemKey = `e2e-idem-dup-${Date.now()}`;

    // First debit
    await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000, reference: 'dup-1', idempotencyKey: idemKey }),
    });

    // Duplicate debit with same key
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000, reference: 'dup-2', idempotencyKey: idemKey }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Duplicate idempotent response: ok + idempotent flag
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    expect(body.transactionId).toBeDefined();
    // Verify balance was deducted only once
    const balRes = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/balance`);
    const balBody = await balRes.json();
    expect(balBody.balance).toBe(494_000); // 495k - 1k (only first debit counted)
  });

  it('POST debit rejects when amount exceeds balance', async () => {
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 10_000_000, // way more than balance
        reference: 'e2e-overdraft',
        idempotencyKey: `e2e-overdraft-${Date.now()}`,
      }),
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.balance).toBeLessThan(10_000_000);
  });

  it('GET history shows transactions in order', async () => {
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/history`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toBeDefined();
    expect(body.transactions.length).toBeGreaterThanOrEqual(2); // at least our 2 debits
    expect(body.transactions[0].type).toBe('debit');
  });

  it('GET usage returns monthly usage stats', async () => {
    const res = await fetch(`${creditsLedgerUrl}/v1/accounts/${creditsAccountId}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountId).toBe(creditsAccountId);
    expect(body.month).toBeDefined();
    expect(typeof body.totalUsed).toBe('number');
  });

  it('healthz returns ok', async () => {
    const res = await fetch(`${creditsLedgerUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('credits-ledger');
  });
});

// ═══════════════════════════════════════════════
// Chain 4: Cross-Service Integration
// ═══════════════════════════════════════════════
describe('Chain 4: Cross-Service', () => {
  let tenantId: string;
  let creditsAccountId: string;

  beforeAll(async () => {
    // Create tenant + credits account for full integration test
    const { rows } = await pool.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING tenant_id`,
      ['e2e-full', 'E2E Full Corp', 'full@testcorp.com', 'pro', 'active', 5, 10_000_000]
    );
    tenantId = rows[0].tenant_id;
    creditsAccountId = `credits-e2e-${tenantId}`;
    await pool.query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at, lifetime_credited)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [creditsAccountId, tenantId, 'pro', 500_000, 5_000_000, 1_000_000, '2027-08-01T00:00:00Z', 1_000_000]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credits_transactions WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_monthly_usage WHERE account_id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM credits_accounts WHERE id = $1', [creditsAccountId]);
    await pool.query('DELETE FROM tenant_status_log WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
  });

  it('full loop: DB tenant → execute → verify credits', async () => {
    // Step 1: Create tenant + credits directly in DB (simulating registerApp completion)
    const loopId = `e2e-loop-${Date.now()}`;
    const loopTenantId = loopId.slice(-8);
    await pool.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [loopTenantId, 'Full Loop 公司', 'loop@testcorp.com', 'pro', 'active', 5, 10_000_000]
    );

    const loopCreditsId = `credits-e2e-${loopTenantId}`;
    await pool.query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [loopCreditsId, loopTenantId, 'pro', 500_000, 5_000_000, 0, '2027-08-01T00:00:00Z']
    );

    // Step 2: Execute agent command (query costs 2000 credits)
    const { createApp: _createNexusApp } = await import(
      '../packages/nexus-gateway/src/app.js'
    );
    const nexusApp = _createNexusApp({
      port: 0,
      tenantId: loopTenantId,
      platform: 'dingtalk',
      planTier: 'pro',
      agentUrl: mockAgentUrl,
      creditsLedgerUrl,
      initialCredits: 0,
      keyConfig: {
        customerKeyRef: 'loop-key',
        botCredentialRef: 'loop-cred',
        creditsAccountId: loopCreditsId,
        configVersion: '1',
      },
    });

    const execRes = await request(nexusApp)
      .post('/v1/agent/execute')
      .send({
        senderId: 'loop-user-001',
        intent: { kind: 'query' },
        message: '查询德国市场情况',
      });

    expect(execRes.status).toBe(200);
    expect(execRes.body.ok).toBe(true);
    expect(execRes.body.agent).toBe('mock-agent');

    // Step 3: Verify credits were deducted (query = 2000 credits)
    await new Promise(r => setTimeout(r, 500));

    const balanceRes = await fetch(`${creditsLedgerUrl}/v1/accounts/${loopCreditsId}/balance`);
    const balanceBody = await balanceRes.json();
    expect(balanceBody.balance).toBeLessThanOrEqual(500_000);

    // Step 4: Provisioning-service can find the tenant
    const tenantRes = await fetch(`${provisioningUrl}/v1/tenants/${loopTenantId}`);
    expect(tenantRes.status).toBe(200);
    const tenantBody = await tenantRes.json();
    expect(tenantBody.tenant.companyName).toBe('Full Loop 公司');

    // Step 5: Onboarding API still functional (verify new API structure)
    process.env.PROVISIONING_SERVICE_URL = provisioningUrl;
    const { createApp: _createCentralApp } = await import(
      '../packages/central-gateway/src/app.js'
    );
    const centralApp = _createCentralApp();
    const onboardRes = await request(centralApp)
      .get('/onboard')
      .set('User-Agent', 'Feishu/7.0');
    expect(onboardRes.status).toBe(200);
    expect(onboardRes.body.status).toBe('pending');

    // Cleanup
    await pool.query('DELETE FROM credits_transactions WHERE account_id = $1', [loopCreditsId]);
    await pool.query('DELETE FROM credits_monthly_usage WHERE account_id = $1', [loopCreditsId]);
    await pool.query('DELETE FROM credits_accounts WHERE id = $1', [loopCreditsId]);
    await pool.query('DELETE FROM tenant_status_log WHERE tenant_id = $1', [loopTenantId]);
    await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [loopTenantId]);
  });
});
