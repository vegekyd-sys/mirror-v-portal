import { Router } from 'express';
import {
  getBalance,
  debit,
  credit,
  getHistory,
  getUsage,
} from '../services/account.js';

const router = Router();

// GET /v1/accounts/:accountId/balance
router.get('/v1/accounts/:accountId/balance', async (req, res) => {
  try {
    const result = await getBalance(req.params.accountId);
    if (!result) {
      res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
});

// POST /v1/accounts/:accountId/debit
router.post('/v1/accounts/:accountId/debit', async (req, res) => {
  try {
    const { amount, reference, description, category, idempotencyKey } = req.body;
    if (!amount || !reference || !idempotencyKey) {
      res.status(400).json({ code: 'VALIDATION', message: 'Missing required fields: amount, reference, idempotencyKey' });
      return;
    }
    if (typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ code: 'VALIDATION', message: 'amount must be a positive number' });
      return;
    }
    const result = await debit({
      accountId: req.params.accountId,
      amount: Math.floor(amount),
      reference,
      description,
      category,
      idempotencyKey,
    });
    if ('code' in result && result.code === 'ACCOUNT_NOT_FOUND') {
      res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
      return;
    }
    if ('code' in result && result.code === 'INSUFFICIENT_CREDITS') {
      res.status(402).json({
        code: 'INSUFFICIENT_CREDITS',
        balance: (result as any).balance,
        required: (result as any).required,
      });
      return;
    }
    if ('code' in result && result.code === 'MONTHLY_LIMIT_EXCEEDED') {
      res.status(402).json({
        code: 'MONTHLY_LIMIT_EXCEEDED',
        monthlyUsed: (result as any).monthlyUsed,
        monthlyAllowance: (result as any).monthlyAllowance,
        required: (result as any).required,
      });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
});

// POST /v1/accounts/:accountId/credit (internal: Payment Service only)
router.post('/v1/accounts/:accountId/credit', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env.PAYMENT_SERVICE_TOKEN;
    // Unauthorized takes priority over unconfigured service
    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing authorization token' });
      return;
    }
    if (!expectedToken) {
      console.error('PAYMENT_SERVICE_TOKEN is not configured');
      res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Payment service not configured' });
      return;
    }
    if (token !== expectedToken) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
      return;
    }
    const { amount, reference, description, idempotencyKey } = req.body;
    if (!amount || !reference || !idempotencyKey) {
      res.status(400).json({ code: 'VALIDATION', message: 'Missing required fields' });
      return;
    }
    const result = await credit({
      accountId: req.params.accountId,
      amount: Math.floor(amount),
      reference,
      description,
      idempotencyKey,
    });
    if ('code' in result && result.code === 'ACCOUNT_NOT_FOUND') {
      res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
});

// GET /v1/accounts/:accountId/history
router.get('/v1/accounts/:accountId/history', async (req, res) => {
  try {
    const result = await getHistory({
      accountId: req.params.accountId,
      from: req.query.from as string,
      to: req.query.to as string,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
});

// GET /v1/accounts/:accountId/usage
router.get('/v1/accounts/:accountId/usage', async (req, res) => {
  try {
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const result = await getUsage(req.params.accountId, month);
    if (!result) {
      res.status(404).json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
  }
});

export default router;
