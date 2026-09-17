/**
 * Catalog drift detector (P0-5).
 *
 * Compares the current runtime LLM_PROVIDERS fingerprint against:
 * 1. The pure Catalog snapshot fingerprint (built from llm_provider_instances
 *    + llm_provider_models + llm_global_model_policy — no legacy JSON).
 * 2. The last published Release fingerprint (llm_catalog_releases).
 *
 * If any two differ, drift has occurred — most likely from a break-glass
 * write that bypassed the Catalog authority and edited Legacy JSON directly.
 * The admin UI uses this to flag "reconcile needed" and block further
 * publishes until the Catalog is brought back in sync.
 */

import type pg from 'pg';
import { snapshotFingerprint } from './model-catalog.js';
import { CatalogRepository, CatalogService } from './model-catalog.js';
import { getGlobalLlmProviders } from './llm-providers.js';

export interface DriftCheckResult {
  /** True if any two of the three fingerprints differ. */
  driftDetected: boolean;
  /** Fingerprint of the current runtime LLM_PROVIDERS (legacy JSON), or null if unset. */
  legacyFingerprint: string | null;
  /** Fingerprint of the pure Catalog snapshot (from structured tables). */
  catalogFingerprint: string | null;
  /** Fingerprint of the last published Release, or null if none exists. */
  lastReleaseFingerprint: string | null;
  /** Human-readable explanations for each detected mismatch. */
  details: string[];
}

/**
 * Compare the current runtime LLM_PROVIDERS fingerprint against the pure
 * Catalog snapshot fingerprint and the last published Release fingerprint.
 *
 * If any differ, drift has occurred (likely from a break-glass write that
 * bypassed the Catalog authority).
 */
export async function checkCatalogDrift(pool: pg.Pool): Promise<DriftCheckResult> {
  const details: string[] = [];

  // Get legacy runtime config (the encrypted LLM_PROVIDERS row).
  const legacy = await getGlobalLlmProviders(pool);
  const legacyFingerprint = legacy ? snapshotFingerprint(legacy) : null;

  // Get pure catalog snapshot (from structured tables only — no legacy JSON).
  const repo = new CatalogRepository(pool);
  const service = new CatalogService(repo);
  let catalogFingerprint: string | null = null;
  try {
    const catalogSnapshot = await service.buildCatalogSnapshot();
    catalogFingerprint = snapshotFingerprint(catalogSnapshot);
  } catch (err) {
    details.push(`Catalog snapshot build failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Get last release fingerprint.
  const { rows } = await pool.query(
    `SELECT fingerprint FROM llm_catalog_releases
     WHERE status = 'active'
     ORDER BY version DESC LIMIT 1`,
  );
  const lastReleaseFingerprint = rows[0]?.fingerprint ?? null;

  // Compare all three fingerprints pairwise.
  let driftDetected = false;

  if (catalogFingerprint && lastReleaseFingerprint && catalogFingerprint !== lastReleaseFingerprint) {
    driftDetected = true;
    details.push(
      `Catalog snapshot fingerprint (${catalogFingerprint}) != last Release fingerprint (${lastReleaseFingerprint})`,
    );
  }

  if (legacyFingerprint && lastReleaseFingerprint && legacyFingerprint !== lastReleaseFingerprint) {
    driftDetected = true;
    details.push(
      `Legacy runtime fingerprint (${legacyFingerprint}) != last Release fingerprint (${lastReleaseFingerprint})`,
    );
  }

  if (catalogFingerprint && legacyFingerprint && catalogFingerprint !== legacyFingerprint) {
    driftDetected = true;
    details.push(
      `Catalog snapshot fingerprint (${catalogFingerprint}) != Legacy runtime fingerprint (${legacyFingerprint})`,
    );
  }

  return { driftDetected, legacyFingerprint, catalogFingerprint, lastReleaseFingerprint, details };
}
