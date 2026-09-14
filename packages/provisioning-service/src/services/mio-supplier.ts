/**
 * Per-tenant Mio CDP supplier identifier management.
 *
 * The supplier id is the credential tenant skills use when calling the Mio
 * CDP API (X-Supplier-Id / MIO_CDP_SUPPLIER_ID env var — see the _client.py
 * scripts inside dealclaw-agent payload skills). It is stored on the
 * tenants row and injected into the `dealclaw-agent-config-<tenant>` Secret
 * (envFrom of the dealclaw-agent Deployment).
 *
 * Uniqueness: one supplier id maps to one live customer — enforced both by a
 * pre-check here (friendly 409 with the conflicting tenant's name) and by the
 * partial unique index tenants_mio_supplier_uq in the DB.
 */

import type pg from 'pg';
import {
  getSecret,
  putSecret,
  restartDeployment,
} from './k8s-client.js';
import { updateSkillEnvSecret } from './skill-env.js';
import { assertMioConfigured, searchMioSuppliers, MioApiError } from './mio-supplier-client.js';
import type { ProvisioningConfig } from '../config.js';

export const MIO_SUPPLIER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class MioSupplierError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MioSupplierError';
  }
}

export interface MioSupplierResult {
  ok: true;
  tenantId: string;
  supplierId: string | null;
  /** True when the tenant agent Deployment was rolled to pick up the new env. */
  restarted: boolean;
  agentSecret: string | null;
}

interface TenantRow {
  tenant_id: string;
  company_name: string | null;
  status: string;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
  plan_tier: string;
  quota_credits_monthly: string;
  credits_account_id: string | null;
  mio_cdp_supplier_id: string | null;
}

/** Decode a K8s secret's base64 `data` into raw string values. */
function decodeSecretData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    try {
      out[k] = Buffer.from(v, 'base64').toString('utf8');
    } catch {
      // keep undecodable entries as-is (shouldn't happen for stringData secrets)
      out[k] = v;
    }
  }
  return out;
}

/**
 * Set (or clear, when supplierId is empty/null) a tenant's Mio CDP supplier
 * id: DB row + agent-config Secret + agent Pod rollout.
 */
export async function updateTenantMioSupplier(
  pool: pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  supplierId: string | null | undefined,
): Promise<MioSupplierResult> {
  const trimmed = (supplierId ?? '').trim();
  if (trimmed && !MIO_SUPPLIER_ID_PATTERN.test(trimmed)) {
    throw new MioSupplierError(
      400,
      'BAD_SUPPLIER_ID',
      'Mio CDP 供应商 ID 格式不正确（1–64 位字母、数字、下划线或连字符）',
    );
  }
  const next = trimmed || null;

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, company_name, status, k8s_namespace, agent_endpoint,
            plan_tier, quota_credits_monthly, credits_account_id, mio_cdp_supplier_id
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new MioSupplierError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new MioSupplierError(400, 'TENANT_DESTROYED', '租户已销毁，无法修改');
  }
  if (tenant.mio_cdp_supplier_id === next) {
    // Idempotent no-op.
    return { ok: true, tenantId, supplierId: next, restarted: false, agentSecret: null };
  }

  if (next) {
    const { rows: conflicts } = await pool.query(
      `SELECT tenant_id, company_name FROM tenants
        WHERE mio_cdp_supplier_id = $1 AND tenant_id <> $2 AND status <> 'destroyed'`,
      [next, tenantId],
    );
    if (conflicts.length) {
      throw new MioSupplierError(
        409,
        'SUPPLIER_ID_TAKEN',
        `该 Mio CDP 供应商 ID 已绑定客户「${conflicts[0].company_name || conflicts[0].tenant_id}」，一个供应商 ID 只能对应一个客户`,
      );
    }
  }

  await pool.query(
    `UPDATE tenants SET mio_cdp_supplier_id = $1, updated_at = NOW() WHERE tenant_id = $2`,
    [next, tenantId],
  ).catch((err: unknown) => {
    // Pre-check 之外的第二道闸：并发下仍可能撞上 tenants_mio_supplier_uq
    // 这个部分唯一索引（WHERE status <> 'destroyed'）。DB 原文是英文约束名，
    // 这里翻成可读中文，避免把 500 抛给前端。
    const e = err as any;
    if (e?.code === '23505' && e?.constraint === 'tenants_mio_supplier_uq') {
      throw new MioSupplierError(
        409,
        'SUPPLIER_ID_TAKEN',
        '该米奥供应商 ID 已被其他客户占用（并发写入被唯一约束拦截），一个供应商 ID 只能对应一个客户',
      );
    }
    throw err;
  });

  // External-agent tenants (agent_endpoint) have no agent-config secret of
  // their own — the central agent's env is managed via ArgoCD/GitOps.
  const hasOwnAgent = Boolean(tenant.k8s_namespace) && !tenant.agent_endpoint;

  if (config.k8sDryRun || !hasOwnAgent) {
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, $2, $3)`,
      [
        tenantId,
        tenant.status,
        hasOwnAgent
          ? `DRY_RUN: Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'}`
          : `Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'} (no per-tenant agent — secret not updated)`,
      ],
    );
    return { ok: true, tenantId, supplierId: next, restarted: false, agentSecret: null };
  }

  // Merge MIO_CDP_SUPPLIER_ID into the existing agent-config Secret. K8s GET
  // returns base64 data and PUT (stringData) replaces the whole content, so
  // decode → modify → put to keep the other keys (TENANT_ID, PLAN_TIER, …).
  const namespace = tenant.k8s_namespace as string;
  const agentSecretName = `dealclaw-agent-config-${tenantId}`;
  const existing = await getSecret(namespace, agentSecretName);
  const data = existing ? decodeSecretData(existing.data) : {
    DEALCLAW_TENANT_ID: tenantId,
    DEALCLAW_PLAN_TIER: tenant.plan_tier,
    DEALCLAW_INITIAL_CREDITS: String(tenant.quota_credits_monthly ?? 0),
  };
  if (next) {
    data.MIO_CDP_SUPPLIER_ID = next;
  } else {
    delete data.MIO_CDP_SUPPLIER_ID;
  }
  await putSecret(namespace, agentSecretName, data);

  // Also refresh the skill-env Secret (.env) — shell skill scripts read
  // MIO_CDP_SUPPLIER_ID from work/mio-api/.env and pick the new value up on
  // their next invocation without waiting for the rollout below.
  try {
    await updateSkillEnvSecret(pool, config, tenantId);
  } catch (err) {
    console.warn(`skill-env refresh after supplier-id update failed for ${tenantId}:`, err);
  }

  // Roll the agent Pod so the running container picks up the new env var.
  const agentDeployment = `dealclaw-agent-${tenantId}`;
  let restarted = false;
  try {
    restarted = await restartDeployment(namespace, agentDeployment);
  } catch (err: unknown) {
    const e = err as any;
    if (!/404|not found/i.test(e?.message || '')) throw err;
  }

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, tenant.status, `Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'} — secret ${agentSecretName}${restarted ? ` updated, agent ${agentDeployment} restarted` : ' updated'}`],
  );

  return { ok: true, tenantId, supplierId: next, restarted, agentSecret: agentSecretName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 存量补录：按公司名在米奥侧找供应商并回填 mio_cdp_supplier_id
// ─────────────────────────────────────────────────────────────────────────────

/** 名称归一：忽略大小写与首尾空格的完整名称比较。 */
function normalizeCompanyName(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/** 「唯一精确命中」判定：两边归一后完全相等，且非空。 */
export function isExactCompanyNameMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeCompanyName(a);
  return left !== '' && left === normalizeCompanyName(b);
}

export interface MioBackfillEntry {
  tenantId: string;
  companyName: string;
  /** 写库用的米奥供应商 id（搜索结果里的 `id`）。 */
  supplierId: string;
  supplierName: string | null;
  supplierCode: string | null;
  /** dryRun 时为 would_bind（只报告不写库）。 */
  action: 'bound' | 'would_bind';
  restarted?: boolean;
}

export type MioBackfillSkipReason =
  /** 米奥侧 0 条命中 */
  | 'no_match'
  /** 米奥侧多条命中 —— 绝不自动取第一条 */
  | 'multiple_matches'
  /** 不在候选范围（已绑定 / 无公司名 / 已销毁 / 租户不存在） */
  | 'not_candidate'
  /** 米奥接口调用失败（网络/HTTP/业务） */
  | 'lookup_failed'
  /** 命中唯一但写库失败（唯一冲突等） */
  | 'bind_failed';

export interface MioBackfillSkip {
  tenantId: string;
  companyName: string | null;
  reason: MioBackfillSkipReason;
  detail?: string;
  /** multiple_matches 时列出全部候选（含 id），便于人工选择。 */
  candidates?: { id: string; code: string | null; name: string | null }[];
}

export interface MioBackfillResult {
  dryRun: boolean;
  /** 参与扫描的候选租户数（company_name 非空 && supplier id 为空 && 未销毁）。 */
  scanned: number;
  /** 唯一精确命中的租户数。 */
  matched: number;
  /** 实际写入库的租户数（dryRun 时恒为 0）。 */
  updated: number;
  entries: MioBackfillEntry[];
  skipped: MioBackfillSkip[];
}

interface BackfillCandidateRow {
  tenant_id: string;
  company_name: string | null;
}

interface BackfillRequestedRow extends BackfillCandidateRow {
  status: string;
  mio_cdp_supplier_id: string | null;
}

/**
 * 存量补录：对「company_name 非空 + mio_cdp_supplier_id 为空」的租户按公司名
 * 搜索米奥供应商，**只有唯一精确命中才写入**；0 条或多条一律进 skipped，
 * 绝不自动取第一条。默认 dryRun=true（只报告不写库）。
 *
 * 注意：这里的 dryRun 语义是「不写 tenants 表」。它和 config.k8sDryRun
 * （只跳过 K8s 操作）不是一回事——后者仍会写库。
 */
export async function backfillTenantMioSuppliers(
  pool: pg.Pool,
  config: ProvisioningConfig,
  options: { tenantIds?: string[]; dryRun?: boolean } = {},
): Promise<MioBackfillResult> {
  const dryRun = options.dryRun !== false;
  const tenantIds = Array.isArray(options.tenantIds) && options.tenantIds.length
    ? options.tenantIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : null;

  // 先确认 Blade-Auth 已配置：避免扫到一半才失败。（只读 env，不回显）
  assertMioConfigured(config);

  const { rows: candidates } = await pool.query<BackfillCandidateRow>(
    `SELECT tenant_id, company_name FROM tenants
      WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
        AND mio_cdp_supplier_id IS NULL
        AND status <> 'destroyed'
        AND ($1::text[] IS NULL OR tenant_id = ANY($1::text[]))
      ORDER BY created_at, tenant_id`,
    [tenantIds],
  );

  const skipped: MioBackfillSkip[] = [];

  // 指定了 tenantIds 时，把「被点名但不满足候选条件」的租户也如实回报，
  // 否则操作者会以为漏跑了。
  if (tenantIds) {
    const { rows: requested } = await pool.query<BackfillRequestedRow>(
      `SELECT tenant_id, company_name, status, mio_cdp_supplier_id
         FROM tenants WHERE tenant_id = ANY($1::text[])`,
      [tenantIds],
    );
    const requestedMap = new Map(requested.map((r) => [r.tenant_id, r]));
    const candidateIds = new Set(candidates.map((c) => c.tenant_id));
    for (const id of tenantIds) {
      if (candidateIds.has(id)) continue;
      const row = requestedMap.get(id);
      let detail = '租户不存在';
      if (row) {
        if (row.status === 'destroyed') detail = '租户已销毁';
        else if (row.mio_cdp_supplier_id) detail = `已绑定供应商 ID ${row.mio_cdp_supplier_id}`;
        else if (!normalizeCompanyName(row.company_name)) detail = '公司名为空';
        else detail = '不满足补录条件';
      }
      skipped.push({ tenantId: id, companyName: row?.company_name ?? null, reason: 'not_candidate', detail });
    }
  }

  const entries: MioBackfillEntry[] = [];
  let updated = 0;

  for (const candidate of candidates) {
    const tenantId = candidate.tenant_id;
    const companyName = (candidate.company_name ?? '').trim();

    let items: { id: string; code: string | null; name: string | null }[];
    try {
      const search = await searchMioSuppliers(config, { search: companyName });
      items = search.items;
    } catch (err: unknown) {
      // 配置类错误（如 token 缺失）：整批都跑不动，直接失败退出。
      if (err instanceof MioApiError && err.kind === 'config') throw err;
      skipped.push({
        tenantId,
        companyName,
        reason: 'lookup_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const exact = items.filter((item) => isExactCompanyNameMatch(item.name, companyName));
    if (exact.length === 0) {
      skipped.push({
        tenantId,
        companyName,
        reason: 'no_match',
        detail: `米奥侧未匹配到名称完全一致的供应商（模糊命中 ${items.length} 条）`,
      });
      continue;
    }
    if (exact.length > 1) {
      skipped.push({
        tenantId,
        companyName,
        reason: 'multiple_matches',
        detail: `名称完全一致的供应商有 ${exact.length} 条，需人工指定`,
        candidates: exact.map((i) => ({ id: i.id, code: i.code, name: i.name })),
      });
      continue;
    }

    const hit = exact[0];
    if (dryRun) {
      entries.push({
        tenantId,
        companyName,
        supplierId: hit.id,
        supplierName: hit.name,
        supplierCode: hit.code,
        action: 'would_bind',
      });
      continue;
    }

    try {
      const bound = await updateTenantMioSupplier(pool, config, tenantId, hit.id);
      updated += 1;
      entries.push({
        tenantId,
        companyName,
        supplierId: hit.id,
        supplierName: hit.name,
        supplierCode: hit.code,
        action: 'bound',
        restarted: bound.restarted,
      });
    } catch (err: unknown) {
      skipped.push({
        tenantId,
        companyName,
        reason: 'bind_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dryRun,
    scanned: candidates.length,
    matched: entries.length,
    updated,
    entries,
    skipped,
  };
}
