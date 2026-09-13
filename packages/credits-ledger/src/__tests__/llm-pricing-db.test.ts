import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import { closePool, getPool, query } from '../db/pool.js';
import { importLegacyPricing } from '../services/llm-pricing-import.js';

const app = createApp();
const auth = 'Bearer test-token';
const tenantId = `pricing-db-${randomUUID()}`;
const accountId = `acct_${tenantId}`;
const requestId = `pricing-shadow-${randomUUID()}`;
const originalPricingShadow = process.env.LLM_PRICING_SHADOW;

beforeAll(async () => {
  process.env.PAYMENT_SERVICE_TOKEN = 'test-token';
  process.env.BILLING_SERVICE_TOKEN = 'test-token';
  process.env.ADMIN_API_TOKEN = 'test-token';
  process.env.LLM_PRICING_SHADOW = 'true';

  // The migration must be safe on both a fresh database and a repeated run.
  await migrate();
  await migrate();

  await query(
    `INSERT INTO credits_accounts
       (id,tenant_id,plan_tier,balance,monthly_allowance,monthly_used,month_reset_at)
     VALUES ($1,$2,'pro',10000,0,321,NOW() + INTERVAL '1 month')
     ON CONFLICT (id) DO UPDATE SET balance=10000, monthly_used=321`,
    [accountId, tenantId],
  );
});

afterAll(async () => {
  try {
    await query('DELETE FROM llm_usage_events WHERE tenant_id=$1', [tenantId]);
    await query('DELETE FROM credits_transactions WHERE account_id=$1', [accountId]);
    await query('DELETE FROM credits_accounts WHERE id=$1', [accountId]);
    await closePool();
  } finally {
    if (originalPricingShadow === undefined) delete process.env.LLM_PRICING_SHADOW;
    else process.env.LLM_PRICING_SHADOW = originalPricingShadow;
  }
});

describe.skipIf(!process.env.DATABASE_URL)('LLM pricing PostgreSQL integration', () => {
  it('imports legacy prices idempotently', async () => {
    const first = await importLegacyPricing(getPool(), false);
    const second = await importLegacyPricing(getPool(), false);

    expect(first.errorCount).toBe(0);
    expect(first.totalCount).toBeGreaterThan(0);
    expect(first.importedCount + first.skippedCount).toBe(first.totalCount);
    expect(second.errorCount).toBe(0);
    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBe(second.totalCount);

    const { rows } = await query(
      "SELECT COUNT(*) AS count FROM llm_model_price_plans WHERE source='legacy-import'",
    );
    expect(Number(rows[0].count)).toBe(first.totalCount);
  });

  it('writes one immutable shadow on replay without debiting credits', async () => {
    const beforeAccount = await query(
      'SELECT balance,monthly_used FROM credits_accounts WHERE id=$1',
      [accountId],
    );
    const beforeTransactions = await query(
      'SELECT COUNT(*) AS count FROM credits_transactions WHERE account_id=$1',
      [accountId],
    );

    const body = {
      tenantId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      inputTokens: 1200,
      outputTokens: 340,
      cacheHitTokens: 200,
      cacheMissTokens: 1000,
      requestId,
      status: 'ok',
      source: 'proxy',
    };
    const first = await request(app)
      .post('/v1/billing/llm-usage')
      .set('Authorization', auth)
      .send(body);
    const replay = await request(app)
      .post('/v1/billing/llm-usage')
      .set('Authorization', auth)
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);

    const events = await query(
      'SELECT id FROM llm_usage_events WHERE tenant_id=$1 AND request_id=$2',
      [tenantId, requestId],
    );
    expect(events.rowCount).toBe(1);
    const shadows = await query(
      'SELECT status,amount,legacy_amount,delta_amount,pricing_snapshot FROM llm_usage_pricing_shadows WHERE usage_event_id=$1',
      [events.rows[0].id],
    );
    expect(shadows.rowCount).toBe(1);
    expect(['resolved', 'free']).toContain(shadows.rows[0].status);
    expect(shadows.rows[0].pricing_snapshot).toBeTruthy();

    const afterAccount = await query(
      'SELECT balance,monthly_used FROM credits_accounts WHERE id=$1',
      [accountId],
    );
    const afterTransactions = await query(
      'SELECT COUNT(*) AS count FROM credits_transactions WHERE account_id=$1',
      [accountId],
    );
    expect(afterAccount.rows[0]).toEqual(beforeAccount.rows[0]);
    expect(afterTransactions.rows[0].count).toBe(beforeTransactions.rows[0].count);

    const summary = await request(app)
      .get('/v1/admin/llm-pricing/summary?limit=5')
      .set('Authorization', auth);
    expect(summary.status).toBe(200);
    expect(summary.body.planCount).toBeGreaterThan(0);
    expect(summary.body.shadowStatuses.resolved + summary.body.shadowStatuses.free).toBeGreaterThan(0);
    expect(summary.body.legacyComparisonCount).toBeGreaterThan(0);
    expect(summary.body.deltaCounts.zero + summary.body.deltaCounts.nonzero).toBeGreaterThan(0);
    expect(summary.body.deltaSamples.length).toBeLessThanOrEqual(5);
  });

  it('disables pricing observation APIs with the existing shadow flag', async () => {
    process.env.LLM_PRICING_SHADOW = 'false';
    try {
      const response = await request(app)
        .get('/v1/admin/llm-pricing/summary')
        .set('Authorization', auth);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('DISABLED');
    } finally {
      process.env.LLM_PRICING_SHADOW = 'true';
    }
  });
});
