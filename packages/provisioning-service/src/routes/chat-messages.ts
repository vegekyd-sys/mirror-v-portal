import { Router, type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import type { ProvisioningConfig } from '../config.js';

/**
 * Chat message log (dealclaw-chatlog plugin ↔ admin console).
 *
 * - POST /v1/tenants/:id/chat-messages — ingest endpoint called by the
 *   in-agent dealclaw-chatlog plugin (service-token auth). Idempotent on
 *   (tenant_id, message_id): the plugin is fire-and-forget and may retry.
 * - GET  /v1/tenants/:id/chat-messages/sessions — session list (grouped by
 *   session_key) with message counts / participants / last activity, for the
 *   conversation-history UI sidebar.
 * - GET  /v1/tenants/:id/chat-messages — paginated messages, newest first;
 *   supports sessionKey / direction filters. The UI re-sorts ascending.
 *
 * Content is truncated at ingest (CHAT_CONTENT_MAX) to bound row size;
 * sender_name is a point-in-time snapshot and may be NULL when the tenant's
 * Feishu app lacks contact:user.base:readonly.
 */

const CHAT_CONTENT_MAX = 20_000;

export function createChatMessageRoutes(pool: pg.Pool, _config: ProvisioningConfig, authMiddleware?: (req: Request, res: Response, next: NextFunction) => void) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  /** POST /v1/tenants/:id/chat-messages — ingest one message. */
  router.post('/v1/tenants/:id/chat-messages', async (req: Request, res: Response) => {
    try {
      const b = req.body ?? {};
      const direction = b.direction === 'in' || b.direction === 'out' ? b.direction : null;
      if (!direction) {
        res.status(400).json({ code: 'BAD_REQUEST', message: "direction must be 'in' or 'out'" });
        return;
      }
      const content = typeof b.content === 'string' ? b.content : '';
      if (!content.trim()) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'content is required' });
        return;
      }
      const str = (v: unknown, max: number): string | null =>
        typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

      const channel = str(b.channel, 32);
      const senderOpenId = str(b.senderOpenId, 128);
      const senderName = str(b.senderName, 256);
      const senderUsername = str(b.senderUsername, 256);
      const sessionKey = str(b.sessionKey, 256);
      const messageId = str(b.messageId, 128);
      const runId = str(b.runId, 128);
      const success = typeof b.success === 'boolean' ? b.success : null;

      const { rowCount } = await pool.query(
        `INSERT INTO chat_messages
           (tenant_id, direction, channel, sender_open_id, sender_name, sender_username,
            content, session_key, message_id, run_id, success)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [req.params.id, direction, channel, senderOpenId, senderName, senderUsername,
          content.slice(0, CHAT_CONTENT_MAX), sessionKey, messageId, runId, success],
      );
      // rowCount 0 = duplicate message_id (already ingested) — same success
      // answer so the plugin never retries a landed row.
      res.json({ ok: true, stored: rowCount === 1 });
    } catch (err) {
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  /** GET /v1/tenants/:id/chat-messages/sessions — grouped session list. */
  router.get('/v1/tenants/:id/chat-messages/sessions', async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20) || 20, 100));
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      // 按「session_key + 自然日（Asia/Shanghai）+ 客户」分桶：同一用户/渠道的历史消息
      // 不再跨天塞进一个会话，也不再因 OpenClaw 会话重置而同日被拆成多个；群聊里
      // 同一天不同人也会拆成独立条目（out 消息归属到紧邻的前一条 in 的客户）。
      const sql = `
        WITH scoped AS (
          SELECT session_key, direction, sender_name, sender_open_id, created_at, id
          FROM chat_messages
          WHERE tenant_id = $1 AND session_key IS NOT NULL
        ),
        marked AS (
          SELECT scoped.*,
                 SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END)
                   OVER (PARTITION BY session_key ORDER BY created_at, id) AS in_seq,
                 TO_CHAR(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day
          FROM scoped
        ),
        person AS (
          SELECT DISTINCT ON (session_key, in_seq)
                 session_key, in_seq,
                 sender_open_id AS person_open_id,
                 sender_name    AS person_name
          FROM marked
          WHERE direction = 'in'
          ORDER BY session_key, in_seq, created_at, id
        ),
        seg AS (
          SELECT m.session_key, m.day, m.direction, m.sender_name, m.sender_open_id, m.created_at,
                 p.person_open_id, p.person_name
          FROM marked m
          JOIN person p USING (session_key, in_seq)
        ),
        agg AS (
          SELECT session_key, day, person_open_id, person_name,
                 COUNT(*)::int AS message_count,
                 MIN(created_at) AS first_at,
                 MAX(created_at) AS last_at,
                 (ARRAY_REMOVE(ARRAY_AGG(sender_name ORDER BY created_at DESC), NULL))[1]    AS last_sender_name,
                 (ARRAY_REMOVE(ARRAY_AGG(sender_open_id ORDER BY created_at DESC), NULL))[1] AS last_sender_open_id
          FROM seg
          GROUP BY session_key, day, person_open_id, person_name
          HAVING COUNT(*) FILTER (WHERE direction = 'in') > 0
        )
        SELECT session_key,
               day,
               person_open_id,
               person_name,
               message_count,
               first_at,
               last_at,
               last_sender_name,
               last_sender_open_id
        FROM agg
        ORDER BY last_at DESC
        LIMIT $2 OFFSET $3
      `;
      const { rows } = await pool.query(sql, [req.params.id, limit, offset]);

      const { rows: totalRows } = await pool.query(
        `WITH scoped AS (
           SELECT session_key, direction, sender_open_id, created_at, id
           FROM chat_messages
           WHERE tenant_id = $1 AND session_key IS NOT NULL
         ),
         marked AS (
           SELECT session_key, direction, sender_open_id, created_at, id,
                  SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END)
                    OVER (PARTITION BY session_key ORDER BY created_at, id) AS in_seq,
                  TO_CHAR(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day
           FROM scoped
         ),
         person AS (
           SELECT DISTINCT ON (session_key, in_seq)
                  session_key, in_seq, sender_open_id AS person_open_id
           FROM marked
           WHERE direction = 'in'
           ORDER BY session_key, in_seq, created_at, id
         ),
         seg AS (
           SELECT m.session_key, m.day, p.person_open_id
           FROM marked m
           JOIN person p USING (session_key, in_seq)
         )
         SELECT COUNT(*)::int AS total
         FROM (SELECT DISTINCT session_key, day, person_open_id FROM seg) s`,
        [req.params.id],
      );
      res.json({ sessions: rows, total: totalRows[0]?.total ?? 0, limit, offset });
    } catch (err) {
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  /** GET /v1/tenants/:id/chat-messages — paginated messages, newest first. */
  router.get('/v1/tenants/:id/chat-messages', async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 200));
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const direction = req.query.direction === 'in' || req.query.direction === 'out'
        ? (req.query.direction as string) : null;
      const sessionKey = typeof req.query.sessionKey === 'string' && req.query.sessionKey.trim()
        ? req.query.sessionKey.trim().slice(0, 256) : null;
      const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
        ? req.query.day : null;

      const where: string[] = ['tenant_id = $1'];
      const params: unknown[] = [req.params.id];
      if (direction) { params.push(direction); where.push(`direction = $${params.length}`); }
      if (sessionKey) { params.push(sessionKey); where.push(`session_key = $${params.length}`); }
      if (day) { params.push(day); where.push(`TO_CHAR(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') = $${params.length}`); }
      const whereSql = where.join(' AND ');

      const { rows } = await pool.query(
        `SELECT id, direction, channel, sender_open_id, sender_name, sender_username,
                content, session_key, message_id, run_id, success, created_at
         FROM chat_messages
         WHERE ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM chat_messages WHERE ${whereSql}`,
        params,
      );
      res.json({ messages: rows, total: totalRows[0]?.total ?? 0, limit, offset });
    } catch (err) {
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
