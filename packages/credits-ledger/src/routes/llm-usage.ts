/**
 * LLM token usage accounting — written by the nexus-gateway LLM proxy.
 *
 * Shadow accounting: records raw input/output tokens per upstream call.
 * Never debits credits (see docs/design/llm-proxy-billing.md).
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, getPool } from '../db/pool.js';
import { calculatePricingAmount, LlmPricingService, subtractPricingAmounts, type PricingRepository } from '../services/llm-pricing.js';
import { recordDriftAlert } from '../services/llm-pricing-admin.js';
import type { PricePlanV1 } from '../domain/llm-pricing.js';

const router = Router();

const pricingRepository: PricingRepository = {
  async findPublishedPlans(provider: string, model: string, occurredAt: Date): Promise<PricePlanV1[]> {
    const { rows } = await query(
      `SELECT p.*, COALESCE(json_agg(i.* ORDER BY i.priority DESC) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM llm_model_price_plans p LEFT JOIN llm_model_price_items i ON i.plan_id=p.id
        WHERE p.provider_key=$1 AND p.model_id=$2 AND p.status='published'
          AND p.valid_from <= $3 AND (p.valid_to IS NULL OR p.valid_to > $3)
        GROUP BY p.id`, [provider, model, occurredAt],
    );
    return rows.map((row: any) => ({
      id: row.id, currency: row.currency, unitScale: String(row.unit_scale),
      skus: row.items.map((item: any) => ({
        id: item.id, usageType: item.usage_type, unitPrice: String(item.unit_price),
        priority: item.priority, conditions: item.conditions ?? {},
      })),
    }));
  },
};
const pricingService = new LlmPricingService(pricingRepository);

async function writePricingShadow(usageEventId: string): Promise<void> {
  const { rows } = await query('SELECT * FROM llm_usage_events WHERE id=$1', [usageEventId]);
  const event = rows[0];
  if (!event) return;
  const resolution = await pricingService.resolve({
    provider: event.provider, model: event.model, occurredAt: new Date(event.created_at),
    usage: {
      inputTokens: String(event.input_tokens), outputTokens: String(event.output_tokens),
      cacheHitTokens: String(event.cache_hit_tokens), cacheMissTokens: String(event.cache_miss_tokens),
    },
  });
  const { rows: legacyRows } = await query(
    `SELECT input_cache_hit_peak,input_cache_hit_offpeak,input_cache_miss_peak,input_cache_miss_offpeak,
            output_peak,output_offpeak,currency
       FROM llm_token_pricing WHERE provider=$1 AND model=$2`,
    [event.provider,event.model],
  );
  let legacyAmount: string | null = null;
  const legacy = legacyRows[0];
  if (legacy) {
    const local = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(event.created_at));
    const weekday=local.find((part)=>part.type==='weekday')?.value??'Sun';
    const hour=Number(local.find((part)=>part.type==='hour')?.value??0);
    const peak=['Mon','Tue','Wed','Thu','Fri'].includes(weekday)&&([9,10,11,14,15,16,17].includes(hour));
    legacyAmount=calculatePricingAmount([
      {id:'legacy-hit',usageType:'input-cache-read',unitPrice:String(peak?legacy.input_cache_hit_peak:legacy.input_cache_hit_offpeak),priority:0,conditions:{}},
      {id:'legacy-miss',usageType:'input-cache-write',unitPrice:String(peak?legacy.input_cache_miss_peak:legacy.input_cache_miss_offpeak),priority:0,conditions:{}},
      {id:'legacy-output',usageType:'output',unitPrice:String(peak?legacy.output_peak:legacy.output_offpeak),priority:0,conditions:{}},
    ],{inputTokens:String(event.input_tokens),outputTokens:String(event.output_tokens),cacheHitTokens:String(event.cache_hit_tokens),cacheMissTokens:String(event.cache_miss_tokens)},'1000000');
  }
  const deltaAmount=resolution.amount&&legacyAmount?subtractPricingAmounts(resolution.amount,legacyAmount):null;
  await query(
    `INSERT INTO llm_usage_pricing_shadows
       (usage_event_id,resolver_version,status,price_plan_id,matched_item_ids,amount,currency,legacy_amount,delta_amount,pricing_snapshot,error_code)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (usage_event_id) DO NOTHING`,
    [usageEventId, resolution.status, resolution.planId ?? null, resolution.matchedSkuIds,
      resolution.amount ?? null, resolution.currency ?? null, legacyAmount, deltaAmount,
      JSON.stringify({ contractVersion: 1, resolution }), resolution.reason ?? null],
  );
  // Delta threshold alert — record if the relative difference exceeds 1%
  await recordDriftAlert(getPool(), {
    usageEventId: usageEventId,
    legacyAmount: legacyAmount,
    newAmount: resolution.amount ?? null,
    deltaAmount: deltaAmount,
    provider: event.provider,
    model: event.model,
  }).catch((driftErr) => {
    console.error('llm pricing drift alert failed:', driftErr);
  });
}

const STATUSES = new Set(['ok', 'error', 'blocked', 'synthesized']);

function int(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  return Math.min(n, max);
}

function str(v: unknown, max = 128): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// POST /v1/billing/llm-usage — record one upstream (or synthesized) call.
// Idempotent on request_id: replays return the existing row without dupes.
router.post('/v1/billing/llm-usage', async (req, res) => {
  try {
    const b = req.body ?? {};
    const tenantId = str(b.tenantId, 64);
    const provider = str(b.provider, 64);
    const model = str(b.model, 128);
    if (!tenantId || !provider || !model) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId, provider, and model are required',
      });
      return;
    }
    const accountId = str(b.accountId, 64) || `acct_${tenantId}`;
    const inputTokens = int(b.inputTokens);
    const outputTokens = int(b.outputTokens);
    const cacheHitTokens = int(b.cacheHitTokens);
    const cacheMissTokens = int(b.cacheMissTokens);
    const status = STATUSES.has(str(b.status, 16)) ? str(b.status, 16) : 'ok';
    const requestId = str(b.requestId, 128) || null;
    const latencyMs = b.latencyMs == null ? null : int(b.latencyMs, 86_400_000);
    const metadata = (b.metadata && typeof b.metadata === 'object') ? b.metadata : {};
    const id = randomUUID();

    const { rows } = await query(
      `INSERT INTO llm_usage_events
         (id, tenant_id, account_id, provider, model,
          input_tokens, output_tokens, total_tokens,
          cache_hit_tokens, cache_miss_tokens,
          latency_ms, status, source, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        id, tenantId, accountId, provider, model,
        inputTokens, outputTokens, inputTokens + outputTokens,
        cacheHitTokens, cacheMissTokens,
        latencyMs, status, str(b.source, 32) || 'proxy', requestId,
        JSON.stringify(metadata),
      ],
    );

    if (rows.length === 0) {
      // Replay of an already-recorded request_id — acknowledge, no duplicate.
      res.json({ ok: true, duplicate: true });
      return;
    }
    // Shadow is deliberately post-write and best-effort: it never changes the
    // legacy response and never touches accounts, monthly usage or transactions.
    if (process.env.LLM_PRICING_SHADOW === 'true') {
      try {
        await writePricingShadow(rows[0].id);
      } catch (shadowError) {
        console.error('llm pricing shadow failed:', shadowError);
      }
    }
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('llm-usage insert failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/summary?tenantId=...&days=7 — per-tenant aggregate.
router.get('/v1/billing/llm-usage/summary', async (req, res) => {
  try {
    const tenantId = str(req.query.tenantId, 64);
    const days = Math.min(Math.max(int(req.query.days, 31) || 7, 1), 365);
    if (!tenantId) {
      res.status(400).json({ code: 'VALIDATION', message: 'tenantId query parameter required' });
      return;
    }

    const { rows: totals } = await query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0)  AS total_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [tenantId, String(days)],
    );

    const { rows: byModel } = await query(
      `SELECT provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY provider, model
        ORDER BY calls DESC`,
      [tenantId, String(days)],
    );

    const { rows: byDay } = await query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [tenantId, String(days)],
    );

    res.json({
      tenantId,
      days,
      totals: {
        calls: Number(totals[0].calls),
        inputTokens: Number(totals[0].input_tokens),
        outputTokens: Number(totals[0].output_tokens),
        totalTokens: Number(totals[0].total_tokens),
      },
      byModel: byModel.map((r: any) => ({
        provider: r.provider, model: r.model, calls: Number(r.calls),
        inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      })),
      byDay: byDay.map((r: any) => ({
        day: r.day, calls: Number(r.calls),
        inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      })),
    });
  } catch (err) {
    console.error('llm-usage summary failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/tenants?days=7 — per-tenant totals (admin page).
router.get('/v1/billing/llm-usage/tenants', async (req, res) => {
  try {
    const days = Math.min(Math.max(int(req.query.days, 31) || 7, 1), 365);
    const { rows: ordered } = await query(
      `SELECT tenant_id,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
              COUNT(*) FILTER (WHERE status = 'blocked')     AS blocked,
              COUNT(*) FILTER (WHERE status = 'synthesized') AS synthesized,
              MAX(created_at) AS last_call_at
         FROM llm_usage_events
        WHERE created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY tenant_id
        ORDER BY total_tokens DESC`,
      [String(days)],
    );
    res.json({
      days,
      tenants: ordered.map((r: any) => ({
        tenantId: r.tenant_id,
        calls: Number(r.calls),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        totalTokens: Number(r.total_tokens),
        blocked: Number(r.blocked),
        synthesized: Number(r.synthesized),
        lastCallAt: r.last_call_at,
      })),
    });
  } catch (err) {
    console.error('llm-usage tenants failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/range?tenantId=&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Absolute (inclusive) date-range aggregate for external token accounting.
router.get('/v1/billing/llm-usage/range', async (req, res) => {
  try {
    const tenantId = str(req.query.tenantId, 64);
    const startDate = str(req.query.startDate, 10);
    const endDate = str(req.query.endDate, 10);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!tenantId || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId and valid startDate/endDate (YYYY-MM-DD) are required',
      });
      return;
    }

    const { rows } = await query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS day,
              provider, model,
              CASE
                WHEN EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Shanghai') IN (1,2,3,4,5)
                  AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Shanghai') IN (9,10,11,14,15,16,17)
                THEN 'peak' ELSE 'offpeak'
              END AS bucket,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_hit_tokens), 0)  AS cache_hit_tokens,
              COALESCE(SUM(cache_miss_tokens), 0) AS cache_miss_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1
          AND created_at >= ($2::date)::timestamptz
          AND created_at <  (($3::date) + 1)::timestamptz
        GROUP BY day, provider, model, bucket
        ORDER BY day, provider, model`,
      [tenantId, startDate, endDate],
    );

    // Load the token pricing table (CNY per 1M tokens).
    const { rows: pricingRows } = await query(
      `SELECT provider, model, input_cache_hit_peak, input_cache_hit_offpeak,
              input_cache_miss_peak, input_cache_miss_offpeak, output_peak, output_offpeak
         FROM llm_token_pricing`,
    );
    const pricingMap = new Map<string, any>();
    for (const p of pricingRows) pricingMap.set(`${p.provider}|${p.model}`, p);

    // Resolve a pricing row with fallback:
    // 1) exact "provider|model";
    // 2) longest model-prefix match, same provider preferred over cross-provider.
    // Covers versioned model names (e.g. deepseek-v4-pro-0813 → deepseek-v4-pro).
    const resolvePricing = (provider: string, model: string): any => {
      const exact = pricingMap.get(`${provider}|${model}`);
      if (exact) return exact;
      let best: any = null;
      let bestScore = -1;
      for (const [k, p] of pricingMap) {
        const sep = k.indexOf('|');
        const pProvider = k.slice(0, sep);
        const pModel = k.slice(sep + 1);
        if (!model.startsWith(pModel)) continue;
        const score = pModel.length * 2 + (pProvider === provider ? 1 : 0);
        if (score > bestScore) { best = p; bestScore = score; }
      }
      return best;
    };

    const costOf = (provider: string, model: string, bucket: string, miss: number, hit: number, out: number): number => {
      const p = resolvePricing(provider, model);
      if (!p) return 0;
      const peak = bucket === 'peak';
      const missPrice = peak ? Number(p.input_cache_miss_peak) : Number(p.input_cache_miss_offpeak);
      const hitPrice = peak ? Number(p.input_cache_hit_peak) : Number(p.input_cache_hit_offpeak);
      const outPrice = peak ? Number(p.output_peak) : Number(p.output_offpeak);
      return (miss * missPrice + hit * hitPrice + out * outPrice) / 1_000_000;
    };

    // Aggregate: day → provider+model (tokens + cost).
    const dayMap = new Map<string, Map<string, any>>();
    for (const r of rows) {
      const day = r.day;
      const key = `${r.provider}|${r.model}`;
      if (!dayMap.has(day)) dayMap.set(day, new Map());
      const modelMap = dayMap.get(day)!;
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          provider: r.provider, model: r.model, calls: 0,
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cost: 0,
        });
      }
      const e = modelMap.get(key)!;
      e.calls += Number(r.calls);
      e.inputTokens += Number(r.input_tokens);
      e.outputTokens += Number(r.output_tokens);
      e.cacheHitTokens += Number(r.cache_hit_tokens);
      e.cacheMissTokens += Number(r.cache_miss_tokens);
      e.cost += costOf(r.provider, r.model, r.bucket, Number(r.cache_miss_tokens), Number(r.cache_hit_tokens), Number(r.output_tokens));
    }

    const byDay = Array.from(dayMap.entries()).map(([day, modelMap]) => {
      const models = Array.from(modelMap.values())
        .sort((a, b) => b.cost - a.cost)
        .map((m) => ({ ...m, cost: round2(m.cost) }));
      const dayCost = round2(models.reduce((s, m) => s + m.cost, 0));
      const inputTokens = models.reduce((s, m) => s + m.inputTokens, 0);
      const outputTokens = models.reduce((s, m) => s + m.outputTokens, 0);
      return { day, inputTokens, outputTokens, cost: dayCost, models };
    }).sort((a, b) => a.day.localeCompare(b.day));

    const totalCost = round2(byDay.reduce((s, d) => s + d.cost, 0));
    res.json({
      tenantId,
      startDate,
      endDate,
      totalInputToken: byDay.reduce((s, d) => s + d.inputTokens, 0),
      totalOutputToken: byDay.reduce((s, d) => s + d.outputTokens, 0),
      totalCost,
      byDay,
    });
  } catch (err) {
    console.error('llm-usage range failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-token-pricing — list token pricing (admin console).
router.get('/v1/billing/llm-token-pricing', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT provider, model, input_cache_hit_peak, input_cache_hit_offpeak,
              input_cache_miss_peak, input_cache_miss_offpeak, output_peak, output_offpeak,
              currency, updated_at
         FROM llm_token_pricing
        ORDER BY provider, model`,
    );
    res.json({
      pricing: rows.map((r: any) => ({
        provider: r.provider,
        model: r.model,
        inputCacheHitPeak: Number(r.input_cache_hit_peak),
        inputCacheHitOffpeak: Number(r.input_cache_hit_offpeak),
        inputCacheMissPeak: Number(r.input_cache_miss_peak),
        inputCacheMissOffpeak: Number(r.input_cache_miss_offpeak),
        outputPeak: Number(r.output_peak),
        outputOffpeak: Number(r.output_offpeak),
        currency: r.currency,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('llm-token-pricing list failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// PUT /v1/billing/llm-token-pricing — upsert one model's token pricing.
router.put('/v1/billing/llm-token-pricing', async (req, res) => {
  try {
    const b = req.body ?? {};
    const provider = str(b.provider, 64);
    const model = str(b.model, 128);
    if (!provider || !model) {
      res.status(400).json({ code: 'VALIDATION', message: 'provider and model are required' });
      return;
    }
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const inputCacheHitPeak = num(b.inputCacheHitPeak);
    const inputCacheHitOffpeak = num(b.inputCacheHitOffpeak);
    const inputCacheMissPeak = num(b.inputCacheMissPeak);
    const inputCacheMissOffpeak = num(b.inputCacheMissOffpeak);
    const outputPeak = num(b.outputPeak);
    const outputOffpeak = num(b.outputOffpeak);
    if ([inputCacheHitPeak, inputCacheHitOffpeak, inputCacheMissPeak, inputCacheMissOffpeak, outputPeak, outputOffpeak].some((v) => v === null)) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'inputCacheHitPeak/inputCacheHitOffpeak/inputCacheMissPeak/inputCacheMissOffpeak/outputPeak/outputOffpeak are required (>= 0)',
      });
      return;
    }
    await query(
      `INSERT INTO llm_token_pricing
         (provider, model, input_cache_hit_peak, input_cache_hit_offpeak,
          input_cache_miss_peak, input_cache_miss_offpeak, output_peak, output_offpeak, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CNY')
       ON CONFLICT (provider, model) DO UPDATE SET
         input_cache_hit_peak = EXCLUDED.input_cache_hit_peak,
         input_cache_hit_offpeak = EXCLUDED.input_cache_hit_offpeak,
         input_cache_miss_peak = EXCLUDED.input_cache_miss_peak,
         input_cache_miss_offpeak = EXCLUDED.input_cache_miss_offpeak,
         output_peak = EXCLUDED.output_peak,
         output_offpeak = EXCLUDED.output_offpeak,
         updated_at = NOW()`,
      [provider, model, inputCacheHitPeak, inputCacheHitOffpeak, inputCacheMissPeak, inputCacheMissOffpeak, outputPeak, outputOffpeak],
    );
    res.json({ ok: true, provider, model });
  } catch (err) {
    console.error('llm-token-pricing upsert failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
