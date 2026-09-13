import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ModelRuntimeParamsV1Schema,
  mergeModelRuntimeParams,
  type ModelRuntimeParamsV1,
  type ParamsStatus,
} from '../domain/model-catalog.js';
import { BuiltinModelParamSource } from './model-param-sources/builtin.js';
import { OpenAiCompatibleModelParamSource } from './model-param-sources/openai-compatible.js';
import type {
  DiscoveryCandidate,
  DiscoverySource,
  EvidenceSourceKind,
  FieldEvidence,
  ModelParamAdapter,
  ModelParamSourceAdapter,
} from './model-param-sources/types.js';
import { ModelParamSourceUnavailableError } from './model-param-sources/types.js';

const RUN_TTL_MS = 15 * 60 * 1000;
const ALLOWED_OVERRIDE_SOURCES = new Set<EvidenceSourceKind>(['official-doc', 'manual-contract']);

export class ModelParamDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ModelParamDiscoveryError';
  }
}

interface ModelRow {
  id: string;
  provider_instance_id: string;
  model_id: string;
  discovered_params: ModelRuntimeParamsV1 | null;
  override_params: ModelRuntimeParamsV1 | null;
  effective_params: ModelRuntimeParamsV1;
  params_status: ParamsStatus;
  revision: string | number;
  updated_at: Date | string;
}

interface FrozenModelCandidate {
  modelRowId: string;
  modelId: string;
  expectedUpdatedAt: string;
  candidate: DiscoveryCandidate;
  candidateEffectiveParams: ModelRuntimeParamsV1;
  candidateStatus: ParamsStatus;
  fallbackFields: string[];
}

export interface DiscoveryPreviewInput {
  providerInstanceId: string;
  modelIds?: string[];
  adapter: ModelParamAdapter;
  actor: string;
}

export interface DiscoveryApplyInput {
  previewRunId: string;
  expectedProviderRevision: string;
  selections: Array<{ modelRowId: string; expectedUpdatedAt: string }>;
  actor: string;
}

export interface OverrideEvidenceInput {
  sourceKind: 'official-doc' | 'manual-contract';
  sourceUrl?: string;
  sourceVersion?: string;
  observedAt: string;
  rawSha256?: string;
  notes?: string;
}

export interface OverrideInput {
  expectedUpdatedAt: string;
  overrideParams: ModelRuntimeParamsV1;
  evidence: OverrideEvidenceInput;
  actor: string;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function paramsOrEmpty(value: unknown): ModelRuntimeParamsV1 {
  return ModelRuntimeParamsV1Schema.parse(value ?? {});
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function findOverrideConflicts(
  discovered: ModelRuntimeParamsV1,
  override: ModelRuntimeParamsV1,
): DiscoveryCandidate['conflicts'] {
  return Object.entries(override).flatMap(([field, currentOverride]) => {
    const discoveredValue = (discovered as Record<string, unknown>)[field];
    if (discoveredValue === undefined || canonicalJson(currentOverride) === canonicalJson(discoveredValue)) return [];
    return [{
      field,
      currentOverride,
      discovered: discoveredValue,
      reason: 'override-differs-from-discovered' as const,
    }];
  });
}

function modelState(row: ModelRow): Record<string, unknown> {
  return {
    discoveredParams: row.discovered_params ?? null,
    overrideParams: row.override_params ?? {},
    effectiveParams: row.effective_params,
    paramsStatus: row.params_status,
    revision: Number(row.revision),
    updatedAt: asIso(row.updated_at),
  };
}

function registry(adapter: ModelParamAdapter): ModelParamSourceAdapter {
  if (adapter === 'builtin-catalog') return new BuiltinModelParamSource();
  if (adapter === 'provider-api') return new OpenAiCompatibleModelParamSource();
  throw new ModelParamDiscoveryError('MODEL_CATALOG_ADAPTER_INVALID', 'Unsupported discovery adapter', 422);
}

function validateModelIds(modelIds: unknown): string[] | undefined {
  if (modelIds === undefined) return undefined;
  if (!Array.isArray(modelIds) || modelIds.length === 0 || modelIds.length > 100 ||
      modelIds.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 100)) {
    throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'modelIds must be 1..100 valid model IDs', 400);
  }
  return [...new Set(modelIds as string[])].sort();
}

function validateEvidence(input: OverrideEvidenceInput): void {
  if (!ALLOWED_OVERRIDE_SOURCES.has(input.sourceKind)) {
    throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'Unsupported override evidence source', 400);
  }
  if (Number.isNaN(Date.parse(input.observedAt))) {
    throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'evidence.observedAt must be ISO datetime', 400);
  }
  if (input.sourceUrl) {
    let parsed: URL;
    try { parsed = new URL(input.sourceUrl); } catch {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'evidence.sourceUrl is invalid', 400);
    }
    if (parsed.protocol !== 'https:') {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'evidence.sourceUrl must use HTTPS', 400);
    }
  }
  if (!input.sourceUrl && !input.rawSha256 && !input.notes) {
    throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'evidence requires sourceUrl, rawSha256, or notes', 400);
  }
  if (input.rawSha256 && !/^[a-f0-9]{64}$/i.test(input.rawSha256)) {
    throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'evidence.rawSha256 must be SHA-256 hex', 400);
  }
}

async function writeEvidence(
  client: pg.PoolClient,
  input: {
    modelRowId: string;
    runId?: string;
    layer: 'discovered' | 'override';
    evidence: FieldEvidence[];
    actor: string;
  },
): Promise<void> {
  for (const item of input.evidence) {
    await client.query(
      `INSERT INTO llm_model_param_evidence
         (id,model_row_id,run_id,layer,field_name,value_json,source_kind,source_url,
          source_version,observed_at,raw_sha256,confidence,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), input.modelRowId, input.runId ?? null, input.layer, item.field,
        JSON.stringify(item.rawValue), item.sourceKind, item.sourceUrl ?? null,
        item.sourceVersion ?? null, item.observedAt, item.rawSha256, item.confidence,
        item.notes ?? null, input.actor],
    );
  }
}

/** Preview/apply orchestration for shadow-only model parameter layers. */
export class ModelParamDiscoveryService {
  constructor(private readonly pool: pg.Pool) {}

  public async preview(input: DiscoveryPreviewInput): Promise<Record<string, unknown>> {
    const modelIds = validateModelIds(input.modelIds);
    const providerResult = await this.pool.query(
      `SELECT id,legacy_provider_name,template_key,base_url,updated_at
         FROM llm_provider_instances WHERE id=$1`,
      [input.providerInstanceId],
    );
    const provider = providerResult.rows[0];
    if (!provider) throw new ModelParamDiscoveryError('MODEL_CATALOG_PROVIDER_NOT_FOUND', 'Provider not found', 404);
    const modelResult = await this.pool.query(
      `SELECT id,provider_instance_id,model_id,discovered_params,override_params,
              effective_params,params_status,revision,updated_at
         FROM llm_provider_models
        WHERE provider_instance_id=$1
          AND ($2::text[] IS NULL OR model_id=ANY($2::text[]))
        ORDER BY id`,
      [input.providerInstanceId, modelIds ?? null],
    );
    const rows = modelResult.rows as ModelRow[];
    if (rows.length === 0 || (modelIds && rows.length !== modelIds.length)) {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_MODEL_NOT_FOUND', 'One or more models were not found', 404);
    }
    const sourceAdapter = registry(input.adapter);
    let discovered: Awaited<ReturnType<ModelParamSourceAdapter['preview']>>;
    try {
      discovered = await sourceAdapter.preview({
        provider: {
          id: String(provider.id),
          legacyProviderName: String(provider.legacy_provider_name),
          templateKey: String(provider.template_key),
          baseUrl: String(provider.base_url),
          updatedAt: asIso(provider.updated_at),
        },
        modelIds: rows.map((row) => row.model_id),
      });
    } catch (error) {
      if (error instanceof ModelParamSourceUnavailableError) {
        throw new ModelParamDiscoveryError(
          'MODEL_CATALOG_PARAM_SOURCE_UNSUPPORTED',
          error.message,
          422,
        );
      }
      throw error;
    }
    const byModel = new Map(discovered.candidates.map((candidate) => [candidate.modelId, candidate]));
    const frozen: FrozenModelCandidate[] = rows.map((row) => {
      const candidate = byModel.get(row.model_id);
      if (!candidate) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_SOURCE_INVALID', 'Discovery source omitted a requested model', 422);
      }
      let candidateEffectiveParams: ModelRuntimeParamsV1 = row.effective_params;
      let candidateStatus: ParamsStatus = 'invalid';
      let fallbackFields: string[] = [];
      try {
        const candidateParams = paramsOrEmpty(candidate.params);
        const overrideParams = paramsOrEmpty(row.override_params);
        candidate.params = candidateParams;
        candidate.conflicts = [...candidate.conflicts, ...findOverrideConflicts(candidateParams, overrideParams)];
        const merged = mergeModelRuntimeParams(candidateParams, overrideParams);
        candidateEffectiveParams = merged.effectiveParams;
        candidateStatus = candidate.unresolvedFields.length > 0 && merged.status === 'complete' ? 'incomplete' : merged.status;
        fallbackFields = merged.fallbackFields;
      } catch {
        candidateStatus = 'invalid';
      }
      return {
        modelRowId: row.id,
        modelId: row.model_id,
        expectedUpdatedAt: asIso(row.updated_at),
        candidate,
        candidateEffectiveParams,
        candidateStatus,
        fallbackFields,
      };
    });
    const runId = randomUUID();
    const expiresAt = new Date(Date.now() + RUN_TTL_MS).toISOString();
    const providerRevision = asIso(provider.updated_at);
    await this.pool.query(
      `INSERT INTO llm_model_discovery_runs
         (id,provider_instance_id,adapter,status,requested_model_ids,candidates,source_kind,
          source_url,source_version,raw_response_sha256,provider_revision,expires_at,created_by)
       VALUES ($1,$2,$3,'previewed',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [runId, input.providerInstanceId, input.adapter, JSON.stringify(rows.map((row) => row.model_id)),
        JSON.stringify(frozen), discovered.source.kind, discovered.source.url ?? null,
        discovered.source.version ?? null, discovered.source.rawSha256, providerRevision,
        expiresAt, input.actor],
    );
    return {
      runId,
      providerInstanceId: input.providerInstanceId,
      adapter: input.adapter,
      source: discovered.source,
      providerRevision,
      expiresAt,
      models: frozen.map((item) => {
        const row = rows.find((candidateRow) => candidateRow.id === item.modelRowId)!;
        return {
          modelRowId: item.modelRowId,
          modelId: item.modelId,
          expectedUpdatedAt: item.expectedUpdatedAt,
          current: modelState(row),
          candidateDiscoveredParams: item.candidate.params,
          candidateEffectiveParams: item.candidateEffectiveParams,
          candidateStatus: item.candidateStatus,
          fallbackFields: item.fallbackFields,
          fieldEvidence: item.candidate.evidence,
          conflicts: item.candidate.conflicts,
          unresolvedFields: item.candidate.unresolvedFields,
          status: item.candidateStatus === 'invalid' ? 'invalid' :
            item.candidate.conflicts.length > 0 ? 'conflict' :
              item.candidate.unresolvedFields.length > 0 ? 'unresolved' : 'ready',
        };
      }),
    };
  }

  public async apply(input: DiscoveryApplyInput): Promise<Record<string, unknown>> {
    if (!Array.isArray(input.selections) || input.selections.length === 0) {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'selections must not be empty', 400);
    }
    const uniqueSelections = new Map(input.selections.map((item) => [item.modelRowId, item]));
    if (uniqueSelections.size !== input.selections.length || input.selections.some((item) => (
      typeof item.modelRowId !== 'string' || typeof item.expectedUpdatedAt !== 'string'
    ))) {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'Invalid or duplicate selections', 400);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runResult = await client.query(
        'SELECT * FROM llm_model_discovery_runs WHERE id=$1 FOR UPDATE', [input.previewRunId],
      );
      const run = runResult.rows[0];
      if (!run) throw new ModelParamDiscoveryError('MODEL_CATALOG_RUN_NOT_FOUND', 'Preview run not found', 404);
      const selectionIds = [...uniqueSelections.keys()].sort();
      if (run.status === 'applied') {
        if (JSON.stringify(run.applied_selection_ids) !== JSON.stringify(selectionIds)) {
          throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Run was applied with different selections', 409);
        }
        await client.query('COMMIT');
        return run.apply_result as Record<string, unknown>;
      }
      if (run.status !== 'previewed' || new Date(run.expires_at).getTime() <= Date.now()) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_RUN_EXPIRED', 'Preview run is no longer applicable', 409);
      }
      if (String(run.provider_revision) !== input.expectedProviderRevision) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Provider revision changed', 409);
      }
      const provider = await client.query(
        'SELECT updated_at FROM llm_provider_instances WHERE id=$1 FOR SHARE', [run.provider_instance_id],
      );
      if (!provider.rows[0] || asIso(provider.rows[0].updated_at) !== input.expectedProviderRevision) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Provider revision changed', 409);
      }
      const frozen = run.candidates as FrozenModelCandidate[];
      const frozenById = new Map(frozen.map((item) => [item.modelRowId, item]));
      if (selectionIds.some((id) => !frozenById.has(id))) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'Selection is not part of preview run', 400);
      }
      const rowsResult = await client.query(
        `SELECT id,provider_instance_id,model_id,discovered_params,override_params,
                effective_params,params_status,revision,updated_at
           FROM llm_provider_models WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [selectionIds],
      );
      if (rowsResult.rows.length !== selectionIds.length) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Selected model no longer exists', 409);
      }
      const conflicts: string[] = [];
      for (const row of rowsResult.rows as ModelRow[]) {
        const selection = uniqueSelections.get(row.id)!;
        const frozenItem = frozenById.get(row.id)!;
        if (asIso(row.updated_at) !== selection.expectedUpdatedAt ||
            selection.expectedUpdatedAt !== frozenItem.expectedUpdatedAt ||
            row.provider_instance_id !== run.provider_instance_id) conflicts.push(row.id);
      }
      if (conflicts.length > 0) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Model revision changed', 409, { modelRowIds: conflicts });
      }
      const resultModels: Record<string, unknown>[] = [];
      for (const row of rowsResult.rows as ModelRow[]) {
        const frozenItem = frozenById.get(row.id)!;
        if (frozenItem.candidateStatus === 'invalid' || frozenItem.candidate.conflicts.length > 0 ||
            frozenItem.candidate.unresolvedFields.length > 0) {
          throw new ModelParamDiscoveryError('MODEL_CATALOG_SOURCE_INVALID', 'Selected candidate is not ready', 422, { modelRowIds: [row.id] });
        }
        const candidateParams = paramsOrEmpty(frozenItem.candidate.params);
        const overrideParams = paramsOrEmpty(row.override_params);
        const merged = mergeModelRuntimeParams(candidateParams, overrideParams);
        const before = modelState(row);
        const updated = await client.query(
          `UPDATE llm_provider_models SET discovered_params=$2,effective_params=$3,params_status=$4,
                  params_schema_version=1,discovered_at=NOW(),discovery_run_id=$5,
                  revision=revision+1,updated_at=NOW()
            WHERE id=$1
            RETURNING id,provider_instance_id,model_id,discovered_params,override_params,
                      effective_params,params_status,revision,updated_at`,
          [row.id, JSON.stringify(candidateParams), JSON.stringify(merged.effectiveParams),
            merged.status, input.previewRunId],
        );
        await writeEvidence(client, {
          modelRowId: row.id,
          runId: input.previewRunId,
          layer: 'discovered',
          evidence: frozenItem.candidate.evidence,
          actor: input.actor,
        });
        resultModels.push({
          modelRowId: row.id,
          modelId: row.model_id,
          before,
          after: modelState(updated.rows[0] as ModelRow),
          fallbackFields: merged.fallbackFields,
        });
      }
      const appliedAt = new Date().toISOString();
      const result = {
        runId: input.previewRunId,
        status: 'applied',
        appliedAt,
        models: resultModels,
      };
      await client.query(
        `UPDATE llm_model_discovery_runs
            SET status='applied',applied_at=$2,applied_selection_ids=$3,apply_result=$4
          WHERE id=$1`,
        [input.previewRunId, appliedAt, JSON.stringify(selectionIds), JSON.stringify(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async replaceOverride(modelRowId: string, input: OverrideInput): Promise<Record<string, unknown>> {
    if (!modelRowId || typeof input.expectedUpdatedAt !== 'string') {
      throw new ModelParamDiscoveryError('MODEL_CATALOG_VALIDATION', 'model id and expectedUpdatedAt are required', 400);
    }
    validateEvidence(input.evidence);
    const overrideParams = paramsOrEmpty(input.overrideParams);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id,provider_instance_id,model_id,discovered_params,override_params,
                effective_params,params_status,revision,updated_at
           FROM llm_provider_models WHERE id=$1 FOR UPDATE`,
        [modelRowId],
      );
      if (!current.rows[0]) throw new ModelParamDiscoveryError('MODEL_CATALOG_MODEL_NOT_FOUND', 'Model not found', 404);
      const row = current.rows[0] as ModelRow;
      if (asIso(row.updated_at) !== input.expectedUpdatedAt) {
        throw new ModelParamDiscoveryError('MODEL_CATALOG_REVISION_CONFLICT', 'Model revision changed', 409, { modelRowIds: [modelRowId] });
      }
      const merged = mergeModelRuntimeParams(paramsOrEmpty(row.discovered_params), overrideParams);
      const before = modelState(row);
      const updated = await client.query(
        `UPDATE llm_provider_models SET override_params=$2,effective_params=$3,params_status=$4,
                params_schema_version=1,revision=revision+1,updated_at=NOW()
          WHERE id=$1
          RETURNING id,provider_instance_id,model_id,discovered_params,override_params,
                    effective_params,params_status,revision,updated_at`,
        [modelRowId, JSON.stringify(overrideParams), JSON.stringify(merged.effectiveParams), merged.status],
      );
      const rawSha256 = input.evidence.rawSha256 ?? '0'.repeat(64);
      const evidence: FieldEvidence[] = Object.entries(overrideParams).map(([field, rawValue]) => ({
        field,
        sourceKind: input.evidence.sourceKind,
        ...(input.evidence.sourceUrl ? { sourceUrl: input.evidence.sourceUrl } : {}),
        ...(input.evidence.sourceVersion ? { sourceVersion: input.evidence.sourceVersion } : {}),
        observedAt: input.evidence.observedAt,
        rawValue,
        rawSha256,
        confidence: 'high',
        ...(input.evidence.notes ? { notes: input.evidence.notes } : {}),
      }));
      await writeEvidence(client, { modelRowId, layer: 'override', evidence, actor: input.actor });
      const result = {
        modelRowId,
        modelId: row.model_id,
        before,
        after: modelState(updated.rows[0] as ModelRow),
        fallbackFields: merged.fallbackFields,
      };
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
