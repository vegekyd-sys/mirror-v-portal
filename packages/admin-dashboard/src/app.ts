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

  // Single-page app — login + dashboard in one file
  app.get('/standalone', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'standalone.html'));
  });

  // Login page — default entry
  app.get('/login', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'login.html'));
  });

  // Dashboard — after login
  app.get('/app', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  // Default: show login page
  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'login.html'));
  });

  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'login.html'));
  });

  return app;
}
