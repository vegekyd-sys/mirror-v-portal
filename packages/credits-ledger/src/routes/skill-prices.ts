import { Router } from 'express';
import {
  listPrices,
  upsertPrice,
  disablePrice,
  getPriceHistory,
  getCategorySummary,
  estimateCost,
} from '../services/skill-pricing.js';

const router = Router();

// GET /v1/skill-prices — list all prices, optional ?category= / ?skillId= filter
router.get('/v1/skill-prices', async (req, res) => {
  try {
    const category = req.query.category as string | undefined;
    const skillId = req.query.skillId as string | undefined;
    const allPrices = await listPrices(category);

    // Filter by skillId if provided (exact match)
    const prices = skillId
      ? allPrices.filter(p => p.skillId === skillId)
      : allPrices;

    const summary = await getCategorySummary();
    res.json({ prices, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Failed to list prices' });
  }
});

// GET /v1/skill-prices/summary — category-level summary only
router.get('/v1/skill-prices/summary', async (req, res) => {
  try {
    const summary = await getCategorySummary();
    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/skill-prices/:skillId — get a single price
router.get('/v1/skill-prices/:skillId', async (req, res) => {
  try {
    const prices = await listPrices();
    const price = prices.find(p => p.skillId === req.params.skillId);
    if (!price) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Skill price not found' });
      return;
    }
    const history = await getPriceHistory(req.params.skillId);
    res.json({ price, history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// GET /v1/skill-prices/:skillId/history — price change log
router.get('/v1/skill-prices/:skillId/history', async (req, res) => {
  try {
    const history = await getPriceHistory(req.params.skillId);
    res.json({ skillId: req.params.skillId, history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// PUT /v1/skill-prices/:skillId — create or update a price
router.put('/v1/skill-prices/:skillId', async (req, res) => {
  try {
    const { skillName, description, category, creditPerUnit, billingUnit, status, sortOrder, changedBy } = req.body;
    if (!skillName || !category || typeof creditPerUnit !== 'number' || creditPerUnit < 0) {
      res.status(400).json({
        code: 'VALIDATION',
        message: 'skillName, category, and creditPerUnit (non-negative number) are required',
      });
      return;
    }

    const result = await upsertPrice({
      skillId: req.params.skillId,
      skillName,
      description,
      category,
      creditPerUnit: Math.floor(creditPerUnit),
      billingUnit,
      status,
      sortOrder,
      changedBy: changedBy ?? 'admin',
    });

    res.json({
      ok: true,
      price: result.price,
      logId: result.logId,
      message: result.logId ? 'Price updated (change logged)' : 'Price created',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// DELETE /v1/skill-prices/:skillId — disable a price
router.delete('/v1/skill-prices/:skillId', async (req, res) => {
  try {
    const ok = await disablePrice(req.params.skillId);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Skill price not found' });
      return;
    }
    res.json({ ok: true, message: 'Price disabled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

// POST /v1/skill-prices/estimate — estimate cost for a skill
router.post('/v1/skill-prices/estimate', async (req, res) => {
  try {
    const { skillId, quantity } = req.body;
    if (!skillId || !quantity) {
      res.status(400).json({ code: 'VALIDATION', message: 'skillId and quantity required' });
      return;
    }
    const result = await estimateCost(skillId, Number(quantity));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 'INTERNAL' });
  }
});

export default router;
