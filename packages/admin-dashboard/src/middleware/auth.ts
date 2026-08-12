/**
 * JWT Auth middleware for admin-dashboard.
 *
 * Verifies JWT from Authorization: Bearer header or auth_token cookie.
 * Proxies verification to credits-ledger's /v1/admin/auth/me endpoint
 * OR verifies locally using the same HMAC-SHA256 secret.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const CREDITS_LEDGER_URL = process.env.CREDITS_LEDGER_URL || 'http://localhost:8081';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'changeme-in-production';

interface JwtPayload {
  sub: string;
  username: string;
  displayName: string;
  role: string;
  iat: number;
  exp: number;
}

/** Get token from header or cookie */
function extractToken(req: Request): string | null {
  // Prefer Authorization header
  const header = req.headers.authorization?.replace('Bearer ', '');
  if (header) return header;

  // Fall back to cookie
  const cookieToken = req.cookies?.auth_token;
  if (cookieToken) return cookieToken;

  return null;
}

/** Local JWT verification (same algorithm as credits-ledger) */
function verifyJwtLocal(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const toVerify = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac('sha256', JWT_SECRET).update(toVerify).digest('base64url');

    if (!timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig))) return null;

    const payload: JwtPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Remote JWT verification (via credits-ledger) */
async function verifyJwtRemote(token: string): Promise<JwtPayload | null> {
  try {
    const res = await fetch(`${CREDITS_LEDGER_URL}/v1/admin/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user ?? null;
  } catch (err) {
    console.error('[auth] Remote verification failed:', err);
    return null;
  }
}

/** Admin auth middleware */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
    return;
  }

  // Try local verification first (faster, no network call)
  const localPayload = verifyJwtLocal(token);
  if (localPayload) {
    (req as any).adminUser = localPayload;
    next();
    return;
  }

  // Fall back to remote verification
  verifyJwtRemote(token).then((remotePayload) => {
    if (remotePayload) {
      (req as any).adminUser = remotePayload;
      next();
    } else {
      res.status(401).json({ code: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
    }
  }).catch(() => {
    res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Auth service unavailable' });
  });
}

/** Optional auth — attaches user if authenticated, but doesn't reject */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    const payload = verifyJwtLocal(token);
    if (payload) {
      (req as any).adminUser = payload;
    }
  }
  next();
}
