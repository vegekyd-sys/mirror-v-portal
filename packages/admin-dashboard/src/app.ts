import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import apiRouter from './routes/api.js';
import { createAuthMiddleware } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(dbUrl?: string) {
  if (dbUrl) process.env.DATABASE_URL = dbUrl;

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));

  // Auth middleware — disabled for internal tool
  // const auth = createAuthMiddleware('ADMIN_API_TOKEN');

  // API routes (no auth — internal tool, URL not public)
  app.use(apiRouter);

  // Static frontend (assets, og.png, etc.)
  app.use(express.static(join(__dirname, '..', 'public')));

  // SPA catch-all — single index.html handles all client-side routing
  // (login, dashboard, customer detail, skill prices, packages)
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}
