import { randomUUID } from "node:crypto";
import { ilinkBaseUrl, ilinkPollHeaders, ilinkPostHeaders } from "./ilink-protocol.js";

/**
 * iLink QR login, run in the manager.
 *
 * The repo already had this flow, but inside the agent pod — it wrote token
 * files into a PVC for OpenClaw's weixin plugin to pick up. Here the manager
 * owns the connection, so the scan has to happen where the poll will live: the
 * session is held in memory, and on confirmation the token is handed to
 * WeixinEdge to seal and start polling with.
 *
 * Sessions are deliberately not persisted. A QR is valid for minutes, and a
 * manager restart mid-scan is better surfaced as an expired code the user can
 * retry than as a half-restored login.
 */
const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const LONG_POLL_MS = 35_000;
const SESSION_TTL_MS = 5 * 60_000;

export type LoginStatus =
  | "pending"
  | "scanned"
  | "need_verify_code"
  | "completed"
  | "expired"
  | "failed";

export interface LoginSession {
  id: string;
  tenantId: string;
  status: LoginStatus;
  qrImage?: string;
  expiresAt: number;
  error?: string;
  accountId?: string;
  needVerifyCode?: boolean;
}

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}
interface StatusResponse {
  status:
    | "wait" | "scaned" | "confirmed" | "expired"
    | "scaned_but_redirect" | "need_verifycode"
    | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface LoginSink {
  /** Seal the token against the tenant and begin receiving. */
  bind(tenantId: string, botToken: string, accountId?: string, baseUrl?: string): Promise<void>;
}

export class WeixinLogin {
  private sessions = new Map<string, LoginSession & { verifyCode?: string; aborted?: boolean }>();
  constructor(private readonly sink: LoginSink) {}

  /** One scan at a time per tenant: two live QRs would race for the same binding. */
  async start(tenantId: string): Promise<LoginSession> {
    for (const [id, s] of this.sessions)
      if (s.tenantId === tenantId && (s.status === "pending" || s.status === "scanned")) {
        s.aborted = true;
        this.sessions.delete(id);
      }
    const res = await fetch(
      `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
      {
        method: "POST",
        headers: ilinkPostHeaders(),
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`ILINK_QRCODE_HTTP_${res.status}`);
    const qr = (await res.json()) as QRCodeResponse;
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("ILINK_QRCODE_MISSING");

    const session: LoginSession & { aborted?: boolean } = {
      id: randomUUID(),
      tenantId,
      status: "pending",
      qrImage: qr.qrcode_img_content,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    void this.poll(session.id, qr.qrcode);
    return session;
  }

  status(id: string): LoginSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.status === "pending" || s.status === "scanned") {
      if (Date.now() > s.expiresAt) s.status = "expired";
    }
    return s;
  }

  /** Supplied by the user when iLink challenges the scan. */
  submitVerifyCode(id: string, code: string) {
    const s = this.sessions.get(id);
    if (!s || s.status !== "need_verify_code") return false;
    s.verifyCode = code;
    s.status = "scanned";
    return true;
  }

  cancel(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.aborted = true;
    this.sessions.delete(id);
  }

  private async poll(id: string, qrcode: string) {
    let base = ILINK_BASE;
    while (true) {
      const s = this.sessions.get(id);
      if (!s || s.aborted) return;
      if (Date.now() > s.expiresAt) {
        s.status = "expired";
        return;
      }
      let body: StatusResponse;
      try {
        let url = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        if (s.verifyCode) {
          url += `&verify_code=${encodeURIComponent(s.verifyCode)}`;
          s.verifyCode = undefined;
        }
        const res = await fetch(url, { headers: ilinkPollHeaders(), signal: AbortSignal.timeout(LONG_POLL_MS + 5_000) });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        body = (await res.json()) as StatusResponse;
      } catch (error: any) {
        // A long poll that times out or trips a gateway is normal; keep waiting.
        if (error?.name === "TimeoutError" || error?.name === "AbortError") continue;
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }

      // iLink moves a session to a regional host mid-scan.
      if (body.redirect_host && (body.status === "scaned" || body.status === "scaned_but_redirect")) {
        try { base = ilinkBaseUrl(`https://${body.redirect_host}`); }
        catch { s.status = "failed"; s.error = "ILINK_REDIRECT_INVALID"; return; }
      }

      switch (body.status) {
        case "wait":
          break;
        case "scaned":
        case "scaned_but_redirect":
          if (s.status === "pending") s.status = "scanned";
          break;
        case "need_verifycode":
          s.status = "need_verify_code";
          s.needVerifyCode = true;
          break;
        case "verify_code_blocked":
          s.status = "failed";
          s.error = "VERIFY_CODE_BLOCKED";
          return;
        case "expired":
          s.status = "expired";
          return;
        case "binded_redirect":
        case "confirmed": {
          if (!body.bot_token) {
            s.status = "failed";
            s.error = "TOKEN_MISSING";
            return;
          }
          try {
            const baseUrl = ilinkBaseUrl(body.baseurl);
            await this.sink.bind(s.tenantId, body.bot_token, body.ilink_bot_id, baseUrl);
            s.status = "completed";
            s.accountId = body.ilink_bot_id;
            s.qrImage = undefined;
          } catch (error: any) {
            s.status = "failed";
            s.error = String(error?.message ?? error).slice(0, 200);
          }
          return;
        }
      }
    }
  }
}
