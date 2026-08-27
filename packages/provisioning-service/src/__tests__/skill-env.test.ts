import { describe, it, expect, vi, beforeEach } from 'vitest';

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  getDeployment: vi.fn(),
  patchDeployment: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => k8sMocks);

const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
}));

vi.mock('../services/crypto.js', () => cryptoMocks);

import {
  buildEnvFileContent,
  getTenantSkillEnvView,
  updateSkillEnvSecret,
  pushTenantSkillEnv,
  pushSkillEnvToAllTenants,
  ENV_FROM_ONLY_KEYS,
  DEPRECATED_KEYS,
  HINT_HOT,
  HINT_FIRST_MOUNT,
  HINT_SKIPPED,
} from '../services/skill-env.js';
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
    mio_cdp_supplier_id: null,
    ...overrides,
  };
}

/**
 * pg.Pool stand-in: records queries and returns canned rows per SQL pattern.
 * runtime_configs rows carry `enc:`-prefixed values; the mocked crypto
 * decrypts them transparently.
 */
function makeFakePool(opts: {
  tenant?: Record<string, any> | null;
  globalRows?: any[];
  tenantRows?: any[];
  allTenants?: Array<{ tenant_id: string }>;
} = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT tenant_id FROM tenants')) {
        return { rows: opts.allTenants ?? [], rowCount: (opts.allTenants ?? []).length };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: opts.tenant ? [opts.tenant] : [], rowCount: opts.tenant ? 1 : 0 };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id IS NULL')) {
        return { rows: opts.globalRows ?? [], rowCount: (opts.globalRows ?? []).length };
      }
      if (sql.includes('FROM runtime_configs WHERE tenant_id = $1')) {
        return { rows: opts.tenantRows ?? [], rowCount: (opts.tenantRows ?? []).length };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

function makeDeployment(overrides: Record<string, any> = {}) {
  return {
    spec: {
      template: {
        spec: {
          volumes: [{ name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } }],
          containers: [
            {
              name: 'dealclaw-agent-t123',
              volumeMounts: [{ name: 'runtime-data', mountPath: '/data' }],
            },
          ],
          ...overrides,
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  k8sMocks.getSecret.mockResolvedValue(null);
  k8sMocks.getDeployment.mockResolvedValue(null);
  k8sMocks.patchDeployment.mockResolvedValue(true);
});

// ── buildEnvFileContent ──────────────────────────────────────────────

describe('buildEnvFileContent', () => {
  it('excludes envFrom-only (LLM_PROVIDERS) and deprecated (DEEPSEEK_API_KEY) keys, sorts the rest', () => {
    const r = buildEnvFileContent({
      DEEPSEEK_API_KEY: 'sk-llm',
      LLM_PROVIDERS: '{"providers":[]}',
      MIO_CDP_APP_KEY: 'mio',
      APIFY_TOKEN: 'apify',
    });
    expect(r.content).toBe('APIFY_TOKEN=apify\nMIO_CDP_APP_KEY=mio\n');
    expect(r.skippedKeys).toEqual([]);
  });

  it('injects MIO_CDP_SUPPLIER_ID from the tenant record when not overridden', () => {
    const r = buildEnvFileContent({ APIFY_TOKEN: 'x' }, 'SUP123');
    expect(r.content).toBe('APIFY_TOKEN=x\nMIO_CDP_SUPPLIER_ID=SUP123\n');
  });

  it('keeps an explicit MIO_CDP_SUPPLIER_ID override over the tenant record', () => {
    const r = buildEnvFileContent({ MIO_CDP_SUPPLIER_ID: 'OTHER' }, 'SUP123');
    expect(r.content).toBe('MIO_CDP_SUPPLIER_ID=OTHER\n');
  });

  it('skips multi-line values instead of corrupting the file', () => {
    const r = buildEnvFileContent({ GOOD: 'ok', BAD: 'a\nb' });
    expect(r.content).toBe('GOOD=ok\n');
    expect(r.skippedKeys).toEqual(['BAD']);
  });

  it('returns an empty string for empty input', () => {
    expect(buildEnvFileContent({}).content).toBe('');
  });
});

// ── updateSkillEnvSecret ─────────────────────────────────────────────

describe('updateSkillEnvSecret', () => {
  it('throws 404 for unknown tenants', async () => {
    const pool = makeFakePool({ tenant: null });
    await expect(updateSkillEnvSecret(pool, prodConfig, 'nope'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('skips in dry-run mode without touching the cluster', async () => {
    const pool = makeFakePool({ tenant: makeTenant() });
    const r = await updateSkillEnvSecret(pool, baseConfig, 't123');
    expect(r).toMatchObject({ pushed: false, skippedReason: 'dry-run' });
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });

  it('skips external-agent tenants (central agent managed via GitOps)', async () => {
    const pool = makeFakePool({ tenant: makeTenant({ agent_endpoint: 'http://central' }) });
    const r = await updateSkillEnvSecret(pool, prodConfig, 't123');
    expect(r).toMatchObject({ pushed: false, skippedReason: 'no-own-agent' });
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });

  it('writes the merged .env content to the skill-env Secret', async () => {
    const pool = makeFakePool({
      tenant: makeTenant({ mio_cdp_supplier_id: 'SUP1' }),
      globalRows: [{ config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' }],
      tenantRows: [{ config_key: 'MIO_CDP_APP_KEY', encrypted_value: 'enc:appk' }],
    });
    const r = await updateSkillEnvSecret(pool, prodConfig, 't123');
    expect(r.pushed).toBe(true);
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'skill-env', {
      '.env': 'APIFY_TOKEN=tok\nMIO_CDP_APP_KEY=appk\nMIO_CDP_SUPPLIER_ID=SUP1\n',
    });
  });
});

// ── pushTenantSkillEnv ───────────────────────────────────────────────

describe('pushTenantSkillEnv', () => {
  it('refuses destroyed tenants', async () => {
    const pool = makeFakePool({ tenant: makeTenant({ status: 'destroyed' }) });
    await expect(pushTenantSkillEnv(pool, prodConfig, 't123'))
      .rejects.toMatchObject({ status: 400, code: 'TENANT_DESTROYED' });
  });

  it('reports skipped (dry-run / external agent) without cluster writes', async () => {
    const pool = makeFakePool({ tenant: makeTenant() });
    const r = await pushTenantSkillEnv(pool, baseConfig, 't123');
    expect(r).toMatchObject({ rollout: 'skipped', hint: HINT_SKIPPED });
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });

  it('patches the Deployment once when the volume mount is missing', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [{ config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' }],
    });
    // Deployment exists but has no skill-env volume/mount.
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment());
    const r = await pushTenantSkillEnv(pool, prodConfig, 't123');

    expect(r.secretUpdated).toBe(true);
    expect(r.rollout).toBe('restarted');
    expect(r.hint).toBe(HINT_FIRST_MOUNT);
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'skill-env', {
      '.env': 'APIFY_TOKEN=tok\n',
    });
    expect(k8sMocks.patchDeployment).toHaveBeenCalledTimes(1);
    const [ns, name, body] = k8sMocks.patchDeployment.mock.calls[0];
    expect(ns).toBe('dealclaw-t123');
    expect(name).toBe('dealclaw-agent-t123');
    const spec = (body as any).spec.template.spec;
    expect(spec.volumes[0].secret).toEqual({ secretName: 'skill-env', defaultMode: 0o440 });
    expect(spec.containers[0].volumeMounts[0]).toEqual({
      name: 'skill-env',
      mountPath: '/run/secrets/skill-env',
      readOnly: true,
    });
    expect(pool.queries.some((q: FakeQuery) => q.sql.includes('INSERT INTO tenant_status_log'))).toBe(true);
  });

  it('is a hot no-rollout push when the mount already exists', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [{ config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' }],
    });
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment({
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } },
        { name: 'skill-env', secret: { secretName: 'skill-env' } },
      ],
      containers: [
        {
          name: 'dealclaw-agent-t123',
          volumeMounts: [
            { name: 'runtime-data', mountPath: '/data' },
            { name: 'skill-env', mountPath: '/run/secrets/skill-env' },
          ],
        },
      ],
    }));
    const r = await pushTenantSkillEnv(pool, prodConfig, 't123');
    expect(r.rollout).toBe('none');
    expect(r.hint).toBe(HINT_HOT);
    expect(k8sMocks.patchDeployment).not.toHaveBeenCalled();
  });

  it('tolerates a missing Deployment (e.g. mid deprovision) without failing', async () => {
    const pool = makeFakePool({ tenant: makeTenant() });
    k8sMocks.getDeployment.mockResolvedValue(null);
    const r = await pushTenantSkillEnv(pool, prodConfig, 't123');
    expect(r.secretUpdated).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Deployment|挂载/);
  });

  it('strips skill AND deprecated keys from the legacy tenant-config Secret (no envFrom shadowing)', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [{ config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' }],
    });
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment({
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } },
        { name: 'skill-env', secret: { secretName: 'skill-env' } },
      ],
      containers: [
        {
          name: 'dealclaw-agent-t123',
          volumeMounts: [
            { name: 'runtime-data', mountPath: '/data' },
            { name: 'skill-env', mountPath: '/run/secrets/skill-env' },
          ],
        },
      ],
    }));
    // Legacy secret still carries skill keys + the deprecated DEEPSEEK key
    // from provisioning time.
    k8sMocks.getSecret.mockResolvedValue({
      type: 'Opaque',
      data: {
        DEEPSEEK_API_KEY: Buffer.from('sk-llm').toString('base64'),
        APIFY_TOKEN: Buffer.from('old-tok').toString('base64'),
      },
    });

    const r = await pushTenantSkillEnv(pool, prodConfig, 't123');
    expect(r.rollout).toBe('none');
    // Only envFrom-only keys (LLM_PROVIDERS) survive — here that is none, so
    // the secret is rewritten empty and the legacy values can never shadow.
    expect(k8sMocks.putSecret).toHaveBeenCalledWith('dealclaw-t123', 'tenant-config', {});
    expect(r.warnings.join(' ')).toMatch(/移除/);
  });

  it('leaves tenant-config untouched when it only holds envFrom-only keys (LLM_PROVIDERS)', async () => {
    const pool = makeFakePool({ tenant: makeTenant() });
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment({
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } },
        { name: 'skill-env', secret: { secretName: 'skill-env' } },
      ],
      containers: [
        {
          name: 'dealclaw-agent-t123',
          volumeMounts: [
            { name: 'runtime-data', mountPath: '/data' },
            { name: 'skill-env', mountPath: '/run/secrets/skill-env' },
          ],
        },
      ],
    }));
    k8sMocks.getSecret.mockResolvedValue({
      type: 'Opaque',
      data: { LLM_PROVIDERS: Buffer.from('{"providers":[]}').toString('base64') },
    });

    await pushTenantSkillEnv(pool, prodConfig, 't123');
    const calls = k8sMocks.putSecret.mock.calls.filter((c: any[]) => c[1] === 'tenant-config');
    expect(calls).toHaveLength(0);
  });

  it('records multi-line values as skipped keys in the result and status log', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [
        { config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' },
        { config_key: 'BAD', encrypted_value: 'enc:a\nb' },
      ],
    });
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment({
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } },
        { name: 'skill-env', secret: { secretName: 'skill-env' } },
      ],
      containers: [
        {
          name: 'dealclaw-agent-t123',
          volumeMounts: [
            { name: 'runtime-data', mountPath: '/data' },
            { name: 'skill-env', mountPath: '/run/secrets/skill-env' },
          ],
        },
      ],
    }));
    const r = await pushTenantSkillEnv(pool, prodConfig, 't123');
    expect(r.skippedKeys).toEqual(['BAD']);
    expect(r.warnings.join(' ')).toMatch(/换行/);
  });
});

// ── pushSkillEnvToAllTenants ─────────────────────────────────────────

describe('pushSkillEnvToAllTenants', () => {
  it('pushes every live tenant sequentially and aggregates the hint', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [{ config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok' }],
      allTenants: [{ tenant_id: 't123' }, { tenant_id: 't456' }],
    });
    k8sMocks.getDeployment.mockResolvedValue(makeDeployment({
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: 'pvc' } },
        { name: 'skill-env', secret: { secretName: 'skill-env' } },
      ],
      containers: [
        {
          name: 'dealclaw-agent-t123',
          volumeMounts: [
            { name: 'runtime-data', mountPath: '/data' },
            { name: 'skill-env', mountPath: '/run/secrets/skill-env' },
          ],
        },
      ],
    }));
    const r = await pushSkillEnvToAllTenants(pool, prodConfig);
    expect(r.tenants).toHaveLength(2);
    expect(r.tenants.every((t) => t.ok)).toBe(true);
    expect(r.hint).toMatch(/已推送 2\/2/);
  });

  it('collects per-tenant failures instead of aborting the batch', async () => {
    const pool = makeFakePool({
      tenant: null, // loadTenant inside push → 404 for both
      allTenants: [{ tenant_id: 't123' }, { tenant_id: 't456' }],
    });
    const r = await pushSkillEnvToAllTenants(pool, prodConfig);
    expect(r.tenants.every((t) => !t.ok)).toBe(true);
    expect(r.tenants[0].error).toBeTruthy();
  });
});

// ── getTenantSkillEnvView ────────────────────────────────────────────

describe('getTenantSkillEnvView', () => {
  it('merges global defaults with tenant overrides and tags the source', async () => {
    const pool = makeFakePool({
      tenant: makeTenant({ mio_cdp_supplier_id: 'SUP1' }),
      globalRows: [
        { config_key: 'APIFY_TOKEN', encrypted_value: 'enc:tok', is_secret: true, description: null, updated_at: '2026-01-01' },
        { config_key: 'MIO_CDP_APP_KEY', encrypted_value: 'enc:glob', is_secret: true, description: null, updated_at: '2026-01-01' },
      ],
      tenantRows: [
        { config_key: 'MIO_CDP_APP_KEY', encrypted_value: 'enc:own', is_secret: true, description: '租户自备', updated_at: '2026-02-02' },
      ],
    });
    const view = await getTenantSkillEnvView(pool, 't123', true);
    const byKey = Object.fromEntries(view.entries.map((e) => [e.key, e]));
    expect(byKey.APIFY_TOKEN.source).toBe('global');
    expect(byKey.MIO_CDP_APP_KEY.source).toBe('tenant');
    expect(byKey.MIO_CDP_SUPPLIER_ID.source).toBe('tenant-record');
    expect(byKey.MIO_CDP_SUPPLIER_ID.displayValue).toBe('SUP1');
    // secret entries are decrypted and shown as-is (admin sees the real .env)
    expect(byKey.APIFY_TOKEN.displayValue).toBe('tok');
    expect(byKey.MIO_CDP_APP_KEY.displayValue).toBe('own');
    expect(view.entries.map((e) => e.key)).toEqual([
      'APIFY_TOKEN',
      'MIO_CDP_APP_KEY',
      'MIO_CDP_SUPPLIER_ID',
    ]);
  });

  it('hides envFrom-only (LLM_PROVIDERS) and deprecated (DEEPSEEK_API_KEY) keys from the .env card', async () => {
    const pool = makeFakePool({
      tenant: makeTenant(),
      globalRows: [
        { config_key: 'LLM_PROVIDERS', encrypted_value: 'enc:{}', is_secret: true, description: null, updated_at: '2026-01-01' },
        { config_key: 'DEEPSEEK_API_KEY', encrypted_value: 'enc:sk', is_secret: true, description: null, updated_at: '2026-01-01' },
      ],
    });
    const view = await getTenantSkillEnvView(pool, 't123', true);
    expect(view.entries).toHaveLength(0);
    expect(ENV_FROM_ONLY_KEYS.has('DEEPSEEK_API_KEY')).toBe(false);
    expect(ENV_FROM_ONLY_KEYS.has('LLM_PROVIDERS')).toBe(true);
    expect(DEPRECATED_KEYS.has('DEEPSEEK_API_KEY')).toBe(true);
  });
});
