import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { Readable } from 'node:stream';
import type { GatewayConfig } from './config.js';
import { auditMiddleware } from './middleware/audit.js';
import { identityMiddleware, initIdentityConfig } from './middleware/identity.js';
import { initPlanConfig, sceneMiddleware, setPlanConfig, sceneHeaders } from './middleware/scene.js';
import { agentLimiter, globalLimiter } from './middleware/ratelimit.js';
import { sendReply, extractAgentReplyText } from './services/feishu-reply.js';
import { registerLlmProxy } from './services/llm-proxy.js';
import { fetchCustomerBalance } from './services/balance-helpers.js';
import { GATEWAY_HEADERS, type GatewayError, type TenantContext } from './types/index.js';

// Shared service token for credits-ledger calls (optional).
function ledgerHeaders(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface BillingAccount {
  tenantId: string;
  accountId: string;
}

/** Resolved per-request billing account, or the gateway-level fallback. */
function billingAccountFor(req: Request, config: GatewayConfig): BillingAccount {
  const resolved = (req as Request & { billingAccount?: BillingAccount }).billingAccount;
  return resolved ?? { tenantId: config.tenantId, accountId: config.keyConfig.creditsAccountId };
}

export function createApp(config: GatewayConfig) {
  initIdentityConfig({
    tenantId: config.tenantId,
    platform: config.platform,
    allowedAppIds: config.allowedAppIds ?? [],
    botSecret: config.botSecret,
  });
  setPlanConfig(initPlanConfig(config.planTier));

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  // Health check MUST be registered before rate limiter to avoid
  // readiness probe getting 429 from globalLimiter (100 req/15min)
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'nexus-gateway', tenantId: config.tenantId });
  });

  // LLM egress proxy — MUST be registered before globalLimiter (LLM calls
  // follow the agent loop, not human pacing) and before the 1MB global JSON
  // parser (LLM contexts can exceed it; the proxy reads raw bodies itself).
  // Balance keyword / exhausted-balance interception lives here now — the
  // message-entry interception in the webhook path was removed.
  registerLlmProxy(app, config);

  app.use(globalLimiter);
  app.use(auditMiddleware);
  app.use(cors({ origin: false }));
  // NB6 FIX: Preserve raw request body for Feishu HMAC signature verification.
  // JSON.stringify(JSON.parse(buf)) can differ from original bytes (key order, escaping).
  app.use(express.json({
    limit: '1mb',
    verify: (req: any, _res, buf: Buffer) => {
      req.rawBody = buf;
    },
  }));

  /**
   * Balance query — for agent or programmatic use.
   * POST /v1/agent/balance
   */
  app.post('/v1/agent/balance', async (req: Request, res: Response) => {
    try {
      const accountId = req.body?.accountId || config.keyConfig?.creditsAccountId;
      if (!accountId || !config.creditsLedgerUrl) {
        res.status(400).json({ code: 'CONFIG_MISSING' });
        return;
      }
      const info = await fetchCustomerBalance(config.creditsLedgerUrl, accountId, config.creditsLedgerToken);
      if (!info) {
        res.status(404).json({ code: 'NOT_FOUND' });
        return;
      }
      res.json({ ok: true, balance: info });
    } catch (err: any) {
      res.status(502).json({ code: 'UPSTREAM_ERROR', message: err.message });
    }
  });

  /**
   * Profile writeback — the dealclaw-agent reports the company name the user
   * told it in conversation. Forwards to provisioning-service using the
   * gateway's OWN tenantId (authoritative, not request-controlled).
   * PATCH /v1/agent/profile
   */
  app.patch('/v1/agent/profile', async (req: Request, res: Response) => {
    try {
      const { companyName, contactEmail } = req.body ?? {};
      if (!config.provisioningServiceUrl) {
        res.status(503).json({ code: 'CONFIG_MISSING', message: 'provisioning service not configured' });
        return;
      }

      const upstream = await fetch(
        `${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants/${config.tenantId}/profile`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(config.provisioningApiToken ? { Authorization: `Bearer ${config.provisioningApiToken}` } : {}),
          },
          body: JSON.stringify({ companyName, contactEmail }),
          signal: AbortSignal.timeout(5_000),
        }
      );

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        console.warn(`[profile] writeback failed: HTTP ${upstream.status} ${errBody.slice(0, 200)}`);
        res.status(502).json({ code: 'UPSTREAM_ERROR', message: 'Failed to update profile' });
        return;
      }

      res.json({ ok: true });
    } catch (err: any) {
      console.error('[profile] writeback error:', err.message);
      res.status(502).json({ code: 'UPSTREAM_ERROR', message: err.message });
    }
  });

  /**
   * Webhook receiver for Feishu event subscriptions.
   * POST /v1/agent/:tenantId/webhook
   * Handles URL verification and forwards message events to dealclaw-agent.
   */
  app.post('/v1/agent/:tenantId/webhook', async (req: Request, res: Response) => {
    const body = req.body;
    console.log(`[webhook] event:`, JSON.stringify(body).slice(0, 300));

    // Feishu URL verification (challenge)
    if (body?.type === 'url_verification') {
      const challenge = body.challenge || '';
      console.log('[webhook] URL verification, challenge:', challenge);
      res.json({ challenge });
      return;
    }

    // Forward event to dealclaw-agent
    if (body?.header?.event_type) {
      try {
        const msgId = body?.event?.message?.message_id;
        if (!msgId) {
          console.log('[webhook] no message_id in event, skipping');
          res.json({ code: 0 });
          return;
        }

        // Balance keyword interception now lives in the LLM egress proxy
        // (services/llm-proxy.ts) — it sees every agent loop iteration and
        // also covers cron/proactive tasks that bypass this webhook path.

        const agentRes = await fetch(`${config.agentUrl.replace(/\/$/, '')}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [GATEWAY_HEADERS.TENANT_ID]: config.tenantId,
            [GATEWAY_HEADERS.USER_ID]: body?.event?.sender?.sender_id?.open_id || 'unknown',
            [GATEWAY_HEADERS.KEY_CONFIG_REF]: config.keyConfig.customerKeyRef,
            [GATEWAY_HEADERS.CREDITS_REMAINING]: '-1',
          },
          body: JSON.stringify({
            intent: { kind: 'chat' },
            event: body,
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (agentRes.ok) {
          // Parse agent response and reply to user via Feishu API
          const agentBody = await agentRes.text();
          console.log('[webhook] agent status:', agentRes.status, 'body_len:', agentBody.length);

          let parsed: unknown;
          try { parsed = JSON.parse(agentBody); } catch { parsed = { text: agentBody }; }

          const replyText = extractAgentReplyText(parsed);
          if (replyText && config.appId && config.appSecret) {
            const replyResult = await sendReply(config.appId, config.appSecret, msgId, replyText);
            console.log('[webhook] feishu reply:', replyResult.ok ? 'sent' : `failed(${replyResult.status})`);
          } else if (!replyText) {
            console.warn('[webhook] agent returned no reply text');
          } else {
            console.warn('[webhook] missing app credentials, cannot reply to Feishu');
          }
        } else {
          console.warn('[webhook] agent forward failed, status:', agentRes.status);
        }
      } catch (err: any) {
        console.warn('[webhook] agent forward failed:', err.message);
      }
    }

    res.json({ code: 0 });
  });

  app.post(
    '/v1/agent/execute',
    agentLimiter,
    identityMiddleware,
    attachKeyConfig(config),
    sceneMiddleware,
    creditsCheckMiddleware(config),
    async (req: Request, res: Response) => {
      const tenant = (req as Request & { tenantContext: TenantContext }).tenantContext;
      const creditsCheck = (req as Request & { creditsCheck: { remaining: number; required: number; accountId: string } }).creditsCheck;

      // Cache scene list (N2 FIX)
      const scenes = sceneHeaders(config.planTier);

      try {
        // B5 FIX: 30-second timeout on agent request
        const response = await fetch(`${config.agentUrl.replace(/\/$/, '')}/execute`, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'content-type': 'application/json',
            [GATEWAY_HEADERS.TENANT_ID]: tenant.tenantId,
            [GATEWAY_HEADERS.USER_ID]: tenant.userId,
            [GATEWAY_HEADERS.KEY_CONFIG_REF]: config.keyConfig.customerKeyRef,
            [GATEWAY_HEADERS.CREDITS_REMAINING]: String(creditsCheck.remaining),
            [GATEWAY_HEADERS.SCENE_UNLOCKED]: scenes,
            [GATEWAY_HEADERS.PLAN_TIER]: config.planTier,
          },
          body: JSON.stringify(req.body),
        });

        const body = await response.text();

        // Skill-level billing is owned by the dealclaw-billing plugin inside the
        // agent (estimate→settle). The gateway only performs a coarse balance
        // pre-check (creditsCheckMiddleware) and does NOT settle here to avoid
        // double-billing.

        res.status(response.status);
        res.type(response.headers.get('content-type') ?? 'application/json');
        res.send(body);
      } catch (err: any) {
        console.error('Agent forward failed:', err.code || err.message);
        res.status(502).json({ code: 'AGENT_UNREACHABLE', message: 'Agent service unavailable' });
      }
    },
  );

  /**
   * External conversation entry — internal call from provisioning-service
   * (authenticated with the shared PROVISIONING_API_TOKEN), NOT a Feishu
   * webhook. provisioning resolves the dlck_ apikey → tenant, then forwards
   * here. We bypass identityMiddleware (no Feishu open_id) and go straight
   * to the agent /execute.
   *
   * Billing model: chat intent is free at the gateway (CREDIT_COSTS.chat=0,
   * no pre-debit); the real token accounting happens in llm-proxy on the
   * LLM egress path, per the established "intercept at LLM call time" rule.
   *
   * POST /v1/external/chat
   *   headers: Authorization: Bearer <PROVISIONING_API_TOKEN>
   *            X-Chat-Session-Id / X-Chat-External-User-Id / X-Chat-Agent-Id
   *   body: { message: string }
   */
  app.post('/v1/external/chat', async (req: Request, res: Response) => {
    // ── service-token auth (internal only) ──
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!config.provisioningApiToken || token !== config.provisioningApiToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'invalid internal token' });
      return;
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'message is required' });
      return;
    }

    // The external caller's user id becomes the agent's session key input
    // (OpenClaw derives sessionKey from tenantId\0channel\0userId). Same
    // externalUserId across calls = same conversation thread.
    const externalUserId =
      (req.header('X-Chat-External-User-Id') || '').trim() || 'external';

    try {
      const response = await fetch(`${config.agentUrl.replace(/\/$/, '')}/execute`, {
        method: 'POST',
        signal: AbortSignal.timeout(config.externalChatTimeoutMs),
        headers: {
          'content-type': 'application/json',
          [GATEWAY_HEADERS.TENANT_ID]: config.tenantId,
          [GATEWAY_HEADERS.USER_ID]: externalUserId,
          [GATEWAY_HEADERS.KEY_CONFIG_REF]: config.keyConfig.customerKeyRef,
          [GATEWAY_HEADERS.CREDITS_REMAINING]: '-1',
          'X-DealClaw-Channel': 'web',
        },
        body: JSON.stringify({
          intent: { kind: 'chat', text: message },
          tenantId: config.tenantId,
        }),
      });

      const body = await response.text();
      res.status(response.status);
      res.type(response.headers.get('content-type') ?? 'application/json');
      res.send(body);
    } catch (err: any) {
      console.error('[external-chat] agent forward failed:', err.code || err.message);
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      res.status(timedOut ? 504 : 502).json({
        code: timedOut ? 'AGENT_TIMEOUT' : 'AGENT_UNREACHABLE',
        message: timedOut ? 'agent response timed out' : 'agent service unavailable',
      });
    }
  });

  /**
   * Streaming variant of /v1/external/chat — pipes the agent /execute/stream
   * SSE straight through to the provisioning caller (and onward to the
   * external client). Same auth/forward contract; only the response shape
   * differs (text/event-stream vs JSON).
   */
  app.post('/v1/external/chat/stream', async (req: Request, res: Response) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!config.provisioningApiToken || token !== config.provisioningApiToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'invalid internal token' });
      return;
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'message is required' });
      return;
    }
    const externalUserId =
      (req.header('X-Chat-External-User-Id') || '').trim() || 'external';

    try {
      const upstream = await fetch(`${config.agentUrl.replace(/\/$/, '')}/execute/stream`, {
        method: 'POST',
        signal: AbortSignal.timeout(config.externalChatStreamTimeoutMs),
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          [GATEWAY_HEADERS.TENANT_ID]: config.tenantId,
          [GATEWAY_HEADERS.USER_ID]: externalUserId,
          [GATEWAY_HEADERS.KEY_CONFIG_REF]: config.keyConfig.customerKeyRef,
          'X-DealClaw-Channel': 'web',
        },
        body: JSON.stringify({
          intent: { kind: 'chat', text: message },
          tenantId: config.tenantId,
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        res.status(upstream.status).type('application/json').send(errText || '{"code":"AGENT_ERROR"}');
        return;
      }

      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();

      const nodeStream = Readable.fromWeb(upstream.body as any);
      nodeStream.on('error', (err) => {
        console.error('[external-chat-stream] pipe error:', err.message);
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
      res.on('close', () => nodeStream.destroy());
    } catch (err: any) {
      console.error('[external-chat-stream] agent forward failed:', err.code || err.message);
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (!res.headersSent) {
        res.status(timedOut ? 504 : 502).json({
          code: timedOut ? 'AGENT_TIMEOUT' : 'AGENT_UNREACHABLE',
          message: timedOut ? 'agent stream timed out' : 'agent service unavailable',
        });
      } else {
        res.end();
      }
    }
  });

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' }));

  return app;
}

function attachKeyConfig(config: GatewayConfig) {
  return (req: Request, _res: Response, next: () => void) => {
    (req as Request & { keyConfig: typeof config.keyConfig }).keyConfig = config.keyConfig;
    next();
  };
}

/**
 * B3 FIX: Credits check via HTTP call to credits-ledger instead of in-memory Map
 */
function creditsCheckMiddleware(config: GatewayConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { accountId } = billingAccountFor(req, config);
    const intent = req.body?.intent;
    const cost = intent?.kind
      ? (CREDIT_COSTS[intent.kind] ?? DEFAULT_COST)
      : DEFAULT_COST;

    if (cost === 0) {
      (req as any).creditsCheck = { remaining: -1, required: 0, accountId };
      next();
      return;
    }

    try {
      const balanceResp = await fetch(
        `${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${accountId}/balance`,
        { signal: AbortSignal.timeout(3_000), headers: ledgerHeaders(config.creditsLedgerToken) }
      );

      if (!balanceResp.ok) {
        console.error('Credits balance check failed:', balanceResp.status);
        // NB7 FIX: fail-close by default — refuse request if credits ledger is down.
        // Allow fail-open only with explicit env var DEALCLAW_CREDITS_FAIL_OPEN=true (dev mode).
        if (process.env.DEALCLAW_CREDITS_FAIL_OPEN === 'true') {
          console.warn('[credits] FAIL-OPEN: credits-ledger returned', balanceResp.status, '— allowing request');
          (req as any).creditsCheck = { remaining: -1, required: cost, accountId };
          next();
          return;
        }
        res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Credits service temporarily unavailable. Please try again.' });
        return;
      }

      const { balance } = await balanceResp.json() as { balance: number };

      if (balance < cost) {
        const err: GatewayError = {
          code: 'INSUFFICIENT_CREDITS',
          message: `Insufficient credits: need ${cost} credits`,
          detail: `Account: ${accountId}`,
        };
        res.status(402).json(err);
        return;
      }

      (req as any).creditsCheck = { remaining: balance, required: cost, accountId };
      next();
    } catch (err: any) {
      console.error('Credits ledger unreachable:', err.code || err.message);
      // NB7 FIX: fail-close by default — refuse request if credits ledger is unreachable.
      // Allow fail-open only with explicit env var DEALCLAW_CREDITS_FAIL_OPEN=true (dev mode).
      if (process.env.DEALCLAW_CREDITS_FAIL_OPEN === 'true') {
        console.warn('[credits] FAIL-OPEN: credits-ledger unreachable — allowing request');
        (req as any).creditsCheck = { remaining: -1, required: cost, accountId };
        next();
        return;
      }
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Credits service temporarily unavailable. Please try again.' });
      return;
    }
  };
}

const DEFAULT_COST = 2000;
const CREDIT_COSTS: Record<string, number> = {
  chat: 0,
  command: 5000,
  query: 2000,
  action: 8000,
};
