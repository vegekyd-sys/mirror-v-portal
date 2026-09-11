import { describe, it, expect } from 'vitest';

// Integration tests require a running agent + credits-ledger in the cluster.
// Skip in CI where those services are not available.
const isCI = !!process.env.JENKINS_URL || !!process.env.BUILD_ID;
const run = isCI ? describe.skip : describe;
import request from 'supertest';
import { createApp } from '../../app.js';
import type { GatewayConfig } from '../../config.js';

// NB FIX: Enable dev-mode auth bypass + credits fail-open for integration tests.
// Production requires botSecret with HMAC signature verification and fail-close credits.
process.env.DEALCLAW_SKIP_SIGNATURE_CHECK = 'true';
process.env.DEALCLAW_CREDITS_FAIL_OPEN = 'true';

const testConfig: GatewayConfig = {
  port: 9999,
  tenantId: 'test-tenant',
  platform: 'feishu',
  planTier: 'pro',
  agentUrl: 'http://127.0.0.1:19999',
  creditsLedgerUrl: 'http://127.0.0.1:19998',
  keyConfig: {
    customerKeyRef: 'test/key',
    botCredentialRef: 'test/bot',
    creditsAccountId: 'credits-test',
    configVersion: '1',
  },
  initialCredits: 10000,
  externalChatTimeoutMs: 300_000,
  externalChatStreamTimeoutMs: 600_000,
  llmUpstreams: {},
};

const app = createApp(testConfig);

/**
 * Helper: build a valid Feishu-style webhook request body.
 * B4 FIX: identity now uses body.event.sender.sender_id.open_id.
 */
function feishuBody(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      header: { app_id: 'cli_test_123' },
      sender: { sender_id: { open_id: 'ou_test_user' } },
    },
    ...overrides,
  };
}

run('GET /healthz', () => {
  it('returns service info', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('nexus-gateway');
    expect(res.body.tenantId).toBe('test-tenant');
  });
});

run('POST /v1/agent/execute — pipeline', () => {
  it('returns 401 when no identity', async () => {
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ intent: { kind: 'chat', text: 'hello' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when scene is locked on starter plan', async () => {
    const { setPlanConfig, initPlanConfig } = await import('../../middleware/scene.js');
    setPlanConfig(initPlanConfig('starter'));

    const res = await request(app)
      .post('/v1/agent/execute')
      .send(feishuBody({ scene: 'expo', intent: { kind: 'chat', text: 'hi' } }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCENE_LOCKED');
  });

  it('returns 502 when agent unreachable (auth+scene passed)', async () => {
    const { setPlanConfig, initPlanConfig } = await import('../../middleware/scene.js');
    setPlanConfig(initPlanConfig('pro'));

    const res = await request(app)
      .post('/v1/agent/execute')
      .send(feishuBody({ scene: 'lead', intent: { kind: 'chat', text: 'hello' } }));
    // Chat = free, passes credits check (cost=0, no HTTP call needed)
    // Agent unreachable → 502
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AGENT_UNREACHABLE');
  });

  it('allows chat with valid identity (then gets 502 from unreachable agent)', async () => {
    const { setPlanConfig, initPlanConfig } = await import('../../middleware/scene.js');
    setPlanConfig(initPlanConfig('pro'));

    const res = await request(app)
      .post('/v1/agent/execute')
      .send(feishuBody({ intent: { kind: 'chat', text: 'hello' } }));
    // Chat is 0 credits → passes credits check, forwarded, Agent down → 502
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AGENT_UNREACHABLE');
  });

  it('passes credits check even when credits-ledger is down (M0 fail-open)', async () => {
    const { setPlanConfig, initPlanConfig } = await import('../../middleware/scene.js');
    setPlanConfig(initPlanConfig('pro'));

    // query intent costs 2000 credits, credits-ledger is non-existent
    // M0 design: fail open
    const res = await request(app)
      .post('/v1/agent/execute')
      .send(feishuBody({ scene: 'lead', intent: { kind: 'query', resource: 'company' } }));
    // Credits call fails → fail-open → proceeds to agent → agent down → 502
    expect(res.status).toBe(502);
  });
});

run('Identity middleware — Feishu signature', () => {
  it('accepts valid Feishu-style webhook body', async () => {
    const { setPlanConfig, initPlanConfig } = await import('../../middleware/scene.js');
    setPlanConfig(initPlanConfig('pro'));

    const res = await request(app)
      .post('/v1/agent/execute')
      .send(feishuBody({ intent: { kind: 'chat', text: 'hello' } }));
    // Should pass identity check (botSecret not set = accept all)
    expect(res.status).not.toBe(401);
  });

  it('rejects when no user identity in body', async () => {
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ event: { header: {} }, intent: { kind: 'chat', text: 'hello' } });
    expect(res.status).toBe(401);
  });
});
