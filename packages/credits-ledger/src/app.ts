import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { query } from './db/pool.js';
import accountsRouter from './routes/accounts.js';
import skillPricesRouter from './routes/skill-prices.js';
import billingRouter from './routes/billing.js';
import customerAdminRouter from './routes/customer-admin.js';
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

  // Admin endpoint: trigger monthly usage reset
  app.post('/v1/admin/monthly-reset', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env.ADMIN_API_TOKEN;

    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (!expectedToken) {
      console.error('ADMIN_API_TOKEN is not configured');
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' });
      return;
    }
    if (token !== expectedToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid admin token' });
      return;
    }

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

  app.get('/v1/admin/monthly-reset/status', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env.ADMIN_API_TOKEN;
    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (!expectedToken) {
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' });
      return;
    }
    if (token !== expectedToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid admin token' });
      return;
    }

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

  app.use(accountsRouter);
  app.use(skillPricesRouter);
  app.use(billingRouter);
  app.use(customerAdminRouter);

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
