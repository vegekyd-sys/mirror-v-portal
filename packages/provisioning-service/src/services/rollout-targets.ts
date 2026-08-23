/**
 * Promoted rollout targets — single source of truth for which image tag a
 * freshly provisioned Deployment should run.
 *
 * Flow (see routes/admin-ops.ts): registry sync fills image_releases → an
 * operator promotes a tag (POST /v1/admin/image-releases/promote) →
 * rollout_targets row is updated → ops-agent rolls the existing fleet, and
 * provisionTenant / bindTenantFeishuApp read the same row so NEW tenants
 * come up on the same version the fleet runs (no more static env tags).
 *
 * env vars (NEXUS_GATEWAY_IMAGE_TAG / DEALCLAW_AGENT_IMAGE_TAG) remain the
 * fallback when nothing has been promoted yet.
 */
import type pg from 'pg';

/** Anything that can run parameterized SQL queries (pg.Pool in prod, fakes in tests). */
export type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Promoted rollout target tag for a service, or null when nothing is
 * promoted (or the query fails — a DB hiccup must never block tenant
 * provisioning; callers fall back to their env-configured tag).
 */
export async function getPromotedTag(
  pool: Queryable | undefined,
  service: string,
): Promise<string | null> {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      'SELECT tag FROM rollout_targets WHERE service = $1 LIMIT 1',
      [service],
    );
    return rows.length ? String(rows[0].tag) : null;
  } catch {
    return null;
  }
}
