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
import { randomUUID } from 'node:crypto';
import { encryptValue, decryptValue } from './crypto.js';
import { enqueueLlmPush } from './llm-push-task.js';
import { upsertRuntimeConfig, validateConfigValue } from './runtime-config.js';
import { getGlobalLlmProviders, validateLlmProviders, LLM_PROVIDERS_KEY } from './llm-providers.js';
import { snapshotFingerprint, CatalogRepository, CatalogService } from './model-catalog.js';
import type { LlmProvidersConfig } from './llm-providers.js';
import type { ProvisioningConfig } from '../config.js';
import type {
  CatalogReleaseRecord,
  CatalogReleaseView,
  TenantReleaseStatusRecord,
} from '../domain/catalog-release.js';

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
  }): Promise<{ release: CatalogReleaseView; taskId: string } | null> {
    const {
      expectedParentFingerprint,
      snapshot,
      fingerprint,
      diffSummary,
      warnings,
      actor,
      actorType,
      idempotencyKey,
    } = params;

    // Idempotency: if a release with this key already exists, return it.
    if (idempotencyKey) {
      const existing = await this.findReleaseByIdempotencyKey(idempotencyKey);
      if (existing) {
        // Find the push task associated with this release.
        const taskId = await this.findTaskIdForRelease(existing.id);
        if (taskId) {
          return { release: this.recordToView(existing), taskId };
        }
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
        const catalogRepo = new CatalogRepository(this.pool);
        const catalogService = new CatalogService(catalogRepo);
        const authoritySnapshot = await catalogService.buildCatalogSnapshot();
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
            JSON.stringify(diffSummary),
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
            const taskId = await this.findTaskIdForRelease(existing.id);
            if (taskId) {
              return { release: this.recordToView(existing), taskId };
            }
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

      // Step 10: Enqueue push task ON THE TRANSACTION CLIENT.
      const { taskId } = await enqueueLlmPush(client, {
        kind: 'global_push',
        scope: null,
        trigger: 'save',
        prevLibrary: lockedPrevious,
        nextLibrary: effectiveSnapshot,
        actor: actor ?? 'service',
        actorType,
        releaseId,
        scopeType: 'full',
        idempotencyKey,
      });

      // Step 11: COMMIT — all or nothing.
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
  }): Promise<{ release: CatalogReleaseView; taskId: string } | null> {
    const { backupId, actor, actorType } = params;

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

      await client.query(
        `INSERT INTO llm_catalog_releases
           (id, version, parent_id, canonical_snapshot, compat_payload,
            fingerprint, parent_fingerprint, diff_summary, warnings,
            actor, actor_type, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'rolled-back')`,
        [
          releaseId,
          version,
          currentReleaseId,
          canonicalSnapshot,
          compatPayload,
          fingerprint,
          parentFingerprint,
          JSON.stringify(diffSummary),
          JSON.stringify([]),
          actor,
          actorType,
        ],
      );

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

      // Enqueue push task on the transaction client.
      const { taskId } = await enqueueLlmPush(client, {
        kind: 'global_push',
        scope: null,
        trigger: 'retry',
        prevLibrary: lockedPrevious,
        nextLibrary: restored,
        actor: actor ?? 'service',
        actorType,
        releaseId,
        scopeType: 'full',
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
