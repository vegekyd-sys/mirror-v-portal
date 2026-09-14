import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { importLegacyCatalog } from '../services/model-catalog-import.js';
import { CatalogRepository, stableProviderInstanceId } from '../services/model-catalog.js';
import { ModelParamDiscoveryService } from '../services/model-param-discovery.js';
import { upsertRuntimeConfig } from '../services/runtime-config.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  process.env.RUNTIME_CONFIG_KEY = process.env.RUNTIME_CONFIG_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await migrate(pool);
  await migrate(pool);
  await pool.query("DELETE FROM runtime_configs WHERE tenant_id IS NULL AND config_key='LLM_PROVIDERS'");
  await pool.query('DELETE FROM llm_model_param_evidence');
  await pool.query('DELETE FROM llm_provider_models');
  await pool.query('DELETE FROM llm_model_discovery_runs');
  await pool.query('DELETE FROM llm_provider_instances');
  await pool.query('DELETE FROM llm_catalog_import_runs');
  await upsertRuntimeConfig(pool, {
    tenantId: null,
    key: 'LLM_PROVIDERS',
    value: JSON.stringify({
      providers: [{
        name: 'catalog-db-test',
        label: 'Catalog DB Test',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'test-secret-never-return',
        models: [
          { id: 'chat-model', reasoning: true },
          { id: 'vision-model', vision: true },
        ],
      }],
      defaultModel: 'catalog-db-test/chat-model',
      imageModel: 'catalog-db-test/vision-model',
      compactionModel: null,
      fallbackModels: [],
    }),
    isSecret: true,
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM runtime_configs WHERE tenant_id IS NULL AND config_key='LLM_PROVIDERS'");
  await pool.query('DELETE FROM llm_model_param_evidence');
  await pool.query('DELETE FROM llm_provider_models');
  await pool.query('DELETE FROM llm_model_discovery_runs');
  await pool.query('DELETE FROM llm_provider_instances');
  await pool.query('DELETE FROM llm_catalog_import_runs');
  await pool.end();
});

describe.skipIf(!process.env.DATABASE_URL)('model catalog PostgreSQL integration', () => {
  it('imports the legacy catalog repeatedly without duplicate rows or pushing runtime config', async () => {
    const first = await importLegacyCatalog(pool, { dryRun: false, actor: 'integration-test' });
    const second = await importLegacyCatalog(pool, { dryRun: false, actor: 'integration-test' });

    expect(first.errorCount).toBe(0);
    expect(second.errorCount).toBe(0);
    const providers = await pool.query(
      "SELECT legacy_provider_name,encrypted_api_key FROM llm_provider_instances WHERE legacy_provider_name='catalog-db-test'",
    );
    const models = await pool.query(
      `SELECT model_id,override_params,effective_params
         FROM llm_provider_models
        WHERE provider_instance_id=(SELECT id FROM llm_provider_instances WHERE legacy_provider_name='catalog-db-test')
        ORDER BY model_id`,
    );
    const runs = await pool.query(
      "SELECT COUNT(*) AS count FROM llm_catalog_import_runs WHERE source_kind='legacy-runtime-config'",
    );
    expect(providers.rowCount).toBe(1);
    expect(providers.rows[0].encrypted_api_key).not.toContain('test-secret-never-return');
    expect(models.rowCount).toBe(2);
    expect(models.rows.find((row) => row.model_id === 'chat-model').override_params.reasoning).toBe(true);
    expect(models.rows.find((row) => row.model_id === 'vision-model').effective_params.inputModalities).toContain('image');
    expect(Number(runs.rows[0].count)).toBe(1);

    const status = await new CatalogRepository(pool).getStatus();
    expect(status.totals).toMatchObject({ providers: 1, models: 2 });
    expect(status.modelStatuses.fallback).toBe(2);
    expect(status.recentImportRuns).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain('encrypted_api_key');
    expect(JSON.stringify(status)).not.toContain('test-secret-never-return');
  });

  it('applies exact discovered parameters while preserving overrides and runtime authority', async () => {
    const providerId = stableProviderInstanceId('catalog-db-test');
    await pool.query(
      `UPDATE llm_provider_instances
          SET legacy_provider_name='aochi-aliyun',base_url='https://workspace-123.maas.aliyuncs.com/compatible-mode/v1'
        WHERE id=$1`,
      [providerId],
    );
    await pool.query(
      `UPDATE llm_provider_models
          SET model_id='qwen3.7-plus',override_params=$2,effective_params=$3,updated_at=NOW()
        WHERE provider_instance_id=$1 AND model_id='chat-model'`,
      [providerId, JSON.stringify({}),
        JSON.stringify({ inputModalities: ['text'], outputModalities: ['text'] })],
    );
    const runtimeBefore = await pool.query(
      "SELECT encrypted_value,updated_at FROM runtime_configs WHERE tenant_id IS NULL AND config_key='LLM_PROVIDERS'",
    );
    const pushesBefore = await pool.query('SELECT COUNT(*) AS count FROM llm_push_tasks');
    const discovery = new ModelParamDiscoveryService(pool);
    const conflictingUpdated = await pool.query(
      `UPDATE llm_provider_models SET override_params=$2,updated_at=NOW()
        WHERE provider_instance_id=$1 AND model_id='qwen3.7-plus'
        RETURNING id,revision,updated_at`,
      [providerId, JSON.stringify({ inputModalities: ['text', 'image'] })],
    );
    const conflictPreview = await discovery.preview({
      providerInstanceId: providerId,
      modelIds: ['qwen3.7-plus'],
      adapter: 'builtin-catalog',
      actor: 'integration-test',
    }) as { runId: string; providerRevision: string; models: Array<{ modelRowId: string; expectedUpdatedAt: string; conflicts: unknown[] }> };
    expect(conflictPreview.models[0].conflicts).toEqual([{
      field: 'inputModalities', currentOverride: ['text', 'image'],
      discovered: ['text', 'image', 'video'], reason: 'override-differs-from-discovered',
    }]);
    await expect(discovery.apply({
      previewRunId: conflictPreview.runId,
      expectedProviderRevision: conflictPreview.providerRevision,
      selections: [{ modelRowId: conflictPreview.models[0].modelRowId, expectedUpdatedAt: conflictPreview.models[0].expectedUpdatedAt }],
      actor: 'integration-test',
    })).rejects.toMatchObject({ code: 'MODEL_CATALOG_SOURCE_INVALID', status: 422 });
    const afterRejected = await pool.query(
      'SELECT revision,updated_at,discovered_params,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [conflictingUpdated.rows[0].id],
    );
    expect(afterRejected.rows[0]).toMatchObject({
      revision: conflictingUpdated.rows[0].revision,
      updated_at: conflictingUpdated.rows[0].updated_at,
      discovered_params: null,
      discovery_run_id: null,
    });
    const rejectedRun = await pool.query('SELECT status,applied_at FROM llm_model_discovery_runs WHERE id=$1', [conflictPreview.runId]);
    expect(rejectedRun.rows[0]).toMatchObject({ status: 'previewed', applied_at: null });
    const rejectedEvidence = await pool.query('SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE run_id=$1', [conflictPreview.runId]);
    expect(Number(rejectedEvidence.rows[0].count)).toBe(0);

    await pool.query(
      `UPDATE llm_provider_models SET override_params='{}'::jsonb,updated_at=NOW()
        WHERE provider_instance_id=$1 AND model_id='qwen3.7-plus'`,
      [providerId],
    );

    const providerCasPreview = await discovery.preview({
      providerInstanceId: providerId,
      modelIds: ['qwen3.7-plus'],
      adapter: 'builtin-catalog',
      actor: 'integration-test',
    }) as { runId: string; providerRevision: string; models: Array<{ modelRowId: string; expectedUpdatedAt: string }> };
    await pool.query(
      "UPDATE llm_provider_instances SET updated_at=updated_at + INTERVAL '1 second' WHERE id=$1",
      [providerId],
    );
    const beforeProviderCasApply = await pool.query(
      'SELECT revision,updated_at,discovered_params,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [providerCasPreview.models[0].modelRowId],
    );
    await expect(discovery.apply({
      previewRunId: providerCasPreview.runId,
      expectedProviderRevision: providerCasPreview.providerRevision,
      selections: [{
        modelRowId: providerCasPreview.models[0].modelRowId,
        expectedUpdatedAt: providerCasPreview.models[0].expectedUpdatedAt,
      }],
      actor: 'integration-test',
    })).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT', status: 409 });
    const afterProviderCasApply = await pool.query(
      'SELECT revision,updated_at,discovered_params,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [providerCasPreview.models[0].modelRowId],
    );
    expect(afterProviderCasApply.rows).toEqual(beforeProviderCasApply.rows);
    const providerCasRun = await pool.query(
      'SELECT status,applied_at FROM llm_model_discovery_runs WHERE id=$1',
      [providerCasPreview.runId],
    );
    expect(providerCasRun.rows[0]).toMatchObject({ status: 'previewed', applied_at: null });
    const providerCasEvidence = await pool.query(
      'SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE run_id=$1',
      [providerCasPreview.runId],
    );
    expect(Number(providerCasEvidence.rows[0].count)).toBe(0);

    const modelCasPreview = await discovery.preview({
      providerInstanceId: providerId,
      modelIds: ['qwen3.7-plus'],
      adapter: 'builtin-catalog',
      actor: 'integration-test',
    }) as { runId: string; providerRevision: string; models: Array<{ modelRowId: string; expectedUpdatedAt: string }> };
    await pool.query(
      "UPDATE llm_provider_models SET updated_at=updated_at + INTERVAL '1 second' WHERE id=$1",
      [modelCasPreview.models[0].modelRowId],
    );
    const beforeModelCasApply = await pool.query(
      'SELECT revision,updated_at,discovered_params,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [modelCasPreview.models[0].modelRowId],
    );
    await expect(discovery.apply({
      previewRunId: modelCasPreview.runId,
      expectedProviderRevision: modelCasPreview.providerRevision,
      selections: [{
        modelRowId: modelCasPreview.models[0].modelRowId,
        expectedUpdatedAt: modelCasPreview.models[0].expectedUpdatedAt,
      }],
      actor: 'integration-test',
    })).rejects.toMatchObject({ code: 'MODEL_CATALOG_REVISION_CONFLICT', status: 409 });
    const afterModelCasApply = await pool.query(
      'SELECT revision,updated_at,discovered_params,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [modelCasPreview.models[0].modelRowId],
    );
    expect(afterModelCasApply.rows).toEqual(beforeModelCasApply.rows);
    const modelCasRun = await pool.query(
      'SELECT status,applied_at FROM llm_model_discovery_runs WHERE id=$1',
      [modelCasPreview.runId],
    );
    expect(modelCasRun.rows[0]).toMatchObject({ status: 'previewed', applied_at: null });
    const modelCasEvidence = await pool.query(
      'SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE run_id=$1',
      [modelCasPreview.runId],
    );
    expect(Number(modelCasEvidence.rows[0].count)).toBe(0);

    const preview = await discovery.preview({
      providerInstanceId: providerId,
      modelIds: ['qwen3.7-plus'],
      adapter: 'builtin-catalog',
      actor: 'integration-test',
    }) as { runId: string; providerRevision: string; models: Array<{ modelRowId: string; expectedUpdatedAt: string }> };
    const applied = await discovery.apply({
      previewRunId: preview.runId,
      expectedProviderRevision: preview.providerRevision,
      selections: [{ modelRowId: preview.models[0].modelRowId, expectedUpdatedAt: preview.models[0].expectedUpdatedAt }],
      actor: 'integration-test',
    }) as { models: Array<{ after: { discoveredParams: Record<string, unknown>; overrideParams: Record<string, unknown>; effectiveParams: Record<string, unknown> } }> };
    expect(applied.models[0].after.discoveredParams).toMatchObject({
      contextWindow: 1_000_000, maxInputTokens: 991_808, maxOutputTokens: 131_072,
      maxReasoningTokens: 262_144, inputModalities: ['text', 'image', 'video'],
    });
    expect(applied.models[0].after.overrideParams).toEqual({});
    expect(applied.models[0].after.effectiveParams).toMatchObject({
      maxOutputTokens: 131_072, toolCalling: true, structuredOutput: true,
    });

    const afterFirstApply = await pool.query(
      'SELECT revision,updated_at,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [preview.models[0].modelRowId],
    );
    const evidenceAfterFirstApply = await pool.query(
      'SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE run_id=$1',
      [preview.runId],
    );
    const reapplied = await discovery.apply({
      previewRunId: preview.runId,
      expectedProviderRevision: preview.providerRevision,
      selections: [{ modelRowId: preview.models[0].modelRowId, expectedUpdatedAt: preview.models[0].expectedUpdatedAt }],
      actor: 'integration-test',
    });
    expect(reapplied).toEqual(applied);
    const afterSecondApply = await pool.query(
      'SELECT revision,updated_at,discovery_run_id FROM llm_provider_models WHERE id=$1',
      [preview.models[0].modelRowId],
    );
    expect(afterSecondApply.rows).toEqual(afterFirstApply.rows);
    const evidenceAfterSecondApply = await pool.query(
      'SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE run_id=$1',
      [preview.runId],
    );
    expect(evidenceAfterSecondApply.rows).toEqual(evidenceAfterFirstApply.rows);
    const appliedRun = await pool.query(
      'SELECT status,applied_selection_ids,apply_result FROM llm_model_discovery_runs WHERE id=$1',
      [preview.runId],
    );
    expect(appliedRun.rows[0]).toMatchObject({
      status: 'applied',
      applied_selection_ids: [preview.models[0].modelRowId],
      apply_result: applied,
    });

    const runtimeAfter = await pool.query(
      "SELECT encrypted_value,updated_at FROM runtime_configs WHERE tenant_id IS NULL AND config_key='LLM_PROVIDERS'",
    );
    const pushesAfter = await pool.query('SELECT COUNT(*) AS count FROM llm_push_tasks');
    expect(runtimeAfter.rows).toEqual(runtimeBefore.rows);
    expect(pushesAfter.rows[0].count).toBe(pushesBefore.rows[0].count);
    const evidence = await pool.query(
      "SELECT COUNT(*) AS count FROM llm_model_param_evidence WHERE layer='discovered'",
    );
    expect(Number(evidence.rows[0].count)).toBeGreaterThan(0);

    const repository = new CatalogRepository(pool);
    const appliedCatalog = await repository.listRuntimeCatalog();
    const appliedModel = appliedCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(appliedModel?.snapshotApproved).toBe(true);

    await pool.query(
      "UPDATE llm_model_discovery_runs SET status='previewed' WHERE id=$1",
      [preview.runId],
    );
    const previewedRunCatalog = await repository.listRuntimeCatalog();
    const previewedRunModel = previewedRunCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(previewedRunModel?.snapshotApproved).toBe(false);

    await pool.query(
      "UPDATE llm_model_discovery_runs SET status='applied' WHERE id=$1",
      [preview.runId],
    );
    await pool.query(
      `UPDATE llm_model_param_evidence
          SET value_json='999'::jsonb
        WHERE run_id=$1 AND layer='discovered' AND field_name='contextWindow'`,
      [preview.runId],
    );
    const mismatchedEvidenceCatalog = await repository.listRuntimeCatalog();
    const mismatchedEvidenceModel = mismatchedEvidenceCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(mismatchedEvidenceModel?.snapshotApproved).toBe(false);
    await pool.query(
      `UPDATE llm_model_param_evidence
          SET value_json='1000000'::jsonb
        WHERE run_id=$1 AND layer='discovered' AND field_name='contextWindow'`,
      [preview.runId],
    );

    await pool.query(
      "UPDATE llm_model_discovery_runs SET status='applied' WHERE id=$1",
      [preview.runId],
    );
    await pool.query(
      "UPDATE llm_model_param_evidence SET layer='override' WHERE run_id=$1 AND layer='discovered'",
      [preview.runId],
    );
    const overrideOnlyCatalog = await repository.listRuntimeCatalog();
    const overrideOnlyModel = overrideOnlyCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(overrideOnlyModel?.snapshotApproved).toBe(false);

    await pool.query(
      "UPDATE llm_model_param_evidence SET layer='discovered' WHERE run_id=$1 AND layer='override'",
      [preview.runId],
    );
    const restoredCatalog = await repository.listRuntimeCatalog();
    const restoredModel = restoredCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(restoredModel?.snapshotApproved).toBe(true);

    await pool.query(
      "UPDATE llm_provider_models SET override_params='{\"reasoning\":true}'::jsonb WHERE id=$1",
      [preview.models[0].modelRowId],
    );
    const unauditedOverrideCatalog = await repository.listRuntimeCatalog();
    const unauditedOverrideModel = unauditedOverrideCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(unauditedOverrideModel?.snapshotApproved).toBe(false);

    await pool.query(
      `INSERT INTO llm_model_param_evidence
         (id,model_row_id,run_id,layer,field_name,value_json,source_kind,observed_at,
          raw_sha256,confidence,created_by)
       VALUES (gen_random_uuid(),$1,NULL,'override','reasoning','true'::jsonb,
               'manual-contract',NOW(),$2,'high','integration-test')`,
      [preview.models[0].modelRowId, '1'.repeat(64)],
    );
    const auditedOverrideCatalog = await repository.listRuntimeCatalog();
    const auditedOverrideModel = auditedOverrideCatalog
      .flatMap((item) => item.models)
      .find((model) => model.id === preview.models[0].modelRowId);
    expect(auditedOverrideModel?.snapshotApproved).toBe(true);
  });
});
