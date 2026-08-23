import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pg from 'pg';
import { createTenantRoutes } from './routes/tenants.js';
import { createRuntimeConfigRoutes } from './routes/runtime-configs.js';
import { createAdminOpsRoutes } from './routes/admin-ops.js';
import { createFeishuAppScanRoutes } from './routes/feishu-app-scan.js';
import type { ProvisioningConfig } from './config.js';
import { createServiceOrAdminAuthMiddleware } from './middleware/auth.js';

export function createApp(pool: pg.Pool, config: ProvisioningConfig) {
  const app = express();

  app.use(helmet());
  // NB2/NB8 FIX: restrict CORS to known origins
  app.use(cors({
    origin: process.env.CORS_ORIGIN || false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }));
  app.use(express.json({ limit: '1mb' }));

  // Health check (no auth)
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'provisioning-service', version: '0.1.0' });
  });

  // NB2 FIX: Add Bearer token auth to all tenant routes.
  // Accepts the shared service token (internal callers) OR a valid admin
  // JWT (pure-frontend admin SPA calling directly, no proxy in front).
  const auth = createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN');
  app.use(createTenantRoutes(pool, config, auth));
  app.use(createRuntimeConfigRoutes(pool, auth));
  app.use(createAdminOpsRoutes(pool, config, auth));
  // Feishu app QR-scan (registerApp device flow) — credentials-only,
  // feeds the customer-creation / feishu-binding forms in the admin SPA.
  app.use(createFeishuAppScanRoutes(auth));

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  return app;
}
