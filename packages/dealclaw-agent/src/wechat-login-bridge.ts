/**
 * WeChat login bridge — runs INSIDE the dealclaw-agent Pod, beside the
 * OpenClaw gateway (loopback 18790). It lets the provisioning-service
 * trigger a QR-code WeChat login and poll its status via HTTP, without
 * exposing a raw pod-exec terminal to the admin console.
 *
 * Why this exists (and doesn't just call `openclaw channels login`):
 *  - The plugin's `auth.login` / `waitForWeixinLogin` use process.stdin for
 *    verify-code input and process.stdout for QR display — unusable from an
 *    HTTP service context.
 *  - pod-exec is a raw terminal: no QR parsing, no session ownership, no
 *    concurrency guard, no audit trail.
 *
 * Approach: replicate the iLink API calls (same as the plugin source:
 * get_bot_qrcode → get_qrcode_status long-poll) and write account files to
 * the same state-directory layout the plugin expects, so the plugin's
 * `gateway.startAccount` picks them up on reload.
 *
 * Auth: Bearer PROVISIONING_API_TOKEN (same shared token as /execute).
 * Single-session-per-tenant: a second start while one is active → 409.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Normalize accountId to match OpenClaw's canonicalizeAccountId behaviour:
//   1. lowercase + trim
//   2. replace every non [a-z0-9_-] character (incl. @ and .) with '-'
//   3. strip leading/trailing dashes
//   4. truncate to 64 chars
//   5. empty/whitespace-only → "default"
// This guarantees the same canonical id the gateway uses when it later calls
// its own normalizeAccountId on the raw ilink_bot_id (e.g. "hex@im.bot" →
// "hex-im-bot"), so the account file written here is discoverable on reload.
// NOTE: OpenClaw additionally checks a blocked-key list (normalizeCanonicalAccountId);
// the bridge has no blocked keys, so that step is intentionally omitted.
function normalizeAccountId(rawId: string): string {
  const normalized = (rawId ?? '').trim().toLowerCase();
  if (!normalized) return 'default';
  const canonical = normalized
    .replace(/[^a-z0-9_-]+/g, '-') // all invalid chars (incl. @, .) → '-'
    .replace(/^-+/g, '')           // strip leading dashes
    .replace(/-+$/g, '')           // strip trailing dashes
    .slice(0, 64);                 // max 64 chars
  return canonical || 'default';
}

// ── iLink API constants (mirrors plugin src/auth/login-qr.ts) ──────────────
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_BOT_TYPE = '3';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_WAIT_TIMEOUT_MS = 8 * 60_000; // 8 min overall deadline
const MAX_QR_REFRESH = 3;

// ── State directory (same layout as plugin src/storage/state-dir.ts) ──────
const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/state';
const weixinStateDir = path.join(stateDir, 'openclaw-weixin');
const accountsIndexPath = path.join(weixinStateDir, 'accounts.json');
const accountsDir = path.join(weixinStateDir, 'accounts');

// ── Session types ───────────────────────────────────────────────────────────
type WeixinLoginStatus =
  | 'pending'        // waiting for scan
  | 'scanned'        // scanned, waiting confirm
  | 'need_verify_code' // plugin requires a numeric code from the phone
  | 'completed'      // login succeeded, account saved
  | 'failed'
  | 'cancelled'
  | 'expired';

interface WeixinLoginSession {
  sessionId: string;
  qrcode: string;           // iLink qrcode token (NOT the QR image)
  qrcodeUrl: string;        // qrcode_img_content (URL the QR encodes)
  status: WeixinLoginStatus;
  startedAt: number;
  expiresAt: number;        // session deadline
  accountId?: string;       // set on completed
  weixinUserId?: string;    // set on completed
  baseUrl?: string;         // iLink redirect URL
  error?: string;
  pendingVerifyCode?: string;
  qrRefreshCount: number;
  abortController: AbortController;
  _pollLoop?: Promise<void>; // background poll loop
}

// ── In-process session store (single Agent Pod = single gateway) ──────────
const sessions = new Map<string, WeixinLoginSession>();
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000; // QR code TTL (iLink side)

function isSessionFresh(s: WeixinLoginSession): boolean {
  return Date.now() - s.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpired(): void {
  for (const [id, s] of sessions) {
    if (Date.now() > s.expiresAt || (!isSessionFresh(s) && s.status === 'pending')) {
      s.abortController.abort();
      sessions.delete(id);
    }
  }
}

// ── iLink API helpers ───────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

function getLocalBotTokenList(): string[] {
  try {
    if (!fs.existsSync(accountsIndexPath)) return [];
    const raw = fs.readFileSync(accountsIndexPath, 'utf-8');
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return [];
    const tokens: string[] = [];
    for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i--) {
      const id = ids[i];
      const accountPath = path.join(accountsDir, `${id}.json`);
      try {
        const data = JSON.parse(fs.readFileSync(accountPath, 'utf-8'));
        const token = data?.token?.trim();
        if (token) tokens.push(token);
      } catch { /* skip */ }
    }
    return tokens;
  } catch {
    return [];
  }
}

async function fetchQRCode(): Promise<QRCodeResponse> {
  const localTokenList = getLocalBotTokenList();
  const res = await fetch(
    `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_ILINK_BOT_TYPE)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_token_list: localTokenList }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
  const text = await res.text();
  return JSON.parse(text) as QRCodeResponse;
}

async function pollQRStatus(
  qrcode: string,
  verifyCode?: string,
  baseUrl: string = ILINK_BASE_URL,
): Promise<StatusResponse> {
  let endpoint = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(QR_LONG_POLL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}`);
    return JSON.parse(await res.text()) as StatusResponse;
  } catch (err: unknown) {
    const e = err as Error;
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      return { status: 'wait' };
    }
    // Network/gateway error — treat as wait and retry
    return { status: 'wait' };
  }
}

// ── Account persistence (same file layout as plugin src/auth/accounts.ts) ──

interface WeixinAccountData {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
}

function registerWeixinAccountId(accountId: string): void {
  fs.mkdirSync(weixinStateDir, { recursive: true });
  let existing: string[] = [];
  try {
    if (fs.existsSync(accountsIndexPath)) {
      existing = JSON.parse(fs.readFileSync(accountsIndexPath, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch { /* start fresh */ }
  if (!existing.includes(accountId)) {
    existing.push(accountId);
    fs.writeFileSync(accountsIndexPath, JSON.stringify(existing, null, 2), 'utf-8');
  }
}

function saveWeixinAccount(
  accountId: string,
  data: { token?: string; baseUrl?: string; userId?: string },
): void {
  fs.mkdirSync(accountsDir, { recursive: true });
  const filePath = path.join(accountsDir, `${accountId}.json`);
  const existing: WeixinAccountData = (() => {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* ignore */ }
    return {};
  })();

  const merged: WeixinAccountData = {
    ...(existing.token || data.token ? { token: data.token || existing.token } : {}),
    ...(data.baseUrl || existing.baseUrl ? { baseUrl: (data.baseUrl || existing.baseUrl)!.trim() } : {}),
    ...(data.userId !== undefined ? { userId: data.userId.trim() || undefined } : { ...(existing.userId ? { userId: existing.userId } : {}) }),
  };
  if (merged.token) merged.savedAt = new Date().toISOString();

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

function clearWeixinAccount(accountId: string): void {
  const files = [`${accountId}.json`, `${accountId}.sync.json`, `${accountId}.context-tokens.json`];
  for (const f of files) {
    try { fs.unlinkSync(path.join(accountsDir, f)); } catch { /* not found */ }
  }
  // Framework allowFrom file
  try {
    fs.unlinkSync(path.join(weixinStateDir, 'credentials', `openclaw-weixin-${accountId}-allowFrom.json`));
  } catch { /* not found */ }
  // Remove from index
  try {
    if (fs.existsSync(accountsIndexPath)) {
      const ids: string[] = JSON.parse(fs.readFileSync(accountsIndexPath, 'utf-8'));
      const updated = ids.filter((id) => id !== accountId);
      if (updated.length !== ids.length) {
        fs.writeFileSync(accountsIndexPath, JSON.stringify(updated, null, 2), 'utf-8');
      }
    }
  } catch { /* ignore */ }
}

function listWeixinAccountIds(): string[] {
  try {
    if (!fs.existsSync(accountsIndexPath)) return [];
    const ids = JSON.parse(fs.readFileSync(accountsIndexPath, 'utf-8'));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Bump channelConfigUpdatedAt in openclaw.json so the gateway reloads
 * channel config from disk (same as plugin's triggerWeixinChannelReload).
 */
async function triggerWeixinChannelReload(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const existing = (channels['openclaw-weixin'] as Record<string, unknown>) ?? {};
    cfg.channels = {
      ...channels,
      'openclaw-weixin': {
        ...existing,
        channelConfigUpdatedAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[wechat-bridge] triggerWeixinChannelReload failed:', String(err));
  }
}

// ── Login session lifecycle ────────────────────────────────────────────────

async function startLogin(): Promise<WeixinLoginSession> {
  purgeExpired();

  // Single active session guard
  const activeCount = [...sessions.values()].filter(s => s.status === 'pending' || s.status === 'scanned').length;
  if (activeCount >= 1) {
    throw Object.assign(new Error('已有进行中的微信扫码会话'), { status: 409, code: 'SESSION_ACTIVE' });
  }

  const qrResponse = await fetchQRCode();
  if (!qrResponse.qrcode || !qrResponse.qrcode_img_content) {
    throw Object.assign(new Error('微信未能生成二维码'), { status: 502, code: 'QR_NOT_READY' });
  }

  const sessionId = randomUUID();
  const abortController = new AbortController();
  const session: WeixinLoginSession = {
    sessionId,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrResponse.qrcode_img_content,
    status: 'pending',
    startedAt: Date.now(),
    expiresAt: Date.now() + LOGIN_WAIT_TIMEOUT_MS,
    qrRefreshCount: 1,
    abortController,
  };

  sessions.set(sessionId, session);

  // Background poll loop
  session._pollLoop = (async () => {
    let currentBaseUrl = ILINK_BASE_URL;

    while (Date.now() < session.expiresAt && !session.abortController.signal.aborted) {
      try {
        const statusResp = await pollQRStatus(
          session.qrcode,
          session.pendingVerifyCode,
          currentBaseUrl,
        );

        // Clear pending verify code after sending
        if (session.pendingVerifyCode && statusResp.status !== 'need_verifycode') {
          session.pendingVerifyCode = undefined;
        }

        // Handle IDC redirect
        if (statusResp.redirect_host && (statusResp.status === 'scaned_but_redirect' || statusResp.status === 'scaned')) {
          currentBaseUrl = `https://${statusResp.redirect_host}`;
        }

        switch (statusResp.status) {
          case 'wait':
            break;
          case 'scaned':
            if (session.status !== 'scanned') session.status = 'scanned';
            break;
          case 'need_verifycode':
            session.status = 'need_verify_code';
            break;
          case 'verify_code_blocked':
            session.status = 'need_verify_code';
            session.error = '验证码错误次数过多，请稍后重试';
            break;
          case 'confirmed':
          case 'binded_redirect': {
            // Login complete — persist account
            if (statusResp.bot_token && statusResp.ilink_bot_id) {
              const rawId = statusResp.ilink_bot_id;
              const normalizedId = normalizeAccountId(rawId);
              const baseUrl = statusResp.baseurl?.trim() || currentBaseUrl;

              saveWeixinAccount(normalizedId, {
                token: statusResp.bot_token,
                baseUrl,
                userId: statusResp.ilink_user_id,
              });
              registerWeixinAccountId(normalizedId);

              // Trigger gateway to reload config + start monitor
              await triggerWeixinChannelReload();

              session.accountId = normalizedId;
              session.weixinUserId = statusResp.ilink_user_id;
              session.baseUrl = baseUrl;
              session.status = 'completed';
            } else if (statusResp.status === 'binded_redirect') {
              // Already bound — existing local credentials remain valid
              session.status = 'completed';
              session.error = '该微信账号已绑定到此 OpenClaw 实例';
            }
            return; // done
          }
          case 'expired': {
            session.qrRefreshCount++;
            if (session.qrRefreshCount > MAX_QR_REFRESH) {
              session.status = 'expired';
              session.error = '二维码多次失效，请重新发起';
              return;
            }
            // Refresh QR
            try {
              const newQr = await fetchQRCode();
              session.qrcode = newQr.qrcode;
              session.qrcodeUrl = newQr.qrcode_img_content;
              session.startedAt = Date.now();
              session.status = 'pending';
            } catch {
              session.status = 'expired';
              session.error = '二维码刷新失败';
              return;
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        // Network error — keep polling, will eventually hit deadline
        if (session.abortController.signal.aborted) break;
      }

      // Small delay between long-polls (long-poll itself blocks ~35s)
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Deadline reached without completion
    if (session.status === 'pending' || session.status === 'scanned' || session.status === 'need_verify_code') {
      session.status = 'expired';
      session.error = '扫码超时';
    }
  })();

  return session;
}

async function cancelLogin(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.abortController.abort();
  if (session.status === 'pending' || session.status === 'scanned' || session.status === 'need_verify_code') {
    session.status = 'cancelled';
  }
  return true;
}

function submitVerifyCode(sessionId: string, code: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.status !== 'need_verify_code') return false;
  session.pendingVerifyCode = code;
  session.status = 'pending'; // resume polling
  return true;
}

// ── Express router ─────────────────────────────────────────────────────────

export function createWeChatLoginBridge() {
  const router = express.Router();

  // Auth: Bearer PROVISIONING_API_TOKEN (same as /execute)
  const authToken = process.env.PROVISIONING_API_TOKEN;
  router.use((req: Request, res: Response, next: NextFunction) => {
    // Skip auth in test mode (no token configured)
    if (!authToken) return next();
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== authToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
      return;
    }
    next();
  });

  // POST /internal/wechat/login/start
  router.post('/internal/wechat/login/start', async (_req: Request, res: Response) => {
    try {
      const session = await startLogin();
      res.status(202).json({
        ok: true,
        sessionId: session.sessionId,
        qrcodeUrl: session.qrcodeUrl,
        expiresAt: new Date(session.expiresAt).toISOString(),
        status: session.status,
      });
    } catch (err: unknown) {
      const e = err as { status?: number; code?: string; message?: string };
      res.status(e.status || 500).json({
        code: e.code || 'INTERNAL',
        message: e.message || 'Internal error',
      });
    }
  });

  // GET /internal/wechat/login/status/:sessionId
  router.get('/internal/wechat/login/status/:sessionId', (req: Request, res: Response) => {
    purgeExpired();
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期' });
      return;
    }
    // Return current QR URL (may have been refreshed)
    const message = statusMessage(session);
    res.json({
      ok: true,
      sessionId: session.sessionId,
      status: session.status,
      message,
      qrcodeUrl: session.status === 'pending' ? session.qrcodeUrl : undefined,
      accountId: session.status === 'completed' ? session.accountId : undefined,
      weixinUserId: session.status === 'completed' ? session.weixinUserId : undefined,
      error: session.error || undefined,
    });
  });

  // POST /internal/wechat/login/cancel/:sessionId
  router.post('/internal/wechat/login/cancel/:sessionId', async (req: Request, res: Response) => {
    const ok = await cancelLogin(req.params.sessionId);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期' });
      return;
    }
    res.json({ ok: true });
  });

  // POST /internal/wechat/login/verify-code/:sessionId
  router.post('/internal/wechat/login/verify-code/:sessionId', (req: Request, res: Response) => {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: '验证码不能为空' });
      return;
    }
    const ok = submitVerifyCode(req.params.sessionId, code);
    if (!ok) {
      res.status(409).json({ code: 'NOT_READY', message: '当前不需要验证码或会话不存在' });
      return;
    }
    res.json({ ok: true });
  });

  // GET /internal/wechat/accounts — list bound accounts (for health check)
  router.get('/internal/wechat/accounts', (_req: Request, res: Response) => {
    const ids = listWeixinAccountIds();
    res.json({ ok: true, accounts: ids });
  });

  // POST /internal/wechat/unbind — clear account from state dir
  router.post('/internal/wechat/unbind', async (req: Request, res: Response) => {
    const { accountId } = req.body || {};
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'accountId is required' });
      return;
    }
    clearWeixinAccount(accountId);
    await triggerWeixinChannelReload();
    res.json({ ok: true });
  });

  return router;
}

function statusMessage(s: WeixinLoginSession): string {
  switch (s.status) {
    case 'pending': return '请用手机微信扫描二维码';
    case 'scanned': return '已扫描，请在手机上确认';
    case 'need_verify_code': return '请输入手机微信显示的数字';
    case 'completed': return s.error ? s.error : '微信绑定成功';
    case 'failed': return `扫码失败：${s.error || '未知错误'}`;
    case 'cancelled': return '已取消';
    case 'expired': return s.error || '二维码已过期';
  }
}
