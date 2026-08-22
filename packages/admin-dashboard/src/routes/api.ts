import { Router, type Request as ExpressRequest } from 'express';
import { query } from './db.js';

const router = Router();

// GET /api/auth/verify — verify admin token and return session info
router.get('/auth/verify', async (_req, res) => {
  // Auth middleware already validated the token
  res.json({ ok: true, role: 'admin' });
});

// GET /api/tenants
router.get('/tenants', async (req, res) => {
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
router.get('/credits/summary', async (req, res) => {
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
router.get('/health', async (req, res) => {
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
router.get('/audit', async (req, res) => {
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

// ── Runtime Config (proxy to provisioning-service) ──
const PROVISIONING_SERVICE_URL = process.env.PROVISIONING_SERVICE_URL || 'http://localhost:8082';

async function proxyToProvisioning(path: string, init?: { method?: string; body?: string }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.PROVISIONING_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.PROVISIONING_API_TOKEN}`;
  }
  const res = await fetch(`${PROVISIONING_SERVICE_URL}${path}`, {
    method: init?.method || 'GET',
    headers,
    body: init?.body,
  });
  return { status: res.status, body: await res.json() };
}

async function proxyToLedger(path: string, init?: RequestInit & { authReq?: ExpressRequest }) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> || {}),
  };

  // Forward the incoming Authorization header (admin JWT / public token) if
  // present; otherwise fall back to the internal service token so public
  // endpoints (e.g. /public/credit) can still reach credits-ledger now that it
  // requires auth.
  const incomingAuth = init?.authReq?.header('authorization');
  if (incomingAuth) {
    headers['Authorization'] = incomingAuth;
  } else if (process.env.BILLING_SERVICE_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.BILLING_SERVICE_TOKEN}`;
  }

  const { authReq: _, ...fetchInit } = init || {};
  const res = await fetch(`${CREDITS_LEDGER_URL}${path}`, {
    method: fetchInit.method || 'GET',
    headers,
    body: fetchInit.body,
  });
  return { status: res.status, body: await res.json() };
}

router.get('/skill-prices', async (_req, res) => {
  try {
    const result = await proxyToLedger('/v1/skill-prices');
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Proxy to credits-ledger failed:', err);
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

router.get('/skill-prices/:skillId/history', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/skill-prices/${encodeURIComponent(req.params.skillId)}/history`);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Proxy to credits-ledger failed:', err);
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

router.put('/skill-prices', async (req, res) => {
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

// ── Plan Templates (proxy to credits-ledger) ──

router.get('/admin/plans', async (_req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/plans');
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/plans', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/plans', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.delete('/admin/plans/:planId', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/plans/${encodeURIComponent(req.params.planId)}`, {
      method: 'DELETE',
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Customer Admin (proxy to credits-ledger) ──

router.get('/admin/customers', async (req, res) => {
  try {
    const status = req.query.status ? `?status=${req.query.status}` : '';
    const result = await proxyToLedger(`/v1/admin/customers${status}`);
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.get('/admin/customers/:tenantId', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/customers/${req.params.tenantId}`);
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/customers', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/customers', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/customers/:tenantId/topup', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/customers/${req.params.tenantId}/topup`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/customers/:tenantId/renew', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/customers/${req.params.tenantId}/renew`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Account Freeze / Unfreeze ──

router.post('/admin/customers/:tenantId/freeze', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/accounts/acct_${req.params.tenantId}/freeze`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/customers/:tenantId/unfreeze', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/accounts/acct_${req.params.tenantId}/unfreeze`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Customer Credit Query (lightweight, shared-secret auth) ──
// Used by customer-facing web page to show balance without admin login

router.get('/public/credit/:tenantId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env.PUBLIC_QUERY_TOKEN || '小元-balance-check-2026';
    if (token !== expectedToken) {
      res.status(401).json({ code: 'UNAUTHORIZED' });
      return;
    }

    const result = await proxyToLedger(`/v1/admin/customers/${req.params.tenantId}`);
    if (result.status === 404) {
      res.status(404).json({ code: 'NOT_FOUND', message: '租户不存在' });
      return;
    }

    // Return a slimmed-down version for customer display
    const d = result.body;
    res.json({
      companyName: d.companyName,
      availableBalance: d.availableBalance,
      balance: d.balance,
      frozenCredits: d.frozenCredits,
      frozenReason: d.frozenReason,
      lifetimeConsumed: d.lifetimeConsumed,
      planTier: d.planTier,
      planName: d.planName,
      status: d.status,
      subscriptionEnd: d.subscriptionEnd,
      liveConsumed: d.liveConsumed,
      shadowConsumed: d.shadowConsumed,
    });
  } catch (err) {
    res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' });
  }
});

// GET /api/orders
router.get('/orders', async (req, res) => {
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

// ── Admin Auth ──

router.post('/admin/auth/login', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.get('/admin/auth/me', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/auth/me', { authReq: req });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Admin Users ──

router.get('/admin/users', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/users', { authReq: req });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/users', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify(req.body),
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/users/:userId/token/deactivate', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/users/${req.params.userId}/token/deactivate`, {
      method: 'POST',
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/users/:userId/token/activate', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/users/${req.params.userId}/token/activate`, {
      method: 'POST',
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Admin Skills ──

router.post('/admin/skills/sync', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/skills/sync', {
      method: 'POST',
      body: JSON.stringify(req.body),
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/skills/:skillId/activate', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/skills/${req.params.skillId}/activate`, {
      method: 'POST',
      body: JSON.stringify(req.body),
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/skills/:skillId/launch', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/skills/${req.params.skillId}/launch`, {
      method: 'POST',
      body: JSON.stringify(req.body),
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.post('/admin/skills/:skillId/reject', async (req, res) => {
  try {
    const result = await proxyToLedger(`/v1/admin/skills/${req.params.skillId}/reject`, {
      method: 'POST',
      body: JSON.stringify(req.body),
      authReq: req,
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.get('/admin/skills/pending', async (req, res) => {
  try {
    const result = await proxyToLedger('/v1/admin/skills/pending', { authReq: req });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.get('/admin/skills', async (req, res) => {
  try {
    const query = new URLSearchParams(req.query as Record<string,string>).toString();
    const result = await proxyToLedger(`/v1/admin/skills${query ? '?' + query : ''}`, { authReq: req });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

// ── Runtime Config (per-tenant configuration management) ──

router.get('/admin/runtime-configs/presets', async (_req, res) => {
  try {
    const result = await proxyToProvisioning('/v1/admin/runtime-configs/presets');
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.get('/admin/runtime-configs', async (req, res) => {
  try {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    const result = await proxyToProvisioning(
      `/v1/admin/runtime-configs${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`,
    );
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.put('/admin/runtime-configs', async (req, res) => {
  try {
    const result = await proxyToProvisioning('/v1/admin/runtime-configs', {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

router.delete('/admin/runtime-configs/:key', async (req, res) => {
  try {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    const result = await proxyToProvisioning(
      `/v1/admin/runtime-configs/${encodeURIComponent(req.params.key)}${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`,
      { method: 'DELETE' },
    );
    res.status(result.status).json(result.body);
  } catch (err) { res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE' }); }
});

export default router;
