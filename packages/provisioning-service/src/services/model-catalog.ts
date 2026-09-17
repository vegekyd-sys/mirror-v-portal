import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  mergeModelRuntimeParams,
  type ModelRuntimeParamsV1,
  type ModelType,
  type ProviderInstanceInput,
  type ProviderMutation,
  type GlobalModelPolicyInput,
  type GlobalModelPolicyRecord,
  type ProviderModelRecord,
} from '../domain/model-catalog.js';
import { encryptValue, decryptValue, maskValue } from './crypto.js';
import type { LlmModelSpec, LlmProviderSpec, LlmProvidersConfig } from './llm-providers.js';

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
  revision?: number;
  metadata?: Record<string, unknown>;
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
    ...(row.revision !== undefined ? { revision: Number(row.revision) } : {}),
    ...(row.source ? { source: String(row.source) } : {}),
  };
}

function rowToProvider(row: Record<string, unknown>): ProviderInstanceRecord {
  return {
    id: String(row.id),
    legacyProviderName: String(row.legacy_provider_name),
    templateKey: String(row.template_key),
    ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    protocol: row.protocol as ProviderInstanceRecord['protocol'],
    baseUrl: String(row.base_url),
    encryptedApiKey: String(row.encrypted_api_key),
    source: row.source as ProviderInstanceRecord['source'],
    enabled: row.enabled === true,
    ...(row.revision !== undefined ? { revision: Number(row.revision) } : {}),
    ...(row.metadata ? { metadata: row.metadata as Record<string, unknown> } : {}),
  };
}

/** Mask an encrypted API key for safe display — decrypts then masks, never returns full. */
function maskEncryptedApiKey(encryptedApiKey: string): string {
  if (!encryptedApiKey) return ''
  try { return maskValue(decryptValue(encryptedApiKey)) } catch { return '••••••••' }
}

/**
 * Convert a stable model row ID (lpm_…) into the legacy "providerName/modelId"
 * reference format used by LlmProvidersConfig, using a runtime catalog snapshot.
 */
export function modelRowIdToLegacyRef(
  catalog: Array<{ provider: ProviderInstanceRecord; models: ProviderModelRecord[] }>,
  modelRowId: string,
): string | null {
  for (const { provider, models } of catalog) {
    const model = models.find((m) => m.id === modelRowId)
    if (model) return `${provider.legacyProviderName}/${model.modelId}`
  }
  return null
}

/**
 * Convert a legacy "providerName/modelId" reference into the stable model row
 * ID (lpm_…) that backs it in the catalog.
 */
export function legacyRefToModelRowId(
  catalog: Array<{ provider: ProviderInstanceRecord; models: ProviderModelRecord[] }>,
  ref: string,
): string | null {
  const slashIdx = ref.indexOf('/')
  if (slashIdx < 0) return null
  const providerName = ref.slice(0, slashIdx)
  const modelId = ref.slice(slashIdx + 1)
  for (const { provider, models } of catalog) {
    if (provider.legacyProviderName !== providerName) continue
    const model = models.find((m) => m.modelId === modelId)
    if (model) return model.id
  }
  return null
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
      ...(row.revision !== undefined ? { revision: Number(row.revision) } : {}),
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

  /** List enabled providers and all models for reference validation, including disabled models. */
  public async listCatalogReferenceCandidates(): Promise<Array<{ provider: ProviderInstanceRecord; models: ProviderModelRecord[] }>> {
    const { rows } = await this.pool.query(`
      SELECT p.*, COALESCE(json_agg(to_jsonb(m) ORDER BY m.model_id)
        FILTER (WHERE m.id IS NOT NULL), '[]') AS models
        FROM llm_provider_instances p
        LEFT JOIN llm_provider_models m ON m.provider_instance_id=p.id
       WHERE p.enabled=TRUE
       GROUP BY p.id
       ORDER BY p.legacy_provider_name`);
    return rows.map((row) => ({
      provider: rowToProvider(row),
      models: (row.models as Record<string, unknown>[]).map(rowToModel),
    }));
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
        ...(row.revision !== undefined ? { revision: Number(row.revision) } : {}),
      },
      models: (row.models as Record<string, unknown>[]).map(rowToModel),
    }));
  }

  // ── Provider CRUD ──────────────────────────────────────────────────────

  /** Create a new provider instance with revision=0 and source='manual'. */
  public async createProvider(input: ProviderInstanceInput): Promise<ProviderInstanceRecord> {
    const id = stableProviderInstanceId(input.legacyProviderName)
    const encryptedApiKey = input.apiKey ? encryptValue(input.apiKey) : ''
    const { rows } = await this.pool.query(
      `INSERT INTO llm_provider_instances
         (id, legacy_provider_name, template_key, display_name, protocol, base_url,
          encrypted_api_key, source, enabled, metadata, revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,0)
       ON CONFLICT (legacy_provider_name) DO NOTHING
       RETURNING *`,
      [id, input.legacyProviderName, input.templateKey, input.displayName ?? null,
       input.protocol, input.baseUrl, encryptedApiKey, input.enabled,
       JSON.stringify(input.metadata ?? {})],
    )
    if (!rows.length) throw new Error(`Provider "${input.legacyProviderName}" already exists`)
    return rowToProvider(rows[0])
  }

  /** Update a provider with CAS on revision. apiKey omitted → unchanged. */
  public async updateProvider(
    id: string, mutation: ProviderMutation, expectedRevision: number,
  ): Promise<ProviderInstanceRecord> {
    const sets: string[] = []
    const vals: unknown[] = [id, expectedRevision]
    let idx = 3
    if (mutation.displayName !== undefined) { sets.push(`display_name=$${idx++}`); vals.push(mutation.displayName) }
    if (mutation.templateKey !== undefined) { sets.push(`template_key=$${idx++}`); vals.push(mutation.templateKey) }
    if (mutation.protocol !== undefined) { sets.push(`protocol=$${idx++}`); vals.push(mutation.protocol) }
    if (mutation.baseUrl !== undefined) { sets.push(`base_url=$${idx++}`); vals.push(mutation.baseUrl) }
    if (mutation.apiKey !== undefined) { sets.push(`encrypted_api_key=$${idx++}`); vals.push(encryptValue(mutation.apiKey)) }
    if (mutation.enabled !== undefined) { sets.push(`enabled=$${idx++}`); vals.push(mutation.enabled) }
    if (mutation.metadata !== undefined) { sets.push(`metadata=$${idx++}`); vals.push(JSON.stringify(mutation.metadata)) }
    sets.push(`revision=revision+1`)
    sets.push(`updated_at=NOW()`)
    const { rows } = await this.pool.query(
      `UPDATE llm_provider_instances SET ${sets.join(', ')}
       WHERE id=$1 AND revision=$2 RETURNING *`,
      vals,
    )
    if (!rows.length) {
      const existing = await this.findProvider(id)
      if (!existing) throw new Error(`Provider "${id}" not found`)
      throw new Error(`STALE_REVISION: expected ${expectedRevision}, got ${existing.revision}`)
    }
    return rowToProvider(rows[0])
  }

  /** Soft-delete: set enabled=false. Checks for runtime_enabled models first. */
  public async deleteProvider(id: string): Promise<void> {
    const { rows: activeModels } = await this.pool.query(
      `SELECT 1 FROM llm_provider_models WHERE provider_instance_id=$1 AND runtime_enabled=TRUE LIMIT 1`,
      [id],
    )
    if (activeModels.length) throw new Error('PROVIDER_HAS_RUNTIME_MODELS: disable or remove runtime-enabled models first')
    const { rowCount } = await this.pool.query(
      `UPDATE llm_provider_instances SET enabled=FALSE, updated_at=NOW() WHERE id=$1`,
      [id],
    )
    if (!rowCount) throw new Error(`Provider "${id}" not found`)
  }

  /** Find a single provider by stable ID. */
  public async findProvider(id: string): Promise<ProviderInstanceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_provider_instances WHERE id=$1`, [id],
    )
    return rows[0] ? rowToProvider(rows[0]) : null
  }

  /** Find a single provider by legacy name. */
  public async findProviderByName(name: string): Promise<ProviderInstanceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_provider_instances WHERE legacy_provider_name=$1`, [name],
    )
    return rows[0] ? rowToProvider(rows[0]) : null
  }

  // ── Model CRUD ─────────────────────────────────────────────────────────

  /** Create a new model under a provider with effective_params={}, status='incomplete'. */
  public async createModel(
    providerInstanceId: string,
    input: { modelId: string; displayName?: string; modelType: ModelType; runtimeEnabled: boolean },
  ): Promise<ProviderModelRecord> {
    const id = stableProviderModelId(providerInstanceId, input.modelId)
    const { rows } = await this.pool.query(
      `INSERT INTO llm_provider_models
         (id, provider_instance_id, model_id, display_name, model_type, runtime_enabled,
          discovered_params, override_params, effective_params, params_schema_version,
          params_status, source, revision)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,'{}'::jsonb,1,'incomplete','manual',0)
       ON CONFLICT (provider_instance_id, model_id) DO NOTHING
       RETURNING *`,
      [id, providerInstanceId, input.modelId, input.displayName ?? null,
       input.modelType, input.runtimeEnabled],
    )
    if (!rows.length) throw new Error(`Model "${input.modelId}" already exists under provider "${providerInstanceId}"`)
    return rowToModel(rows[0])
  }

  /** Update a model with CAS on revision. */
  public async updateModel(
    id: string,
    mutation: { displayName?: string; modelType?: ModelType; runtimeEnabled?: boolean },
    expectedRevision: number,
  ): Promise<ProviderModelRecord> {
    const sets: string[] = []
    const vals: unknown[] = [id, expectedRevision]
    let idx = 3
    if (mutation.displayName !== undefined) { sets.push(`display_name=$${idx++}`); vals.push(mutation.displayName) }
    if (mutation.modelType !== undefined) { sets.push(`model_type=$${idx++}`); vals.push(mutation.modelType) }
    if (mutation.runtimeEnabled !== undefined) { sets.push(`runtime_enabled=$${idx++}`); vals.push(mutation.runtimeEnabled) }
    sets.push(`revision=revision+1`)
    sets.push(`updated_at=NOW()`)
    const { rows } = await this.pool.query(
      `UPDATE llm_provider_models SET ${sets.join(', ')}
       WHERE id=$1 AND revision=$2 RETURNING *`,
      vals,
    )
    if (!rows.length) {
      const { rows: check } = await this.pool.query(
        `SELECT revision FROM llm_provider_models WHERE id=$1`, [id],
      )
      if (!check.length) throw new Error(`Model "${id}" not found`)
      throw new Error(`STALE_REVISION: expected ${expectedRevision}, got ${check[0].revision}`)
    }
    return rowToModel(rows[0])
  }

  /** Soft-delete: set runtime_enabled=false. */
  public async deleteModel(id: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE llm_provider_models SET runtime_enabled=FALSE, updated_at=NOW() WHERE id=$1`,
      [id],
    )
    if (!rowCount) throw new Error(`Model "${id}" not found`)
  }

  /** Toggle runtime_enabled with CAS on revision. */
  public async setModelRuntimeEnabled(
    id: string, enabled: boolean, expectedRevision: number,
  ): Promise<ProviderModelRecord> {
    const { rows } = await this.pool.query(
      `UPDATE llm_provider_models SET runtime_enabled=$3, revision=revision+1, updated_at=NOW()
       WHERE id=$1 AND revision=$2 RETURNING *`,
      [id, expectedRevision, enabled],
    )
    if (!rows.length) {
      const { rows: check } = await this.pool.query(
        `SELECT revision FROM llm_provider_models WHERE id=$1`, [id],
      )
      if (!check.length) throw new Error(`Model "${id}" not found`)
      throw new Error(`STALE_REVISION: expected ${expectedRevision}, got ${check[0].revision}`)
    }
    return rowToModel(rows[0])
  }

  // ── Global Model Policy CRUD ───────────────────────────────────────────

  /** Get the singleton global model policy row, or null if unset. */
  public async getGlobalModelPolicy(): Promise<GlobalModelPolicyRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_global_model_policy WHERE id='current'`,
    )
    if (!rows.length) return null
    const row = rows[0]
    return {
      defaultModel: row.default_model === null ? null : String(row.default_model),
      imageModel: row.image_model === null ? null : String(row.image_model),
      compactionModel: row.compaction_model === null ? null : String(row.compaction_model),
      fallbackModels: Array.isArray(row.fallback_models) ? row.fallback_models as string[] : [],
      revision: Number(row.revision),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    }
  }

  /**
   * Update the global model policy with CAS on revision.
   * Validates that all referenced model IDs exist and are runtime_enabled.
   */
  public async updateGlobalModelPolicy(
    input: GlobalModelPolicyInput,
    expectedRevision: number,
    updatedBy: string | null,
  ): Promise<GlobalModelPolicyRecord> {
    const refs = [...new Set([
      input.defaultModel, input.imageModel, input.compactionModel,
      ...input.fallbackModels,
    ].filter((r): r is string => r !== null))]
    // Validate references and mutate the policy in one statement. This closes the
    // SELECT→UPDATE window in which a model/provider could otherwise be disabled.
    const { rows } = await this.pool.query(
      `UPDATE llm_global_model_policy policy
         SET default_model=$2, image_model=$3, compaction_model=$4,
             fallback_models=$5, revision=policy.revision+1, updated_by=$6, updated_at=NOW()
       WHERE policy.id='current'
         AND policy.revision=$1
         AND NOT EXISTS (
           SELECT 1
             FROM unnest($7::text[]) requested(id)
            WHERE NOT EXISTS (
              SELECT 1
                FROM llm_provider_models model
                JOIN llm_provider_instances provider ON provider.id=model.provider_instance_id
               WHERE model.id=requested.id
                 AND model.runtime_enabled=TRUE
                 AND model.params_status <> 'invalid'
                 AND provider.enabled=TRUE
            )
         )
       RETURNING policy.*`,
      [expectedRevision,
       input.defaultModel, input.imageModel, input.compactionModel,
       input.fallbackModels, updatedBy, refs],
    )
    if (!rows.length) {
      const [{ rows: policyRows }, { rows: validRows }] = await Promise.all([
        this.pool.query(`SELECT revision FROM llm_global_model_policy WHERE id='current'`),
        refs.length === 0
          ? Promise.resolve({ rows: [] })
          : this.pool.query(
            `SELECT model.id
               FROM llm_provider_models model
               JOIN llm_provider_instances provider ON provider.id=model.provider_instance_id
              WHERE model.id = ANY($1::text[])
                AND model.runtime_enabled=TRUE
                AND model.params_status <> 'invalid'
                AND provider.enabled=TRUE`,
            [refs],
          ),
      ])
      if (!policyRows.length) throw new Error('Global model policy row not found')
      if (Number(policyRows[0].revision) !== expectedRevision) {
        throw new Error(`STALE_REVISION: expected ${expectedRevision}, got ${policyRows[0].revision}`)
      }
      const found = new Set(validRows.map((candidate) => String(candidate.id)))
      const missing = refs.filter((ref) => !found.has(ref))
      throw new Error(`DANGLING_MODEL_REFERENCE: models or providers not found or not runtime-enabled: ${missing.join(', ')}`)
    }
    const row = rows[0]
    return {
      defaultModel: row.default_model === null ? null : String(row.default_model),
      imageModel: row.image_model === null ? null : String(row.image_model),
      compactionModel: row.compaction_model === null ? null : String(row.compaction_model),
      fallbackModels: Array.isArray(row.fallback_models) ? row.fallback_models as string[] : [],
      revision: Number(row.revision),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    }
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

  /**
   * Build a complete LlmProvidersConfig from the pure Catalog — no legacy
   * JSON skeleton required. Queries enabled providers + runtime-enabled
   * models + the global model policy, then converts stable model row IDs
   * (lpm_…) into the legacy "providerName/modelId" reference format.
   *
   * For each model, the stored effective_params (merge of discovered + override
   * + SAFE_FALLBACK) are projected onto the LlmModelSpec fields. Models whose
   * effective params are incomplete/fallback still get SAFE_FALLBACK values
   * (inputModalities=['text'], outputModalities=['text']).
   */
  public async buildCatalogSnapshot(): Promise<LlmProvidersConfig> {
    const catalog = await this.repository.listRuntimeCatalog();
    const policy = await this.repository.getGlobalModelPolicy();

    const modelRowIdMap = new Map<string, { providerName: string; modelId: string }>();
    const providers: LlmProviderSpec[] = [];

    for (const { provider, models } of catalog) {
      let apiKey = ''
      try { apiKey = decryptValue(provider.encryptedApiKey) } catch { /* leave empty */ }
      const providerModels: LlmModelSpec[] = models.map((model) => {
        modelRowIdMap.set(model.id, {
          providerName: provider.legacyProviderName,
          modelId: model.modelId,
        })
        const params = model.effectiveParams
        return {
          id: model.modelId,
          ...(model.displayName ? { displayName: model.displayName } : {}),
          modelType: model.modelType,
          protocol: provider.protocol,
          ...(params.contextWindow !== undefined ? { contextWindow: params.contextWindow } : {}),
          ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
          ...(params.inputModalities !== undefined ? { inputModalities: [...params.inputModalities] } : {}),
          ...(params.reasoning === true ? { reasoning: true } : {}),
          ...(params.vision === true ? { vision: true } : {}),
        } as LlmModelSpec
      })
      providers.push({
        name: provider.legacyProviderName,
        ...(provider.displayName ? { label: provider.displayName } : {}),
        baseUrl: provider.baseUrl,
        apiKey,
        models: providerModels,
      })
    }

    const convertRef = (rowId: string | null): string | null => {
      if (!rowId) return null
      const mapping = modelRowIdMap.get(rowId)
      return mapping ? `${mapping.providerName}/${mapping.modelId}` : null
    }

    const snapshot: LlmProvidersConfig = {
      providers,
      defaultModel: policy ? convertRef(policy.defaultModel) : null,
      imageModel: policy ? convertRef(policy.imageModel) : null,
      compactionModel: policy ? convertRef(policy.compactionModel) : null,
      fallbackModels: policy
        ? policy.fallbackModels.map(convertRef).filter((r): r is string => r !== null)
        : [],
    }
    return snapshot
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
