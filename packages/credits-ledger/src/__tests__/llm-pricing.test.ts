import { describe, expect, it } from 'vitest';
import type { PricePlanV1 } from '../domain/llm-pricing.js';
import { calculatePricingAmount, LlmPricingService, matchesPricingCondition, subtractPricingAmounts } from '../services/llm-pricing.js';

const plan: PricePlanV1 = {
  id: 'plan_1', currency: 'CNY', unitScale: '1000000',
  skus: [
    { id: 'input', usageType: 'input', unitPrice: '0.300000000000', priority: 0, conditions: {} },
    { id: 'output', usageType: 'output', unitPrice: '27.000000000000', priority: 0, conditions: {} },
  ],
};

describe('LlmPricingService', () => {
  it('calculates with decimal strings without floating point loss', async () => {
    const service = new LlmPricingService({ findPublishedPlans: async () => [plan] });
    const result = await service.resolve({
      provider: 'deepseek', model: 'v4', occurredAt: new Date('2026-09-01T00:00:00Z'),
      usage: { inputTokens: '1000001', outputTokens: '3' },
    });
    expect(result).toMatchObject({ status: 'resolved', amount: '0.300081300000', currency: 'CNY' });
  });

  it('distinguishes unknown, conflict and explicit free', async () => {
    const input = { provider: 'p', model: 'm', occurredAt: new Date(), usage: { inputTokens: '1', outputTokens: '0' } };
    expect((await new LlmPricingService({ findPublishedPlans: async () => [] }).resolve(input)).status).toBe('unknown');
    expect((await new LlmPricingService({ findPublishedPlans: async () => [plan, plan] }).resolve(input)).status).toBe('conflict');
    const free = { ...plan, skus: [{ ...plan.skus[0], unitPrice: '0' }] };
    expect((await new LlmPricingService({ findPublishedPlans: async () => [free] }).resolve(input)).status).toBe('free');
  });

  it('does not classify zero usage on a paid plan as explicitly free', async () => {
    const service = new LlmPricingService({ findPublishedPlans: async () => [plan] });
    const result = await service.resolve({
      provider: 'p',
      model: 'm',
      occurredAt: new Date(),
      usage: { inputTokens: '0', outputTokens: '0' },
    });

    expect(result).toMatchObject({
      status: 'resolved',
      amount: '0.000000000000',
    });
  });

  it('uses fixed-point BigInt arithmetic with half-up rounding and signed deltas', () => {
    expect(calculatePricingAmount([{ id:'x',usageType:'input',unitPrice:'0.000000000001',priority:0,conditions:{} }],{inputTokens:'500000',outputTokens:'0'},'1000000')).toBe('0.000000000001');
    expect(subtractPricingAmounts('1.000000000000','1.250000000000')).toBe('-0.250000000000');
  });

  it('uses half-open Asia/Shanghai time windows', () => {
    const condition = { timezone: 'Asia/Shanghai', weekdays: [1], startTime: '09:00', endTime: '12:00' };
    expect(matchesPricingCondition(condition, new Date('2026-09-07T01:00:00Z'), undefined)).toBe(true);
    expect(matchesPricingCondition(condition, new Date('2026-09-07T04:00:00Z'), undefined)).toBe(false);
  });
});
