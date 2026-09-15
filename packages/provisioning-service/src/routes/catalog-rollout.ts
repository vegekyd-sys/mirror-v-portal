/**
 * Catalog Rollout admin routes — impact preview + scoped rollout + status.
 *
 *   GET  /v1/admin/model-catalog/rollout/impact-preview
 *        Preview which tenants would be affected by a snapshot publish.
 *        Read-only (modelCatalogRead flag).
 *
 *   POST /v1/admin/model-catalog/rollout
 *        Enqueue a scoped rollout after a Release has been published.
 *        Write (modelCatalogSnapshotWrite flag).
 *
 *   GET  /v1/admin/model-catalog/rollout/status
 *        Query per-tenant release delivery status.
 *        Read-only (modelCatalogRead flag).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest } from '../services/audit.js';
import { CatalogRepository, CatalogService } from '../services/model-catalog.js';
import { CatalogRolloutService, type ScopeType } from '../services/catalog-rollout-service.js';
import { getGlobalLlmProviders } from '../services/llm-providers.js';

function disabled(res: Response): void {
  res.status(503).json({ code: 'DISABLED', message: 'Model catalog feature is disabled' });
}

function internalError(res: Response, code = 'INTERNAL', status = 500): void {
  res.status(status).json({ code, message: 'Catalog rollout request failed' });
}

/** Admin routes for catalog rollout preview and scoped execution. */
export function createCatalogRolloutRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  const repository = new CatalogRepository(pool);
  const catalogService = new CatalogService(repository);
  const rolloutService = new CatalogRolloutService(pool);

  // ── GET /v1/admin/model-catalog/rollout/impact-preview ──
  // Computes the impact manifest WITHOUT publishing: diffs the current runtime
  // library against a fresh compatibility snapshot built from the catalog.
  router.get('/v1/admin/model-catalog/rollout/impact-preview', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const prev = await getGlobalLlmProviders(pool);
      const next = await catalogService.buildCompatibilitySnapshot(prev);
      const manifest = await rolloutService.computeImpactManifest(prev, next, null);
      res.json(manifest);
    } catch (error) {
      console.error('catalog rollout impact-preview failed:', error);
      internalError(res, 'IMPACT_PREVIEW_FAILED', 422);
    }
  });

  // ── POST /v1/admin/model-catalog/rollout ──
  // Enqueue a scoped rollout linked to a published Release.
  router.post('/v1/admin/model-catalog/rollout', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);

    const releaseId = typeof req.body?.releaseId === 'string' ? req.body.releaseId : '';
    const scopeType = req.body?.scopeType as ScopeType | undefined;
    const tenantIds = Array.isArray(req.body?.tenantIds) ? req.body.tenantIds : undefined;
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined;

    if (!releaseId) {
      res.status(400).json({ code: 'VALIDATION', message: 'releaseId is required' });
      return;
    }
    const validScopes: ScopeType[] = ['full', 'allowlist', 'single', 'affected', 'canary'];
    if (!scopeType || !validScopes.includes(scopeType)) {
      res.status(400).json({ code: 'VALIDATION', message: `scopeType must be one of: ${validScopes.join(', ')}` });
      return;
    }
    if ((scopeType === 'single' || scopeType === 'allowlist' || scopeType === 'canary') &&
        (!tenantIds || tenantIds.length === 0 || tenantIds.some((t: unknown) => typeof t !== 'string'))) {
      res.status(400).json({ code: 'VALIDATION', message: `scopeType=${scopeType} requires a non-empty tenantIds string array` });
      return;
    }

    try {
      const { actor, actorType } = actorFromRequest(req);
      const result = await rolloutService.enqueueScopedRollout({
        releaseId,
        scopeType,
        tenantIds: tenantIds as string[] | undefined,
        actor,
        actorType: actorType === 'external' ? 'service' : actorType,
        idempotencyKey,
      });
      res.json({
        ...result,
        streamUrl: `/v1/admin/llm-push-tasks/${result.taskId}/stream`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('catalog rollout enqueue failed:', error);
      if (message.includes('not found') || message.includes('not active')) {
        internalError(res, 'RELEASE_NOT_FOUND', 404);
        return;
      }
      if (message.includes('requires')) {
        res.status(400).json({ code: 'VALIDATION', message });
        return;
      }
      internalError(res);
    }
  });

  // ── GET /v1/admin/model-catalog/rollout/status ──
  // Query per-tenant release delivery status, optionally filtered by releaseId.
  router.get('/v1/admin/model-catalog/rollout/status', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    const releaseId = typeof req.query.releaseId === 'string' ? req.query.releaseId : undefined;
    try {
      const statuses = await rolloutService.listTenantReleaseStatus(releaseId);
      res.json({ statuses, total: statuses.length });
    } catch (error) {
      console.error('catalog rollout status query failed:', error);
      internalError(res);
    }
  });

  return router;
}
