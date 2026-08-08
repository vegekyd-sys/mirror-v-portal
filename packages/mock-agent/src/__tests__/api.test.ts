import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp, setMockConfig } from '../app.js';

const app = createApp();

beforeEach(async () => {
  // Reset mock config between tests
  await request(app).delete('/admin/config');
});

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('mock-agent');
  });
});

describe('POST /execute', () => {
  it('handles chat intent', async () => {
    const res = await request(app)
      .post('/execute')
      .set('x-dealclaw-tenant-id', 'test-001')
      .set('x-dealclaw-user-id', 'user-001')
      .set('x-dealclaw-plan-tier', 'starter')
      .send({ message: 'Hello', intent: { kind: 'chat' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.intent).toBe('chat');
    expect(res.body.meta.tenantId).toBe('test-001');
  });

  it('handles search_buyers intent', async () => {
    const res = await request(app)
      .post('/execute')
      .set('x-dealclaw-tenant-id', 'test-001')
      .send({ intent: { kind: 'search_buyers' }, message: 'Find German buyers' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('search_buyers');
    expect(res.body.result.leads).toHaveLength(3);
    expect(res.body.result.leads[0].matchScore).toBe(92);
  });

  it('handles company_profile intent', async () => {
    const res = await request(app)
      .post('/execute')
      .set('x-dealclaw-tenant-id', 'test-001')
      .send({ intent: { kind: 'company_profile' } });

    expect(res.status).toBe(200);
    expect(res.body.result.recommendation.score).toBe(4);
  });

  it('handles generate_email intent', async () => {
    const res = await request(app)
      .post('/execute')
      .set('x-dealclaw-tenant-id', 'solarunis')
      .send({ intent: { kind: 'generate_email' } });

    expect(res.status).toBe(200);
    expect(res.body.result.subject).toContain('Solarunis');
    expect(res.body.result.channel).toBe('email');
  });

  it('respects failWithStatus config', async () => {
    await request(app).post('/admin/config').send({ failWithStatus: 500 });
    const res = await request(app)
      .post('/execute')
      .send({ intent: { kind: 'chat' } });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('AGENT_ERROR');
  });

  it('handles missing headers gracefully', async () => {
    const res = await request(app).post('/execute').send({});
    expect(res.status).toBe(200);
    expect(res.body.meta.tenantId).toBe('unknown');
    expect(res.body.meta.planTier).toBe('starter');
  });
});

describe('Admin config', () => {
  it('sets and resets config', async () => {
    const res1 = await request(app).post('/admin/config').send({ delayMs: 100 });
    expect(res1.body.config.delayMs).toBe(100);

    const res2 = await request(app).delete('/admin/config');
    expect(res2.body.config.delayMs).toBeUndefined();
  });
});
