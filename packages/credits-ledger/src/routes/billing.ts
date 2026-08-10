import { Router } from 'express';
import {
  estimateBilling,
  settleBilling,
  canAfford,
  getBillingEvents,
  getTenantBillingSummary,
} from '../services/billing-hook.js';

const router = Router();

// POST /v1/billing/estimate — estimate cost before execution
router.post('/v1/billing/estimate', async (req, res) => {
  try {
    const { tenantId, accountId, taskId, skillId, quantity, metadata } = req.body;
    if (!tenantId || !accountId || !skillId || !quantity) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId, accountId, skillId, and quantity are required',
      });
      return;
    }
    const result = await estimateBilling({
      tenantId, accountId, taskId, skillId, quantity: Number(quantity), metadata,
    });

    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/billing/settle — execute & deduct credits
router.post('/v1/billing/settle', async (req, res) => {
  try {
    const { tenantId, accountId, taskId, skillId, quantity, estimatedEventId, resultSummary, metadata } = req.body;
    if (!tenantId || !accountId || !skillId || !quantity || !estimatedEventId) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'tenantId, accountId, skillId, quantity, and estimatedEventId are required',
      });
      return;
    }

    const result = await settleBilling({
      tenantId, accountId, taskId, skillId,
      quantity: Number(quantity),
      estimatedEventId,
      resultSummary,
      metadata,
    });

    if (!result.ok) {
      const status = result.code === 'INSUFFICIENT_CREDITS' ? 402 : 500;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/billing/can-afford — quick balance check
router.post('/v1/billing/can-afford', async (req, res) => {
  try {
    const { accountId, skillId, quantity } = req.body;
    if (!accountId || !skillId || !quantity) {
      res.status(400).json({ code: 'VALIDATION', message: 'accountId, skillId, quantity required' });
      return;
    }
    const result = await canAfford(accountId, skillId, Number(quantity));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/billing/events?tenantId=... — billing history for a tenant
router.get('/v1/billing/events', async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      res.status(400).json({ code: 'VALIDATION', message: 'tenantId query parameter required' });
      return;
    }

    const events = await getBillingEvents({
      tenantId,
      skillId: req.query.skillId as string | undefined,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });

    const summary = await getTenantBillingSummary(tenantId);

    res.json({ events, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
