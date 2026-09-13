import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { importLegacyCatalog } from '../services/model-catalog-import.js';
import { CatalogRepository } from '../services/model-catalog.js';
import { upsertRuntimeConfig } from '../services/runtime-config.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  process.env.RUNTIME_CONFIG_KEY = process.env.RUNTIME_CONFIG_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await migrate(pool);
  await migrate(pool);
  await pool.query("DELETE FROM runtime_configs WHERE tenant_id IS NULL AND config_key='LLM_PROVIDERS'");
  await pool.query('DELETE FROM llm_provider_models');
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
  await pool.query('DELETE FROM llm_provider_models');
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
});
