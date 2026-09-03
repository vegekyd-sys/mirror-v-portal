/**
 * Per-tenant image overrides ("pins") — lets the admin console lock a single
 * tenant's Deployment to a specific image so the ops-agent rollout cron skips
 * it (instead of reverting it to the globally promoted rollout_target).
 *
 * Semantics:
 *   - No row  → the tenant follows the fleet (promoted tag).
 *   - A row   → the tenant is pinned to `image`.
 *
 * Backing table: tenant_image_overrides (see db/migrate.ts).
 */
import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'>;

export interface ImageOverride {
  tenantId: string;
  service: string;
  image: string;
}

/**
 * Load every override for a service into a Map<tenantId, image> — used by the
 * batch rollout endpoint so it can skip pinned tenants with a single query
 * (rather than N per-tenant lookups every 10 minutes).
 */
export async function getOverrideMap(
  pool: Queryable,
  service: string,
): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    'SELECT tenant_id, image FROM tenant_image_overrides WHERE service = $1',
    [service],
  );
  return new Map(rows.map((r: any) => [String(r.tenant_id), String(r.image)]));
}

/** Read a single tenant's pinned image for a service, or null when not pinned. */
export async function getOverride(
  pool: Queryable | undefined,
  tenantId: string,
  service: string,
): Promise<string | null> {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      'SELECT image FROM tenant_image_overrides WHERE tenant_id = $1 AND service = $2 LIMIT 1',
      [tenantId, service],
    );
    return rows.length ? String(rows[0].image) : null;
  } catch {
    return null;
  }
}

/** Pin a tenant's service to `image` (upsert). */export async function setOverride(
  pool: Queryable,
  override: ImageOverride & { updatedBy?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_image_overrides (tenant_id, service, image, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (tenant_id, service)
       DO UPDATE SET image = EXCLUDED.image, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [override.tenantId, override.service, override.image, override.updatedBy ?? null],
  );
}

/** Remove a pin so the tenant follows the fleet again. */
export async function clearOverride(
  pool: Queryable,
  tenantId: string,
  service: string,
): Promise<void> {
  await pool.query(
    'DELETE FROM tenant_image_overrides WHERE tenant_id = $1 AND service = $2',
    [tenantId, service],
  );
}

/** Read a single tenant's overrides for all services (for the runtime view). */
export async function listOverrides(
  pool: Queryable,
  tenantId: string,
): Promise<ImageOverride[]> {
  const { rows } = await pool.query(
    'SELECT tenant_id, service, image FROM tenant_image_overrides WHERE tenant_id = $1 ORDER BY service',
    [tenantId],
  );
  return rows.map((r: any) => ({
    tenantId: String(r.tenant_id),
    service: String(r.service),
    image: String(r.image),
  }));
}
