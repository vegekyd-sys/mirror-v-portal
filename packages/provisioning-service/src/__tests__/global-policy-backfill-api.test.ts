import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisioningConfig } from '../config.js';
import { createModelCatalogRoutes } from '../routes/model-catalog.js';
import { encryptValue } from '../services/crypto.js';

const previousKey = process.env.RUNTIME_CONFIG_KEY;

function config(read: boolean, backfillWrite: boolean): ProvisioningConfig {
  return {
    port: 0, databaseUrl: '', k8sDryRun: true, runtimeNamespace: 'test', imageRegistry: 'test',
    nexusGatewayImageTag: 'test', dealclawAgentImageTag: 'test', agentPvcSize: '1Gi',
    agentPvcStorageClass: 'test', agentPvcAccessMode: 'ReadWriteOnce', ossEndpoint: '', ossBucket: '',
    ossSecretName: '', backupImage: '', creditsLedgerUrl: '', creditsLedgerToken: '',
    modelCatalogRead: read, modelCatalogShadowImport: false, modelCatalogSnapshotWrite: false,
    modelCatalogParamWrite: false, modelCatalogGlobalPolicyBackfillWrite: backfillWrite,
    llmPushWorkerIntervalMs: 100, llmPushLeaseSeconds: 600,
  };
}

function app(pool: pg.Pool, read = true, backfillWrite = true) {
  const instance = express();
  instance.use(express.json());
  instance.use(createModelCatalogRoutes(pool, config(read, backfillWrite)));
  return instance;
}

beforeEach(() => {
  process.env.RUNTIME_CONFIG_KEY = '11'.repeat(32);
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.RUNTIME_CONFIG_KEY;
  else process.env.RUNTIME_CONFIG_KEY = previousKey;
});

describe('global policy backfill API', () => {
  it('defaults to dry-run and performs no update or audit', async () => {
    const legacy = encryptValue(JSON.stringify({
      providers: [{ name: 'provider-a', baseUrl: 'https://example.test', apiKey: 'secret-key', models: [{ id: 'chat' }] }],
      defaultModel: 'provider-a/chat', imageModel: null, compactionModel: null, fallbackModels: [],
    }));
    const queries: string[] = [];
    const pool = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT encrypted_value FROM runtime_configs')) return { rows: [{ encrypted_value: legacy }] };
      if (sql.includes('COALESCE(json_agg(to_jsonb(m)')) return { rows: [{
        id: 'lpi_a', legacy_provider_name: 'provider-a', template_key: 'custom-openai', protocol: 'openai-completions',
        base_url: 'https://example.test', encrypted_api_key: 'must-not-leak', source: 'legacy-import', enabled: true,
        models: [{ id: 'lpm_chat', provider_instance_id: 'lpi_a', model_id: 'chat', model_type: 'chat',
          runtime_enabled: true, effective_params: {}, params_status: 'complete', schema_version: 1 }],
      }] };
      if (sql.includes("FROM llm_global_model_policy WHERE id='current'")) return { rows: [{
        default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(0),
      }] };
      throw new Error(`unexpected write: ${sql}`);
    }) } as unknown as pg.Pool;

    const response = await request(app(pool)).post('/v1/admin/model-catalog/global-policy/backfill').send({});
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('dry-run');
    expect(response.body.resolvedIds.defaultModel).toBe('lpm_chat');
    expect(queries.some((sql) => sql.includes('UPDATE llm_global_model_policy'))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO audit_logs'))).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('secret-key');
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
  });

  it('applies with CAS and writes a secret-free audit record', async () => {
    const legacy = encryptValue(JSON.stringify({
      providers: [{ name: 'provider-a', baseUrl: 'https://example.test', apiKey: 'top-secret', models: [{ id: 'chat' }] }],
      defaultModel: 'provider-a/chat', imageModel: null, compactionModel: null, fallbackModels: [],
    }));
    const auditValues: unknown[][] = [];
    const transactionCommands: string[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT encrypted_value FROM runtime_configs')) return { rows: [{ encrypted_value: legacy }] };
      if (sql.includes('COALESCE(json_agg(to_jsonb(m)')) return { rows: [{
        id: 'lpi_a', legacy_provider_name: 'provider-a', template_key: 'custom-openai', protocol: 'openai-completions',
        base_url: 'https://example.test', encrypted_api_key: 'encrypted-secret', source: 'legacy-import', enabled: true,
        models: [{ id: 'lpm_chat', provider_instance_id: 'lpi_a', model_id: 'chat', model_type: 'chat',
          runtime_enabled: true, effective_params: {}, params_status: 'complete', schema_version: 1 }],
      }] };
      if (sql.includes("SELECT * FROM llm_global_model_policy WHERE id='current'")) return { rows: [{
        default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 3, updated_at: new Date(0),
      }] };
      if (sql.includes('SELECT id FROM llm_provider_models')) return { rows: [{ id: 'lpm_chat' }] };
      if (sql.includes('UPDATE llm_global_model_policy')) {
        expect(values?.[0]).toBe(3);
        return { rows: [{ default_model: 'lpm_chat', image_model: null, compaction_model: null,
          fallback_models: [], revision: 4, updated_at: new Date(1) }] };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        auditValues.push(values ?? []);
        return { rows: [] };
      }
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK' ||
          sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('LOCK TABLE')) {
        transactionCommands.push(sql);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool;

    const application = app(pool);
    const preview = await request(application).post('/v1/admin/model-catalog/global-policy/backfill').send({});
    const response = await request(application).post('/v1/admin/model-catalog/global-policy/backfill').send({
      dryRun: false,
      planFingerprint: preview.body.planFingerprint,
      expectedRevision: preview.body.expectedRevision,
    });
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('applied');
    expect(response.body.policy.revision).toBe(4);
    expect(auditValues).toHaveLength(1);
    expect(transactionCommands).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      `SELECT pg_advisory_xact_lock(hashtext('global-policy-backfill'))`,
      'LOCK TABLE runtime_configs IN SHARE MODE',
      'LOCK TABLE llm_provider_instances IN SHARE MODE',
      'LOCK TABLE llm_provider_models IN SHARE MODE',
      'LOCK TABLE llm_global_model_policy IN SHARE ROW EXCLUSIVE MODE',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(auditValues)).not.toContain('top-secret');
    expect(JSON.stringify(auditValues)).not.toContain('encrypted-secret');
  });

  it('uses read flag for preview and dedicated flag for apply', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('must not query'); }) } as unknown as pg.Pool;
    const preview = await request(app(pool, false, true))
      .post('/v1/admin/model-catalog/global-policy/backfill')
      .send({});
    expect(preview.status).toBe(503);
    const apply = await request(app(pool, true, false))
      .post('/v1/admin/model-catalog/global-policy/backfill')
      .send({ dryRun: false, planFingerprint: 'fingerprint', expectedRevision: 0 });
    expect(apply.status).toBe(403);
    expect(apply.body.code).toBe('MODEL_CATALOG_GLOBAL_POLICY_BACKFILL_WRITE_DISABLED');
  });

  it('rolls back the policy transaction when strict audit insertion fails', async () => {
    const legacy = encryptValue(JSON.stringify({
      providers: [{ name: 'provider-a', baseUrl: 'https://example.test', apiKey: 'secret', models: [{ id: 'chat' }] }],
      defaultModel: 'provider-a/chat', imageModel: null, compactionModel: null, fallbackModels: [],
    }));
    const commands: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK' || sql === 'COMMIT' ||
          sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('LOCK TABLE')) {
        commands.push(sql);
        return { rows: [] };
      }
      if (sql.includes('SELECT encrypted_value FROM runtime_configs')) return { rows: [{ encrypted_value: legacy }] };
      if (sql.includes('COALESCE(json_agg(to_jsonb(m)')) return { rows: [{
        id: 'lpi_a', legacy_provider_name: 'provider-a', template_key: 'custom-openai', protocol: 'openai-completions',
        base_url: 'https://example.test', encrypted_api_key: 'encrypted', source: 'legacy-import', enabled: true,
        models: [{ id: 'lpm_chat', provider_instance_id: 'lpi_a', model_id: 'chat', model_type: 'chat',
          runtime_enabled: true, effective_params: {}, params_status: 'complete', schema_version: 1 }],
      }] };
      if (sql.includes("SELECT * FROM llm_global_model_policy WHERE id='current'")) return { rows: [{
        default_model: null, image_model: null, compaction_model: null, fallback_models: [], revision: 0, updated_at: new Date(0),
      }] };
      if (sql.includes('UPDATE llm_global_model_policy')) return { rows: [{
        default_model: 'lpm_chat', image_model: null, compaction_model: null, fallback_models: [], revision: 1, updated_at: new Date(1),
      }] };
      if (sql.includes('INSERT INTO audit_logs')) throw new Error('audit unavailable');
      throw new Error(`unexpected query: ${sql}`);
    });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const application = app(pool);
    const preview = await request(application).post('/v1/admin/model-catalog/global-policy/backfill').send({});
    const response = await request(application).post('/v1/admin/model-catalog/global-policy/backfill').send({
      dryRun: false, planFingerprint: preview.body.planFingerprint, expectedRevision: preview.body.expectedRevision,
    });
    expect(response.status).toBe(500);
    expect(commands).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      `SELECT pg_advisory_xact_lock(hashtext('global-policy-backfill'))`,
      'LOCK TABLE runtime_configs IN SHARE MODE',
      'LOCK TABLE llm_provider_instances IN SHARE MODE',
      'LOCK TABLE llm_provider_models IN SHARE MODE',
      'LOCK TABLE llm_global_model_policy IN SHARE ROW EXCLUSIVE MODE',
      'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
