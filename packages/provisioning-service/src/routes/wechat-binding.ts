/**
 * WeChat binding routes (admin console).
 *
 *   GET    /v1/admin/tenants/:tenantId/wechat-binding              → binding status
 *   POST   /v1/admin/tenants/:tenantId/wechat-binding/start       → start QR login
 *   GET    /v1/admin/tenants/:tenantId/wechat-binding/status/:sid  → poll login status
 *   POST   /v1/admin/tenants/:tenantId/wechat-binding/cancel       → cancel login
 *   POST   /v1/admin/tenants/:tenantId/wechat-binding/unbind       → unbind
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import {
  getTenantWeChatBinding,
  startWeChatLogin,
  getWeChatLoginStatus,
  cancelWeChatLogin,
  unbindTenantWeChat,
  WeChatBindingError,
} from '../services/wechat-binding.js';

export function createWeChatBindingRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  // GET /v1/admin/tenants/:tenantId/wechat-binding
  router.get('/v1/admin/tenants/:tenantId/wechat-binding', async (req: Request, res: Response) => {
    try {
      const info = await getTenantWeChatBinding(pool, req.params.tenantId);
      res.json({ ok: true, ...info });
    } catch (err: unknown) {
      if (err instanceof WeChatBindingError || err instanceof Error) {
        const e = err as any;
        res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
      } else {
        res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
      }
    }
  });

  // POST /v1/admin/tenants/:tenantId/wechat-binding/start
  router.post('/v1/admin/tenants/:tenantId/wechat-binding/start', async (req: Request, res: Response) => {
    try {
      const result = await startWeChatLogin(pool, config, req.params.tenantId);
      res.status(202).json({ ok: true, ...result });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  // GET /v1/admin/tenants/:tenantId/wechat-binding/status/:sessionId
  router.get('/v1/admin/tenants/:tenantId/wechat-binding/status/:sessionId', async (req: Request, res: Response) => {
    try {
      const result = await getWeChatLoginStatus(pool, config, req.params.tenantId, req.params.sessionId);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  // POST /v1/admin/tenants/:tenantId/wechat-binding/cancel
  router.post('/v1/admin/tenants/:tenantId/wechat-binding/cancel', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'sessionId is required' });
        return;
      }
      await cancelWeChatLogin(pool, config, req.params.tenantId, sessionId);
      res.json({ ok: true });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  // POST /v1/admin/tenants/:tenantId/wechat-binding/unbind
  router.post('/v1/admin/tenants/:tenantId/wechat-binding/unbind', async (req: Request, res: Response) => {
    try {
      const result = await unbindTenantWeChat(pool, config, req.params.tenantId);
      res.json({ ok: true, restarted: result.restarted });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  return router;
}
