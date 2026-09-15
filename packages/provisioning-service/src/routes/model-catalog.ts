import { Router, type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest, writeAuditLog } from '../services/audit.js';
import { decryptValue, maskValue } from '../services/crypto.js';
import { importLegacyCatalog } from '../services/model-catalog-import.js';
import {
  ModelParamDiscoveryError,
  ModelParamDiscoveryService,
} from '../services/model-param-discovery.js';
import {
  CatalogRepository, CatalogService, snapshotFingerprint,
  modelRowIdToLegacyRef, legacyRefToModelRowId,
  type ProviderInstanceRecord,
} from '../services/model-catalog.js';
import { CatalogReleaseService } from '../services/catalog-release-service.js';
import { getGlobalLlmProviders, LLM_PROVIDERS_KEY, validateLlmProviders } from '../services/llm-providers.js';
import { TenantSelectionV2Service } from '../services/tenant-selection-v2.js';
import { validateConfigValue } from '../services/runtime-config.js';
import { checkCatalogDrift } from '../services/catalog-drift-detector.js';
import type { CatalogReleaseRecord, CatalogReleaseView } from '../domain/catalog-release.js';
import {
  GlobalModelPolicyInputSchema,
  ModelMutationSchema,
  ProviderInstanceInputSchema,
  ProviderMutationSchema,
  MODEL_TYPES,
  type ModelType,
} from '../domain/model-catalog.js';

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

/** Strip encrypted API key from a provider record, adding hasApiKey + apiKeyMask. */
function redactProvider(provider: ProviderInstanceRecord) {
  const { encryptedApiKey, ...rest } = provider
  let apiKeyMask = '••••••••'
  if (encryptedApiKey) {
    try { apiKeyMask = maskValue(decryptValue(encryptedApiKey)) } catch { /* keep default mask */ }
  }
  return { ...rest, hasApiKey: Boolean(encryptedApiKey), apiKeyMask }
}

/** Parse expectedRevision from query param or body field. Returns NaN if absent. */
function parseExpectedRevision(req: Request): number {
  const raw = req.query.expectedRevision ?? req.body?.expectedRevision
  const num = Number(raw)
  return Number.isSafeInteger(num) && num >= 0 ? num : NaN
}

/** Send a CAS conflict response. */
function staleRevision(res: Response): void {
  res.status(409).json({ code: 'STALE_REVISION', message: 'Revision mismatch — refresh and retry' })
}

/** Send a validation error response. */
function validationError(res: Response, message: string): void {
  res.status(400).json({ code: 'MODEL_CATALOG_VALIDATION', message })
}

/** Send a conflict error response. */
function conflictError(res: Response, code: string, message: string): void {
  res.status(409).json({ code, message })
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
  // Inject feature flags into the release service for P1-2 catalog projection.
  if ('setConfig' in releases && typeof (releases as any).setConfig === 'function') {
    (releases as CatalogReleaseService).setConfig({
      catalogProjectionFromAuthority: config.catalogProjectionFromAuthority,
    });
  }

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
    // P0-5: Break-glass 模式激活时冻结 Catalog Publish，防止双写。
    if (config.catalogBreakGlass === true) {
      res.status(503).json({
        code: 'CATALOG_PUBLISH_FROZEN',
        message: 'Break-glass 模式已激活，Catalog Publish 已冻结。请先解除 break-glass 再发布。',
      });
      return;
    }
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

  // ── Provider CRUD (modelCatalogParamWrite) ──────────────────────────────

  router.get('/v1/admin/model-catalog/providers/:id', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const provider = await repository.findProvider(req.params.id);
      if (!provider) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Provider not found' });
        return;
      }
      res.json({ provider: redactProvider(provider) });
    } catch (error) {
      console.error('model catalog provider detail failed:', error);
      internalError(res);
    }
  });

  router.post('/v1/admin/model-catalog/providers', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const parsed = ProviderInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'MODEL_CATALOG_VALIDATION',
        message: parsed.error.message,
      });
      return;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const provider = await repository.createProvider(parsed.data);
      const redacted = redactProvider(provider);
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.provider.create',
        method: 'POST', path: req.path, resourceType: 'llm_provider_instance',
        resourceId: provider.id, newValue: redacted,
      });
      res.status(201).json({ provider: redacted });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists')) {
        conflictError(res, 'DUPLICATE_PROVIDER', msg);
        return;
      }
      console.error('model catalog provider create failed:', error);
      internalError(res);
    }
  });

  router.patch('/v1/admin/model-catalog/providers/:id', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const expectedRevision = parseExpectedRevision(req);
    if (Number.isNaN(expectedRevision)) {
      validationError(res, 'expectedRevision is required (query param or body field)');
      return;
    }
    const parsed = ProviderMutationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'MODEL_CATALOG_VALIDATION',
        message: parsed.error.message,
      });
      return;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const before = await repository.findProvider(req.params.id);
      if (!before) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Provider not found' });
        return;
      }
      const provider = await repository.updateProvider(req.params.id, parsed.data, expectedRevision);
      const redacted = redactProvider(provider);
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.provider.update',
        method: 'PATCH', path: req.path, resourceType: 'llm_provider_instance',
        resourceId: provider.id,
        oldValue: redactProvider(before), newValue: redacted,
      });
      res.json({ provider: redacted });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('STALE_REVISION')) return staleRevision(res);
      if (msg.includes('not found')) {
        res.status(404).json({ code: 'NOT_FOUND', message: msg });
        return;
      }
      console.error('model catalog provider update failed:', error);
      internalError(res);
    }
  });

  router.delete('/v1/admin/model-catalog/providers/:id', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    try {
      const { actor, actorType } = actorFromRequest(req);
      const before = await repository.findProvider(req.params.id);
      if (!before) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Provider not found' });
        return;
      }
      await repository.deleteProvider(req.params.id);
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.provider.delete',
        method: 'DELETE', path: req.path, resourceType: 'llm_provider_instance',
        resourceId: req.params.id,
        oldValue: redactProvider(before),
      });
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('PROVIDER_HAS_RUNTIME_MODELS')) {
        conflictError(res, 'PROVIDER_HAS_RUNTIME_MODELS', msg);
        return;
      }
      if (msg.includes('not found')) {
        res.status(404).json({ code: 'NOT_FOUND', message: msg });
        return;
      }
      console.error('model catalog provider delete failed:', error);
      internalError(res);
    }
  });

  // ── Model CRUD (modelCatalogParamWrite) ─────────────────────────────────

  router.post('/v1/admin/model-catalog/providers/:id/models', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    if (!modelId || modelId.length > 100) {
      validationError(res, 'modelId must be 1-100 chars');
      return;
    }
    if (!MODEL_TYPES.includes(req.body?.modelType as ModelType)) {
      validationError(res, 'invalid modelType');
      return;
    }
    if (typeof req.body?.runtimeEnabled !== 'boolean') {
      validationError(res, 'runtimeEnabled must be boolean');
      return;
    }
    const displayName = typeof req.body.displayName === 'string' && req.body.displayName.trim()
      ? req.body.displayName.trim().slice(0, 128) : undefined;
    try {
      const { actor, actorType } = actorFromRequest(req);
      const model = await repository.createModel(req.params.id, {
        modelId, ...(displayName ? { displayName } : {}),
        modelType: req.body.modelType as ModelType,
        runtimeEnabled: req.body.runtimeEnabled as boolean,
      });
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.model.create',
        method: 'POST', path: req.path, resourceType: 'llm_provider_model',
        resourceId: model.id, newValue: { ...model, effectiveParams: undefined },
      });
      res.status(201).json({ model });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists')) {
        conflictError(res, 'DUPLICATE_MODEL', msg);
        return;
      }
      console.error('model catalog model create failed:', error);
      internalError(res);
    }
  });

  router.patch('/v1/admin/model-catalog/models/:id', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const expectedRevision = parseExpectedRevision(req);
    if (Number.isNaN(expectedRevision)) {
      validationError(res, 'expectedRevision is required (query param or body field)');
      return;
    }
    const mutation: { displayName?: string; modelType?: ModelType; runtimeEnabled?: boolean } = {};
    if (req.body?.displayName !== undefined) {
      if (typeof req.body.displayName !== 'string' || req.body.displayName.length > 128) {
        validationError(res, 'displayName must be string <= 128 chars');
        return;
      }
      mutation.displayName = req.body.displayName.trim() || undefined;
    }
    if (req.body?.modelType !== undefined) {
      if (!MODEL_TYPES.includes(req.body.modelType as ModelType)) {
        validationError(res, 'invalid modelType');
        return;
      }
      mutation.modelType = req.body.modelType as ModelType;
    }
    if (req.body?.runtimeEnabled !== undefined) {
      if (typeof req.body.runtimeEnabled !== 'boolean') {
        validationError(res, 'runtimeEnabled must be boolean');
        return;
      }
      mutation.runtimeEnabled = req.body.runtimeEnabled;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const model = await repository.updateModel(req.params.id, mutation, expectedRevision);
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.model.update',
        method: 'PATCH', path: req.path, resourceType: 'llm_provider_model',
        resourceId: model.id, newValue: { ...model, effectiveParams: undefined },
      });
      res.json({ model });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('STALE_REVISION')) return staleRevision(res);
      if (msg.includes('not found')) {
        res.status(404).json({ code: 'NOT_FOUND', message: msg });
        return;
      }
      console.error('model catalog model update failed:', error);
      internalError(res);
    }
  });

  router.delete('/v1/admin/model-catalog/models/:id', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    try {
      const { actor, actorType } = actorFromRequest(req);
      // Check if model is referenced in Global Model Policy before deleting.
      const policy = await repository.getGlobalModelPolicy();
      if (policy) {
        const refs = [
          policy.defaultModel, policy.imageModel, policy.compactionModel,
          ...policy.fallbackModels,
        ].filter((r): r is string => r !== null)
        if (refs.includes(req.params.id)) {
          conflictError(res, 'MODEL_REFERENCED_BY_POLICY',
            'Model is referenced by the global model policy — remove the reference first');
          return;
        }
      }
      await repository.deleteModel(req.params.id);
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.model.delete',
        method: 'DELETE', path: req.path, resourceType: 'llm_provider_model',
        resourceId: req.params.id,
      });
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('not found')) {
        res.status(404).json({ code: 'NOT_FOUND', message: msg });
        return;
      }
      console.error('model catalog model delete failed:', error);
      internalError(res);
    }
  });

  // ── Global Model Policy (read = modelCatalogRead, write = modelCatalogSnapshotWrite) ──

  router.get('/v1/admin/model-catalog/global-policy', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const policy = await repository.getGlobalModelPolicy();
      res.json({ policy });
    } catch (error) {
      console.error('model catalog global policy get failed:', error);
      internalError(res);
    }
  });

  router.put('/v1/admin/model-catalog/global-policy', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);
    const expectedRevision = parseExpectedRevision(req);
    if (Number.isNaN(expectedRevision)) {
      validationError(res, 'expectedRevision is required (query param or body field)');
      return;
    }
    const parsed = GlobalModelPolicyInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'MODEL_CATALOG_VALIDATION',
        message: parsed.error.message,
      });
      return;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const before = await repository.getGlobalModelPolicy();
      const policy = await repository.updateGlobalModelPolicy(
        parsed.data, expectedRevision,
        actorType === 'external' ? 'service-token' : actor,
      );
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.global-policy.update',
        method: 'PUT', path: req.path, resourceType: 'llm_global_model_policy',
        resourceId: 'current', oldValue: before, newValue: policy,
      });
      res.json({ policy });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('STALE_REVISION')) return staleRevision(res);
      if (msg.includes('DANGLING_MODEL_REFERENCE')) {
        res.status(400).json({ code: 'DANGLING_MODEL_REFERENCE', message: msg });
        return;
      }
      console.error('model catalog global policy update failed:', error);
      internalError(res);
    }
  });

  // ── Pure Catalog Snapshot Preview (modelCatalogRead) ───────────────────

  router.get('/v1/admin/model-catalog/catalog-preview', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const snapshot = await service.buildCatalogSnapshot();
      const fingerprint = snapshotFingerprint(snapshot);
      res.json({
        snapshot: redactSnapshot(snapshot),
        fingerprint,
      });
    } catch (error) {
      console.error('model catalog catalog preview failed:', error);
      internalError(res, 'SNAPSHOT_INVALID', 422);
    }
  });

  // ── Drift Detection (modelCatalogRead) ────────────────────────────────
  // Compares the runtime LLM_PROVIDERS fingerprint against the pure Catalog
  // snapshot fingerprint and the last published Release fingerprint. If any
  // differ, drift has occurred (likely from a break-glass write that bypassed
  // the Catalog). Used by the admin UI to flag "reconcile needed".

  router.get('/v1/admin/model-catalog/drift-check', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const result = await checkCatalogDrift(pool);
      res.json(result);
    } catch (err) {
      console.error('drift-check failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // ── Selection V2 endpoints ────────────────────────────────────────────
  // Stable model row ID selection. GET is controlled by modelCatalogRead;
  // PUT/POST by modelCatalogParamWrite. These coexist with the legacy
  // /v1/admin/llm-providers/selection endpoint during the dual-write transition.

  router.get('/v1/admin/model-catalog/tenants/:id/selection', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const v2Service = new TenantSelectionV2Service(pool);
      const selection = await v2Service.getSelection(req.params.id);
      if (!selection) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'No V2 selection for this tenant' });
        return;
      }
      res.json({ selection });
    } catch (error) {
      console.error('selection v2 get failed:', error);
      internalError(res);
    }
  });

  router.put('/v1/admin/model-catalog/tenants/:id/selection', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const expectedRevision = parseExpectedRevision(req);
    if (Number.isNaN(expectedRevision)) {
      validationError(res, 'expectedRevision is required (query param or body field)');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: {
      defaultModelId?: string | null;
      imageModelId?: string | null;
      compactionModelId?: string | null;
      fallbackModelIds?: string[];
      directMode?: boolean;
    } = {};
    if ('defaultModelId' in body) {
      input.defaultModelId = typeof body.defaultModelId === 'string' && body.defaultModelId.trim()
        ? body.defaultModelId.trim() : null;
    }
    if ('imageModelId' in body) {
      input.imageModelId = typeof body.imageModelId === 'string' && body.imageModelId.trim()
        ? body.imageModelId.trim() : null;
    }
    if ('compactionModelId' in body) {
      input.compactionModelId = typeof body.compactionModelId === 'string' && body.compactionModelId.trim()
        ? body.compactionModelId.trim() : null;
    }
    if ('fallbackModelIds' in body) {
      if (!Array.isArray(body.fallbackModelIds)) {
        validationError(res, 'fallbackModelIds must be an array');
        return;
      }
      input.fallbackModelIds = body.fallbackModelIds
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        .map((id) => id.trim());
    }
    if ('directMode' in body) {
      input.directMode = body.directMode === true;
    }
    try {
      const { actor, actorType } = actorFromRequest(req);
      const v2Service = new TenantSelectionV2Service(pool);
      const selection = await v2Service.updateSelection(
        req.params.id,
        input,
        expectedRevision,
        actorType === 'external' ? 'service-token' : actor,
      );
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.selection-v2.update',
        method: 'PUT', path: req.path, resourceType: 'llm_tenant_selection_v2',
        resourceId: req.params.id, tenantId: req.params.id, newValue: selection,
      });
      res.json({ selection });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('STALE_REVISION')) return staleRevision(res);
      console.error('selection v2 update failed:', error);
      internalError(res);
    }
  });

  router.post('/v1/admin/model-catalog/selection/backfill', async (req, res) => {
    if (config.modelCatalogParamWrite !== true) return paramWriteDisabled(res);
    const dryRun = req.body?.dryRun === true;
    try {
      const { actor, actorType } = actorFromRequest(req);
      const v2Service = new TenantSelectionV2Service(pool);
      const report = await v2Service.backfillFromLegacy({
        dryRun,
        actor: actorType === 'external' ? 'service-token' : actor,
      });
      void writeAuditLog(pool, {
        actor, actorType, action: 'model-catalog.selection-v2.backfill',
        method: 'POST', path: req.path, resourceType: 'llm_tenant_selection_v2',
        resourceId: 'batch',
        newValue: {
          dryRun,
          totalTenants: report.totalTenants,
          migrated: report.migrated,
          skipped: report.skipped,
          missing: report.missing,
          errors: report.errors.length,
        },
      });
      res.json({ report });
    } catch (error) {
      console.error('selection v2 backfill failed:', error);
      internalError(res);
    }
  });

  router.get('/v1/admin/model-catalog/selection/compare/:id', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const v2Service = new TenantSelectionV2Service(pool);
      const comparison = await v2Service.compareSelections(req.params.id);
      res.json(comparison);
    } catch (error) {
      console.error('selection v2 compare failed:', error);
      internalError(res);
    }
  });

  return router;
}
