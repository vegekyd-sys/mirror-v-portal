import { describe, it, expect } from 'vitest';
import {
  FeishuBindingError,
  verifyFeishuApp,
  getTenantFeishuBinding,
  bindTenantFeishuApp,
  unbindTenantFeishuApp,
} from '../services/feishu-binding.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-nexus-production',
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

interface FakeQuery { sql: string; params?: unknown[] }

/** pg.Pool stand-in: records queries, returns canned rows per pattern. */
function makeFakePool(tenant: Record<string, any> | null, opts: { conflict?: any[] } = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('WHERE app_id = $1')) {
        return { rows: opts.conflict ?? [], rowCount: 0 };
      }
      if (sql.includes('SELECT tenant_id, app_id, platform, im_open_id FROM tenants')) {
        return {
          rows: tenant ? [{ tenant_id: tenant.tenant_id, app_id: tenant.app_id ?? null, platform: tenant.platform ?? 'feishu', im_open_id: tenant.im_open_id ?? null }] : [],
          rowCount: tenant ? 1 : 0,
        };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: tenant ? [tenant] : [], rowCount: tenant ? 1 : 0 };
      }
      if (sql.includes('FROM rollout_targets')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

/** Stub fetch for the Feishu token endpoint. */
function okFetch() {
  return (async () =>
    new Response(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-abc', tenant_key: 'tk-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;
}

function badFetch(msg = 'app secret is wrong') {
  return (async () =>
    new Response(JSON.stringify({ code: 10003, msg }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;
}

describe('verifyFeishuApp', () => {
  it('resolves when Feishu returns code 0', async () => {
    const r = await verifyFeishuApp('cli_abc123', 'secret123', okFetch());
    expect(r.tenantKey).toBe('tk-1');
  });

  it('throws INVALID_CREDENTIALS when Feishu rejects', async () => {
    await expect(verifyFeishuApp('cli_abc123', 'wrong', badFetch())).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 400,
    });
  });

  it('throws FEISHU_UNREACHABLE on network failure', async () => {
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    await expect(verifyFeishuApp('cli_abc123', 'secret123', failing)).rejects.toMatchObject({
      code: 'FEISHU_UNREACHABLE',
      status: 502,
    });
  });
});

describe('getTenantFeishuBinding', () => {
  it('returns null for unknown tenant', async () => {
    const pool = makeFakePool(null);
    expect(await getTenantFeishuBinding(pool, 'nope')).toBeNull();
  });

  it('reports bound state', async () => {
    const pool = makeFakePool({ tenant_id: 'default', app_id: 'cli_x', platform: 'feishu' });
    const b = await getTenantFeishuBinding(pool, 'default');
    expect(b).toMatchObject({ tenantId: 'default', bound: true, appId: 'cli_x' });
  });
});

describe('bindTenantFeishuApp', () => {
  const externalTenant = {
    tenant_id: 'default',
    status: 'active',
    platform: 'web',
    app_id: null,
    k8s_namespace: null,
    agent_endpoint: 'http://dealclaw-agent.dealclaw-nexus-production:18789',
    plan_tier: 'starter',
    quota_credits_monthly: '1000000',
    credits_account_id: 'acct_default',
  };

  it('rejects a malformed app id', async () => {
    const pool = makeFakePool(externalTenant);
    await expect(
      bindTenantFeishuApp(pool, baseConfig, 'default', { appId: 'not-cli', appSecret: 'secret123' }, okFetch()),
    ).rejects.toMatchObject({ code: 'BAD_APP_ID' });
  });

  it('rejects unknown tenant', async () => {
    const pool = makeFakePool(null);
    await expect(
      bindTenantFeishuApp(pool, baseConfig, 'default', { appId: 'cli_abc123', appSecret: 'secret123' }, okFetch()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('rejects an app already bound to another tenant', async () => {
    const pool = makeFakePool(externalTenant, { conflict: [{ tenant_id: 'other', company_name: '其他公司' }] });
    await expect(
      bindTenantFeishuApp(pool, baseConfig, 'default', { appId: 'cli_abc123', appSecret: 'secret123' }, okFetch()),
    ).rejects.toMatchObject({ code: 'APP_ALREADY_BOUND', status: 409 });
  });

  it('refuses to persist when credentials fail verification', async () => {
    const pool = makeFakePool(externalTenant);
    await expect(
      bindTenantFeishuApp(pool, baseConfig, 'default', { appId: 'cli_abc123', appSecret: 'wrong-secret' }, badFetch()),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const update = pool.queries.find((q: FakeQuery) => q.sql.includes('UPDATE tenants SET app_id'));
    expect(update).toBeUndefined(); // nothing persisted
  });

  it('binds an external-agent tenant into the central namespace (dry-run)', async () => {
    const pool = makeFakePool(externalTenant);
    const r = await bindTenantFeishuApp(pool, baseConfig, 'default', { appId: 'cli_abc123', appSecret: 'secret123' }, okFetch());
    expect(r.ok).toBe(true);
    expect(r.gatewayNamespace).toBe('dealclaw-nexus-production'); // central ns, no k8s_namespace
    expect(r.agentUrl).toBe('http://dealclaw-agent.dealclaw-nexus-production:18789');
    const update = pool.queries.find((q: FakeQuery) => q.sql.includes('UPDATE tenants SET app_id'));
    expect(update?.params).toEqual(['cli_abc123', 'secret123', 'default']);
  });

  it('binds a regular tenant into its own namespace (dry-run)', async () => {
    const tenant = {
      ...externalTenant,
      tenant_id: '264559c9f19f4e7eaffe99cf007ea9fb',
      k8s_namespace: 'dealclaw-264559c9f19f4e7eaffe99cf007ea9fb',
      agent_endpoint: null,
    };
    const pool = makeFakePool(tenant);
    const r = await bindTenantFeishuApp(pool, baseConfig, tenant.tenant_id, { appId: 'cli_abc123', appSecret: 'secret123' }, okFetch());
    expect(r.gatewayNamespace).toBe(tenant.k8s_namespace);
    expect(r.agentUrl).toBe(`http://dealclaw-agent-${tenant.tenant_id}.${tenant.k8s_namespace}:18789`);
  });
});

describe('unbindTenantFeishuApp', () => {
  it('errors when nothing is bound', async () => {
    const pool = makeFakePool({ tenant_id: 'default', status: 'active', app_id: null, platform: 'web' });
    await expect(unbindTenantFeishuApp(pool, baseConfig, 'default')).rejects.toMatchObject({
      code: 'NOT_BOUND',
      status: 404,
    });
  });

  it('clears credentials and platform; KEEPS the gateway as LLM egress proxy (dry-run)', async () => {
    const tenant = {
      tenant_id: 'default',
      status: 'active',
      platform: 'feishu',
      app_id: 'cli_abc123',
      k8s_namespace: null,
      agent_endpoint: 'http://dealclaw-agent.dealclaw-nexus-production:18789',
    };
    const pool = makeFakePool(tenant);
    const r = await unbindTenantFeishuApp(pool, baseConfig, 'default');
    expect(r.gatewayKept).toBe('nexus-gateway-default');
    expect(r.gatewayNamespace).toBeNull(); // dry-run
    expect(r.restarted).toBe(false);
    const update = pool.queries.find((q: FakeQuery) => q.sql.includes('app_id = NULL'));
    expect(update?.params).toEqual(['default']);
  });
});

describe('FeishuBindingError shape', () => {
  it('carries status + code', () => {
    const e = new FeishuBindingError(409, 'APP_ALREADY_BOUND', 'dup');
    expect(e.status).toBe(409);
    expect(e.code).toBe('APP_ALREADY_BOUND');
    expect(e).toBeInstanceOf(FeishuBindingError);
  });
});
