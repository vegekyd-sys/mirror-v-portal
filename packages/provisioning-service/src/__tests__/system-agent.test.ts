import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createSystemAgentService } from '../services/system-agent.js';
import { createSystemAgentRoutes } from '../routes/system-agent.js';
import { createServiceOrAdminAuthMiddleware } from '../middleware/auth.js';

const deployment = () => ({ metadata: { resourceVersion: '7', generation: 2 }, spec: {
  replicas: 1, template: { spec: { containers: [{ name: 'nexus-manager', image: 'image@sha256:abc', envFrom: [
    { secretRef: { name: 'nexus-manager-gateway' } },
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
  it('rejects foreign pod logs before accessing logs or secrets', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'nexus-manager-abc' } }] });
    await expect(createSystemAgentService(request).logs('customer-pod', false)).rejects.toMatchObject({ status: 404 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('masks the gateway credential in logs', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [{ metadata: { name: 'nexus-manager-abc' } }] })
      .mockResolvedValueOnce('gateway-key').mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce({ data: { key: Buffer.from('gateway-key').toString('base64') } });
    expect((await createSystemAgentService(request).logs('nexus-manager-abc', true)).logs).toBe('[REDACTED]');
    expect(request.mock.calls[1][1]).toContain('previous=true');
  });
  it('protects status and mutations with authentication', async () => {
    const service = { status: vi.fn() } as any;
    const app = express(); app.use(express.json()); app.use('/v1/admin/system-agent', createSystemAgentRoutes(createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN'), service));
    expect((await supertest(app).get('/v1/admin/system-agent')).status).toBe(401);
    expect((await supertest(app).post('/v1/admin/system-agent/restart')).status).toBe(401);
    expect(service.status).not.toHaveBeenCalled();
    service.status.mockResolvedValue({ state: 'ready' });
    expect((await supertest(app).get('/v1/admin/system-agent').set('Authorization', 'Bearer admin-service')).status).toBe(200);
  });
});
