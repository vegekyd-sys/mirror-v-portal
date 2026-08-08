import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import pg from 'pg';
import { scanTenants, shouldResetMonthly, getNotificationsForToday } from './services/scheduler.js';
import { computeTransition, type TenantState } from './services/state-machine.js';
import { runCronCycle } from './services/cron.js';
import type { OpsConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';

export function createApp(pool: pg.Pool, config: OpsConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // NB4 FIX: Protect all operations endpoints with Bearer token auth
  const auth = createAuthMiddleware('OPS_API_TOKEN');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'ops-agent' });
  });

  /**
   * POST /v1/ops/scan
   */
  app.post('/v1/ops/scan', auth, (req, res) => {
    try {
      const tenants: TenantState[] = req.body?.tenants || [];
      const result = scanTenants(tenants);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err.message });
    }
  });

  /**
   * POST /v1/ops/check
   * Check a single tenant's next action.
   */
  app.post('/v1/ops/check', auth, (req, res) => {
    try {
      const tenant: TenantState = req.body;
      if (!tenant || !tenant.id) {
        res.status(400).json({ code: 'VALIDATION', message: 'Missing tenant state' });
        return;
      }
      const transition = computeTransition(tenant);
      res.json({ tenant: tenant.id, transition });
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err.message });
    }
  });

  /**
   * POST /v1/ops/cron — manual cron trigger (M1: replaces scheduled task)
   * Queries provisioning DB for active tenants, enriches with credits balances,
   * computes transitions, and executes actions.
   */
  app.post('/v1/ops/cron', auth, async (_req, res) => {
    try {
      const result = await runCronCycle(pool, config);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err.message });
    }
  });

  /**
   * GET /v1/ops/status — cron scheduler status
   */
  app.get('/v1/ops/status', (_req, res) => {
    res.json({
      service: 'ops-agent',
      cronIntervalMinutes: config.cronIntervalMinutes,
      creditsLedgerUrl: config.creditsLedgerUrl,
    });
  });

  return app;
}
