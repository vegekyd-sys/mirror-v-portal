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
      const info = await fetchBalance(config.creditsLedgerUrl, accountId, config.creditsLedgerToken);
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

        // ── Balance query interception ──
        // If the user is asking about balance/credits/用量, reply directly
        // without consuming agent credits.
        const msgText = extractMessageText(body);
        if (msgText && isBalanceQuery(msgText) && config.creditsLedgerUrl && config.keyConfig?.creditsAccountId) {
          console.log('[webhook] balance query detected, responding directly');
          try {
            const balanceInfo = await fetchBalance(config.creditsLedgerUrl, config.keyConfig.creditsAccountId, config.creditsLedgerToken);
            if (balanceInfo && config.appId && config.appSecret) {
              const replyText = formatBalanceReply(balanceInfo);
              const replyResult = await sendReply(config.appId, config.appSecret, msgId, replyText);
              console.log('[webhook] balance reply:', replyResult.ok ? 'sent' : `failed(${replyResult.status})`);
            }
          } catch (balErr: any) {
            console.warn('[webhook] balance fetch failed:', balErr.message);
            // Fall through to agent
          }
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

// ── Balance query helpers (customer-facing) ──

/** Extract message text from a Feishu event body */
function extractMessageText(body: any): string | null {
  try {
    // Route 1: im.message.receive_v1
    const content = body?.event?.message?.content;
    if (typeof content === 'string') {
      const parsed = JSON.parse(content);
      if (parsed.text) return parsed.text.trim();
    }
    if (typeof content === 'object' && content?.text) {
      return String(content.text).trim();
    }
    // Route 2: direct text field
    if (body?.text) return String(body.text).trim();
    return null;
  } catch {
    if (typeof body?.event?.message?.content === 'string') {
      return body.event.message.content.trim();
    }
    return null;
  }
}

/** Check if the message is asking about balance/credits */
function isBalanceQuery(text: string): boolean {
  const patterns = [
    /^查余额$/, /^余额$/, /^我的余额$/, /^credit/i, /^credits/i,
    /查.*余额/, /看.*余额/, /还剩/, /剩余.*credit/i, /剩余.*额度/,
    /有多少.*credit/i, /用量/, /消耗/, /my balance/i,
  ];
  return patterns.some(p => p.test(text));
}

interface BalanceInfo {
  companyName: string;
  availableBalance: number;
  frozenCredits: number;
  lifetimeConsumed: number;
  planTier: string;
  planName: string;
  status: string;
  subscriptionEnd: string | null;
  liveConsumed?: number;
  shadowConsumed?: number;
}

async function fetchBalance(ledgerUrl: string, accountId: string, token?: string): Promise<BalanceInfo | null> {
  // Derive tenant ID from account ID (acct_<tenantId>)
  const tenantId = accountId.startsWith('acct_') ? accountId.slice(5) : accountId;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${ledgerUrl.replace(/\/$/, '')}/v1/admin/customers/${encodeURIComponent(tenantId)}`, {
    signal: AbortSignal.timeout(5_000),
    headers,
  });
  if (!res.ok) return null;
  return res.json() as Promise<BalanceInfo>;
}

function formatBalanceReply(info: BalanceInfo): string {
  const k = (n: number) => n ? `${(n / 1000).toFixed(1)}K` : '0';
  const statusEmoji = info.status === 'active' ? '✅' : info.status === 'suspended' ? '⏸️' : '🔴';
  const lines = [
    `💰 **${info.companyName || '账户'}** · ${statusEmoji} ${info.planName || info.planTier || ''}`,
    '',
    `可用余额：**${k(info.availableBalance)}** Credits`,
  ];
  if (info.frozenCredits > 0) {
    lines.push(`（其中冻结 ${k(info.frozenCredits)}：${info.subscriptionEnd ? '慧展权益预留' : '预留'}）`);
  }
  if (info.liveConsumed != null) {
    lines.push(`本月已用：${k(info.liveConsumed)}`);
  }
  if (info.shadowConsumed != null && info.shadowConsumed > 0) {
    lines.push(`内测消耗：${k(info.shadowConsumed)}（不计费）`);
  }
  if (info.subscriptionEnd) {
    const endDate = new Date(info.subscriptionEnd).toLocaleDateString('zh-CN');
    lines.push(`套餐到期：${endDate}`);
  }
  lines.push('', `📊 详情：https://43.156.232.2:8443/credit-info.html`);
  return lines.join('\n');
}
