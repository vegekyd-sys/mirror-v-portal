import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import {
  PRESET_RUNTIME_KEYS,
  upsertRuntimeConfig,
  deleteRuntimeConfig,
  listRuntimeConfigs,
  validateConfigKey,
} from '../services/runtime-config.js';
import { getMasterKey, MasterKeyError } from '../services/crypto.js';

/**
 * Admin API for per-tenant runtime configuration.
 *
 * Mounted with the same Bearer-token auth as the tenant routes
 * (PROVISIONING_API_TOKEN); admin-dashboard proxies these endpoints.
 *
 * Scope semantics: tenantId omitted/null → global defaults; tenantId set →
 * per-tenant override. Resolution at provisioning time merges the two,
 * tenant rows winning.
 */
export function createRuntimeConfigRoutes(
  pool: pg.Pool,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();

  if (authMiddleware) {
    router.use(authMiddleware);
  }

  function masterKeyAvailable(): boolean {
    try {
      return getMasterKey() !== null;
    } catch {
      return false;
    }
  }

  async function tenantExists(tenantId: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [tenantId]);
    return rows.length > 0;
  }

  // GET /v1/admin/runtime-configs/presets — known keys for UI hints
  router.get('/v1/admin/runtime-configs/presets', (_req: Request, res: Response) => {
    res.json({ presets: PRESET_RUNTIME_KEYS });
  });

  // GET /v1/admin/runtime-configs?tenantId=<id> — list one scope (masked values)
  router.get('/v1/admin/runtime-configs', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;
      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const items = await listRuntimeConfigs(pool, tenantId, masterKeyAvailable());
      res.json({ items, tenantId, keyConfigured: masterKeyAvailable() });
    } catch (err) {
      console.error('listRuntimeConfigs failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PUT /v1/admin/runtime-configs — upsert one entry in the given scope
  router.put('/v1/admin/runtime-configs', async (req: Request, res: Response) => {
    try {
      const { tenantId, key, value, isSecret, description } = req.body ?? {};
      const scope = typeof tenantId === 'string' && tenantId ? tenantId : null;

      if (scope && !(await tenantExists(scope))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (typeof isSecret !== 'undefined' && typeof isSecret !== 'boolean') {
        res.status(400).json({ code: 'VALIDATION', message: 'isSecret must be boolean' });
        return;
      }
      if (typeof description !== 'undefined' && typeof description !== 'string') {
        res.status(400).json({ code: 'VALIDATION', message: 'description must be string' });
        return;
      }

      await upsertRuntimeConfig(pool, { tenantId: scope, key, value, isSecret, description });
      res.json({ ok: true, key, tenantId: scope });
    } catch (err) {
      if (err instanceof MasterKeyError) {
        res.status(503).json({ code: 'RUNTIME_CONFIG_KEY_NOT_CONFIGURED', message: err.message });
        return;
      }
      if (err instanceof Error && (err.message.startsWith('Invalid config key') || err.message.startsWith('Config value'))) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('upsertRuntimeConfig failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // DELETE /v1/admin/runtime-configs/:key?tenantId=<id> — delete one scope entry
  router.delete('/v1/admin/runtime-configs/:key', async (req: Request, res: Response) => {
    try {
      const key = validateConfigKey(req.params.key);
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;

      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const deleted = await deleteRuntimeConfig(pool, tenantId, key);
      if (deleted === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Config entry not found in this scope' });
        return;
      }
      res.json({ ok: true, key, tenantId });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid config key')) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('deleteRuntimeConfig failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
