/**
 * Tenant Selection V2 — stable model row ID references.
 *
 * Replaces the legacy "providerName/modelId" selection format (stored in
 * runtime_configs as LLM_MODEL_SELECTION) with stable lpm_ IDs that survive
 * provider renames. During the transition period both representations are
 * kept in sync via dual-write; legacy reads remain primary until
 * SELECTION_V2_PRIMARY_READ=true flips the default.
 *
 * The V2 table (llm_tenant_selection_v2) is a simple per-tenant row with
 * CAS revision, supporting getSelection / updateSelection / backfillFromLegacy
 * / compareSelections operations.
 */
import type pg from 'pg';
import { encryptValue, decryptValue } from './crypto.js';
import {
  getTenantModelSelection,
  type TenantModelSelection,
} from './llm-providers.js';
import {
  CatalogRepository,
  legacyRefToModelRowId,
  modelRowIdToLegacyRef,
} from './model-catalog.js';
import { upsertRuntimeConfig } from './runtime-config.js';
import { LLM_MODEL_SELECTION_KEY } from './llm-providers.js';

export interface TenantSelectionV2 {
  tenantId: string;
  defaultModelId: string | null;
  imageModelId: string | null;
  compactionModelId: string | null;
  fallbackModelIds: string[];
  directMode: boolean;
  revision: number;
}

export interface SelectionBackfillReport {
  totalTenants: number;
  migrated: number;
  skipped: number;
  missing: number;
  ambiguous: number;
  errors: Array<{ tenantId: string; error: string }>;
  details: Array<{
    tenantId: string;
    legacySelection: TenantModelSelection | null;
    v2Selection: TenantSelectionV2 | null;
    missingRefs: string[];
    ambiguousRefs: string[];
  }>;
}

interface V2Row {
  tenant_id: string;
  default_model_id: string | null;
  image_model_id: string | null;
  compaction_model_id: string | null;
  fallback_model_ids: string[];
  direct_mode: boolean;
  revision: number;
}

function rowToSelection(row: V2Row): TenantSelectionV2 {
  return {
    tenantId: row.tenant_id,
    defaultModelId: row.default_model_id,
    imageModelId: row.image_model_id,
    compactionModelId: row.compaction_model_id,
    fallbackModelIds: Array.isArray(row.fallback_model_ids) ? row.fallback_model_ids : [],
    directMode: row.direct_mode === true,
    revision: Number(row.revision),
  };
}

export class TenantSelectionV2Service {
  constructor(private pool: pg.Pool) {}

  /**
   * Read the V2 selection for a tenant. Returns null when no V2 row exists.
   */
  async getSelection(tenantId: string): Promise<TenantSelectionV2 | null> {
    const { rows } = await this.pool.query(
      `SELECT tenant_id, default_model_id, image_model_id, compaction_model_id,
              fallback_model_ids, direct_mode, revision
         FROM llm_tenant_selection_v2 WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!rows.length) return null;
    return rowToSelection(rows[0] as unknown as V2Row);
  }

  /**
   * Read V2 selection and convert it to the legacy TenantModelSelection format
   * (providerName/modelId refs). Used for dual-read comparison and during the
   * transition period when resolveEffectiveLlmProviders still expects legacy
   * refs.
   */
  async getSelectionAsLegacy(tenantId: string): Promise<TenantModelSelection | null> {
    const v2 = await this.getSelection(tenantId);
    if (!v2) return null;
    const catalog = await new CatalogRepository(this.pool).listRuntimeCatalog();

    const convert = (id: string | null): string | null => {
      if (!id) return null;
      return modelRowIdToLegacyRef(catalog, id);
    };

    return {
      defaultModel: convert(v2.defaultModelId),
      imageModel: convert(v2.imageModelId),
      compactionModel: convert(v2.compactionModelId),
      fallbackModels: v2.fallbackModelIds
        .map((id) => convert(id))
        .filter((ref): ref is string => ref !== null),
      directMode: v2.directMode,
      runtimeContractMode: 'v1',
    };
  }

  /**
   * Write V2 selection with CAS on revision. Performs dual-write: the legacy
   * runtime_configs row (LLM_MODEL_SELECTION) is also updated in the same
   * transaction so both representations stay in sync.
   *
   * Missing model IDs in the input keep their existing value (partial update
   * semantics). Pass null to clear a slot.
   */
  async updateSelection(
    tenantId: string,
    input: {
      defaultModelId?: string | null;
      imageModelId?: string | null;
      compactionModelId?: string | null;
      fallbackModelIds?: string[];
      directMode?: boolean;
    },
    expectedRevision: number,
    updatedBy: string | null,
  ): Promise<TenantSelectionV2> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // CAS: lock and read the current row.
      const { rows: currentRows } = await client.query(
        `SELECT * FROM llm_tenant_selection_v2 WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      const current = currentRows.length > 0 ? rowToSelection(currentRows[0] as unknown as V2Row) : null;

      if (current && current.revision !== expectedRevision) {
        await client.query('ROLLBACK');
        throw new Error(`STALE_REVISION: expected ${expectedRevision}, got ${current.revision}`);
      }

      // Merge input with existing values (partial update).
      const defaultModelId = input.defaultModelId !== undefined ? input.defaultModelId : current?.defaultModelId ?? null;
      const imageModelId = input.imageModelId !== undefined ? input.imageModelId : current?.imageModelId ?? null;
      const compactionModelId = input.compactionModelId !== undefined ? input.compactionModelId : current?.compactionModelId ?? null;
      const fallbackModelIds = input.fallbackModelIds !== undefined ? input.fallbackModelIds : current?.fallbackModelIds ?? [];
      const directMode = input.directMode !== undefined ? input.directMode : current?.directMode ?? false;
      const newRevision = (current?.revision ?? 0) + 1;

      // UPSERT V2 row.
      const { rows: upserted } = await client.query(
        `INSERT INTO llm_tenant_selection_v2
           (tenant_id, default_model_id, image_model_id, compaction_model_id,
            fallback_model_ids, direct_mode, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (tenant_id) DO UPDATE
           SET default_model_id = EXCLUDED.default_model_id,
               image_model_id = EXCLUDED.image_model_id,
               compaction_model_id = EXCLUDED.compaction_model_id,
               fallback_model_ids = EXCLUDED.fallback_model_ids,
               direct_mode = EXCLUDED.direct_mode,
               revision = EXCLUDED.revision,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()
         RETURNING *`,
        [
          tenantId,
          defaultModelId,
          imageModelId,
          compactionModelId,
          fallbackModelIds,
          directMode,
          newRevision,
          updatedBy,
        ],
      );

      // Dual-write: convert V2 stable IDs back to legacy refs and write the
      // legacy runtime_configs row so existing resolveEffectiveLlmProviders
      // continues to work during the transition.
      const catalog = await new CatalogRepository(this.pool).listRuntimeCatalog();
      const convert = (id: string | null): string | null => {
        if (!id) return null;
        return modelRowIdToLegacyRef(catalog, id);
      };
      const legacySelection: TenantModelSelection = {
        defaultModel: convert(defaultModelId),
        imageModel: convert(imageModelId),
        compactionModel: convert(compactionModelId),
        fallbackModels: fallbackModelIds
          .map((id) => convert(id))
          .filter((ref): ref is string => ref !== null),
        directMode,
        runtimeContractMode: 'v1',
      };
      await upsertRuntimeConfig(client, {
        tenantId,
        key: LLM_MODEL_SELECTION_KEY,
        value: JSON.stringify(legacySelection),
        isSecret: false,
        description: '租户模型选择（dual-write from V2 stable IDs）',
      });

      await client.query('COMMIT');
      return rowToSelection(upserted[0] as unknown as V2Row);
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

  /**
   * Backfill: migrate all active tenants' legacy selections to V2 stable IDs.
   *
   * For each tenant:
   *   1. Read legacy selection (getTenantModelSelection)
   *   2. If none exists → skipped
   *   3. Convert each legacy ref to a stable model row ID via the catalog
   *   4. Refs that can't be resolved are recorded as missing
   *   5. dryRun=true → collect report only; dryRun=false → UPSERT V2 rows
   *
   * Returns a detailed report with per-tenant results.
   */
  async backfillFromLegacy(opts: {
    dryRun: boolean;
    actor: string | null;
  }): Promise<SelectionBackfillReport> {
    const { dryRun, actor } = opts;
    const report: SelectionBackfillReport = {
      totalTenants: 0,
      migrated: 0,
      skipped: 0,
      missing: 0,
      ambiguous: 0,
      errors: [],
      details: [],
    };

    // Query all active tenants.
    const { rows: tenantRows } = await this.pool.query(
      `SELECT tenant_id FROM tenants WHERE status NOT IN ('destroyed') ORDER BY created_at`,
    );
    report.totalTenants = tenantRows.length;

    // Cache the catalog for all ref conversions.
    const catalog = await new CatalogRepository(this.pool).listRuntimeCatalog();

    for (const { tenant_id } of tenantRows) {
      const tenantId = String(tenant_id);
      try {
        const legacySelection = await getTenantModelSelection(this.pool, tenantId);
        if (!legacySelection) {
          report.skipped += 1;
          report.details.push({
            tenantId,
            legacySelection: null,
            v2Selection: null,
            missingRefs: [],
            ambiguousRefs: [],
          });
          continue;
        }

        const missingRefs: string[] = [];
        const ambiguousRefs: string[] = [];

        const convertRef = (ref: string | null): string | null => {
          if (!ref) return null;
          const id = legacyRefToModelRowId(catalog, ref);
          if (!id) {
            missingRefs.push(ref);
            return null;
          }
          return id;
        };

        const defaultModelId = convertRef(legacySelection.defaultModel);
        const imageModelId = convertRef(legacySelection.imageModel);
        const compactionModelId = convertRef(legacySelection.compactionModel);
        const fallbackModelIds = (legacySelection.fallbackModels ?? [])
          .map((ref) => convertRef(ref))
          .filter((id): id is string => id !== null);

        if (missingRefs.length > 0) {
          report.missing += 1;
        }

        if (!dryRun) {
          // UPSERT the V2 row directly (not via updateSelection to avoid the
          // dual-write back to legacy — the legacy row already exists).
          await this.pool.query(
            `INSERT INTO llm_tenant_selection_v2
               (tenant_id, default_model_id, image_model_id, compaction_model_id,
                fallback_model_ids, direct_mode, revision, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, NOW())
             ON CONFLICT (tenant_id) DO UPDATE
               SET default_model_id = EXCLUDED.default_model_id,
                   image_model_id = EXCLUDED.image_model_id,
                   compaction_model_id = EXCLUDED.compaction_model_id,
                   fallback_model_ids = EXCLUDED.fallback_model_ids,
                   direct_mode = EXCLUDED.direct_mode,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
            [
              tenantId,
              defaultModelId,
              imageModelId,
              compactionModelId,
              fallbackModelIds,
              legacySelection.directMode,
              actor,
            ],
          );
          report.migrated += 1;
        } else {
          // In dry-run mode, count as migrated only if there are no missing refs.
          if (missingRefs.length === 0) {
            report.migrated += 1;
          }
        }

        const v2Selection: TenantSelectionV2 = {
          tenantId,
          defaultModelId,
          imageModelId,
          compactionModelId,
          fallbackModelIds,
          directMode: legacySelection.directMode,
          revision: 0,
        };

        report.details.push({
          tenantId,
          legacySelection,
          v2Selection,
          missingRefs,
          ambiguousRefs,
        });
      } catch (err) {
        report.errors.push({
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return report;
  }

  /**
   * Dual-read comparison: read the legacy selection and the V2 selection
   * (converted to legacy format), then compare field-by-field.
   *
   * Returns match=true when all fields are identical, or a list of
   * differences explaining the mismatch.
   */
  async compareSelections(tenantId: string): Promise<{
    match: boolean;
    legacySelection: TenantModelSelection | null;
    v2SelectionAsLegacy: TenantModelSelection | null;
    differences: string[];
  }> {
    const legacySelection = await getTenantModelSelection(this.pool, tenantId);
    const v2SelectionAsLegacy = await this.getSelectionAsLegacy(tenantId);
    const differences: string[] = [];

    // Normalize: treat null and undefined the same.
    const norm = (v: string | null | undefined): string | null =>
      v ?? null;

    // Compare defaultModel
    if (norm(legacySelection?.defaultModel) !== norm(v2SelectionAsLegacy?.defaultModel)) {
      differences.push(
        `defaultModel: legacy=${norm(legacySelection?.defaultModel)} vs v2=${norm(v2SelectionAsLegacy?.defaultModel)}`,
      );
    }

    // Compare imageModel
    if (norm(legacySelection?.imageModel) !== norm(v2SelectionAsLegacy?.imageModel)) {
      differences.push(
        `imageModel: legacy=${norm(legacySelection?.imageModel)} vs v2=${norm(v2SelectionAsLegacy?.imageModel)}`,
      );
    }

    // Compare compactionModel
    if (norm(legacySelection?.compactionModel) !== norm(v2SelectionAsLegacy?.compactionModel)) {
      differences.push(
        `compactionModel: legacy=${norm(legacySelection?.compactionModel)} vs v2=${norm(v2SelectionAsLegacy?.compactionModel)}`,
      );
    }

    // Compare directMode
    const legacyDirect = legacySelection?.directMode === true;
    const v2Direct = v2SelectionAsLegacy?.directMode === true;
    if (legacyDirect !== v2Direct) {
      differences.push(`directMode: legacy=${legacyDirect} vs v2=${v2Direct}`);
    }

    // Compare fallbackModels (null vs null, array vs array)
    const legacyFallbacks = legacySelection?.fallbackModels ?? null;
    const v2Fallbacks = v2SelectionAsLegacy?.fallbackModels ?? null;
    if (legacyFallbacks === null && v2Fallbacks === null) {
      // both follow global — match
    } else if (legacyFallbacks === null || v2Fallbacks === null) {
      differences.push(
        `fallbackModels: legacy=${JSON.stringify(legacyFallbacks)} vs v2=${JSON.stringify(v2Fallbacks)}`,
      );
    } else if (JSON.stringify(legacyFallbacks) !== JSON.stringify(v2Fallbacks)) {
      differences.push(
        `fallbackModels: legacy=${JSON.stringify(legacyFallbacks)} vs v2=${JSON.stringify(v2Fallbacks)}`,
      );
    }

    return {
      match: differences.length === 0,
      legacySelection,
      v2SelectionAsLegacy,
      differences,
    };
  }
}
