import { describe, it, expect, vi, beforeEach } from 'vitest';

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => k8sMocks);

import {
  MioSupplierError,
  MIO_SUPPLIER_ID_PATTERN,
  updateTenantMioSupplier,
} from '../services/mio-supplier.js';
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

const prodConfig = { ...baseConfig, k8sDryRun: false };

interface FakeQuery { sql: string; params?: unknown[] }

function makeTenant(overrides: Record<string, any> = {}) {
  return {
    tenant_id: 't123',
    company_name: 'Test Co',
    status: 'active',
    k8s_namespace: 'dealclaw-t123',
    agent_endpoint: null,
    plan_tier: 'starter',
    quota_credits_monthly: '1000000',
    credits_account_id: 'acct_t123',
    mio_cdp_supplier_id: null,
    ...overrides,
  };
}

/** pg.Pool stand-in: records queries, returns canned rows per pattern. */
function makeFakePool(tenant: Record<string, any> | null, opts: { conflicts?: any[] } = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('WHERE mio_cdp_supplier_id = $1')) {
        return { rows: opts.conflicts ?? [], rowCount: 0 };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: tenant ? [tenant] : [], rowCount: tenant ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MIO_SUPPLIER_ID_PATTERN', () => {
  it('accepts alphanumeric / underscore / hyphen ids', () => {
    expect(MIO_SUPPLIER_ID_PATTERN.test('SUP12345')).toBe(true);
    expect(MIO_SUPPLIER_ID_PATTERN.test('sup-123_ab')).toBe(true);
  });

  it('rejects spaces, unicode and over-length ids', () => {
    expect(MIO_SUPPLIER_ID_PATTERN.test('sup 123')).toBe(false);
    expect(MIO_SUPPLIER_ID_PATTERN.test('供应商1')).toBe(false);
    expect(MIO_SUPPLIER_ID_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(MIO_SUPPLIER_ID_PATTERN.test('')).toBe(false);
  });
});

describe('updateTenantMioSupplier — validation & lookup', () => {
  it('rejects malformed supplier ids with 400', async () => {
    const pool = makeFakePool(makeTenant());
    await expect(updateTenantMioSupplier(pool, baseConfig, 't123', 'bad id!'))
      .rejects.toMatchObject({ status: 400, code: 'BAD_SUPPLIER_ID' });
  });

  it('returns 404 for unknown tenants', async () => {
    const pool = makeFakePool(null);
    await expect(updateTenantMioSupplier(pool, baseConfig, 'nope', 'SUP1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('refuses destroyed tenants', async () => {
    const pool = makeFakePool(makeTenant({ status: 'destroyed' }));
    await expect(updateTenantMioSupplier(pool, baseConfig, 't123', 'SUP1'))
      .rejects.toMatchObject({ status: 400, code: 'TENANT_DESTROYED' });
  });

  it('is a no-op when the value is unchanged', async () => {
    const pool = makeFakePool(makeTenant({ mio_cdp_supplier_id: 'SUP1' }));
    const r = await updateTenantMioSupplier(pool, baseConfig, 't123', 'SUP1');
    expect(r).toMatchObject({ ok: true, supplierId: 'SUP1', restarted: false });
    expect(pool.queries.some((q: FakeQuery) => q.sql.startsWith('UPDATE tenants'))).toBe(false);
  });
});

describe('updateTenantMioSupplier — uniqueness', () => {
  it('returns 409 SUPPLIER_ID_TAKEN when another live tenant holds the id', async () => {
    const pool = makeFakePool(makeTenant(), {
      conflicts: [{ tenant_id: 'other', company_name: 'Other Co' }],
    });
    await expect(updateTenantMioSupplier(pool, baseConfig, 't123', 'SUP1'))
      .rejects.toMatchObject({ status: 409, code: 'SUPPLIER_ID_TAKEN' });
    expect(pool.queries.some((q: FakeQuery) => q.sql.startsWith('UPDATE tenants'))).toBe(false);
  });
});

describe('updateTenantMioSupplier — dry-run', () => {
  it('persists the value and logs without touching K8s', async () => {
    const pool = makeFakePool(makeTenant());
    const r = await updateTenantMioSupplier(pool, baseConfig, 't123', ' SUP1 ');
    expect(r).toMatchObject({ ok: true, supplierId: 'SUP1', restarted: false });
    const update = pool.queries.find((q: FakeQuery) => q.sql.startsWith('UPDATE tenants'));
    expect(update?.params).toEqual(['SUP1', 't123']);
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });

  it('clears the value with an empty string', async () => {
    const pool = makeFakePool(makeTenant({ mio_cdp_supplier_id: 'SUP1' }));
    const r = await updateTenantMioSupplier(pool, baseConfig, 't123', '');
    expect(r.supplierId).toBeNull();
    const update = pool.queries.find((q: FakeQuery) => q.sql.startsWith('UPDATE tenants'));
    expect(update?.params).toEqual([null, 't123']);
  });
});

describe('updateTenantMioSupplier — real K8s path', () => {
  it('merges MIO_CDP_SUPPLIER_ID into the agent-config secret and restarts the agent', async () => {
    k8sMocks.getSecret.mockResolvedValue({
      type: 'Opaque',
      data: {
        DEALCLAW_TENANT_ID: Buffer.from('t123').toString('base64'),
        DEALCLAW_PLAN_TIER: Buffer.from('starter').toString('base64'),
      },
    });
    k8sMocks.restartDeployment.mockResolvedValue(true);
    const pool = makeFakePool(makeTenant());

    const r = await updateTenantMioSupplier(pool, prodConfig, 't123', 'SUP1');

    expect(r).toMatchObject({ ok: true, supplierId: 'SUP1', restarted: true, agentSecret: 'dealclaw-agent-config-t123' });
    expect(k8sMocks.getSecret).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-config-t123');
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-config-t123', {
      DEALCLAW_TENANT_ID: 't123',
      DEALCLAW_PLAN_TIER: 'starter',
      MIO_CDP_SUPPLIER_ID: 'SUP1',
    });
    expect(k8sMocks.restartDeployment).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-t123');
  });

  it('removes the key when clearing an existing value', async () => {
    k8sMocks.getSecret.mockResolvedValue({
      type: 'Opaque',
      data: {
        DEALCLAW_TENANT_ID: Buffer.from('t123').toString('base64'),
        MIO_CDP_SUPPLIER_ID: Buffer.from('SUP1').toString('base64'),
      },
    });
    k8sMocks.restartDeployment.mockResolvedValue(true);
    const pool = makeFakePool(makeTenant({ mio_cdp_supplier_id: 'SUP1' }));

    await updateTenantMioSupplier(pool, prodConfig, 't123', null);

    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-config-t123', {
      DEALCLAW_TENANT_ID: 't123',
    });
  });

  it('creates the secret from DB values when it does not exist yet', async () => {
    k8sMocks.getSecret.mockResolvedValue(null);
    k8sMocks.restartDeployment.mockResolvedValue(true);
    const pool = makeFakePool(makeTenant());

    await updateTenantMioSupplier(pool, prodConfig, 't123', 'SUP1');

    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'dealclaw-agent-config-t123', {
      DEALCLAW_TENANT_ID: 't123',
      DEALCLAW_PLAN_TIER: 'starter',
      DEALCLAW_INITIAL_CREDITS: '1000000',
      MIO_CDP_SUPPLIER_ID: 'SUP1',
    });
  });

  it('tolerates a missing agent Deployment (404) without failing', async () => {
    k8sMocks.getSecret.mockResolvedValue({ type: 'Opaque', data: {} });
    k8sMocks.restartDeployment.mockRejectedValue(new Error('restartDeployment failed: 404 not found'));
    const pool = makeFakePool(makeTenant());

    const r = await updateTenantMioSupplier(pool, prodConfig, 't123', 'SUP1');
    expect(r).toMatchObject({ ok: true, restarted: false });
  });

  it('skips K8s for external-agent tenants and still persists', async () => {
    const pool = makeFakePool(makeTenant({ k8s_namespace: null, agent_endpoint: 'http://central-agent:18789' }));
    const r = await updateTenantMioSupplier(pool, prodConfig, 't123', 'SUP1');
    expect(r).toMatchObject({ ok: true, supplierId: 'SUP1', restarted: false });
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
    expect(pool.queries.some((q: FakeQuery) => q.sql.startsWith('UPDATE tenants'))).toBe(true);
  });
});
