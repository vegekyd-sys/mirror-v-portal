import { Router } from 'express';
import { query } from './db.js';

const router = Router();

// GET /api/auth/verify — verify admin token and return session info
router.get('/api/auth/verify', async (_req, res) => {
  // Auth middleware already validated the token
  res.json({ ok: true, role: 'admin' });
});

// GET /api/tenants
router.get('/api/tenants', async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    let q = 'SELECT tenant_id, company_name, plan_tier, status, subscription_end, created_at FROM tenants';
    const params: unknown[] = [];
    if (status) { q += ' WHERE status = $1'; params.push(status); }
    q += ' ORDER BY created_at DESC LIMIT 100';

    const { rows } = await query(q, params);

    // Stats
    const statsResult = await query(
      "SELECT status, COUNT(*) FROM tenants GROUP BY status"
    );
    const stats: Record<string, number> = {};
    statsResult.rows.forEach((r: any) => { stats[r.status] = Number(r.count); });
    stats.total = Object.values(stats).reduce((a, b) => a + b, 0);

    res.json({ tenants: rows, stats, total: stats.total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /api/credits/summary
router.get('/api/credits/summary', async (req, res) => {
  try {
    const { rows: accts } = await query(
      'SELECT * FROM credits_accounts ORDER BY balance DESC'
    );
    const { rows: totalRow } = await query(
      'SELECT SUM(balance) as total_balance, SUM(monthly_used) as total_used FROM credits_accounts'
    );

    const lowBalance = accts.filter((r: any) =>
      r.monthly_allowance > 0 && Number(r.balance) < Number(r.monthly_allowance) * 0.1
    ).length;

    res.json({
      totalBalance: Number(totalRow[0]?.total_balance ?? 0),
      totalMonthlyConsumed: Number(totalRow[0]?.total_used ?? 0),
      lowBalanceTenants: lowBalance,
      topConsumers: accts.slice(0, 20).map((r: any) => ({
        tenantId: r.tenant_id,
        planTier: r.plan_tier,
        balance: Number(r.balance),
        monthlyAllowance: Number(r.monthly_allowance),
        monthlyUsed: Number(r.monthly_used),
        usagePercent: r.monthly_allowance > 0
          ? Math.round((Number(r.monthly_used) / Number(r.monthly_allowance)) * 100)
          : 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /api/health
router.get('/api/health', async (req, res) => {
  try {
    // Collect health info from db query
    const { rows: tenants } = await query(
      "SELECT tenant_id, status FROM tenants WHERE status = 'active' LIMIT 50"
    );

    res.json({
      central: {
        database: { healthy: true },
      },
      tenants: tenants.map((t: any) => ({
        tenantId: t.tenant_id,
        status: t.status,
      })),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

// GET /api/audit
router.get('/api/audit', async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    const conditions = ['1=1'];
    const params: unknown[] = [];
    if (tenantId) { conditions.push(`tenant_id = $${params.length + 1}`); params.push(tenantId); }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    params.push(limit);

    const { rows } = await query(
      `SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );

    const statsResult = await query(
      `SELECT result, COUNT(*) FROM audit_log GROUP BY result`
    );
    const stats: Record<string, number> = {};
    statsResult.rows.forEach((r: any) => { stats[r.result] = Number(r.count); });

    res.json({ entries: rows, stats });
  } catch {
    // audit_log may not exist yet in M0
    res.json({ entries: [], stats: {} });
  }
});

// ── Skill Pricing (proxy to credits-ledger) ──
const CREDITS_LEDGER_URL = process.env.CREDITS_LEDGER_URL || 'http://localhost:8081';

async function proxyToLedger(path: string, init?: RequestInit) {
  const res = await fetch(`${CREDITS_LEDGER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers as Record<string,string> },
    ...init,
  });
  return { status: res.status, body: await res.json() };
}

router.get('/api/skill-prices', async (_req, res) => {
  try {
    const result = await proxyToLedger('/v1/skill-prices');
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Proxy to credits-ledger failed:', err);
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

router.get('/api/skill-prices/:skillId/history', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/skill-prices/${encodeURIComponent(req.params.skillId)}/history`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Proxy to credits-ledger failed:', err);
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

router.put('/api/skill-prices', async (req, res) => {
  try {
    const { skillId, ...rest } = req.body;
    const result = await proxyToLedger(`/v1/skill-prices/${encodeURIComponent(skillId)}`, {
      method: 'PUT',
      body: JSON.stringify(rest),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Proxy to credits-ledger failed:', err);
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

// GET /api/orders
router.get('/api/orders', async (req, res) => {
  try {
    const status = req.query.status as string;
    let q = 'SELECT * FROM payment_orders';
    const params: unknown[] = [];
    if (status) { q += ' WHERE status = $1'; params.push(status); }
    q += ' ORDER BY created_at DESC LIMIT 50';

    const { rows } = await query(q, params);
    res.json({ orders: rows });
  } catch {
    // payment_orders may not exist yet in M0
    res.json({ orders: [] });
  }
});

export default router;
