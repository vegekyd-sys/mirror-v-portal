/**
 * Admin Auth Routes — login, user management, JWT middleware.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  login,
  verifyJwt,
  createAdminUser,
  listAdminUsers,
  regenerateToken,
  deactivateUser,
  activateUser,
} from '../services/admin-auth.js';

const router = Router();

// ── JWT Auth Middleware ──

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: '请先登录' });
    return;
  }

  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
    return;
  }

  // Attach user info to request for downstream handlers
  (req as any).adminUser = payload;
  next();
}

// ── Service-token middleware ──
// Internal service-to-service calls (billing hook, agent billing CLI, etc.)
// authenticate with a shared service token (BILLING_SERVICE_TOKEN).
// `requireServiceOrAdmin` also accepts a valid admin JWT, so the admin
// dashboard can keep proxying with its JWT.
export function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
  const expected = process.env.BILLING_SERVICE_TOKEN ?? process.env.PAYMENT_SERVICE_TOKEN;
  if (!expected) {
    res.status(503).json({ code: 'NOT_CONFIGURED', message: 'BILLING_SERVICE_TOKEN not configured' });
    return;
  }
  if (!token || token !== expected) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid service token' });
    return;
  }
  next();
}

export function requireServiceOrAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
  const serviceToken = process.env.BILLING_SERVICE_TOKEN ?? process.env.PAYMENT_SERVICE_TOKEN;
  // Accept the shared service token (internal callers)
  if (serviceToken && token === serviceToken) return next();
  // Otherwise require a valid admin JWT (admin dashboard proxy)
  return requireAdmin(req, res, next);
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).adminUser;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ code: 'FORBIDDEN', message: '权限不足' });
      return;
    }
    next();
  };
}

// ── POST /v1/admin/auth/login ──
// Body: { token: "login-token" }
// Returns: { jwt: "...", user: {...} }
router.post('/v1/admin/auth/login', async (req: Request, res: Response) => {
  const { token } = req.body ?? {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ code: 'BAD_REQUEST', message: '请输入登录口令' });
    return;
  }

  try {
    const result = await login(token);
    if (!result) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: '口令无效' });
      return;
    }

    res.json({
      ok: true,
      jwt: result.jwt,
      user: result.user,
    });
  } catch (err) {
    console.error('[admin-auth] login error:', err);
    res.status(500).json({ code: 'INTERNAL', message: '登录失败' });
  }
});

// ── GET /v1/admin/auth/me ──
// Verify current JWT and return user info
router.get('/v1/admin/auth/me', requireAdmin, (req: Request, res: Response) => {
  const user = (req as any).adminUser;
  res.json({ ok: true, user });
});

// ── User Management (admin only) ──

// GET /v1/admin/users — list all admin users
router.get('/v1/admin/users', requireAdmin, requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const users = await listAdminUsers();
    res.json({ ok: true, users });
  } catch (err) {
    console.error('[admin-auth] list users error:', err);
    res.status(500).json({ code: 'INTERNAL', message: '查询失败' });
  }
});

// POST /v1/admin/users — create new admin user
router.post('/v1/admin/users', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  const { username, displayName, role } = req.body ?? {};
  if (!username || !displayName) {
    res.status(400).json({ code: 'BAD_REQUEST', message: '用户名和显示名称为必填' });
    return;
  }

  const createdBy = (req as any).adminUser.username;

  try {
    const result = await createAdminUser({ username, displayName, role, createdBy });
    if (!result) {
      res.status(409).json({ code: 'CONFLICT', message: '用户名已存在' });
      return;
    }

    res.json({
      ok: true,
      user: result.user,
      loginToken: result.loginToken, // Show only once — user should copy and store
    });
  } catch (err) {
    console.error('[admin-auth] create user error:', err);
    res.status(500).json({ code: 'INTERNAL', message: '创建失败' });
  }
});

// POST /v1/admin/users/:userId/regenerate-token — regenerate login token
router.post('/v1/admin/users/:userId/regenerate-token', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  const requestedBy = (req as any).adminUser.username;

  try {
    const result = await regenerateToken(req.params.userId, requestedBy);
    if (!result) {
      res.status(404).json({ code: 'NOT_FOUND', message: '用户不存在或已禁用' });
      return;
    }

    res.json({ ok: true, loginToken: result.loginToken });
  } catch (err) {
    console.error('[admin-auth] regenerate token error:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/users/:userId/deactivate
router.post('/v1/admin/users/:userId/deactivate', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const ok = await deactivateUser(req.params.userId);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-auth] deactivate error:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/admin/users/:userId/activate
router.post('/v1/admin/users/:userId/activate', requireAdmin, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const ok = await activateUser(req.params.userId);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-auth] activate error:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
