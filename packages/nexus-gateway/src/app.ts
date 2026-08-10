import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import type { GatewayConfig } from './config.js';
import { auditMiddleware } from './middleware/audit.js';
import { identityMiddleware, initIdentityConfig } from './middleware/identity.js';
import { initPlanConfig, sceneMiddleware, setPlanConfig, sceneHeaders } from './middleware/scene.js';
import { agentLimiter, globalLimiter } from './middleware/ratelimit.js';
import { sendReply, extractAgentReplyText } from './services/feishu-reply.js';
import { GATEWAY_HEADERS, type GatewayError, type TenantContext } from './types/index.js';

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

        // B3 FIX: call credits-ledger API for debit instead of in-memory
        if (response.ok && creditsCheck.required > 0) {
          const idempotencyKey = `gw:${config.tenantId}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
          try {
            await fetch(
              `${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${creditsCheck.accountId}/debit`,
              {
                method: 'POST',
                signal: AbortSignal.timeout(5_000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  amount: creditsCheck.required,
                  reference: `req_${config.tenantId}_${Date.now()}`,
                  idempotencyKey,
                }),
              }
            );
          } catch (debitErr: any) {
            console.error('Credits debit failed after agent success:', debitErr.code || debitErr.message);
            // Log but don't block the response — credits correction can happen async
          }
        }

        res.status(response.status);
        res.type(response.headers.get('content-type') ?? 'application/json');
        res.send(body);
      } catch (err: any) {
        console.error('Agent forward failed:', err.code || err.message);
        res.status(502).json({ code: 'AGENT_UNREACHABLE', message: 'Agent service unavailable' });
      }
    },
  );

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
    const intent = req.body?.intent;
    const cost = intent?.kind
      ? (CREDIT_COSTS[intent.kind] ?? DEFAULT_COST)
      : DEFAULT_COST;

    if (cost === 0) {
      (req as any).creditsCheck = { remaining: -1, required: 0, accountId: config.keyConfig.creditsAccountId };
      next();
      return;
    }

    try {
      const balanceResp = await fetch(
        `${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${config.keyConfig.creditsAccountId}/balance`,
        { signal: AbortSignal.timeout(3_000) }
      );

      if (!balanceResp.ok) {
        console.error('Credits balance check failed:', balanceResp.status);
        // NB7 FIX: fail-close by default — refuse request if credits ledger is down.
        // Allow fail-open only with explicit env var DEALCLAW_CREDITS_FAIL_OPEN=true (dev mode).
        if (process.env.DEALCLAW_CREDITS_FAIL_OPEN === 'true') {
          console.warn('[credits] FAIL-OPEN: credits-ledger returned', balanceResp.status, '— allowing request');
          (req as any).creditsCheck = { remaining: -1, required: cost, accountId: config.keyConfig.creditsAccountId };
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
          detail: `Account: ${config.keyConfig.creditsAccountId}`,
        };
        res.status(402).json(err);
        return;
      }

      (req as any).creditsCheck = { remaining: balance, required: cost, accountId: config.keyConfig.creditsAccountId };
      next();
    } catch (err: any) {
      console.error('Credits ledger unreachable:', err.code || err.message);
      // NB7 FIX: fail-close by default — refuse request if credits ledger is unreachable.
      // Allow fail-open only with explicit env var DEALCLAW_CREDITS_FAIL_OPEN=true (dev mode).
      if (process.env.DEALCLAW_CREDITS_FAIL_OPEN === 'true') {
        console.warn('[credits] FAIL-OPEN: credits-ledger unreachable — allowing request');
        (req as any).creditsCheck = { remaining: -1, required: cost, accountId: config.keyConfig.creditsAccountId };
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
