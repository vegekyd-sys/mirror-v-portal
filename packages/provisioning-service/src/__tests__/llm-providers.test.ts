import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => k8sMocks);

const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
}));

vi.mock('../services/crypto.js', () => cryptoMocks);

import {
  validateLlmProviders,
  resolveLlmProviders,
  pushLlmProviders,
  LLM_PROVIDERS_KEY,
} from '../services/llm-providers.js';
import { buildEnvFileContent } from '../services/skill-env.js';
import { createApp } from '../app.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-test',
  imageRegistry: 'test-registry/dealclaw',
  nexusGatewayImageTag: 'test',
  dealclawAgentImageTag: 'test',
  agentPvcSize: '10Gi',
  agentPvcStorageClass: 'alibabacloud-cnfs-nas',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
  ossBucket: 'dealclaw-backup',
  ossSecretName: 'dealclaw-oss',
  backupImage: 'test/ossutil',
  creditsLedgerUrl: 'http://credits-ledger:8081',
  creditsLedgerToken: '',
};
const prodConfig = { ...baseConfig, k8sDryRun: false };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const goodDoc = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk-qwen',
      models: [{ id: 'qwen-max' }, { id: 'qwq-plus', reasoning: true }],
    },
    {
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k-glm',
      models: ['glm-4.5'],
    },
  ],
  defaultModel: 'qwen/qwen-max',
};

interface FakeQuery { sql: string; params?: unknown[] }

function makeFakePool(opts: {
  tenant?: Record<string, any> | null;
  allTenants?: Array<{ tenant_id: string }>;
  tenantLlmRow?: { encrypted_value: string }[];
  globalLlmRow?: { encrypted_value: string }[];
  globalRows?: any[];
  tenantRows?: any[];
  deleteRowCount?: number;
} = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT 1 FROM tenants')) {
        return { rows: opts.tenant === null ? [] : [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT tenant_id FROM tenants')) {
        return { rows: opts.allTenants ?? [], rowCount: (opts.allTenants ?? []).length };
      }
      if (sql.includes('SELECT k8s_namespace FROM tenants')) {
        return { rows: opts.tenant ? [opts.tenant] : [], rowCount: opts.tenant ? 1 : 0 };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: opts.tenant ? [opts.tenant] : [], rowCount: opts.tenant ? 1 : 0 };
      }
      if (sql.includes('AND config_key = $1') || sql.includes('AND config_key = $2')) {
        // LLM_PROVIDERS lookup: tenant scope first when tenantId param present
        if (sql.includes('tenant_id = $1')) {
          return { rows: opts.tenantLlmRow ?? [], rowCount: (opts.tenantLlmRow ?? []).length };
        }
        return { rows: opts.globalLlmRow ?? [], rowCount: (opts.globalLlmRow ?? []).length };
      }
      if (sql.includes('INSERT INTO runtime_configs')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM runtime_configs')) {
        return { rows: [], rowCount: opts.deleteRowCount ?? 1 };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id IS NULL')) {
        return { rows: opts.globalRows ?? [], rowCount: (opts.globalRows ?? []).length };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id = $1')) {
        return { rows: opts.tenantRows ?? [], rowCount: (opts.tenantRows ?? []).length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

const makeTenant = (overrides: Record<string, any> = {}) => ({
  tenant_id: 't123',
  status: 'active',
  k8s_namespace: 'dealclaw-t123',
  agent_endpoint: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  k8sMocks.getSecret.mockResolvedValue(null);
  k8sMocks.deploymentExists.mockResolvedValue(true);
  k8sMocks.restartDeployment.mockResolvedValue(true);
});

// ── validateLlmProviders ─────────────────────────────────────────────

describe('validateLlmProviders', () => {
  it('normalises a good document (mixed model formats, trailing slash)', () => {
    const doc = validateLlmProviders(goodDoc);
    expect(doc.providers).toHaveLength(2);
    expect(doc.providers[0].baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(doc.providers[0].models[1]).toEqual({ id: 'qwq-plus', reasoning: true });
    expect(doc.providers[1].models).toEqual([{ id: 'glm-4.5' }]);
    expect(doc.defaultModel).toBe('qwen/qwen-max');
  });

  it('rejects duplicate provider names', () => {
    expect(() =>
      validateLlmProviders({
        providers: [
          { name: 'qwen', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'] },
          { name: 'qwen', baseUrl: 'https://b.com', apiKey: 'k', models: ['m'] },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('rejects invalid provider names', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'BadName', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'] }] }),
    ).toThrow(/提供商 ID/);
  });

  it('rejects non-http baseUrls', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'ftp://a.com', apiKey: 'k', models: ['m'] }] }),
    ).toThrow(/Base URL/);
  });

  it('rejects empty provider lists entries without apiKey or models', () => {
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'https://a.com', apiKey: '', models: ['m'] }] }),
    ).toThrow(/API Key/);
    expect(() =>
      validateLlmProviders({ providers: [{ name: 'qwen', baseUrl: 'https://a.com', apiKey: 'k', models: [] }] }),
    ).toThrow(/至少需要 1 个模型/);
  });

  it('rejects a defaultModel outside the configured providers', () => {
    expect(() =>
      validateLlmProviders({ ...goodDoc, defaultModel: 'other/m9' }),
    ).toThrow(/默认模型/);
  });
});

// ── resolveLlmProviders ──────────────────────────────────────────────

describe('resolveLlmProviders', () => {
  it('prefers the tenant override over the global row', async () => {
    const pool = makeFakePool({
      tenantLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify({ providers: [], defaultModel: null }) }],
    });
    const r = await resolveLlmProviders(pool, 't123');
    expect(r.source).toBe('tenant');
    expect(r.config?.providers).toHaveLength(2);
  });

  it('falls back to global when the tenant has no override', async () => {
    const pool = makeFakePool({
      globalLlmRow: [{ encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const r = await resolveLlmProviders(pool, 't123');
    expect(r.source).toBe('global');
    expect(r.config?.defaultModel).toBe('qwen/qwen-max');
  });

  it('reports none when nothing is configured', async () => {
    const pool = makeFakePool();
    const r = await resolveLlmProviders(pool, null);
    expect(r.source).toBe('none');
    expect(r.config).toBeNull();
  });
});

// ── pushLlmProviders ─────────────────────────────────────────────────

describe('pushLlmProviders', () => {
  it('writes the blob into tenant-config and rolls the agent', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      tenantRows: [{ config_key: LLM_PROVIDERS_KEY, encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    k8sMocks.getSecret.mockResolvedValue({
      data: {
        DEEPSEEK_API_KEY: b64('sk-ds'),
        LLM_PROVIDERS: b64('{"providers":[{"name":"old"}]}'),
        APIFY_TOKEN: b64('stale-skill-key'),
      },
    });
    const r = await pushLlmProviders(pool, prodConfig, 't123');
    expect(r.tenants[0]).toMatchObject({ tenantId: 't123', ok: true, restarted: true });
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'tenant-config', {
      DEEPSEEK_API_KEY: 'sk-ds',
      LLM_PROVIDERS: JSON.stringify(goodDoc),
    });
    expect(k8sMocks.restartDeployment).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-t123');
    expect(r.hint).toContain('滚动重启');
  });

  it('removes the blob from tenant-config when no provider config remains', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      // no LLM_PROVIDERS row anywhere → removal path
    });
    k8sMocks.getSecret.mockResolvedValue({
      data: { DEEPSEEK_API_KEY: b64('sk-ds'), LLM_PROVIDERS: b64('{}') },
    });
    const r = await pushLlmProviders(pool, prodConfig, 't123');
    expect(r.tenants[0].ok).toBe(true);
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'tenant-config', {
      DEEPSEEK_API_KEY: 'sk-ds',
    });
  });

  it('targets every live tenant for the global scope', async () => {
    const pool = makeFakePool({
      allTenants: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      tenant: makeTenant({ tenant_id: 't1' }),
      globalRows: [{ config_key: LLM_PROVIDERS_KEY, encrypted_value: 'enc:' + JSON.stringify(goodDoc) }],
    });
    const r = await pushLlmProviders(pool, prodConfig, null);
    expect(r.tenants).toHaveLength(2);
    expect(k8sMocks.putSecret).toHaveBeenCalledTimes(2);
  });
});

// ── .env isolation ───────────────────────────────────────────────────

describe('buildEnvFileContent excludes LLM_PROVIDERS', () => {
  it('never leaks the provider blob into the hot .env', () => {
    const r = buildEnvFileContent({
      APIFY_TOKEN: 'tok',
      LLM_PROVIDERS: JSON.stringify(goodDoc),
    });
    expect(r.content).toBe('APIFY_TOKEN=tok\n');
  });
});

// ── API (dry-run config) ─────────────────────────────────────────────

describe('llm-providers API', () => {
  const authHeader = { Authorization: 'Bearer test-token' };
  const savedToken = process.env.PROVISIONING_API_TOKEN;

  beforeEach(() => {
    process.env.PROVISIONING_API_TOKEN = 'test-token';
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.PROVISIONING_API_TOKEN;
    else process.env.PROVISIONING_API_TOKEN = savedToken;
  });

  it('requires bearer auth', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    expect((await request(app).get('/v1/admin/llm-providers')).status).toBe(401);
    expect((await request(app).put('/v1/admin/llm-providers').send(goodDoc)).status).toBe(401);
    expect((await request(app).delete('/v1/admin/llm-providers')).status).toBe(401);
  });

  it('PUT validates and stores the encrypted blob, returning a push hint', async () => {
    const pool = makeFakePool({ allTenants: [] });
    const app = createApp(pool, baseConfig);
    const res = await request(app).put('/v1/admin/llm-providers').set(authHeader).send(goodDoc);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.push.hint).toBeTruthy();
    const insert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    // stored via the crypto layer, never plaintext (mock prefixes enc:)
    const stored = String(insert!.params![1]);
    expect(stored).toMatch(/^enc:/);
    expect(JSON.parse(stored.slice(4)).providers[0].name).toBe('qwen');
  });

  it('PUT rejects invalid documents with 400', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app)
      .put('/v1/admin/llm-providers')
      .set(authHeader)
      .send({ providers: [{ name: 'X', baseUrl: 'nope', apiKey: '', models: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('GET returns source none when unconfigured', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const res = await request(app).get('/v1/admin/llm-providers').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', config: null });
  });

  it('DELETE 404s when the scope has no provider doc', async () => {
    const pool = makeFakePool({ deleteRowCount: 0 });
    const app = createApp(pool, baseConfig);
    const res = await request(app).delete('/v1/admin/llm-providers').set(authHeader);
    expect(res.status).toBe(404);
  });

  it('blocks the generic runtime-configs endpoints for LLM_PROVIDERS', async () => {
    const app = createApp(makeFakePool(), baseConfig);
    const put = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'LLM_PROVIDERS', value: '{}' });
    expect(put.status).toBe(400);
    const del = await request(app)
      .delete(`/v1/admin/runtime-configs/LLM_PROVIDERS`)
      .set(authHeader);
    expect(del.status).toBe(400);
  });
});
