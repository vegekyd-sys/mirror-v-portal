import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import type { GatewayConfig, V2RouteEntry } from '../../config.js';
import { registerLlmProxy, type UsageReportEvent } from '../../services/llm-proxy.js';

const LEDGER = 'http://ledger.test';
const UPSTREAM = 'https://up.test/v1';
const UPSTREAM_2 = 'https://up2.test/v1';

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
    ...over,
  };
}

interface Harness {
  app: Express;
  reports: UsageReportEvent[];
  upstreamCalls: Array<{ url: string; method: string; auth?: string; body?: any }>;
  balance: number;
  balanceFetchFail: boolean;
}

function makeHarness(config = makeConfig()): Harness {
  const h: Harness = { app: express(), reports: [], upstreamCalls: [], balance: 50_000, balanceFetchFail: false };

  const decodeBody = (body: unknown): any => {
    if (body == null) return undefined;
    if (body instanceof Uint8Array) return JSON.parse(Buffer.from(body).toString('utf8'));
    return JSON.parse(String(body));
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === `${LEDGER}/v1/accounts/acct_test-tenant/balance`) {
      if (h.balanceFetchFail) return new Response('boom', { status: 500 });
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
      return Response.json({ ok: true, id: 'ev_1' });
    }
    // Match upstream chat/completions by path prefix
    if (url === `${UPSTREAM}/chat/completions` || url === `${UPSTREAM_2}/chat/completions`) {
      const reqBody = decodeBody(init?.body);
      h.upstreamCalls.push({ url, method, auth: (init?.headers as any)?.authorization, body: reqBody });
      if (reqBody?.forceError) return new Response('{"error":"bad"}', { status: 400 });
      if (reqBody?.stream) {
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
    // Non-chat upstream paths (e.g. /models) → 404
    if (url.startsWith(UPSTREAM) || url.startsWith(UPSTREAM_2)) {
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
    providerId: 'qwen',
    upstreamBaseUrl: UPSTREAM,
    models: [{ modelId: 'qwen/qwen-max', upstreamModel: 'qwen-max' }],
  },
];

// ── v1 mode (regression) ──────────────────────────────────────────────

describe('llm-proxy v1 mode (unchanged behaviour)', () => {
  it('routes to V1 upstream and reports usage', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls).toHaveLength(1);
    expect(h.upstreamCalls[0].url).toContain(UPSTREAM);
    expect(h.reports[0]).toMatchObject({ status: 'ok', provider: 'qwen' });
  });

  it('404s for unconfigured provider', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/unknown/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROVIDER_NOT_FOUND');
  });
});

// ── shadow mode ───────────────────────────────────────────────────────
// Shadow mode uses V1 for routing (same as v1). The V2 comparison happens
// at config load time (config.ts), not at the proxy layer. The proxy
// behavior in shadow mode is identical to v1.

describe('llm-proxy shadow mode (V1 routing, V2 compared at load)', () => {
  it('routes via V1 upstreams (shadow = V1 active)', async () => {
    const h = makeHarness(makeConfig({ runtimeContractMode: 'shadow' }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls[0].url).toContain(UPSTREAM);
    expect(h.reports[0]).toMatchObject({ status: 'ok', provider: 'qwen' });
  });

  it('still 404s for unconfigured provider in shadow mode', async () => {
    const h = makeHarness(makeConfig({ runtimeContractMode: 'shadow' }));
    const res = await request(h.app).post('/v1/llm/unknown/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(404);
  });
});

// ── v2 mode ────────────────────────────────────────────────────────────

describe('llm-proxy v2 mode (V2 routes as sole source)', () => {
  it('routes via V2 runtimeKey', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      // V1 upstreams are ignored in v2 mode
      llmUpstreams: { other: 'https://other.test/v1' },
    }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls[0].url).toContain(UPSTREAM);
    expect(h.reports[0]).toMatchObject({ status: 'ok', provider: 'qwen' });
  });

  it('routes via V2 alias', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    const res = await request(h.app).post('/v1/llm/qwen-alias/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls[0].url).toContain(UPSTREAM);
    // provider in usage is the URL param (alias), not the runtimeKey
    expect(h.reports[0]).toMatchObject({ status: 'ok', provider: 'qwen-alias' });
  });

  it('404s for provider not in V2 route map', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
      llmUpstreams: { other: 'https://other.test/v1' }, // V1 has "other" but V2 doesn't
    }));
    const res = await request(h.app).post('/v1/llm/other/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('404s when V2 route map is empty', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: new Map(),
      llmUpstreams: { qwen: UPSTREAM }, // V1 has qwen but V2 is empty
    }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(404);
  });

  it('preserves balance interception in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    h.balance = 0;
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(res.text).toContain('额度已用完');
    expect(h.upstreamCalls.length).toBe(0);
    expect(h.reports[0].status).toBe('blocked');
  });

  it('preserves balance keyword synthesis in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ messages: [{ role: 'user', content: '查余额' }] }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('可用余额');
    expect(h.upstreamCalls.length).toBe(0);
    expect(h.reports[0].status).toBe('synthesized');
  });

  it('preserves auth passthrough in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer sk-real-key')
      .send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls[0].auth).toBe('Bearer sk-real-key');
  });

  it('preserves upstream error passthrough in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ stream: false, forceError: true }));
    expect(res.status).toBe(400);
    expect(h.reports[0].status).toBe('error');
  });

  it('supports multiple V2 routes with different upstreams', async () => {
    const routes: V2RouteEntry[] = [
      { runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: UPSTREAM, models: [] },
      { runtimeKey: 'deepseek', aliases: ['ds'], providerId: 'deepseek', upstreamBaseUrl: UPSTREAM_2, models: [] },
    ];
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(routes),
    }));
    // Route via runtimeKey "deepseek"
    const res1 = await request(h.app).post('/v1/llm/deepseek/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res1.status).toBe(200);
    expect(h.upstreamCalls[0].url).toContain(UPSTREAM_2);
    // Route via alias "ds"
    const res2 = await request(h.app).post('/v1/llm/ds/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res2.status).toBe(200);
    expect(h.upstreamCalls[1].url).toContain(UPSTREAM_2);
  });

  it('preserves ledger fail-open in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    h.balanceFetchFail = true;
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls.length).toBe(1);
    expect(h.reports[0].status).toBe('ok');
  });

  it('preserves non-chat call passthrough (GET models) in v2 mode', async () => {
    const h = makeHarness(makeConfig({
      runtimeContractMode: 'v2',
      llmRouteMapV2: makeRouteMap(V2_ROUTES),
    }));
    const res = await request(h.app).get('/v1/llm/qwen/models');
    expect(res.status).toBe(404); // upstream mock 404s for /models
    expect(h.reports[0].status).toBe('error');
  });
});

// ── config.ts V2 validation ────────────────────────────────────────────
// These tests verify the loadConfig() V2 processing by setting env vars
// and calling loadConfig directly. We use a minimal env stub.

describe('config.ts V2 route loading', () => {
  // Save and restore env
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    'DEALCLAW_TENANT_ID', 'DEALCLAW_PLATFORM', 'DEALCLAW_AGENT_URL',
    'DEALCLAW_CUSTOMER_KEY_REF', 'DEALCLAW_BOT_CREDENTIAL_REF',
    'LLM_UPSTREAMS', 'LLM_RUNTIME_CONTRACT_MODE', 'LLM_RUNTIME_ROUTES_V2',
  ];

  function setEnv(over: Record<string, string> = {}) {
    for (const k of envKeys) envBackup[k] = process.env[k];
    process.env.DEALCLAW_TENANT_ID = 'test-tenant';
    process.env.DEALCLAW_AGENT_URL = 'http://agent.test';
    process.env.DEALCLAW_CUSTOMER_KEY_REF = 'test/key';
    process.env.DEALCLAW_BOT_CREDENTIAL_REF = 'test/bot';
    process.env.LLM_UPSTREAMS = JSON.stringify({ qwen: UPSTREAM });
    for (const [k, v] of Object.entries(over)) process.env[k] = v;
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('v2 mode builds route map from valid V2 routes', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [{
          runtimeKey: 'qwen',
          aliases: ['qwen-alias'],
          providerId: 'qwen',
          upstreamBaseUrl: UPSTREAM,
          models: [{ modelId: 'qwen/qwen-max', upstreamModel: 'qwen-max' }],
        }],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      const cfg = loadConfig();
      expect(cfg.runtimeContractMode).toBe('v2');
      expect(cfg.llmRouteMapV2).not.toBeNull();
      expect(cfg.llmRouteMapV2!.size).toBe(2); // runtimeKey + alias
      expect(cfg.llmRouteMapV2!.get('qwen')?.upstreamBaseUrl).toBe(UPSTREAM);
      expect(cfg.llmRouteMapV2!.get('qwen-alias')?.upstreamBaseUrl).toBe(UPSTREAM);
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode fails closed on invalid JSON', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: '{not valid json',
    });
    try {
      const { loadConfig } = await import('../../config.js');
      expect(() => loadConfig()).toThrow('not valid JSON');
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode fails closed on missing routes array', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({ notRoutes: [] }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      expect(() => loadConfig()).toThrow('routes');
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode fails closed on alias conflict', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [
          { runtimeKey: 'qwen', aliases: ['shared'], providerId: 'qwen', upstreamBaseUrl: UPSTREAM, models: [] },
          { runtimeKey: 'deepseek', aliases: ['shared'], providerId: 'deepseek', upstreamBaseUrl: UPSTREAM_2, models: [] },
        ],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      expect(() => loadConfig()).toThrow('alias conflict');
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode fails closed on duplicate runtimeKey', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [
          { runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: UPSTREAM, models: [] },
          { runtimeKey: 'qwen', aliases: [], providerId: 'qwen-2', upstreamBaseUrl: UPSTREAM_2, models: [] },
        ],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      expect(() => loadConfig()).toThrow('alias conflict');
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode with empty routes produces empty map (all 404)', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: '{}',
    });
    try {
      const { loadConfig } = await import('../../config.js');
      const cfg = loadConfig();
      expect(cfg.llmRouteMapV2).not.toBeNull();
      expect(cfg.llmRouteMapV2!.size).toBe(0);
    } finally {
      restoreEnv();
    }
  });

  it('v1 mode ignores LLM_RUNTIME_ROUTES_V2', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v1',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [{ runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: UPSTREAM, models: [] }],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      const cfg = loadConfig();
      expect(cfg.runtimeContractMode).toBe('v1');
      expect(cfg.llmRouteMapV2).toBeNull();
      // V1 upstreams are still active
      expect(cfg.llmUpstreams.qwen).toBe(UPSTREAM);
    } finally {
      restoreEnv();
    }
  });

  it('shadow mode loads V1 upstreams and does not build route map', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [{ runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: UPSTREAM, models: [] }],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      const cfg = loadConfig();
      expect(cfg.runtimeContractMode).toBe('shadow');
      expect(cfg.llmRouteMapV2).toBeNull();
      // V1 upstreams are still the routing source
      expect(cfg.llmUpstreams.qwen).toBe(UPSTREAM);
    } finally {
      restoreEnv();
    }
  });

  it('shadow mode does not throw on invalid V2 (warn only)', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'shadow',
      LLM_RUNTIME_ROUTES_V2: '{invalid json',
    });
    try {
      const { loadConfig } = await import('../../config.js');
      // Should NOT throw — shadow mode is non-blocking
      const cfg = loadConfig();
      expect(cfg.runtimeContractMode).toBe('shadow');
      expect(cfg.llmUpstreams.qwen).toBe(UPSTREAM);
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode fails closed on missing upstreamBaseUrl', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [{ runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: 'not-a-url', models: [] }],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      expect(() => loadConfig()).toThrow('upstreamBaseUrl');
    } finally {
      restoreEnv();
    }
  });

  it('v2 mode strips trailing slashes from upstreamBaseUrl', async () => {
    setEnv({
      LLM_RUNTIME_CONTRACT_MODE: 'v2',
      LLM_RUNTIME_ROUTES_V2: JSON.stringify({
        routes: [{ runtimeKey: 'qwen', aliases: [], providerId: 'qwen', upstreamBaseUrl: 'https://up.test/v1///', models: [] }],
      }),
    });
    try {
      const { loadConfig } = await import('../../config.js');
      const cfg = loadConfig();
      expect(cfg.llmRouteMapV2!.get('qwen')?.upstreamBaseUrl).toBe(UPSTREAM);
    } finally {
      restoreEnv();
    }
  });
});
