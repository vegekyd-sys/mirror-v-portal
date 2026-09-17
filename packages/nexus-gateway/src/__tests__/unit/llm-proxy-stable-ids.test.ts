import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import type { GatewayConfig, V2RouteEntry } from '../../config.js';
import { registerLlmProxy, type UsageReportEvent } from '../../services/llm-proxy.js';

const LEDGER = 'http://ledger.test';
const UPSTREAM = 'https://up.test/v1';

function makeConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 9999,
    tenantId: 'test-tenant',
    platform: 'feishu',
    planTier: 'pro',
    agentUrl: 'http://127.0.0.1:19999',
    creditsLedgerUrl: LEDGER,
    keyConfig: {
      customerKeyRef: 'test/key',
      botCredentialRef: 'test/bot',
      creditsAccountId: 'acct_test-tenant',
      configVersion: '1',
    },
    initialCredits: 10000,
    externalChatTimeoutMs: 300_000,
    externalChatStreamTimeoutMs: 600_000,
    llmUpstreams: { qwen: UPSTREAM },
    runtimeContractMode: 'v1',
    llmRouteMapV2: null,
    releaseIdV2: null,
    ...over,
  };
}

interface Harness {
  app: Express;
  reports: UsageReportEvent[];
  upstreamCalls: Array<{ url: string; method: string; auth?: string; body?: any }>;
  ledgerBodies: Array<Record<string, unknown>>;
  balance: number;
}

function makeHarness(config = makeConfig()): Harness {
  const h: Harness = { app: express(), reports: [], upstreamCalls: [], ledgerBodies: [], balance: 50_000 };

  const decodeBody = (body: unknown): any => {
    if (body == null) return undefined;
    if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString('utf8'));
    return JSON.parse(String(body));
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === `${LEDGER}/v1/accounts/acct_test-tenant/balance`) {
      return Response.json({ balance: h.balance });
    }
    if (url === `${LEDGER}/v1/admin/customers/test-tenant`) {
      return Response.json({
        companyName: 'TestCo', availableBalance: h.balance, frozenCredits: 0,
        lifetimeConsumed: 0, planTier: 'pro', planName: 'Pro', status: 'active',
        subscriptionEnd: null,
      });
    }
    if (url === `${LEDGER}/v1/billing/llm-usage` && method === 'POST') {
      const body = decodeBody(init?.body);
      h.ledgerBodies.push(body);
      return Response.json({ ok: true, id: 'ev_1' });
    }
    if (url === `${UPSTREAM}/chat/completions` && method === 'POST') {
      const reqBody = decodeBody(init?.body);
      h.upstreamCalls.push({ url, method, auth: (init?.headers as any)?.authorization, body: reqBody });
      if (reqBody && reqBody.forceError) return new Response('{"error":"bad"}', { status: 400 });
      if (reqBody && reqBody.stream) {
        const sse = [
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"}}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{}}],"usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168}}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'c1', object: 'chat.completion', model: reqBody?.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      });
    }
    if (url.startsWith(UPSTREAM)) {
      return new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };

  registerLlmProxy(h.app, config, { fetchImpl, onReport: ev => h.reports.push(ev) });
  return h;
}

const chatBody = (over: Record<string, unknown> = {}) => ({
  model: 'qwen-max', stream: true,
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

/** Build a V2 route map from route entries (for test configs). */
function makeRouteMap(routes: V2RouteEntry[]): Map<string, V2RouteEntry> {
  const map = new Map<string, V2RouteEntry>();
  for (const r of routes) {
    map.set(r.runtimeKey, r);
    for (const a of r.aliases) map.set(a, r);
  }
  return map;
}

const V2_ROUTES: V2RouteEntry[] = [
  {
    runtimeKey: 'qwen',
    aliases: ['qwen-alias'],
    providerId: 'lpi_qwen_test',
    upstreamBaseUrl: UPSTREAM,
    models: [
      { modelId: 'lpm_qwen_max', upstreamModel: 'qwen-max' },
      { modelId: 'lpm_qwen_turbo', upstreamModel: 'qwen-turbo' },
    ],
  },
];

// ── V1 mode: no stable IDs ────────────────────────────────────────────

describe('stable usage attribution — v1 mode', () => {
  it('usage report has null stable IDs', async () => {
    const h = makeHarness();
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.provider).toBe('qwen');
    expect(r.model).toBe('qwen-max');
    // Stable IDs should be null/undefined in v1 mode
    expect(r.stableProviderId).toBeNull();
    expect(r.stableModelId).toBeNull();
    expect(r.releaseId).toBeNull();
  });

  it('ledger POST body does not include stable IDs in v1 mode', async () => {
    const h = makeHarness();
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.ledgerBodies).toHaveLength(1);
    const body = h.ledgerBodies[0];
    expect(body.provider).toBe('qwen');
    expect(body.model).toBe('qwen-max');
    expect(body).not.toHaveProperty('stableProviderId');
    expect(body).not.toHaveProperty('stableModelId');
    expect(body).not.toHaveProperty('releaseId');
  });
});

// ── V2 mode: stable IDs resolved ──────────────────────────────────────

describe('stable usage attribution — v2 mode', () => {
  it('usage report contains stable providerId, modelId, and releaseId', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    // Legacy fields preserved
    expect(r.provider).toBe('qwen');
    expect(r.model).toBe('qwen-max');
    // Stable IDs resolved from V2 route map
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
    expect(r.releaseId).toBe('rel_test_001');
  });

  it('ledger POST body includes stable IDs when non-null', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.ledgerBodies).toHaveLength(1);
    const body = h.ledgerBodies[0];
    // Legacy fields still present
    expect(body.provider).toBe('qwen');
    expect(body.model).toBe('qwen-max');
    // Stable IDs included
    expect(body.stableProviderId).toBe('lpi_qwen_test');
    expect(body.stableModelId).toBe('lpm_qwen_max');
    expect(body.releaseId).toBe('rel_test_001');
  });

  it('resolves stableModelId via alias lookup (qwen-alias)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).post('/v1/llm/qwen-alias/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    // Provider resolved via alias
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
    // Legacy provider is the URL param (alias name)
    expect(r.provider).toBe('qwen-alias');
  });

  it('stableModelId is null for unmapped model (warn, no block)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    // "qwen-plus" is not in the route's models array
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ model: 'qwen-plus' }));
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    // Provider is resolved
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    // Model not found in V2 models array → null
    expect(r.stableModelId).toBeNull();
    // releaseId still present
    expect(r.releaseId).toBe('rel_test_001');
    // Proxy did NOT block — upstream was called
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it('stableModelId is null when body has no model field (GET /models)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).get('/v1/llm/qwen/models');
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    // Provider resolved
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    // No model in body → model is "unknown" → no stableModelId
    expect(r.stableModelId).toBeNull();
    expect(r.releaseId).toBe('rel_test_001');
  });

  it('releaseId is null when config.releaseIdV2 is null', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: null, // no release ID
    }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
    expect(r.releaseId).toBeNull();
    // Ledger body should NOT include releaseId
    const body = h.ledgerBodies[0];
    expect(body).not.toHaveProperty('releaseId');
  });

  it('preserves balance interception with stable IDs (synthesized)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ messages: [{ role: 'user', content: '查余额' }] }));
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.status).toBe('synthesized');
    // Stable IDs still attached to synthesized reports
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
    expect(r.releaseId).toBe('rel_test_001');
  });

  it('preserves balance block with stable IDs (blocked)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    h.balance = 0;
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.status).toBe('blocked');
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
  });

  it('preserves upstream error with stable IDs (error)', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ stream: false, forceError: true }));
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.status).toBe('error');
    expect(r.stableProviderId).toBe('lpi_qwen_test');
    expect(r.stableModelId).toBe('lpm_qwen_max');
  });

  it('resolves different stableModelId for different models on same provider', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      releaseIdV2: 'rel_test_001',
    }));
    // Call with qwen-turbo
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ model: 'qwen-turbo' }));
    expect(h.reports[0].stableModelId).toBe('lpm_qwen_turbo');
    // Call with qwen-max
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ model: 'qwen-max' }));
    expect(h.reports[1].stableModelId).toBe('lpm_qwen_max');
  });
});

// ── Shadow mode: no stable IDs ────────────────────────────────────────

describe('stable usage attribution — shadow mode', () => {
  it('usage report has null stable IDs in shadow mode', async () => {
    const h = makeHarness(makeConfig({ runtimeContractMode: 'shadow' }));
    await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(h.reports).toHaveLength(1);
    const r = h.reports[0];
    expect(r.stableProviderId).toBeNull();
    expect(r.stableModelId).toBeNull();
    expect(r.releaseId).toBeNull();
  });
});
