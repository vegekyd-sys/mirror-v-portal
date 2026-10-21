import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestrateOnboarding, wakingMessage } from '../services/onboarding-orchestrator.js';

afterEach(() => vi.unstubAllGlobals());

const RM = 'http://runtime-manager.test';

function session(templateId: string, templateName: string) {
  return {
    deviceCode: 'scan', qrUrl: '', expireIn: 600, status: 'pending', startedAt: new Date(), progress: 5,
    appId: 'cli_bound', appSecret: 'bound-secret', userOpenId: 'ou_owner',
    templateId, templateVersion: `${templateId}.v1`, templateName, _abortController: new AbortController(),
  } as any;
}

/** Routes every outbound call; records them so the test can read the conversation back. */
function stubNetwork(opts: { chatId?: string | null } = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetcher = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === `${RM}/v1/tenants` && method === 'POST') return Response.json({ tenant: { tenantId: 't1' } });
    if (url.includes('/auth/v3/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'tat' });
    if (url.includes('/im/v1/messages')) return Response.json({ code: 0, data: { message_id: 'om_1', ...(opts.chatId === null ? {} : { chat_id: opts.chatId ?? 'oc_owner' }) } });
    if (url.endsWith('/v1/tenants/t1/greet')) return Response.json({ queued: true });
    return Response.json({ code: 0 });
  });
  vi.stubGlobal('fetch', fetcher);
  return calls;
}

const sentTexts = (calls: ReturnType<typeof stubNetwork>) =>
  calls.filter((c) => c.url.includes('/im/v1/messages')).map((c) => JSON.parse(c.body.content).text);

describe('the agent speaks first after a scan', () => {
  it('Mirror V: a short waking note now, then its own opening queued in the same chat', async () => {
    const calls = stubNetwork();
    const result = await orchestrateOnboarding(session('mirror-v-full', 'Mirror V'), { provisioningServiceUrl: RM, baseUrl: 'https://portal.test', provisioningApiToken: 'admin' });
    expect(result.ok).toBe(true);
    expect(sentTexts(calls)).toEqual([wakingMessage('Mirror V')]);
    // No tenant id, no "send me a message to start" — the agent will take it from here.
    expect(sentTexts(calls)[0]).not.toMatch(/租户|发消息/);
    const greet = calls.find((c) => c.url.endsWith('/v1/tenants/t1/greet'));
    expect(greet).toMatchObject({ method: 'POST', body: { chatId: 'oc_owner' } });
  });

  it('without a chat id from Feishu there is nobody to address, so no greeting is queued', async () => {
    const calls = stubNetwork({ chatId: null });
    await orchestrateOnboarding(session('mirror-v-full', 'Mirror V'), { provisioningServiceUrl: RM, baseUrl: 'https://portal.test' });
    expect(calls.some((c) => c.url.endsWith('/greet'))).toBe(false);
  });

  it('other templates keep the static welcome and are not greeted by their agent', async () => {
    const calls = stubNetwork();
    await orchestrateOnboarding(session('xingqing', '星擎助手'), { provisioningServiceUrl: RM, baseUrl: 'https://portal.test' });
    expect(sentTexts(calls)[0]).toContain('星擎助手 已就绪');
    expect(calls.some((c) => c.url.endsWith('/greet'))).toBe(false);
  });
});
