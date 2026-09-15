import { Router, type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest } from '../services/audit.js';
import { decryptValue } from '../services/crypto.js';
import { importLegacyCatalog } from '../services/model-catalog-import.js';
import {
  ModelParamDiscoveryError,
  ModelParamDiscoveryService,
} from '../services/model-param-discovery.js';
import { CatalogRepository, CatalogService, snapshotFingerprint } from '../services/model-catalog.js';
import { CatalogReleaseService } from '../services/catalog-release-service.js';
import { getGlobalLlmProviders, LLM_PROVIDERS_KEY, validateLlmProviders } from '../services/llm-providers.js';
import { validateConfigValue } from '../services/runtime-config.js';
import type { CatalogReleaseRecord, CatalogReleaseView } from '../domain/catalog-release.js';

function disabled(res: Response): void {
  res.status(503).json({ code: 'DISABLED', message: 'Model catalog feature is disabled' });
}

function internalError(res: Response, code = 'INTERNAL', status = 500): void {
  res.status(status).json({ code, message: 'Model catalog request failed' });
}

function paramWriteDisabled(res: Response): void {
  res.status(403).json({
    code: 'MODEL_CATALOG_PARAM_WRITE_DISABLED',
    message: 'Model catalog parameter writes are disabled',
  });
}

function handleParamError(res: Response, error: unknown): void {
  if (error instanceof ModelParamDiscoveryError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  console.error('model catalog parameter operation failed:', error);
  internalError(res);
}

function redactSnapshot(snapshot: Awaited<ReturnType<CatalogService['buildCompatibilitySnapshot']>>) {
  return {
    ...snapshot,
    providers: snapshot.providers.map(({ apiKey: _apiKey, ...provider }) => ({ ...provider, hasApiKey: true })),
  };
}

/** Convert a CatalogReleaseRecord (with encrypted fields) to a public view. */
function recordToView(record: CatalogReleaseRecord): CatalogReleaseView {
  return {
    id: record.id,
    version: record.version,
    parentId: record.parentId,
    fingerprint: record.fingerprint,
    parentFingerprint: record.parentFingerprint,
    diffSummary: record.diffSummary,
    warnings: record.warnings,
    actor: record.actor,
    actorType: record.actorType,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Admin routes for the P0 shadow catalog and explicit compatibility publishing. */
export function createModelCatalogRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  releaseService?: CatalogReleaseService,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);
  const repository = new CatalogRepository(pool);
  const service = new CatalogService(repository);
  const paramDiscovery = new ModelParamDiscoveryService(pool);
  const releases = releaseService ?? new CatalogReleaseService(pool);

  router.post('/v1/admin/model-catalog/import', async (req, res) => {
    if (config.modelCatalogShadowImport !== true) return disabled(res);
    if (typeof req.body?.dryRun !== 'boolean') {
      res.status(400).json({ code: 'VALIDATION', message: 'dryRun must be boolean' });
      return;
    }
    try {
      const { actor } = actorFromRequest(req);
      res.json(await importLegacyCatalog(pool, { dryRun: req.body.dryRun, actor }));
    } catch (error) {
      console.error('model catalog import failed:', error);
      internalError(res, 'IMPORT_FAILED', 422);
    }
  });

  router.get('/v1/admin/model-catalog/status', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    const requestedLimit = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 10;
    try {
      res.json(await repository.getStatus(limit));
    } catch (error) {
      console.error('model catalog status failed:', error);
      internalError(res);
    }
  });

  router.get('/v1/admin/model-catalog/providers', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    res.json({ providers: await repository.listProviders() });
  });

  router.get('/v1/admin/model-catalog/providers/:id/models', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    res.json({ models: await repository.listModels(req.params.id) });
  });

  router.post('/v1/admin/model-catalog/discovery/preview', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    const providerInstanceId = typeof req.body?.providerInstanceId === 'string' ? req.body.providerInstanceId : '';
    const adapter = req.body?.adapter;
    if (!providerInstanceId || (adapter !== 'provider-api' && adapter !== 'builtin-catalog')) {
      res.status(400).json({ code: 'MODEL_CATALOG_VALIDATION', message: 'providerInstanceId and explicit adapter are required' });
      return;
    }
    try {
      const { actor } = actorFromRequest(req);
      res.json(await paramDiscovery.preview({
        providerInstanceId,
        ...(req.body.modelIds !== undefined ? { modelIds: req.body.modelIds } : {}),
        adapter,
        actor,
      }));
    } catch (error) {
      handleParamError(res, error);
    }
  });

  router.post('/v1/admin/model-catalog/discovery/apply', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    if (typeof req.body?.previewRunId !== 'string' || typeof req.body?.expectedProviderRevision !== 'string') {
      res.status(400).json({ code: 'MODEL_CATALOG_VALIDATION', message: 'previewRunId and expectedProviderRevision are required' });
      return;
    }
    try {
      const { actor } = actorFromRequest(req);
      res.json(await paramDiscovery.apply({
        previewRunId: req.body.previewRunId,
        expectedProviderRevision: req.body.expectedProviderRevision,
        selections: req.body.selections,
        actor,
      }));
    } catch (error) {
      handleParamError(res, error);
    }
  });

  router.patch('/v1/admin/model-catalog/models/:id/override', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const allowed = new Set(['expectedUpdatedAt', 'overrideParams', 'evidence']);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !allowed.has(key))) {
      res.status(400).json({ code: 'MODEL_CATALOG_VALIDATION', message: 'Unknown or forbidden request field' });
      return;
    }
    try {
      const { actor } = actorFromRequest(req);
      res.json(await paramDiscovery.replaceOverride(req.params.id, {
        expectedUpdatedAt: req.body.expectedUpdatedAt,
        overrideParams: req.body.overrideParams,
        evidence: req.body.evidence,
        actor,
      }));
    } catch (error) {
      handleParamError(res, error);
    }
  });

  router.get('/v1/admin/model-catalog/snapshot-preview', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const legacy = await getGlobalLlmProviders(pool);
      const previous = legacy ?? {
        providers: [], defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [],
      };
      const snapshot = await service.buildCompatibilitySnapshot(legacy);
      const diff = service.diffCompatibilitySnapshot(previous, snapshot);
      res.json({ snapshot: redactSnapshot(snapshot), fingerprint: diff.fingerprint, diff });
    } catch (error) {
      console.error('model catalog snapshot preview failed:', error);
      internalError(res, 'SNAPSHOT_INVALID', 422);
    }
  });

  router.post('/v1/admin/model-catalog/snapshot-restore', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : '';
    if (!backupId) {
      res.status(400).json({ code: 'VALIDATION', message: 'backupId is required' });
      return;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const result = await releases.atomicRestore({
        backupId,
        actor,
        actorType: actorType === 'external' ? 'service' : actorType,
      });
      if (!result) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Snapshot backup not found' });
        return;
      }
      res.json({
        ok: true,
        release: result.release,
        taskId: result.taskId,
        streamUrl: `/v1/admin/llm-push-tasks/${result.taskId}/stream`,
      });
    } catch (error) {
      console.error('model catalog snapshot restore failed:', error);
      internalError(res);
    }
  });

  router.post('/v1/admin/model-catalog/snapshot-publish', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);
    const expectedFingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';
    if (!expectedFingerprint) {
      res.status(400).json({ code: 'VALIDATION', message: 'fingerprint is required' });
      return;
    }
    try {
      // Read-only: build the snapshot and compute its fingerprint (outside tx).
      const previous = await getGlobalLlmProviders(pool);
      const next = validateLlmProviders(await service.buildCompatibilitySnapshot(previous));
      const actualFingerprint = snapshotFingerprint(next);
      if (actualFingerprint !== expectedFingerprint) {
        res.status(409).json({ code: 'FINGERPRINT_MISMATCH', message: 'Catalog changed after preview', details: { actualFingerprint } });
        return;
      }
      const blob = JSON.stringify(next);
      validateConfigValue(blob);
      const diff = service.diffCompatibilitySnapshot(
        previous ?? { providers: [], defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [] },
        next,
      );
      const { actor, actorType } = actorFromRequest(req);

      // Resolve the current release's fingerprint for CAS.
      const currentReleaseId = await releases.getCurrentReleaseId();
      const currentRelease = currentReleaseId ? await releases.getRelease(currentReleaseId) : null;
      const expectedParentFingerprint = currentRelease?.fingerprint ?? null;

      // Atomic publish: Release + runtime_config + push task in one tx.
      const result = await releases.atomicPublish({
        expectedParentFingerprint,
        snapshot: next,
        fingerprint: actualFingerprint,
        diffSummary: diff as unknown as Record<string, unknown>,
        warnings: diff.fallbackWarnings ?? [],
        actor,
        actorType: actorType === 'external' ? 'service' : actorType,
      });

      if (!result) {
        // CAS failure — someone else published between preview and publish.
        res.status(409).json({ code: 'STALE_FINGERPRINT', message: 'A newer release was published since preview' });
        return;
      }

      res.json({
        ok: true,
        release: result.release,
        taskId: result.taskId,
        streamUrl: `/v1/admin/llm-push-tasks/${result.taskId}/stream`,
      });
    } catch (error) {
      const tooLarge = error instanceof Error && error.message.includes('too long');
      console.error('model catalog snapshot publish failed:', error);
      internalError(res, tooLarge ? 'SNAPSHOT_TOO_LARGE' : 'INTERNAL', tooLarge ? 422 : 500);
    }
  });

  // ── Release query endpoints (read-only, controlled by modelCatalogRead) ──

  router.get('/v1/admin/model-catalog/releases', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const list = await releases.listReleases(20);
      res.json({ releases: list });
    } catch (error) {
      console.error('model catalog releases list failed:', error);
      internalError(res);
    }
  });

  router.get('/v1/admin/model-catalog/releases/current', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const releaseId = await releases.getCurrentReleaseId();
      if (!releaseId) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'No current release' });
        return;
      }
      const release = await releases.getRelease(releaseId);
      if (!release) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Current release not found' });
        return;
      }
      res.json({ release: recordToView(release) });
    } catch (error) {
      console.error('model catalog current release failed:', error);
      internalError(res);
    }
  });

  router.get('/v1/admin/model-catalog/releases/:id', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const release = await releases.getRelease(req.params.id);
      if (!release) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Release not found' });
        return;
      }
      res.json({ release: recordToView(release) });
    } catch (error) {
      console.error('model catalog release detail failed:', error);
      internalError(res);
    }
  });

  router.get('/v1/admin/model-catalog/tenants/:id/release-status', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const status = await releases.getTenantReleaseStatus(req.params.id);
      if (!status) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant release status not found' });
        return;
      }
      res.json({ status });
    } catch (error) {
      console.error('model catalog tenant release status failed:', error);
      internalError(res);
    }
  });

  return router;
}
