import { Router } from 'express';
import { getPool } from '../db/pool.js';
import { importLegacyPricing } from '../services/llm-pricing-import.js';

const router = Router();

router.post('/v1/admin/llm-pricing/import', async (req, res) => {
  if (process.env.LLM_PRICING_SHADOW !== 'true') {
    res.status(503).json({ code: 'DISABLED', message: 'LLM pricing shadow is disabled' });
    return;
  }
  if (typeof req.body?.dryRun !== 'boolean') {
    res.status(400).json({ code: 'VALIDATION', message: 'dryRun must be boolean' });
    return;
  }
  try {
    res.json(await importLegacyPricing(getPool(), req.body.dryRun));
  } catch (error) {
    res.status(500).json({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/v1/admin/llm-pricing/plans', async (_req, res) => {
  if (process.env.LLM_PRICING_SHADOW !== 'true') {
    res.status(503).json({ code: 'DISABLED', message: 'LLM pricing shadow is disabled' });
    return;
  }
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
    res.status(500).json({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
