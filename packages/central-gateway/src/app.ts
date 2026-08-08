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
import { DINGTALK_ONBOARD_HTML, WECOM_ONBOARD_HTML } from './services/platform-onboarding.js';

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
          agentUrl: config.agentUrl,
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
        agentUrl: config.agentUrl,
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

const ONBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>DealClaw — AI 销售助手入驻</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
    min-height: 100vh; display: flex; justify-content: center; align-items: center;
    padding: 20px; color: #e0e0e0;
  }
  .card {
    background: rgba(255,255,255,0.06); backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 20px;
    padding: 36px 28px; max-width: 420px; width: 100%;
    box-shadow: 0 8px 40px rgba(0,0,0,0.4);
  }
  .logo { text-align: center; margin-bottom: 24px; }
  .logo h1 { font-size: 28px; background: linear-gradient(135deg, #6366f1, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .logo p { font-size: 13px; color: #888; margin-top: 4px; }
  .qr-section { text-align: center; margin: 20px 0; padding: 20px; background: #fff; border-radius: 16px; min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .qr-section img { width: 200px; height: 200px; }
  .qr-section .qr-placeholder { color: #999; font-size: 14px; }
  .qr-section .qr-timer { color: #666; font-size: 12px; margin-top: 8px; }
  .qr-section .qr-status { color: #333; font-size: 13px; margin-top: 6px; }
  .progress-bar { width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin-top: 12px; overflow: hidden; display: none; }
  .progress-bar.active { display: block; }
  .progress-bar .fill { height: 100%; background: linear-gradient(135deg, #6366f1, #8b5cf6); transition: width 0.5s ease; border-radius: 2px; width: 0%; }
  .divider { display: flex; align-items: center; margin: 24px 0; color: #666; font-size: 12px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.15); }
  .divider span { padding: 0 12px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 13px; color: #aaa; margin-bottom: 4px; }
  .field input, .field select {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.05); color: #e0e0e0; font-size: 15px; outline: none;
  }
  .field input:focus, .field select:focus { border-color: #6366f1; }
  button {
    width: 100%; padding: 12px; border-radius: 12px; border: none;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff; font-size: 16px; font-weight: 600; cursor: pointer;
    margin-top: 8px; transition: opacity 0.2s;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: rgba(255,255,255,0.1); color: #aaa; margin-top: 6px; font-size: 13px; }
  button.secondary:hover { background: rgba(255,255,255,0.15); }
  .result { margin-top: 16px; padding: 14px; border-radius: 12px; font-size: 14px; display: none; }
  .result.success { display: block; background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); }
  .result.error { display: block; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); }
  .result.info { display: block; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; background: rgba(99,102,241,0.2); color: #818cf8; margin-bottom: 12px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>DealClaw</h1>
    <p>AI 外贸销售助手 · 扫码即用</p>
  </div>

  <!-- ====== QR Flow (default) ====== -->
  <div id="qrFlow">
    <div class="qr-section" id="qrBox">
      <div class="qr-placeholder" id="qrPlaceholder">
        <p style="font-size:48px;margin-bottom:8px;">📱</p>
        <p>点击下方按钮</p>
        <p>生成专属入驻二维码</p>
      </div>
      <img id="qrImage" src="" alt="飞书入驻二维码" style="display:none;" width="200" height="200">
      <div class="qr-timer" id="qrTimer" style="display:none;"></div>
      <div class="qr-status" id="qrStatus"></div>
    </div>
    <div class="progress-bar" id="progressBar">
      <div class="fill" id="progressFill"></div>
    </div>

    <button id="startBtn" onclick="startOnboarding()">🚀 开始入驻 · 飞书扫码</button>
    <button id="cancelBtn" class="secondary hidden" onclick="cancelOnboarding()">取消入驻</button>
    <button id="retryBtn" class="secondary hidden" onclick="resetFlow()">🔄 重新开始</button>
  </div>

  <div class="result" id="result"></div>

  <div class="divider"><span>或使用内测模式</span></div>

  <!-- ====== Mock Flow (internal test) ====== -->
  <div id="mockFlow">
    <span class="badge">🔧 内测模式</span>

    <div class="field">
      <label>公司名称 *</label>
      <input id="companyName" type="text" placeholder="如：杭州奥创天下科技有限公司">
    </div>
    <div class="field">
      <label>联系邮箱 *</label>
      <input id="contactEmail" type="email" placeholder="your@company.com">
    </div>
    <div class="field">
      <label>套餐</label>
      <select id="planTier">
        <option value="starter">Starter（免费试用）</option>
        <option value="pro">Pro</option>
        <option value="enterprise">Enterprise</option>
      </select>
    </div>

    <button id="mockBtn" onclick="handleMockSubmit()">🚀 内测确认 · 立即开通</button>
  </div>
</div>

<script>
let currentDeviceCode = null;
let pollInterval = null;
let expireTimer = null;
let expireAt = null;

// ══════════ QR Flow ══════════

async function startOnboarding() {
  const btn = document.getElementById('startBtn');
  const result = document.getElementById('result');
  const qrPlaceholder = document.getElementById('qrPlaceholder');
  const qrImage = document.getElementById('qrImage');
  const qrTimer = document.getElementById('qrTimer');
  const qrStatus = document.getElementById('qrStatus');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const cancelBtn = document.getElementById('cancelBtn');
  const retryBtn = document.getElementById('retryBtn');

  btn.disabled = true;
  btn.textContent = '正在生成二维码...';
  result.className = 'result';
  result.style.display = 'none';

  try {
    const res = await fetch('/onboard/feishu/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.message || '启动失败');
    }

    currentDeviceCode = data.deviceCode;

    // Show QR code
    qrPlaceholder.style.display = 'none';
    qrImage.src = data.qrDataUri || generateQRCode(data.qrUrl);
    qrImage.style.display = 'block';
    qrStatus.textContent = '请用飞书 App 扫描二维码';
    qrStatus.style.color = '#333';

    // Show timer
    expireAt = Date.now() + data.expireIn * 1000;
    qrTimer.style.display = 'block';
    updateTimer();

    // Show progress
    progressBar.classList.add('active');
    progressFill.style.width = '5%';

    btn.textContent = '等待扫码中...';
    cancelBtn.classList.remove('hidden');
    retryBtn.classList.add('hidden');

    // Start polling
    pollInterval = setInterval(pollStatus, 2000);
    expireTimer = setInterval(updateTimer, 1000);

  } catch (err) {
    result.className = 'result error';
    result.style.display = 'block';
    result.textContent = '启动失败: ' + err.message;
    btn.disabled = false;
    btn.textContent = '🚀 开始入驻 · 飞书扫码';
  }
}

function updateTimer() {
  const qrTimer = document.getElementById('qrTimer');
  if (!qrTimer || !expireAt) return;

  const remaining = Math.max(0, Math.ceil((expireAt - Date.now()) / 1000));
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  qrTimer.textContent = '二维码有效期: ' + min + ':' + String(sec).padStart(2, '0');

  if (remaining <= 0) {
    clearInterval(expireTimer);
    qrTimer.textContent = '二维码已过期';
    onRegistrationFailed('二维码已过期，请重新生成');
  }
}

async function pollStatus() {
  if (!currentDeviceCode) return;

  try {
    const res = await fetch('/onboard/feishu/status/' + currentDeviceCode);
    const data = await res.json();
    const progressFill = document.getElementById('progressFill');
    const qrStatus = document.getElementById('qrStatus');
    const result = document.getElementById('result');
    const btn = document.getElementById('startBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const retryBtn = document.getElementById('retryBtn');

    progressFill.style.width = data.progress + '%';

    if (data.status === 'provisioning') {
      qrStatus.textContent = '应用创建成功，正在为你分配专属资源...';
      btn.textContent = '部署中...';
    } else if (data.status === 'completed') {
      // Done!
      clearInterval(pollInterval);
      clearInterval(expireTimer);
      progressFill.style.width = '100%';
      qrStatus.textContent = '✅ 入驻完成！';

      result.className = 'result success';
      result.style.display = 'block';
      if (data.result) {
        result.innerHTML = '<strong>✅ 入驻成功！</strong><br><br>' +
          '租户 ID: <code>' + data.result.tenantId + '</code><br>' +
          'App ID: <code>' + data.result.appId + '</code><br>' +
          'Webhook: <code>' + data.result.webhookUrl + '</code>';
      } else {
        result.textContent = '入驻完成！即将跳转...';
      }

      btn.textContent = '✅ 入驻完成';
      btn.disabled = true;
      cancelBtn.classList.add('hidden');
      retryBtn.classList.remove('hidden');

      // Hide QR
      document.getElementById('qrImage').style.display = 'none';
      document.getElementById('qrTimer').style.display = 'none';
      document.getElementById('progressBar').classList.remove('active');

    } else if (data.status === 'failed' || data.status === 'expired' || data.status === 'cancelled') {
      onRegistrationFailed(data.message || '入驻失败');
    }
  } catch (err) {
    // silent retry on poll errors
    console.error('Poll error:', err);
  }
}

function onRegistrationFailed(msg) {
  clearInterval(pollInterval);
  clearInterval(expireTimer);

  const result = document.getElementById('result');
  const btn = document.getElementById('startBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const retryBtn = document.getElementById('retryBtn');
  const progressBar = document.getElementById('progressBar');

  result.className = 'result error';
    result.style.display = 'block';
  result.textContent = msg;

  btn.textContent = '入驻未完成';
  btn.disabled = true;
  cancelBtn.classList.add('hidden');
  retryBtn.classList.remove('hidden');
  progressBar.classList.remove('active');
  document.getElementById('qrTimer').style.display = 'none';
}

function cancelOnboarding() {
  if (!currentDeviceCode) return;

  fetch('/onboard/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode: currentDeviceCode }),
  }).catch(() => {});

  clearInterval(pollInterval);
  clearInterval(expireTimer);

  document.getElementById('qrStatus').textContent = '已取消';
  document.getElementById('qrStatus').style.color = '#999';
  document.getElementById('startBtn').disabled = false;
  document.getElementById('startBtn').textContent = '🚀 开始入驻 · 飞书扫码';
  document.getElementById('cancelBtn').classList.add('hidden');
  document.getElementById('progressBar').classList.remove('active');
  document.getElementById('qrImage').style.display = 'none';
  document.getElementById('qrPlaceholder').style.display = '';
  document.getElementById('qrTimer').style.display = 'none';

  currentDeviceCode = null;
}

function resetFlow() {
  clearInterval(pollInterval);
  clearInterval(expireTimer);
  currentDeviceCode = null;

  document.getElementById('result').className = 'result';
  document.getElementById('result').style.display = 'none';
  document.getElementById('startBtn').disabled = false;
  document.getElementById('startBtn').textContent = '🚀 开始入驻 · 飞书扫码';
  document.getElementById('cancelBtn').classList.add('hidden');
  document.getElementById('retryBtn').classList.add('hidden');
  document.getElementById('progressBar').classList.remove('active');
  document.getElementById('qrImage').style.display = 'none';
  document.getElementById('qrPlaceholder').style.display = '';
  document.getElementById('qrTimer').style.display = 'none';
  document.getElementById('qrStatus').textContent = '';
  document.getElementById('progressFill').style.width = '0%';
}

// ══════════ QR Code Generation ══════════

function generateQRCode(url) {
  // Use Google Charts API to generate QR code from the device authorization URL
  return 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
}

// ══════════ Mock Flow ══════════

async function handleMockSubmit() {
  const btn = document.getElementById('mockBtn');
  const result = document.getElementById('result');
  const companyName = document.getElementById('companyName').value.trim();
  const contactEmail = document.getElementById('contactEmail').value.trim();
  const planTier = document.getElementById('planTier').value;

  if (!companyName || !contactEmail) {
    result.className = 'result error';
    result.style.display = 'block';
    result.textContent = '请填写公司名称和联系邮箱';
    return;
  }

  btn.disabled = true;
  btn.textContent = '正在开通...';
  result.className = 'result';
  result.style.display = 'none';

  try {
    const res = await fetch('/onboard/mock-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, contactEmail, planTier }),
    });
    const data = await res.json();
    if (data.ok) {
      result.className = 'result success';
      result.style.display = 'block';
      result.innerHTML = '<strong>✅ 入驻成功！</strong><br><br>' +
        '租户 ID: <code>' + data.tenantId + '</code><br>' +
        'Webhook: <code>' + data.botWebhookUrl + '</code><br><br>' +
        '<small style="color:#888">' + data.welcomeMessage.replace(/\\n/g, '<br>') + '</small>';
    } else {
      throw new Error(data.message || '入驻失败');
    }
  } catch (err) {
    result.className = 'result error';
    result.style.display = 'block';
    result.textContent = '入驻失败: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 内测确认 · 立即开通';
  }
}
</script>
</body>
</html>`;
