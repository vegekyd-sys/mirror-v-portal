/**
 * External conversation endpoint — third-party HTTP access to the agent.
 *
 * POST /api/external/chat
 *
 * Auth chain (all in provisioning-service, the public control plane):
 *   1. Bearer dlck_ key → findValidChatApiKey (tenant-scoped, write access)
 *   2. IP allowlist (CIDR) — if the key has one
 *   3. Per-key rate limit (in-memory token bucket, rpm)
 *   4. Tenant status must be 'active'
 *   5. Forward to the tenant's nexus-gateway /v1/external/chat
 *
 * The gateway then does service-token auth + credits pre-check + forwards
 * to dealclaw-agent /execute. LLM billing happens in llm-proxy (per the
 * established "intercept at LLM call time" model — chat intent is free at
 * the gateway, tokens are accounted on the LLM egress path).
 *
 * NB: in-memory rate limiting is per-process. Under multiple replicas the
 * effective limit is ≈ rpm × replicas; a Redis-backed limiter is the v2
 * upgrade path when precision matters.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'node:stream';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import {
  findValidChatApiKey,
  touchChatApiKeyLastUsed,
  type ValidChatApiKey,
} from '../services/chat-api-keys.js';

/** Headers provisioning sets when forwarding to the tenant's gateway. */
const GATEWAY_FORWARD_HEADERS = {
  SESSION_ID: 'X-Chat-Session-Id',
  EXTERNAL_USER_ID: 'X-Chat-External-User-Id',
  AGENT_ID: 'X-Chat-Agent-Id',
} as const;

const MAX_MESSAGE_LEN = 8_000;

/**
 * Forward timeouts (ms). Agent runs are open-ended (long LLM chains, tool
 * loops, session-lane queueing behind compaction), so the non-stream forward
 * must outlive the gateway's own forward timeout — otherwise provisioning
 * aborts first and masks the gateway's AGENT_TIMEOUT error with a generic
 * GATEWAY_TIMEOUT. Defaults: gateway 300s / stream 600s, provisioning +30s
 * headroom so downstream error bodies can pass through.
 */
const CHAT_FORWARD_TIMEOUT_MS = Number(process.env.DEALCLAW_EXTERNAL_CHAT_TIMEOUT_MS ?? 330_000);
const CHAT_STREAM_FORWARD_TIMEOUT_MS = Number(
  process.env.DEALCLAW_EXTERNAL_CHAT_STREAM_TIMEOUT_MS ?? 630_000,
);

// ── in-memory per-key rate limiter ──

interface RateBucket {
  windowStart: number;
  count: number;
}
const rateBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;

function rateLimitAllows(keyId: string, rpm: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(keyId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    rateBuckets.set(keyId, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= rpm;
}

// ── IPv4 CIDR matching ──

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const mask = slash >= 0 ? parseInt(cidr.slice(slash + 1), 10) : 32;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (Number.isNaN(mask) || mask < 0 || mask > 32) return false;
  if (mask === 0) return true;
  const maskInt = mask === 32 ? 0xffffffff : ((0xffffffff << (32 - mask)) >>> 0);
  return (ipInt & maskInt) === (baseInt & maskInt);
}

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0]?.trim() : '';
  if (first) return first.replace(/^::ffff:/, '');
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// ── gateway address ──

function gatewayUrlForTenant(tenantId: string, k8sNamespace: string | null): string {
  // Mirrors admin-ops web-chat proxy: svc name carries the tenantId suffix,
  // namespace falls back to `dealclaw-<tenantId>`, no `.svc` (short intra-cluster DNS).
  const ns = k8sNamespace || `dealclaw-${tenantId}`;
  return `http://nexus-gateway-${tenantId}.${ns}:8080/v1/external/chat`;
}

interface ChatAuth {
  rec: ValidChatApiKey;
  k8sNamespace: string | null;
}

interface ChatBody {
  message: string;
  sessionId?: string;
  externalUserId?: string;
  agentId?: string;
}

function extractChatBody(req: Request, rec: ValidChatApiKey): ChatBody | null {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE_LEN) return null;
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : undefined;
  const externalUserId = typeof req.body?.externalUserId === 'string' ? req.body.externalUserId.trim() : undefined;
  // key-bound agent wins; request body agentId is a fallback.
  const agentId = rec.agentId || (typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : undefined);
  return { message, sessionId, externalUserId, agentId };
}

function forwardHeaders(body: ChatBody): Record<string, string> {
  return {
    [GATEWAY_FORWARD_HEADERS.SESSION_ID]: body.sessionId || '',
    [GATEWAY_FORWARD_HEADERS.EXTERNAL_USER_ID]: body.externalUserId || '',
    [GATEWAY_FORWARD_HEADERS.AGENT_ID]: body.agentId || '',
  };
}

export function createChatExternalRoutes(
  pool: pg.Pool,
  _config: ProvisioningConfig,
) {
  const router = Router();

  /**
   * Shared auth middleware — runs the full dlck_ chain (key → IP allowlist →
   * rate limit → tenant active) and attaches req.chatAuth = { rec, k8sNamespace }.
   * Both the JSON and the SSE endpoints mount this so they stay in lockstep.
   */
  const chatKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ── 1. Bearer dlck_ key ──
      const authHeader = req.headers.authorization ?? '';
      const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const rec = await findValidChatApiKey(pool, key);
      if (!rec) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'invalid or revoked API key' });
        return;
      }

      // ── 2. IP allowlist ──
      if (rec.ipAllowlist && rec.ipAllowlist.length > 0) {
        const ip = clientIp(req);
        const allowed = rec.ipAllowlist.some((cidr) => isIpInCidr(ip, cidr));
        if (!allowed) {
          res.status(403).json({ code: 'IP_FORBIDDEN', message: `IP ${ip} is not in the allowlist` });
          return;
        }
      }

      // ── 3. rate limit ──
      if (!rateLimitAllows(rec.id, rec.rateLimitRpm)) {
        res.status(429).json({ code: 'RATE_LIMITED', message: `exceeded ${rec.rateLimitRpm} rpm` });
        return;
      }

      // refresh last_used_at (fire-and-forget)
      touchChatApiKeyLastUsed(pool, rec.id);

      // ── 4. tenant status ──
      const { rows } = await pool.query(
        `SELECT status, k8s_namespace FROM tenants WHERE tenant_id = $1`,
        [rec.tenantId],
      );
      if (rows.length === 0) {
        res.status(404).json({ code: 'TENANT_NOT_FOUND', message: 'tenant does not exist' });
        return;
      }
      if (rows[0].status !== 'active') {
        res.status(403).json({
          code: 'TENANT_NOT_ACTIVE',
          message: `tenant status is ${rows[0].status}`,
        });
        return;
      }

      (req as any).chatAuth = { rec, k8sNamespace: rows[0].k8s_namespace } as ChatAuth;
      next();
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err?.message || 'auth failed' });
    }
  };

  // POST /api/external/chat — synchronous, JSON response.
  router.post('/api/external/chat', chatKeyAuth, async (req: Request, res: Response) => {
    try {
      const { rec, k8sNamespace } = (req as any).chatAuth as ChatAuth;
      const body = extractChatBody(req, rec);
      if (!body) {
        res.status(400).json({ code: 'BAD_REQUEST', message: `message is required and must be under ${MAX_MESSAGE_LEN} chars` });
        return;
      }

      // ── forward to nexus-gateway ──
      const gatewayUrl = gatewayUrlForTenant(rec.tenantId, k8sNamespace);
      const internalToken = process.env.PROVISIONING_API_TOKEN;
      const gwRes = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
          ...forwardHeaders(body),
        },
        body: JSON.stringify({ message: body.message }),
        signal: AbortSignal.timeout(CHAT_FORWARD_TIMEOUT_MS),
      });

      const gwBody = await gwRes.text();
      if (!gwRes.ok) {
        let parsed: any = null;
        try { parsed = JSON.parse(gwBody); } catch { /* not json */ }
        res.status(gwRes.status).json(parsed ?? { code: 'GATEWAY_ERROR', message: gwBody.slice(0, 300) });
        return;
      }

      // gateway returns the agent /execute body; normalise into our contract.
      let agentBody: any;
      try { agentBody = JSON.parse(gwBody); } catch { agentBody = { raw: gwBody }; }

      res.json({
        reply: agentBody?.result?.summary ?? agentBody?.text ?? gwBody,
        sessionId: body.sessionId || agentBody?.sessionId || null,
        agentId: agentBody?.runtime?.agentId ?? body.agentId ?? null,
        model: agentBody?.runtime?.model ?? null,
        responseId: agentBody?.runtime?.responseId ?? null,
        usage: agentBody?.creditsUsed ?? null,
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        res.status(504).json({ code: 'GATEWAY_TIMEOUT', message: 'agent response timed out' });
        return;
      }
      res.status(500).json({ code: 'INTERNAL', message: err?.message || 'chat failed' });
    }
  });

  // POST /api/external/chat/stream — SSE. Pipes OpenClaw's /v1/responses
  // stream (response.output_text.delta / response.completed ...) straight
  // through gateway → agent → OpenClaw. Same dlck_ auth; only the response
  // is text/event-stream instead of JSON. Callers MUST consume incrementally.
  router.post('/api/external/chat/stream', chatKeyAuth, async (req: Request, res: Response) => {
    try {
      const { rec, k8sNamespace } = (req as any).chatAuth as ChatAuth;
      const body = extractChatBody(req, rec);
      if (!body) {
        res.status(400).json({ code: 'BAD_REQUEST', message: `message is required and must be under ${MAX_MESSAGE_LEN} chars` });
        return;
      }

      const gatewayUrl = gatewayUrlForTenant(rec.tenantId, k8sNamespace) + '/stream';
      const internalToken = process.env.PROVISIONING_API_TOKEN;
      const upstream = await fetch(gatewayUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(CHAT_STREAM_FORWARD_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'accept': 'text/event-stream',
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
          ...forwardHeaders(body),
        },
        body: JSON.stringify({ message: body.message }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        let parsed: any = null;
        try { parsed = JSON.parse(errText); } catch { /* not json */ }
        res.status(upstream.status).json(parsed ?? { code: 'GATEWAY_ERROR', message: errText.slice(0, 300) });
        return;
      }

      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();

      const nodeStream = Readable.fromWeb(upstream.body as any);
      nodeStream.on('error', (err) => {
        console.error('[chat-stream] pipe error:', err.message);
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
      // Client disconnect → tear down the upstream fetch so the chain stops.
      res.on('close', () => nodeStream.destroy());
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (!res.headersSent) {
        res.status(timedOut ? 504 : 500).json({
          code: timedOut ? 'GATEWAY_TIMEOUT' : 'INTERNAL',
          message: timedOut ? 'agent stream timed out' : (err?.message || 'stream failed'),
        });
        return;
      }
      // headers already flushed (SSE started) — can't send a JSON error;
      // just close the stream.
      res.end();
    }
  });

  return router;
}
