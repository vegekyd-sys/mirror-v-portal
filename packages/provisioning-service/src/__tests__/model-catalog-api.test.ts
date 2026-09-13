import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { createModelCatalogRoutes } from '../routes/model-catalog.js';
import express from 'express';
import { encryptValue } from '../services/crypto.js';
import { snapshotFingerprint } from '../services/model-catalog.js';

const TRACKED_ENV = [
  'RUNTIME_CONFIG_KEY',
  'MODEL_CATALOG_READ',
  'MODEL_CATALOG_SHADOW_IMPORT',
  'MODEL_CATALOG_SNAPSHOT_WRITE',
] as const;
const originalEnv = Object.fromEntries(TRACKED_ENV.map((key) => [key, process.env[key]])) as Record<
  (typeof TRACKED_ENV)[number],
  string | undefined
>;

function restoreCatalogEnv(): void {
  for (const key of TRACKED_ENV) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

afterEach(() => {
  restoreCatalogEnv();
});

function createConfig(read: boolean): ProvisioningConfig {
  return {
    port: 0, databaseUrl: '', k8sDryRun: true, runtimeNamespace: 'test', imageRegistry: 'test',
    nexusGatewayImageTag: 'test', dealclawAgentImageTag: 'test', agentPvcSize: '1Gi',
    agentPvcStorageClass: 'test', agentPvcAccessMode: 'ReadWriteOnce', ossEndpoint: '', ossBucket: '',
    ossSecretName: '', backupImage: '', creditsLedgerUrl: '', creditsLedgerToken: '',
    modelCatalogRead: read, modelCatalogShadowImport: false, modelCatalogSnapshotWrite: false,
    llmPushWorkerIntervalMs: 100, llmPushLeaseSeconds: 600,
  };
}

function createApp(pool: pg.Pool, read: boolean) {
  const app = express();
  app.use(express.json());
  app.use(createModelCatalogRoutes(pool, createConfig(read)));
  return app;
}

describe('model catalog status API', () => {
  it('restores catalog environment values captured before the suite', () => {
    for (const key of TRACKED_ENV) process.env[key] = `changed-${key}`;
    restoreCatalogEnv();
    for (const key of TRACKED_ENV) expect(process.env[key]).toBe(originalEnv[key]);
  });

  it('returns disabled without querying when catalog reads are off', async () => {
    const pool = { query: async () => { throw new Error('must not query'); } } as unknown as pg.Pool;
    const response = await request(createApp(pool, false)).get('/v1/admin/model-catalog/status');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DISABLED');
  });

  it('returns status counts and metadata without secret columns', async () => {
    const query = async (sql: string) => {
      if (sql.includes('provider_count')) return { rows: [{ provider_count: '2', model_count: '4', complete_count: '1', incomplete_count: '1', fallback_count: '1', invalid_count: '1' }] };
      if (sql.includes('llm_catalog_import_runs')) return { rows: [{ id: 'run', source_kind: 'legacy-runtime-config', source_fingerprint: 'fp', status: 'succeeded', total_count: 4, succeeded_count: 4, skipped_count: 0, error_count: 0, started_at: 'start', finished_at: 'finish' }] };
      return { rows: [{ id: 'backup', runtime_config_id: 1, source_fingerprint: 'fp', actor: 'admin', created_at: 'now', encrypted_value: 'must-not-leak' }] };
    };
    const response = await request(createApp({ query } as unknown as pg.Pool, true)).get('/v1/admin/model-catalog/status');
    expect(response.status).toBe(200);
    expect(response.body.totals).toEqual({ providers: 2, models: 4 });
    expect(response.body.modelStatuses).toEqual({ complete: 1, incomplete: 1, fallback: 1, invalid: 1 });
    expect(JSON.stringify(response.body)).not.toContain('encrypted_value');
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
  });

  it('does not expose database error details', async () => {
    const pool = { query: async () => { throw new Error('encrypted_api_key=secret postgres detail'); } } as unknown as pg.Pool;
    const response = await request(createApp(pool, true)).get('/v1/admin/model-catalog/status');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(JSON.stringify(response.body)).not.toContain('postgres');
  });

  it('builds preview once and returns a diff and fingerprint for that snapshot', async () => {
    process.env.RUNTIME_CONFIG_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    let catalogReads = 0;
    const query = async (sql: string) => {
      if (sql.includes('runtime_configs')) return { rows: [] };
      if (sql.includes('llm_provider_instances')) {
        catalogReads += 1;
        return { rows: [{
          id: 'provider-id', legacy_provider_name: 'provider', template_key: 'custom-openai',
          protocol: 'openai-completions', base_url: 'https://example.invalid',
          encrypted_api_key: encryptValue('secret'), source: 'manual', enabled: true,
          models: [{
            id: 'model-id', provider_instance_id: 'provider-id', model_id: 'chat-model',
            model_type: 'chat', runtime_enabled: true, effective_params: {
              contextWindow: 4096, maxOutputTokens: 1024, inputModalities: ['text'],
            }, params_status: 'complete',
          }],
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const response = await request(createApp({ query } as unknown as pg.Pool, true))
      .get('/v1/admin/model-catalog/snapshot-preview');
    expect(response.status).toBe(200);
    expect(catalogReads).toBe(1);
    expect(response.body.fingerprint).toBe(response.body.diff.fingerprint);
    const unredactedShape = {
      ...response.body.snapshot,
      providers: response.body.snapshot.providers.map(({ hasApiKey: _hasApiKey, ...provider }: Record<string, unknown>) => ({
        ...provider,
        apiKey: 'secret',
      })),
    };
    expect(response.body.fingerprint).toBe(snapshotFingerprint(unredactedShape));
    expect(response.body.diff.addedProviders).toEqual(['provider']);
    expect(response.body.diff.addedModels).toEqual(['provider/chat-model']);
  });
});
