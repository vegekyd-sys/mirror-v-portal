import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * provisionTenant image-tag resolution: the promoted rollout target
 * (rollout_targets table) must override the env-configured static tags so a
 * freshly provisioned gateway/agent runs the same version the fleet was
 * rolled to. DB failure / no promoted tag / no pool → env tags stay.
 */

const k8sMock = vi.hoisted(() => ({
  createNamespace: vi.fn(),
  getSecret: vi.fn(async () => ({ data: {}, type: 'kubernetes.io/dockerconfigjson' })),
  copySecretToNamespace: vi.fn(),
  createSecret: vi.fn(),
  createDeployment: vi.fn(),
  createService: vi.fn(),
  createPersistentVolumeClaim: vi.fn(),
}));

vi.mock('../services/k8s-client.js', () => ({
  ...k8sMock,
  deleteNamespace: vi.fn(),
  deleteSecret: vi.fn(),
  deleteDeployment: vi.fn(),
  deleteService: vi.fn(),
  deletePersistentVolumeClaim: vi.fn(),
  createJob: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}));

const { provisionTenant } = await import('../services/provisioning.js');

const tenant = {
  tenantId: 't-tags',
  companyName: 'Tag Test Co',
  contactEmail: 'tags@example.com',
  planTier: 'starter' as const,
  quotaAgents: 1,
  quotaCreditsMonthly: 100,
  platform: 'feishu',
};

const baseOptions = {
  dryRun: false,
  imageRegistry: 'reg.example.com/dealclaw',
  nexusGatewayImageTag: 'master.env.7',
  dealclawAgentImageTag: 'master.env.7',
  runtimeSecretData: { LLM_PROVIDERS: '{"providers":[]}' },
};

/** Fake pool returning a promoted tag per service param. */
function makePool(promoted: Record<string, string> | 'error') {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      if (promoted === 'error') throw new Error('db down');
      const service = String(params?.[0] ?? '');
      return { rows: service in promoted ? [{ tag: promoted[service] }] : [], rowCount: 1 };
    },
  } as any;
}

function deploymentImages(): string[] {
  return k8sMock.createDeployment.mock.calls.map((c: any[]) => c[0].image as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  k8sMock.getSecret.mockResolvedValue({ data: {}, type: 'kubernetes.io/dockerconfigjson' });
});

describe('provisionTenant image tags', () => {
  it('uses promoted rollout targets for gateway AND agent when available', async () => {
    await provisionTenant(tenant, {
      ...baseOptions,
      dbPool: makePool({ 'nexus-gateway': 'master.c43b3c7f.62', 'dealclaw-agent': 'master.c43b3c7f.62' }),
    });
    const images = deploymentImages();
    expect(images).toContain('reg.example.com/dealclaw/nexus-gateway:master.c43b3c7f.62');
    expect(images).toContain('reg.example.com/dealclaw/dealclaw-agent:master.c43b3c7f.62');
    expect(images.some((i) => i.endsWith(':master.env.7'))).toBe(false);
  });

  it('falls back to env-configured tags when nothing is promoted', async () => {
    await provisionTenant(tenant, { ...baseOptions, dbPool: makePool({}) });
    const images = deploymentImages();
    expect(images).toContain('reg.example.com/dealclaw/nexus-gateway:master.env.7');
    expect(images).toContain('reg.example.com/dealclaw/dealclaw-agent:master.env.7');
  });

  it('falls back to env-configured tags when the DB query fails', async () => {
    await provisionTenant(tenant, { ...baseOptions, dbPool: makePool('error') });
    const images = deploymentImages();
    expect(images).toContain('reg.example.com/dealclaw/nexus-gateway:master.env.7');
    expect(images).toContain('reg.example.com/dealclaw/dealclaw-agent:master.env.7');
  });

  it('falls back to env-configured tags when no pool is provided (dry-run style callers)', async () => {
    await provisionTenant(tenant, baseOptions);
    const images = deploymentImages();
    expect(images).toContain('reg.example.com/dealclaw/nexus-gateway:master.env.7');
    expect(images).toContain('reg.example.com/dealclaw/dealclaw-agent:master.env.7');
  });

  it('promotes gateway independently from agent (mixed targets)', async () => {
    await provisionTenant(tenant, {
      ...baseOptions,
      dbPool: makePool({ 'nexus-gateway': 'master.gw.9' }), // no agent promoted
    });
    const images = deploymentImages();
    expect(images).toContain('reg.example.com/dealclaw/nexus-gateway:master.gw.9');
    expect(images).toContain('reg.example.com/dealclaw/dealclaw-agent:master.env.7');
  });
});
