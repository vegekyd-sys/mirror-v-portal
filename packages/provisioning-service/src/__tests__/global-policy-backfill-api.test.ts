import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisioningConfig } from '../config.js';
import { createModelCatalogRoutes } from '../routes/model-catalog.js';
import { encryptValue } from '../services/crypto.js';

const previousKey = process.env.RUNTIME_CONFIG_KEY;

function config(paramWrite: boolean): ProvisioningConfig {
  return {
    port: 0, databaseUrl: '', k8sDryRun: true, runtimeNamespace: 'test', imageRegistry: 'test',
    nexusGatewayImageTag: 'test', dealclawAgentImageTag: 'test', agentPvcSize: '1Gi',
    agentPvcStorageClass: 'test', agentPvcAccessMode: 'ReadWriteOnce', ossEndpoint: '', ossBucket: '',
    ossSecretName: '', backupImage: '', creditsLedgerUrl: '', creditsLedgerToken: '',
    modelCatalogRead: true, modelCatalogShadowImport: false, modelCatalogSnapshotWrite: false,
    modelCatalogParamWrite: paramWrite, llmPushWorkerIntervalMs: 100, llmPushLeaseSeconds: 600,
  };
}

function app(pool: pg.Pool, paramWrite = true) {
  const instance = express();
  instance.use(express.json());
  instance.use(createModelCatalogRoutes(pool, config(paramWrite)));
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
    const pool = { query: vi.fn(async (sql: string, values?: unknown[]) => {
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
      throw new Error(`unexpected query: ${sql}`);
    }) } as unknown as pg.Pool;

    const response = await request(app(pool)).post('/v1/admin/model-catalog/global-policy/backfill').send({ dryRun: false });
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('applied');
    expect(response.body.policy.revision).toBe(4);
    expect(auditValues).toHaveLength(1);
    expect(JSON.stringify(auditValues)).not.toContain('top-secret');
    expect(JSON.stringify(auditValues)).not.toContain('encrypted-secret');
  });

  it('checks the parameter-write flag before validation', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('must not query'); }) } as unknown as pg.Pool;
    const response = await request(app(pool, false))
      .post('/v1/admin/model-catalog/global-policy/backfill')
      .send({ dryRun: 'invalid' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MODEL_CATALOG_PARAM_WRITE_DISABLED');
  });
});
