/**
 * Price Plan CRUD service — P1-3 Pricing Authority.
 *
 * Manages the lifecycle of llm_model_price_plans: create (draft) → update (CAS)
 * → publish (auto-revokes prior published plan for same model) → revoke.
 * SKUs are stored both as a JSONB column on the plans table (for the admin API)
 * and synced to llm_model_price_items (for the resolver in llm-usage.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { PricingSkuV1 } from '../domain/llm-pricing.js';
import { PricingSkuV1Schema } from '../domain/llm-pricing.js';

export interface PricePlanRecord {
  id: string;
  providerModelId: string | null;
  legacyProvider: string | null;
  legacyModel: string | null;
  currency: string;
  unitScale: string;
  status: 'draft' | 'published' | 'revoked';
  version: number;
  revision: number;
  publishedAt: string | null;
  revokedAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PricePlanWithSkus extends PricePlanRecord {
  skus: PricingSkuV1[];
}

export class StaleRevisionError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`STALE_REVISION: expected ${expected}, got ${actual}`);
    this.name = 'StaleRevisionError';
  }
}

export class PlanNotFoundError extends Error {
  constructor(public planId: string) {
    super(`Plan "${planId}" not found`);
    this.name = 'PlanNotFoundError';
  }
}

export class InvalidPlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanStateError';
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function providerInstanceId(provider: string): string {
  return stableId('lpi', `v1\0${provider}`);
}

function providerModelId(providerId: string, model: string): string {
  return stableId('lpm', `v1\0${providerId}\0${model}`);
}

function validateSkus(skus: unknown[]): PricingSkuV1[] {
  return skus.map((sku) => {
    const result = PricingSkuV1Schema.safeParse(sku);
    if (!result.success) {
      throw new Error(`Invalid SKU: ${result.error.message}`);
    }
    return result.data;
  });
}

function rowToRecord(row: Record<string, unknown>): PricePlanRecord {
  const status = String(row.status);
  const mappedStatus: 'draft' | 'published' | 'revoked' =
    status === 'published' ? 'published' :
    status === 'revoked' || status === 'disabled' ? 'revoked' : 'draft';
  return {
    id: String(row.id),
    providerModelId: row.provider_model_id ? String(row.provider_model_id) : null,
    legacyProvider: row.provider_key ? String(row.provider_key) : null,
    legacyModel: row.model_id ? String(row.model_id) : null,
    currency: String(row.currency),
    unitScale: String(row.unit_scale),
    status: mappedStatus,
    version: Number(row.version),
    revision: Number(row.revision),
    publishedAt: row.published_at ? String(row.published_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function itemsToSkus(items: Array<Record<string, unknown>>): PricingSkuV1[] {
  return items.map((item) => ({
    id: String(item.id),
    usageType: String(item.usage_type) as PricingSkuV1['usageType'],
    unitPrice: String(item.unit_price),
    priority: Number(item.priority),
    conditions: (item.conditions ?? {}) as PricingSkuV1['conditions'],
  }));
}

function skusToItems(skus: PricingSkuV1[], planId: string): Array<{ id: string; usageType: string; unitPrice: string; priority: number; conditions: PricingSkuV1['conditions'] }> {
  return skus.map((sku, index) => ({
    id: sku.id || stableId('lpi', `${planId}\0${index}`),
    usageType: sku.usageType,
    unitPrice: sku.unitPrice,
    priority: sku.priority,
    conditions: sku.conditions ?? {},
  }));
}

export class LlmPricingAdminService {
  constructor(private pool: pg.Pool) {}

  /**
   * List all price plans (with SKUs), ordered by provider/model/version.
   */
  async listPlans(): Promise<PricePlanWithSkus[]> {
    const { rows } = await this.pool.query(
      `SELECT p.*, COALESCE(json_agg(i.* ORDER BY i.priority DESC) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM llm_model_price_plans p
         LEFT JOIN llm_model_price_items i ON i.plan_id = p.id
        GROUP BY p.id
        ORDER BY p.provider_key, p.model_id, p.version DESC`,
    );
    return rows.map((row) => {
      const record = rowToRecord(row);
      const skusJsonb = Array.isArray(row.skus) && row.skus.length > 0
        ? (row.skus as unknown[])
        : [];
      const skus: PricingSkuV1[] = skusJsonb.length > 0
        ? validateSkus(skusJsonb)
        : itemsToSkus(row.items as Array<Record<string, unknown>>);
      return { ...record, skus };
    });
  }

  /**
   * Get a single price plan by ID (with SKUs).
   */
  async getPlan(id: string): Promise<PricePlanWithSkus | null> {
    const { rows } = await this.pool.query(
      `SELECT p.*, COALESCE(json_agg(i.* ORDER BY i.priority DESC) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM llm_model_price_plans p
         LEFT JOIN llm_model_price_items i ON i.plan_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [id],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const record = rowToRecord(row);
    const skusJsonb = Array.isArray(row.skus) && row.skus.length > 0
      ? (row.skus as unknown[])
      : [];
    const skus: PricingSkuV1[] = skusJsonb.length > 0
      ? validateSkus(skusJsonb)
      : itemsToSkus(row.items as Array<Record<string, unknown>>);
    return { ...record, skus };
  }

  /**
   * Create a new draft plan. SKUs are stored in the JSONB column and synced
   * to llm_model_price_items for resolver compatibility.
   */
  async createPlan(
    input: {
      providerModelId?: string;
      legacyProvider?: string;
      legacyModel?: string;
      currency: string;
      unitScale: string;
      skus: PricingSkuV1[];
    },
    createdBy: string | null,
  ): Promise<PricePlanRecord> {
    const skus = validateSkus(input.skus);
    if (skus.length === 0) {
      throw new InvalidPlanStateError('At least one SKU is required');
    }
    const currency = input.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidPlanStateError('currency must be a 3-letter ISO code');
    }
    const unitScale = Number(input.unitScale);
    if (!Number.isInteger(unitScale) || unitScale <= 0) {
      throw new InvalidPlanStateError('unitScale must be a positive integer');
    }

    // Determine provider/model identifiers
    const legacyProvider = input.legacyProvider ?? null;
    const legacyModel = input.legacyModel ?? null;
    let providerModelIdVal: string;
    let providerInstanceIdVal: string;
    let providerKey: string;
    let modelId: string;

    if (input.providerModelId) {
      // Stable ID provided directly — derive legacy ref from it if possible
      providerModelIdVal = input.providerModelId;
      providerInstanceIdVal = stableId('lpi', `v1\0${legacyProvider ?? 'unknown'}`);
      providerKey = legacyProvider ?? input.providerModelId;
      modelId = legacyModel ?? input.providerModelId;
    } else if (legacyProvider && legacyModel) {
      // Derive stable IDs from legacy provider/model
      providerInstanceIdVal = providerInstanceId(legacyProvider);
      providerModelIdVal = providerModelId(providerInstanceIdVal, legacyModel);
      providerKey = legacyProvider;
      modelId = legacyModel;
    } else {
      throw new InvalidPlanStateError(
        'Either providerModelId or (legacyProvider + legacyModel) must be provided',
      );
    }

    const planId = `lpp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const sourceKey = `admin:${planId}`;
    const skusJson = JSON.stringify(skus);
    const items = skusToItems(skus, planId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Determine the next version number for this provider_model_id
      const { rows: versionRows } = await client.query(
        'SELECT COALESCE(MAX(version), 0) AS max_version FROM llm_model_price_plans WHERE provider_model_id = $1',
        [providerModelIdVal],
      );
      const version = Number(versionRows[0].max_version) + 1;

      await client.query(
        `INSERT INTO llm_model_price_plans
           (id, provider_instance_id, provider_model_id, provider_key, model_id,
            version, status, currency, unit_scale, valid_from, source, source_key,
            contract_version, skus, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, '1970-01-01T00:00:00Z',
                 'admin', $9, 1, $10, 0, $11, NOW())`,
        [planId, providerInstanceIdVal, providerModelIdVal, providerKey, modelId,
         version, currency, unitScale, sourceKey, skusJson, createdBy],
      );

      // Sync SKUs to llm_model_price_items for resolver compatibility
      for (const item of items) {
        await client.query(
          `INSERT INTO llm_model_price_items (id, plan_id, usage_type, unit_price, priority, conditions)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [item.id, planId, item.usageType, item.unitPrice, item.priority, JSON.stringify(item.conditions)],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const created = await this.getPlan(planId);
    if (!created) throw new Error('Failed to read back created plan');
    const { skus: _skus, ...record } = created;
    return record;
  }

  /**
   * Update a plan's currency/unitScale/SKUs with CAS on revision.
   * Only draft plans can be updated.
   */
  async updatePlan(
    id: string,
    input: {
      currency?: string;
      unitScale?: string;
      skus?: PricingSkuV1[];
    },
    expectedRevision: number,
    updatedBy: string | null,
  ): Promise<PricePlanRecord> {
    const existing = await this.getPlan(id);
    if (!existing) throw new PlanNotFoundError(id);
    if (existing.status !== 'draft') {
      throw new InvalidPlanStateError(`Only draft plans can be updated (current: ${existing.status})`);
    }
    if (existing.revision !== expectedRevision) {
      throw new StaleRevisionError(expectedRevision, existing.revision);
    }

    const sets: string[] = [];
    const vals: unknown[] = [id, expectedRevision];
    let idx = 3;

    if (input.currency !== undefined) {
      const currency = input.currency.toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new InvalidPlanStateError('currency must be a 3-letter ISO code');
      }
      sets.push(`currency = $${idx++}`);
      vals.push(currency);
    }

    if (input.unitScale !== undefined) {
      const unitScale = Number(input.unitScale);
      if (!Number.isInteger(unitScale) || unitScale <= 0) {
        throw new InvalidPlanStateError('unitScale must be a positive integer');
      }
      sets.push(`unit_scale = $${idx++}`);
      vals.push(unitScale);
    }

    let skusToUpdate: PricingSkuV1[] | null = null;
    if (input.skus !== undefined) {
      skusToUpdate = validateSkus(input.skus);
      if (skusToUpdate.length === 0) {
        throw new InvalidPlanStateError('At least one SKU is required');
      }
      sets.push(`skus = $${idx++}`);
      vals.push(JSON.stringify(skusToUpdate));
    }

    sets.push('revision = revision + 1');
    sets.push('updated_by = $' + idx++);
    vals.push(updatedBy);
    sets.push('updated_at = NOW()');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE llm_model_price_plans SET ${sets.join(', ')}
         WHERE id = $1 AND revision = $2 RETURNING *`,
        vals,
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        const check = await this.pool.query('SELECT revision FROM llm_model_price_plans WHERE id = $1', [id]);
        if (check.rows.length === 0) throw new PlanNotFoundError(id);
        throw new StaleRevisionError(expectedRevision, Number(check.rows[0].revision));
      }

      // Sync SKUs to llm_model_price_items if provided
      if (skusToUpdate) {
        await client.query('DELETE FROM llm_model_price_items WHERE plan_id = $1', [id]);
        const items = skusToItems(skusToUpdate, id);
        for (const item of items) {
          await client.query(
            `INSERT INTO llm_model_price_items (id, plan_id, usage_type, unit_price, priority, conditions)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [item.id, id, item.usageType, item.unitPrice, item.priority, JSON.stringify(item.conditions)],
          );
        }
      }

      await client.query('COMMIT');
      return rowToRecord(rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Publish a draft plan. Auto-revokes any existing published plan for the
   * same provider_model_id (or legacy provider/model ref).
   */
  async publishPlan(
    id: string,
    expectedRevision: number,
    publishedBy: string | null,
  ): Promise<PricePlanRecord> {
    const existing = await this.getPlan(id);
    if (!existing) throw new PlanNotFoundError(id);
    if (existing.status !== 'draft') {
      throw new InvalidPlanStateError(`Only draft plans can be published (current: ${existing.status})`);
    }
    if (existing.revision !== expectedRevision) {
      throw new StaleRevisionError(expectedRevision, existing.revision);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Auto-revoke any existing published plan for the same provider_model_id
      await client.query(
        `UPDATE llm_model_price_plans
         SET status = 'revoked', revoked_at = NOW(), revision = revision + 1, updated_at = NOW()
         WHERE provider_model_id = $1 AND status = 'published' AND id != $2`,
        [existing.providerModelId, id],
      );
      // Also check by legacy ref if provider_model_id is null
      if (existing.legacyProvider && existing.legacyModel) {
        await client.query(
          `UPDATE llm_model_price_plans
           SET status = 'revoked', revoked_at = NOW(), revision = revision + 1, updated_at = NOW()
           WHERE provider_key = $1 AND model_id = $2 AND status = 'published' AND id != $3
             AND (provider_model_id IS NULL OR provider_model_id != $4)`,
          [existing.legacyProvider, existing.legacyModel, id, existing.providerModelId],
        );
      }

      const { rows } = await client.query(
        `UPDATE llm_model_price_plans
         SET status = 'published', published_at = NOW(),
             valid_from = NOW(), revision = revision + 1, updated_by = $3, updated_at = NOW()
         WHERE id = $1 AND revision = $2 AND status = 'draft'
         RETURNING *`,
        [id, expectedRevision, publishedBy],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        const check = await this.pool.query('SELECT revision, status FROM llm_model_price_plans WHERE id = $1', [id]);
        if (check.rows.length === 0) throw new PlanNotFoundError(id);
        throw new StaleRevisionError(expectedRevision, Number(check.rows[0].revision));
      }

      await client.query('COMMIT');
      return rowToRecord(rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revoke a published plan.
   */
  async revokePlan(
    id: string,
    expectedRevision: number,
    revokedBy: string | null,
  ): Promise<PricePlanRecord> {
    const existing = await this.getPlan(id);
    if (!existing) throw new PlanNotFoundError(id);
    if (existing.status !== 'published') {
      throw new InvalidPlanStateError(`Only published plans can be revoked (current: ${existing.status})`);
    }
    if (existing.revision !== expectedRevision) {
      throw new StaleRevisionError(expectedRevision, existing.revision);
    }

    const { rows } = await this.pool.query(
      `UPDATE llm_model_price_plans
       SET status = 'revoked', revoked_at = NOW(),
           valid_to = NOW(), revision = revision + 1, updated_by = $3, updated_at = NOW()
       WHERE id = $1 AND revision = $2 AND status = 'published'
       RETURNING *`,
      [id, expectedRevision, revokedBy],
    );
    if (rows.length === 0) {
      const check = await this.pool.query('SELECT revision, status FROM llm_model_price_plans WHERE id = $1', [id]);
      if (check.rows.length === 0) throw new PlanNotFoundError(id);
      throw new StaleRevisionError(expectedRevision, Number(check.rows[0].revision));
    }
    return rowToRecord(rows[0]);
  }

  /**
   * Get the active published plan for a stable provider_model_id.
   */
  async getActivePlanForModel(providerModelId: string): Promise<PricePlanWithSkus | null> {
    const { rows } = await this.pool.query(
      `SELECT p.*, COALESCE(json_agg(i.* ORDER BY i.priority DESC) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM llm_model_price_plans p
         LEFT JOIN llm_model_price_items i ON i.plan_id = p.id
        WHERE p.provider_model_id = $1 AND p.status = 'published'
          AND p.valid_from <= NOW() AND (p.valid_to IS NULL OR p.valid_to > NOW())
        GROUP BY p.id`,
      [providerModelId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const record = rowToRecord(row);
    const skusJsonb = Array.isArray(row.skus) && row.skus.length > 0
      ? (row.skus as unknown[])
      : [];
    const skus: PricingSkuV1[] = skusJsonb.length > 0
      ? validateSkus(skusJsonb)
      : itemsToSkus(row.items as Array<Record<string, unknown>>);
    return { ...record, skus };
  }

  /**
   * Get the active published plan by legacy provider/model ref.
   */
  async getActivePlanForLegacyRef(provider: string, model: string): Promise<PricePlanWithSkus | null> {
    const { rows } = await this.pool.query(
      `SELECT p.*, COALESCE(json_agg(i.* ORDER BY i.priority DESC) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM llm_model_price_plans p
         LEFT JOIN llm_model_price_items i ON i.plan_id = p.id
        WHERE p.provider_key = $1 AND p.model_id = $2 AND p.status = 'published'
          AND p.valid_from <= NOW() AND (p.valid_to IS NULL OR p.valid_to > NOW())
        GROUP BY p.id`,
      [provider, model],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const record = rowToRecord(row);
    const skusJsonb = Array.isArray(row.skus) && row.skus.length > 0
      ? (row.skus as unknown[])
      : [];
    const skus: PricingSkuV1[] = skusJsonb.length > 0
      ? validateSkus(skusJsonb)
      : itemsToSkus(row.items as Array<Record<string, unknown>>);
    return { ...record, skus };
  }
}

/**
 * Delta threshold for drift alerts — 1% relative difference.
 */
export const DELTA_THRESHOLD = 0.01;

/**
 * Record a drift alert if the delta between legacy and new pricing
 * exceeds the threshold ratio.
 */
export async function recordDriftAlert(
  pool: pg.Pool,
  params: {
    usageEventId: string;
    legacyAmount: string | null;
    newAmount: string | null;
    deltaAmount: string | null;
    provider: string;
    model: string;
  },
): Promise<void> {
  const { legacyAmount, newAmount, deltaAmount } = params;
  if (legacyAmount === null || newAmount === null || deltaAmount === null) return;
  const legacy = Number(legacyAmount);
  if (!Number.isFinite(legacy) || legacy <= 0) return;
  const delta = Number(deltaAmount);
  if (!Number.isFinite(delta)) return;
  const deltaRatio = Math.abs(delta / legacy);
  if (deltaRatio > DELTA_THRESHOLD) {
    await pool.query(
      `INSERT INTO llm_pricing_drift_alerts
         (usage_event_id, legacy_amount, new_amount, delta_amount, delta_threshold, provider, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [params.usageEventId, legacyAmount, newAmount, deltaAmount, DELTA_THRESHOLD, params.provider, params.model],
    );
  }
}
