import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signupAccountSecrets } from '../services/makaron-account.js';
import { createApp } from '../app.js';
import { orchestrateOnboarding } from '../services/onboarding-orchestrator.js';

const key = 'mk_live_disposable_test_account_123456789';
afterEach(() => vi.unstubAllGlobals());

describe('Makaron signup account isolation', () => {
  it('never uses an owner fallback or starts registration for a missing customer key', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ templates: [{ id: 'makaron', version: 'makaron.v2.1.2' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    for (const channel of ['feishu', 'weixin']) {
      const response = await request(createApp()).post(`/onboard/${channel}/start`).send({ templateId: 'makaron' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MAKARON_ACCOUNT_REQUIRED');
    }
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/v1/templates'))).toBe(true);
  });
  it('checks only the fixed Makaron account endpoint and returns the exact customer secret', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await signupAccountSecrets('makaron', ` ${key} `)).toEqual({ MAKARON_API_KEY: key });
    expect(fetcher.mock.calls[0][0]).toBe('https://www.makaron.app/api/billing/credits');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { authorization: `Bearer ${key}` }, redirect: 'error' });
  });
  it('rejects invalid or unavailable accounts without copying upstream details', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('sensitive upstream body', { status: 401 })).mockResolvedValueOnce(new Response('upstream failure', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(signupAccountSecrets('makaron', key)).rejects.toMatchObject({ code: 'MAKARON_ACCOUNT_INVALID' });
    await expect(signupAccountSecrets('makaron', key)).rejects.toMatchObject({ code: 'MAKARON_ACCOUNT_UNAVAILABLE' });
  });
  it('does not bind Makaron credentials to another template', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await signupAccountSecrets('mirror-v-full', key)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('binds the scan account to its created tenant before any welcome, and fails closed on a rejected binding', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'http://127.0.0.1:1/v1/tenants') return new Response(JSON.stringify({ tenant: { tenantId: 'scan-owned-tenant' } }), { status: 200 });
      if (url.endsWith('/secrets')) return new Response('{}', { status: 403 });
      throw new Error('Unexpected request after failed account binding');
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await orchestrateOnboarding({ deviceCode: 'disposable', qrUrl: '', expireIn: 600, status: 'pending', startedAt: new Date(), progress: 5,
      appId: 'disposable-app', appSecret: 'disposable-secret', userOpenId: 'scan-owner', templateId: 'makaron', templateVersion: 'makaron.v2.1.2', _abortController: new AbortController() },
      { provisioningServiceUrl: 'http://127.0.0.1:1', baseUrl: 'https://example.com', tenantSecrets: { MAKARON_API_KEY: key } });
    expect(result).toEqual({ ok: false, error: 'MAKARON_ACCOUNT_BIND_FAILED' });
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[1][0]).toBe('http://127.0.0.1:1/v1/tenants/scan-owned-tenant/secrets');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ secrets: { MAKARON_API_KEY: key } });
  });
});
