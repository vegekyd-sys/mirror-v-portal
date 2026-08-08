import type { Request, Response, NextFunction } from 'express';

/**
 * Shared Bearer token auth middleware.
 * Used by provisioning-service, ops-agent, admin-dashboard, and central-gateway.
 * 
 * NB2/NB3/NB4/NB8 FIX: Adds token-based auth to services that previously had none.
 * 
 * Unconfigured token → 503 (secure by default, like credits-ledger credit endpoint).
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
