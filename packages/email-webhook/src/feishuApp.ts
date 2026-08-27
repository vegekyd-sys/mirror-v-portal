/**
 * 飞书自建应用（应用机器人）发消息。
 *
 * 和自定义群机器人的区别：自定义机器人是一个固定的 webhook URL，POST 就发；
 * 应用机器人要先用 app_id/app_secret 换 tenant_access_token，再带 token 调
 * 发消息接口，并显式指定 receive_id（群 ID）。好处是一套凭据能发到任意群，
 * 所以能做「代理邮箱 → 群」的路由。
 *
 * token 有效期 2 小时，这里按 app_id 缓存并提前 5 分钟过期。
 */

import { logger } from "./logger.js";
import type { Binding } from "./bindings.js";

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";

/** 提前量：避免拿到一个马上就过期的 token */
const TOKEN_SKEW_SECONDS = 300;

/** token 失效类错误码，遇到就清缓存重试一次 */
const TOKEN_INVALID_CODES = new Set([99991663, 99991661, 99991664]);

export interface SendResult {
  sent: boolean;
  reason: string;
  via?: string;
  chat_id?: string;
  message_id?: string;
  bound?: boolean;
  [key: string]: unknown;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class FeishuAppClient {
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, CachedToken>();
  /** 同一个 app_id 并发取 token 时只发一次请求，等价于 Python 版的 asyncio.Lock */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(timeoutSeconds = 5) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  private async token(appId: string, appSecret: string): Promise<string> {
    const now = Date.now() / 1000;
    const cached = this.tokens.get(appId);
    if (cached && cached.expiresAt > now) return cached.token;

    const pending = this.inflight.get(appId);
    if (pending) return pending;

    const request = (async () => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (payload["code"] !== 0) {
        throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(payload)}`);
      }
      const token = String(payload["tenant_access_token"]);
      const expire = Number(payload["expire"] ?? 7200) || 7200;
      this.tokens.set(appId, {
        token,
        expiresAt: Date.now() / 1000 + Math.max(expire - TOKEN_SKEW_SECONDS, 60),
      });
      logger.info(`已刷新飞书 token app_id=${appId} 有效期=${expire}s`);
      return token;
    })();

    this.inflight.set(appId, request);
    try {
      return await request;
    } finally {
      this.inflight.delete(appId);
    }
  }

  invalidate(appId: string): void {
    this.tokens.delete(appId);
  }

  /** 发送交互式卡片到绑定的群。token 失效会自动重试一次。 */
  async sendCard(binding: Binding, card: unknown): Promise<SendResult> {
    for (const attempt of [1, 2]) {
      let token: string;
      try {
        token = await this.token(binding.app_id, binding.app_secret);
      } catch (err) {
        logger.error("飞书应用鉴权失败:", err);
        return { sent: false, reason: `auth failed: ${(err as Error).message}` };
      }

      const body = {
        receive_id: binding.chat_id,
        msg_type: "interactive",
        // content 必须是 JSON 字符串，不是对象
        content: JSON.stringify(card),
      };

      let response: Response;
      let payload: Record<string, unknown>;
      try {
        response = await fetch(`${MESSAGE_URL}?receive_id_type=chat_id`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      } catch (err) {
        logger.error("飞书应用发消息失败:", err);
        return { sent: false, reason: `request failed: ${(err as Error).message}` };
      }

      const code = payload["code"];
      if (typeof code === "number" && TOKEN_INVALID_CODES.has(code) && attempt === 1) {
        logger.warn(`飞书 token 失效，清缓存重试 app_id=${binding.app_id}`);
        this.invalidate(binding.app_id);
        continue;
      }

      if (response.status !== 200 || code !== 0) {
        logger.error(`飞书应用返回异常: http=${response.status} body=${JSON.stringify(payload)}`);
        return { sent: false, reason: `feishu rejected: ${JSON.stringify(payload)}` };
      }

      const data = (payload["data"] ?? {}) as Record<string, unknown>;
      return {
        sent: true,
        reason: "",
        via: "app_bot",
        chat_id: binding.chat_id,
        message_id: String(data["message_id"] ?? ""),
      };
    }

    return { sent: false, reason: "token refresh loop exhausted" };
  }
}
