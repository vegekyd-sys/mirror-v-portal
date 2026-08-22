import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import apiRouter from './routes/api.js';
import { requireAdmin } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(dbUrl?: string) {
  if (dbUrl) process.env.DATABASE_URL = dbUrl;

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // ── Strip /admin prefix if nginx/ALB didn't already strip it ──
  // Some deployments (e.g. 43.156.232.2 nginx) pass /admin/* without
  // stripping; ALB Ingress (dealclaw-test) already strips it.
  // This middleware is idempotent: if /admin was already stripped, it's a no-op.
  app.use((req, _res, next) => {
    if (req.path.startsWith('/admin')) {
      req.url = req.url.replace(/^\/admin/, '') || '/';
    }
    next();
  });

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
  // NOTE: the /admin prefix stripping middleware above rewrites /admin/* to /*
  // before routing, so these pages must be registered at their stripped paths.
  // Browsers still link to /admin/skills etc.; both prefixed and stripped
  // requests end up here.
  app.get('/skills', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'admin-skills.html'));
  });

  app.get('/runtime-configs', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'admin-runtime-configs.html'));
  });

  app.get('/tenants', requireAdmin, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'admin-tenants.html'));
  });

  // ── Protected API routes (auth bypass for login + public endpoints) ──
  app.use('/api', (req, res, next) => {
    // Skip auth for login, public credit queries, and health
    if (req.path === '/admin/auth/login' || req.path.startsWith('/public/') || req.path === '/health') {
      return next();
    }
    return requireAdmin(req, res, next);
  }, apiRouter);

  // ── Static frontend (assets, og.png, etc.) ──
  app.use(express.static(join(__dirname, '..', 'public')));

  // ── SPA catch-all — serve the React SPA; it handles auth client-side ──
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}
