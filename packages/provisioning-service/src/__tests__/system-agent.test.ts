import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createSystemAgentService } from '../services/system-agent.js';
import { createSystemAgentRoutes } from '../routes/system-agent.js';
import { createServiceOrAdminAuthMiddleware } from '../middleware/auth.js';

const deployment = () => ({ metadata: { resourceVersion: '7', generation: 2 }, spec: {
  replicas: 1, template: { spec: { containers: [{ name: 'nexus-manager', image: 'image@sha256:abc', envFrom: [
    { secretRef: { name: 'nexus-manager-credentials-initial' } }, { secretRef: { name: 'nexus-manager-gateway' } },
  ] }] } },
}, status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1 } });

describe('system agent management', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_MANAGER_ENABLED', 'true'); vi.stubEnv('NEXUS_MANAGER_UI_URL', 'https://manager.example.com');
    vi.stubEnv('NEXUS_MANAGER_NAMESPACE', 'dealclaw-system'); vi.stubEnv('PROVISIONING_API_TOKEN', 'admin-service');
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('fails closed when disabled without calling Kubernetes', async () => {
    vi.stubEnv('NEXUS_MANAGER_ENABLED', 'false'); const request = vi.fn();
    await expect(createSystemAgentService(request).status()).rejects.toMatchObject({ status: 503 }); expect(request).not.toHaveBeenCalled();
  });
  it('never returns credentials or whole pod specs from status', async () => {
    vi.stubEnv('NEXUS_MANAGER_UI_URL', 'https://nexus.datathink.com/nexus-manager/openclaw/');
    const d = deployment(); (d.spec.template.spec.containers[0] as any).env = [{ value: 'private-key' }];
    const req = vi.fn().mockResolvedValueOnce(d).mockResolvedValueOnce({ items: [] });
    const status = await createSystemAgentService(req).status();
    expect(status.state).toBe('ready'); expect(JSON.stringify(status)).not.toContain('private-key');
    expect(status.uiUrl).toBe('https://nexus.datathink.com/nexus-manager/openclaw/');
  });
  it('requires fresh resourceVersion and does not mutate on conflict', async () => {
    const request = vi.fn().mockResolvedValue(deployment());
    await expect(createSystemAgentService(request).action('stop', '6')).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('versions secrets then patches only fixed deployment, preserving gateway reference', async () => {
    const request = vi.fn().mockResolvedValueOnce(deployment()).mockResolvedValueOnce({ data: { OTHER_KEY: 'cHJlc2VydmU=' } }).mockResolvedValue({});
    const result = await createSystemAgentService(request).credentials('new-secret', '7');
    expect(result.accepted).toBe(true);
    const secret = request.mock.calls[2][2];
    expect(secret.immutable).toBe(true); expect(secret.data.OTHER_KEY).toBe('cHJlc2VydmU=');
    expect(secret.data.NEXUS_MODEL_API_KEY).toBe(Buffer.from('new-secret').toString('base64'));
    const patch = request.mock.calls[3];
    expect(patch[1]).toBe('/apis/apps/v1/namespaces/dealclaw-system/deployments/nexus-manager');
    expect(patch[2].metadata.resourceVersion).toBe('7');
    expect(patch[2].spec.template.spec.containers[0].envFrom[1].secretRef.name).toBe('nexus-manager-gateway');
    expect(JSON.stringify(result)).not.toContain('new-secret');
  });
  it('rejects foreign pod logs before accessing logs or secrets', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'nexus-manager-abc' } }] });
    await expect(createSystemAgentService(request).logs('customer-pod', false)).rejects.toMatchObject({ status: 404 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('masks current and previous injected credentials in logs', async () => {
    const d: any = deployment(); d.metadata.annotations = { 'nexus.dealclaw.io/previous-credentials': 'nexus-manager-credentials-old' };
    const request = vi.fn().mockResolvedValueOnce({ items: [{ metadata: { name: 'nexus-manager-abc' } }] })
      .mockResolvedValueOnce('new-key old-key gateway-key').mockResolvedValueOnce(d)
      .mockResolvedValueOnce({ data: { key: Buffer.from('new-key').toString('base64') } })
      .mockResolvedValueOnce({ data: { key: Buffer.from('old-key').toString('base64') } })
      .mockResolvedValueOnce({ data: { key: Buffer.from('gateway-key').toString('base64') } });
    expect((await createSystemAgentService(request).logs('nexus-manager-abc', true)).logs).toBe('[REDACTED] [REDACTED] [REDACTED]');
    expect(request.mock.calls[1][1]).toContain('previous=true');
  });
  it('protects status and mutations with authentication', async () => {
    const service = { status: vi.fn(), credentials: vi.fn() } as any;
    const app = express(); app.use(express.json()); app.use('/v1/admin/system-agent', createSystemAgentRoutes(createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN'), service));
    expect((await supertest(app).get('/v1/admin/system-agent')).status).toBe(401);
    expect((await supertest(app).put('/v1/admin/system-agent/credentials/model').send({ apiKey: 'secret' })).status).toBe(401);
    expect(service.status).not.toHaveBeenCalled(); expect(service.credentials).not.toHaveBeenCalled();
    service.status.mockResolvedValue({ state: 'ready' });
    expect((await supertest(app).get('/v1/admin/system-agent').set('Authorization', 'Bearer admin-service')).status).toBe(200);
  });
});
