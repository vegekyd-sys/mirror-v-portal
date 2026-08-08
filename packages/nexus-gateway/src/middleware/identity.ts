/**
 * Identity Middleware
 * 
 * B4 FIX: Validates platform request signatures (Feishu HMAC-SHA256).
 * Extracts platform user identity and maps to DealClaw tenant context.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { TenantContext, GatewayError } from '../types/index.js';

// In production, injected from K8s Secret at pod startup
let TENANT_CONFIG: {
  tenantId: string;
  platform: TenantContext['platform'];
  allowedAppIds: string[];
  botSecret?: string;
} | null = null;

export function initIdentityConfig(config: typeof TENANT_CONFIG) {
  TENANT_CONFIG = config;
}

/**
 * Express middleware: validate identity and attach tenant context
 */
export function identityMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!TENANT_CONFIG) {
    res.status(500).json({ code: 'UNAUTHORIZED', message: 'Gateway not configured' } as GatewayError);
    return;
  }

  // 1. Verify platform signature
  if (TENANT_CONFIG.platform === 'feishu') {
    const skipCheck = process.env.DEALCLAW_SKIP_SIGNATURE_CHECK === 'true';
    if (skipCheck) {
      console.warn('[identity] WARNING: Signature verification disabled via DEALCLAW_SKIP_SIGNATURE_CHECK=true');
    } else if (!TENANT_CONFIG.botSecret) {
      console.error('[identity] botSecret not configured — refusing request. Set DEALCLAW_SKIP_SIGNATURE_CHECK=true for dev mode.');
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE' as GatewayError['code'], message: 'Gateway signature secret not configured' } as GatewayError);
      return;
    } else if (!verifyFeishuSignature(req)) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid signature' } as GatewayError);
      return;
    }
  }
  // TODO: DingTalk / WeCom signature verification

  // 2. Extract platform user ID
  const platformUserId = extractPlatformUserId(req);
  if (!platformUserId) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Cannot identify platform user' } as GatewayError);
    return;
  }

  // 3. Verify app ID is in allowed list
  const appId = extractAppId(req);
  if (appId && TENANT_CONFIG.allowedAppIds?.length > 0 && !TENANT_CONFIG.allowedAppIds.includes(appId)) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'App not authorized' } as GatewayError);
    return;
  }

  // 4. Resolve tenant role
  const role = resolveRole(platformUserId);

  (req as any).tenantContext = {
    tenantId: TENANT_CONFIG.tenantId,
    userId: platformUserId,
    platform: TENANT_CONFIG.platform,
    role,
  } satisfies TenantContext;

  next();
}

/**
 * B4 FIX: Verify Feishu webhook signature (HMAC-SHA256).
 * 
 * Feishu sends a timestamp + nonce in the header, and signs
 * those + the request body with the app secret.
 */
function verifyFeishuSignature(req: Request): boolean {
  // B4-续 FIX: botSecret is now required — caller must check before calling this
  if (!TENANT_CONFIG?.botSecret) return false;

  const timestamp = req.headers['x-lark-request-timestamp'] as string;
  const nonce = req.headers['x-lark-request-nonce'] as string;
  const signature = req.headers['x-lark-signature'] as string;

  if (!timestamp || !nonce || !signature) return false;

  // Check timestamp is within 5 minutes to prevent replay
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  // Compute expected signature
  // NB6 FIX: Use raw body buffer instead of re-serializing JSON.parse'd body.
  // Express JSON.stringify(req.body) may reorder keys or escape differently
  // than the original request body, breaking the HMAC signature match.
  const rawBody = (req as any).rawBody;
  if (!rawBody) {
    console.error('[identity] rawBody not available — ensure express.raw() middleware is configured before express.json()');
    return false;
  }
  const rawBodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  const signStr = `${timestamp}${nonce}${rawBody}`;
  const expected = createHmac('sha256', TENANT_CONFIG.botSecret)
    .update(signStr)
    .digest('base64');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractAppId(req: Request): string | null {
  return req.body?.event?.header?.app_id || req.body?.app_id || null;
}

function extractPlatformUserId(req: Request): string | null {
  // Feishu: from verified webhook event
  const feishuUserId = req.body?.event?.sender?.sender_id?.open_id;
  if (feishuUserId) return feishuUserId;

  // DingTalk
  const dingtalkUserId = req.body?.senderId;
  if (dingtalkUserId) return dingtalkUserId;

  return null;
}

function resolveRole(_userId: string): TenantContext['role'] {
  return 'member';
}
