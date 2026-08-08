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

  // NB3 FIX: Protect all /api/* routes with Bearer token auth
  const auth = createAuthMiddleware('ADMIN_API_TOKEN');
  app.use('/api', auth);

  // API routes
  app.use(apiRouter);

  // Static frontend
  app.use(express.static(join(__dirname, '..', 'public')));

  // SPA fallback — serve login.html as entry point, dashboard as main app
  app.get('/login', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'login.html'));
  });

  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}
