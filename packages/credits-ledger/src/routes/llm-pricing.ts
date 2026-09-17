import { Router } from 'express';
import { getPool } from '../db/pool.js';
import { importLegacyPricing } from '../services/llm-pricing-import.js';
import {
  LlmPricingAdminService,
  StaleRevisionError,
  PlanNotFoundError,
  InvalidPlanStateError,
  type PricePlanRecord,
  type PricePlanWithSkus,
} from '../services/llm-pricing-admin.js';

const router = Router();

function shadowDisabled(res: import('express').Response): boolean {
  if (process.env.LLM_PRICING_SHADOW === 'true') return false;
  res.status(503).json({ code: 'DISABLED', message: 'LLM pricing shadow is disabled' });
  return true;
}

function internalError(res: import('express').Response): void {
  res.status(500).json({ code: 'INTERNAL', message: 'LLM pricing request failed' });
}

function validationError(res: import('express').Response, message: string): void {
  res.status(400).json({ code: 'VALIDATION', message });
}

function recordToApi(record: PricePlanRecord) {
  return {
    id: record.id,
    providerModelId: record.providerModelId,
    legacyProvider: record.legacyProvider,
    legacyModel: record.legacyModel,
    currency: record.currency,
    unitScale: record.unitScale,
    status: record.status,
    version: record.version,
    revision: record.revision,
    publishedAt: record.publishedAt,
    revokedAt: record.revokedAt,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function planWithSkusToApi(plan: PricePlanWithSkus) {
  return { ...recordToApi(plan), skus: plan.skus };
}

function parseExpectedRevision(req: import('express').Request): number {
  const raw = req.query.expectedRevision ?? req.body?.expectedRevision;
  const num = Number(raw);
  return Number.isSafeInteger(num) && num >= 0 ? num : NaN;
}

router.post('/v1/admin/llm-pricing/import', async (req, res) => {
  if (shadowDisabled(res)) return;
  if (typeof req.body?.dryRun !== 'boolean') {
    res.status(400).json({ code: 'VALIDATION', message: 'dryRun must be boolean' });
    return;
  }
  try {
    res.json(await importLegacyPricing(getPool(), req.body.dryRun));
  } catch (error) {
    console.error('llm pricing request failed:', error);
    internalError(res);
  }
});

router.get('/v1/admin/llm-pricing/summary', async (req, res) => {
  if (shadowDisabled(res)) return;
  const requestedLimit = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 20;
  try {
    const pool = getPool();
    const [planResult, shadowResult, samplesResult] = await Promise.all([
      pool.query('SELECT COUNT(*) AS plan_count FROM llm_model_price_plans'),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='resolved') AS resolved_count,
               COUNT(*) FILTER (WHERE status='unknown') AS unknown_count,
               COUNT(*) FILTER (WHERE status='conflict') AS conflict_count,
               COUNT(*) FILTER (WHERE status='free') AS free_count,
               COUNT(*) FILTER (WHERE status='pending') AS pending_count,
               COUNT(*) FILTER (WHERE legacy_amount IS NOT NULL) AS legacy_comparison_count,
               COUNT(*) FILTER (WHERE delta_amount = 0) AS zero_delta_count,
               COUNT(*) FILTER (WHERE delta_amount <> 0) AS nonzero_delta_count
          FROM llm_usage_pricing_shadows`),
      pool.query(`
        SELECT s.usage_event_id,e.tenant_id,e.provider,e.model,s.status,s.amount,s.currency,
               s.legacy_amount,s.delta_amount,s.created_at
          FROM llm_usage_pricing_shadows s
          JOIN llm_usage_events e ON e.id=s.usage_event_id
         WHERE s.delta_amount IS NOT NULL
         ORDER BY ABS(s.delta_amount) DESC, s.created_at DESC LIMIT $1`, [limit]),
    ]);
    const counts = shadowResult.rows[0];
    res.json({
      planCount: Number(planResult.rows[0].plan_count),
      shadowStatuses: {
        resolved: Number(counts.resolved_count), unknown: Number(counts.unknown_count),
        conflict: Number(counts.conflict_count), free: Number(counts.free_count), pending: Number(counts.pending_count),
      },
      legacyComparisonCount: Number(counts.legacy_comparison_count),
      deltaCounts: { zero: Number(counts.zero_delta_count), nonzero: Number(counts.nonzero_delta_count) },
      deltaSamples: samplesResult.rows.map((row) => ({
        usageEventId: row.usage_event_id, tenantId: row.tenant_id, provider: row.provider, model: row.model,
        status: row.status, amount: row.amount === null ? null : String(row.amount), currency: row.currency,
        legacyAmount: row.legacy_amount === null ? null : String(row.legacy_amount),
        deltaAmount: row.delta_amount === null ? null : String(row.delta_amount), createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('llm pricing summary failed:', error);
    internalError(res);
  }
});

router.get('/v1/admin/llm-pricing/plans', async (_req, res) => {
  if (shadowDisabled(res)) return;
  try {
    const service = new LlmPricingAdminService(getPool());
    const plans = await service.listPlans();
    res.json({ plans: plans.map(planWithSkusToApi) });
  } catch (error) {
    console.error('llm pricing plans list failed:', error);
    internalError(res);
  }
});

// ── Plan CRUD endpoints ──

router.post('/v1/admin/llm-pricing/plans', async (req, res) => {
  if (shadowDisabled(res)) return;
  const b = req.body ?? {};
  if (typeof b.currency !== 'string' || !b.currency.trim()) {
    validationError(res, 'currency is required (3-letter ISO code)');
    return;
  }
  if (typeof b.unitScale !== 'string' && typeof b.unitScale !== 'number') {
    validationError(res, 'unitScale is required');
    return;
  }
  if (!Array.isArray(b.skus) || b.skus.length === 0) {
    validationError(res, 'skus must be a non-empty array');
    return;
  }
  if (!b.providerModelId && !(b.legacyProvider && b.legacyModel)) {
    validationError(res, 'Either providerModelId or (legacyProvider + legacyModel) must be provided');
    return;
  }
  try {
    const service = new LlmPricingAdminService(getPool());
    const record = await service.createPlan(
      {
        providerModelId: typeof b.providerModelId === 'string' ? b.providerModelId : undefined,
        legacyProvider: typeof b.legacyProvider === 'string' ? b.legacyProvider : undefined,
        legacyModel: typeof b.legacyModel === 'string' ? b.legacyModel : undefined,
        currency: b.currency,
        unitScale: String(b.unitScale),
        skus: b.skus,
      },
      null,
    );
    res.status(201).json({ plan: recordToApi(record) });
  } catch (error) {
    if (error instanceof InvalidPlanStateError) {
      validationError(res, error.message);
      return;
    }
    console.error('llm pricing plan create failed:', error);
    internalError(res);
  }
});

router.get('/v1/admin/llm-pricing/plans/:id', async (req, res) => {
  if (shadowDisabled(res)) return;
  try {
    const service = new LlmPricingAdminService(getPool());
    const plan = await service.getPlan(req.params.id);
    if (!plan) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Plan not found' });
      return;
    }
    res.json({ plan: planWithSkusToApi(plan) });
  } catch (error) {
    console.error('llm pricing plan get failed:', error);
    internalError(res);
  }
});

router.patch('/v1/admin/llm-pricing/plans/:id', async (req, res) => {
  if (shadowDisabled(res)) return;
  const expectedRevision = parseExpectedRevision(req);
  if (Number.isNaN(expectedRevision)) {
    validationError(res, 'expectedRevision is required (query param or body field)');
    return;
  }
  const b = req.body ?? {};
  const allowed = new Set(['currency', 'unitScale', 'skus', 'expectedRevision']);
  if (typeof b !== 'object' || Array.isArray(b) ||
      Object.keys(b).some((key) => !allowed.has(key))) {
    validationError(res, 'Unknown or forbidden request field');
    return;
  }
  try {
    const service = new LlmPricingAdminService(getPool());
    const record = await service.updatePlan(
      req.params.id,
      {
        currency: typeof b.currency === 'string' ? b.currency : undefined,
        unitScale: b.unitScale !== undefined ? String(b.unitScale) : undefined,
        skus: Array.isArray(b.skus) ? b.skus : undefined,
      },
      expectedRevision,
      null,
    );
    res.json({ plan: recordToApi(record) });
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      res.status(409).json({ code: 'STALE_REVISION', message: 'Revision mismatch — refresh and retry' });
      return;
    }
    if (error instanceof PlanNotFoundError) {
      res.status(404).json({ code: 'NOT_FOUND', message: error.message });
      return;
    }
    if (error instanceof InvalidPlanStateError) {
      res.status(409).json({ code: 'INVALID_STATE', message: error.message });
      return;
    }
    console.error('llm pricing plan update failed:', error);
    internalError(res);
  }
});

router.post('/v1/admin/llm-pricing/plans/:id/publish', async (req, res) => {
  if (shadowDisabled(res)) return;
  const expectedRevision = parseExpectedRevision(req);
  if (Number.isNaN(expectedRevision)) {
    validationError(res, 'expectedRevision is required (query param or body field)');
    return;
  }
  try {
    const service = new LlmPricingAdminService(getPool());
    const record = await service.publishPlan(req.params.id, expectedRevision, null);
    res.json({ plan: recordToApi(record) });
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      res.status(409).json({ code: 'STALE_REVISION', message: 'Revision mismatch — refresh and retry' });
      return;
    }
    if (error instanceof PlanNotFoundError) {
      res.status(404).json({ code: 'NOT_FOUND', message: error.message });
      return;
    }
    if (error instanceof InvalidPlanStateError) {
      res.status(409).json({ code: 'INVALID_STATE', message: error.message });
      return;
    }
    console.error('llm pricing plan publish failed:', error);
    internalError(res);
  }
});

router.post('/v1/admin/llm-pricing/plans/:id/revoke', async (req, res) => {
  if (shadowDisabled(res)) return;
  const expectedRevision = parseExpectedRevision(req);
  if (Number.isNaN(expectedRevision)) {
    validationError(res, 'expectedRevision is required (query param or body field)');
    return;
  }
  try {
    const service = new LlmPricingAdminService(getPool());
    const record = await service.revokePlan(req.params.id, expectedRevision, null);
    res.json({ plan: recordToApi(record) });
  } catch (error) {
    if (error instanceof StaleRevisionError) {
      res.status(409).json({ code: 'STALE_REVISION', message: 'Revision mismatch — refresh and retry' });
      return;
    }
    if (error instanceof PlanNotFoundError) {
      res.status(404).json({ code: 'NOT_FOUND', message: error.message });
      return;
    }
    if (error instanceof InvalidPlanStateError) {
      res.status(409).json({ code: 'INVALID_STATE', message: error.message });
      return;
    }
    console.error('llm pricing plan revoke failed:', error);
    internalError(res);
  }
});

// ── Drift alerts endpoint ──

router.get('/v1/admin/llm-pricing/drift-alerts', async (req, res) => {
  if (shadowDisabled(res)) return;
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200) : 50;
  try {
    const { rows } = await getPool().query(
      `SELECT id, usage_event_id, legacy_amount, new_amount, delta_amount,
              delta_threshold, provider, model, created_at
         FROM llm_pricing_drift_alerts
        ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({
      alerts: rows.map((row) => ({
        id: Number(row.id),
        usageEventId: row.usage_event_id,
        legacyAmount: row.legacy_amount === null ? null : String(row.legacy_amount),
        newAmount: row.new_amount === null ? null : String(row.new_amount),
        deltaAmount: row.delta_amount === null ? null : String(row.delta_amount),
        deltaThreshold: row.delta_threshold === null ? null : String(row.delta_threshold),
        provider: row.provider,
        model: row.model,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('llm pricing drift alerts failed:', error);
    internalError(res);
  }
});

export default router;
