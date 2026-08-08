import type { Request, Response, NextFunction } from 'express';

/**
 * NB4 FIX: Bearer token auth middleware for ops-agent.
 * Protects destructive endpoints (cron, scan, check).
 */
export function createAuthMiddleware(envVar: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env[envVar];

    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (!expectedToken) {
      console.error(`${envVar} is not configured`);
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
