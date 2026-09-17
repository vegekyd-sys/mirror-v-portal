import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import type { GatewayConfig } from '../../config.js';
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
    ...over,
  };
}

interface Harness {
  app: Express;
  reports: UsageReportEvent[];
  upstreamCalls: Array<{ url: string; method: string; auth?: string; body?: any }>;
  /** mutate to change ledger balance responses */
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

    // simulate a truly unreachable upstream host
    if (url.startsWith('http://127.0.0.1:1')) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    }

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
    if (url === `${UPSTREAM}/chat/completions` && method === 'POST') {
      const reqBody = decodeBody(init?.body);
      h.upstreamCalls.push({
        url, method,
        auth: (init?.headers as any)?.authorization,
        body: reqBody,
      });
      if (reqBody.forceError) return new Response('{"error":"bad"}', { status: 400 });

      if (reqBody.stream) {
        const sse = [
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{}}],"usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168}}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'c1', object: 'chat.completion', model: reqBody.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      });
    }
    return new Response('not found', { status: 404 });
  };

  registerLlmProxy(h.app, config, { fetchImpl, onReport: ev => h.reports.push(ev) });
  return h;
}

const chatBody = (over: Record<string, unknown> = {}) => ({
  model: 'deepseek-v4-pro', stream: true,
  messages: [{ role: 'user', content: '帮我写封开发信' }],
  ...over,
});

beforeEach(() => {
  // isolate per-test balance state via fresh harness in each test
});

describe('LLM egress proxy', () => {
  it('404s for an unconfigured provider', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/unknown/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('synthesizes a balance reply for 查余额 (no upstream call)', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ messages: [{ role: 'user', content: '查余额' }] }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('可用余额');
    expect(res.text).toContain('50.0K');
    expect(res.text).toContain('[DONE]');
    expect(h.upstreamCalls.length).toBe(0);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].status).toBe('synthesized');
  });

  it('blocks chat when balance is exhausted', async () => {
    const h = makeHarness();
    h.balance = 0;
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(res.text).toContain('额度已用完');
    expect(h.upstreamCalls.length).toBe(0);
    expect(h.reports[0].status).toBe('blocked');
  });

  it('fail-opens when the ledger is unreachable', async () => {
    const h = makeHarness();
    h.balanceFetchFail = true;
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(200);
    expect(h.upstreamCalls.length).toBe(1);
    expect(h.reports[0].status).toBe('ok');
  });

  it('streams upstream chunks unchanged and reports tee-d usage + passthrough auth', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer sk-real-key')
      .send(chatBody());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('你好');
    expect(res.text).toContain('"input_tokens":123');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(h.upstreamCalls[0].auth).toBe('Bearer sk-real-key');
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ status: 'ok', inputTokens: 123, outputTokens: 45, provider: 'qwen', model: 'deepseek-v4-pro' });
  });

  it('forwards non-stream JSON and reports usage', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ stream: false }));
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('hello');
    expect(h.reports[0]).toMatchObject({ status: 'ok', inputTokens: 10, outputTokens: 6 });
  });

  it('passes upstream errors through and reports status=error', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody({ stream: false, forceError: true }));
    expect(res.status).toBe(400);
    expect(h.reports[0].status).toBe('error');
  });

  it('does not intercept non-chat calls (GET models)', async () => {
    const h = makeHarness();
    const res = await request(h.app).get('/v1/llm/qwen/models');
    // upstream mock 404s for /models — the point is it was forwarded, not intercepted
    expect(res.status).toBe(404);
    expect(h.reports[0].status).toBe('error');
  });

  it('502s when upstream is unreachable', async () => {
    const config = makeConfig({ llmUpstreams: { qwen: 'http://127.0.0.1:1' } });
    const h = makeHarness(config);
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json').send(chatBody());
    expect(res.status).toBe(502);
    expect(h.reports[0].status).toBe('error');
  });

  it('does not intercept a long sub-agent context containing 消耗 (regression)', async () => {
    const h = makeHarness();
    const longTask = '请搜索美国 LED 户外照明采购商 10 家，优先用 CDP 联系人接口拿联系人+邮箱，免费且不消耗 Apollo 额度，最终整理成买家清单返回。';
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ messages: [{ role: 'user', content: longTask }] }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('你好'); // passed through to the real upstream
    expect(h.upstreamCalls.length).toBe(1);
    expect(h.reports[0].status).toBe('ok');
  });

  it('still synthesizes a balance reply for 本月消耗了多少 (short query)', async () => {
    const h = makeHarness();
    const res = await request(h.app).post('/v1/llm/qwen/chat/completions')
      .set('content-type', 'application/json')
      .send(chatBody({ messages: [{ role: 'user', content: '本月消耗了多少' }] }));
    expect(res.status).toBe(200);
    expect(res.text).toContain('可用余额');
    expect(h.upstreamCalls.length).toBe(0);
    expect(h.reports[0].status).toBe('synthesized');
  });
});
