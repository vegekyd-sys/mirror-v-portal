import { Router } from 'express';
import { getPool } from '../db/pool.js';
import { importLegacyPricing } from '../services/llm-pricing-import.js';

const router = Router();

function shadowDisabled(res: import('express').Response): boolean {
  if (process.env.LLM_PRICING_SHADOW === 'true') return false;
  res.status(503).json({ code: 'DISABLED', message: 'LLM pricing shadow is disabled' });
  return true;
}

function internalError(res: import('express').Response): void {
  res.status(500).json({ code: 'INTERNAL', message: 'LLM pricing request failed' });
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
    const { rows } = await getPool().query(
      `SELECT id,provider_instance_id,provider_model_id,provider_key,model_id,version,status,
              currency,unit_scale,valid_from,valid_to,source,source_key,contract_version,published_at,created_at
         FROM llm_model_price_plans ORDER BY provider_key,model_id,version DESC`,
    );
    res.json({ plans: rows.map((row) => ({
      id: row.id, providerInstanceId: row.provider_instance_id, providerModelId: row.provider_model_id,
      providerKey: row.provider_key, modelId: row.model_id, version: row.version, status: row.status,
      currency: row.currency, unitScale: String(row.unit_scale), validFrom: row.valid_from,
      validTo: row.valid_to, source: row.source, sourceKey: row.source_key,
      contractVersion: row.contract_version, publishedAt: row.published_at, createdAt: row.created_at,
    })) });
  } catch (error) {
    console.error('llm pricing request failed:', error);
    internalError(res);
  }
});

export default router;
