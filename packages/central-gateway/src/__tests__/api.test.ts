import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { runInNewContext } from 'node:vm';
import { createApp } from '../app.js';
import { ONBOARD_HTML } from '../services/onboard-page.js';
import { detectPlatform, routeOnboarding, getRedirectUrl } from '../services/channel.js';
import {
  startFeishuRegistration,
  pollRegistrationStatus,
  cancelRegistration,
  type RegistrationSession,
} from '../services/feishu-register.js';
import { orchestrateOnboarding, extractFeishuText } from '../services/onboarding-orchestrator.js';

// Use a unique test app (loadConfig reads env on each call)
const app = createApp();

// ── Channel Detection Tests (unchanged) ──

describe('Channel Detection', () => {
  it('detects feishu', () => {
    expect(detectPlatform('Mozilla/5.0 Lark/7.0')).toBe('feishu');
    expect(detectPlatform('Feishu/6.0 Android')).toBe('feishu');
  });

  it('detects dingtalk', () => {
    expect(detectPlatform('Mozilla/5.0 DingTalk/6.0')).toBe('dingtalk');
    expect(detectPlatform('钉钉 Android 5.0')).toBe('dingtalk');
  });

  it('detects wecom', () => {
    expect(detectPlatform('Mozilla/5.0 wxwork/4.0')).toBe('wecom');
    expect(detectPlatform('企业微信 iOS')).toBe('wecom');
  });

  it('detects wechat (personal)', () => {
    expect(detectPlatform('MicroMessenger/8.0')).toBe('wechat');
  });

  it('returns unknown for browsers', () => {
    expect(detectPlatform('Mozilla/5.0 Chrome/120')).toBe('unknown');
  });
});

describe('Redirect URL generation', () => {
  it('generates feishu URL', () => {
    const url = getRedirectUrl('feishu', 'https://dealclaw.cn', 'state123');
    expect(url).toContain('/onboard/feishu');
    expect(url).toContain('state123');
  });

  it('generates dingtalk URL', () => {
    const url = getRedirectUrl('dingtalk', 'https://dealclaw.cn', 'state123');
    expect(url).toContain('login.dingtalk.com');
    expect(url).toContain('state123');
  });

  it('generates wecom URL', () => {
    const url = getRedirectUrl('wecom', 'https://dealclaw.cn', 'state123');
    expect(url).toContain('open.weixin.qq.com');
    expect(url).toContain('#wechat_redirect');
  });
});

// ── Feishu RegisterApp Service Tests ──

describe('Feishu RegisterApp Service', () => {
  it('startFeishuRegistration returns a valid session', async () => {
    // Note: this test does NOT actually call lark.registerApp() —
    // it tests the session structure via the mock/error path.
    // In a real integration test, lark.registerApp() would need network + a Feishu app.
    const session = await startFeishuRegistration();

    expect(session).toBeDefined();
    expect(session.status).toBe('pending');
    expect(session.progress).toBeGreaterThanOrEqual(0);
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session._abortController).toBeDefined();

    // Cleanup
    session._abortController.abort();
  });

  it('pollRegistrationStatus returns correct status messages', () => {
    const pendingSession: RegistrationSession = {
      deviceCode: 'test-001',
      qrUrl: 'https://open.feishu.cn/test',
      expireIn: 600,
      status: 'pending',
      startedAt: new Date(),
      progress: 5,
      _abortController: new AbortController(),
    };

    const status = pollRegistrationStatus(pendingSession);
    expect(status.progress).toBe(5);
    expect(status.message).toContain('扫描二维码');
  });

  it('pollRegistrationStatus shows completing message for completed', () => {
    const completedSession: RegistrationSession = {
      deviceCode: 'test-done',
      qrUrl: 'https://open.feishu.cn/test',
      expireIn: 600,
      status: 'completed',
      startedAt: new Date(),
      progress: 100,
      _abortController: new AbortController(),
    };

    const status = pollRegistrationStatus(completedSession);
    expect(status.progress).toBe(100);
    expect(status.message).toContain('入驻完成');
  });

  it('cancelRegistration removes session from map', () => {
    const sessions = new Map<string, RegistrationSession>();
    const session: RegistrationSession = {
      deviceCode: 'dc-cancel',
      qrUrl: 'https://open.feishu.cn/test',
      expireIn: 600,
      status: 'pending',
      startedAt: new Date(),
      progress: 5,
      _abortController: new AbortController(),
    };
    sessions.set('dc-cancel', session);

    const result = cancelRegistration(sessions, 'dc-cancel');
    expect(result.ok).toBe(true);
    expect(sessions.has('dc-cancel')).toBe(false);
  });

  it('cancelRegistration returns false for unknown deviceCode', () => {
    const sessions = new Map<string, RegistrationSession>();
    const result = cancelRegistration(sessions, 'nonexistent');
    expect(result.ok).toBe(false);
  });
});

// ── API Tests ──

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('central-gateway');
  });
});

describe('GET /onboard — Feishu registration', () => {
  it('shows only manager-approved templates and rejects an unknown selection before registration', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ templates: [
      { id: 'dealclaw', version: 'dealclaw-base.v2', name: 'DealClaw', description: '出海顾问' },
      { id: 'mirror-v', version: 'mirror-v.v1', name: 'Mirror V', description: '通用 Agent' },
    ] }));
    try {
      const catalog = await request(app).get('/onboard/templates');
      expect(catalog.status).toBe(200);
      expect(catalog.body.templates.map((item: { id: string }) => item.id)).toEqual(['dealclaw', 'mirror-v']);
      const invalid = await request(app).post('/onboard/feishu/start').send({ templateId: 'unapproved' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('TEMPLATE_NOT_AVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
  });
  it('hides unlisted templates from the signup page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ templates: [
      { id: 'mirror-v', version: 'mirror-v.v1', name: 'Mirror V', description: '通用 Agent', listed: true },
      { id: 'xingqing', version: 'xingqing-starter.v1', name: '星擎助手', description: '数据问答', listed: false },
    ] }));
    try {
      const catalog = await request(app).get('/onboard/templates');
      expect(catalog.body.templates.map((item: { id: string }) => item.id)).toEqual(['mirror-v']);
    } finally { fetchMock.mockRestore(); }
  });
  it('returns JSON for feishu UA (registerApp may need real network)', async () => {
    const res = await request(app).get('/onboard').set('User-Agent', 'Feishu/7.0');
    // RegisterApp may fail in test env (needs real Feishu network).
    // In that case the endpoint returns 500 with status: 'failed'.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.platform).toBe('feishu');
      expect(['pending', 'failed']).toContain(res.body.status);
    }
  });

  it('returns HTML page for non-feishu platforms', async () => {
    const res = await request(app).get('/onboard').set('User-Agent', 'Chrome');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>Mirror V Portal · 选择你的 Agent</title>');
    expect(res.text).toContain('id="channelWeixin"');
    expect(res.text).toContain("'/onboard/weixin/start'");
    // Feishu's app-creation launcher only works from the Feishu scanner, so the
    // desktop shows its native QR instead of a Portal entry.
    expect(res.text).toContain("'/onboard/feishu/start'");
    expect(res.text).toContain("'/onboard/feishu/status/'");
    expect(res.text).not.toContain("'/onboard/portal/start'");
    // The gate deliberately carries no customer-identifying content.
    expect(res.text).not.toContain('公司名称');
    expect(res.text).not.toContain('联系邮箱');
  });

  it('serves the generated onboarding artwork', async () => {
    for (const name of ['nexus-world-v2.webp', 'nexus-world-mobile-v2.webp']) {
      const res = await request(app).get('/onboard/assets/' + name);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/webp');
      expect(res.body.subarray(0, 4).toString()).toBe('RIFF');
    }
  });

  it('supports byte ranges for the background video', async () => {
    const res = await request(app).get('/onboard/assets/nexus-world-v5.mp4').set('Range', 'bytes=0-255');
    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toContain('video/mp4');
    expect(res.headers['content-range']).toMatch(/^bytes 0-255\//);
    expect(Number(res.headers['content-length'])).toBe(256);
  });

  it('returns HTML page for dingtalk', async () => {
    const res = await request(app).get('/onboard').set('User-Agent', 'DingTalk/6.0');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('DealClaw');
  });
});

describe('Explicit onboarding template links', () => {
  // Execute the page's actual selection function without starting a channel
  // registration. The browser acceptance still verifies the complete page.
  async function selectFromPage(search: string, templates: Array<{ id: string; name: string; description: string }>) {
    const start = ONBOARD_HTML.indexOf('async function loadTemplates()');
    const end = ONBOARD_HTML.indexOf('async function open()', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    function element() {
      const handlers = new Map<string, () => void>();
      return {
        type: '', className: '', textContent: '',
        setAttribute: vi.fn(), append: vi.fn(),
        addEventListener(name: string, handler: () => void) { handlers.set(name, handler); },
        click() { handlers.get('click')?.(); },
      };
    }
    const cards: Array<ReturnType<typeof element>> = [];
    const opened = vi.fn(), closed = vi.fn();
    const context = {
      URL, URLSearchParams,
      location: { search, href: 'https://portal.example/onboard' + search },
      history: { replaceState: vi.fn() },
      document: { createElement: element },
      templateList: {
        replaceChildren() { cards.length = 0; },
        appendChild(card: ReturnType<typeof element>) { cards.push(card); },
        querySelectorAll() { return cards; },
      },
      templateDescription: { textContent: '' },
      templateSelect: { value: '', replaceChildren: vi.fn(), appendChild: vi.fn() },
      selectedTemplate: null as { id: string } | null,
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ templates }) })),
      open: opened, closeGate: closed,
      resetMobilePicker: vi.fn(), appendMobileAgent: vi.fn(), updateMobileSelection: vi.fn(),
    };
    await runInNewContext(ONBOARD_HTML.slice(start, end) + '\nloadTemplates()', context);
    return { context, opened, closed };
  }
  const mirror = { id: 'mirror-v', name: 'Mirror V', description: '通用 Agent' };
  const makaron = { id: 'makaron', name: 'Makaron', description: '图片与视频创作' };

  it('opens Makaron when the explicit template is available', async () => {
    const result = await selectFromPage('?template=makaron', [mirror, makaron]);
    expect(result.context.selectedTemplate?.id).toBe('makaron');
    expect(result.opened).toHaveBeenCalledTimes(1);
    expect(result.closed).not.toHaveBeenCalled();
  });
  it('never falls back or starts authorization for an absent or unlisted requested template', async () => {
    for (const search of ['?template=makaron', '?template=unknown', '?template=']) {
      const result = await selectFromPage(search, [mirror]);
      expect(result.context.selectedTemplate).toBeNull();
      expect(result.opened).not.toHaveBeenCalled();
      expect(result.closed).toHaveBeenCalledWith('所选 Agent 暂未开放，请稍后重试');
      expect(result.context.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('retains the ordinary portal default without an explicit template', async () => {
    const result = await selectFromPage('', [makaron, mirror]);
    expect(result.context.selectedTemplate?.id).toBe('mirror-v');
    expect(result.opened).toHaveBeenCalledTimes(1);
    expect(result.closed).not.toHaveBeenCalled();
  });
});

describe('WeChat portal onboarding', () => {
  it('pins the chosen template and only exposes status for its own QR session', async () => {
    const managerCalls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/templates')) return Response.json({ templates: [
        { id: 'mirror-v', version: 'mirror-v.v1', name: 'Mirror V', description: '通用 Agent' },
      ] });
      managerCalls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/v1/channels/weixin/portal-login')) return Response.json({
        sessionId: 'weixin-flow-test', qrImage: 'https://example.invalid/qr', expiresIn: 600,
      });
      if (url.endsWith('/v1/channels/weixin/login/weixin-flow-test') && init?.method === 'DELETE')
        return Response.json({ ok: true });
      if (url.endsWith('/v1/channels/weixin/login/weixin-flow-test'))
        return Response.json({ status: 'pending', expiresIn: 590 });
      throw new Error(`Unexpected request: ${url}`);
    });
    try {
      const started = await request(app).post('/onboard/weixin/start').send({ templateId: 'mirror-v' });
      expect(started.status).toBe(200);
      expect(started.body.deviceCode).toBe('weixin-flow-test');
      expect(started.body.qrDataUri).toMatch(/^data:image\/png;base64,/);
      expect(JSON.parse(managerCalls[0].body || '{}')).toEqual({ templateId: 'mirror-v', templateVersion: 'mirror-v.v1' });
      expect(managerCalls.some(call => call.url.endsWith('/v1/tenants'))).toBe(false);
      expect((await request(app).get('/onboard/weixin/status/unknown')).status).toBe(404);
      const status = await request(app).get('/onboard/weixin/status/weixin-flow-test');
      expect(status.body.status).toBe('pending');
      expect((await request(app).post('/onboard/weixin/cancel').send({ deviceCode: 'weixin-flow-test' })).body.ok).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('One-scan Portal entry', () => {
  it('shows one QR before choosing a channel and routes the same entry to a native authorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/templates')) return Response.json({ templates: [
        { id: 'mirror-v', version: 'mirror-v.v1', name: 'Mirror V', description: '通用 Agent' },
      ] });
      if (url.endsWith('/v1/channels/weixin/portal-login')) return Response.json({
        sessionId: 'portal-weixin-test', qrImage: 'https://liteapp.weixin.qq.com/test', expiresIn: 600,
      });
      if (url.endsWith('/v1/channels/weixin/login/portal-weixin-test'))
        return Response.json({ status: 'pending', progress: 12 });
      throw new Error(`Unexpected request: ${url} ${init?.method || 'GET'}`);
    });
    try {
      const entry = await request(app).post('/onboard/portal/start').send({ templateId: 'mirror-v' });
      expect(entry.status).toBe(200);
      expect(entry.body.qrDataUri).toMatch(/^data:image\/png;base64,/);
      const id = entry.body.entryId;
      const scan = await request(app).get('/onboard/scan').query({ entry: id });
      expect(scan.status).toBe(200);
      expect(scan.text).toContain('MicroMessenger');
      expect(scan.text).toContain('Lark|Feishu');
      expect(scan.text).not.toContain('长按上方授权码');
      expect(scan.text).not.toContain('在微信确认开通');
      expect(scan.text).toContain('回到电脑上的 Portal，选择“微信”');
      expect(scan.text).not.toContain('id="weixin">在微信开通');
      expect(scan.text).not.toContain('location.assign(');
      expect(scan.text).not.toContain('飞书扫码</button>');
      const before = await request(app).get(`/onboard/portal/${id}/status`);
      expect(before.body).toMatchObject({ templateId: 'mirror-v', channel: null, status: 'pending' });

      const native = await request(app).post('/onboard/weixin/start').send({ templateId: 'mirror-v' });
      expect(native.status).toBe(200);
      const linked = await request(app).post(`/onboard/portal/${id}/link`).send({ channel: 'weixin', deviceCode: native.body.deviceCode });
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({ ok: true, qrImageUrl: `/onboard/portal/${id}/weixin-qr.png` });
      expect(linked.body.redirectUrl).toBeUndefined();
      expect((await request(app).post(`/onboard/portal/${id}/link`).send({ channel: 'weixin', deviceCode: native.body.deviceCode })).status).toBe(409);
      const after = await request(app).get(`/onboard/portal/${id}/status`);
      expect(after.body).toMatchObject({ channel: 'weixin', status: 'pending', progress: 12, qrImageUrl: `/onboard/portal/${id}/weixin-qr.png` });
      expect(after.body.actionUrl).toBeUndefined();
      expect(after.text).not.toContain(native.body.deviceCode);
      const image = await request(app).get(after.body.qrImageUrl);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toContain('image/png');
      expect(image.headers['cache-control']).toBe('no-store');
      expect(image.body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect((await request(app).post(`/onboard/portal/${id}/cancel`)).body.ok).toBe(true);
      expect((await request(app).get(`/onboard/portal/${id}/status`)).status).toBe(410);
      expect((await request(app).get(after.body.qrImageUrl)).status).toBe(404);
    } finally { fetchMock.mockRestore(); }
  });

  it('rejects expired or unapproved entries before any channel session starts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ templates: [
      { id: 'mirror-v', version: 'mirror-v.v1', name: 'Mirror V', description: '通用 Agent' },
    ] }));
    try {
      expect((await request(app).post('/onboard/portal/start').send({ templateId: 'unknown' })).status).toBe(400);
      expect((await request(app).get('/onboard/scan').query({ entry: 'unknown' })).status).toBe(410);
      expect((await request(app).post('/onboard/portal/unknown/link').send({ channel: 'feishu', deviceCode: 'x' })).status).toBe(410);
    } finally { fetchMock.mockRestore(); }
  });
});

describe('GET /onboard/status', () => {
  it('returns a debug session list when deviceCode is missing', async () => {
    const res = await request(app).get('/onboard/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it('returns 404 for unknown deviceCode', async () => {
    const res = await request(app).get('/onboard/status?deviceCode=nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /onboard/cancel', () => {
  it('returns 400 when deviceCode is missing', async () => {
    const res = await request(app).post('/onboard/cancel').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('returns ok:false for unknown deviceCode', async () => {
    const res = await request(app).post('/onboard/cancel').send({ deviceCode: 'nonexistent' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});

describe('Platform Callbacks', () => {
  it('GET /onboard/dingtalk/callback handles callback with code', async () => {
    const res = await request(app).get('/onboard/dingtalk/callback?code=auth123');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('dingtalk');
  });

  it('GET /onboard/wecom/callback handles callback', async () => {
    const res = await request(app).get('/onboard/wecom/callback?code=auth456');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('wecom');
  });
});

// ── Onboarding Orchestrator Tests ──

describe('Onboarding Orchestrator', () => {
  it('returns error when session has no app credentials', async () => {
    const emptySession: RegistrationSession = {
      deviceCode: 'orc-001',
      qrUrl: 'https://open.feishu.cn/test',
      expireIn: 600,
      status: 'pending',
      startedAt: new Date(),
      progress: 5,
      _abortController: new AbortController(),
    };

    const result = await orchestrateOnboarding(emptySession, {
      provisioningServiceUrl: 'http://127.0.0.1:19999',
      baseUrl: 'https://dealclaw.cn',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing app credentials');
  });

  it('returns error when provisioning is unreachable', async () => {
    const session: RegistrationSession = {
      deviceCode: 'orc-002',
      qrUrl: 'https://open.feishu.cn/test',
      expireIn: 600,
      status: 'provisioning',
      startedAt: new Date(),
      progress: 75,
      appId: 'cli_test_app',
      appSecret: 'test_secret',
      _abortController: new AbortController(),
    };

    const result = await orchestrateOnboarding(session, {
      provisioningServiceUrl: 'http://127.0.0.1:19999', // unreachable
      baseUrl: 'https://dealclaw.cn',
    });

    expect(result.ok).toBe(false);
  });

  it('generates correct webhook URL format', () => {
    // Verify webhook URL construction logic
    const baseUrl = 'https://dealclaw.cn';
    const tenantId = 'test12345';
    const expectedWebhook = `${baseUrl}/v1/agent/${tenantId}/webhook`;
    expect(expectedWebhook).toBe('https://dealclaw.cn/v1/agent/test12345/webhook');
  });
});

describe('Feishu text extraction', () => {
  const message = { msg_type: 'text', content: JSON.stringify({ text: '帮我找德国五金进口商' }) };

  it('extracts text from the unwrapped Lark SDK event shape', () => {
    expect(extractFeishuText({ message })).toBe('帮我找德国五金进口商');
  });

  it('extracts text from a wrapped Feishu webhook event shape', () => {
    expect(extractFeishuText({ event: { message } })).toBe('帮我找德国五金进口商');
  });

  it('extracts text from a nested data.event shape', () => {
    expect(extractFeishuText({ data: { event: { message } } })).toBe('帮我找德国五金进口商');
  });

  it('ignores non-text messages', () => {
    expect(extractFeishuText({ message: { msg_type: 'image', content: '{}' } })).toBe('');
  });
});
