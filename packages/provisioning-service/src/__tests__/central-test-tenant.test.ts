import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the K8s layer — unit tests must not touch a cluster.
const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  deploymentExists: vi.fn(),
  createSecret: vi.fn(),
  putSecret: vi.fn(),
  createDeployment: vi.fn(),
  createService: vi.fn(),
  deleteDeployment: vi.fn(),
  deleteService: vi.fn(),
  restartDeployment: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => k8sMocks);

vi.mock('../services/credits-account.js', () => ({
  createCreditsAccount: vi.fn(async () => ({ ok: true })),
}));

import { ensureCentralTestTenant, CENTRAL_TEST_TENANT_ID } from '../services/central-test-tenant.js';
import type { ProvisioningConfig } from '../config.js';

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: false,
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
  defaultTenantAgentUrl: 'http://dealclaw-agent.dealclaw-nexus-production:18789',
};

const dryRunConfig = { ...baseConfig, k8sDryRun: true };

const legacyCreds = {
  data: {
    DEALCLAW_APP_ID: Buffer.from('cli_aae6930c69f8dbc1').toString('base64'),
    DEALCLAW_APP_SECRET: Buffer.from('legacy-secret-value').toString('base64'),
    DEEPSEEK_API_KEY: Buffer.from('sk-x').toString('base64'),
  },
};

interface FakeQuery { sql: string; params?: unknown[] }

/**
 * Stateful fake pool: the tenant row is mutable so INSERT/UPDATE performed
 * by the code under test are visible to subsequent SELECTs (the adoption
 * flow INSERTs a row and then bindTenantFeishuApp re-reads it).
 */
function makeFakePool(initial: Record<string, any> | null) {
  let tenant: Record<string, any> | null = initial ? { ...initial } : null;
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.startsWith('INSERT INTO tenants')) {
        tenant = {
          tenant_id: params?.[0],
          company_name: params?.[1],
          contact_email: params?.[2],
          credits_account_id: params?.[3],
          agent_endpoint: params?.[4],
          platform: 'feishu',
          plan_tier: 'starter',
          status: 'active',
          app_id: null,
          app_secret: null,
          k8s_namespace: null,
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE tenants SET app_id')) {
        if (tenant) {
          tenant.app_id = params?.[0];
          tenant.app_secret = params?.[1];
          tenant.platform = 'feishu';
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE tenants SET app_id = NULL')) {
        if (tenant) {
          tenant.app_id = null;
          tenant.app_secret = null;
          tenant.platform = 'web';
        }
        return { rows: [], rowCount: 1 };
      }
      // ensureCentralTestTenant's SELECT (includes app_secret in projection)
      if (sql.includes('app_secret FROM tenants WHERE tenant_id = $1')) {
        return { rows: tenant ? [tenant] : [], rowCount: tenant ? 1 : 0 };
      }
      // bindTenantFeishuApp's SELECT
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: tenant ? [tenant] : [], rowCount: tenant ? 1 : 0 };
      }
      if (sql.includes('WHERE app_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM rollout_targets')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  k8sMocks.deploymentExists.mockResolvedValue(true);
  k8sMocks.restartDeployment.mockResolvedValue(false);
  for (const fn of [k8sMocks.createSecret, k8sMocks.putSecret, k8sMocks.createDeployment, k8sMocks.createService]) {
    fn.mockResolvedValue(undefined);
  }
});

/** Stub fetch for the Feishu token endpoint (verification always passes). */
const okFetch = (async () =>
  new Response(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-abc', tenant_key: 'tk-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as any;

describe('ensureCentralTestTenant', () => {
  it('skips entirely in k8s dry-run mode', async () => {
    const pool = makeFakePool(null);
    const r = await ensureCentralTestTenant(pool, dryRunConfig, okFetch);
    expect(r.action).toBe('skipped');
    expect(k8sMocks.getSecret).not.toHaveBeenCalled();
  });

  it('adopts a fresh tenant using legacy tenant-config credentials', async () => {
    k8sMocks.getSecret.mockResolvedValue({ type: 'Opaque', data: legacyCreds.data });
    const pool = makeFakePool(null);
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('adopted');

    const insert = pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO tenants'));
    expect(insert?.params?.[0]).toBe(CENTRAL_TEST_TENANT_ID);
    expect(insert?.params?.[4]).toBe(baseConfig.defaultTenantAgentUrl); // external agent mode

    // bind went through: secret materialized with legacy creds, gateway deployed in central ns
    expect(k8sMocks.putSecret).toHaveBeenCalledWith(
      'dealclaw-nexus-production',
      'dealclaw-bot-dealclaw-test',
      { DEALCLAW_APP_ID: 'cli_aae6930c69f8dbc1', DEALCLAW_APP_SECRET: 'legacy-secret-value' },
    );
    expect(k8sMocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'nexus-gateway-dealclaw-test',
        namespace: 'dealclaw-nexus-production',
      }),
    );
    const bindUpdate = pool.queries.find((q: FakeQuery) => q.sql.includes('UPDATE tenants SET app_id'));
    expect(bindUpdate?.params?.[0]).toBe('cli_aae6930c69f8dbc1');
  });

  it('reports waiting_config when tenant-config has no feishu credentials', async () => {
    k8sMocks.getSecret.mockResolvedValue({
      type: 'Opaque',
      data: { DEEPSEEK_API_KEY: Buffer.from('sk-x').toString('base64') },
    });
    const pool = makeFakePool(null);
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('waiting_config');
    expect(pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO tenants'))).toBeUndefined();
  });

  it('never re-binds after an explicit admin unbind', async () => {
    k8sMocks.getSecret.mockResolvedValue({ type: 'Opaque', data: legacyCreds.data });
    const pool = makeFakePool({ tenant_id: CENTRAL_TEST_TENANT_ID, status: 'active', platform: 'web', app_id: null, app_secret: null });
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('skipped');
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });

  it('is already_ready when bound and the gateway deployment exists', async () => {
    const pool = makeFakePool({
      tenant_id: CENTRAL_TEST_TENANT_ID,
      status: 'active',
      platform: 'feishu',
      app_id: 'cli_aae6930c69f8dbc1',
      app_secret: 'legacy-secret-value',
    });
    k8sMocks.deploymentExists.mockResolvedValue(true);
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('already_ready');
    expect(k8sMocks.createDeployment).not.toHaveBeenCalled();
  });

  it('self-heals a missing gateway using the row credentials (not tenant-config)', async () => {
    k8sMocks.getSecret.mockResolvedValue({ type: 'Opaque', data: legacyCreds.data });
    k8sMocks.deploymentExists.mockResolvedValue(false); // gateway gone
    const pool = makeFakePool({
      tenant_id: CENTRAL_TEST_TENANT_ID,
      status: 'active',
      platform: 'feishu',
      app_id: 'cli_rebound9999', // admin re-bound to a different app
      app_secret: 'row-secret',
    });
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('healed');
    // re-bind used the ROW's credentials, not the legacy tenant-config ones
    expect(k8sMocks.putSecret).toHaveBeenCalledWith(
      'dealclaw-nexus-production',
      'dealclaw-bot-dealclaw-test',
      { DEALCLAW_APP_ID: 'cli_rebound9999', DEALCLAW_APP_SECRET: 'row-secret' },
    );
  });

  it('retries the initial bind when the row exists but was never bound', async () => {
    k8sMocks.getSecret.mockResolvedValue({ type: 'Opaque', data: legacyCreds.data });
    const pool = makeFakePool({
      tenant_id: CENTRAL_TEST_TENANT_ID,
      status: 'active',
      platform: 'feishu',
      app_id: null,
      app_secret: null,
    });
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('adopted');
    expect(k8sMocks.putSecret).toHaveBeenCalled();
  });

  it('skips a destroyed tenant', async () => {
    const pool = makeFakePool({
      tenant_id: CENTRAL_TEST_TENANT_ID,
      status: 'destroyed',
      platform: 'feishu',
      app_id: 'cli_x',
      app_secret: 's',
    });
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('skipped');
  });

  it('never throws — a k8s failure becomes a failed result', async () => {
    k8sMocks.getSecret.mockRejectedValue(new Error('api server down'));
    const pool = makeFakePool(null);
    const r = await ensureCentralTestTenant(pool, baseConfig, okFetch);
    expect(r.action).toBe('failed');
    expect(r.detail).toContain('api server down');
  });
});
