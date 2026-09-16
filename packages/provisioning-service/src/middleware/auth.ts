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
 * Shared token validation used by both the Express middleware and the
 * WebSocket upgrade path (pod exec terminal — a browser WS cannot attach
 * custom Authorization headers, so the client sends its token as the first
 * WS message and this function validates it with the same rules).
 */
export function isValidServiceOrAdminToken(token: string | undefined, envVar: string): boolean {
  if (!token) return false;
  const expectedToken = process.env[envVar];
  if (expectedToken && token === expectedToken) return true;
  return verifyAdminJwt(token) !== null;
}

/**
 * Service-token OR admin-JWT auth. Internal services (ops-agent, billing
 * hooks) keep using the shared static token; the pure-frontend admin SPA
 * authenticates with the JWT issued by credits-ledger login, so this
 * service no longer needs a proxy in front of it.
 */
export function createServiceOrAdminAuthMiddleware(envVar: string) {  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    const expectedToken = process.env[envVar];
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

// ── 超管（super admin）门禁 ────────────────────────────────────────────────

/**
 * 视为「超管」的角色。admin_users.role 目前只存在 admin / operator：
 * 超管 = admin，operator（运维/只读同类角色）不具全局默认配置的写权限。
 * 后续若引入更细粒度角色（FDE / CSM），把角色名加进来即可。
 */
export const SUPER_ADMIN_ROLES = ['admin'];
export const SUPER_ADMIN_DENIED_MESSAGE =
  '仅超管可操作全局默认配置（服务令牌与其他角色无权限）';

/**
 * 超管门禁：必须挂在 authMiddleware（createServiceOrAdminAuthMiddleware）之后，
 * 因为只有 admin JWT 路径会填 req.adminUser。
 *   - 无 req.adminUser（服务令牌/未知凭据）→ 403；
 *   - role 不在允许列表（如 operator）→ 403。
 * 403 而不是 401：凭据本身有效，只是权限不足。
 */
export function createSuperAdminMiddleware(roles: string[] = SUPER_ADMIN_ROLES) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).adminUser as { role?: string; username?: string; sub?: string } | undefined;
    if (!user) {
      res.status(403).json({ code: 'FORBIDDEN', message: SUPER_ADMIN_DENIED_MESSAGE });
      return;
    }
    const role = String(user.role ?? '');
    if (!roles.includes(role)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `${SUPER_ADMIN_DENIED_MESSAGE}（当前角色：${role || '未设置'}）`,
      });
      return;
    }
    next();
  };
}
