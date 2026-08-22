import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared Bearer token auth middleware.
 * Used by provisioning-service, ops-agent, and central-gateway.
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

/**
 * Admin JWT verification.
 * KEEP IN SYNC with credits-ledger services/admin-auth.ts verifyJwt() —
 * same HS256 + base64url HMAC scheme, secret = ADMIN_JWT_SECRET (copied per
 * service because Docker images build each package standalone with npm).
 */
export function verifyAdminJwt(token: string): Record<string, unknown> | null {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const toVerify = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac('sha256', secret).update(toVerify).digest('base64url');

    if (!timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig))) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Service-token OR admin-JWT auth. Internal services (ops-agent, billing
 * hooks) keep using the shared static token; the pure-frontend admin SPA
 * authenticates with the JWT issued by credits-ledger login, so this
 * service no longer needs a proxy in front of it.
 */
export function createServiceOrAdminAuthMiddleware(envVar: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env[envVar];

    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (expectedToken && token === expectedToken) {
      next();
      return;
    }
    const adminPayload = verifyAdminJwt(token);
    if (adminPayload) {
      (req as any).adminUser = adminPayload;
      next();
      return;
    }
    if (!expectedToken && !process.env.ADMIN_JWT_SECRET) {
      console.error(`${envVar} and ADMIN_JWT_SECRET are both not configured`);
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Auth not configured' });
      return;
    }
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  };
}
