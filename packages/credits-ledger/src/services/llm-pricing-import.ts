import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

interface LegacyPricingRow {
  provider: string;
  model: string;
  input_cache_hit_peak: string;
  input_cache_hit_offpeak: string;
  input_cache_miss_peak: string;
  input_cache_miss_offpeak: string;
  output_peak: string;
  output_offpeak: string;
  currency: string;
}

export interface PricingImportReport {
  runId: string;
  dryRun: boolean;
  totalCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  sourceFingerprint: string;
  items: Array<{ provider: string; model: string; status: 'imported' | 'skipped' | 'error'; reason?: string }>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function providerInstanceId(provider: string): string {
  return stableId('lpi', `v1\0${provider}`);
}

function providerModelId(providerId: string, model: string): string {
  return stableId('lpm', `v1\0${providerId}\0${model}`);
}

function priceItems(row: LegacyPricingRow, planId: string) {
  const peakMorning = { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '12:00' };
  const peakAfternoon = { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], startTime: '14:00', endTime: '18:00' };
  const offpeakMorning = { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], startTime: '00:00', endTime: '09:00' };
  const offpeakNoon = { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], startTime: '12:00', endTime: '14:00' };
  const offpeakEvening = { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], startTime: '18:00', endTime: '00:00' };
  const weekend = { timezone: 'Asia/Shanghai', weekdays: [0, 6] };
  const specs: Array<[string, string, string, Record<string, unknown>]> = [];
  for (const condition of [peakMorning, peakAfternoon]) {
    specs.push(
      ['input-cache-read', row.input_cache_hit_peak, 'hit', condition],
      ['input-cache-write', row.input_cache_miss_peak, 'miss', condition],
      ['output', row.output_peak, '', condition],
    );
  }
  for (const condition of [offpeakMorning, offpeakNoon, offpeakEvening, weekend]) {
    specs.push(
      ['input-cache-read', row.input_cache_hit_offpeak, 'hit', condition],
      ['input-cache-write', row.input_cache_miss_offpeak, 'miss', condition],
      ['output', row.output_offpeak, '', condition],
    );
  }
  return specs.map(([usageType, unitPrice, cacheState, condition], index) => ({
    id: stableId('lpi', `${planId}\0${index}`), usageType, unitPrice,
    conditions: cacheState ? { ...condition, cacheState } : condition,
  }));
}

/** Idempotently shadows legacy token prices without changing display authority. */
export async function importLegacyPricing(pool: pg.Pool, dryRun: boolean): Promise<PricingImportReport> {
  const { rows } = await pool.query<LegacyPricingRow>(
    `SELECT provider,model,input_cache_hit_peak,input_cache_hit_offpeak,
            input_cache_miss_peak,input_cache_miss_offpeak,output_peak,output_offpeak,currency
       FROM llm_token_pricing ORDER BY provider,model`,
  );
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const runId = randomUUID();
  const items: PricingImportReport['items'] = [];
  let importedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  for (const row of rows) {
    const sourceKey = `legacy:${row.provider}:${row.model}`;
    const planId = stableId('lpp', sourceKey);
    try {
      const existing = await pool.query('SELECT source FROM llm_model_price_plans WHERE source_key=$1', [sourceKey]);
      if (existing.rows.length > 0) {
        skippedCount += 1;
        items.push({ provider: row.provider, model: row.model, status: 'skipped', reason: 'already imported' });
        continue;
      }
      if (!dryRun) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO llm_model_price_plans
               (id,provider_instance_id,provider_model_id,provider_key,model_id,version,status,currency,unit_scale,
                valid_from,source,source_key,contract_version,published_at)
             VALUES ($1,$2,$3,$4,$5,1,'published',$6,1000000,'1970-01-01T00:00:00Z','legacy-import',$7,1,NOW())`,
            [planId, providerInstanceId(row.provider), providerModelId(providerInstanceId(row.provider), row.model), row.provider, row.model, row.currency, sourceKey],
          );
          for (const item of priceItems(row, planId)) {
            await client.query(
              `INSERT INTO llm_model_price_items (id,plan_id,usage_type,unit_price,priority,conditions)
               VALUES ($1,$2,$3,$4,0,$5)`,
              [item.id, planId, item.usageType, item.unitPrice, JSON.stringify(item.conditions)],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      importedCount += 1;
      items.push({ provider: row.provider, model: row.model, status: 'imported' });
    } catch (error) {
      errorCount += 1;
      items.push({ provider: row.provider, model: row.model, status: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const report = { runId, dryRun, totalCount: rows.length, importedCount, skippedCount, errorCount, sourceFingerprint, items };
  if (!dryRun) {
    await pool.query(
      `INSERT INTO llm_price_sync_runs
         (id,source_kind,source_fingerprint,status,total_count,succeeded_count,skipped_count,error_count,report,finished_at)
       VALUES ($1,'legacy-token-pricing',$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (source_kind,source_fingerprint) DO NOTHING`,
      [runId, sourceFingerprint, errorCount === 0 ? 'succeeded' : importedCount > 0 ? 'partial' : 'failed',
        rows.length, importedCount, skippedCount, errorCount, JSON.stringify(report)],
    );
  }
  return report;
}
