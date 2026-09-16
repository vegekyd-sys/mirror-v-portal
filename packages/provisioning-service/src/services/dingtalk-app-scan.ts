/**
 * DingTalk (钉钉) app scan-to-create — admin-console counterpart of the WeCom
 * / Feishu app-scan flows, adapted for DingTalk's official QR one-click bot
 * creation ("扫码一键创建机器人 / 设备授权流").
 *
 * How it works (DingTalk registration device-authorization flow, the same
 * endpoints the official `@dingtalk-real-ai/dingtalk-connector` uses):
 *  1. POST /v1/admin/dingtalk-app/scan/start → we call
 *     `POST https://oapi.dingtalk.com/app/registration/init` with `{source}`
 *     to obtain a short-lived `nonce`, then
 *     `POST .../app/registration/begin` with `{nonce}` to obtain
 *     `device_code` + `verification_uri_complete` (the QR payload).
 *  2. The admin renders the QR and the CUSTOMER scans it with their DingTalk
 *     app, then confirms "一键创建机器人" on the phone. DingTalk creates the
 *     bot/app in the customer's own DingTalk org and associates the
 *     credentials with the device_code.
 *  3. The SPA polls GET .../status/:deviceCode → we call
 *     `POST .../app/registration/poll` with `{device_code}`; on
 *     `status === 'SUCCESS'` we read `client_id` + `client_secret` and hand
 *     them back for auto-fill into the DingTalk binding form.
 *
 * This module is credentials-ONLY: nothing is persisted and no tenant is
 * created — the admin stays in control of the form, and the final bind still
 * goes through dingtalk-binding.ts (which stores the secret in the K8s Secret
 * and never in the DB).
 *
 * Polling is FRONTEND-driven: each status call performs one synchronous
 * poll against DingTalk. Sessions live in memory (single provisioning pod);
 * a pod restart simply loses pending scans, which the UI surfaces as
 * "二维码已过期，请重试".
 */

import QRCode from 'qrcode';

export type DingTalkAppScanStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface DingTalkAppScanSession {
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete: string;
  qrDataUri: string;
  expireIn: number;
  status: DingTalkAppScanStatus;
  startedAt: Date;
  completedAt?: Date;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}

/** Source identifier handed to DingTalk's registration endpoints (env-overridable). */
export const DEFAULT_DINGTALK_SOURCE = 'DING_DWS_CLAW';
/** Base URL for DingTalk registration endpoints (env-overridable). */
export const DEFAULT_DINGTALK_BASE_URL = 'https://oapi.dingtalk.com';

/** Session TTL mirrors the Feishu flow (QR codes expire well before that). */
export const SCAN_SESSION_TTL_MS = 20 * 60 * 1000;
/** Completed sessions linger briefly so the polling browser still sees the result. */
export const COMPLETED_RETENTION_MS = 5 * 60 * 1000;
/** Max concurrent pending sessions — guards against runaway UI loops. */
export const MAX_ACTIVE_SESSIONS = 50;
/** Fallback QR validity (seconds) when DingTalk doesn't report expires_in. */
export const QR_EXPIRE_SECONDS_FALLBACK = 7200;

export class DingTalkAppScanError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DingTalkAppScanError';
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface StoreOptions {
  /** DingTalk source identifier (default DING_DWS_CLAW, the official connector default). */
  source?: string;
  /** DingTalk registration base URL (default https://oapi.dingtalk.com). */
  baseUrl?: string;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: FetchLike;
}

/** Human-readable per-status message, mirroring the Feishu/WeCom scan flows. */
export function scanStatusMessage(session: DingTalkAppScanSession): string {
  switch (session.status) {
    case 'pending':
      return '请客户用钉钉扫描二维码并确认「一键创建机器人」';
    case 'completed':
      return '机器人创建成功，凭据已获取';
    case 'failed':
      return `扫码失败：${session.error || '未知错误'}`;
    case 'cancelled':
      return '已取消';
  }
}

// ── DingTalk registration HTTP endpoints ──────────────────────────────────

interface DingTalkApiResp<T extends Record<string, unknown>> {
  errcode: number;
  errmsg?: string;
  [key: string]: unknown;
}

interface InitResp extends DingTalkApiResp<Record<string, unknown>> {
  nonce?: string;
  expires_in?: number;
}

interface BeginResp extends DingTalkApiResp<Record<string, unknown>> {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface PollResp extends DingTalkApiResp<Record<string, unknown>> {
  status?: string;
  client_id?: string;
  client_secret?: string;
  fail_reason?: string;
}

export class DingTalkAppScanStore {
  private sessions = new Map<string, DingTalkAppScanSession>();
  private readonly source: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: StoreOptions = {}) {
    this.source = opts.source || DEFAULT_DINGTALK_SOURCE;
    this.baseUrl = (opts.baseUrl || DEFAULT_DINGTALK_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** Drop stale sessions (lazy sweep — called on every access). */
  sweep(now = Date.now()): void {
    for (const [key, s] of this.sessions) {
      const age = now - s.startedAt.getTime();
      const doneAge = s.completedAt ? now - s.completedAt.getTime() : 0;
      if (age > SCAN_SESSION_TTL_MS || (s.status !== 'pending' && doneAge > COMPLETED_RETENTION_MS)) {
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Start a scan session: init → begin against DingTalk, render the QR inline
   * as a data URI, and register the session keyed by device_code.
   */
  async start(now = Date.now()): Promise<DingTalkAppScanSession> {
    this.sweep(now);
    const active = [...this.sessions.values()].filter((s) => s.status === 'pending').length;
    if (active >= MAX_ACTIVE_SESSIONS) {
      throw new DingTalkAppScanError(429, 'TOO_MANY_SESSIONS', '扫码会话过多，请稍后再试');
    }

    const { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn } =
      await this.fetchDeviceCode();

    const session: DingTalkAppScanSession = {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      qrDataUri: '',
      expireIn: expiresIn,
      status: 'pending',
      startedAt: new Date(now),
    };

    try {
      session.qrDataUri = await QRCode.toDataURL(verificationUriComplete, { width: 300, margin: 1 });
    } catch (e) {
      console.error('[dingtalk-app-scan] QR render failed:', e);
      // verificationUriComplete still works — the SPA can fall back to it.
    }

    this.sessions.set(deviceCode, session);
    return session;
  }

  /**
   * Poll DingTalk for the scan result (frontend-driven). A network failure
   * keeps the session pending so the SPA retries; a definitive failure/success
   * settles the session.
   */
  async poll(deviceCode: string): Promise<DingTalkAppScanSession> {
    this.sweep();
    const session = this.sessions.get(deviceCode);
    if (!session) {
      throw new DingTalkAppScanError(404, 'NOT_FOUND', '扫码会话不存在或已过期，请重新发起');
    }
    if (session.status !== 'pending') return session;

    let body: PollResp;
    try {
      body = await this.queryResult(deviceCode);
    } catch (err) {
      // Transient egress failure — stay pending; the SPA backs off and retries.
      console.warn('[dingtalk-app-scan] poll failed:', String(err));
      return session;
    }

    const status = String(body.status ?? '').trim().toUpperCase();
    if (status === 'SUCCESS') {
      const clientId = String(body.client_id ?? '').trim();
      const clientSecret = String(body.client_secret ?? '').trim();
      if (!clientId || !clientSecret) {
        session.status = 'failed';
        session.error = '扫码成功但未获取到机器人凭据';
      } else {
        session.status = 'completed';
        session.clientId = clientId;
        session.clientSecret = clientSecret;
      }
      session.completedAt = new Date();
    } else if (status === 'FAIL' || status === 'EXPIRED') {
      session.status = 'failed';
      session.error =
        String(body.fail_reason ?? '').trim() ||
        (status === 'EXPIRED' ? '扫码授权已过期，请重试' : '扫码未完成，请重试');
      session.completedAt = new Date();
    }
    // WAITING / UNKNOWN / empty → still pending.

    return session;
  }

  /** Read a session; undefined when unknown/expired (pod restart etc.). */
  get(deviceCode: string): DingTalkAppScanSession | undefined {
    this.sweep();
    return this.sessions.get(deviceCode);
  }

  /** Cancel a pending scan. Returns false when the session is unknown. */
  cancel(deviceCode: string): boolean {
    const session = this.sessions.get(deviceCode);
    if (!session) return false;
    if (session.status === 'pending') {
      session.status = 'cancelled';
      session.completedAt = new Date();
    }
    return true;
  }

  // ── DingTalk registration HTTP calls ────────────────────────────────────

  private async postJson<T extends DingTalkApiResp<Record<string, unknown>>>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const e = err as Error;
      throw new DingTalkAppScanError(
        502,
        'DINGTALK_UNREACHABLE',
        `无法连接钉钉开放平台：${e?.message || err}（请检查集群出网 oapi.dingtalk.com）`,
      );
    }
    return (await res.json().catch(() => ({} as T))) as T;
  }

  private assertApiOk<T extends DingTalkApiResp<Record<string, unknown>>>(
    data: T,
    action: string,
  ): T {
    if (!data || data.errcode !== 0) {
      throw new DingTalkAppScanError(
        502,
        'DINGTALK_API_ERROR',
        `钉钉接口[${action}]调用失败：${data?.errmsg || 'unknown error'}（errcode=${data?.errcode ?? 'N/A'}）`,
      );
    }
    return data;
  }

  private async fetchDeviceCode(): Promise<{
    deviceCode: string;
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete: string;
    expiresIn: number;
  }> {
    // Step 1: init — obtain a short-lived nonce.
    const init = this.assertApiOk(
      await this.postJson<InitResp>('/app/registration/init', { source: this.source }),
      'init',
    );
    const nonce = String(init.nonce ?? '').trim();
    if (!nonce) {
      throw new DingTalkAppScanError(502, 'QR_NOT_READY', '钉钉未能返回 nonce，请稍后重试');
    }

    // Step 2: begin — exchange nonce for device_code + verification URI.
    const begin = this.assertApiOk(
      await this.postJson<BeginResp>('/app/registration/begin', { nonce }),
      'begin',
    );
    const deviceCode = String(begin.device_code ?? '').trim();
    const verificationUriComplete = String(begin.verification_uri_complete ?? '').trim();
    if (!deviceCode || !verificationUriComplete) {
      throw new DingTalkAppScanError(502, 'QR_NOT_READY', '钉钉未能生成扫码二维码，请稍后重试');
    }

    const expiresIn = Number(begin.expires_in ?? 0);
    return {
      deviceCode,
      userCode: String(begin.user_code ?? '').trim() || undefined,
      verificationUri: String(begin.verification_uri ?? '').trim() || undefined,
      verificationUriComplete,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : QR_EXPIRE_SECONDS_FALLBACK,
    };
  }

  private async queryResult(deviceCode: string): Promise<PollResp> {
    const poll = await this.postJson<PollResp>('/app/registration/poll', {
      device_code: deviceCode,
    });
    return this.assertApiOk(poll, 'poll');
  }
}
