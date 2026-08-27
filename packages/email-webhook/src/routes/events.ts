import type { FastifyInstance } from "fastify";
import { bearerToken, headerValue, requireAdmin } from "../auth.js";

interface EventsQuery {
  after?: string;
  limit?: string;
}

/** 只接受纯整数写法，"10.9"/"abc" 都算失败，回落默认值。 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return 50;
  const value = Number.parseInt(raw, 10);
  return Math.max(1, Math.min(value, 200));
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 认证增量读取事件，供本地 poller 拉取。
   *
   * 契约：GET /v1/events?after=<cursor>&limit=<n>
   *       Authorization: Bearer <ADMIN_TOKEN>
   *
   * 返回 {events, next_cursor, has_more}。每个 event 的 sequence 即下次游标值
   * （= 服务端 received_at），poller 拿到后作为 after 传入下一次请求。
   */
  app.get<{ Querystring: EventsQuery }>("/v1/events", async (request) => {
    const state = request.server.state;
    requireAdmin(state, bearerToken(headerValue(request.headers.authorization)));

    const after = request.query.after ?? "";
    const limit = parseLimit(request.query.limit);

    const [rows, hasMore] = await state.events.readSince(after, limit);

    const events = [];
    let lastCursor = after;
    for (const row of rows) {
      const raw = (typeof row.raw === "object" && row.raw !== null ? row.raw : {}) as Record<
        string,
        unknown
      >;
      // Resend 原始 payload 的 data 子对象才是扁平化的邮件数据，
      // 本地 ingest 需要的就是它。
      const data = raw["data"];
      const payload = typeof data === "object" && data !== null && !Array.isArray(data) ? data : raw;
      const seq = row.cursor;
      events.push({
        sequence: seq,
        svix_id: row.message_id,
        event_type: row.event_type,
        received_at: seq,
        payload,
      });
      lastCursor = seq;
    }

    return {
      count: events.length,
      events,
      next_cursor: lastCursor,
      has_more: hasMore,
    };
  });
}
