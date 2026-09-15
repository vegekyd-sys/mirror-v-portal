/**
 * DingTalk (钉钉) bot binding routes (admin console).
 *
 *   GET    /v1/admin/tenants/:tenantId/dingtalk-binding         → binding status
 *   POST   /v1/admin/tenants/:tenantId/dingtalk-binding/bind    → bind (credential-based)
 *   POST   /v1/admin/tenants/:tenantId/dingtalk-binding/unbind  → unbind
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import {
  getTenantDingTalkBinding,
  bindTenantDingTalk,
  unbindTenantDingTalk,
  DingTalkBindingError,
} from '../services/dingtalk-binding.js';

export function createDingTalkBindingRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  // GET /v1/admin/tenants/:tenantId/dingtalk-binding
  router.get('/v1/admin/tenants/:tenantId/dingtalk-binding', async (req: Request, res: Response) => {
    try {
      const info = await getTenantDingTalkBinding(pool, req.params.tenantId);
      res.json({ ok: true, ...info });
    } catch (err: unknown) {
      if (err instanceof DingTalkBindingError || err instanceof Error) {
        const e = err as any;
        res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
      } else {
        res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
      }
    }
  });

  // POST /v1/admin/tenants/:tenantId/dingtalk-binding/bind
  router.post('/v1/admin/tenants/:tenantId/dingtalk-binding/bind', async (req: Request, res: Response) => {
    try {
      const { clientId, clientSecret } = req.body || {};
      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'clientId and clientSecret are required' });
        return;
      }
      const result = await bindTenantDingTalk(pool, config, req.params.tenantId, { clientId, clientSecret });
      res.status(202).json(result);
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  // POST /v1/admin/tenants/:tenantId/dingtalk-binding/unbind
  router.post('/v1/admin/tenants/:tenantId/dingtalk-binding/unbind', async (req: Request, res: Response) => {
    try {
      const result = await unbindTenantDingTalk(pool, config, req.params.tenantId);
      res.json({ ok: true, restarted: result.restarted });
    } catch (err: unknown) {
      const e = err as any;
      res.status(e.status || 500).json({ code: e.code || 'INTERNAL', message: e.message });
    }
  });

  return router;
}
