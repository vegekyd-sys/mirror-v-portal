/**
 * WeCom (企业微信) bot binding routes (admin console).
 *
 *   GET    /v1/admin/tenants/:tenantId/wecom-binding         → binding status
 *   POST   /v1/admin/tenants/:tenantId/wecom-binding/bind    → bind (credential-based)
 *   POST   /v1/admin/tenants/:tenantId/wecom-binding/unbind  → unbind
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import {
  getTenantWeComBinding,
  bindTenantWeCom,
  unbindTenantWeCom,
  WeComBindingError,
} from '../services/wecom-binding.js';

export function createWeComBindingRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  // GET /v1/admin/tenants/:tenantId/wecom-binding
  router.get('/v1/admin/tenants/:tenantId/wecom-binding', async (req: Request, res: Response) => {
    try {
      const info = await getTenantWeComBinding(pool, req.params.tenantId);
      res.json({ ok: true, ...info });
    } catch (err: unknown) {
      if (err instanceof WeComBindingError || err instanceof Error) {
        const e = err as any;
        res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
      } else {
        res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
      }
    }
  });

  // POST /v1/admin/tenants/:tenantId/wecom-binding/bind
  router.post('/v1/admin/tenants/:tenantId/wecom-binding/bind', async (req: Request, res: Response) => {
    try {
      const { botId, secret } = req.body || {};
      if (typeof botId !== 'string' || typeof secret !== 'string') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'botId and secret are required' });
        return;
      }
      const result = await bindTenantWeCom(pool, config, req.params.tenantId, { botId, secret });
      res.status(202).json(result);
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  // POST /v1/admin/tenants/:tenantId/wecom-binding/unbind
  router.post('/v1/admin/tenants/:tenantId/wecom-binding/unbind', async (req: Request, res: Response) => {
    try {
      const result = await unbindTenantWeCom(pool, config, req.params.tenantId);
      res.json({ ok: true, restarted: result.restarted });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  return router;
}
