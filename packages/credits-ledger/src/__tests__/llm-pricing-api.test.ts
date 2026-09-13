import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db/pool.js', () => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
}));

import { getPool } from '../db/pool.js';
import router from '../routes/llm-pricing.js';
import express from 'express';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const originalPricingShadow = process.env.LLM_PRICING_SHADOW;

function restorePricingShadow(): void {
  if (originalPricingShadow === undefined) delete process.env.LLM_PRICING_SHADOW;
  else process.env.LLM_PRICING_SHADOW = originalPricingShadow;
}

afterEach(() => {
  vi.clearAllMocks();
  restorePricingShadow();
});

describe('LLM pricing shadow summary API', () => {
  it('restores the environment value captured before the suite', () => {
    process.env.LLM_PRICING_SHADOW = originalPricingShadow === 'changed-for-test'
      ? 'another-test-value'
      : 'changed-for-test';
    restorePricingShadow();
    expect(process.env.LLM_PRICING_SHADOW).toBe(originalPricingShadow);
  });

  it('is disabled when the shadow flag is not true', async () => {
    process.env.LLM_PRICING_SHADOW = 'false';
    const response = await request(createApp()).get('/v1/admin/llm-pricing/summary');
    expect(response.status).toBe(503);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('returns bounded summary and decimal strings', async () => {
    process.env.LLM_PRICING_SHADOW = 'true';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ plan_count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ resolved_count: '2', unknown_count: '1', conflict_count: '1', free_count: '1', pending_count: '0', legacy_comparison_count: '4', zero_delta_count: '3', nonzero_delta_count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ usage_event_id: 'event', tenant_id: 'tenant', provider: 'provider', model: 'model', status: 'resolved', amount: '1.230000000000', currency: 'CNY', legacy_amount: '1.000000000000', delta_amount: '0.230000000000', created_at: 'now' }] });
    vi.mocked(getPool).mockReturnValue({ query } as never);
    const response = await request(createApp()).get('/v1/admin/llm-pricing/summary?limit=999');
    expect(response.status).toBe(200);
    expect(response.body.planCount).toBe(3);
    expect(response.body.shadowStatuses).toEqual({ resolved: 2, unknown: 1, conflict: 1, free: 1, pending: 0 });
    expect(response.body.deltaCounts).toEqual({ zero: 3, nonzero: 1 });
    expect(response.body.deltaSamples[0].deltaAmount).toBe('0.230000000000');
    expect(query.mock.calls[2][1]).toEqual([100]);
  });

  it('does not expose database details', async () => {
    process.env.LLM_PRICING_SHADOW = 'true';
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockRejectedValue(new Error('postgres password=secret')) } as never);
    const response = await request(createApp()).get('/v1/admin/llm-pricing/summary');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(JSON.stringify(response.body)).not.toContain('postgres');
  });
});
