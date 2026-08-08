import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp, extractIncomingText } from '../app.js';
import {
  extractOutputText,
  OpenClawRuntimeClient,
  type AgentExecutionContext,
  type RuntimeClient,
} from '../openclaw-runtime.js';

class FakeRuntime implements RuntimeClient {
  calls: Array<{ text: string; context: AgentExecutionContext }> = [];

  async health() {
    return { ok: true, detail: 'test-runtime' };
  }

  async execute(text: string, context: AgentExecutionContext) {
    this.calls.push({ text, context });
    return {
      text: `REAL_RUNTIME:${text}`,
      responseId: 'resp_test',
      model: 'openclaw/dealclaw',
      agentId: 'dealclaw',
    };
  }
}

describe('DealClaw OpenClaw bridge', () => {
  it('reports the real runtime and payload version', async () => {
    const app = createApp({ runtime: new FakeRuntime() });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.runtime).toBe('openclaw');
    expect(res.body.payloadVersion).toBe('dealclaw-base.v1');
  });

  it('forwards text and tenant identity into OpenClaw without static skill routing', async () => {
    const runtime = new FakeRuntime();
    const app = createApp({ runtime });
    const res = await request(app)
      .post('/execute')
      .set('X-DealClaw-Tenant-ID', 'customer-a')
      .set('X-DealClaw-User-ID', 'ou_123')
      .set('X-DealClaw-Plan-Tier', 'pro')
      .send({ intent: { kind: 'chat', text: '帮我找德国五金进口商' } });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('openclaw_runtime');
    expect(res.body.pipeline).toEqual(['openclaw/dealclaw']);
    expect(res.body.result.summary).toBe('REAL_RUNTIME:帮我找德国五金进口商');
    expect(res.body.runtime.engine).toBe('openclaw');
    expect(runtime.calls[0]).toEqual({
      text: '帮我找德国五金进口商',
      context: {
        tenantId: 'customer-a',
        userId: 'ou_123',
        channel: 'feishu',
        planTier: 'pro',
      },
    });
  });

  it('recovers text and sender from wrapped Feishu events', async () => {
    const runtime = new FakeRuntime();
    const app = createApp({ runtime });
    const message = { msg_type: 'text', content: JSON.stringify({ text: '分析这家公司' }) };
    const sender = { sender_id: { open_id: 'ou_feishu' } };
    const res = await request(app)
      .post('/execute')
      .send({ tenantId: 'tenant-b', event: { event: { message, sender } } });

    expect(res.status).toBe(200);
    expect(runtime.calls[0].context.userId).toBe('ou_feishu');
    expect(runtime.calls[0].context.tenantId).toBe('tenant-b');
  });

  it('rejects empty/non-text payloads instead of returning a fake welcome', async () => {
    const app = createApp({ runtime: new FakeRuntime() });
    const res = await request(app).post('/execute').send({ intent: { kind: 'chat' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_MESSAGE');
  });
});

describe('tenant session isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses stable sessions within one tenant and different sessions across tenants', async () => {
    const calls: Array<{ headers: Headers; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ output_text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const runtime = new OpenClawRuntimeClient({ baseUrl: 'http://runtime.test' });
    const base = { userId: 'same-user', channel: 'feishu' };
    await runtime.execute('one', { ...base, tenantId: 'tenant-a' });
    await runtime.execute('two', { ...base, tenantId: 'tenant-a' });
    await runtime.execute('three', { ...base, tenantId: 'tenant-b' });

    const sessionKeys = calls.map(call => call.headers.get('x-openclaw-session-key'));
    expect(sessionKeys[0]).toBe(sessionKeys[1]);
    expect(sessionKeys[0]).not.toBe(sessionKeys[2]);
    expect(calls[0].body.user).toBe(calls[1].body.user);
    expect(calls[0].body.user).not.toBe(calls[2].body.user);
  });
});

describe('payload adapters', () => {
  it('extracts normalized and Feishu text shapes', () => {
    const message = { msg_type: 'text', content: JSON.stringify({ text: '找买家' }) };
    expect(extractIncomingText({ intent: { text: '查公司' } })).toBe('查公司');
    expect(extractIncomingText({ event: { data: { event: { message } } } })).toBe('找买家');
  });

  it('extracts OpenResponses output text', () => {
    expect(extractOutputText({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '第一段' }, { type: 'output_text', text: '第二段' }] }],
    })).toBe('第一段\n第二段');
  });
});
