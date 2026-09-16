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

// NB8 FIX: Simple in-memory rate limiter for onboarding endpoints
const onboardRateLimits = new Map<string, { count: number; resetAt: number }>();
function onboardingRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
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
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ═══════════════════════════════════════════════════════════
  // In-memory session store (per-process, cleared on restart)
  // In production, replace with Redis/DB-backed store.
  // ═══════════════════════════════════════════════════════════
  const sessions = new Map<string, RegistrationSession>();

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
  }, 5 * 60 * 1000);

  // ═══════════════════════════════════════════════════════════
  // In-memory tenant credential store
  // In production: stored in DB, loaded by tenant's own Agent pod.
  // ═══════════════════════════════════════════════════════════
  const tenantCredentials = new Map<string, { appId: string; tenantAccessToken: string }>();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'central-gateway' });
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
  app.post('/onboard/feishu/start', onboardingRateLimit(5, 60_000), async (_req: Request, res: Response) => {
    try {
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
      });

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
      });
    } catch (err: any) {
      console.error('start registration error:', err);
      res.status(500).json({ code: 'INTERNAL', message: err.message });
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
    });

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


