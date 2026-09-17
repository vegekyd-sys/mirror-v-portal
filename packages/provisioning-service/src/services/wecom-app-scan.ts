/**
 * WeCom (企业微信) app scan-to-fetch — admin-console counterpart of the
 * Feishu app-scan flow, adapted for WeCom's official QR one-click bot
 * creation ("扫码一键创建智能机器人").
 *
 * How it works (WeCom AI-bot device-authorization flow, the same endpoints the
 * official `@wecom/wecom-openclaw-cli` uses):
 *  1. POST /v1/admin/wecom-app/scan/start → we call
 *     `GET https://work.weixin.qq.com/ai/qc/generate?source=…&plat=…` which
 *     returns `auth_url` (the QR payload) + `scode` (polling token).
 *  2. The admin renders the QR and the CUSTOMER scans it with their WeCom app,
 *     then confirms "一键创建智能机器人" on the phone. WeCom creates the bot
 *     in the customer's own WeCom org and associates the credentials with the
 *     scode.
 *  3. The SPA polls GET .../status/:scode → we call
 *     `GET .../ai/qc/query_result?scode=…`; on `data.status === 'success'` we
 *     read `data.bot_info.botid` + `data.bot_info.secret` and hand them back
 *     for auto-fill into the WeCom binding form.
 *
 * This module is credentials-ONLY: nothing is persisted and no tenant is
 * created — the admin stays in control of the form, and the final bind still
 * goes through wecom-binding.ts (which stores the secret in the K8s Secret and
 * never in the DB).
 *
 * Polling is FRONTEND-driven: each status call performs one synchronous
 * query_result against WeCom. Sessions live in memory (single provisioning
 * pod); a pod restart simply loses pending scans, which the UI surfaces as
 * "二维码已过期，请重试".
 */

import QRCode from 'qrcode';

export type WeComAppScanStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface WeComAppScanSession {
  scode: string;
  authUrl: string;
  scanPageUrl: string;
  qrDataUri: string;
  status: WeComAppScanStatus;
  startedAt: Date;
  completedAt?: Date;
  botId?: string;
  secret?: string;
  error?: string;
}

/** Source identifier handed to WeCom's generate endpoint (env-overridable). */
export const DEFAULT_WECOM_SOURCE = 'wecom-cli';

/** Session TTL mirrors the official CLI's 5-minute poll timeout. */
export const SCAN_SESSION_TTL_MS = 5 * 60 * 1000;
/** Completed sessions linger briefly so the polling browser still sees the result. */
export const COMPLETED_RETENTION_MS = 5 * 60 * 1000;
/** Max concurrent pending sessions — guards against runaway UI loops. */
export const MAX_ACTIVE_SESSIONS = 50;
/** QR validity shown to the admin (seconds), aligned with the 5-min TTL. */
export const QR_EXPIRE_SECONDS = 300;

/** WeCom's `plat` code — mirrors the official CLI's getPlatCode(). */
export function getWeComPlatCode(): number {
  switch (process.platform) {
    case 'darwin':
      return 1;
    case 'win32':
      return 2;
    case 'linux':
      return 3;
    default:
      return 0;
  }
}

export class WeComAppScanError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WeComAppScanError';
    this.status = status;
    this.code = code;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface StoreOptions {
  /** WeCom source identifier (default `wecom-cli`, the official CLI default). */
  source?: string;
  /** WeCom platform code; defaults to the current OS mapping. */
  plat?: number;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: FetchLike;
}

/** Human-readable per-status message, mirroring the Feishu scan flow. */
export function scanStatusMessage(session: WeComAppScanSession): string {
  switch (session.status) {
    case 'pending':
      return '请客户用企业微信扫描二维码并确认「一键创建智能机器人」';
    case 'completed':
      return '机器人创建成功，凭据已获取';
    case 'failed':
      return `扫码失败：${session.error || '未知错误'}`;
    case 'cancelled':
      return '已取消';
  }
}

export class WeComAppScanStore {
  private sessions = new Map<string, WeComAppScanSession>();
  private readonly source: string;
  private readonly plat: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: StoreOptions = {}) {
    this.source = opts.source || DEFAULT_WECOM_SOURCE;
    this.plat = opts.plat ?? getWeComPlatCode();
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
   * Start a scan session: fetch the QR auth_url + scode from WeCom, render the
   * QR inline as a data URI, and register the session.
   */
  async start(now = Date.now()): Promise<WeComAppScanSession> {
    this.sweep(now);
    const active = [...this.sessions.values()].filter((s) => s.status === 'pending').length;
    if (active >= MAX_ACTIVE_SESSIONS) {
      throw new WeComAppScanError(429, 'TOO_MANY_SESSIONS', '扫码会话过多，请稍后再试');
    }

    const { scode, authUrl } = await this.fetchQRCode();

    const session: WeComAppScanSession = {
      scode,
      authUrl,
      scanPageUrl: `https://work.weixin.qq.com/ai/qc/gen?source=${encodeURIComponent(this.source)}&scode=${encodeURIComponent(scode)}`,
      qrDataUri: '',
      status: 'pending',
      startedAt: new Date(now),
    };

    try {
      session.qrDataUri = await QRCode.toDataURL(authUrl, { width: 300, margin: 1 });
    } catch (e) {
      console.error('[wecom-app-scan] QR render failed:', e);
      // authUrl still works — the SPA can fall back to scanPageUrl / a client renderer.
    }

    this.sessions.set(scode, session);
    return session;
  }

  /**
   * Poll WeCom for the scan result (frontend-driven). A network failure keeps
   * the session pending so the SPA retries; a definitive failure/success
   * settles the session.
   */
  async poll(scode: string): Promise<WeComAppScanSession> {
    this.sweep();
    const session = this.sessions.get(scode);
    if (!session) {
      throw new WeComAppScanError(404, 'NOT_FOUND', '扫码会话不存在或已过期，请重新发起');
    }
    if (session.status !== 'pending') return session;

    let body: any;
    try {
      body = await this.queryResult(scode);
    } catch (err) {
      // Transient egress failure — stay pending; the SPA backs off and retries.
      console.warn('[wecom-app-scan] query_result failed:', String(err));
      return session;
    }

    const status = body?.data?.status;
    if (status === 'success') {
      const botInfo = body.data.bot_info || {};
      if (!botInfo.botid || !botInfo.secret) {
        session.status = 'failed';
        session.error = '扫码成功但未获取到机器人凭据';
      } else {
        session.status = 'completed';
        session.botId = botInfo.botid;
        session.secret = botInfo.secret;
      }
      session.completedAt = new Date();
    } else if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'expired') {
      session.status = 'failed';
      session.error = body?.data?.message || body?.errmsg || '扫码未完成，请重试';
      session.completedAt = new Date();
    }
    // Otherwise still pending (e.g. status === 'pending' or undefined).

    return session;
  }

  /** Read a session; undefined when unknown/expired (pod restart etc.). */
  get(scode: string): WeComAppScanSession | undefined {
    this.sweep();
    return this.sessions.get(scode);
  }

  /** Cancel a pending scan. Returns false when the session is unknown. */
  cancel(scode: string): boolean {
    const session = this.sessions.get(scode);
    if (!session) return false;
    if (session.status === 'pending') {
      session.status = 'cancelled';
      session.completedAt = new Date();
    }
    return true;
  }

  // ── WeCom HTTP endpoints ─────────────────────────────────────────────────

  private async fetchQRCode(): Promise<{ scode: string; authUrl: string }> {
    const url = `https://work.weixin.qq.com/ai/qc/generate?source=${encodeURIComponent(this.source)}&plat=${this.plat}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      const e = err as Error;
      throw new WeComAppScanError(502, 'QR_NOT_READY', `无法连接企业微信生成二维码：${e?.message || err}（请检查集群出网 work.weixin.qq.com）`);
    }
    const body = await res.json().catch(() => ({} as any));
    const scode = body?.data?.scode;
    const authUrl = body?.data?.auth_url;
    if (!scode || !authUrl) {
      throw new WeComAppScanError(502, 'QR_NOT_READY', '企业微信未能生成扫码二维码，请稍后重试');
    }
    return { scode, authUrl };
  }

  private async queryResult(scode: string): Promise<any> {
    const url = `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(scode)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    return res.json();
  }
}
