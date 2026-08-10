import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestContext } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import { query, closePool } from '../db/pool.js';
import { createAccount } from '../services/account.js';
import { runMonthlyReset } from '../services/monthly-reset.js';

const TEST_ACCOUNT = 'credits-test-001';
const TEST_TENANT = 'test-tenant';

const app = createApp();

let dbAvailable = false;

const dbIt = (name: string, fn: (ctx: TestContext) => Promise<void> | void) => {
  it(name, async (ctx) => {
    if (!dbAvailable) { ctx.skip(); return; }
    await fn(ctx);
  });
};

beforeAll(async () => {
  process.env.PAYMENT_SERVICE_TOKEN = 'test-token';
  process.env.ADMIN_API_TOKEN = 'test-token';

  // Probe DB availability before running heavy setup
  // Clean skill_prices so latest seed data applies
  try {
    await query('DELETE FROM skill_prices');
    await migrate();
    dbAvailable = true;
  } catch {
    console.warn('[credits-ledger tests] Database unavailable — skipping DB-dependent tests');
    return;
  }

  await createAccount({
    id: TEST_ACCOUNT,
    tenantId: 'test-tenant',
    planTier: 'pro',
    monthlyAllowance: 5_000_000,
  });
  await query('UPDATE credits_accounts SET balance = 10000, monthly_used = 0 WHERE id = $1', [TEST_ACCOUNT]);
  await query('DELETE FROM credits_transactions WHERE account_id = $1', [TEST_ACCOUNT]);
  await query('DELETE FROM skill_billing_events WHERE tenant_id = $1', [TEST_TENANT]);
  await query('DELETE FROM price_change_log');
});

afterAll(async () => {
  if (!dbAvailable) return;
  await query('DELETE FROM credits_transactions WHERE account_id = $1', [TEST_ACCOUNT]);
  await query('DELETE FROM credits_accounts WHERE id = $1', [TEST_ACCOUNT]);
  await closePool();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await query('UPDATE credits_accounts SET balance = 10000, monthly_used = 0 WHERE id = $1', [TEST_ACCOUNT]);
  await query('DELETE FROM credits_transactions WHERE account_id = $1', [TEST_ACCOUNT]);
});

describe('GET /healthz', () => {
  it('returns 200 when DB available, 503 when not', async () => {
    const res = await request(app).get('/healthz');
    if (dbAvailable) {
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } else {
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toBe('Database unavailable');
    }
    expect(res.body.service).toBe('credits-ledger');
  });
});

describe('GET /v1/accounts/:id/balance', () => {
  dbIt('returns balance for existing account', async () => {
    const res = await request(app).get(`/v1/accounts/${TEST_ACCOUNT}/balance`);
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(TEST_ACCOUNT);
    expect(res.body.balance).toBe(10000);
    expect(res.body.planTier).toBe('pro');
    expect(res.body.monthlyAllowance).toBe(5_000_000);
  });

  dbIt('returns 404 for non-existent account', async () => {
    const res = await request(app).get('/v1/accounts/nonexistent/balance');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('POST /v1/accounts/:id/debit', () => {
  dbIt('debites credits on sufficient balance', async () => {
    const res = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 2000, reference: 'req-test-1', idempotencyKey: 'key-a' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.balanceBefore).toBe(10000);
    expect(res.body.balanceAfter).toBe(8000);
  });

  dbIt('returns 402 on insufficient balance', async () => {
    const res = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 20000, reference: 'req-test-2', idempotencyKey: 'key-b' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(res.body.balance).toBe(10000);
    expect(res.body.required).toBe(20000);
  });

  dbIt('handles idempotency — same key returns same result', async () => {
    const key = 'idem-test-001';
    const r1 = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 2000, reference: 'req-001', idempotencyKey: key });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);

    const r2 = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 2000, reference: 'req-001', idempotencyKey: key });
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);

    // Balance should only be debited once
    const bal = await request(app).get(`/v1/accounts/${TEST_ACCOUNT}/balance`);
    expect(bal.body.balance).toBe(8000);
  });

  dbIt('rejects missing required fields', async () => {
    const res = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 100 });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/accounts/:id/credit', () => {
  dbIt('credits account when authorized', async () => {
    const res = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/credit`)
      .set('Authorization', 'Bearer test-token')
      .send({ amount: 5000, reference: 'order-001', idempotencyKey: 'credit-key-a' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.balanceBefore).toBe(10000);
    expect(res.body.balanceAfter).toBe(15000);
  });

  dbIt('rejects unauthorized credit call', async () => {
    const res = await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/credit`)
      .send({ amount: 5000, reference: 'order-001', idempotencyKey: 'credit-key-b' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/accounts/:id/history', () => {
  dbIt('returns transaction history', async () => {
    // Create a few transactions first
    await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 1000, reference: 'req-h1', idempotencyKey: 'hist-1' });
    await request(app)
      .post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 2000, reference: 'req-h2', idempotencyKey: 'hist-2' });

    const res = await request(app).get(`/v1/accounts/${TEST_ACCOUNT}/history`);
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(TEST_ACCOUNT);
    expect(res.body.transactions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /v1/accounts/:id/usage', () => {
  dbIt('returns monthly usage', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app)
      .get(`/v1/accounts/${TEST_ACCOUNT}/usage?month=${month}`);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(month);
    expect(res.body.monthlyAllowance).toBe(5_000_000);
  });
});

describe('POST /v1/admin/monthly-reset', () => {
  dbIt('resets overdue accounts', async () => {
    // Make the test account overdue
    await query(
      `UPDATE credits_accounts
       SET monthly_used = 5000,
           month_reset_at = '2020-01-01 00:00:00+00'
       WHERE id = $1`,
      [TEST_ACCOUNT]
    );

    const result = await runMonthlyReset();
    expect(result.resetAccounts).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);

    // Verify account was reset
    const { rows } = await query(
      'SELECT monthly_used, month_reset_at FROM credits_accounts WHERE id = $1',
      [TEST_ACCOUNT]
    );
    expect(Number(rows[0].monthly_used)).toBe(0);
    expect(new Date(rows[0].month_reset_at).getTime()).toBeGreaterThan(Date.now());
  });

  dbIt('skips already-reset accounts (idempotent)', async () => {
    const result = await runMonthlyReset();
    expect(result.resetAccounts).toBe(0);
    // No overdue accounts → 0 reset + 0 skipped (query returns nothing)
    expect(result.skippedAccounts + result.resetAccounts).toBe(0);
  });

  dbIt('unauthenticated request returns 401 when token configured', async () => {
    process.env.ADMIN_API_TOKEN = 'test-token';
    try {
      const res = await request(app)
        .post('/v1/admin/monthly-reset')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    } finally {
      // NB FIX: Restore instead of delete to not break subsequent tests
      process.env.ADMIN_API_TOKEN = 'test-token';
    }
  });
});

// ── v2: Skill Pricing & Billing Hook Tests ──

describe('GET /v1/skill-prices', () => {
  dbIt('returns all prices with summary', async () => {
    const res = await request(app).get('/v1/skill-prices');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.prices)).toBe(true);
    expect(res.body.prices.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.summary)).toBe(true);
    const ids = res.body.prices.map((p: any) => p.skillId);
    expect(ids).toContain('dealclaw-find-buyers');
    expect(ids).toContain('dealclaw-analyze-company');
    expect(ids).toContain('dealclaw-email-growth-send');
    expect(ids).toContain('dealclaw-email-founder-direct');
  });

  dbIt('filters by category', async () => {
    const res = await request(app).get('/v1/skill-prices?category=outreach');
    expect(res.status).toBe(200);
    res.body.prices.forEach((p: any) => expect(p.category).toBe('outreach'));
  });
});

describe('PUT /v1/skill-prices/:skillId', () => {
  dbIt('creates and updates a skill price', async () => {
    const r1 = await request(app)
      .put('/v1/skill-prices/test.buyer_basic')
      .send({ skillName: '测试买家', category: 'buyer', creditPerUnit: 150 });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.price.creditPerUnit).toBe(150);

    const r2 = await request(app)
      .put('/v1/skill-prices/test.buyer_basic')
      .send({ skillName: '测试买家(改)', category: 'buyer', creditPerUnit: 200 });
    expect(r2.status).toBe(200);
    expect(r2.body.price.creditPerUnit).toBe(200);
    expect(r2.body.logId).toBeDefined();
  });
});

describe('POST /v1/skill-prices/estimate', () => {
  dbIt('estimates cost for a known skill', async () => {
    const res = await request(app)
      .post('/v1/skill-prices/estimate')
      .send({ skillId: 'dealclaw-find-buyers', quantity: 10 });
    expect(res.status).toBe(200);
    expect(res.body.totalCredit).toBe(3000);
    expect(res.body.unitPrice).toBe(300);
    expect(res.body.isDefault).toBe(false);
  });

  dbIt('falls back to global default for unknown skill prefix', async () => {
    const res = await request(app)
      .post('/v1/skill-prices/estimate')
      .send({ skillId: 'unknown.nonexistent', quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.unitPrice).toBe(100);
    expect(res.body.totalCredit).toBe(300);
  });
});

describe('POST /v1/billing/estimate', () => {
  dbIt('estimates and records billing event', async () => {
    const res = await request(app)
      .post('/v1/billing/estimate')
      .send({
        tenantId: TEST_TENANT, accountId: TEST_ACCOUNT,
        taskId: 'task-test-1', skillId: 'dealclaw-analyze-company', quantity: 5,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.estimatedCredit).toBe(6000);
    expect(res.body.eventId).toBeDefined();
  });
});

describe('POST /v1/billing/settle', () => {
  dbIt('deducts credits and settles billing event', async () => {
    const est = await request(app)
      .post('/v1/billing/estimate')
      .send({ tenantId: TEST_TENANT, accountId: TEST_ACCOUNT, taskId: 'task-s', skillId: 'dealclaw-find-buyers', quantity: 10 });
    expect(est.body.ok).toBe(true);

    const res = await request(app)
      .post('/v1/billing/settle')
      .send({
        tenantId: TEST_TENANT, accountId: TEST_ACCOUNT, taskId: 'task-s',
        skillId: 'dealclaw-find-buyers', quantity: 10,
        estimatedEventId: est.body.eventId, resultSummary: '返回10条买家',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.actualCredit).toBe(3000);
    expect(res.body.transactionId).toBeDefined();
  });

  dbIt('returns 402 on insufficient credits', async () => {
    const res = await request(app)
      .post('/v1/billing/settle')
      .send({
        tenantId: TEST_TENANT, accountId: TEST_ACCOUNT, taskId: 'task-fail',
        skillId: 'dealclaw-exhibition-leads', quantity: 100, estimatedEventId: 'fake',
      });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('POST /v1/billing/can-afford', () => {
  dbIt('checks affordability', async () => {
    const res = await request(app)
      .post('/v1/billing/can-afford')
      .send({ accountId: TEST_ACCOUNT, skillId: 'dealclaw-find-buyers', quantity: 50 });
    expect(res.status).toBe(200);
    expect(res.body.canAfford).toBe(false);
    expect(res.body.estimatedCredit).toBe(15000);
    expect(res.body.balance).toBe(10000);
  });
});

describe('GET /v1/billing/events', () => {
  dbIt('returns billing events for a tenant', async () => {
    const res = await request(app).get(`/v1/billing/events?tenantId=${TEST_TENANT}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.summary).toBeDefined();
  });
});

describe('GET /v1/admin/monthly-reset/status', () => {
  dbIt('returns active and overdue counts', async () => {
    const res = await request(app)
      .get('/v1/admin/monthly-reset/status')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(typeof res.body.activeAccounts).toBe('number');
    expect(typeof res.body.overdueReset).toBe('number');
  });
});
