/**
 * 建租户领域逻辑（从 routes/tenants.ts 的 POST /v1/tenants 抽出）。
 *
 * 目的：路由与「一键开通流水线」（routes/onboarding.ts 的 quick-start）共用
 * 同一段逻辑，**避免 HTTP 自调**；同时保证 POST /v1/tenants 的行为与响应
 * 完全向后兼容（响应体组装仍在路由里，错误语义靠 TenantCreateError 上抛）。
 *
 * 既有语义（保持不动的关键点）：
 *   1. companyName / contactEmail 可缺省（QR 流程先建后补）；planTier 非法降级
 *      starter；quotaAgents / quotaCreditsMonthly 有上下限。
 *   2. 带飞书 bot 凭据 → 默认识到 openclaw 直连平面并立即 provision；
 *      **不带凭据 → 只写客户记录 + credits 账户，不建工作负载**（status 保持
 *      pending，等 PUT /v1/tenants/:id/credentials 拿到凭据后再开通）。
 *   3. mioCdpSupplierId 可选，唯一约束冲突翻成可读 409。
 *   4. DB 操作在一个事务里；K8s provision 在 commit 之后，失败则落
 *      provisioning_failed（DB 记录保留，便于重试）。
 *   5. 建租户 env = runtime_configs（全局/租户）+ global_defaults（「默认配置」
 *      页）合并；全局默认缺失只标记「未就绪」，不阻断开通。
 */

import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  provisionTenant,
  type ProvisionResult,
} from './provisioning.js';
import { createCreditsAccount } from './credits-account.js';
import { MIO_SUPPLIER_ID_PATTERN } from './mio-supplier.js';
import { getGlobalLlmProviders, applyTenantLlmConfig } from './llm-providers.js';
import { resolveEffectiveTenantEnv } from './tenant-env.js';
import type { ProvisioningConfig } from '../config.js';

/** 建租户失败：携带建议 HTTP status / 错误码，由路由层原样映射。 */
export class TenantCreateError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantCreateError';
  }
}

export interface CreateTenantRequest {
  companyName?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  planTier?: unknown;
  quotaAgents?: unknown;
  quotaCreditsMonthly?: unknown;
  botAppId?: unknown;
  botAppSecret?: unknown;
  mioCdpSupplierId?: unknown;
  messagePlane?: unknown;
}

/** 建租户结果里与响应体一一对应的租户快照。 */
export interface CreatedTenantSnapshot {
  tenantId: string;
  companyName: string;
  contactEmail: string;
  planTier: 'starter' | 'pro' | 'enterprise';
  status: string;
  quotaAgents: number;
  quotaCreditsMonthly: number;
  mioCdpSupplierId: string | null;
  k8sNamespace: string;
  messagePlane: 'gateway' | 'openclaw';
  /** 仅在真正 provision 的分支返回（与旧响应字段一致）。 */
  secretsCreated?: string[];
  podsScheduled?: string[];
}

export interface CreateTenantOutcome {
  /** true = 已 provision K8s 工作负载；false = 仅客户记录（等凭据）。 */
  provisioned: boolean;
  tenant: CreatedTenantSnapshot;
  /** provision 结果（未 provision 时为 null，与旧响应 provisioning 字段一致）。 */
  provisioning: ProvisionResult | null;
  /** 全局默认配置未就绪的 key（不阻断，调用方可提示）。 */
  missingDefaultKeys: string[];
}

export interface CreateTenantDeps {
  pool: pg.Pool;
  config: ProvisioningConfig;
}

/**
 * 建租户。返回 outcome；失败抛 TenantCreateError（status/code 由路由映射）。
 */
export async function createTenant(
  deps: CreateTenantDeps,
  body: CreateTenantRequest,
): Promise<CreateTenantOutcome> {
  const { pool, config } = deps;
  const {
    companyName,
    contactEmail,
    contactPhone,
    planTier,
    quotaAgents,
    quotaCreditsMonthly,
    botAppId,
    botAppSecret,
    mioCdpSupplierId,
  } = body;

  // Validate required fields
  // companyName: optional for QR-flow tenants (collected later by agent)
  const hasCompanyName = companyName && typeof companyName === 'string' && companyName.trim().length > 0;
  // contactEmail: optional for QR-flow tenants (collected later by agent)
  const hasContactEmail = contactEmail && typeof contactEmail === 'string' && contactEmail.includes('@');
  const safePlanTier = (['starter', 'pro', 'enterprise'] as const).includes(planTier as any)
    ? (planTier as 'starter' | 'pro' | 'enterprise')
    : 'starter';
  const safeQuotaAgents = Math.max(1, Math.min(Number(quotaAgents ?? 1), 100));
  const safeQuotaCredits = Math.max(0, Math.min(Number(quotaCreditsMonthly ?? 1_000_000), 100_000_000));

  // NS2 FIX: Use full UUID instead of 8-char hex (32-bit entropy → 128-bit entropy)
  const tenantId = uuidv4().replace(/-/g, '');
  const safeName = hasCompanyName
    ? (companyName as string).trim().replace(/[<>"';&|`$]/g, '').slice(0, 200)
    : 'new-tenant';
  const safeEmail = hasContactEmail ? (contactEmail as string) : `pending-${tenantId.slice(0, 8)}@dealclaw.cn`;
  const safePhone = contactPhone ? String(contactPhone).replace(/[^0-9+ -]/g, '').slice(0, 30) : null;
  const safeAppId =
    botAppId && typeof botAppId === 'string' && botAppId.trim() ? botAppId.trim().slice(0, 64) : null;
  const safeAppSecret =
    botAppSecret && typeof botAppSecret === 'string' && botAppSecret.trim() ? botAppSecret.trim().slice(0, 128) : null;

  // Message plane: Feishu bot credentials present → default to the
  // openclaw direct-connect plane (feishu WS inside the tenant agent).
  // Without credentials the gateway bridge is the only workable default.
  // An explicit body.messagePlane wins, but 'openclaw' requires creds.
  const explicitPlane = body.messagePlane;
  const hasBotCreds = Boolean(safeAppId && safeAppSecret);
  if (explicitPlane === 'openclaw' && !hasBotCreds) {
    throw new TenantCreateError(
      400,
      'NO_BOT_CREDENTIALS',
      'messagePlane=openclaw 需要同时提供 botAppId 与 botAppSecret',
    );
  }
  const messagePlane: 'gateway' | 'openclaw' =
    explicitPlane === 'gateway' || explicitPlane === 'openclaw'
      ? explicitPlane
      : hasBotCreds
        ? 'openclaw'
        : 'gateway';
  // Customer-only creation (no bot credentials) must NEVER land on the
  // gateway plane: without credentials the gateway WS bridge cannot
  // connect to Feishu at all — the root cause of "先建后绑" tenants.
  // Pin the DB plane to the desired end state 'openclaw' so the later
  // auto-provision (PUT /v1/tenants/:id/credentials) comes up correctly.
  const dbMessagePlane = hasBotCreds ? messagePlane : 'openclaw';

  // Mio CDP supplier id — optional, unique among live tenants, injected
  // into the tenant agent's environment as MIO_CDP_SUPPLIER_ID.
  const rawSupplierId = typeof mioCdpSupplierId === 'string' ? mioCdpSupplierId.trim() : '';
  if (rawSupplierId && !MIO_SUPPLIER_ID_PATTERN.test(rawSupplierId)) {
    throw new TenantCreateError(
      400,
      'BAD_SUPPLIER_ID',
      'Mio CDP 供应商 ID 格式不正确（1–64 位字母、数字、下划线或连字符）',
    );
  }
  const safeSupplierId = rawSupplierId || null;
  // Tenant workloads are fully isolated in a per-tenant namespace.
  const k8sNs = `dealclaw-${tenantId}`;
  const creditsAccountId = `acct_${tenantId}`;

  // NS3 FIX: Wrap DB operations in transaction to prevent partial writes.
  // K8s provisioning happens after commit; if it fails, tenant status gets updated.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO tenants (tenant_id, company_name, contact_email, contact_phone, plan_tier, k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly, app_id, app_secret, mio_cdp_supplier_id, message_plane)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, safeName, safeEmail, safePhone, safePlanTier, k8sNs, creditsAccountId, safeQuotaAgents, safeQuotaCredits, safeAppId, safeAppSecret, safeSupplierId, dbMessagePlane],
    );

    await client.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, NULL, 'pending', 'Tenant created')`,
      [tenantId],
    );

    await client.query('COMMIT');
  } catch (dbErr: unknown) {
    const e = dbErr as any;
    await client.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505') {
      if (e?.constraint === 'tenants_mio_supplier_uq') {
        throw new TenantCreateError(409, 'SUPPLIER_ID_TAKEN', '该 Mio CDP 供应商 ID 已绑定其他客户');
      }
      throw new TenantCreateError(409, 'DUPLICATE', 'Tenant with this email already exists');
    }
    throw dbErr;
  } finally {
    client.release();
  }

  // Issue 1 FIX: 创建 credits-ledger 客户账户（身份一致：tenantId=UUID）。
  // 账户 id = acct_<UUID>，与 tenants.credits_account_id 对齐，否则 agent 计费
  // 会 ACCOUNT_NOT_FOUND。幂等：已存在 → DUPLICATE → ok。
  const creditsResult = await createCreditsAccount({
    tenantId,
    companyName: safeName,
    contactEmail: hasContactEmail ? (contactEmail as string) : undefined,
    planTier: safePlanTier,
    creditsLedgerUrl: config.creditsLedgerUrl,
    creditsLedgerToken: config.creditsLedgerToken,
  });
  if (!creditsResult.ok) {
    console.error('credits-ledger account creation failed:', creditsResult.error);
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, 'pending', 'provisioning_failed', $2)`,
      [tenantId, `credits account creation failed: ${creditsResult.error?.slice(0, 200)}`],
    );
    await pool.query(`UPDATE tenants SET status = 'provisioning_failed' WHERE tenant_id = $1`, [tenantId]);
    throw new TenantCreateError(
      500,
      'PROVISIONING_FAILED',
      'Tenant created but credits account creation failed',
    );
  }

  // Requirement (2026-08-27): a customer created WITHOUT Feishu bot
  // credentials must NOT get an agent. Previously this silently created
  // a gateway-plane agent whose WS bridge could never connect — the root
  // cause of "先建后绑" (create first, bind later) tenants landing on the
  // wrong message plane. Only the customer record + credits account are
  // created here; the agent is provisioned later when credentials are
  // bound, via PUT /v1/tenants/:id/credentials (auto-provision path).
  if (!hasBotCreds) {
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, 'pending', 'pending', 'No Feishu credentials — agent provisioning deferred until creds bound')`,
      [tenantId],
    );
    return {
      provisioned: false,
      missingDefaultKeys: [],
      provisioning: null,
      tenant: {
        tenantId,
        companyName: safeName,
        contactEmail: safeEmail,
        planTier: safePlanTier,
        status: 'pending',
        quotaAgents: safeQuotaAgents,
        quotaCreditsMonthly: safeQuotaCredits,
        mioCdpSupplierId: safeSupplierId,
        k8sNamespace: k8sNs,
        messagePlane: dbMessagePlane,
      },
    };
  }

  // Provision K8s resources (after DB commit — if this fails, update status)
  let provisionResult: ProvisionResult;
  let missingDefaultKeys: string[] = [];
  try {
    // Resolve runtime config (global defaults + tenant overrides) from the
    // runtime_configs table, merged with the 「默认配置」页的 global_defaults
    // （全局默认 key 与主群规则）。Skipped in dry-run mode so local/test flows
    // don't require RUNTIME_CONFIG_KEY. Resolution failures (missing
    // master key, empty config) mark the tenant provisioning_failed below.
    let runtimeSecretData: Record<string, string> | undefined;
    if (!config.k8sDryRun) {
      const resolvedEnv = await resolveEffectiveTenantEnv(pool, tenantId);
      runtimeSecretData = resolvedEnv.env;
      missingDefaultKeys = resolvedEnv.missingDefaults;
    }

    provisionResult = await provisionTenant({
      tenantId,
      companyName: safeName,
      contactEmail: (contactEmail as string | undefined) ?? safeEmail,
      planTier: safePlanTier,
      quotaAgents: safeQuotaAgents,
      quotaCreditsMonthly: safeQuotaCredits,
      appId: safeAppId || undefined,
      appSecret: safeAppSecret || undefined,
      messagePlane,
      mioCdpSupplierId: safeSupplierId || undefined,
    }, {
      dryRun: config.k8sDryRun,
      runtimeNamespace: config.runtimeNamespace,
      imageRegistry: config.imageRegistry,
      nexusGatewayImageTag: config.nexusGatewayImageTag,
      dealclawAgentImageTag: config.dealclawAgentImageTag,
      runtimeSecretData,
      // Resolve promoted rollout targets so the new tenant's gateway and
      // agent run the same image version the fleet was rolled to.
      dbPool: pool,
    });
  } catch (provErr: unknown) {
    const e = provErr as any;
    console.error('K8s provisioning failed:', e);
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, 'pending', 'provisioning_failed', $2)`,
      [tenantId, e.message?.slice(0, 255) || 'Provisioning failed'],
    );
    await pool.query(`UPDATE tenants SET status = 'provisioning_failed' WHERE tenant_id = $1`, [tenantId]);
    throw new TenantCreateError(500, 'PROVISIONING_FAILED', 'Tenant created but K8s provisioning failed');
  }

  // 全局默认 key 未就绪：不阻断开通，只把缺失的 key 名追进 provisioning.warnings
  // （由 admin-web 提「未就绪」）。缺省不阻断是既定决策；日志/响应都不含值。
  if (missingDefaultKeys.length) {
    provisionResult.warnings.push(
      `全局默认配置未就绪：${missingDefaultKeys.join(', ')}（不阻断开通，可在「默认配置」页补齐后同步到存量 Agent）`,
    );
  }

  // Provisioning succeeded — activate the tenant. The ops-agent state
  // machine defines no automatic transition out of 'pending', so without
  // this a successfully provisioned tenant would stay pending forever.
  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, 'pending', 'active', 'K8s provisioning completed')`,
    [tenantId],
  );
  await pool.query(
    `UPDATE tenants SET status = 'active', updated_at = NOW() WHERE tenant_id = $1`,
    [tenantId],
  );

  // 方案1 修复：provisioning 后立即把 LLM_PROVIDERS 重写为网关态，
  // 避免「创建后无全局库改动」时直连上游绕过网关计费（见 helper 注释）。
  await rewriteTenantLlmToGateway({ pool, config }, tenantId);

  return {
    provisioned: true,
    missingDefaultKeys,
    provisioning: provisionResult,
    tenant: {
      tenantId,
      companyName: safeName,
      contactEmail: safeEmail,
      planTier: safePlanTier,
      status: 'active',
      quotaAgents: safeQuotaAgents,
      quotaCreditsMonthly: safeQuotaCredits,
      mioCdpSupplierId: safeSupplierId,
      k8sNamespace: provisionResult.namespace,
      messagePlane,
      secretsCreated: provisionResult.secrets,
      podsScheduled: provisionResult.pods,
    },
  };
}

/**
 * 新建租户 provisioning 后立即把 LLM_PROVIDERS 重写为网关态。
 *
 * 根因：provisioning 步骤 1b 把全局库的真实上游 baseUrl 原样写进
 * tenant-config，1d 把 llm-proxy-config 初始化为空 {}，指望后续
 * pushLlmProviders 补齐。但 push 只在「有人改全局库」时触发，凡
 * 「创建后没再触发过全局库保存」的新租户都会直连上游、绕过网关的
 * 余额拦截 + token 计费。这里建租户成功后补一次单租户 scope 重写：
 * baseUrl → nexus-gateway /v1/llm/<name>，真实地址进 LLM_UPSTREAMS，
 * 并滚动 agent + gateway 让重写后的 Secret 生效。
 *
 * 幂等 + fail-open：applyTenantLlmConfig 内部合并现有 Secret、try-catch
 * 返回 ok:false 不抛错；此处再包一层，任何失败只打日志，不阻断建租户。
 */
export async function rewriteTenantLlmToGateway(
  deps: CreateTenantDeps,
  tenantId: string,
): Promise<void> {
  const { pool, config } = deps;
  if (config.k8sDryRun) return; // dry-run / test 流程无真实 K8s
  try {
    const nowLibrary = await getGlobalLlmProviders(pool);
    if (!nowLibrary || nowLibrary.providers.length === 0) {
      console.warn(`[provision] skip LLM gateway rewrite for ${tenantId}: global library empty`);
      return;
    }
    const outcome = await applyTenantLlmConfig(pool, config, tenantId, nowLibrary, null, tenantId);
    if (!outcome.ok) {
      console.error(`[provision] LLM gateway rewrite failed for ${tenantId}: ${outcome.error}`);
    }
  } catch (err: unknown) {
    const e = err as Error;
    console.error(`[provision] LLM gateway rewrite error for ${tenantId}: ${e?.message ?? String(err)}`);
  }
}
