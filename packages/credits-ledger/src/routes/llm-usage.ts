/**
 * LLM token usage accounting — written by the nexus-gateway LLM proxy.
 *
 * Shadow accounting: records raw input/output tokens per upstream call.
 * Never debits credits (see docs/design/llm-proxy-billing.md).
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';

const router = Router();

const STATUSES = new Set(['ok', 'error', 'blocked', 'synthesized']);

function int(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  return Math.min(n, max);
}

function str(v: unknown, max = 128): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// POST /v1/billing/llm-usage — record one upstream (or synthesized) call.
// Idempotent on request_id: replays return the existing row without dupes.
router.post('/v1/billing/llm-usage', async (req, res) => {
  try {
    const b = req.body ?? {};
    const tenantId = str(b.tenantId, 64);
    const provider = str(b.provider, 64);
    const model = str(b.model, 128);
    if (!tenantId || !provider || !model) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId, provider, and model are required',
      });
      return;
    }
    const accountId = str(b.accountId, 64) || `acct_${tenantId}`;
    const inputTokens = int(b.inputTokens);
    const outputTokens = int(b.outputTokens);
    const status = STATUSES.has(str(b.status, 16)) ? str(b.status, 16) : 'ok';
    const requestId = str(b.requestId, 128) || null;
    const latencyMs = b.latencyMs == null ? null : int(b.latencyMs, 86_400_000);
    const metadata = (b.metadata && typeof b.metadata === 'object') ? b.metadata : {};
    const id = randomUUID();

    const { rows } = await query(
      `INSERT INTO llm_usage_events
         (id, tenant_id, account_id, provider, model,
          input_tokens, output_tokens, total_tokens,
          latency_ms, status, source, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        id, tenantId, accountId, provider, model,
        inputTokens, outputTokens, inputTokens + outputTokens,
        latencyMs, status, str(b.source, 32) || 'proxy', requestId,
        JSON.stringify(metadata),
      ],
    );

    if (rows.length === 0) {
      // Replay of an already-recorded request_id — acknowledge, no duplicate.
      res.json({ ok: true, duplicate: true });
      return;
    }
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('llm-usage insert failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/summary?tenantId=...&days=7 — per-tenant aggregate.
router.get('/v1/billing/llm-usage/summary', async (req, res) => {
  try {
    const tenantId = str(req.query.tenantId, 64);
    const days = Math.min(Math.max(int(req.query.days, 31) || 7, 1), 365);
    if (!tenantId) {
      res.status(400).json({ code: 'VALIDATION', message: 'tenantId query parameter required' });
      return;
    }

    const { rows: totals } = await query(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0)  AS total_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [tenantId, String(days)],
    );

    const { rows: byModel } = await query(
      `SELECT provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY provider, model
        ORDER BY calls DESC`,
      [tenantId, String(days)],
    );

    const { rows: byDay } = await query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [tenantId, String(days)],
    );

    res.json({
      tenantId,
      days,
      totals: {
        calls: Number(totals[0].calls),
        inputTokens: Number(totals[0].input_tokens),
        outputTokens: Number(totals[0].output_tokens),
        totalTokens: Number(totals[0].total_tokens),
      },
      byModel: byModel.map((r: any) => ({
        provider: r.provider, model: r.model, calls: Number(r.calls),
        inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      })),
      byDay: byDay.map((r: any) => ({
        day: r.day, calls: Number(r.calls),
        inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      })),
    });
  } catch (err) {
    console.error('llm-usage summary failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/tenants?days=7 — per-tenant totals (admin page).
router.get('/v1/billing/llm-usage/tenants', async (req, res) => {
  try {
    const days = Math.min(Math.max(int(req.query.days, 31) || 7, 1), 365);
    const { rows: ordered } = await query(
      `SELECT tenant_id,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
              COUNT(*) FILTER (WHERE status = 'blocked')     AS blocked,
              COUNT(*) FILTER (WHERE status = 'synthesized') AS synthesized,
              MAX(created_at) AS last_call_at
         FROM llm_usage_events
        WHERE created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY tenant_id
        ORDER BY total_tokens DESC`,
      [String(days)],
    );
    res.json({
      days,
      tenants: ordered.map((r: any) => ({
        tenantId: r.tenant_id,
        calls: Number(r.calls),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        totalTokens: Number(r.total_tokens),
        blocked: Number(r.blocked),
        synthesized: Number(r.synthesized),
        lastCallAt: r.last_call_at,
      })),
    });
  } catch (err) {
    console.error('llm-usage tenants failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/llm-usage/range?tenantId=&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Absolute (inclusive) date-range aggregate for external token accounting.
router.get('/v1/billing/llm-usage/range', async (req, res) => {
  try {
    const tenantId = str(req.query.tenantId, 64);
    const startDate = str(req.query.startDate, 10);
    const endDate = str(req.query.endDate, 10);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!tenantId || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId and valid startDate/endDate (YYYY-MM-DD) are required',
      });
      return;
    }

    const { rows } = await query(
      `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage_events
        WHERE tenant_id = $1
          AND created_at >= ($2::date)::timestamptz
          AND created_at <  (($3::date) + 1)::timestamptz`,
      [tenantId, startDate, endDate],
    );

    const r = rows[0];
    res.json({
      tenantId,
      startDate,
      endDate,
      totalInputToken: Number(r.input_tokens),
      totalOutputToken: Number(r.output_tokens),
    });
  } catch (err) {
    console.error('llm-usage range failed:', err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
