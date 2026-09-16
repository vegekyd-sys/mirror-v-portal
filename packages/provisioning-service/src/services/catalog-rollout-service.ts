/**
 * Catalog Rollout Service — impact preview + scoped rollout orchestration.
 *
 * Before publishing a catalog snapshot, the admin can preview which tenants
 * will be affected (need an agent/gateway restart) and why. After publishing
 * (creating an immutable Release), a scoped rollout can be enqueued that
 * targets only the affected tenants, an allowlist, or a single canary tenant —
 * instead of the legacy "global push to everyone" behaviour.
 *
 * The impact manifest is a pure read-only computation: it diffs the current
 * runtime LlmProvidersConfig against the candidate snapshot, resolves each
 * tenant's effective selection, and uses {@link analyzeTenantLlmRestart} to
 * determine whether the tenant's live config would change. No Secrets are
 * touched, no pods are rolled.
 *
 * The scoped rollout delegates to {@link enqueueLlmPush} for the actual
 * push-task creation and initialises per-tenant desired release status rows
 * in `llm_tenant_release_status` so the worker can reconcile delivery.
 */
import type pg from 'pg';
import { decryptValue } from './crypto.js';
import { enqueueLlmPush } from './llm-push-task.js';
import type { AutoPauseThresholds } from './llm-push-types.js';
import {
  analyzeTenantLlmRestart,
  effectiveCompactionRefIn,
  effectiveFallbacksFor,
  effectiveImageRefIn,
  effectiveRefIn,
  getGlobalLlmProviders,
  getTenantModelSelection,
  type LlmProvidersConfig,
  type TenantModelSelection,
} from './llm-providers.js';
import { snapshotFingerprint } from './model-catalog.js';
import { getOverrideMap } from './tenant-image-overrides.js';

// ── Public types ──

/** Single tenant's impact-preview result. */
export interface TenantImpactEntry {
  tenantId: string;
  tenantName: string | null;
  /** True for tenants with a custom agent_endpoint (no per-tenant Deployment). */
  internal: boolean;
  // Current effective selection (under the runtime library)
  currentDefaultModel: string | null;
  currentImageModel: string | null;
  currentCompactionModel: string | null;
  currentFallbackModels: string[];
  // Desired effective selection (under the candidate library)
  desiredDefaultModel: string | null;
  desiredImageModel: string | null;
  desiredCompactionModel: string | null;
  desiredFallbackModels: string[];
  // Impact analysis
  affected: boolean;
  affectedReasons: string[];
  agentRestart: boolean;
  gatewayRestart: boolean;
  // Release tracking
  currentAppliedReleaseId: string | null;
  desiredReleaseId: string | null;
  deliveryStatus: string | null;
}

/** Complete impact manifest returned by the preview endpoint. */
export interface ImpactManifest {
  /** Release ID when previewing a published Release; null for snapshot-only preview. */
  releaseId: string | null;
  fingerprint: string;
  totalTenants: number;
  affectedTenants: number;
  unaffectedTenants: number;
  /** Tenants with an image override pin (nexus-agent or nexus-gateway). */
  pinnedTenants: number;
  entries: TenantImpactEntry[];
}

/** Scope granularity for a scoped rollout. */
export type ScopeType = 'full' | 'allowlist' | 'single' | 'affected' | 'canary';

/** Parameters for enqueueing a scoped rollout task. */
export interface ScopedRolloutParams {
  releaseId: string;
  scopeType: ScopeType;
  tenantIds?: string[];
  actor: string | null;
  actorType: 'admin' | 'service';
  idempotencyKey?: string;
  /** Per-batch tenant count; 0 (default) = no batching (all at once). */
  batchSize?: number;
  /** Observation window between batches in ms; 0 = no wait. */
  batchIntervalMs?: number;
  /** Auto-pause thresholds evaluated after each batch completes. */
  autoPauseThresholds?: AutoPauseThresholds;
}

// ── Internal row types ──

interface TenantRow {
  tenant_id: string;
  company_name: string;
  k8s_namespace: string;
  agent_endpoint: string | null;
}

interface ReleaseStatusRow {
  tenant_id: string;
  applied_release_id: string | null;
  delivery_status: string | null;
}

interface ReleaseRow {
  fingerprint: string;
  compat_payload: string;
}

// ── Service ──

export class CatalogRolloutService {
  constructor(private pool: pg.Pool) {}

  /**
   * Compute the impact manifest: for every active tenant, determine whether
   * the library change from `prev` to `next` would require an agent/gateway
   * restart, and collect the reason codes.
   *
   * This is a read-only operation — no Secrets are written, no pods are rolled.
   */
  async computeImpactManifest(
    prev: LlmProvidersConfig | null,
    next: LlmProvidersConfig,
    releaseId: string | null,
  ): Promise<ImpactManifest> {
    // 1. Query all active tenants (including External Agents with no k8s
    //    namespace — they are listed in the manifest but marked unsupported).
    const { rows: tenantRows } = await this.pool.query<TenantRow>(
      `SELECT tenant_id, company_name, k8s_namespace, agent_endpoint
         FROM tenants
        WHERE status NOT IN ('destroyed')
        ORDER BY created_at`,
    );

    // 2. Bulk-load image override maps for both services (pinned tenants).
    const [agentOverrides, gatewayOverrides] = await Promise.all([
      getOverrideMap(this.pool, 'nexus-agent'),
      getOverrideMap(this.pool, 'nexus-gateway'),
    ]);

    // 3. Bulk-load per-tenant applied release status.
    const tenantIds = tenantRows.map((r) => r.tenant_id);
    const releaseStatusMap = await this.loadReleaseStatusMap(tenantIds);

    // 4. Query the current desired release pointer.
    const desiredReleaseId = await this.loadDesiredReleaseId();

    // 5. For each tenant, compute the effective selection under prev and next,
    //    then run the differential restart analysis.
    const entries: TenantImpactEntry[] = [];
    for (const row of tenantRows) {
      const tenantId = row.tenant_id;
      const selection = await getTenantModelSelection(this.pool, tenantId);
      const analysis = analyzeTenantLlmRestart(prev, next, selection);
      const hasAgent = row.agent_endpoint === null;
      const affected = analysis.restart && hasAgent;
      const pinned = agentOverrides.has(tenantId) || gatewayOverrides.has(tenantId);
      const status = releaseStatusMap.get(tenantId);

      // External Agent — has a custom agent_endpoint and no per-tenant K8s
      // Deployment, so there is nothing for the push task to roll out.
      const isExternal = row.agent_endpoint !== null && row.k8s_namespace === null;

      const baseFields = {
        tenantId,
        tenantName: row.company_name ?? null,
        internal: !hasAgent,
        currentDefaultModel: effectiveRefIn(prev, selection?.defaultModel ?? null),
        currentImageModel: effectiveImageRefIn(prev, selection?.imageModel ?? null),
        currentCompactionModel:
          effectiveCompactionRefIn(prev, selection?.compactionModel ?? null)
          ?? effectiveRefIn(prev, selection?.defaultModel ?? null),
        currentFallbackModels: effectiveFallbacksFor(prev, selection ?? null),
        desiredDefaultModel: effectiveRefIn(next, selection?.defaultModel ?? null),
        desiredImageModel: effectiveImageRefIn(next, selection?.imageModel ?? null),
        desiredCompactionModel:
          effectiveCompactionRefIn(next, selection?.compactionModel ?? null)
          ?? effectiveRefIn(next, selection?.defaultModel ?? null),
        desiredFallbackModels: effectiveFallbacksFor(next, selection ?? null),
        currentAppliedReleaseId: status?.applied_release_id ?? null,
        desiredReleaseId,
      };

      if (isExternal) {
        entries.push({
          ...baseFields,
          affected: false,
          affectedReasons: ['external_agent: no k8s deployment to rollout'],
          agentRestart: false,
          gatewayRestart: false,
          deliveryStatus: 'unsupported',
        });
      } else {
        entries.push({
          ...baseFields,
          affected,
          affectedReasons: analysis.reasons,
          agentRestart: affected,
          gatewayRestart: affected,
          deliveryStatus: status?.delivery_status ?? null,
        });
      }
    }

    const affectedCount = entries.filter((e) => e.affected).length;
    const pinnedCount = entries.filter(
      (e) => agentOverrides.has(e.tenantId) || gatewayOverrides.has(e.tenantId),
    ).length;

    return {
      releaseId,
      fingerprint: snapshotFingerprint(next),
      totalTenants: entries.length,
      affectedTenants: affectedCount,
      unaffectedTenants: entries.length - affectedCount,
      pinnedTenants: pinnedCount,
      entries,
    };
  }

  /**
   * Enqueue a scoped rollout task after a Release has been published.
   * Creates an LLM push task linked to the Release and initialises per-tenant
   * desired release status rows. When batchSize > 0, target tenants are split
   * into batches: the first batch is immediately claimable ('pending') while
   * subsequent batches are held as 'paused' until the worker promotes them
   * after evaluating auto-pause thresholds.
   */
  async enqueueScopedRollout(
    params: ScopedRolloutParams,
  ): Promise<{ taskId: string; status: string; total: number }> {
    // 1. Load the Release record to get the fingerprint + compat payload.
    const { rows: releaseRows } = await this.pool.query<ReleaseRow>(
      `SELECT fingerprint, compat_payload FROM llm_catalog_releases
        WHERE id = $1 AND status = 'active'`,
      [params.releaseId],
    );
    if (!releaseRows[0]) {
      throw new Error(`Release ${params.releaseId} not found or not active`);
    }
    const release = releaseRows[0];
    const nextLibrary: LlmProvidersConfig = JSON.parse(
      decryptValue(release.compat_payload),
    );

    // 2. Get the current runtime library (prev).
    const prevLibrary = await getGlobalLlmProviders(this.pool);

    // 3. Determine target tenants based on scopeType.
    const targetTenantIds = await this.resolveTargetTenants(
      params.scopeType,
      params.tenantIds,
      prevLibrary,
      nextLibrary,
    );

    // 4. Compute batch metadata.
    const batchSize = params.batchSize ?? 0;
    const batchTotal = batchSize > 0
      ? Math.ceil(targetTenantIds.length / batchSize)
      : 0;

    // 5. Enqueue the LLM push task with batch metadata.
    const pushResult = await enqueueLlmPush(this.pool, {
      kind: params.scopeType === 'single' ? 'tenant_push' : 'global_push',
      scope: params.scopeType === 'single' ? targetTenantIds[0] ?? null : null,
      trigger: 'save',
      prevLibrary,
      nextLibrary,
      actor: params.actor ?? 'service',
      actorType: params.actorType,
      releaseId: params.releaseId,
      scopeType: params.scopeType,
      idempotencyKey: params.idempotencyKey,
      batchSize,
      batchTotal,
      batchIntervalMs: params.batchIntervalMs ?? 0,
      autoPauseThresholds: params.autoPauseThresholds,
    });

    // 6. Pre-enumerate items with batch metadata when batching is enabled.
    //    This bypasses the worker's default enumerateTargets (which would
    //    insert all items as a single unbatched wave).
    if (batchSize > 0 && targetTenantIds.length > 0) {
      await this.enqueueBatchedItems(
        pushResult.taskId,
        targetTenantIds,
        batchSize,
      );
      // Set total_count since we pre-enumerated (worker won't re-enumerate
      // because countItems > 0).
      await this.pool.query(
        `UPDATE llm_push_tasks SET total_count = $1 WHERE id = $2`,
        [targetTenantIds.length, pushResult.taskId],
      );
    }

    // 7. Initialise per-tenant desired release status.
    if (targetTenantIds.length > 0) {
      await this.initTenantReleaseStatus(params.releaseId, targetTenantIds);
    }

    return {
      taskId: pushResult.taskId,
      status: pushResult.status,
      total: targetTenantIds.length,
    };
  }

  /**
   * Enqueue rollout as part of an already-open Release mutation transaction.
   * The service must be constructed with that transaction client.
   */
  async enqueueReleaseMutationRollout(params: ScopedRolloutParams & {
    prevLibrary: LlmProvidersConfig | null;
    nextLibrary: LlmProvidersConfig;
    trigger: 'save' | 'retry';
  }): Promise<{ taskId: string; status: string; total: number }> {
    const targetTenantIds = await this.resolveTargetTenants(
      params.scopeType,
      params.tenantIds,
      params.prevLibrary,
      params.nextLibrary,
    );
    const pushResult = await enqueueLlmPush(this.pool, {
      kind: params.scopeType === 'single' ? 'tenant_push' : 'global_push',
      scope: params.scopeType === 'single' ? targetTenantIds[0] ?? null : null,
      trigger: params.trigger,
      prevLibrary: params.prevLibrary,
      nextLibrary: params.nextLibrary,
      actor: params.actor ?? 'service',
      actorType: params.actorType,
      releaseId: params.releaseId,
      scopeType: params.scopeType,
      idempotencyKey: params.idempotencyKey,
    });
    if (targetTenantIds.length > 0 && params.scopeType !== 'full') {
      await this.enqueueBatchedItems(pushResult.taskId, targetTenantIds, targetTenantIds.length);
      await this.pool.query(
        `UPDATE llm_push_tasks SET total_count = $1 WHERE id = $2`,
        [targetTenantIds.length, pushResult.taskId],
      );
    }
    if (targetTenantIds.length > 0) {
      await this.initTenantReleaseStatus(params.releaseId, targetTenantIds);
    }
    return { taskId: pushResult.taskId, status: pushResult.status, total: targetTenantIds.length };
  }

  /**
   * Update a tenant's applied release status after the worker completes
   * (or skips / fails) the rollout for that tenant.
   */
  async updateTenantAppliedStatus(params: {
    tenantId: string;
    releaseId: string;
    fingerprint: string;
    deliveryStatus: 'delivered' | 'failed' | 'skipped' | 'unsupported';
    restartReason: string | null;
    error: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_tenant_release_status
         (tenant_id, desired_release_id, applied_release_id, applied_fingerprint,
          applied_at, restart_reason, delivery_status, error, attempts, updated_at)
       VALUES ($1, $2, $2, $3, NOW(), $4, $5, $6, 1, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         desired_release_id = EXCLUDED.desired_release_id,
         applied_release_id = EXCLUDED.applied_release_id,
         applied_fingerprint = EXCLUDED.applied_fingerprint,
         applied_at = EXCLUDED.applied_at,
         restart_reason = EXCLUDED.restart_reason,
         delivery_status = EXCLUDED.delivery_status,
         error = EXCLUDED.error,
         attempts = llm_tenant_release_status.attempts + 1,
         updated_at = NOW()
       WHERE NOT (
         llm_tenant_release_status.delivery_status = 'delivered'
         AND llm_tenant_release_status.applied_release_id = EXCLUDED.applied_release_id
       )`,
      [
        params.tenantId,
        params.releaseId,
        params.fingerprint,
        params.restartReason,
        params.deliveryStatus,
        params.error,
      ],
    );
  }

  /**
   * Mark tenants with external agent endpoints as 'unsupported' for a given
   * release. Called by the push task worker after all items are processed.
   * Only affects tenants whose release status is still 'pending' and that
   * have a non-null agent_endpoint in the tenants table.
   */
  async markExternalAgentsUnsupported(releaseId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE llm_tenant_release_status trs
       SET delivery_status = 'unsupported',
           error = 'external agent endpoint',
           updated_at = NOW()
       FROM tenants t
       WHERE trs.desired_release_id = $1
         AND trs.delivery_status = 'pending'
         AND trs.tenant_id = t.tenant_id
         AND t.agent_endpoint IS NOT NULL`,
      [releaseId],
    );
    return rowCount ?? 0;
  }

  /**
   * Bulk-initialise per-tenant desired release status rows. Existing rows are
   * updated with the new desired_release_id and a 'pending' delivery_status.
   * Called from {@link enqueueScopedRollout}.
   */
  async initTenantReleaseStatus(
    releaseId: string,
    tenantIds: string[],
  ): Promise<void> {
    if (tenantIds.length === 0) return;
    // Build a multi-value VALUES clause for batch upsert.
    const values = tenantIds
      .map((_, i) => `($1, $${i + 2})`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO llm_tenant_release_status
         (tenant_id, desired_release_id, delivery_status, attempts, updated_at)
       VALUES ${values}
       ON CONFLICT (tenant_id) DO UPDATE SET
         desired_release_id = EXCLUDED.desired_release_id,
         delivery_status = 'pending',
         updated_at = NOW()`,
      [releaseId, ...tenantIds],
    );
  }

  /**
   * Pre-enumerate push task items with per-batch metadata. The first batch is
   * inserted with batch_status='pending' (immediately claimable by the
   * worker); subsequent batches are 'paused' and promoted one at a time after
   * auto-pause threshold evaluation. Bypasses the worker's default
   * enumerateTargets.
   */
  private async enqueueBatchedItems(
    taskId: string,
    tenantIds: string[],
    batchSize: number,
  ): Promise<void> {
    // Split tenant list into batches.
    const batches: string[][] = [];
    for (let i = 0; i < tenantIds.length; i += batchSize) {
      batches.push(tenantIds.slice(i, i + batchSize));
    }
    const batchTotal = batches.length;

    for (let batchIndex = 0; batchIndex < batchTotal; batchIndex++) {
      const batchTenants = batches[batchIndex];
      const batchStatus = batchIndex === 0 ? 'pending' : 'paused';
      const n = batchTenants.length;
      // Param layout: $1=task_id, $2..$(n+1)=tenant_ids,
      //               $(n+2)=batch_index, $(n+3)=batch_total, $(n+4)=batch_status
      const values = batchTenants
        .map((_, i) => `($1, $${i + 2}, $${n + 2}, $${n + 3}, $${n + 4})`)
        .join(', ');
      await this.pool.query(
        `INSERT INTO llm_push_task_items
           (task_id, tenant_id, batch_index, batch_total, batch_status)
         VALUES ${values}`,
        [taskId, ...batchTenants, batchIndex, batchTotal, batchStatus],
      );
    }
  }

  /**
   * Query per-tenant release status, optionally filtered by releaseId.
   */
  async listTenantReleaseStatus(
    releaseId?: string,
  ): Promise<Array<{
    tenantId: string;
    desiredReleaseId: string | null;
    appliedReleaseId: string | null;
    appliedFingerprint: string | null;
    appliedAt: string | null;
    restartReason: string | null;
    deliveryStatus: string | null;
    error: string | null;
    attempts: number;
    updatedAt: string;
  }>> {
    const { rows } = releaseId
      ? await this.pool.query(
          `SELECT * FROM llm_tenant_release_status
            WHERE desired_release_id = $1 OR applied_release_id = $1
            ORDER BY updated_at DESC`,
          [releaseId],
        )
      : await this.pool.query(
          `SELECT * FROM llm_tenant_release_status
            ORDER BY updated_at DESC`,
        );
    return rows.map((r: Record<string, unknown>) => ({
      tenantId: String(r.tenant_id),
      desiredReleaseId: r.desired_release_id ? String(r.desired_release_id) : null,
      appliedReleaseId: r.applied_release_id ? String(r.applied_release_id) : null,
      appliedFingerprint: r.applied_fingerprint ? String(r.applied_fingerprint) : null,
      appliedAt: r.applied_at ? String(r.applied_at) : null,
      restartReason: r.restart_reason ? String(r.restart_reason) : null,
      deliveryStatus: r.delivery_status ? String(r.delivery_status) : null,
      error: r.error ? String(r.error) : null,
      attempts: Number(r.attempts ?? 0),
      updatedAt: String(r.updated_at),
    }));
  }

  // ── Private helpers ──

  /**
   * Resolve the target tenant list for a given scope type.
   * - full: all active tenants with agent_endpoint IS NULL
   * - single: the one tenant from params.tenantIds[0]
   * - allowlist/canary: the explicit tenant list from params.tenantIds
   * - affected: tenants where computeImpactManifest says affected=true
   */
  private async resolveTargetTenants(
    scopeType: ScopeType,
    tenantIds: string[] | undefined,
    prev: LlmProvidersConfig | null,
    next: LlmProvidersConfig,
  ): Promise<string[]> {
    if (scopeType === 'single' || scopeType === 'allowlist' || scopeType === 'canary') {
      if (!tenantIds || tenantIds.length === 0) {
        throw new Error(`scopeType=${scopeType} requires at least one tenantId`);
      }
      const uniqueTenantIds = [...new Set(tenantIds)];
      const { rows } = await this.pool.query<{
        tenant_id: string;
        status: string;
        k8s_namespace: string | null;
        agent_endpoint: string | null;
      }>(
        `SELECT tenant_id, status, k8s_namespace, agent_endpoint
           FROM tenants
          WHERE tenant_id = ANY($1::text[])`,
        [uniqueTenantIds],
      );
      const eligible = new Set(
        rows
          .filter((row) => row.status !== 'destroyed' &&
            row.k8s_namespace !== null && row.agent_endpoint === null)
          .map((row) => row.tenant_id),
      );
      const invalid = uniqueTenantIds.filter((tenantId) => !eligible.has(tenantId));
      if (invalid.length > 0) {
        throw new Error(`INVALID_ROLLOUT_TARGETS: ${invalid.join(',')}`);
      }
      return uniqueTenantIds;
    }

    if (scopeType === 'affected') {
      const manifest = await this.computeImpactManifest(prev, next, null);
      return manifest.entries.filter((e) => e.affected).map((e) => e.tenantId);
    }

    // full — all active tenants with agent_endpoint IS NULL (same filter as
    // the LLM push worker's enumerateTargets).
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenants
        WHERE status NOT IN ('destroyed')
          AND k8s_namespace IS NOT NULL
          AND agent_endpoint IS NULL
        ORDER BY created_at`,
    );
    return rows.map((r) => r.tenant_id);
  }

  /** Bulk-load per-tenant applied release status into a Map. */
  private async loadReleaseStatusMap(
    tenantIds: string[],
  ): Promise<Map<string, ReleaseStatusRow>> {
    const result = new Map<string, ReleaseStatusRow>();
    if (tenantIds.length === 0) return result;
    const { rows } = await this.pool.query<ReleaseStatusRow>(
      `SELECT tenant_id, applied_release_id, delivery_status
         FROM llm_tenant_release_status
        WHERE tenant_id = ANY($1::text[])`,
      [tenantIds],
    );
    for (const row of rows) {
      result.set(row.tenant_id, row);
    }
    return result;
  }

  /** Read the current desired release pointer singleton. */
  private async loadDesiredReleaseId(): Promise<string | null> {
    const { rows } = await this.pool.query<{ release_id: string | null }>(
      `SELECT release_id FROM llm_catalog_release_pointer WHERE id = 'current'`,
    );
    return rows[0]?.release_id ?? null;
  }
}
