import type { Request, Response, NextFunction } from 'express';

/**
 * NB3 FIX: Bearer token auth middleware for admin-dashboard API.
 */
import { readFileSync, existsSync } from 'node:fs';

function getAdminToken(): string {
  // Try file first, then env var
  const tokenFile = process.env.ADMIN_TOKEN_FILE || '/tmp/dealclaw-admin-token';
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf-8').trim();
  }
  return process.env.ADMIN_API_TOKEN || '';
}

export function createAuthMiddleware(envVar: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = getAdminToken();

    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (!expectedToken) {
      console.error('Admin token not configured');
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Auth token not configured' });
      return;
    }
    if (token !== expectedToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
      return;
    }
    next();
  };
}
