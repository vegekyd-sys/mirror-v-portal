import { describe, it, expect, beforeAll } from 'vitest';
import type { TestContext } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app.js';
import { computeTransition, type TenantState } from '../services/state-machine.js';
import { scanTenants, shouldResetMonthly, getNotificationsForToday } from '../services/scheduler.js';
import { enrichWithCredits, getCreditsBalance } from '../services/credits-check.js';
import type { OpsConfig } from '../config.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:***@localhost:5432/dealclaw_test';

let pool: pg.Pool;
let config: OpsConfig;
let app: ReturnType<typeof createApp>;

let dbAvailable = false;

const dbIt = (name: string, fn: (ctx: TestContext) => Promise<void> | void) => {
  it(name, async (ctx) => {
    if (!dbAvailable) { ctx.skip(); return; }
    await fn(ctx);
  });
};

beforeAll(async () => {
  // NB FIX: Set ops API token for test auth
  process.env.OPS_API_TOKEN = 'test-token';

  try {
    pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn('[ops-agent tests] Database unavailable — skipping DB-dependent API tests');
    pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
  }

  config = {
    port: 0,
    databaseUrl: TEST_DB,
    creditsLedgerUrl: 'http://credits-ledger:8081',
    cronIntervalMinutes: 60,
  };
  app = createApp(pool, config);
});

// ── State Machine Tests ──

function makeTenant(overrides: Partial<TenantState>): TenantState {
  const now = new Date();
  return {
    id: 'cust-001',
    status: 'active',
    creditsBalance: 5_000_000,
    monthlyAllowance: 5_000_000,
    monthlyUsed: 1_000_000,
    subscriptionEnd: new Date(now.getFullYear() + 1, 0, 1),
    suspendedAt: null,
    graceUntil: null,
    daysInCurrentStatus: 0,
    hasPaymentPending: false,
    ...overrides,
  };
}

describe('State Machine', () => {
  it('active tenant with sufficient credits stays active', () => {
    const result = computeTransition(makeTenant());
    expect(result).toBeNull();
  });

  it('active → low_credits when balance is 0', () => {
    const result = computeTransition(makeTenant({ creditsBalance: 0 }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('low_credits');
    expect(result!.actions.some(a => a.type === 'notify')).toBe(true);
  });

  it('active → low_credits when balance below 10%', () => {
    const result = computeTransition(makeTenant({ creditsBalance: 400_000 }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('low_credits');
  });

  it('low_credits → active when credits replenished', () => {
    const result = computeTransition(makeTenant({
      status: 'low_credits',
      creditsBalance: 4_000_000,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('active');
  });

  it('low_credits → suspended after 7 days without payment', () => {
    const result = computeTransition(makeTenant({
      status: 'low_credits',
      creditsBalance: 0,
      daysInCurrentStatus: 7,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('suspended');
  });

  it('suspended → active when payment received', () => {
    const result = computeTransition(makeTenant({
      status: 'suspended',
      hasPaymentPending: true,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('active');
  });

  it('suspended → grace after 7 days', () => {
    const result = computeTransition(makeTenant({
      status: 'suspended',
      daysInCurrentStatus: 8,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('grace');
  });

  it('grace → destroyed after 30 days', () => {
    const result = computeTransition(makeTenant({
      status: 'grace',
      daysInCurrentStatus: 30,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('destroyed');
  });

  it('grace → active when payment received', () => {
    const result = computeTransition(makeTenant({
      status: 'grace',
      hasPaymentPending: true,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('active');
  });

  it('destroyed stays destroyed — no transition', () => {
    const result = computeTransition(makeTenant({ status: 'destroyed' }));
    expect(result).toBeNull();
  });

  it('pending stays pending — no transition', () => {
    const result = computeTransition(makeTenant({ status: 'pending' }));
    expect(result).toBeNull();
  });

  it('active → suspended when subscription expired', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = computeTransition(makeTenant({
      status: 'active',
      subscriptionEnd: yesterday,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('suspended');
  });

  it('sends 7-day expiry reminder', () => {
    const in7Days = new Date();
    in7Days.setDate(in7Days.getDate() + 7);
    const result = computeTransition(makeTenant({ subscriptionEnd: in7Days }));
    expect(result).not.toBeNull();
    expect(result!.actions.some(a => a.message?.includes('7 days'))).toBe(true);
  });

  it('sends 3-day expiry reminder', () => {
    const in3Days = new Date();
    in3Days.setDate(in3Days.getDate() + 3);
    const result = computeTransition(makeTenant({ subscriptionEnd: in3Days }));
    expect(result).not.toBeNull();
    expect(result!.actions.some(a => a.message?.includes('3 days'))).toBe(true);
  });

  it('grace 15-day deletion warning', () => {
    const result = computeTransition(makeTenant({
      status: 'grace',
      daysInCurrentStatus: 15,
    }));
    expect(result).not.toBeNull();
    expect(result!.to).toBe('grace');
    expect(result!.actions.some(a => a.type === 'notify')).toBe(true);
  });

  it('grace not destroyed at day 15 (only warns)', () => {
    const result = computeTransition(makeTenant({
      status: 'grace',
      daysInCurrentStatus: 15,
    }));
    expect(result!.actions).toContainEqual(
      expect.objectContaining({ type: 'notify' }),
    );
  });
});

// ── Scheduler Tests ──

describe('Scheduler', () => {
  it('shouldResetMonthly returns true when date passed', () => {
    const past = new Date();
    past.setMonth(past.getMonth() - 1);
    expect(shouldResetMonthly(past)).toBe(true);
  });

  it('shouldResetMonthly returns false for future date', () => {
    const future = new Date();
    future.setMonth(future.getMonth() + 1);
    expect(shouldResetMonthly(future)).toBe(false);
  });

  it('getNotificationsForToday returns 7-day warning', () => {
    const in7Days = new Date();
    in7Days.setDate(in7Days.getDate() + 7);
    const result = getNotificationsForToday(in7Days);
    expect(result).toContain('7-day expiry reminder');
  });

  it('scanTenants aggregates results', () => {
    const result = scanTenants([
      makeTenant({ creditsBalance: 0 }),
      makeTenant({ status: 'grace', daysInCurrentStatus: 30 }),
      makeTenant({}),
    ]);
    expect(result.scanned).toBe(3);
    expect(result.transitions.length).toBe(2);
    expect(result.errors.length).toBe(0);
  });
});

// ── Credits Check Tests ──

describe('Credits Check', () => {
  it('getCreditsBalance returns zeros when unreachable (fail-open)', async () => {
    const result = await getCreditsBalance('http://127.0.0.1:19999', 'test-account');
    expect(result.balance).toBe(0);
    expect(result.monthlyUsed).toBe(0);
  });

  it('enrichWithCredits returns map for all tenants', async () => {
    const result = await enrichWithCredits('http://127.0.0.1:19999', ['t1', 't2']);
    expect(result.has('t1')).toBe(true);
    expect(result.has('t2')).toBe(true);
    expect(result.get('t1')?.balance).toBe(0); // fail-open, unreachable
  });
});

// ── API Tests ──

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('ops-agent');
  });
});

describe('GET /v1/ops/status', () => {
  it('returns scheduler config', async () => {
    const res = await request(app).get('/v1/ops/status');
    expect(res.status).toBe(200);
    expect(res.body.cronIntervalMinutes).toBe(60);
    expect(res.body.creditsLedgerUrl).toBeDefined();
  });
});

describe('POST /v1/ops/scan', () => {
  dbIt('scans tenant list and returns transitions', async () => {
    const res = await request(app)
      .post('/v1/ops/scan')
      .set('Authorization', 'Bearer test-token')
      .send({ tenants: [makeTenant({ creditsBalance: 0 })] });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.transitions[0].to).toBe('low_credits');
  });

  dbIt('handles empty tenant list', async () => {
    const res = await request(app)
      .post('/v1/ops/scan')
      .set('Authorization', 'Bearer test-token')
      .send({ tenants: [] });
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(0);
  });
});

describe('POST /v1/ops/check', () => {
  dbIt('checks single tenant', async () => {
    const res = await request(app)
      .post('/v1/ops/check')
      .set('Authorization', 'Bearer test-token')
      .send(makeTenant({ creditsBalance: 0 }));
    expect(res.status).toBe(200);
    expect(res.body.tenant).toBe('cust-001');
    expect(res.body.transition.to).toBe('low_credits');
  });

  dbIt('rejects invalid input', async () => {
    const res = await request(app)
      .post('/v1/ops/check')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/ops/cron', () => {
  dbIt('runs cron cycle and returns results', async () => {
    const res = await request(app)
      .post('/v1/ops/cron')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.timestamp).toBeDefined();
    expect(typeof res.body.scanned).toBe('number');
    expect(Array.isArray(res.body.transitions)).toBe(true);
  });
});
