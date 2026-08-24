/**
 * External (third-party) API routes — authenticated by external API keys
 * managed in the admin console, NOT the internal service/admin token.
 */
import { Router, type Request, type Response } from 'express';
import pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { findValidExternalApiKey } from '../services/external-api-keys.js';

export function createExternalApiRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
) {
  const router = Router();

  const proxyRange = async (tenantId: string, startDate: string, endDate: string, res: Response) => {
    try {
      const q = new URLSearchParams({ tenantId, startDate, endDate });
      const url = `${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/billing/llm-usage/range?${q}`;
      const ledgerRes = await fetch(url, {
        headers: { Authorization: `Bearer ${config.creditsLedgerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await ledgerRes.json().catch(() => ({}));
      if (!ledgerRes.ok) {
        res.status(502).json({
          code: 'LEDGER_ERROR',
          message: (data as any)?.message || `credits-ledger returned HTTP ${ledgerRes.status}`,
        });
        return;
      }
      res.json(data);
    } catch (err: unknown) {
      const e = err as any;
      res.status(502).json({ code: 'LEDGER_UNREACHABLE', message: `无法访问 credits-ledger：${e?.message || e}` });
    }
  };

  // POST /api/external/llm-usage/supplier-summary — external token accounting.
  // Body: { supplierId, startDate: YYYY-MM-DD, endDate: YYYY-MM-DD }
  // Auth: Bearer external API key (scoped to a supplier or global).
  router.post('/api/external/llm-usage/supplier-summary', async (req: Request, res: Response) => {
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
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (!supplierId || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
        res.status(400).json({
          code: 'BAD_REQUEST',
          message: 'supplierId and startDate/endDate (YYYY-MM-DD) are required',
        });
        return;
      }

      // Enforce supplier scope when the key is bound to a specific supplier.
      if (rec.supplierId && rec.supplierId !== supplierId) {
        res.status(403).json({ code: 'FORBIDDEN', message: 'API key is not authorized for this supplier' });
        return;
      }

      const { rows } = await pool.query(
        `SELECT tenant_id FROM tenants
          WHERE mio_cdp_supplier_id = $1 AND status <> 'destroyed'
          ORDER BY created_at DESC LIMIT 1`,
        [supplierId],
      );
      if (rows.length === 0) {
        res.status(404).json({ code: 'SUPPLIER_NOT_FOUND', message: `no active tenant for supplier ${supplierId}` });
        return;
      }

      await proxyRange(String(rows[0].tenant_id), startDate, endDate, res);
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'supplier summary failed' });
    }
  });

  return router;
}
