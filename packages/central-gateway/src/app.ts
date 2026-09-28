import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import QRCode from 'qrcode';
import { detectPlatform } from './services/channel.js';
import { loadConfig } from './config.js';
import {
  startFeishuRegistration,
  pollRegistrationStatus,
  cancelRegistration,
  getRegistrationResult,
  type RegistrationSession,
} from './services/feishu-register.js';
import { orchestrateOnboarding } from './services/onboarding-orchestrator.js';
import { relayNotification, type NotifyPayload } from './services/notify-relay.js';
import { DINGTALK_ONBOARD_HTML, WECOM_ONBOARD_HTML } from './services/platform-onboarding.js';
import { ONBOARD_HTML } from './services/onboard-page.js';
import { PORTAL_SCAN_HTML } from './services/portal-scan-page.js';

// listed=false: selectable by explicit id (acceptance tests) but not shown on the signup page.
interface SignupTemplate { id: string; version: string; name: string; description: string; listed?: boolean }
async function loadSignupTemplates(config: ReturnType<typeof loadConfig>): Promise<SignupTemplate[]> {
  const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/templates`, {
    headers: config.provisioningApiToken ? { Authorization: `Bearer ${config.provisioningApiToken}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`TEMPLATE_CATALOG_UNAVAILABLE:${response.status}`);
  const body = await response.json() as { templates?: SignupTemplate[] };
  if (!Array.isArray(body.templates)) throw new Error('TEMPLATE_CATALOG_INVALID');
  return body.templates;
}
async function selectSignupTemplate(config: ReturnType<typeof loadConfig>, id: unknown): Promise<SignupTemplate> {
  const templates = await loadSignupTemplates(config);
  const template = templates.find((item) => item.id === (id ?? 'dealclaw'));
  if (!template) throw new Error('TEMPLATE_NOT_AVAILABLE');
  return template;
}

// NB8 FIX: Simple in-memory rate limiter for onboarding endpoints
const onboardRateLimits = new Map<string, { count: number; resetAt: number }>();
function onboardingRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
    const now = Date.now();
    const entry = onboardRateLimits.get(ip);

    if (entry && now < entry.resetAt) {
      if (entry.count >= maxRequests) {
        res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many onboarding requests. Please try again later.' });
        return;
      }
      entry.count++;
    } else {
      onboardRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    }
    next();
  };
}

// Clean stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of onboardRateLimits) {
    if (entry.resetAt < now) onboardRateLimits.delete(key);
  }
}, 5 * 60 * 1000);

export function createApp() {
  const config = loadConfig();
  const app = express();
  app.disable('x-powered-by');
  // The public listener is behind local Nginx; preserve the scanner's real IP
  // for onboarding rate limits without trusting arbitrary forwarded headers.
  app.set('trust proxy', 'loopback');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        connectSrc: ["'self'", 'https:', 'http:'],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use('/onboard/assets', express.static(fileURLToPath(new URL('../public/onboard/', import.meta.url)), { maxAge: '1d', index: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ═══════════════════════════════════════════════════════════
  // In-memory session store (per-process, cleared on restart)
  // In production, replace with Redis/DB-backed store.
  // ═══════════════════════════════════════════════════════════
  const sessions = new Map<string, RegistrationSession>();
  const weixinSessions = new Map<string, { startedAt: number; templateId: string; qrUrl: string }>();
  const portalEntries = new Map<string, {
    template: SignupTemplate;
    createdAt: number;
    channel?: 'feishu' | 'weixin';
    deviceCode?: string;
  }>();

  // Clean stale sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      // Only clean sessions older than 20 minutes
      const age = now - s.startedAt.getTime();
      if (age < 20 * 60 * 1000) continue;
      if (s.status === 'expired' || s.status === 'cancelled' || s.status === 'failed') {
        console.log(`[session] cleaning stale: ${key}, status=${s.status}, age=${Math.round(age/1000)}s`);
        sessions.delete(key);
      }
      if (s.completedAt && now - s.completedAt.getTime() > 30 * 60 * 1000) {
        sessions.delete(key);
      }
    }
    for (const [id, session] of weixinSessions) {
      if (now - session.startedAt > 20 * 60_000) weixinSessions.delete(id);
    }
    for (const [id, entry] of portalEntries) {
      if (now - entry.createdAt > 20 * 60_000) portalEntries.delete(id);
    }
  }, 5 * 60 * 1000);

  // ═══════════════════════════════════════════════════════════
  // In-memory tenant credential store
  // In production: stored in DB, loaded by tenant's own Agent pod.
  // ═══════════════════════════════════════════════════════════
  const tenantCredentials = new Map<string, { appId: string; tenantAccessToken: string }>();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'central-gateway' });
  });

  app.get('/onboard/templates', async (_req, res) => {
    try { res.json({ templates: (await loadSignupTemplates(config)).filter((template) => template.listed !== false) }); }
    catch { res.status(503).json({ code: 'TEMPLATE_CATALOG_UNAVAILABLE' }); }
  });

  // The desktop displays one Portal QR. The scanner's app chooses the native
  // authorization flow after opening this URL; the entry keeps both devices in
  // sync without starting unused Feishu and WeChat registrations up front.
  app.post('/onboard/portal/start', onboardingRateLimit(10, 60_000), async (req, res) => {
    try {
      const template = await selectSignupTemplate(config, req.body?.templateId ?? 'mirror-v');
      const entryId = randomUUID();
      const url = new URL('/onboard/scan', config.portalBaseUrl);
      url.searchParams.set('entry', entryId);
      portalEntries.set(entryId, { template, createdAt: Date.now() });
      res.json({ ok: true, entryId, templateId: template.id, qrDataUri: await QRCode.toDataURL(url.toString(), { width: 300, margin: 1 }), expireIn: 600 });
    } catch (error) {
      console.error('[portal-entry] start failed', error);
      const invalidTemplate = error instanceof Error && error.message === 'TEMPLATE_NOT_AVAILABLE';
      res.status(invalidTemplate ? 400 : 503).json({ code: invalidTemplate ? 'TEMPLATE_NOT_AVAILABLE' : 'PORTAL_ENTRY_UNAVAILABLE', message: invalidTemplate ? 'Agent 模板不可用' : '入口码暂时不可用' });
    }
  });

  function portalEntry(id: string) {
    const entry = portalEntries.get(id);
    return entry && Date.now() - entry.createdAt < 10 * 60_000 ? entry : undefined;
  }

  app.get('/onboard/scan', (req, res) => {
    if (!portalEntry(String(req.query.entry || ''))) {
      res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><title>入口码已过期</title><p>入口码已过期，请在电脑上重新生成。</p>');
      return;
    }
    res.type('html').send(PORTAL_SCAN_HTML);
  });

  app.get('/onboard/portal/:entryId/status', async (req, res) => {
    const entry = portalEntry(req.params.entryId);
    if (!entry) { res.status(410).json({ status: 'expired', message: '入口码已过期' }); return; }
    const base = {
      templateId: entry.template.id,
      templateName: entry.template.name,
      channel: entry.channel || null,
      actionUrl: entry.channel === 'feishu' && entry.deviceCode ? sessions.get(entry.deviceCode)?.qrUrl : undefined,
      qrImageUrl: entry.channel === 'weixin' && entry.deviceCode ? `/onboard/portal/${encodeURIComponent(req.params.entryId)}/weixin-qr.png` : undefined,
    };
    if (!entry.channel || !entry.deviceCode) { res.json({ ...base, status: 'pending', progress: 0 }); return; }
    if (entry.channel === 'feishu') {
      const session = sessions.get(entry.deviceCode);
      if (!session) { res.json({ ...base, status: 'expired', message: '飞书授权已过期' }); return; }
      const info = pollRegistrationStatus(session);
      res.json({ ...base, status: session.status, progress: info.progress, message: info.message });
      return;
    }
    try {
      const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(entry.deviceCode)}`, {
        headers: config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('WEIXIN_STATUS_UNAVAILABLE');
      const status = await response.json() as { status: string; progress?: number; message?: string };
      res.json({ ...base, status: status.status, progress: status.progress, message: status.message });
    } catch { res.json({ ...base, status: 'checking', message: '正在检查微信授权' }); }
  });

  app.get('/onboard/portal/:entryId/weixin-qr.png', async (req, res) => {
    const entry = portalEntry(req.params.entryId);
    const session = entry?.channel === 'weixin' && entry.deviceCode ? weixinSessions.get(entry.deviceCode) : undefined;
    if (!session) { res.status(404).end(); return; }
    try {
      const png = await QRCode.toBuffer(session.qrUrl, { width: 360, margin: 2 });
      res.set('Cache-Control', 'no-store').type('png').send(png);
    } catch { res.status(503).end(); }
  });

  app.post('/onboard/portal/:entryId/link', (req, res) => {
    const entry = portalEntry(req.params.entryId);
    if (!entry) { res.status(410).json({ code: 'PORTAL_ENTRY_EXPIRED' }); return; }
    if (entry.channel) { res.status(409).json({ code: 'PORTAL_ENTRY_IN_USE' }); return; }
    const channel = req.body?.channel;
    const deviceCode = String(req.body?.deviceCode || '');
    const session = channel === 'feishu' ? sessions.get(deviceCode) : channel === 'weixin' ? weixinSessions.get(deviceCode) : undefined;
    if (!session || session.templateId !== entry.template.id) { res.status(400).json({ code: 'INVALID_AUTH_SESSION' }); return; }
    const redirectUrl = channel === 'feishu' ? (session as RegistrationSession).qrUrl : (session as { qrUrl: string }).qrUrl;
    let host: string;
    try {
      const url = new URL(redirectUrl);
      if (url.protocol !== 'https:') throw new Error('AUTH_URL_INSECURE');
      host = url.hostname;
    }
    catch { res.status(503).json({ code: 'AUTH_URL_INVALID' }); return; }
    const allowed = channel === 'feishu' ? ['open.feishu.cn', 'open.larksuite.com', 'accounts.feishu.cn', 'accounts.larksuite.com'] : ['liteapp.weixin.qq.com'];
    if (!allowed.includes(host)) { res.status(503).json({ code: 'AUTH_URL_INVALID' }); return; }
    entry.channel = channel;
    entry.deviceCode = deviceCode;
    res.json(channel === 'weixin'
      ? { ok: true, qrImageUrl: `/onboard/portal/${encodeURIComponent(req.params.entryId)}/weixin-qr.png` }
      : { ok: true, redirectUrl });
  });

  app.post('/onboard/portal/:entryId/verify', async (req, res) => {
    const entry = portalEntry(req.params.entryId);
    if (!entry || entry.channel !== 'weixin' || !entry.deviceCode) { res.status(404).json({ code: 'SESSION_NOT_FOUND' }); return; }
    const code = String(req.body?.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) { res.status(400).json({ code: 'INVALID_CODE' }); return; }
    try {
      const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(entry.deviceCode)}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {}) },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(5000),
      });
      res.status(response.status).json(await response.json());
    } catch { res.status(503).json({ code: 'VERIFY_UNAVAILABLE' }); }
  });

  app.post('/onboard/portal/:entryId/cancel', async (req, res) => {
    const entry = portalEntries.get(req.params.entryId);
    if (!entry) { res.json({ ok: true }); return; }
    portalEntries.delete(req.params.entryId);
    if (entry.channel === 'feishu' && entry.deviceCode) {
      const session = sessions.get(entry.deviceCode);
      if (session && session.status !== 'completed') cancelRegistration(sessions, entry.deviceCode);
    } else if (entry.channel === 'weixin' && entry.deviceCode && weixinSessions.delete(entry.deviceCode)) {
      try {
        await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(entry.deviceCode)}`, {
          method: 'DELETE',
          headers: config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {},
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* Manager sessions expire even if cancellation is unavailable. */ }
    }
    res.json({ ok: true });
  });

  // WeChat portal scan: the manager keeps the iLink poll and only creates an
  // Elastic tenant after the phone confirms the scan.
  app.post('/onboard/weixin/start', onboardingRateLimit(5, 60_000), async (req, res) => {
    try {
      const template = await selectSignupTemplate(config, req.body?.templateId);
      const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/portal-login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {}),
        },
        body: JSON.stringify({ templateId: template.id, templateVersion: template.version }),
        signal: AbortSignal.timeout(22_000),
      });
      if (!response.ok) throw new Error(`WEIXIN_LOGIN_${response.status}`);
      const session = await response.json() as { sessionId: string; qrImage: string; expiresIn: number };
      if (!session.sessionId || !session.qrImage) throw new Error('WEIXIN_QR_INVALID');
      weixinSessions.set(session.sessionId, { startedAt: Date.now(), templateId: template.id, qrUrl: session.qrImage });
      res.json({
        ok: true,
        deviceCode: session.sessionId,
        qrDataUri: await QRCode.toDataURL(session.qrImage, { width: 300, margin: 1 }),
        expireIn: session.expiresIn,
        templateId: template.id,
        templateVersion: template.version,
      });
    } catch (error) {
      console.error('[weixin-onboard] start failed', error);
      res.status(503).json({ code: 'WEIXIN_LOGIN_UNAVAILABLE', message: '微信扫码暂时不可用，请稍后重试' });
    }
  });

  app.get('/onboard/weixin/status/:sessionId', async (req, res) => {
    if (!weixinSessions.has(req.params.sessionId)) {
      res.status(404).json({ code: 'SESSION_NOT_FOUND' });
      return;
    }
    try {
      const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(req.params.sessionId)}`, {
        headers: config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`WEIXIN_STATUS_${response.status}`);
      const data = await response.json();
      res.json(data);
    } catch {
      res.status(503).json({ code: 'WEIXIN_STATUS_UNAVAILABLE' });
    }
  });

  app.post('/onboard/weixin/verify/:sessionId', async (req, res) => {
    if (!weixinSessions.has(req.params.sessionId)) {
      res.status(404).json({ code: 'SESSION_NOT_FOUND' });
      return;
    }
    const code = String(req.body?.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      res.status(400).json({ code: 'INVALID_CODE' });
      return;
    }
    try {
      const response = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(req.params.sessionId)}/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {}),
        },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(5000),
      });
      res.status(response.status).json(await response.json());
    } catch {
      res.status(503).json({ code: 'WEIXIN_VERIFY_UNAVAILABLE' });
    }
  });

  app.post('/onboard/weixin/cancel', async (req, res) => {
    const sessionId = String(req.body?.deviceCode || '');
    if (!weixinSessions.delete(sessionId)) {
      res.status(404).json({ code: 'SESSION_NOT_FOUND' });
      return;
    }
    try {
      await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/channels/weixin/login/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: config.provisioningApiToken ? { authorization: `Bearer ${config.provisioningApiToken}` } : {},
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* The manager session also expires automatically. */ }
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════
  // 入驻页面（HTML + JSON）
  // 正式流程：页面展示二维码 → 飞书扫码 → registerApp 自动创建 Bot
  // 内测兜底：填公司名/邮箱 → 点「内测确认」→ 走通完整链路
  // ═══════════════════════════════════════════════════════════

  app.get('/onboard', (req: Request, res: Response) => {
    const ua = req.headers['user-agent'] || '';
    const platform = detectPlatform(ua);

    // Feishu app in-app access → start registration and return JSON
    if (platform === 'feishu') {
      handleFeishuJsonOnboard(req, res, config);
      return;
    }

    // DingTalk in-app → show guide page (no marketplace needed)
    if (platform === 'dingtalk') {
      res.type('html').send(DINGTALK_ONBOARD_HTML);
      return;
    }

    // WeCom in-app → show coming-soon page (needs marketplace listing)
    if (platform === 'wecom') {
      res.type('html').send(WECOM_ONBOARD_HTML);
      return;
    }

    // Browser access → HTML page with QR code for Feishu scan
    res.type('html').send(ONBOARD_HTML);
  });

  // ═══════════════════════════════════════════════════════════
  // 飞书设备授权 — 启动入驻（生成二维码）
  // POST /onboard/feishu/start
  // NB8 FIX: rate limit to prevent abuse
  // ═══════════════════════════════════════════════════════════
  app.post('/onboard/feishu/start', onboardingRateLimit(5, 60_000), async (req: Request, res: Response) => {
    try {
      const template = await selectSignupTemplate(config, req.body?.templateId);
      const session = await startFeishuRegistration(async (registeredSession: RegistrationSession) => {
        // Orchestrate tenant creation after registration completes
        const result = await orchestrateOnboarding(registeredSession, {
          provisioningServiceUrl: config.provisioningServiceUrl,
          provisioningApiToken: config.provisioningApiToken,
          baseUrl: config.baseUrl,
        });

        if (!result.ok) {
          registeredSession.status = 'failed';
          registeredSession.error = result.error || 'Orchestration failed';
          registeredSession.progress = 0;
          console.error(`[onboarding] FAILED: ${registeredSession.error}`);
        } else {
          console.log(`[onboarding] SUCCESS: tenant=${result.tenantId}, webhook=${result.botWebhookUrl}`);
          // Store tenant credentials for webhook auto-reply
          if (result.tenantId && result.appId && result.tenantAccessToken) {
            tenantCredentials.set(result.tenantId, {
              appId: result.appId,
              tenantAccessToken: result.tenantAccessToken,
            });
            console.log(`[onboarding] stored credentials for tenant ${result.tenantId}`);
          } else {
            console.warn(`[onboarding] missing credentials: tenantId=${!!result.tenantId}, appId=${!!result.appId}, token=${!!result.tenantAccessToken}`);
          }
        }
      }, template);

      // Wait for begin() to complete and deviceCode to be set
      for (let i = 0; i < 50; i++) {
        if (session.deviceCode) break;
        await new Promise(r => setTimeout(r, 200));
      }

      if (!session.deviceCode) {
        throw new Error('Failed to get device code from Feishu');
      }

      // Store session NOW (after deviceCode is known)
      sessions.set(session.deviceCode, session);
      console.log(`[session] stored: ${session.deviceCode.slice(0, 20)}...`);

      // Wait another tick for begin response to fully parse
      await new Promise(r => setTimeout(r, 300));

      // Generate QR code as data URI (no external dependency)
      let qrDataUri = '';
      if (session.qrUrl) {
        try {
          qrDataUri = await QRCode.toDataURL(session.qrUrl, { width: 300, margin: 1 });
        } catch (e) {
          console.error('QR generation failed:', e);
        }
      }

      res.json({
        ok: true,
        deviceCode: session.deviceCode,
        qrUrl: session.qrUrl,
        qrDataUri,
        expireIn: session.expireIn,
        status: session.status,
        progress: session.progress,
        templateId: session.templateId,
        templateVersion: session.templateVersion,
      });
    } catch (err: any) {
      console.error('start registration error:', err);
      res.status(err.message === 'TEMPLATE_NOT_AVAILABLE' ? 400 : 503).json({ code: err.message === 'TEMPLATE_NOT_AVAILABLE' ? 'TEMPLATE_NOT_AVAILABLE' : 'REGISTRATION_UNAVAILABLE', message: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 飞书设备授权 — 轮询入驻状态
  // GET /onboard/feishu/status/:deviceCode
  // ═══════════════════════════════════════════════════════════
  app.get('/onboard/feishu/status/:deviceCode', (req: Request, res: Response) => {
    const { deviceCode } = req.params;
    const session = sessions.get(deviceCode);

    if (!session) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found or expired' });
      return;
    }

    const statusInfo = pollRegistrationStatus(session);
    const result = getRegistrationResult(session);

    res.json({
      ok: true,
      deviceCode: session.deviceCode,
      qrUrl: session.qrUrl,
      status: session.status,
      templateId: session.templateId,
      templateVersion: session.templateVersion,
      progress: statusInfo.progress,
      message: statusInfo.message,
      result: session.status === 'completed' ? {
        tenantId: result.tenantId,
        appId: result.appId,
        webhookUrl: result.webhookUrl,
      } : undefined,
      error: session.error || undefined,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 飞书设备授权 — 取消入驻
  // POST /onboard/cancel
  // ═══════════════════════════════════════════════════════════
  app.post('/onboard/cancel', (req: Request, res: Response) => {
    const { deviceCode } = req.body;
    if (!deviceCode) {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'deviceCode is required' });
      return;
    }

    const { ok } = cancelRegistration(sessions, deviceCode);
    res.json({ ok });
  });

  // ═══════════════════════════════════════════════════════════
  // GET /onboard/status — compatible alias (query param) + debug
  // ═══════════════════════════════════════════════════════════
  app.get('/onboard/status', (req: Request, res: Response) => {
    const deviceCode = req.query.deviceCode as string;
    if (!deviceCode) {
      // No deviceCode: list all active session statuses for debug
      const list: any[] = [];
      sessions.forEach((s, key) => {
        list.push({
          deviceCode: key.slice(0, 30) + '...',
          status: s.status,
          progress: s.progress,
          error: s.error || null,
          hasAppId: !!s.appId,
          tenantId: s.tenantId || null,
          age: Math.round((Date.now() - s.startedAt.getTime()) / 1000) + 's',
        });
      });
      res.json({ ok: true, total: list.length, sessions: list });
      return;
    }

    const session = sessions.get(deviceCode);
    if (!session) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found or expired' });
      return;
    }

    const statusInfo = pollRegistrationStatus(session);
    res.json({
      ok: true,
      deviceCode,
      status: session.status,
      progress: statusInfo.progress,
      message: statusInfo.message,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 对内测试：跳过 registerApp，直接创建租户
  // POST /onboard/mock-confirm
  // ═══════════════════════════════════════════════════════════
  app.post('/onboard/mock-confirm', onboardingRateLimit(3, 60_000), async (req: Request, res: Response) => {
    try {
      const { companyName, contactEmail, planTier } = req.body;
      if (!companyName || !contactEmail) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'companyName and contactEmail are required' });
        return;
      }

      const provRes = await fetch(`${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, contactEmail, planTier: planTier || 'starter' }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!provRes.ok) {
        const err = await provRes.json().catch(() => ({}));
        res.status(502).json({ code: 'PROVISIONING_FAILED', message: err.message || 'Provisioning failed' });
        return;
      }

      const provBody = await provRes.json();
      const tenantId = provBody.tenant?.tenantId;
      const botWebhookUrl = `${config.baseUrl}/v1/agent/${tenantId}/webhook`;

      res.json({
        ok: true,
        tenantId,
        botWebhookUrl,
        appId: 'dealclaw-internal-test',
        welcomeMessage: `🎉 Hi ${companyName}！DealClaw AI 销售助手已就绪！\n\n✅ 专属 Agent 已创建\n🆔 租户 ID: ${tenantId}\n🔗 Webhook: ${botWebhookUrl}`,
      });
    } catch (err: any) {
      console.error('Mock confirm error:', err);
      res.status(500).json({ code: 'INTERNAL', message: err.message });
    }
  });

  // 钉钉 / 企微回调（远期）
  app.get('/onboard/dingtalk/callback', (req, res) => {
    res.json({ platform: 'dingtalk', action: 'exchange_code', code: req.query.code });
  });

  app.get('/onboard/wecom/callback', (req, res) => {
    res.json({ platform: 'wecom', action: 'exchange_code', code: req.query.code });
  });

  // ═══════════════════════════════════════════════════════════
  // Bot Webhook — 接收飞书事件推送
  // POST /v1/agent/:tenantId/webhook
  // ═══════════════════════════════════════════════════════════
  app.post('/v1/agent/:tenantId/webhook', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const body = req.body;

    console.log(`[webhook:${tenantId}]`, JSON.stringify(body).slice(0, 300));

    // Feishu URL verification challenge
    if (body?.type === 'url_verification') {
      const challenge = body?.challenge || body?.token;
      console.log(`[webhook:${tenantId}] URL verification, challenge:`, challenge);
      res.json({ challenge });
      return;
    }

    // Feishu event callback
    if (body?.header?.event_type) {
      const eventType = body.header.event_type;
      console.log(`[webhook:${tenantId}] event: ${eventType}`);

      // Handle message events — send auto-reply
      if (eventType === 'im.message.receive_v1' && body?.event?.message) {
        const msg = body.event.message;
        const msgType = msg.msg_type;
        const msgId = msg.message_id;
        console.log(`[webhook:${tenantId}] message: ${msgType}`);

        // Auto-reply to any text message
        const creds = tenantCredentials.get(tenantId);
        if (creds && msgId) {
          // Fire-and-forget reply (don't block webhook response)
          sendBotReply(creds.tenantAccessToken, msgId, `👋 收到！我是 DealClaw AI 销售助手。\n租户: ${tenantId}\n你说: ${getMsgPreview(msg)}`)
            .catch(e => console.warn('[webhook] reply error:', e.message));
        }
      }
    }

    // Always respond 200 to acknowledge receipt
    res.json({ code: 0 });
  });

  // ═══════════════════════════════════════════════════════════
  // Internal notify relay — ops-agent delivers lifecycle notifications here
  // POST /internal/v1/notify   (Bearer INTERNAL_API_TOKEN)
  // Body: { tenantId, channel, notificationType?, dedupKey?, message }
  // ═══════════════════════════════════════════════════════════
  app.post('/internal/v1/notify', async (req: Request, res: Response) => {
    if (!config.internalApiToken) {
      res.status(503).json({ code: 'NOT_CONFIGURED', message: 'INTERNAL_API_TOKEN is not configured' });
      return;
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${config.internalApiToken}`) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' });
      return;
    }

    const { tenantId, channel, notificationType, dedupKey, message } = (req.body ?? {}) as Partial<NotifyPayload>;

    if (!tenantId || typeof tenantId !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'tenantId is required' });
      return;
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required' });
      return;
    }
    const safeChannel = channel === 'email' || channel === 'all' ? channel : 'bot';

    try {
      const result = await relayNotification(config, {
        tenantId,
        channel: safeChannel,
        notificationType,
        dedupKey,
        message: message.slice(0, 4000),
      });
      console.log(JSON.stringify({
        level: result.ok ? 'info' : 'warn',
        action: 'notify-relay',
        tenantId,
        notificationType: notificationType || '-',
        ok: result.ok,
        delivered: result.delivered,
        skipped: result.skipped,
        reason: result.reason,
        error: result.error,
      }));
      res.json(result);
    } catch (err: any) {
      console.error('[notify-relay] unexpected error:', err);
      res.status(500).json({ ok: false, delivered: [], skipped: [], error: err.message });
    }
  });

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));

  // ═══════════════════════════════════════════════════════════
  // Helper: send auto-reply via Feishu Bot API
  // ═══════════════════════════════════════════════════════════
  async function sendBotReply(accessToken: string, msgId: string, text: string) {
    try {
      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          content: JSON.stringify({ text }),
          msg_type: 'text',
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      console.warn('[webhook] send reply failed:', err.message);
    }
  }

  function getMsgPreview(msg: any): string {
    try {
      return JSON.parse(msg.content || '{}').text || msg.msg_type || '...';
    } catch {
      return '...';
    }
  }

  // Expose tenantCredentials for orchestrator to use
  (app as any).tenantCredentials = tenantCredentials;

  return app;
}

// ═══════════════════════════════════════════════════════════
// Internal: Feishu in-app JSON onboarding
// ═══════════════════════════════════════════════════════════

async function handleFeishuJsonOnboard(
  req: Request,
  res: Response,
  config: ReturnType<typeof loadConfig>,
) {
  try {
    const template = await selectSignupTemplate(config, req.query.templateId);
    const session = await startFeishuRegistration(async (registeredSession: RegistrationSession) => {
      const result = await orchestrateOnboarding(registeredSession, {
        provisioningServiceUrl: config.provisioningServiceUrl,
        provisioningApiToken: config.provisioningApiToken,
        baseUrl: config.baseUrl,
      });
      if (!result.ok) {
        registeredSession.status = 'failed';
        registeredSession.error = result.error || 'Orchestration failed';
        registeredSession.progress = 0;
      }
    }, template);

    // Wait for begin() to complete
    for (let i = 0; i < 50; i++) {
      if (session.deviceCode) break;
      await new Promise(r => setTimeout(r, 200));
    }

    if (!session.deviceCode) {
      throw new Error('Failed to get device code from Feishu');
    }

    // Note: this path doesn't use sessions map (one-shot JSON response)

    res.json({
      ok: true,
      platform: 'feishu',
      deviceCode: session.deviceCode,
      qrUrl: session.qrUrl,
      expireIn: session.expireIn,
      status: session.status,
      progress: session.progress,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      platform: 'feishu',
      status: 'failed',
      message: err.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 入驻 HTML 页面
// 流程：打开页面 → 点击「开始入驻」→ 获取真实二维码 → 飞书扫码
//       → 页面自动轮询状态 → 入驻完成展示租户信息
// ═══════════════════════════════════════════════════════════
