/**
 * External conversation-log pull endpoint — 米奥「Agent 对话日志」拉取接口.
 *
 * Purpose (王建, 2026-08-31): 外部系统按 supplier + 时间范围批量拉取 Agent
 * 对话日志（原始消息流，含 in/out 两条记录），用于数据同步/审计/分析。
 * 不需要前端式分页、keyword 模糊搜索、按 conversationId 返回整段会话。
 *
 * Mirrors `/api/external/llm-usage/supplier-summary` for auth & isolation:
 *   - Bearer external API key (scoped to a supplier or global).
 *   - supplierId → tenant_id via `tenants.mio_cdp_supplier_id`.
 *   - per-supplier data isolation.
 *
 * Large-result batching (keyset pagination on the monotonic `id`):
 *   - request returns up to `limit` rows (default 1000, max 10000) plus a
 *     `nextCursor` (the last row id of the batch). Caller repeats with
 *     `cursor = nextCursor` until `hasMore` is false.
 *   - keyset by `id` (BIGSERIAL, strictly monotonic) is stable under
 *     concurrent ingest — no skip/duplicate that OFFSET paging would cause.
 *   - time range filters `created_at`; ordering is `id ASC` (insertion order,
 *     which equals ingest time for the realtime chatlog plugin).
 *
 *   POST /api/external/conversation/logs
 *     body: { supplierId, startDate: YYYY-MM-DD, endDate: YYYY-MM-DD,
 *             cursor?: string, limit?: number }
 *     resp: { records: MessageRow[], nextCursor: string|null, hasMore: boolean,
 *             total: number }
 *
 * MessageRow (raw chat_messages row, camelCased):
 *   messageId, sessionKey, direction('in'|'out'), channel, senderOpenId,
 *   senderName, senderUsername, content, runId, success, createdAt(+08:00).
 */
import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { findValidExternalApiKey } from '../services/external-api-keys.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^\d{1,19}$/;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

export function createConversationExternalRoutes(
  pool: pg.Pool,
  _config: ProvisioningConfig,
) {
  const router = Router();

  // POST /api/external/conversation/logs
  router.post('/api/external/conversation/logs', async (req: Request, res: Response) => {
    try {
      // --- auth: Bearer external API key ---
      const authHeader = req.headers.authorization ?? '';
      const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const rec = await findValidExternalApiKey(pool, key);
      if (!rec) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'invalid or revoked API key' });
        return;
      }

      // --- body: supplierId + time range (same shape as supplier-summary) ---
      const supplierId = typeof req.body?.supplierId === 'string' ? req.body.supplierId.trim() : '';
      const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
      const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';
      if (!supplierId || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
        res.status(400).json({
          code: 'BAD_REQUEST',
          message: 'supplierId and startDate/endDate (YYYY-MM-DD) are required',
        });
        return;
      }
      if (startDate > endDate) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'startDate must not be later than endDate' });
        return;
      }

      // --- enforce supplier scope when the key is supplier-bound ---
      if (rec.supplierId && rec.supplierId !== supplierId) {
        res.status(403).json({ code: 'FORBIDDEN', message: 'API key is not authorized for this supplier' });
        return;
      }

      // --- resolve supplierId → tenant_id ---
      const tenant = await pool.query(
        `SELECT tenant_id FROM tenants
          WHERE mio_cdp_supplier_id = $1 AND status <> 'destroyed'
          ORDER BY created_at DESC LIMIT 1`,
        [supplierId],
      );
      if (tenant.rows.length === 0) {
        res.status(404).json({ code: 'SUPPLIER_NOT_FOUND', message: `no active tenant for supplier ${supplierId}` });
        return;
      }
      const tenantId = String(tenant.rows[0].tenant_id);

      // --- cursor + limit ---
      const cursorRaw = typeof req.body?.cursor === 'string' ? req.body.cursor.trim() : '';
      if (cursorRaw && !CURSOR_RE.test(cursorRaw)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'invalid cursor' });
        return;
      }
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Math.floor(Number(req.body?.limit) || DEFAULT_LIMIT)),
      );

      // --- keyset pull: id ascending, time range on created_at (Asia/Shanghai day bounds) ---
      const sql = `
        SELECT id, direction, channel, sender_open_id, sender_name, sender_username,
               content, session_key, message_id, run_id, success,
               to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS created_at
        FROM chat_messages
        WHERE tenant_id = $1
          AND created_at >= ($2::date AT TIME ZONE 'Asia/Shanghai')
          AND created_at <  (($3::date + 1) AT TIME ZONE 'Asia/Shanghai')
          AND ($4::bigint IS NULL OR id > $4)
        ORDER BY id ASC
        LIMIT $5
      `;
      const { rows } = await pool.query(sql, [
        tenantId,
        startDate,
        endDate,
        cursorRaw || null,
        limit + 1,
      ]);

      const hasMore = rows.length > limit;
      const batch = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore && batch.length ? String(batch[batch.length - 1].id) : null;

      const records = batch.map((r: any) => ({
        messageId: r.message_id ?? null,
        sessionKey: r.session_key ?? null,
        direction: r.direction,
        channel: r.channel ?? null,
        senderOpenId: r.sender_open_id ?? null,
        senderName: r.sender_name ?? null,
        senderUsername: r.sender_username ?? null,
        content: r.content,
        runId: r.run_id ?? null,
        success: r.success ?? null,
        createdAt: r.created_at,
      }));

      // --- total count: same tenant + time-range filter, no cursor/limit ---
      // 走 idx_chat_messages_tenant_time (tenant_id, created_at DESC) 索引，成本可控
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM chat_messages
         WHERE tenant_id = $1
           AND created_at >= ($2::date AT TIME ZONE 'Asia/Shanghai')
           AND created_at <  (($3::date + 1) AT TIME ZONE 'Asia/Shanghai')`,
        [tenantId, startDate, endDate],
      );
      const total = countRes.rows[0]?.total ?? 0;

      res.json({ records, nextCursor, hasMore, total });
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err?.message || 'conversation logs failed' });
    }
  });

  // POST /api/external/conversation/sessions — 会话列表 (grouped by session_key).
  //
  // 米奥「会话列表」接口 (罗勇坚, 2026-09-01): 外部系统按 supplier 拉取该租户下的
  // 会话列表（同一飞书会话 = 一个 session_key），一屏看到有哪些会话、各多少轮、
  // 最后谁发言、何时。与 /conversation/logs（平铺消息流）互补。
  //
  // 鉴权/隔离与 logs 同一套：Bearer external API key + supplierId → tenant_id。
  // 分页用 offset/limit（会话按 session_key 归组后数量有限，无需 keyset）。
  // startDate/endDate 可选：给了就只统计该时间窗内活跃的会话（计数/首末/preview
  // 均按窗口内消息计算）；都不给 = 全量会话。
  router.post('/api/external/conversation/sessions', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization ?? '';
      const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const rec = await findValidExternalApiKey(pool, key);
      if (!rec) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'invalid or revoked API key' });
        return;
      }

      const supplierId = typeof req.body?.supplierId === 'string' ? req.body.supplierId.trim() : '';
      const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
      const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';
      if (!supplierId) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'supplierId is required' });
        return;
      }
      if ((startDate && !DATE_RE.test(startDate)) || (endDate && !DATE_RE.test(endDate))) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'startDate/endDate must be YYYY-MM-DD' });
        return;
      }
      if (startDate && endDate && startDate > endDate) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'startDate must not be later than endDate' });
        return;
      }

      if (rec.supplierId && rec.supplierId !== supplierId) {
        res.status(403).json({ code: 'FORBIDDEN', message: 'API key is not authorized for this supplier' });
        return;
      }

      const tenant = await pool.query(
        `SELECT tenant_id FROM tenants
          WHERE mio_cdp_supplier_id = $1 AND status <> 'destroyed'
          ORDER BY created_at DESC LIMIT 1`,
        [supplierId],
      );
      if (tenant.rows.length === 0) {
        res.status(404).json({ code: 'SUPPLIER_NOT_FOUND', message: `no active tenant for supplier ${supplierId}` });
        return;
      }
      const tenantId = String(tenant.rows[0].tenant_id);

      const limit = Math.min(500, Math.max(1, Math.floor(Number(req.body?.limit) || 50)));
      const offset = Math.max(0, Math.floor(Number(req.body?.offset) || 0));

      const hasRange = Boolean(startDate && endDate);
      const rangeWhere = hasRange
        ? `AND created_at >= ($2::date AT TIME ZONE 'Asia/Shanghai')
             AND created_at <  (($3::date + 1) AT TIME ZONE 'Asia/Shanghai')`
        : '';
      const params: unknown[] = hasRange ? [tenantId, startDate, endDate] : [tenantId];

      const sql = `
        WITH scoped AS (
          SELECT session_key, direction, sender_name, sender_open_id, content, created_at
          FROM chat_messages
          WHERE tenant_id = $1 AND session_key IS NOT NULL
            ${rangeWhere}
        ),
        agg AS (
          SELECT session_key,
                 COUNT(*)::int AS message_count,
                 COUNT(*) FILTER (WHERE direction = 'in')::int  AS in_count,
                 COUNT(*) FILTER (WHERE direction = 'out')::int AS out_count,
                 MIN(created_at) AS first_at,
                 MAX(created_at) AS last_at,
                 (ARRAY_REMOVE(ARRAY_AGG(sender_name ORDER BY created_at DESC), NULL))[1]    AS last_sender_name,
                 (ARRAY_REMOVE(ARRAY_AGG(sender_open_id ORDER BY created_at DESC), NULL))[1] AS last_sender_open_id
          FROM scoped
          GROUP BY session_key
        ),
        preview AS (
          SELECT DISTINCT ON (session_key) session_key, content
          FROM scoped
          WHERE direction = 'in'
          ORDER BY session_key, created_at ASC
        ),
        second AS (
          SELECT session_key, content
          FROM (
            SELECT session_key, content,
                   ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY created_at ASC) AS rn
            FROM scoped
          ) t
          WHERE rn = 2
        )
        SELECT agg.session_key,
               agg.message_count,
               agg.in_count,
               agg.out_count,
               to_char(agg.first_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS first_at,
               to_char(agg.last_at  AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS last_at,
               agg.last_sender_name,
               agg.last_sender_open_id,
               left(preview.content, 200) AS preview,
               left(second.content, 200) AS secondary_preview
        FROM agg
        LEFT JOIN preview USING (session_key)
        LEFT JOIN second USING (session_key)
        ORDER BY agg.last_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      const { rows } = await pool.query(sql, [...params, limit, offset]);

      const countRes = await pool.query(
        `SELECT COUNT(DISTINCT session_key)::int AS total
         FROM chat_messages
         WHERE tenant_id = $1 AND session_key IS NOT NULL
           ${rangeWhere}`,
        params,
      );
      const total = countRes.rows[0]?.total ?? 0;

      const sessions = rows.map((r: any) => ({
        sessionKey: r.session_key ?? null,
        messageCount: r.message_count ?? 0,
        inCount: r.in_count ?? 0,
        outCount: r.out_count ?? 0,
        firstAt: r.first_at ?? null,
        lastAt: r.last_at ?? null,
        lastSenderName: r.last_sender_name ?? null,
        lastSenderOpenId: r.last_sender_open_id ?? null,
        preview: r.preview ?? null,
        secondaryPreview: r.secondary_preview ?? null,
      }));

      const hasMore = offset + sessions.length < total;
      res.json({ sessions, total, limit, offset, hasMore });
    } catch (err: any) {
      res.status(500).json({ code: 'INTERNAL', message: err?.message || 'conversation sessions failed' });
    }
  });

  return router;
}
