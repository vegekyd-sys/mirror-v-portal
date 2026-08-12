import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../app.js';
import { query } from '../routes/db.js';

const app = createApp('postgresql://postgres:***@localhost:5432/dealclaw_test');

let dbAvailable = false;

/** Create a valid HMAC-SHA256 JWT for test admin auth */
function createTestToken(): string {
  const secret = process.env.ADMIN_JWT_SECRET || 'changeme-in-production';
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: 'test-admin',
    username: 'testadmin',
    displayName: 'Test Admin',
    role: 'admin',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

let testToken: string;

// Helper: skip test gracefully when DB is unavailable (CI/gate check)
const dbIt = (name: string, fn: (ctx: TestContext) => Promise<void> | void) => {
  it(name, async (ctx) => {
    if (!dbAvailable) { ctx.skip(); return; }
    await fn(ctx);
  });
};

beforeAll(async () => {
  testToken = createTestToken();

  // Probe DB availability before running heavy setup
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn('[admin-dashboard tests] Database unavailable — skipping DB-dependent tests');
    return;
  }

  // Ensure the shared test schema is additive. Never drop the tenants table here:
  // package tests run in parallel and provisioning-service uses the same test DB.
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT,
      plan_tier TEXT NOT NULL DEFAULT 'starter',
      status TEXT NOT NULL DEFAULT 'pending',
      k8s_namespace TEXT,
      credits_account_id TEXT,
      quota_agents INTEGER NOT NULL DEFAULT 1,
      quota_credits_monthly BIGINT NOT NULL DEFAULT 1000000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subscription_end TIMESTAMPTZ,
      suspended_at TIMESTAMPTZ,
      grace_until TIMESTAMPTZ,
      app_id TEXT,
      app_secret TEXT
    )
  `).catch(() => {});
  await query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ').catch(() => {});
  await query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ').catch(() => {});
  await query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ').catch(() => {});
  await query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_id TEXT').catch(() => {});
  await query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_secret TEXT').catch(() => {});
  await query(`
    CREATE TABLE IF NOT EXISTS credits_accounts (
      id VARCHAR(64) PRIMARY KEY, tenant_id VARCHAR(64),
      plan_tier VARCHAR(16), balance BIGINT DEFAULT 0,
      monthly_allowance BIGINT DEFAULT 0, monthly_used BIGINT DEFAULT 0,
      month_reset_at TIMESTAMPTZ, status VARCHAR(16) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await query("DELETE FROM credits_accounts WHERE id = 'credits-cust-001'").catch(() => {});
  await query("DELETE FROM tenants WHERE tenant_id = 'cust-001'").catch(() => {});
  await query("INSERT INTO tenants (tenant_id, company_name, contact_email, plan_tier, status, subscription_end) VALUES ('cust-001', 'Test Corp', 'test@corp.com', 'pro', 'active', '2027-07-01')");
  await query("INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, monthly_used, month_reset_at, status) VALUES ('credits-cust-001', 'cust-001', 'pro', 5000000, 5000000, 1000000, NOW() + INTERVAL '1 month', 'active')");
});

afterAll(async () => {
  if (!dbAvailable) return;
  await query("DELETE FROM credits_accounts WHERE id = 'credits-cust-001'").catch(() => {});
  await query("DELETE FROM tenants WHERE tenant_id = 'cust-001'").catch(() => {});
});

describe('GET /api/tenants', () => {
  dbIt('returns tenant list with stats', async () => {
    const res = await request(app)
      .get('/api/tenants')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tenants.length).toBeGreaterThanOrEqual(1);
    expect(res.body.tenants[0].tenant_id).toBe('cust-001');
    expect(res.body.stats.active).toBeGreaterThanOrEqual(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  dbIt('filters by status', async () => {
    const res = await request(app)
      .get('/api/tenants?status=active')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tenants.every((t: any) => t.status === 'active')).toBe(true);
  });
});

describe('GET /api/credits/summary', () => {
  dbIt('returns credits summary', async () => {
    const res = await request(app)
      .get('/api/credits/summary')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalBalance).toBeGreaterThan(0);
    expect(res.body.topConsumers.length).toBeGreaterThanOrEqual(1);
    expect(res.body.topConsumers[0].usagePercent).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/health', () => {
  dbIt('returns health status', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body.central.database.healthy).toBe(true);
  });
});

describe('GET /api/audit', () => {
  dbIt('returns empty gracefully when no audit_log table', async () => {
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('entries');
  });
});

describe('GET /api/orders', () => {
  dbIt('returns empty gracefully when no payment_orders table', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set('Authorization', `Bearer ${testToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('orders');
  });
});

describe('Frontend static', () => {
  it('serves index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('小元 · 管理后台');
  });
});
