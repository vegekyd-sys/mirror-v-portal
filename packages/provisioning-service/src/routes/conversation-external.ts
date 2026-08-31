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

  return router;
}
