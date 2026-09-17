/**
 * Immutable Catalog Release domain types.
 *
 * A Release is an append-only record of a catalog snapshot at publish time.
 * It stores the encrypted canonical snapshot + compat payload (so the full
 * provider library can be reconstructed without re-reading the mutable
 * `llm_provider_instances` / `llm_provider_models` tables) along with a
 * fingerprint for fast equality checks and a diff summary for audit/display.
 *
 * The per-tenant `TenantReleaseStatusRecord` tracks the desired-vs-applied
 * state so the rollout worker can reconcile drift and report delivery status.
 */

/** Immutable Release record (maps 1:1 to `llm_catalog_releases` row). */
export interface CatalogReleaseRecord {
  id: string;
  version: number;
  parentId: string | null;
  /** AES-256-GCM encrypted canonical snapshot JSON. */
  canonicalSnapshot: string;
  /** AES-256-GCM encrypted compatibility payload JSON. */
  compatPayload: string;
  fingerprint: string;
  parentFingerprint: string | null;
  diffSummary: Record<string, unknown>;
  warnings: unknown[];
  actor: string | null;
  actorType: 'admin' | 'service';
  status: 'active' | 'superseded' | 'rolled-back';
  idempotencyKey: string | null;
  createdAt: Date;
}

/** Input for creating a new Release (caller provides encrypted snapshots). */
export interface CreateReleaseInput {
  parentReleaseId: string | null;
  parentFingerprint: string | null;
  /** AES-256-GCM encrypted canonical snapshot JSON. */
  canonicalSnapshot: string;
  /** AES-256-GCM encrypted compatibility payload JSON. */
  compatPayload: string;
  fingerprint: string;
  diffSummary: Record<string, unknown>;
  warnings: unknown[];
  actor: string | null;
  actorType: 'admin' | 'service';
  idempotencyKey?: string;
}

/** Public API view — never exposes encrypted snapshot/payload data. */
export interface CatalogReleaseView {
  id: string;
  version: number;
  parentId: string | null;
  fingerprint: string;
  parentFingerprint: string | null;
  diffSummary: Record<string, unknown>;
  warnings: unknown[];
  actor: string | null;
  actorType: 'admin' | 'service';
  status: string;
  createdAt: string;
}

/** Per-tenant desired/applied release status (maps to `llm_tenant_release_status`). */
export interface TenantReleaseStatusRecord {
  tenantId: string;
  desiredReleaseId: string | null;
  appliedReleaseId: string | null;
  appliedFingerprint: string | null;
  appliedAt: string | null;
  restartReason: string | null;
  deliveryStatus: 'pending' | 'delivered' | 'failed' | 'skipped' | 'unsupported' | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}
