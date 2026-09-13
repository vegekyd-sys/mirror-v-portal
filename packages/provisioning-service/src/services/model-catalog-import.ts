import { createHmac, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { encryptValue } from './crypto.js';
import { getGlobalLlmProviders, type LlmProvidersConfig } from './llm-providers.js';
import { mergeModelRuntimeParams, type ModelRuntimeParamsV1 } from '../domain/model-catalog.js';
import { stableProviderInstanceId, stableProviderModelId } from './model-catalog.js';

export interface CatalogImportItem {
  provider: string;
  model?: string;
  status: 'imported' | 'skipped' | 'error';
  reason?: string;
}

export interface CatalogImportReport {
  runId: string;
  sourceFingerprint: string;
  dryRun: boolean;
  totalCount: number;
  succeededCount: number;
  skippedCount: number;
  errorCount: number;
  references: Record<string, string | string[] | null>;
  items: CatalogImportItem[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(config: LlmProvidersConfig): string {
  const secret = process.env.RUNTIME_CONFIG_KEY;
  if (!secret) throw new Error('RUNTIME_CONFIG_KEY is not configured');
  return createHmac('sha256', secret).update(canonical(config)).digest('hex');
}

function safeItemError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/api.?key|encrypted|password|secret|token|postgres|sql|constraint/i.test(message)) {
    return 'Item import failed';
  }
  return message.slice(0, 200);
}

/** Imports the current legacy runtime authority into shadow tables only. */
export async function importLegacyCatalog(
  pool: pg.Pool,
  input: { dryRun: boolean; actor: string },
): Promise<CatalogImportReport> {
  const legacy = await getGlobalLlmProviders(pool);
  if (!legacy) throw new Error('No valid global LLM_PROVIDERS configuration exists');
  const sourceFingerprint = fingerprint(legacy);
  const runId = randomUUID();
  const items: CatalogImportItem[] = [];
  let succeededCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const provider of legacy.providers) {
    const providerId = stableProviderInstanceId(provider.name);
    try {
      const existing = await pool.query(
        'SELECT source FROM llm_provider_instances WHERE legacy_provider_name=$1',
        [provider.name],
      );
      if (existing.rows[0] && existing.rows[0].source !== 'legacy-import') {
        skippedCount += 1;
        items.push({ provider: provider.name, status: 'skipped', reason: 'manually-owned provider' });
        continue;
      }
      if (!input.dryRun) {
        await pool.query(
          `INSERT INTO llm_provider_instances
             (id,legacy_provider_name,template_key,display_name,protocol,base_url,encrypted_api_key,source,enabled,metadata)
           VALUES ($1,$2,'custom-openai',$3,'openai-completions',$4,$5,'legacy-import',TRUE,$6)
           ON CONFLICT (legacy_provider_name) DO UPDATE SET
             display_name=EXCLUDED.display_name, base_url=EXCLUDED.base_url,
             encrypted_api_key=EXCLUDED.encrypted_api_key, updated_at=NOW()
           WHERE llm_provider_instances.source='legacy-import'`,
          [providerId, provider.name, provider.label ?? null, provider.baseUrl,
            encryptValue(provider.apiKey), JSON.stringify({ legacyAssumption: 'chat-runtime-config' })],
        );
      }
      succeededCount += 1;
      items.push({ provider: provider.name, status: 'imported' });
    } catch (error) {
      errorCount += 1;
      items.push({ provider: provider.name, status: 'error', reason: safeItemError(error) });
      continue;
    }

    for (const model of provider.models) {
      try {
        const modelId = stableProviderModelId(providerId, model.id);
        const current = await pool.query(
          'SELECT source, override_params FROM llm_provider_models WHERE provider_instance_id=$1 AND model_id=$2',
          [providerId, model.id],
        );
        if (current.rows[0] && (current.rows[0].source !== 'legacy-import' || current.rows[0].override_params)) {
          skippedCount += 1;
          items.push({ provider: provider.name, model: model.id, status: 'skipped', reason: 'manual source or override' });
          continue;
        }
        const legacyOverride: ModelRuntimeParamsV1 = {
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.vision !== undefined ? { vision: model.vision } : {}),
          ...(model.vision === true ? { inputModalities: ['text', 'image'] } : {}),
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
          ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
          ...(model.compat ? { compat: model.compat } : {}),
        };
        const merged = mergeModelRuntimeParams(undefined, legacyOverride);
        if (!input.dryRun) {
          await pool.query(
            `INSERT INTO llm_provider_models
               (id,provider_instance_id,model_id,display_name,model_type,runtime_enabled,
                discovered_params,override_params,effective_params,params_status,source)
             VALUES ($1,$2,$3,$4,'chat',TRUE,NULL,$5,$6,$7,'legacy-import')
             ON CONFLICT (provider_instance_id,model_id) DO UPDATE SET
               display_name=EXCLUDED.display_name, effective_params=EXCLUDED.effective_params,
               params_status=EXCLUDED.params_status, runtime_enabled=TRUE, updated_at=NOW()
             WHERE llm_provider_models.source='legacy-import' AND llm_provider_models.override_params IS NULL`,
            [modelId, providerId, model.id, model.displayName ?? null, JSON.stringify(legacyOverride),
              JSON.stringify(merged.effectiveParams), merged.status],
          );
        }
        succeededCount += 1;
        items.push({ provider: provider.name, model: model.id, status: 'imported' });
      } catch (error) {
        errorCount += 1;
        items.push({ provider: provider.name, model: model.id, status: 'error', reason: safeItemError(error) });
      }
    }
  }

  const report: CatalogImportReport = {
    runId, sourceFingerprint, dryRun: input.dryRun,
    totalCount: items.length, succeededCount, skippedCount, errorCount,
    references: {
      defaultModel: legacy.defaultModel, imageModel: legacy.imageModel,
      compactionModel: legacy.compactionModel, fallbackModels: legacy.fallbackModels,
    },
    items,
  };
  if (!input.dryRun) {
    const status = errorCount === 0 ? 'succeeded' : succeededCount > 0 ? 'partial' : 'failed';
    await pool.query(
      `INSERT INTO llm_catalog_import_runs
         (id,source_kind,source_fingerprint,status,total_count,succeeded_count,skipped_count,error_count,report,finished_at)
       VALUES ($1,'legacy-runtime-config',$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (source_kind,source_fingerprint) DO NOTHING`,
      [runId, sourceFingerprint, status, items.length, succeededCount, skippedCount, errorCount, JSON.stringify(report)],
    );
  }
  return report;
}
