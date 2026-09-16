/**
 * Catalog Release Service — atomic publish & restore with immutable releases.
 *
 * Wraps the Release lifecycle (create, query, atomic publish/restore) in a
 * single service. The key innovation over the legacy snapshot-publish path is
 * `atomicPublish`: it performs Release creation, runtime_config upsert, backup
 * insertion, and push-task enqueue ALL inside one PostgreSQL transaction, so
 * a crash before COMMIT leaves no partial state — no orphaned config without
 * a push task, and no push task without a Release.
 *
 * CAS (compare-and-set): the caller passes `expectedParentFingerprint` — the
 * fingerprint of the current release at preview time. If another publish
 * landed in between, the current release's fingerprint will differ and the
 * transaction returns null (caller surfaces a 409 STALE_FINGERPRINT).
 *
 * Idempotency: if `idempotencyKey` is provided and a release with that key
 * already exists, the INSERT fails on the UNIQUE constraint and the service
 * returns the pre-existing release (no duplicate push task).
 */
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { encryptValue, decryptValue } from './crypto.js';
import { upsertRuntimeConfig, validateConfigValue } from './runtime-config.js';
import { getGlobalLlmProviders, validateLlmProviders, LLM_PROVIDERS_KEY } from './llm-providers.js';
import { snapshotFingerprint, CatalogRepository, CatalogService } from './model-catalog.js';
import { CatalogRolloutService, type ScopeType } from './catalog-rollout-service.js';
import { writeAuditLogStrict } from './audit.js';
import type { LlmProvidersConfig } from './llm-providers.js';
import type { ProvisioningConfig } from '../config.js';
import type {
  CatalogReleaseRecord,
  CatalogReleaseView,
  TenantReleaseStatusRecord,
} from '../domain/catalog-release.js';

/** Explicit rollout policy attached to a Release mutation. */
export type ReleaseRolloutPolicy =
  | { mode: 'no-rollout' }
  | { mode: 'rollout'; scopeType: ScopeType; tenantIds?: string[] };

/** Result of an atomic Release mutation. */
export interface CatalogReleaseMutationResult {
  release: CatalogReleaseView;
  taskId: string | null;
}

/** Raised when an idempotency key is reused for a different mutation. */
export class CatalogReleaseIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('Idempotency key was already used for a different release mutation');
    this.name = 'CatalogReleaseIdempotencyConflictError';
  }
}

/** Map a raw DB row (snake_case) to a CatalogReleaseRecord. */
function rowToRecord(row: Record<string, unknown>): CatalogReleaseRecord {
  return {
    id: String(row.id),
    version: Number(row.version),
    parentId: row.parent_id ? String(row.parent_id) : null,
    canonicalSnapshot: String(row.canonical_snapshot),
    compatPayload: String(row.compat_payload),
    fingerprint: String(row.fingerprint),
    parentFingerprint: row.parent_fingerprint ? String(row.parent_fingerprint) : null,
    diffSummary: row.diff_summary as Record<string, unknown>,
    warnings: row.warnings as unknown[],
    actor: row.actor ? String(row.actor) : null,
    actorType: row.actor_type as 'admin' | 'service',
    status: String(row.status) as 'active' | 'superseded' | 'rolled-back',
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** Map a raw DB row to a CatalogReleaseView (no encrypted fields). */
function rowToView(row: Record<string, unknown>): CatalogReleaseView {
  return {
    id: String(row.id),
    version: Number(row.version),
    parentId: row.parent_id ? String(row.parent_id) : null,
    fingerprint: String(row.fingerprint),
    parentFingerprint: row.parent_fingerprint ? String(row.parent_fingerprint) : null,
    diffSummary: row.diff_summary as Record<string, unknown>,
    warnings: row.warnings as unknown[],
    actor: row.actor ? String(row.actor) : null,
    actorType: row.actor_type as 'admin' | 'service',
    status: String(row.status),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

/** Map a raw DB row to a TenantReleaseStatusRecord. */
function rowToTenantStatus(row: Record<string, unknown>): TenantReleaseStatusRecord {
  return {
    tenantId: String(row.tenant_id),
    desiredReleaseId: row.desired_release_id ? String(row.desired_release_id) : null,
    appliedReleaseId: row.applied_release_id ? String(row.applied_release_id) : null,
    appliedFingerprint: row.applied_fingerprint ? String(row.applied_fingerprint) : null,
    appliedAt: row.applied_at
      ? (row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at))
      : null,
    restartReason: row.restart_reason ? String(row.restart_reason) : null,
    deliveryStatus: row.delivery_status ? String(row.delivery_status) as TenantReleaseStatusRecord['deliveryStatus'] : null,
    error: row.error ? String(row.error) : null,
    attempts: Number(row.attempts),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  };
}

export class CatalogReleaseService {
  private config: Pick<ProvisioningConfig, 'catalogProjectionFromAuthority'> | null = null;

  constructor(private pool: pg.Pool) {}

  /**
   * Inject provisioning config for feature-flag-gated behaviour.
   * When catalogProjectionFromAuthority is true, atomicPublish independently
   * builds the snapshot from the Catalog Authority rather than trusting the
   * caller-supplied snapshot.
   */
  setConfig(config: Pick<ProvisioningConfig, 'catalogProjectionFromAuthority'>): void {
    this.config = config;
  }

  /**
   * Build the canonical Authority snapshot used by atomicPublish and compare it
   * semantically with the current Legacy projection.
   */
  async buildAuthorityPreview(): Promise<{
    snapshot: LlmProvidersConfig;
    fingerprint: string;
    diff: Record<string, unknown>;
    expectedParentFingerprint: string | null;
  }> {
    const snapshot = await this.buildAuthoritySnapshot(this.pool);
    const fingerprint = snapshotFingerprint(snapshot);
    const legacy = await getGlobalLlmProviders(this.pool);
    const previous = legacy ?? {
      providers: [], defaultModel: null, imageModel: null,
      compactionModel: null, fallbackModels: [],
    };
    const catalogService = new CatalogService(new CatalogRepository(this.pool));
    const diff = catalogService.diffCompatibilitySnapshot(previous, snapshot);
    const currentReleaseId = await this.getCurrentReleaseId();
    const currentRelease = currentReleaseId ? await this.getRelease(currentReleaseId) : null;
    return {
      snapshot,
      fingerprint,
      diff: diff as unknown as Record<string, unknown>,
      expectedParentFingerprint: currentRelease?.fingerprint ?? null,
    };
  }

  /** Get the release_id pointed to by the 'current' pointer. */
  async getCurrentReleaseId(): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT release_id FROM llm_catalog_release_pointer WHERE id = 'current'`,
    );
    if (!rows.length || !rows[0].release_id) return null;
    return String(rows[0].release_id);
  }

  /** Get a release by id (full record, including encrypted fields). */
  async getRelease(id: string): Promise<CatalogReleaseRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_catalog_releases WHERE id = $1`,
      [id],
    );
    if (!rows.length) return null;
    return rowToRecord(rows[0]);
  }

  /** List the most recent N releases (public view, no encrypted data). */
  async listReleases(limit: number): Promise<CatalogReleaseView[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const { rows } = await this.pool.query(
      `SELECT id, version, parent_id, fingerprint, parent_fingerprint,
              diff_summary, warnings, actor, actor_type, status, created_at
       FROM llm_catalog_releases
       ORDER BY version DESC
       LIMIT $1`,
      [safeLimit],
    );
    return rows.map(rowToView);
  }

  /** Get per-tenant release status. */
  async getTenantReleaseStatus(tenantId: string): Promise<TenantReleaseStatusRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_tenant_release_status WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!rows.length) return null;
    return rowToTenantStatus(rows[0]);
  }

  /** List tenant release statuses for a given release (desired or applied). */
  async listTenantReleaseStatus(releaseId: string): Promise<TenantReleaseStatusRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_tenant_release_status
       WHERE desired_release_id = $1 OR applied_release_id = $1
       ORDER BY updated_at DESC`,
      [releaseId],
    );
    return rows.map(rowToTenantStatus);
  }

  /**
   * Atomic Publish: create a new immutable Release and update all dependent
   * state in a single DB transaction.
   *
   * Steps:
   *  1. BEGIN
   *  2. Lock runtime_configs row (FOR UPDATE)
   *  3. Read current runtime_config value as previous (for backup + push)
   *  4. CAS: compare expectedParentFingerprint with current release's fingerprint
   *  5. Create immutable Release (INSERT llm_catalog_releases)
   *  6. Mark old release as 'superseded'
   *  7. Update current pointer
   *  8. Write backup (source_fingerprint = old value fingerprint)
   *  9. Upsert runtime_config (new snapshot)
   * 10. enqueueLlmPush(client, ...) — on the transaction client, not the pool
   * 11. COMMIT
   *
   * Returns null on CAS failure. On idempotency conflict, returns the
   * pre-existing release.
   */
  async atomicPublish(params: {
    expectedParentFingerprint: string | null;
    snapshot: LlmProvidersConfig;
    fingerprint: string;
    diffSummary: Record<string, unknown>;
    warnings: unknown[];
    actor: string | null;
    actorType: 'admin' | 'service';
    idempotencyKey?: string;
    rollout?: ReleaseRolloutPolicy;
  }): Promise<CatalogReleaseMutationResult | null> {
    const {
      expectedParentFingerprint,
      snapshot,
      fingerprint,
      diffSummary,
      warnings,
      actor,
      actorType,
      idempotencyKey,
      rollout = { mode: 'rollout', scopeType: 'full' },
    } = params;

    // Preserve the historical service default (full rollout) for internal callers;
    // API callers must always provide an explicit policy.
    this.validateRolloutPolicy(rollout);
    const normalizedRollout = this.normalizeRolloutPolicy(rollout);
    const requestFingerprint = this.requestFingerprint({
      operation: 'publish', fingerprint, expectedParentFingerprint,
      rollout: normalizedRollout,
    });

    // Idempotency: replay only when the key is bound to identical semantics.
    if (idempotencyKey) {
      const existing = await this.findReleaseByIdempotencyKey(idempotencyKey);
      if (existing) {
        this.assertIdempotencySemantics(existing, requestFingerprint);
        const taskId = await this.findTaskIdForRelease(existing.id);
        return { release: this.recordToView(existing), taskId };
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Step 2: Lock the runtime_configs row.
      const configResult = await client.query(
        `SELECT id, encrypted_value FROM runtime_configs
          WHERE tenant_id IS NULL AND config_key = $1 FOR UPDATE`,
        [LLM_PROVIDERS_KEY],
      );

      // Step 3: Read the current (locked) value as previous.
      let lockedPrevious: LlmProvidersConfig | null = null;
      let lockedConfigId: string | null = null;
      let lockedEncryptedValue: string | null = null;
      if (configResult.rows.length > 0) {
        lockedConfigId = String(configResult.rows[0].id);
        lockedEncryptedValue = String(configResult.rows[0].encrypted_value);
        try {
          lockedPrevious = validateLlmProviders(JSON.parse(decryptValue(lockedEncryptedValue)));
        } catch {
          lockedPrevious = null;
        }
      }

      // Step 4: CAS — compare expectedParentFingerprint with current release's fingerprint.
      const pointerResult = await client.query(
        `SELECT release_id FROM llm_catalog_release_pointer WHERE id = 'current' FOR UPDATE`,
      );
      const currentReleaseId = pointerResult.rows[0]?.release_id
        ? String(pointerResult.rows[0].release_id)
        : null;

      let parentVersion = 0;
      let parentFingerprint: string | null = null;
      if (currentReleaseId) {
        const parentResult = await client.query(
          `SELECT version, fingerprint FROM llm_catalog_releases WHERE id = $1`,
          [currentReleaseId],
        );
        if (parentResult.rows.length > 0) {
          parentVersion = Number(parentResult.rows[0].version);
          parentFingerprint = String(parentResult.rows[0].fingerprint);
        }
      }

      // CAS check: if expectedParentFingerprint doesn't match the current
      // release's fingerprint, someone else published in between.
      if (expectedParentFingerprint !== parentFingerprint) {
        await client.query('ROLLBACK');
        return null;
      }

      // P1-2: Catalog Projection from Authority. When the feature flag is on,
      // atomicPublish independently builds the snapshot from the Catalog
      // (CatalogService.buildCatalogSnapshot) instead of trusting the
      // caller-supplied snapshot. The independently-built snapshot's fingerprint
      // is compared with the caller-supplied fingerprint; a mismatch means the
      // catalog was edited between preview and publish → transaction rolls back.
      let effectiveSnapshot = snapshot;
      let effectiveFingerprint = fingerprint;
      if (this.config?.catalogProjectionFromAuthority === true) {
        const authoritySnapshot = await this.buildAuthoritySnapshot(client);
        const authorityFingerprint = snapshotFingerprint(authoritySnapshot);
        if (authorityFingerprint !== fingerprint) {
          await client.query('ROLLBACK');
          throw new Error(
            `CATALOG_PROJECTION_MISMATCH: caller fingerprint ${fingerprint} does not match authority fingerprint ${authorityFingerprint}`,
          );
        }
        effectiveSnapshot = authoritySnapshot;
        effectiveFingerprint = authorityFingerprint;
      }

      // Step 5: Create the immutable Release.
      const releaseId = randomUUID();
      const version = parentVersion + 1;
      const canonicalSnapshot = encryptValue(JSON.stringify(effectiveSnapshot));
      const compatPayload = encryptValue(JSON.stringify(effectiveSnapshot));

      try {
        await client.query(
          `INSERT INTO llm_catalog_releases
             (id, version, parent_id, canonical_snapshot, compat_payload,
              fingerprint, parent_fingerprint, diff_summary, warnings,
              actor, actor_type, status, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)`,
          [
            releaseId,
            version,
            currentReleaseId,
            canonicalSnapshot,
            compatPayload,
            effectiveFingerprint,
            parentFingerprint,
            JSON.stringify({ ...diffSummary, releaseRequestFingerprint: requestFingerprint }),
            JSON.stringify(warnings),
            actor,
            actorType,
            idempotencyKey ?? null,
          ],
        );
      } catch (insertError: unknown) {
        // UNIQUE constraint violation on idempotency_key — the release was
        // already created by a concurrent request. Roll back and return it.
        if (idempotencyKey && this.isUniqueViolation(insertError)) {
          await client.query('ROLLBACK');
          const existing = await this.findReleaseByIdempotencyKey(idempotencyKey);
          if (existing) {
            this.assertIdempotencySemantics(existing, requestFingerprint);
            const taskId = await this.findTaskIdForRelease(existing.id);
            return { release: this.recordToView(existing), taskId };
          }
        }
        throw insertError;
      }

      // Step 6: Mark old release as superseded.
      if (currentReleaseId) {
        await client.query(
          `UPDATE llm_catalog_releases SET status = 'superseded' WHERE id = $1`,
          [currentReleaseId],
        );
      }

      // Step 7: Update current pointer.
      await client.query(
        `UPDATE llm_catalog_release_pointer SET release_id = $1, updated_at = NOW() WHERE id = 'current'`,
        [releaseId],
      );

      // Step 8: Write backup (source_fingerprint = OLD value fingerprint).
      const previousForFingerprint = lockedPrevious ?? {
        providers: [], defaultModel: null, imageModel: null,
        compactionModel: null, fallbackModels: [],
      };
      const oldFingerprint = snapshotFingerprint(previousForFingerprint);
      if (lockedConfigId && lockedEncryptedValue) {
        await client.query(
          `INSERT INTO llm_catalog_snapshot_backups
             (id, runtime_config_id, encrypted_value, source_fingerprint, actor)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [lockedConfigId, lockedEncryptedValue, oldFingerprint, actor],
        );
      }

      // Step 9: Upsert runtime_config with the new snapshot.
      const blob = JSON.stringify(effectiveSnapshot);
      validateConfigValue(blob);
      await upsertRuntimeConfig(client, {
        tenantId: null,
        key: LLM_PROVIDERS_KEY,
        value: blob,
        isSecret: true,
        description: '模型目录显式发布的兼容快照',
      });

      // Step 10: Optionally enqueue the explicitly requested rollout on the
      // transaction client. no-rollout intentionally creates no push task.
      let taskId: string | null = null;
      if (rollout.mode === 'rollout') {
        const rolloutService = new CatalogRolloutService(client as unknown as pg.Pool);
        const rolloutResult = await rolloutService.enqueueReleaseMutationRollout({
          releaseId,
          scopeType: rollout.scopeType,
          tenantIds: rollout.tenantIds,
          actor,
          actorType,
          idempotencyKey,
          prevLibrary: lockedPrevious,
          nextLibrary: effectiveSnapshot,
          trigger: 'save',
        });
        taskId = rolloutResult.taskId;
      }

      await writeAuditLogStrict(client as unknown as pg.Pool, {
        actor: actor ?? 'service',
        actorType,
        action: 'model-catalog.snapshot.publish',
        method: 'POST',
        path: '/v1/admin/model-catalog/snapshot-publish',
        resourceType: 'llm_catalog_release',
        resourceId: releaseId,
        oldValue: { parentReleaseId: currentReleaseId, parentFingerprint },
        newValue: {
          releaseId,
          fingerprint: effectiveFingerprint,
          rollout: normalizedRollout,
          requestFingerprint,
          taskId,
        },
      });

      // Step 11: COMMIT — all or nothing, including strict audit.
      await client.query('COMMIT');

      // Build the view from the data we have (avoids a re-query).
      const releaseView: CatalogReleaseView = {
        id: releaseId,
        version,
        parentId: currentReleaseId,
        fingerprint: effectiveFingerprint,
        parentFingerprint,
        diffSummary,
        warnings,
        actor,
        actorType,
        status: 'active',
        createdAt: new Date().toISOString(),
      };

      return { release: releaseView, taskId };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK failure is non-fatal — the connection is returning to the pool.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomic Restore: create a new Release from a historical backup snapshot.
   *
   * The snapshot comes from the backup's encrypted_value (decrypted), not from
   * the catalog overlay. The transaction steps mirror atomicPublish.
   */
  async atomicRestore(params: {
    backupId: string;
    actor: string | null;
    actorType: 'admin' | 'service';
    idempotencyKey?: string;
    rollout?: ReleaseRolloutPolicy;
  }): Promise<CatalogReleaseMutationResult | null> {
    const {
      backupId,
      actor,
      actorType,
      idempotencyKey,
      rollout = { mode: 'rollout', scopeType: 'full' },
    } = params;
    this.validateRolloutPolicy(rollout);
    const normalizedRollout = this.normalizeRolloutPolicy(rollout);
    const requestFingerprint = this.requestFingerprint({
      operation: 'restore', backupId, rollout: normalizedRollout,
    });
    if (idempotencyKey) {
      const existing = await this.findReleaseByIdempotencyKey(idempotencyKey);
      if (existing) {
        this.assertIdempotencySemantics(existing, requestFingerprint);
        return {
          release: this.recordToView(existing),
          taskId: await this.findTaskIdForRelease(existing.id),
        };
      }
    }

    // Read the backup (outside the transaction — it's immutable).
    const backupResult = await this.pool.query(
      `SELECT encrypted_value, source_fingerprint FROM llm_catalog_snapshot_backups WHERE id = $1`,
      [backupId],
    );
    if (!backupResult.rows.length) {
      return null;
    }
    const restored = validateLlmProviders(
      JSON.parse(decryptValue(String(backupResult.rows[0].encrypted_value))),
    );
    const backupSourceFingerprint = backupResult.rows[0].source_fingerprint
      ? String(backupResult.rows[0].source_fingerprint)
      : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the runtime_configs row.
      const configResult = await client.query(
        `SELECT id, encrypted_value FROM runtime_configs
          WHERE tenant_id IS NULL AND config_key = $1 FOR UPDATE`,
        [LLM_PROVIDERS_KEY],
      );

      // Read the current (locked) value as previous.
      let lockedPrevious: LlmProvidersConfig | null = null;
      let lockedConfigId: string | null = null;
      let lockedEncryptedValue: string | null = null;
      if (configResult.rows.length > 0) {
        lockedConfigId = String(configResult.rows[0].id);
        lockedEncryptedValue = String(configResult.rows[0].encrypted_value);
        try {
          lockedPrevious = validateLlmProviders(JSON.parse(decryptValue(lockedEncryptedValue)));
        } catch {
          lockedPrevious = null;
        }
      }

      // Get current release for parent chain + CAS.
      const pointerResult = await client.query(
        `SELECT release_id FROM llm_catalog_release_pointer WHERE id = 'current' FOR UPDATE`,
      );
      const currentReleaseId = pointerResult.rows[0]?.release_id
        ? String(pointerResult.rows[0].release_id)
        : null;

      let parentVersion = 0;
      let parentFingerprint: string | null = null;
      if (currentReleaseId) {
        const parentResult = await client.query(
          `SELECT version, fingerprint FROM llm_catalog_releases WHERE id = $1`,
          [currentReleaseId],
        );
        if (parentResult.rows.length > 0) {
          parentVersion = Number(parentResult.rows[0].version);
          parentFingerprint = String(parentResult.rows[0].fingerprint);
        }
      }

      // Compute the restored snapshot's fingerprint.
      const fingerprint = snapshotFingerprint(restored);
      const version = parentVersion + 1;
      const releaseId = randomUUID();
      const canonicalSnapshot = encryptValue(JSON.stringify(restored));
      const compatPayload = encryptValue(JSON.stringify(restored));

      const diffSummary: Record<string, unknown> = {
        restoredFromBackup: backupId,
        backupSourceFingerprint,
      };

      try {
        await client.query(
          `INSERT INTO llm_catalog_releases
             (id, version, parent_id, canonical_snapshot, compat_payload,
              fingerprint, parent_fingerprint, diff_summary, warnings,
              actor, actor_type, status, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rolled-back',$12)`,
          [
            releaseId,
            version,
            currentReleaseId,
            canonicalSnapshot,
            compatPayload,
            fingerprint,
            parentFingerprint,
            JSON.stringify({ ...diffSummary, releaseRequestFingerprint: requestFingerprint }),
            JSON.stringify([]),
            actor,
            actorType,
            idempotencyKey ?? null,
          ],
        );
      } catch (insertError: unknown) {
        if (idempotencyKey && this.isUniqueViolation(insertError)) {
          await client.query('ROLLBACK');
          const existing = await this.findReleaseByIdempotencyKey(idempotencyKey);
          if (existing) {
            this.assertIdempotencySemantics(existing, requestFingerprint);
            return {
              release: this.recordToView(existing),
              taskId: await this.findTaskIdForRelease(existing.id),
            };
          }
        }
        throw insertError;
      }

      // Mark old release as superseded.
      if (currentReleaseId) {
        await client.query(
          `UPDATE llm_catalog_releases SET status = 'superseded' WHERE id = $1`,
          [currentReleaseId],
        );
      }

      // Update current pointer.
      await client.query(
        `UPDATE llm_catalog_release_pointer SET release_id = $1, updated_at = NOW() WHERE id = 'current'`,
        [releaseId],
      );

      // Write backup of the current (pre-restore) value.
      const previousForFingerprint = lockedPrevious ?? {
        providers: [], defaultModel: null, imageModel: null,
        compactionModel: null, fallbackModels: [],
      };
      const oldFingerprint = snapshotFingerprint(previousForFingerprint);
      if (lockedConfigId && lockedEncryptedValue) {
        await client.query(
          `INSERT INTO llm_catalog_snapshot_backups
             (id, runtime_config_id, encrypted_value, source_fingerprint, actor)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
          [lockedConfigId, lockedEncryptedValue, oldFingerprint, actor],
        );
      }

      // Upsert runtime_config with the restored snapshot.
      const blob = JSON.stringify(restored);
      validateConfigValue(blob);
      await upsertRuntimeConfig(client, {
        tenantId: null,
        key: LLM_PROVIDERS_KEY,
        value: blob,
        isSecret: true,
        description: '模型目录快照恢复',
      });

      let taskId: string | null = null;
      if (rollout.mode === 'rollout') {
        const rolloutService = new CatalogRolloutService(client as unknown as pg.Pool);
        const rolloutResult = await rolloutService.enqueueReleaseMutationRollout({
          releaseId,
          scopeType: rollout.scopeType,
          tenantIds: rollout.tenantIds,
          actor,
          actorType,
          idempotencyKey,
          prevLibrary: lockedPrevious,
          nextLibrary: restored,
          trigger: 'retry',
        });
        taskId = rolloutResult.taskId;
      }

      await writeAuditLogStrict(client as unknown as pg.Pool, {
        actor: actor ?? 'service',
        actorType,
        action: 'model-catalog.snapshot.restore',
        method: 'POST',
        path: '/v1/admin/model-catalog/snapshot-restore',
        resourceType: 'llm_catalog_release',
        resourceId: releaseId,
        oldValue: { parentReleaseId: currentReleaseId, parentFingerprint },
        newValue: {
          releaseId,
          backupId,
          fingerprint,
          rollout: normalizedRollout,
          requestFingerprint,
          taskId,
        },
      });
      await client.query('COMMIT');

      const releaseView: CatalogReleaseView = {
        id: releaseId,
        version,
        parentId: currentReleaseId,
        fingerprint,
        parentFingerprint,
        diffSummary,
        warnings: [],
        actor,
        actorType,
        status: 'rolled-back',
        createdAt: new Date().toISOString(),
      };

      return { release: releaseView, taskId };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK failure is non-fatal.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Private helpers ──

  /** Build the canonical Authority projection through the shared builder. */
  private async buildAuthoritySnapshot(database: pg.Pool | pg.PoolClient): Promise<LlmProvidersConfig> {
    const repository = new CatalogRepository(database as unknown as pg.Pool);
    return new CatalogService(repository).buildCatalogSnapshot();
  }

  /** Validate rollout scope invariants before starting a transaction. */
  private validateRolloutPolicy(policy: ReleaseRolloutPolicy): void {
    if (policy.mode === 'no-rollout') return;
    const tenantIds = policy.tenantIds;
    if (tenantIds !== undefined &&
        (!Array.isArray(tenantIds) || tenantIds.some((id) => typeof id !== 'string' || id.trim() === ''))) {
      throw new Error('INVALID_ROLLOUT_POLICY: tenantIds must contain non-empty strings');
    }
    if (policy.scopeType === 'single' && tenantIds?.length !== 1) {
      throw new Error('INVALID_ROLLOUT_POLICY: single requires exactly one tenantId');
    }
    if ((policy.scopeType === 'allowlist' || policy.scopeType === 'canary') && !tenantIds?.length) {
      throw new Error(`INVALID_ROLLOUT_POLICY: ${policy.scopeType} requires tenantIds`);
    }
    if ((policy.scopeType === 'full' || policy.scopeType === 'affected') && tenantIds !== undefined) {
      throw new Error(`INVALID_ROLLOUT_POLICY: ${policy.scopeType} does not accept tenantIds`);
    }
  }

  /** Normalize semantically set-like tenant targets before hashing/auditing. */
  private normalizeRolloutPolicy(policy: ReleaseRolloutPolicy): ReleaseRolloutPolicy {
    if (policy.mode === 'no-rollout' || policy.tenantIds === undefined) return policy;
    return { ...policy, tenantIds: [...new Set(policy.tenantIds)].sort() };
  }

  /** Produce a stable digest from normalized request semantics. */
  private requestFingerprint(value: Record<string, unknown>): string {
    const normalize = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(normalize);
      if (input !== null && typeof input === 'object') {
        return Object.fromEntries(
          Object.entries(input as Record<string, unknown>)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalize(nested)]),
        );
      }
      return input;
    };
    return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
  }

  /** Reject replay when a key was bound to different request semantics. */
  private assertIdempotencySemantics(
    release: CatalogReleaseRecord,
    requestFingerprint: string,
  ): void {
    if (release.diffSummary.releaseRequestFingerprint !== requestFingerprint) {
      throw new CatalogReleaseIdempotencyConflictError();
    }
  }

  /** Find a release by its idempotency key. */
  private async findReleaseByIdempotencyKey(key: string): Promise<CatalogReleaseRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM llm_catalog_releases WHERE idempotency_key = $1`,
      [key],
    );
    if (!rows.length) return null;
    return rowToRecord(rows[0]);
  }

  /** Find the push task id associated with a release. */
  private async findTaskIdForRelease(releaseId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT id FROM llm_push_tasks WHERE release_id = $1 ORDER BY created_at LIMIT 1`,
      [releaseId],
    );
    if (!rows.length) return null;
    return String(rows[0].id);
  }

  /** Convert a CatalogReleaseRecord to a CatalogReleaseView. */
  private recordToView(record: CatalogReleaseRecord): CatalogReleaseView {
    return {
      id: record.id,
      version: record.version,
      parentId: record.parentId,
      fingerprint: record.fingerprint,
      parentFingerprint: record.parentFingerprint,
      diffSummary: record.diffSummary,
      warnings: record.warnings,
      actor: record.actor,
      actorType: record.actorType,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /** Check if a PG error is a unique constraint violation (code 23505). */
  private isUniqueViolation(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as Record<string, unknown>).code) === '23505';
    }
    return false;
  }
}
