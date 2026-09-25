import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { query } from './db/pool.js';
import accountsRouter from './routes/accounts.js';
import skillPricesRouter from './routes/skill-prices.js';
import billingRouter from './routes/billing.js';
import llmUsageRouter from './routes/llm-usage.js';
import customerAdminRouter from './routes/customer-admin.js';
import adminAuthRouter, { requireAdmin, requireServiceOrAdmin } from './routes/admin-auth.js';
import adminSkillsRouter from './routes/admin-skills.js';
import llmPricingRouter from './routes/llm-pricing.js';
import elasticAdminRouter from './routes/elastic-admin.js';
import { runMonthlyReset } from './services/monthly-reset.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '1mb' }));

  // B8 FIX: health check verifies database connectivity
  app.get('/healthz', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, service: 'credits-ledger' });
    } catch (err) {
      console.error('Health check failed:', err);
      res.status(503).json({ ok: false, service: 'credits-ledger', message: 'Database unavailable' });
    }
  });

  // ── Auth routes — MUST be mounted before the requireServiceOrAdmin layers ──
  // Express runs middleware in registration order; if the service/admin auth
  // layers sit above this router, anonymous POST /v1/admin/auth/login is
  // rejected before it can ever reach the login handler (chicken-and-egg:
  // you would need a JWT to obtain a JWT). The router's other routes
  // (/v1/admin/auth/me, user management) carry their own requireAdmin.
  app.use(adminAuthRouter);

  // ── Billing / accounts / skill-prices ──
  // Internal service calls authenticate with a shared service token
  // (BILLING_SERVICE_TOKEN / PAYMENT_SERVICE_TOKEN); admin dashboard
  // proxies with a valid JWT. Unauthenticated callers are rejected.
  app.use(requireServiceOrAdmin, accountsRouter);
  app.use(requireServiceOrAdmin, skillPricesRouter);
  app.use(requireServiceOrAdmin, billingRouter);
  app.use(requireServiceOrAdmin, llmUsageRouter);
  app.use(requireServiceOrAdmin, llmPricingRouter);

  // ── Customer admin (topup/renew/create-customer/v-command/plans/customers) ──
  // Money-creation + account-management endpoints: service token or admin JWT.
  app.use(requireServiceOrAdmin, customerAdminRouter);

  // Monthly reset — internal ops-agent / admin (service token or admin JWT)
  app.post('/v1/admin/monthly-reset', requireServiceOrAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await runMonthlyReset();
      res.json({
        ok: true,
        ...result,
        message: `${result.resetAccounts} account(s) reset, ${result.skippedAccounts} skipped`,
      });
    } catch (err: any) {
      console.error('Monthly reset failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Reset failed' });
    }
  });

  app.get('/v1/admin/monthly-reset/status', requireServiceOrAdmin, async (_req: Request, res: Response) => {
    try {
      const { rows } = await query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE month_reset_at < NOW()) as overdue
         FROM credits_accounts WHERE status = 'active'`
      );
      res.json({
        activeAccounts: Number(rows[0].total),
        overdueReset: Number(rows[0].overdue),
      });
    } catch (err) {
      console.error('Reset status check failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Status check failed' });
    }
  });

  // ── Admin-only routes (JWT protected) ──
  app.use('/v1/admin/elastic', requireAdmin, elasticAdminRouter);
  app.use('/v1/admin', requireAdmin, adminSkillsRouter);

  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  // B8 FIX: global error handler — catches unhandled exceptions in middleware chain
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  });

  return app;
}
