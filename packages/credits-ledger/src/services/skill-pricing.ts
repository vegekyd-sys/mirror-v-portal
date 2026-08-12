import { query } from '../db/pool.js';

export interface SkillPrice {
  skillId: string;
  skillName: string;
  description: string | null;
  category: string;
  creditPerUnit: number;
  billingUnit: string;
  status: 'live' | 'shadow' | 'disabled';
  billingMode: 'live' | 'shadow' | 'disabled';
  responsiblePerson: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function rowToSkillPrice(r: any): SkillPrice {
  return {
    skillId: r.skill_id,
    skillName: r.skill_name,
    description: r.description,
    category: r.category,
    creditPerUnit: Number(r.credit_per_unit),
    billingUnit: r.billing_unit,
    status: r.status,
    billingMode: r.status,
    responsiblePerson: r.responsible_person ?? null,
    sortOrder: Number(r.sort_order),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Default category fallback pricing when a specific skill_id is not found */
const CATEGORY_DEFAULTS: Record<string, number> = {
  buyer: 300,
  insight: 5000,
  outreach: 80,
  exhibition: 300,
  admin: 100,
};
const GLOBAL_DEFAULT = 100;

/**
 * Get price for a skill. Falls back to category default if no exact match.
 * Returns null only if category is unknown and no global default exists.
 */
export async function getSkillPrice(skillId: string): Promise<{
  skillId: string;
  skillName: string;
  creditPerUnit: number;
  billingUnit: string;
  category: string;
  pricingStatus: 'live' | 'shadow';
  isDefault: boolean;
} | null> {
  const { rows } = await query(
    'SELECT * FROM skill_prices WHERE skill_id = $1 AND status != $2',
    [skillId, 'disabled']
  );
  if (rows.length > 0) {
    const p = rowToSkillPrice(rows[0]);
    return {
      skillId: p.skillId,
      skillName: p.skillName,
      creditPerUnit: p.creditPerUnit,
      billingUnit: p.billingUnit,
      category: p.category,
      pricingStatus: p.status === 'shadow' ? 'shadow' : 'live',
      isDefault: false,
    };
  }

  // Try category-level default
  const category = skillId.split('.')[0] ?? 'other';
  const defaultCredit = CATEGORY_DEFAULTS[category] ?? GLOBAL_DEFAULT;

  return {
    skillId,
    skillName: `${skillId} (默认定价)`,
    creditPerUnit: defaultCredit,
    billingUnit: 'per_item',
    category,
    pricingStatus: 'live' as const,
    isDefault: true,
  };
}

/**
 * Estimate credit for a skill action.
 * Returns total credit needed and breakdown.
 */
export async function estimateCost(
  skillId: string,
  quantity: number
): Promise<{ totalCredit: number; unitPrice: number; skillName: string; isDefault: boolean }> {
  const price = await getSkillPrice(skillId);
  if (!price) {
    throw new Error(`Unknown skill: ${skillId}`);
  }
  return {
    totalCredit: price.creditPerUnit * quantity,
    unitPrice: price.creditPerUnit,
    skillName: price.skillName,
    isDefault: price.isDefault,
  };
}

/** List all prices, optionally filtered by category */
export async function listPrices(category?: string): Promise<SkillPrice[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    conditions.push(`category = $${params.length + 1}`);
    params.push(category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM skill_prices ${where} ORDER BY sort_order ASC, skill_id ASC`,
    params
  );
  return rows.map(rowToSkillPrice);
}

/** Upsert a skill price */
export async function upsertPrice(params: {
  skillId: string;
  skillName: string;
  description?: string;
  category: string;
  creditPerUnit: number;
  billingUnit?: string;
  status?: string;
  responsiblePerson?: string;
  sortOrder?: number;
  changedBy?: string;
}): Promise<{ price: SkillPrice; logId?: number }> {
  // Log old price before update
  const { rows: oldRows } = await query(
    'SELECT credit_per_unit FROM skill_prices WHERE skill_id = $1',
    [params.skillId]
  );
  const oldCredit = oldRows.length > 0 ? Number(oldRows[0].credit_per_unit) : null;

  const { rows } = await query(
    `INSERT INTO skill_prices (skill_id, skill_name, description, category, credit_per_unit, billing_unit, status, responsible_person, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (skill_id) DO UPDATE SET
       skill_name = EXCLUDED.skill_name,
       description = EXCLUDED.description,
       category = EXCLUDED.category,
       credit_per_unit = EXCLUDED.credit_per_unit,
       billing_unit = EXCLUDED.billing_unit,
       status = EXCLUDED.status,
       responsible_person = EXCLUDED.responsible_person,
       sort_order = EXCLUDED.sort_order,
       updated_at = NOW()
     RETURNING *`,
    [
      params.skillId,
      params.skillName,
      params.description ?? null,
      params.category,
      params.creditPerUnit,
      params.billingUnit ?? 'per_item',
      params.status ?? 'live',
      params.responsiblePerson ?? null,
      params.sortOrder ?? 0,
    ]
  );

  // Record price change in log
  let logId: number | undefined;
  if (oldCredit !== null && oldCredit !== params.creditPerUnit) {
    const logResult = await query(
      `INSERT INTO price_change_log (skill_id, old_credit, new_credit, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [params.skillId, oldCredit, params.creditPerUnit, params.changedBy ?? 'admin', `Price updated from ${oldCredit} → ${params.creditPerUnit}`]
    );
    logId = logResult.rows[0].id;
  }

  return { price: rowToSkillPrice(rows[0]), logId };
}

/** Get price change history for a skill */
export async function getPriceHistory(skillId: string, limit = 20) {
  const { rows } = await query(
    'SELECT * FROM price_change_log WHERE skill_id = $1 ORDER BY created_at DESC LIMIT $2',
    [skillId, limit]
  );
  return rows.map((r: any) => ({
    id: r.id,
    skillId: r.skill_id,
    oldCredit: r.old_credit ? Number(r.old_credit) : null,
    newCredit: Number(r.new_credit),
    changedBy: r.changed_by,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/** Delete a skill price (set to disabled rather than hard delete) */
export async function disablePrice(skillId: string): Promise<boolean> {
  const { rowCount } = await query(
    "UPDATE skill_prices SET status = 'disabled', updated_at = NOW() WHERE skill_id = $1",
    [skillId]
  );
  return (rowCount ?? 0) > 0;
}

/** Get a category summary with price ranges */
export async function getCategorySummary() {
  const { rows } = await query(
    `SELECT category,
            COUNT(*) as skill_count,
            MIN(credit_per_unit) as min_price,
            MAX(credit_per_unit) as max_price,
            COUNT(*) FILTER (WHERE status = 'live') as live_count,
            COUNT(*) FILTER (WHERE status = 'shadow') as shadow_count
     FROM skill_prices
     GROUP BY category
     ORDER BY category`
  );
  return rows.map((r: any) => ({
    category: r.category,
    skillCount: Number(r.skill_count),
    minPrice: Number(r.min_price),
    maxPrice: Number(r.max_price),
    liveCount: Number(r.live_count),
    shadowCount: Number(r.shadow_count),
  }));
}
