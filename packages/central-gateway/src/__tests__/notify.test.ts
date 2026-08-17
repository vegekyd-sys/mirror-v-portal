import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

// Point provisioning at a dead port so the delivery path fails fast & deterministically.
process.env.PROVISIONING_SERVICE_URL = 'http://127.0.0.1:1';
process.env.INTERNAL_API_TOKEN = 'internal-test-token';

const app = createApp();

// App created WITHOUT the token configured → relay must refuse to serve.
let unconfiguredApp: ReturnType<typeof createApp>;

beforeAll(() => {
  const saved = process.env.INTERNAL_API_TOKEN;
  delete process.env.INTERNAL_API_TOKEN;
  unconfiguredApp = createApp();
  process.env.INTERNAL_API_TOKEN = saved;
});

describe('POST /internal/v1/notify — auth', () => {
  it('returns 503 when INTERNAL_API_TOKEN is not configured', async () => {
    const res = await request(unconfiguredApp)
      .post('/internal/v1/notify')
      .send({ tenantId: 't-1', message: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('rejects missing bearer token', async () => {
    const res = await request(app)
      .post('/internal/v1/notify')
      .send({ tenantId: 't-1', message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects wrong bearer token', async () => {
    const res = await request(app)
      .post('/internal/v1/notify')
      .set('Authorization', 'Bearer wrong-token')
      .send({ tenantId: 't-1', message: 'hi' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /internal/v1/notify — validation', () => {
  it('rejects missing tenantId', async () => {
    const res = await request(app)
      .post('/internal/v1/notify')
      .set('Authorization', 'Bearer internal-test-token')
      .send({ message: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('rejects empty message', async () => {
    const res = await request(app)
      .post('/internal/v1/notify')
      .set('Authorization', 'Bearer internal-test-token')
      .send({ tenantId: 't-1', message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('POST /internal/v1/notify — delivery path', () => {
  it('reports contact lookup failure in-band (200 + ok:false) when provisioning is unreachable', async () => {
    const res = await request(app)
      .post('/internal/v1/notify')
      .set('Authorization', 'Bearer internal-test-token')
      .send({
        tenantId: 't-1',
        channel: 'bot',
        notificationType: 'low-credits',
        dedupKey: 'low-credits:t-1:2026-08',
        message: '积分不足提醒',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Contact lookup failed');
  });
});
