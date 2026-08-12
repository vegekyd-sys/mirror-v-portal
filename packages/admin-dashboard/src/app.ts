import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import apiRouter from './routes/api.js';
import { requireAdmin, optionalAuth } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(dbUrl?: string) {
  if (dbUrl) process.env.DATABASE_URL = dbUrl;

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // ── Health check (no auth) ──
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // ── Auth endpoints (no auth required) ──
  // Login page
  app.get('/login', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'login.html'));
  });

  // ── Protected HTML pages ──
  app.get('/admin/skills', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'admin-skills.html'));
  });

  // ── Protected API routes ──
  app.use('/api', requireAdmin, apiRouter);

  // ── Static frontend (assets, og.png, etc.) ──
  app.use(express.static(join(__dirname, '..', 'public')));

  // ── SPA catch-all — require auth, redirect to login if not ──
  app.get('*', optionalAuth, (req, res) => {
    const user = (req as any).adminUser;
    if (!user) {
      // Not logged in → redirect to login page
      res.redirect('/login');
      return;
    }

    // Logged in → serve SPA
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}
