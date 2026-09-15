import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmPricingAdminService,
  StaleRevisionError,
  PlanNotFoundError,
  InvalidPlanStateError,
  recordDriftAlert,
  DELTA_THRESHOLD,
} from '../services/llm-pricing-admin.js';
import type { PricingSkuV1 } from '../domain/llm-pricing.js';

/**
 * Fake pg.Pool that records calls and returns configurable results.
 * Both pool.query and client.query share the same results queue so that
 * transaction flows (BEGIN → ... → COMMIT) interleave correctly with
 * read-back queries on the pool.
 */
interface FakeQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
}

interface FakePoolConfig {
  /** Queue of query results — each .query() call shifts the next one. */
  results: FakeQueryResult[];
  /** All recorded calls for assertions. */
  calls: Array<{ text: string; params: unknown[] }>;
}

function createFakePool(config: FakePoolConfig): any {
  const sharedQuery = vi.fn(async (text: string, params?: unknown[]): Promise<FakeQueryResult> => {
    config.calls.push({ text, params: params ?? [] });
    const result = config.results.shift();
    if (!result) return { rows: [], rowCount: 0 };
    return result;
  });
  const pool: any = {
    query: sharedQuery,
    connect: vi.fn(() => {
      // Client shares the same results queue as the pool
      return {
        query: sharedQuery,
        release: vi.fn(() => {}),
      };
    }),
  };
  return pool;
}

const sampleSkus: PricingSkuV1[] = [
  { id: 'sku_input', usageType: 'input', unitPrice: '0.300000000000', priority: 0, conditions: {} },
  { id: 'sku_output', usageType: 'output', unitPrice: '27.000000000000', priority: 0, conditions: {} },
];

describe('LlmPricingAdminService', () => {
  let config: FakePoolConfig;
  let pool: any;

  beforeEach(() => {
    config = { results: [], calls: [] };
    pool = createFakePool(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createPlan', () => {
    it('creates a draft plan with SKUs stored as JSONB and synced to items', async () => {
      const readBackRow = {
        id: 'lpp_test001',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 0,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      // Flow: BEGIN → SELECT MAX(version) → INSERT plan → INSERT item1 → INSERT item2 → COMMIT → getPlan read-back
      config.results = [
        { rows: [] }, // BEGIN
        { rows: [{ max_version: 0 }] }, // SELECT MAX(version)
        { rows: [] }, // INSERT plan
        { rows: [] }, // INSERT item 1
        { rows: [] }, // INSERT item 2
        { rows: [] }, // COMMIT
        { rows: [readBackRow] }, // getPlan read-back (pool.query)
      ];
      const service = new LlmPricingAdminService(pool);
      const record = await service.createPlan(
        {
          legacyProvider: 'deepseek',
          legacyModel: 'deepseek-v4-pro',
          currency: 'CNY',
          unitScale: '1000000',
          skus: sampleSkus,
        },
        'tester',
      );
      expect(record.id).toBe('lpp_test001');
      expect(record.status).toBe('draft');
      expect(record.legacyProvider).toBe('deepseek');
      expect(record.legacyModel).toBe('deepseek-v4-pro');
      expect(record.providerModelId).toBeTruthy();
      expect(record.version).toBe(1);
      expect(record.revision).toBe(0);
    });

    it('rejects plan without providerModelId or legacy ref', async () => {
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.createPlan(
          { currency: 'CNY', unitScale: '1000000', skus: sampleSkus },
          null,
        ),
      ).rejects.toThrow(InvalidPlanStateError);
    });

    it('rejects empty SKUs', async () => {
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.createPlan(
          { legacyProvider: 'p', legacyModel: 'm', currency: 'CNY', unitScale: '1000000', skus: [] },
          null,
        ),
      ).rejects.toThrow(InvalidPlanStateError);
    });
  });

  describe('updatePlan', () => {
    it('updates plan fields with CAS on revision', async () => {
      const existingRow = {
        id: 'lpp_test001',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 0,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      const updatedRow = { ...existingRow, revision: 1, currency: 'USD', updated_at: '2026-01-02T00:00:00Z' };
      // Flow: getPlan(pool.query) → BEGIN → UPDATE RETURNING → DELETE items → INSERT item1 → INSERT item2 → COMMIT
      config.results = [
        { rows: [existingRow] }, // getPlan
        { rows: [] }, // BEGIN
        { rows: [updatedRow] }, // UPDATE RETURNING
        { rows: [] }, // DELETE items
        { rows: [] }, // INSERT item 1
        { rows: [] }, // INSERT item 2
        { rows: [] }, // COMMIT
      ];
      const service = new LlmPricingAdminService(pool);
      const record = await service.updatePlan(
        'lpp_test001',
        { currency: 'USD', skus: sampleSkus },
        0,
        'admin',
      );
      expect(record.currency).toBe('USD');
      expect(record.revision).toBe(1);
    });

    it('throws StaleRevisionError when revision does not match', async () => {
      const existingRow = {
        id: 'lpp_test001',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 5,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [existingRow] }];
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.updatePlan('lpp_test001', { currency: 'USD' }, 0, 'admin'),
      ).rejects.toThrow(StaleRevisionError);
    });

    it('rejects update on non-draft plan', async () => {
      const existingRow = {
        id: 'lpp_test001',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'published',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 1,
        published_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [existingRow] }];
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.updatePlan('lpp_test001', { currency: 'USD' }, 1, 'admin'),
      ).rejects.toThrow(InvalidPlanStateError);
    });
  });

  describe('publishPlan', () => {
    it('publishes a draft plan and auto-revokes existing published plan', async () => {
      const existingRow = {
        id: 'lpp_test002',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 2,
        revision: 0,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      const publishedRow = {
        ...existingRow,
        status: 'published',
        revision: 1,
        published_at: '2026-01-02T00:00:00Z',
        valid_from: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      };
      // Flow: getPlan(pool.query) → BEGIN → auto-revoke by providerModelId → auto-revoke by legacy ref → publish RETURNING → COMMIT
      config.results = [
        { rows: [existingRow] }, // getPlan
        { rows: [] }, // BEGIN
        { rows: [] }, // auto-revoke by provider_model_id
        { rows: [] }, // auto-revoke by legacy ref
        { rows: [publishedRow] }, // publish RETURNING
        { rows: [] }, // COMMIT
      ];
      const service = new LlmPricingAdminService(pool);
      const record = await service.publishPlan('lpp_test002', 0, 'admin');
      expect(record.status).toBe('published');
      expect(record.revision).toBe(1);
      expect(record.publishedAt).toBeTruthy();
    });

    it('throws StaleRevisionError on revision mismatch', async () => {
      const existingRow = {
        id: 'lpp_test002',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 2,
        revision: 3,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [existingRow] }];
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.publishPlan('lpp_test002', 0, 'admin'),
      ).rejects.toThrow(StaleRevisionError);
    });

    it('rejects publishing a non-draft plan', async () => {
      const existingRow = {
        id: 'lpp_test002',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'published',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 2,
        revision: 1,
        published_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [existingRow] }];
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.publishPlan('lpp_test002', 1, 'admin'),
      ).rejects.toThrow(InvalidPlanStateError);
    });
  });

  describe('revokePlan', () => {
    it('revokes a published plan', async () => {
      const revokedRow = {
        id: 'lpp_test003',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'revoked',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 2,
        published_at: '2026-01-01T00:00:00Z',
        revoked_at: '2026-01-03T00:00:00Z',
        updated_by: 'admin',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-03T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      const existingRow = { ...revokedRow, status: 'published', revision: 1, revoked_at: null };
      // Flow: getPlan(pool.query) → UPDATE RETURNING (pool.query, no transaction)
      config.results = [
        { rows: [existingRow] }, // getPlan
        { rows: [revokedRow] }, // UPDATE RETURNING
      ];
      const service = new LlmPricingAdminService(pool);
      const record = await service.revokePlan('lpp_test003', 1, 'admin');
      expect(record.status).toBe('revoked');
      expect(record.revokedAt).toBeTruthy();
      expect(record.revision).toBe(2);
    });

    it('rejects revoking a non-published plan', async () => {
      const existingRow = {
        id: 'lpp_test003',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'draft',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 0,
        published_at: null,
        revoked_at: null,
        updated_by: 'tester',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [existingRow] }];
      const service = new LlmPricingAdminService(pool);
      await expect(
        service.revokePlan('lpp_test003', 0, 'admin'),
      ).rejects.toThrow(InvalidPlanStateError);
    });
  });

  describe('getActivePlanForModel', () => {
    it('returns the active published plan for a stable providerModelId', async () => {
      const planRow = {
        id: 'lpp_active001',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'published',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 1,
        published_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
        updated_by: 'admin',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: sampleSkus,
        items: [],
      };
      config.results = [{ rows: [planRow] }];
      const service = new LlmPricingAdminService(pool);
      const plan = await service.getActivePlanForModel('lpm_abc');
      expect(plan).not.toBeNull();
      expect(plan!.id).toBe('lpp_active001');
      expect(plan!.status).toBe('published');
      expect(plan!.skus).toHaveLength(2);
    });

    it('returns null when no published plan exists', async () => {
      config.results = [{ rows: [] }];
      const service = new LlmPricingAdminService(pool);
      const plan = await service.getActivePlanForModel('lpm_nonexistent');
      expect(plan).toBeNull();
    });
  });

  describe('getActivePlanForLegacyRef', () => {
    it('returns the active published plan for a legacy provider/model', async () => {
      const planRow = {
        id: 'lpp_active002',
        provider_model_id: 'lpm_abc',
        provider_key: 'deepseek',
        model_id: 'deepseek-v4-pro',
        status: 'published',
        currency: 'CNY',
        unit_scale: 1000000,
        version: 1,
        revision: 1,
        published_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
        updated_by: 'admin',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        skus: [],
        items: [
          { id: 'item1', usage_type: 'input', unit_price: '0.300000000000', priority: 0, conditions: {} },
          { id: 'item2', usage_type: 'output', unit_price: '27.000000000000', priority: 0, conditions: {} },
        ],
      };
      config.results = [{ rows: [planRow] }];
      const service = new LlmPricingAdminService(pool);
      const plan = await service.getActivePlanForLegacyRef('deepseek', 'deepseek-v4-pro');
      expect(plan).not.toBeNull();
      expect(plan!.legacyProvider).toBe('deepseek');
      expect(plan!.legacyModel).toBe('deepseek-v4-pro');
      // SKUs should be populated from items (since skus JSONB is empty)
      expect(plan!.skus).toHaveLength(2);
      expect(plan!.skus[0].usageType).toBe('input');
    });
  });

  describe('recordDriftAlert', () => {
    it('records an alert when delta exceeds 1% threshold', async () => {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      const fakePool: any = {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          calls.push({ text, params: params ?? [] });
          return { rows: [], rowCount: 0 };
        }),
      };
      // legacy=100, new=102, delta=2 → ratio=0.02 > 0.01
      await recordDriftAlert(fakePool, {
        usageEventId: 'evt_001',
        legacyAmount: '100.000000000000',
        newAmount: '102.000000000000',
        deltaAmount: '2.000000000000',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].text).toContain('llm_pricing_drift_alerts');
      // params: usageEventId, legacyAmount, newAmount, deltaAmount, deltaThreshold, provider, model
      expect(calls[0].params[0]).toBe('evt_001');
      expect(calls[0].params[4]).toBe(DELTA_THRESHOLD);
    });

    it('does not record when delta is below threshold', async () => {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      const fakePool: any = {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          calls.push({ text, params: params ?? [] });
          return { rows: [], rowCount: 0 };
        }),
      };
      // legacy=100, new=100.005, delta=0.005 → ratio=0.00005 < 0.01
      await recordDriftAlert(fakePool, {
        usageEventId: 'evt_002',
        legacyAmount: '100.000000000000',
        newAmount: '100.005000000000',
        deltaAmount: '0.005000000000',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(calls).toHaveLength(0);
    });

    it('does not record when legacyAmount is null', async () => {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      const fakePool: any = {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          calls.push({ text, params: params ?? [] });
          return { rows: [], rowCount: 0 };
        }),
      };
      await recordDriftAlert(fakePool, {
        usageEventId: 'evt_003',
        legacyAmount: null,
        newAmount: '100.000000000000',
        deltaAmount: null,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(calls).toHaveLength(0);
    });

    it('does not record when legacyAmount is zero', async () => {
      const calls: Array<{ text: string; params: unknown[] }> = [];
      const fakePool: any = {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          calls.push({ text, params: params ?? [] });
          return { rows: [], rowCount: 0 };
        }),
      };
      await recordDriftAlert(fakePool, {
        usageEventId: 'evt_004',
        legacyAmount: '0.000000000000',
        newAmount: '1.000000000000',
        deltaAmount: '1.000000000000',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('getPlan', () => {
    it('returns null for a non-existent plan', async () => {
      config.results = [{ rows: [] }];
      const service = new LlmPricingAdminService(pool);
      const plan = await service.getPlan('lpp_nonexistent');
      expect(plan).toBeNull();
    });
  });
});
