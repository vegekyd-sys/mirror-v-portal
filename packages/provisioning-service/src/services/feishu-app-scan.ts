/**
 * Feishu app scan-to-fetch — admin-console counterpart of central-gateway's
 * self-serve onboarding QR flow.
 *
 * Lets an admin get a Feishu app's credentials by having the CUSTOMER scan a
 * QR code with their Feishu mobile app, instead of hand-copying App ID /
 * App Secret from the Feishu open platform console.
 *
 * How it works (Feishu device-authorization / registerApp flow):
 *  1. POST /v1/admin/feishu-app/scan/start → we call lark.registerApp() with
 *     createOnly:true. Feishu hands us a device-authorization URL which we
 *     render as a QR code.
 *  2. The customer scans the QR with the Feishu app and confirms — Feishu
 *     creates a fresh self-built app ("DealClaw AI销售助手") in the
 *     customer's own Feishu tenant.
 *  3. registerApp() resolves with client_id + client_secret. The admin SPA
 *     polls GET .../status/:deviceCode, receives the credentials and
 *     auto-fills the binding / customer-creation form. Submitting then goes
 *     through the normal (verified) bind / create flow.
 *
 * This module is credentials-ONLY: unlike central-gateway's orchestration
 * (which provisions a tenant immediately), here nothing is persisted and no
 * tenant is created — the admin stays in control of the form.
 *
 * Sessions live in memory (single provisioning pod); a pod restart simply
 * loses pending scans, which the UI surfaces as "二维码已过期，请重试".
 */

import * as lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

export type FeishuAppScanStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface FeishuAppScanSession {
  deviceCode: string;
  qrUrl: string;
  qrDataUri: string;
  expireIn: number;
  status: FeishuAppScanStatus;
  startedAt: Date;
  completedAt?: Date;
  appId?: string;
  appSecret?: string;
  error?: string;
  _abortController: AbortController;
  _completionPromise?: Promise<void>;
}

/** Same preset as the self-serve onboarding flow — one consistent bot identity. */
const APP_PRESET = {
  name: '元海精灵 AI出海专家',
  desc: 'AI-powered sales assistant for global trade — 全天候帮你找客户、写邮件、跟线索',
};

/** Sessions are dropped after 20 min (QR codes expire well before that). */
export const SCAN_SESSION_TTL_MS = 20 * 60 * 1000;
/** Completed sessions linger briefly so the polling browser still sees the result. */
export const COMPLETED_RETENTION_MS = 5 * 60 * 1000;
/** Max concurrent pending sessions — guards against runaway UI loops. */
export const MAX_ACTIVE_SESSIONS = 50;
/** How long start() waits for the QR to become available. */
const QR_READY_TIMEOUT_MS = 10_000;

// ── Injectable registerApp (so tests never touch the network) ──────────────

export interface RegisterAppHandlers {
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange(info: { status: string }): void;
  signal: AbortSignal;
}

export type RegisterAppFn = (
  handlers: RegisterAppHandlers,
) => Promise<{ client_id: string; client_secret: string }>;

async function defaultRegisterApp(handlers: RegisterAppHandlers) {
  // Mirrors packages/central-gateway/src/services/feishu-register.ts —
  // createOnly:true means Feishu creates the app and returns credentials,
  // no further store/marketplace steps.
  return lark.registerApp({
    onQRCodeReady: handlers.onQRCodeReady,
    onStatusChange: handlers.onStatusChange,
    appPreset: APP_PRESET,
    addons: {
      preset: true,
      scopes: { tenant: ['im:message:send_as_bot'], user: [] },
    } as lark.AppAddons,
    createOnly: true,
    signal: handlers.signal,
  }) as unknown as Promise<{ client_id: string; client_secret: string }>;
}

// ── Session store ──────────────────────────────────────────────────────────

export class FeishuAppScanError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'FeishuAppScanError';
    this.status = status;
    this.code = code;
  }
}

export class FeishuAppScanStore {
  private sessions = new Map<string, FeishuAppScanSession>();
  private readonly registerAppImpl: RegisterAppFn;

  constructor(registerAppImpl: RegisterAppFn = defaultRegisterApp) {
    this.registerAppImpl = registerAppImpl;
  }

  /** Drop stale sessions (lazy sweep — called on every access). */
  sweep(now = Date.now()): void {
    for (const [key, s] of this.sessions) {
      const age = now - s.startedAt.getTime();
      const doneAge = s.completedAt ? now - s.completedAt.getTime() : 0;
      if (age > SCAN_SESSION_TTL_MS || (s.status !== 'pending' && doneAge > COMPLETED_RETENTION_MS)) {
        if (s.status === 'pending') s._abortController.abort();
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Start a scan session. Resolves once the QR URL is available (or null on
   * timeout); registration continues in the background and completes the
   * session when the customer confirms on their phone.
   */
  async start(now = Date.now()): Promise<FeishuAppScanSession> {
    this.sweep(now);
    const active = [...this.sessions.values()].filter((s) => s.status === 'pending').length;
    if (active >= MAX_ACTIVE_SESSIONS) {
      throw new FeishuAppScanError(429, 'TOO_MANY_SESSIONS', '扫码会话过多，请稍后再试');
    }

    const abortController = new AbortController();
    const session: FeishuAppScanSession = {
      deviceCode: '',
      qrUrl: '',
      qrDataUri: '',
      expireIn: 600,
      status: 'pending',
      startedAt: new Date(now),
      _abortController: abortController,
    };

    session._completionPromise = (async () => {
      try {
        const result = await this.registerAppImpl({
          onQRCodeReady(info) {
            session.deviceCode = extractDeviceCode(info.url);
            session.qrUrl = info.url;
            session.expireIn = info.expireIn;
          },
          onStatusChange(info) {
            // 'polling' / 'slow_down' / 'domain_switched' all mean "not
            // confirmed yet" — stay pending (see central-gateway notes).
            console.log('[feishu-app-scan] status:', info.status);
          },
          signal: abortController.signal,
        });

        session.appId = result.client_id;
        session.appSecret = result.client_secret;
        session.status = 'completed';
        session.completedAt = new Date();
        console.log('[feishu-app-scan] app created:', result.client_id);
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e?.code === 'abort' || abortController.signal.aborted) {
          session.status = 'cancelled';
          session.error = '已取消';
        } else {
          session.status = 'failed';
          session.error = `${e?.code || 'error'}: ${e?.message || err}`;
          console.error('[feishu-app-scan] failed:', session.error);
        }
        session.completedAt = new Date();
      }
    })();

    // Wait for the QR to be ready (fires well before registerApp resolves).
    const deadline = now + QR_READY_TIMEOUT_MS;
    while (!session.deviceCode && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      // Abort/timeout surfaces faster than the deadline loop.
      if (session.status !== 'pending' && !session.deviceCode) break;
    }

    if (!session.deviceCode) {
      abortController.abort();
      if (session.status === 'failed') {
        throw new FeishuAppScanError(502, 'REGISTER_FAILED', `飞书扫码会话创建失败：${session.error || '未知错误'}`);
      }
      throw new FeishuAppScanError(
        502,
        'QR_NOT_READY',
        '飞书未能生成扫码二维码，请稍后重试（检查集群出网 open.feishu.cn）',
      );
    }

    // Render the QR inline (data URI) so the SPA needs no external service.
    try {
      session.qrDataUri = await QRCode.toDataURL(session.qrUrl, { width: 300, margin: 1 });
    } catch (e) {
      console.error('[feishu-app-scan] QR render failed:', e);
      // qrUrl still works — the SPA can fall back to a client-side renderer.
    }

    this.sessions.set(session.deviceCode, session);
    return session;
  }

  /** Read a session; undefined when unknown/expired (pod restart etc.). */
  get(deviceCode: string): FeishuAppScanSession | undefined {
    this.sweep();
    return this.sessions.get(deviceCode);
  }

  /** Cancel a pending scan. Returns false when the session is unknown. */
  cancel(deviceCode: string): boolean {
    const session = this.sessions.get(deviceCode);
    if (!session) return false;
    if (session.status === 'pending') {
      session._abortController.abort();
      // Keep the session so the polling browser observes 'cancelled';
      // sweep() reaps it after COMPLETED_RETENTION_MS.
    }
    return true;
  }
}

/** Human-readable per-status message, mirroring the onboarding flow. */
export function scanStatusMessage(session: FeishuAppScanSession): string {
  switch (session.status) {
    case 'pending':
      return '请客户用飞书 App 扫描二维码并确认创建应用';
    case 'completed':
      return '应用创建成功，凭据已获取';
    case 'failed':
      return `扫码失败：${session.error || '未知错误'}`;
    case 'cancelled':
      return '已取消';
  }
}

function extractDeviceCode(url: string): string {
  try {
    return new URL(url).searchParams.get('user_code') || '';
  } catch {
    return '';
  }
}
