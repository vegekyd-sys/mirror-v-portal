import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  mergeModelRuntimeParams,
  type ModelRuntimeParamsV1,
  type ProviderModelRecord,
} from '../domain/model-catalog.js';
import { decryptValue } from './crypto.js';
import { modelExistsIn, visionModelExistsIn, type LlmModelSpec, type LlmProvidersConfig } from './llm-providers.js';

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

export interface SnapshotDiff {
  addedProviders: string[];
  removedProviders: string[];
  changedProviders: string[];
  addedModels: string[];
  removedModels: string[];
  changedModels: string[];
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
      SELECT p.*, COALESCE(json_agg(m.* ORDER BY m.model_id) FILTER (WHERE m.id IS NOT NULL), '[]') AS models
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
    const catalog = await this.repository.listRuntimeCatalog();
    const snapshot: LlmProvidersConfig = {
      providers: catalog.map(({ provider, models }) => ({
        name: provider.legacyProviderName,
        ...(provider.displayName ? { label: provider.displayName } : {}),
        baseUrl: provider.baseUrl,
        apiKey: decryptValue(provider.encryptedApiKey),
        models: models.filter((model) => model.modelType === 'chat' && model.paramsStatus !== 'invalid').map((model): LlmModelSpec => ({
          id: model.modelId,
          modelType: model.modelType,
          protocol: provider.protocol,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          ...(model.effectiveParams.contextWindow ? { contextWindow: model.effectiveParams.contextWindow } : {}),
          ...(model.effectiveParams.maxOutputTokens ? { maxOutputTokens: model.effectiveParams.maxOutputTokens } : {}),
          ...(model.effectiveParams.inputModalities ? { inputModalities: model.effectiveParams.inputModalities } : {}),
          ...(model.effectiveParams.reasoning !== undefined ? { reasoning: model.effectiveParams.reasoning } : {}),
          ...(model.effectiveParams.vision !== undefined ? { vision: model.effectiveParams.vision } : {}),
          ...(model.effectiveParams.compat ? { compat: model.effectiveParams.compat } : {}),
        })),
      })).filter((provider) => provider.models.length > 0),
      defaultModel: null,
      imageModel: null,
      compactionModel: null,
      fallbackModels: [],
    };
    if (legacy) {
      snapshot.defaultModel = legacy.defaultModel && modelExistsIn(snapshot, legacy.defaultModel) ? legacy.defaultModel : null;
      snapshot.imageModel = legacy.imageModel && visionModelExistsIn(snapshot, legacy.imageModel) ? legacy.imageModel : null;
      snapshot.compactionModel = legacy.compactionModel && modelExistsIn(snapshot, legacy.compactionModel) ? legacy.compactionModel : null;
      snapshot.fallbackModels = legacy.fallbackModels.filter((ref) => modelExistsIn(snapshot, ref) && ref !== snapshot.defaultModel);
    }
    return snapshot;
  }

  /** Compares a previously built snapshot without reading the catalog again. */
  public diffCompatibilitySnapshot(
    legacy: LlmProvidersConfig,
    snapshot: LlmProvidersConfig,
  ): SnapshotDiff {
    const before = new Map(legacy.providers.map((provider) => [provider.name, canonicalJson(provider)]));
    const after = new Map(snapshot.providers.map((provider) => [provider.name, canonicalJson(provider)]));
    const models = (config: LlmProvidersConfig): Map<string, string> => new Map(
      config.providers.flatMap((provider) => provider.models.map((model) => [
        `${provider.name}/${model.id}`, canonicalJson(model),
      ] as const)),
    );
    const beforeModels = models(legacy);
    const afterModels = models(snapshot);
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
      changedModels: [...afterModels.keys()].filter((key) => beforeModels.has(key) && beforeModels.get(key) !== afterModels.get(key)).sort(),
      changedReferences: references
        .filter(([, previous, next]) => canonicalJson(previous) !== canonicalJson(next))
        .map(([reference, previous, next]) => ({ reference, before: previous, after: next })),
      fingerprint: snapshotFingerprint(snapshot),
    };
  }
}
