import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The creation page URL Feishu hands back, with our addons appended (as the SDK does).
const qrUrls: string[] = [];
vi.mock('@larksuiteoapi/node-sdk', async (orig) => ({
  ...(await orig<object>()),
  registerApp: vi.fn((opts: { onQRCodeReady: (i: { url: string; expireIn: number }) => void; addons: unknown }) => {
    const url = new URL('https://accounts.feishu.cn/oauth/v1/device/verify');
    url.searchParams.set('user_code', `CODE-${qrUrls.length}`);
    url.searchParams.set('addons', Buffer.from(JSON.stringify(opts.addons)).toString('base64url'));
    qrUrls.push(url.toString());
    opts.onQRCodeReady({ url: url.toString(), expireIn: 600 });
    return new Promise(() => {});
  }),
}));
const encoded: string[] = [];
vi.mock('qrcode', async (orig) => {
  const real = (await orig<{ default: { toDataURL: (t: string, o: unknown) => Promise<string> } }>()).default;
  return { default: { ...real, toDataURL: vi.fn(async (text: string, o: unknown) => { encoded.push(text); return real.toDataURL(text, o); }) } };
});

const { createApp, DIRECT_QR_MAX_CHARS } = await import('../app.js');

describe('Feishu QR for a long creation link', () => {
  it('Mirror V gets a short Portal link that redirects to the full creation page; short links stay direct', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ templates: [
      { id: 'mirror-v-full', version: 'mirror-v-full.v1', name: 'Mirror V', description: '通用 Agent' },
      { id: 'dealclaw', version: 'dealclaw-base.v2', name: 'DealClaw', description: '出海顾问' },
    ] }));
    try {
      const app = createApp();
      const res = await request(app).post('/onboard/feishu/start').send({ templateId: 'mirror-v-full' });
      expect(res.body.ok).toBe(true);
      expect(res.body.qrUrl.length).toBeGreaterThan(DIRECT_QR_MAX_CHARS);
      const short = new URL(encoded.at(-1)!);
      expect(short.pathname).toMatch(/^\/onboard\/feishu\/go\/[A-Za-z0-9_-]{22}$/);
      const go = await request(app).get(short.pathname);
      expect(go.status).toBe(302);
      expect(go.headers.location).toBe(res.body.qrUrl);
      expect((await request(app).get('/onboard/feishu/go/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(410);

      const basic = await request(app).post('/onboard/feishu/start').send({ templateId: 'dealclaw' });
      expect(basic.body.qrUrl.length).toBeLessThanOrEqual(DIRECT_QR_MAX_CHARS);
      expect(encoded.at(-1)).toBe(basic.body.qrUrl);
    } finally { fetchMock.mockRestore(); }
  });
});
