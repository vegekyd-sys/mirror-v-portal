import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P2 message-plane switch:
 *  - gateway → openclaw: gateway env patched FIRST (WS stops), then agent
 *    envFrom(bot secret) + env → both deployments roll in the right order.
 *  - openclaw → gateway: agent patched FIRST (channels drop), then gateway.
 *  - provisionTenant emits DEALCLAW_MESSAGE_PLANE env on both deployments
 *    and bot-secret envFrom on the agent only for the openclaw plane.
 */

const k8sMock = vi.hoisted(() => {
  const deployments: Record<string, any> = {};
  return {
    deployments,
    createNamespace: vi.fn(),
    getSecret: vi.fn(async () => ({ data: {}, type: 'kubernetes.io/dockerconfigjson' })),
    copySecretToNamespace: vi.fn(),
    createSecret: vi.fn(),
    createDeployment: vi.fn((spec: any) => { deployments[spec.name] = spec; }),
    createService: vi.fn(),
    createPersistentVolumeClaim: vi.fn(),
    getDeployment: vi.fn(async (_ns: string, name: string) => deployments[name] ?? null),
    patchDeployment: vi.fn(async (_ns: string, name: string, body: any) => {
      const d = deployments[name];
      if (!d) return false;
      const patch = body.spec?.template?.spec?.containers?.[0];
      if (patch?.envFrom) d.envFrom = patch.envFrom;
      if (patch?.env) {
        d.env = [...(d.env ?? []).filter((e: any) => !patch.env.some((p: any) => p.name === e.name)), ...patch.env];
      }
      return true;
    }),
    patchDeploymentEnvFromSecret: vi.fn(),
  };
});

// Real ordering logic lives in k8s-client's helpers; emulate their semantics.
k8sMock.patchDeploymentEnvFromSecret.mockImplementation(async (ns: string, name: string, secretName: string) => {
  const d = k8sMock.deployments[name];
  if (!d) return false;
  if ((d.envFrom ?? []).some((e: any) => e?.secretRef?.name === secretName)) return false;
  d.envFrom = [...(d.envFrom ?? []), { secretRef: { name: secretName } }];
  return true;
});

// Route patchDeploymentEnvVar through patchDeployment so ordering across
// both helpers can be asserted from the patchDeployment mock's call order.
vi.mock('../services/k8s-client.js', () => ({
  createNamespace: k8sMock.createNamespace,
  deleteNamespace: vi.fn(),
  getSecret: k8sMock.getSecret,
  copySecretToNamespace: k8sMock.copySecretToNamespace,
  createSecret: k8sMock.createSecret,
  createDeployment: k8sMock.createDeployment,
  createService: k8sMock.createService,
  createPersistentVolumeClaim: k8sMock.createPersistentVolumeClaim,
  deleteSecret: vi.fn(),
  deleteDeployment: vi.fn(),
  deleteService: vi.fn(),
  deletePersistentVolumeClaim: vi.fn(),
  createJob: vi.fn(),
  getDeployment: k8sMock.getDeployment,
  patchDeployment: k8sMock.patchDeployment,
  patchDeploymentEnvFromSecret: k8sMock.patchDeploymentEnvFromSecret,
  patchDeploymentEnvVar: async (ns: string, name: string, varName: string, value: string) => {
    const d = k8sMock.deployments[name];
    if (!d) return false;
    const existing = (d.env ?? []).find((e: any) => e?.name === varName);
    if (existing && existing.value === value) return false;
    return k8sMock.patchDeployment(ns, name, {
      spec: { template: { spec: { containers: [{ name, env: [{ name: varName, value }] }] } } },
    });
  },
}));

const { provisionTenant, switchTenantMessagePlane } = await import('../services/provisioning.js');

const tenant = {
  tenantId: 't-plane',
  companyName: 'Plane Test Co',
  contactEmail: 'plane@example.com',
  planTier: 'starter' as const,
  quotaAgents: 1,
  quotaCreditsMonthly: 100,
  platform: 'feishu',
  appId: 'cli_x',
  appSecret: 'sec',
};

const baseOptions = {
  dryRun: false,
  imageRegistry: 'reg.example.com/dealclaw',
  nexusGatewayImageTag: 'master.t.1',
  dealclawAgentImageTag: 'master.t.1',
  runtimeSecretData: { DEEPSEEK_API_KEY: 'sk-test' },
};

const NS = 'dealclaw-t-plane';
const GW = 'nexus-gateway-t-plane';
const AG = 'dealclaw-agent-t-plane';

function findDeployment(name: string): any {
  return k8sMock.createDeployment.mock.calls.map((c: any[]) => c[0]).find((s: any) => s.name === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(k8sMock.deployments).forEach((k) => delete k8sMock.deployments[k]);
  k8sMock.getSecret.mockResolvedValue({ data: {}, type: 'kubernetes.io/dockerconfigjson' });
});

describe('provisionTenant message plane', () => {
  it('default (gateway plane): no bot secret on agent, plane env = gateway', async () => {
    await provisionTenant(tenant, baseOptions);
    const agent = findDeployment(AG);
    const gw = findDeployment(GW);
    expect(agent.envFrom.map((e: any) => e.secretRef.name)).not.toContain('dealclaw-bot-t-plane');
    expect(agent.env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('gateway');
    expect(gw.env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('gateway');
  });

  it('openclaw plane: agent gets bot secret envFrom + provisioning URL env; gateway plane=openclaw', async () => {
    await provisionTenant({ ...tenant, messagePlane: 'openclaw' }, baseOptions);
    const agent = findDeployment(AG);
    const gw = findDeployment(GW);
    expect(agent.envFrom.map((e: any) => e.secretRef.name)).toContain('dealclaw-bot-t-plane');
    expect(agent.env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('openclaw');
    expect(agent.env.find((e: any) => e.name === 'PROVISIONING_SERVICE_URL')).toBeTruthy();
    expect(gw.env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('openclaw');
  });
});

describe('switchTenantMessagePlane ordering', () => {
  beforeEach(async () => {
    await provisionTenant(tenant, baseOptions); // provision on gateway plane
    k8sMock.patchDeployment.mockClear();
    k8sMock.patchDeploymentEnvFromSecret.mockClear();
  });

  it('gateway → openclaw: gateway env patched before agent env', async () => {
    const r = await switchTenantMessagePlane('t-plane', 'openclaw');
    expect(r.ok).toBe(true);

    const gwPatch = k8sMock.patchDeployment.mock.calls.find(
      (c: any[]) => c[1] === GW,
    ) as any[];
    const agentPatch = k8sMock.patchDeployment.mock.calls.find(
      (c: any[]) => c[1] === AG,
    ) as any[];
    expect(gwPatch).toBeTruthy();
    expect(agentPatch).toBeTruthy();
    expect(k8sMock.patchDeployment.mock.invocationCallOrder[
      k8sMock.patchDeployment.mock.calls.findIndex((c: any[]) => c[1] === GW)
    ]).toBeLessThan(
      k8sMock.patchDeployment.mock.invocationCallOrder[
        k8sMock.patchDeployment.mock.calls.findIndex((c: any[]) => c[1] === AG)
      ],
    );

    // Agent envFrom gained the bot secret and env switched.
    const agent = k8sMock.deployments[AG];
    expect(agent.envFrom.map((e: any) => e.secretRef.name)).toContain('dealclaw-bot-t-plane');
    expect(agent.env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('openclaw');
    expect(k8sMock.deployments[GW].env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('openclaw');
  });

  it('openclaw → gateway: agent env patched before gateway env', async () => {
    await switchTenantMessagePlane('t-plane', 'openclaw');
    k8sMock.patchDeployment.mockClear();

    const r = await switchTenantMessagePlane('t-plane', 'gateway');
    expect(r.ok).toBe(true);
    const order = k8sMock.patchDeployment.mock.invocationCallOrder;
    const idx = (name: string) => k8sMock.patchDeployment.mock.calls.findIndex((c: any[]) => c[1] === name);
    expect(order[idx(AG)]).toBeLessThan(order[idx(GW)]);
    expect(k8sMock.deployments[AG].env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('gateway');
    expect(k8sMock.deployments[GW].env.find((e: any) => e.name === 'DEALCLAW_MESSAGE_PLANE')?.value).toBe('gateway');
  });

  it('idempotent: switching to the same plane is a no-op with ok=true', async () => {
    await switchTenantMessagePlane('t-plane', 'openclaw');
    k8sMock.patchDeployment.mockClear();
    const r = await switchTenantMessagePlane('t-plane', 'openclaw');
    expect(r.ok).toBe(true);
    expect(k8sMock.patchDeployment).not.toHaveBeenCalled();
  });
});
