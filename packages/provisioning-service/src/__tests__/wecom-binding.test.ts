import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WeComBindingError,
  getTenantWeComBinding,
  bindTenantWeCom,
  unbindTenantWeCom,
} from '../services/wecom-binding.js';
import type { ProvisioningConfig } from '../config.js';

// ── k8s-client mock ────────────────────────────────────────────────────
const k8sMock = vi.hoisted(() => ({
  putSecret: vi.fn(),
  restartDeployment: vi.fn(async () => true),
  patchDeploymentEnvVar: vi.fn(async () => false),
  patchDeploymentEnvFromSecret: vi.fn(async () => false),
}));

vi.mock('../services/k8s-client.js', () => ({
  putSecret: k8sMock.putSecret,
  restartDeployment: k8sMock.restartDeployment,
  patchDeploymentEnvVar: k8sMock.patchDeploymentEnvVar,
  patchDeploymentEnvFromSecret: k8sMock.patchDeploymentEnvFromSecret,
}));

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
  llmPushWorkerIntervalMs: 100,
  llmPushLeaseSeconds: 600,
};

interface FakeQuery { sql: string; params?: unknown[] }

function makeFakePool(
  tenant: Record<string, any> | null,
  opts: { binding?: Record<string, any> | null; conflicts?: any[] } = {},
) {
  const binding = opts.binding ?? null;
  const conflicts = opts.conflicts ?? [];
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('FROM wecom_bindings')) {
        // Conflict check query: SELECT tenant_id FROM wecom_bindings WHERE bot_id = $1 ...
        if (sql.includes('bot_id = $1') && sql.includes('tenant_id <> $2')) {
          return { rows: conflicts, rowCount: conflicts.length };
        }
        // Get query: SELECT tenant_id, bot_id, status, bound_at FROM wecom_bindings WHERE tenant_id = $1
        return {
          rows: binding
            ? [{ tenant_id: tenant?.tenant_id ?? 'default', bot_id: binding.bot_id ?? null, status: binding.status ?? 'bound', bound_at: binding.bound_at ?? null }]
            : [],
          rowCount: binding ? 1 : 0,
        };
      }
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return { rows: tenant ? [tenant] : [], rowCount: tenant ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as any;
}

const okFetch = (async () => new Response('ok', { status: 200 })) as any;
const failingFetch = (async () => { throw new Error('connection refused'); }) as any;

const openclawTenant = {
  tenant_id: 'topenc1aw00000000000000000000',
  status: 'active',
  k8s_namespace: 'dealclaw-topenc1aw00000000000000000000',
  message_plane: 'openclaw',
  agent_endpoint: null,
};

describe('getTenantWeComBinding', () => {
  it('returns unbound default when no row exists', async () => {
    const pool = makeFakePool(openclawTenant, { binding: null });
    const b = await getTenantWeComBinding(pool, openclawTenant.tenant_id);
    expect(b).toEqual({
      tenantId: openclawTenant.tenant_id,
      bound: false,
      botId: null,
      status: 'unbound',
      boundAt: null,
      lastError: null,
    });
  });

  it('reports bound state with bot id', async () => {
    const pool = makeFakePool(openclawTenant, { binding: { bot_id: 'bot_12345678', status: 'bound', bound_at: '2026-01-01T00:00:00Z' } });
    const b = await getTenantWeComBinding(pool, openclawTenant.tenant_id);
    expect(b).toMatchObject({ bound: true, botId: 'bot_12345678', status: 'bound', lastError: null });
  });
});

describe('bindTenantWeCom validation', () => {
  const tid = openclawTenant.tenant_id;

  it('rejects empty bot id', async () => {
    const pool = makeFakePool(openclawTenant);
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: '', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'BAD_BOT_ID', status: 400 });
  });

  it('rejects bot id shorter than 8 chars', async () => {
    const pool = makeFakePool(openclawTenant);
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_123', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'BAD_BOT_ID', status: 400 });
  });

  it('rejects empty secret', async () => {
    const pool = makeFakePool(openclawTenant);
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: '' }),
    ).rejects.toMatchObject({ code: 'BAD_SECRET', status: 400 });
  });

  it('rejects secret shorter than 8 chars', async () => {
    const pool = makeFakePool(openclawTenant);
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: 's3cret' }),
    ).rejects.toMatchObject({ code: 'BAD_SECRET', status: 400 });
  });

  it('rejects unknown tenant', async () => {
    const pool = makeFakePool(null);
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('rejects destroyed tenant', async () => {
    const pool = makeFakePool({ ...openclawTenant, status: 'destroyed' });
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'TENANT_DESTROYED', status: 400 });
  });

  it('refuses non-openclaw plane (fail-closed)', async () => {
    const pool = makeFakePool({ ...openclawTenant, message_plane: 'gateway' });
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'PLANE_NOT_OPENCLAW', status: 400 });
  });

  it('rejects the same bot already bound to another tenant (409)', async () => {
    const pool = makeFakePool(openclawTenant, { conflicts: [{ tenant_id: 'other' }] });
    await expect(
      bindTenantWeCom(pool, baseConfig, tid, { botId: 'bot_1234', secret: 'secret12' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_CONFLICT', status: 409 });
  });
});

describe('bindTenantWeCom dry-run', () => {
  it('persists binding + audit log, no k8s calls', async () => {
    const pool = makeFakePool(openclawTenant);
    const r = await bindTenantWeCom(pool, baseConfig, openclawTenant.tenant_id, { botId: 'bot_1234', secret: 'secret12' });
    expect(r).toMatchObject({ ok: true, tenantId: openclawTenant.tenant_id, botId: 'bot_1234', restarted: false });

    const upsert = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO wecom_bindings'));
    expect(upsert).toBeDefined();
    expect(upsert?.params).toEqual([openclawTenant.tenant_id, 'bot_1234']);

    const log = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO tenant_status_log'));
    expect(log?.params?.[2]).toContain('DRY_RUN');

    expect(k8sMock.putSecret).not.toHaveBeenCalled();
  });
});

describe('bindTenantWeCom / unbindTenantWeCom k8s wiring (k8s mocked)', () => {
  const liveConfig: ProvisioningConfig = { ...baseConfig, k8sDryRun: false };
  const tid = openclawTenant.tenant_id;
  const ns = openclawTenant.k8s_namespace;
  const AG = `dealclaw-agent-${tid}`;
  const SECRET = `dealclaw-wecom-${tid}`;

  beforeEach(() => {
    vi.clearAllMocks();
    k8sMock.restartDeployment.mockResolvedValue(true);
    k8sMock.patchDeploymentEnvVar.mockResolvedValue(false);
    k8sMock.patchDeploymentEnvFromSecret.mockResolvedValue(false);
  });

  it('bind: writes secret, wires envFrom + switch, rolls agent, and confirms healthz', async () => {
    const pool = makeFakePool(openclawTenant);
    const r = await bindTenantWeCom(pool, liveConfig, tid, { botId: 'bot_1234', secret: 'secret12' }, okFetch);

    expect(r.restarted).toBe(true);
    expect(k8sMock.putSecret).toHaveBeenCalledWith(ns, SECRET, {
      DEALCLAW_WECOM_BOT_ID: 'bot_1234',
      DEALCLAW_WECOM_SECRET: 'secret12',
    });
    expect(k8sMock.patchDeploymentEnvFromSecret).toHaveBeenCalledWith(ns, AG, SECRET);
    expect(k8sMock.patchDeploymentEnvVar).toHaveBeenCalledWith(ns, AG, 'DEALCLAW_WECOM_BOUND', '1');
    expect(k8sMock.restartDeployment).toHaveBeenCalledWith(ns, AG);
  });

  it('throws AGENT_NOT_READY when agent healthz never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const pool = makeFakePool(openclawTenant);
      const p = bindTenantWeCom(pool, liveConfig, tid, { botId: 'bot_1234', secret: 'secret12' }, failingFetch);
      // Attach the rejection handler BEFORE advancing timers so the rejection
      // is observed (avoids an unhandled-rejection window when the loop gives up).
      const assertion = expect(p).rejects.toMatchObject({ code: 'AGENT_NOT_READY', status: 503 });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('unbind: flips switch off, rotates secret to placeholders, rolls agent', async () => {
    const pool = makeFakePool(openclawTenant, { binding: { bot_id: 'bot_1234', status: 'bound' } });
    const r = await unbindTenantWeCom(pool, liveConfig, tid);

    expect(r.restarted).toBe(true);
    expect(k8sMock.patchDeploymentEnvVar).toHaveBeenCalledWith(ns, AG, 'DEALCLAW_WECOM_BOUND', '0');

    const put = k8sMock.putSecret.mock.calls[0];
    expect(put[0]).toBe(ns);
    expect(put[1]).toBe(SECRET);
    expect(put[2].DEALCLAW_WECOM_BOT_ID).toBe(`placeholder-${tid}`);
    expect(typeof put[2].DEALCLAW_WECOM_SECRET).toBe('string');

    expect(k8sMock.restartDeployment).toHaveBeenCalledWith(ns, AG);
  });

  it('unbind: refuses when nothing is bound', async () => {
    const pool = makeFakePool(openclawTenant, { binding: null });
    await expect(unbindTenantWeCom(pool, liveConfig, tid)).rejects.toMatchObject({
      code: 'NOT_BOUND',
      status: 404,
    });
  });
});

describe('WeComBindingError shape', () => {
  it('carries status + code', () => {
    const e = new WeComBindingError(400, 'PLANE_NOT_OPENCLAW', 'plane');
    expect(e.status).toBe(400);
    expect(e.code).toBe('PLANE_NOT_OPENCLAW');
    expect(e).toBeInstanceOf(WeComBindingError);
  });
});
