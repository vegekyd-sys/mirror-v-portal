import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import type pg from 'pg'
import type { ProvisioningConfig } from '../config.js'
import { createRuntimeConfigRoutes } from '../routes/runtime-configs.js'
import { createModelCatalogRoutes } from '../routes/model-catalog.js'
import { CatalogReleaseService } from '../services/catalog-release-service.js'
import { checkCatalogDrift } from '../services/catalog-drift-detector.js'

// ── Mocks ──────────────────────────────────────────────────────────────
// crypto is mocked so we never need a real RUNTIME_CONFIG_KEY for encrypt/
// decrypt of the LLM_PROVIDERS blob.
const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
  maskValue: (v: string) => '••••',
}))

vi.mock('../services/crypto.js', () => cryptoMocks)

// k8s-client is mocked so no real K8s calls happen during push.
const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}))

vi.mock('../services/k8s-client.js', () => k8sMocks)

// ── Config helpers ─────────────────────────────────────────────────────

function createConfig(overrides: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
  return {
    port: 0,
    databaseUrl: '',
    k8sDryRun: true,
    runtimeNamespace: 'test',
    imageRegistry: 'test',
    nexusGatewayImageTag: 'test',
    dealclawAgentImageTag: 'test',
    agentPvcSize: '1Gi',
    agentPvcStorageClass: 'test',
    agentPvcAccessMode: 'ReadWriteOnce',
    ossEndpoint: '',
    ossBucket: '',
    ossSecretName: '',
    backupImage: '',
    creditsLedgerUrl: '',
    creditsLedgerToken: '',
    llmPushWorkerIntervalMs: 100,
    llmPushLeaseSeconds: 600,
    ...overrides,
  }
}

function createRuntimeApp(pool: pg.Pool, config: ProvisioningConfig) {
  const app = express()
  app.use(express.json())
  app.use(createRuntimeConfigRoutes(pool, config))
  return app
}

function createCatalogApp(pool: pg.Pool, config: ProvisioningConfig) {
  const app = express()
  app.use(express.json())
  app.use(createModelCatalogRoutes(pool, config, undefined, new CatalogReleaseService(pool)))
  return app
}

// ── Fake pool for runtime-configs (PUT/DELETE llm-providers) ────────────

interface FakeQuery { sql: string; params?: unknown[] }

function makeRuntimePool(opts: {
  globalLlmRow?: { encrypted_value: string }[]
  deleteRowCount?: number
  allTenants?: Array<{ tenant_id: string }>
} = {}) {
  const queries: FakeQuery[] = []
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      // deleteRuntimeConfig: DELETE FROM runtime_configs — check BEFORE the
      // generic SELECT pattern since "DELETE FROM runtime_configs" also
      // contains "FROM runtime_configs" + "tenant_id IS NULL".
      if (sql.startsWith('DELETE FROM runtime_configs')) {
        return { rows: [], rowCount: opts.deleteRowCount ?? 1 }
      }
      // getGlobalLlmProviders: SELECT encrypted_value FROM runtime_configs
      // WHERE tenant_id IS NULL AND config_key = $1
      if (sql.includes('FROM runtime_configs') && sql.includes('tenant_id IS NULL') && sql.includes('config_key')) {
        return { rows: opts.globalLlmRow ?? [], rowCount: (opts.globalLlmRow ?? []).length }
      }
      // upsertRuntimeConfig: INSERT INTO runtime_configs ... ON CONFLICT
      if (sql.includes('INSERT INTO runtime_configs')) {
        return { rows: [], rowCount: 1 }
      }
      // enqueueLlmPush: INSERT INTO llm_push_tasks
      if (sql.includes('INSERT INTO llm_push_tasks')) {
        return { rows: [], rowCount: 1 }
      }
      // audit_logs INSERT (both via writeAuditLog and break-glass direct)
      if (sql.includes('INSERT INTO audit_logs')) {
        return { rows: [], rowCount: 1 }
      }
      // list tenants for push
      if (sql.includes('SELECT tenant_id FROM tenants')) {
        return { rows: opts.allTenants ?? [], rowCount: (opts.allTenants ?? []).length }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return pool as unknown as pg.Pool & { queries: FakeQuery[] }
}

// ── Fake pool for catalog drift-check ──────────────────────────────────

function makeDriftPool(opts: {
  globalLlmRow?: { encrypted_value: string }[]
  catalogProviders?: unknown[]
  globalPolicy?: unknown
  releaseFingerprint?: string | null
} = {}) {
  const pool = {
    query: async (sql: string) => {
      // getGlobalLlmProviders: SELECT encrypted_value FROM runtime_configs
      if (sql.includes('FROM runtime_configs') && sql.includes('tenant_id IS NULL') && sql.includes('config_key')) {
        return { rows: opts.globalLlmRow ?? [], rowCount: (opts.globalLlmRow ?? []).length }
      }
      // listRuntimeCatalog — the big JOIN starting with SELECT p.* ...
      // The SQL contains 'llm_provider_instances'.
      if (sql.includes('llm_provider_instances')) {
        return { rows: opts.catalogProviders ?? [] }
      }
      // getGlobalModelPolicy: SELECT * FROM llm_global_model_policy
      if (sql.includes('llm_global_model_policy')) {
        return { rows: opts.globalPolicy ? [opts.globalPolicy] : [] }
      }
      // drift check: last release fingerprint
      if (sql.includes('FROM llm_catalog_releases')) {
        return { rows: opts.releaseFingerprint ? [{ fingerprint: opts.releaseFingerprint }] : [] }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return pool as unknown as pg.Pool
}

// ── Test data ──────────────────────────────────────────────────────────

const goodDoc = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk-qwen',
      models: [{ id: 'qwen-max' }],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  k8sMocks.getSecret.mockResolvedValue(null)
  k8sMocks.deploymentExists.mockResolvedValue(true)
  k8sMocks.restartDeployment.mockResolvedValue(true)
  k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1. 旧 PUT/DELETE 只读保护
// ═══════════════════════════════════════════════════════════════════════

describe('legacy llm-providers read-only protection', () => {
  it('PUT returns 410 and writes a body-free blocked audit when readonly=true', async () => {
    const pool = makeRuntimePool()
    const config = createConfig({ legacyLlmProvidersReadonly: true })
    const app = createRuntimeApp(pool, config)

    const res = await request(app)
      .put('/v1/admin/llm-providers')
      .set('x-request-id', 'req-blocked-put')
      .send(goodDoc)
    expect(res.status).toBe(410)
    expect(res.body.code).toBe('LEGACY_LLM_PROVIDERS_DISABLED')
    expect(res.body.catalogUrl).toBe('/catalog')

    const audit = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_logs'))
    expect(audit?.params?.[2]).toBe('llm-provider.legacy-write-blocked')
    expect(audit?.params?.[3]).toBe('PUT')
    expect(audit?.params?.[10]).toBe(410)
    expect(audit?.params?.[13]).toBe('req-blocked-put')
    expect(JSON.stringify(audit?.params)).not.toContain('sk-qwen')
  })

  it('DELETE returns 410 and writes a queryable blocked audit when readonly=true', async () => {
    const pool = makeRuntimePool()
    const config = createConfig({ legacyLlmProvidersReadonly: true })
    const app = createRuntimeApp(pool, config)

    const res = await request(app).delete('/v1/admin/llm-providers')
    expect(res.status).toBe(410)
    expect(res.body.code).toBe('LEGACY_LLM_PROVIDERS_DISABLED')

    const audit = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_logs'))
    expect(audit?.params?.[2]).toBe('llm-provider.legacy-write-blocked')
    expect(audit?.params?.[3]).toBe('DELETE')
    expect(audit?.params?.[10]).toBe(410)
    expect(audit?.params?.[8]).toBeNull()
  })

  it('PUT still works (200) when legacyLlmProvidersReadonly is false (default)', async () => {
    const pool = makeRuntimePool({ allTenants: [] })
    const config = createConfig()
    const app = createRuntimeApp(pool, config)

    const res = await request(app).put('/v1/admin/llm-providers').send(goodDoc)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.taskId).toBeTruthy()
  })

  it('DELETE still works (200) when legacyLlmProvidersReadonly is false (default)', async () => {
    const pool = makeRuntimePool({ deleteRowCount: 1, allTenants: [] })
    const config = createConfig()
    const app = createRuntimeApp(pool, config)

    const res = await request(app).delete('/v1/admin/llm-providers')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('GET /v1/admin/llm-providers remains available and audits metadata without secrets', async () => {
    const pool = makeRuntimePool({
      globalLlmRow: [{ encrypted_value: `enc:${JSON.stringify(goodDoc)}` }],
    })
    const config = createConfig({ legacyLlmProvidersReadonly: true })
    const app = createRuntimeApp(pool, config)

    const res = await request(app)
      .get('/v1/admin/llm-providers')
      .set('x-request-id', 'req-read')
      .set('user-agent', 'catalog-protection-test')
    expect(res.status).toBe(200)
    expect(res.body.config.providers[0].apiKey).toBe('sk-qwen')

    await vi.waitFor(() => {
      expect(pool.queries.some((q) => q.sql.includes('INSERT INTO audit_logs'))).toBe(true)
    })
    const audit = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_logs'))
    expect(audit?.params?.[2]).toBe('llm-provider.legacy-read')
    expect(audit?.params?.[3]).toBe('GET')
    expect(audit?.params?.[10]).toBe(200)
    expect(audit?.params?.[13]).toBe('req-read')
    expect(audit?.params?.[9]).toContain('catalog-protection-test')
    expect(JSON.stringify(audit?.params)).not.toContain('sk-qwen')
    expect(JSON.stringify(audit?.params)).not.toContain('dashscope.aliyuncs.com')
  })

  it.each(['get', 'put'] as const)(
    'selection %s remains reachable while global legacy writes are readonly',
    async (method) => {
      const pool = makeRuntimePool({ globalLlmRow: [] })
      const config = createConfig({ legacyLlmProvidersReadonly: true })
      const app = createRuntimeApp(pool, config)

      const res = method === 'get'
        ? await request(app).get('/v1/admin/llm-providers/selection').query({ tenantId: 'missing' })
        : await request(app).put('/v1/admin/llm-providers/selection').send({ tenantId: 'missing' })
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(pool.queries.some((q) => q.sql.includes('SELECT 1 FROM tenants'))).toBe(true)
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Break-glass 旁路
// ═══════════════════════════════════════════════════════════════════════

describe('break-glass bypass', () => {
  it('PUT writes successfully when legacyLlmProvidersReadonly=true AND catalogBreakGlass=true', async () => {
    const pool = makeRuntimePool({ allTenants: [] })
    const config = createConfig({ legacyLlmProvidersReadonly: true, catalogBreakGlass: true })
    const app = createRuntimeApp(pool, config)

    const res = await request(app).put('/v1/admin/llm-providers').send(goodDoc)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    // Break-glass path should have written two extra audit_logs entries:
    // 1. llm-providers.break-glass.write
    // 2. catalog.reconcile.pending
    const breakGlassAudits = pool.queries.filter(
      (q) => q.sql.includes('INSERT INTO audit_logs') && q.sql.includes('break-glass.write'),
    )
    expect(breakGlassAudits.length).toBe(1)

    const reconcileAudits = pool.queries.filter(
      (q) => q.sql.includes('INSERT INTO audit_logs') && q.sql.includes('catalog.reconcile.pending'),
    )
    expect(reconcileAudits.length).toBe(1)
  })

  it('DELETE succeeds when legacyLlmProvidersReadonly=true AND catalogBreakGlass=true', async () => {
    const pool = makeRuntimePool({ deleteRowCount: 1, allTenants: [] })
    const config = createConfig({ legacyLlmProvidersReadonly: true, catalogBreakGlass: true })
    const app = createRuntimeApp(pool, config)

    const res = await request(app).delete('/v1/admin/llm-providers')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    // Break-glass DELETE should also create break-glass audit + reconcile pending
    const breakGlassAudits = pool.queries.filter(
      (q) => q.sql.includes('INSERT INTO audit_logs') && q.sql.includes('break-glass.write'),
    )
    expect(breakGlassAudits.length).toBe(1)

    const reconcileAudits = pool.queries.filter(
      (q) => q.sql.includes('INSERT INTO audit_logs') && q.sql.includes('catalog.reconcile.pending'),
    )
    expect(reconcileAudits.length).toBe(1)
  })

  it('PUT does NOT create break-glass audit when catalogBreakGlass is false', async () => {
    const pool = makeRuntimePool({ allTenants: [] })
    const config = createConfig({ legacyLlmProvidersReadonly: false, catalogBreakGlass: false })
    const app = createRuntimeApp(pool, config)

    const res = await request(app).put('/v1/admin/llm-providers').send(goodDoc)
    expect(res.status).toBe(200)

    const breakGlassAudits = pool.queries.filter(
      (q) => q.sql.includes('break-glass.write'),
    )
    expect(breakGlassAudits.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Catalog Publish 在 break-glass 时冻结
// ═══════════════════════════════════════════════════════════════════════

describe('catalog publish freeze during break-glass', () => {
  it('snapshot-publish returns 503 when catalogBreakGlass=true', async () => {
    const pool = { query: async () => { throw new Error('must not query') } } as unknown as pg.Pool
    const config = createConfig({
      modelCatalogSnapshotWrite: true,
      catalogBreakGlass: true,
    })
    const app = createCatalogApp(pool, config)

    const res = await request(app)
      .post('/v1/admin/model-catalog/snapshot-publish')
      .send({ fingerprint: 'abc123' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('CATALOG_PUBLISH_FROZEN')
  })

  it('snapshot-restore returns 503 before body or database access when catalogBreakGlass=true', async () => {
    const pool = { query: async () => { throw new Error('must not query') } } as unknown as pg.Pool
    const config = createConfig({
      modelCatalogSnapshotWrite: true,
      catalogBreakGlass: true,
    })
    const app = createCatalogApp(pool, config)

    const res = await request(app)
      .post('/v1/admin/model-catalog/snapshot-restore')
      .send({ backupId: 'backup-must-not-be-read' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('CATALOG_RESTORE_FROZEN')
  })

  it('snapshot-publish does NOT freeze when catalogBreakGlass is false', async () => {
    // With break-glass off and snapshot write on, the endpoint should proceed
    // past the freeze check and hit the next validation (missing fingerprint → 400).
    const pool = { query: async () => { throw new Error('must not query') } } as unknown as pg.Pool
    const config = createConfig({
      modelCatalogSnapshotWrite: true,
      catalogBreakGlass: false,
    })
    const app = createCatalogApp(pool, config)

    const res = await request(app)
      .post('/v1/admin/model-catalog/snapshot-publish')
      .send({ fingerprint: '' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. 漂移检测 — checkCatalogDrift 函数
// ═══════════════════════════════════════════════════════════════════════

describe('checkCatalogDrift', () => {
  it('returns driftDetected=false when system is empty (no legacy, no catalog, no release)', async () => {
    const pool = makeDriftPool({
      globalLlmRow: [],
      catalogProviders: [],
      globalPolicy: null,
      releaseFingerprint: null,
    })

    const result = await checkCatalogDrift(pool)
    expect(result.driftDetected).toBe(false)
    expect(result.legacyFingerprint).toBeNull()
    expect(result.lastReleaseFingerprint).toBeNull()
    expect(result.details).toHaveLength(0)
  })

  it('returns driftDetected=true when legacy != release fingerprint', async () => {
    // Set up legacy with a provider so legacyFingerprint is a real hash.
    // Catalog is empty (different from legacy), and release fingerprint is
    // a hard-coded different string.
    const docJson = JSON.stringify(goodDoc)
    const pool = makeDriftPool({
      globalLlmRow: [{ encrypted_value: `enc:${docJson}` }],
      catalogProviders: [],
      globalPolicy: null,
      releaseFingerprint: 'deliberately-different-fingerprint',
    })

    const result = await checkCatalogDrift(pool)
    expect(result.driftDetected).toBe(true)
    expect(result.legacyFingerprint).toBeTruthy()
    expect(result.lastReleaseFingerprint).toBe('deliberately-different-fingerprint')
    // Legacy vs Release should be flagged
    expect(result.details.some((d) => d.includes('Legacy runtime fingerprint'))).toBe(true)
  })

  it('returns driftDetected=true when catalog != release fingerprint', async () => {
    // No legacy (null), catalog has data, release fingerprint differs.
    const pool = makeDriftPool({
      globalLlmRow: [],
      catalogProviders: [{
        id: 'lpi_1',
        legacy_provider_name: 'qwen',
        template_key: 'custom-openai',
        display_name: null,
        protocol: 'openai-completions',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        encrypted_api_key: 'enc:sk-qwen',
        source: 'manual',
        enabled: true,
        revision: 0,
        metadata: null,
        models: [{
          id: 'lpm_1',
          provider_instance_id: 'lpi_1',
          model_id: 'qwen-max',
          display_name: null,
          model_type: 'chat',
          runtime_enabled: true,
          discovered_params: null,
          override_params: null,
          effective_params: {},
          params_status: 'fallback',
          revision: 0,
          updated_at: new Date(0),
          snapshot_approved: false,
        }],
      }],
      globalPolicy: {
        default_model: 'lpm_1',
        image_model: null,
        compaction_model: null,
        fallback_models: [],
        revision: 0,
        updated_at: new Date(0),
      },
      releaseFingerprint: 'deliberately-different-fingerprint',
    })

    const result = await checkCatalogDrift(pool)
    expect(result.driftDetected).toBe(true)
    expect(result.catalogFingerprint).toBeTruthy()
    expect(result.lastReleaseFingerprint).toBe('deliberately-different-fingerprint')
    // Catalog vs Release should be flagged
    expect(result.details.some((d) => d.includes('Catalog snapshot fingerprint'))).toBe(true)
  })

  it('returns driftDetected=false when catalog matches release and no legacy', async () => {
    // Build a catalog snapshot, compute its fingerprint, then use that as
    // the release fingerprint — they should match.
    const catalogRow = {
      id: 'lpi_1',
      legacy_provider_name: 'qwen',
      template_key: 'custom-openai',
      display_name: null,
      protocol: 'openai-completions',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      encrypted_api_key: 'enc:sk-qwen',
      source: 'manual',
      enabled: true,
      revision: 0,
      metadata: null,
      models: [{
        id: 'lpm_1',
        provider_instance_id: 'lpi_1',
        model_id: 'qwen-max',
        display_name: null,
        model_type: 'chat',
        runtime_enabled: true,
        discovered_params: null,
        override_params: null,
        effective_params: {},
        params_status: 'fallback',
        revision: 0,
        updated_at: new Date(0),
        snapshot_approved: false,
      }],
    }
    const policy = {
      default_model: 'lpm_1',
      image_model: null,
      compaction_model: null,
      fallback_models: [],
      revision: 0,
      updated_at: new Date(0),
    }

    // First pass: compute the catalog fingerprint.
    const prePool = makeDriftPool({
      globalLlmRow: [],
      catalogProviders: [catalogRow],
      globalPolicy: policy,
      releaseFingerprint: null,
    })
    const preResult = await checkCatalogDrift(prePool)
    const catalogFp = preResult.catalogFingerprint!
    expect(catalogFp).toBeTruthy()

    // Second pass: use the catalog fingerprint as the release fingerprint.
    const pool = makeDriftPool({
      globalLlmRow: [],
      catalogProviders: [catalogRow],
      globalPolicy: policy,
      releaseFingerprint: catalogFp,
    })
    const result = await checkCatalogDrift(pool)
    expect(result.driftDetected).toBe(false)
    expect(result.catalogFingerprint).toBe(catalogFp)
    expect(result.lastReleaseFingerprint).toBe(catalogFp)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. 漂移检测端点 GET /v1/admin/model-catalog/drift-check
// ═══════════════════════════════════════════════════════════════════════

describe('drift-check endpoint', () => {
  it('returns 503 when modelCatalogRead is false', async () => {
    const pool = { query: async () => { throw new Error('must not query') } } as unknown as pg.Pool
    const config = createConfig({ modelCatalogRead: false })
    const app = createCatalogApp(pool, config)

    const res = await request(app).get('/v1/admin/model-catalog/drift-check')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('DISABLED')
  })

  it('returns drift result when modelCatalogRead is true', async () => {
    const pool = makeDriftPool({
      globalLlmRow: [],
      catalogProviders: [],
      globalPolicy: null,
      releaseFingerprint: null,
    })
    const config = createConfig({ modelCatalogRead: true })
    const app = createCatalogApp(pool, config)

    const res = await request(app).get('/v1/admin/model-catalog/drift-check')
    expect(res.status).toBe(200)
    expect(res.body.driftDetected).toBe(false)
    expect(res.body).toHaveProperty('legacyFingerprint')
    expect(res.body).toHaveProperty('catalogFingerprint')
    expect(res.body).toHaveProperty('lastReleaseFingerprint')
    expect(res.body).toHaveProperty('details')
  })
})
