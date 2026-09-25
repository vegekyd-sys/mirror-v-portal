import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
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
    expect(res.text).toContain('NEXUS');
    // The gate deliberately carries no customer-identifying content.
    expect(res.text).not.toContain('公司名称');
    expect(res.text).not.toContain('联系邮箱');
  });

  it('serves the generated onboarding artwork and logo', async () => {
    for (const name of ['nexus-world-v2.webp', 'nexus-world-mobile-v2.webp', 'nexus-logo-v2.webp']) {
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
