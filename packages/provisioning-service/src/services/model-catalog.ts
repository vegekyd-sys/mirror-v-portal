import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  mergeModelRuntimeParams,
  type ModelRuntimeParamsV1,
  type ProviderModelRecord,
} from '../domain/model-catalog.js';
import type { LlmModelSpec, LlmProvidersConfig } from './llm-providers.js';

export interface ProviderInstanceRecord {
  id: string;
  legacyProviderName: string;
  templateKey: string;
  displayName?: string;
  protocol: 'openai-completions';
  baseUrl: string;
  encryptedApiKey: string;
  source: 'legacy-import' | 'manual' | 'builtin-catalog';
  enabled: boolean;
}

export interface SnapshotFallbackWarning {
  providerName: string;
  modelId: string;
  fallbackFields: string[];
}

export interface SnapshotDiff {
  addedProviders: string[];
  removedProviders: string[];
  changedProviders: string[];
  addedModels: string[];
  removedModels: string[];
  changedModels: string[];
  affectedProviders: string[];
  fallbackWarnings: SnapshotFallbackWarning[];
  changedReferences: Array<{
    reference: 'defaultModel' | 'imageModel' | 'compactionModel' | 'fallbackModels';
    before: string | string[] | null;
    after: string | string[] | null;
  }>;
  fingerprint: string;
}

export interface CatalogStatus {
  totals: { providers: number; models: number };
  modelStatuses: { complete: number; incomplete: number; fallback: number; invalid: number };
  recentImportRuns: Array<{
    id: string; sourceKind: string; sourceFingerprint: string; status: string;
    totalCount: number; succeededCount: number; skippedCount: number; errorCount: number;
    startedAt: unknown; finishedAt: unknown;
  }>;
  recentSnapshotBackups: Array<{
    id: string; runtimeConfigId: string | null; sourceFingerprint: string; actor: string | null; createdAt: unknown;
  }>;
}

export function stableProviderInstanceId(legacyProviderName: string): string {
  return `lpi_${createHash('sha256').update(`v1\0${legacyProviderName}`).digest('hex').slice(0, 24)}`;
}

export function stableProviderModelId(providerInstanceId: string, modelId: string): string {
  return `lpm_${createHash('sha256').update(`v1\0${providerInstanceId}\0${modelId}`).digest('hex').slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function snapshotFingerprint(snapshot: LlmProvidersConfig): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function rowToModel(row: Record<string, unknown>): ProviderModelRecord {
  return {
    id: String(row.id),
    providerInstanceId: String(row.provider_instance_id),
    modelId: String(row.model_id),
    ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    modelType: row.model_type as ProviderModelRecord['modelType'],
    runtimeEnabled: row.runtime_enabled === true,
    ...(row.discovered_params ? { discoveredParams: row.discovered_params as ModelRuntimeParamsV1 } : {}),
    ...(row.override_params ? { overrideParams: row.override_params as ModelRuntimeParamsV1 } : {}),
    effectiveParams: row.effective_params as ModelRuntimeParamsV1,
    paramsStatus: row.params_status as ProviderModelRecord['paramsStatus'],
    snapshotApproved: row.snapshot_approved === true,
    schemaVersion: 1,
  };
}

/** SQL repository for the structured, shadow-only catalog. */
export class CatalogRepository {
  constructor(private readonly pool: pg.Pool) {}

  public async findModel(providerId: string, modelId: string): Promise<ProviderModelRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM llm_provider_models WHERE provider_instance_id=$1 AND model_id=$2',
      [providerId, modelId],
    );
    return rows[0] ? rowToModel(rows[0]) : null;
  }

  public async listProviders(): Promise<Array<Omit<ProviderInstanceRecord, 'encryptedApiKey'> & { hasApiKey: boolean }>> {
    const { rows } = await this.pool.query('SELECT * FROM llm_provider_instances ORDER BY legacy_provider_name');
    return rows.map((row) => ({
      id: row.id,
      legacyProviderName: row.legacy_provider_name,
      templateKey: row.template_key,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      protocol: row.protocol,
      baseUrl: row.base_url,
      source: row.source,
      enabled: row.enabled,
      hasApiKey: Boolean(row.encrypted_api_key),
    }));
  }

  public async listModels(providerId: string): Promise<ProviderModelRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM llm_provider_models WHERE provider_instance_id=$1 ORDER BY model_id', [providerId],
    );
    return rows.map(rowToModel);
  }

  /** Returns aggregate and recent audit state without selecting encrypted values or report payloads. */
  public async getStatus(recentLimit = 10): Promise<CatalogStatus> {
    const limit = Math.min(Math.max(Math.trunc(recentLimit), 1), 50);
    const [counts, importRuns, backups] = await Promise.all([
      this.pool.query(`
        SELECT
          (SELECT COUNT(*) FROM llm_provider_instances) AS provider_count,
          COUNT(*) AS model_count,
          COUNT(*) FILTER (WHERE params_status='complete') AS complete_count,
          COUNT(*) FILTER (WHERE params_status='incomplete') AS incomplete_count,
          COUNT(*) FILTER (WHERE params_status='fallback') AS fallback_count,
          COUNT(*) FILTER (WHERE params_status='invalid') AS invalid_count
        FROM llm_provider_models`),
      this.pool.query(`
        SELECT id,source_kind,source_fingerprint,status,total_count,succeeded_count,
               skipped_count,error_count,started_at,finished_at
          FROM llm_catalog_import_runs ORDER BY started_at DESC LIMIT $1`, [limit]),
      this.pool.query(`
        SELECT id,runtime_config_id,source_fingerprint,actor,created_at
          FROM llm_catalog_snapshot_backups ORDER BY created_at DESC LIMIT $1`, [limit]),
    ]);
    const count = counts.rows[0];
    return {
      totals: { providers: Number(count.provider_count), models: Number(count.model_count) },
      modelStatuses: {
        complete: Number(count.complete_count), incomplete: Number(count.incomplete_count),
        fallback: Number(count.fallback_count), invalid: Number(count.invalid_count),
      },
      recentImportRuns: importRuns.rows.map((row) => ({
        id: String(row.id), sourceKind: row.source_kind, sourceFingerprint: row.source_fingerprint,
        status: row.status, totalCount: Number(row.total_count), succeededCount: Number(row.succeeded_count),
        skippedCount: Number(row.skipped_count), errorCount: Number(row.error_count),
        startedAt: row.started_at, finishedAt: row.finished_at,
      })),
      recentSnapshotBackups: backups.rows.map((row) => ({
        id: String(row.id), runtimeConfigId: row.runtime_config_id === null ? null : String(row.runtime_config_id),
        sourceFingerprint: row.source_fingerprint, actor: row.actor ?? null, createdAt: row.created_at,
      })),
    };
  }

  public async listRuntimeCatalog(): Promise<Array<{ provider: ProviderInstanceRecord; models: ProviderModelRecord[] }>> {
    const { rows } = await this.pool.query(`
      SELECT p.*, COALESCE(json_agg((to_jsonb(m) || jsonb_build_object(
        'snapshot_approved', EXISTS (
          SELECT 1
            FROM llm_model_discovery_runs r
           WHERE r.id=m.discovery_run_id
             AND r.provider_instance_id=m.provider_instance_id
             AND r.status='applied'
             AND COALESCE(m.discovered_params, '{}'::jsonb) <> '{}'::jsonb
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_each(COALESCE(m.discovered_params, '{}'::jsonb)) discovered_field
                WHERE NOT EXISTS (
                  SELECT 1
                    FROM llm_model_param_evidence discovered_evidence
                   WHERE discovered_evidence.model_row_id=m.id
                     AND discovered_evidence.run_id=r.id
                     AND discovered_evidence.layer='discovered'
                     AND discovered_evidence.field_name=discovered_field.key
                     AND discovered_evidence.value_json=discovered_field.value
                )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_each(COALESCE(m.override_params, '{}'::jsonb)) override_field
                WHERE NOT EXISTS (
                  SELECT 1
                    FROM llm_model_param_evidence override_evidence
                   WHERE override_evidence.model_row_id=m.id
                     AND override_evidence.layer='override'
                     AND override_evidence.field_name=override_field.key
                     AND override_evidence.value_json=override_field.value
                )
             )
        )
      )) ORDER BY m.model_id) FILTER (WHERE m.id IS NOT NULL), '[]') AS models
      FROM llm_provider_instances p LEFT JOIN llm_provider_models m
        ON m.provider_instance_id=p.id AND m.runtime_enabled=TRUE
      WHERE p.enabled=TRUE GROUP BY p.id ORDER BY p.legacy_provider_name`);
    return rows.map((row) => ({
      provider: {
        id: row.id, legacyProviderName: row.legacy_provider_name, templateKey: row.template_key,
        ...(row.display_name ? { displayName: row.display_name } : {}), protocol: row.protocol,
        baseUrl: row.base_url, encryptedApiKey: row.encrypted_api_key, source: row.source, enabled: row.enabled,
      },
      models: (row.models as Record<string, unknown>[]).map(rowToModel),
    }));
  }
}

const snapshotWarnings = new WeakMap<LlmProvidersConfig, SnapshotFallbackWarning[]>();

function runtimeOverlay(
  legacyModel: LlmModelSpec,
  provider: ProviderInstanceRecord,
  model: ProviderModelRecord,
  params: ModelRuntimeParamsV1,
): LlmModelSpec {
  return {
    ...legacyModel,
    modelType: model.modelType,
    protocol: provider.protocol,
    ...(params.contextWindow !== undefined ? { contextWindow: params.contextWindow } : {}),
    ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
    ...(params.inputModalities !== undefined ? { inputModalities: [...params.inputModalities] } : {}),
    ...(params.reasoning === true ? { reasoning: true } : {}),
    ...(params.vision === true ? { vision: true } : {}),
  };
}

function semanticModel(model: LlmModelSpec): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...model,
    modelType: model.modelType ?? 'chat',
    protocol: model.protocol ?? 'openai-completions',
    reasoning: model.reasoning === true,
    vision: model.vision === true,
  };
  if (model.inputModalities) normalized.inputModalities = [...new Set(model.inputModalities)].sort();
  if (model.compat) {
    normalized.compat = Object.fromEntries(Object.entries(model.compat).sort(([left], [right]) => left.localeCompare(right)));
  }
  return normalized;
}

function providerMetadata(provider: LlmProvidersConfig['providers'][number]): Record<string, unknown> {
  const { models: _models, ...metadata } = provider;
  return metadata;
}

/** Catalog business rules independent of legacy runtime publication. */
export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  public mergeParams(discovered?: ModelRuntimeParamsV1, override?: ModelRuntimeParamsV1) {
    return mergeModelRuntimeParams(discovered, override);
  }

  public async getModel(providerId: string, modelId: string): Promise<ProviderModelRecord | null> {
    return this.repository.findModel(providerId, modelId);
  }

  public validateSlot(model: ProviderModelRecord, slot: 'default' | 'image' | 'compaction' | 'fallback'): void {
    if (model.modelType !== 'chat' || !model.runtimeEnabled || model.paramsStatus === 'invalid') {
      throw new Error(`${slot} requires a runtime-enabled valid chat model`);
    }
    if (slot === 'image' && !model.effectiveParams.inputModalities?.includes('image')) {
      throw new Error('image slot requires image input modality');
    }
  }

  public async buildCompatibilitySnapshot(legacy?: LlmProvidersConfig | null): Promise<LlmProvidersConfig> {
    if (!legacy) throw new Error('Legacy LLM_PROVIDERS is required for an incremental snapshot');
    const catalog = await this.repository.listRuntimeCatalog();
    const catalogByProvider = new Map(catalog.map((item) => [item.provider.legacyProviderName, item]));
    const warnings: SnapshotFallbackWarning[] = [];
    const providers = legacy.providers.map((legacyProvider) => {
      const catalogProvider = catalogByProvider.get(legacyProvider.name);
      if (!catalogProvider) throw new Error(`Catalog provider missing for legacy provider ${legacyProvider.name}`);
      const catalogModels = new Map(catalogProvider.models.map((model) => [model.modelId, model]));
      const models = legacyProvider.models.map((legacyModel) => {
        const catalogModel = catalogModels.get(legacyModel.id);
        if (!catalogModel) throw new Error(`Catalog model missing for legacy model ${legacyProvider.name}/${legacyModel.id}`);
        const provenance = mergeModelRuntimeParams(catalogModel.discoveredParams, catalogModel.overrideParams);
        const approved = catalogModel.paramsStatus === 'complete' && catalogModel.snapshotApproved === true &&
          provenance.status === 'complete' && provenance.fallbackFields.length === 0;
        if (!approved) {
          warnings.push({
            providerName: legacyProvider.name,
            modelId: legacyModel.id,
            fallbackFields: [...provenance.fallbackFields],
          });
          return { ...legacyModel };
        }
        return runtimeOverlay(
          legacyModel,
          catalogProvider.provider,
          catalogModel,
          provenance.effectiveParams,
        );
      });
      return { ...legacyProvider, models };
    });
    const snapshot: LlmProvidersConfig = {
      ...legacy,
      providers,
      defaultModel: legacy.defaultModel,
      imageModel: legacy.imageModel,
      compactionModel: legacy.compactionModel,
      fallbackModels: [...legacy.fallbackModels],
    };
    snapshotWarnings.set(snapshot, warnings);
    return snapshot;
  }

  /** Compares a previously built snapshot without reading the catalog again. */
  public diffCompatibilitySnapshot(
    legacy: LlmProvidersConfig,
    snapshot: LlmProvidersConfig,
  ): SnapshotDiff {
    const before = new Map(legacy.providers.map((provider) => [provider.name, canonicalJson(providerMetadata(provider))]));
    const after = new Map(snapshot.providers.map((provider) => [provider.name, canonicalJson(providerMetadata(provider))]));
    const models = (config: LlmProvidersConfig): Map<string, string> => new Map(
      config.providers.flatMap((provider) => provider.models.map((model) => [
        `${provider.name}/${model.id}`, canonicalJson(semanticModel(model)),
      ] as const)),
    );
    const beforeModels = models(legacy);
    const afterModels = models(snapshot);
    const changedModels = [...afterModels.keys()]
      .filter((key) => beforeModels.has(key) && beforeModels.get(key) !== afterModels.get(key))
      .sort();
    const references = [
      ['defaultModel', legacy.defaultModel, snapshot.defaultModel],
      ['imageModel', legacy.imageModel, snapshot.imageModel],
      ['compactionModel', legacy.compactionModel, snapshot.compactionModel],
      ['fallbackModels', legacy.fallbackModels, snapshot.fallbackModels],
    ] as const;
    return {
      addedProviders: [...after.keys()].filter((key) => !before.has(key)).sort(),
      removedProviders: [...before.keys()].filter((key) => !after.has(key)).sort(),
      changedProviders: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
      addedModels: [...afterModels.keys()].filter((key) => !beforeModels.has(key)).sort(),
      removedModels: [...beforeModels.keys()].filter((key) => !afterModels.has(key)).sort(),
      changedModels,
      affectedProviders: [...new Set(changedModels.map((key) => key.slice(0, key.indexOf('/'))))].sort(),
      fallbackWarnings: snapshotWarnings.get(snapshot) ?? [],
      changedReferences: references
        .filter(([, previous, next]) => canonicalJson(previous) !== canonicalJson(next))
        .map(([reference, previous, next]) => ({ reference, before: previous, after: next })),
      fingerprint: snapshotFingerprint(snapshot),
    };
  }
}
