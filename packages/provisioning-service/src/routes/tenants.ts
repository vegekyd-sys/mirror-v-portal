import { Router, type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { provisionTenant, deprovisionTenant, backupTenantData, restoreTenantData, tenantNamespace, switchTenantMessagePlane } from '../services/provisioning.js';
import { resolveTenantConfig } from '../services/runtime-config.js';
import { createCreditsAccount } from '../services/credits-account.js';
import { getTenantRuntimeStatus } from '../services/k8s-client.js';
import {
  FeishuBindingError,
  getTenantFeishuBinding,
  bindTenantFeishuApp,
  unbindTenantFeishuApp,
} from '../services/feishu-binding.js';
import {
  MioSupplierError,
  MIO_SUPPLIER_ID_PATTERN,
  updateTenantMioSupplier,
} from '../services/mio-supplier.js';
import {
  SkillEnvError,
  getTenantSkillEnvView,
  pushTenantSkillEnv,
} from '../services/skill-env.js';
import { getMasterKey } from '../services/crypto.js';
import type { ProvisioningConfig } from '../config.js';

export function createTenantRoutes(pool: pg.Pool, config: ProvisioningConfig, authMiddleware?: (req: Request, res: Response, next: NextFunction) => void) {

  const registry = config.imageRegistry;

  /** Construct full docker image from tag-only or short references */
  function normalizeImage(service: string, img: string): string {
    if (img.includes('/')) return img; // already full path like registry/service:tag
    if (img.includes(':')) {
      // Short form like repo:tag — prepend registry/
      return `${registry}/${service}:${img.split(':').pop()}`;
    }
    // Plain tag — construct full image
    return `${registry}/${service}:${img}`;
  }
  const router = Router();

  // NB2 FIX: Apply Bearer token auth to all tenant routes
  if (authMiddleware) {
    router.use(authMiddleware);
  }

  // POST /v1/tenants — create new tenant
  router.post('/v1/tenants', async (req: Request, res: Response) => {
    try {
      const { companyName, contactEmail, contactPhone, planTier, quotaAgents, quotaCreditsMonthly, botAppId, botAppSecret, mioCdpSupplierId } = req.body;

      // Validate required fields
      // companyName: optional for QR-flow tenants (collected later by agent)
      const hasCompanyName = companyName && typeof companyName === 'string' && companyName.trim().length > 0;
      // contactEmail: optional for QR-flow tenants (collected later by agent)
      const hasContactEmail = contactEmail && typeof contactEmail === 'string' && contactEmail.includes('@');
      const safePlanTier = (['starter', 'pro', 'enterprise'] as const).includes(planTier) ? planTier : 'starter';
      const safeQuotaAgents = Math.max(1, Math.min(Number(quotaAgents ?? 1), 100));
      const safeQuotaCredits = Math.max(0, Math.min(Number(quotaCreditsMonthly ?? 1_000_000), 100_000_000));

      // NS2 FIX: Use full UUID instead of 8-char hex (32-bit entropy → 128-bit entropy)
      const tenantId = uuidv4().replace(/-/g, '');
      const safeName = hasCompanyName ? companyName.trim().replace(/[<>"';&|`$]/g, '').slice(0, 200) : 'new-tenant';
      const safeEmail = hasContactEmail ? contactEmail : `pending-${tenantId.slice(0, 8)}@dealclaw.cn`;
      const safePhone = contactPhone ? contactPhone.replace(/[^0-9+ -]/g, '').slice(0, 30) : null;
      const safeAppId = botAppId && typeof botAppId === 'string' && botAppId.trim() ? botAppId.trim().slice(0, 64) : null;
      const safeAppSecret = botAppSecret && typeof botAppSecret === 'string' && botAppSecret.trim() ? botAppSecret.trim().slice(0, 128) : null;
      // Mio CDP supplier id — optional, unique among live tenants, injected
      // into the tenant agent's environment as MIO_CDP_SUPPLIER_ID.
      const rawSupplierId = typeof mioCdpSupplierId === 'string' ? mioCdpSupplierId.trim() : '';
      if (rawSupplierId && !MIO_SUPPLIER_ID_PATTERN.test(rawSupplierId)) {
        res.status(400).json({ code: 'BAD_SUPPLIER_ID', message: 'Mio CDP 供应商 ID 格式不正确（1–64 位字母、数字、下划线或连字符）' });
        return;
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
          `INSERT INTO tenants (tenant_id, company_name, contact_email, contact_phone, plan_tier, k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly, app_id, app_secret, mio_cdp_supplier_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [tenantId, safeName, safeEmail, safePhone, safePlanTier, k8sNs, creditsAccountId, safeQuotaAgents, safeQuotaCredits, safeAppId, safeAppSecret, safeSupplierId],
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
            res.status(409).json({ code: 'SUPPLIER_ID_TAKEN', message: '该 Mio CDP 供应商 ID 已绑定其他客户' });
          } else {
            res.status(409).json({ code: 'DUPLICATE', message: 'Tenant with this email already exists' });
          }
          return;
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
        contactEmail: hasContactEmail ? contactEmail : undefined,
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
        res.status(500).json({ code: 'PROVISIONING_FAILED', message: 'Tenant created but credits account creation failed' });
        return;
      }

      // Provision K8s resources (after DB commit — if this fails, update status)
      let provisionResult;
      try {
        // Resolve runtime config (global defaults + tenant overrides) from the
        // runtime_configs table. Skipped in dry-run mode so local/test flows
        // don't require RUNTIME_CONFIG_KEY. Resolution failures (missing
        // master key, empty config) mark the tenant provisioning_failed below.
        let runtimeSecretData: Record<string, string> | undefined;
        if (!config.k8sDryRun) {
          runtimeSecretData = await resolveTenantConfig(pool, tenantId);
        }

        provisionResult = await provisionTenant({
          tenantId,
          companyName: safeName,
          contactEmail,
          planTier: safePlanTier,
          quotaAgents: safeQuotaAgents,
          quotaCreditsMonthly: safeQuotaCredits,
          appId: safeAppId || undefined,
          appSecret: safeAppSecret || undefined,
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
        res.status(500).json({ code: 'PROVISIONING_FAILED', message: 'Tenant created but K8s provisioning failed' });
        return;
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

      res.status(201).json({
        ok: true,
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
          secretsCreated: provisionResult.secrets,
          podsScheduled: provisionResult.pods,
        },
        provisioning: provisionResult,
      });
    } catch (err: unknown) {
      const e = err as any;
      if (e?.code === '23505') {
        res.status(409).json({ code: 'DUPLICATE', message: 'Tenant with this email already exists' });
        return;
      }
      console.error('Create tenant failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to create tenant' });
    }
  });

  // GET /v1/tenants/:id — get tenant details
  router.get('/v1/tenants/:id', async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT tenant_id, company_name, contact_email, contact_phone, plan_tier, status,
                k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly,
                mio_cdp_supplier_id, created_at, updated_at
         FROM tenants WHERE tenant_id = $1`,
        [req.params.id],
      );

      if (rows.length === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const t = rows[0];

      // Get status log
      const { rows: logRows } = await pool.query(
        `SELECT from_status, to_status, reason, created_at
         FROM tenant_status_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.id],
      );

      res.json({
        ok: true,
        tenant: {
          tenantId: t.tenant_id,
          companyName: t.company_name,
          contactEmail: t.contact_email,
          contactPhone: t.contact_phone,
          planTier: t.plan_tier,
          status: t.status,
          k8sNamespace: t.k8s_namespace,
          creditsAccountId: t.credits_account_id,
          quotaAgents: t.quota_agents,
          quotaCreditsMonthly: Number(t.quota_credits_monthly),
          mioCdpSupplierId: t.mio_cdp_supplier_id ?? null,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        },
        statusLog: logRows.map((l: any) => ({
          from: l.from_status,
          to: l.to_status,
          reason: l.reason,
          at: l.created_at,
        })),
      });
    } catch (err) {
      console.error('Get tenant failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to get tenant' });
    }
  });

  // GET /v1/tenants/:id/runtime — query tenant Deployment/Pod readiness from K8s
  router.get('/v1/tenants/:id/runtime', async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT tenant_id FROM tenants WHERE tenant_id = $1`,
        [req.params.id],
      );
      if (rows.length === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      if (config.k8sDryRun) {
        res.json({
          ok: true,
          dryRun: true,
          namespace: tenantNamespace(req.params.id),
          tenantId: req.params.id,
          deployments: [],
          pods: [],
        });
        return;
      }

      const runtime = await getTenantRuntimeStatus(tenantNamespace(req.params.id), req.params.id);
      res.json({ ok: true, dryRun: false, ...runtime });
    } catch (err) {
      console.error('Get tenant runtime status failed:', err);
      res.status(500).json({ code: 'RUNTIME_STATUS_FAILED', message: 'Failed to query tenant runtime status' });
    }
  });

  // GET /v1/tenants — list all tenants
  router.get('/v1/tenants', async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT tenant_id, company_name, contact_email, plan_tier, status, quota_agents, quota_credits_monthly,
                k8s_namespace, mio_cdp_supplier_id, app_id, agent_endpoint, created_at, updated_at
         FROM tenants ORDER BY created_at DESC LIMIT 100`,
      );

      res.json({
        ok: true,
        tenants: rows.map((t: any) => ({
          tenantId: t.tenant_id,
          companyName: t.company_name,
          contactEmail: t.contact_email,
          planTier: t.plan_tier,
          status: t.status,
          quotaAgents: t.quota_agents,
          quotaCreditsMonthly: Number(t.quota_credits_monthly),
          k8sNamespace: t.k8s_namespace ?? null,
          mioCdpSupplierId: t.mio_cdp_supplier_id ?? null,
          feishuAppId: t.app_id ?? null,
          externalAgent: Boolean(t.agent_endpoint),
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        })),
        total: rows.length,
      });
    } catch (err) {
      console.error('List tenants failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to list tenants' });
    }
  });

  // DELETE /v1/tenants/:id — destroy tenant
  router.delete('/v1/tenants/:id', async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT status FROM tenants WHERE tenant_id = $1`,
        [req.params.id],
      );

      if (rows.length === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const { status } = rows[0];

      if (status === 'destroyed') {
        res.status(400).json({ code: 'ALREADY_DESTROYED', message: 'Tenant already destroyed' });
        return;
      }

      // Deprovision K8s resources
      const result = await deprovisionTenant(req.params.id, {
        dryRun: config.k8sDryRun,
      });

      if (!result.deleted) {
        res.status(500).json({
          code: 'DEPROVISION_FAILED',
          message: 'Tenant resources could not be removed',
          warnings: result.warnings,
        });
        return;
      }

      // Soft-delete only after K8s resources were removed successfully.
      await pool.query(
        `UPDATE tenants SET status = 'destroyed', updated_at = NOW() WHERE tenant_id = $1`,
        [req.params.id],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, $2, 'destroyed', 'Manually destroyed')`,
        [req.params.id, status],
      );

      res.json({ ok: true, deleted: result.deleted, warnings: result.warnings });
    } catch (err) {
      console.error('Delete tenant failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to delete tenant' });
    }
  });

  // PUT /v1/tenants/:id/credentials — persist Feishu app credentials
  router.put("/v1/tenants/:id/credentials", async (req, res) => {
    try {
      const { appId, appSecret } = req.body;
      await pool.query("UPDATE tenants SET app_id=$1, app_secret=$2, updated_at=NOW() WHERE tenant_id=$3", [appId, appSecret, req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ code: "INTERNAL" }); }
  });

  // GET /v1/tenants/:id/credentials — read Feishu app credentials + notification contact
  router.get("/v1/tenants/:id/credentials", async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT app_id, app_secret, platform, im_open_id FROM tenants WHERE tenant_id=$1", [req.params.id]);
      if (!rows.length) { res.status(404).json({ code: "NOT_FOUND" }); return; }
      res.json({
        appId: rows[0].app_id,
        appSecret: rows[0].app_secret,
        platform: rows[0].platform ?? 'feishu',
        imOpenId: rows[0].im_open_id ?? null,
      });
    } catch (err) { res.status(500).json({ code: "INTERNAL" }); }
  });

  // PATCH /v1/tenants/:id/contact — write back IM contact captured by nexus-gateway
  // (sender open_id of the first bot message). Used by the notify relay to
  // deliver lifecycle notifications. Does NOT bump updated_at — ops-agent
  // derives daysInCurrentStatus from it.
  router.patch("/v1/tenants/:id/contact", async (req, res) => {
    try {
      const { platform, imOpenId } = req.body ?? {};
      if (!imOpenId || typeof imOpenId !== 'string' || !imOpenId.trim()) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'imOpenId is required' });
        return;
      }
      const safePlatform = ['feishu', 'dingtalk', 'wecom'].includes(platform) ? platform : 'feishu';
      const result = await pool.query(
        "UPDATE tenants SET platform=$1, im_open_id=$2 WHERE tenant_id=$3",
        [safePlatform, imOpenId.trim().slice(0, 128), req.params.id],
      );
      if (result.rowCount === 0) { res.status(404).json({ code: "NOT_FOUND" }); return; }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ code: "INTERNAL" }); }
  });

  // PUT /v1/tenants/:id/message-plane — P2: switch the Feishu message plane
  // between the nexus-gateway WS bridge ('gateway') and the in-agent
  // @openclaw/feishu plugin ('openclaw'). Ordered rollout guarantees a single
  // WS client at any time (Feishu load-balances events across connections).
  router.put('/v1/tenants/:id/message-plane', async (req: Request, res: Response) => {
    try {
      const { plane } = req.body ?? {};
      if (plane !== 'gateway' && plane !== 'openclaw') {
        res.status(400).json({ code: 'BAD_REQUEST', message: "plane must be 'gateway' or 'openclaw'" });
        return;
      }
      const tenantId = req.params.id;

      // openclaw plane requires real bot credentials (placeholder creds from
      // web-platform tenants would produce a dead WS client inside the agent).
      const { rows } = await pool.query(
        `SELECT app_id, app_secret, platform, status FROM tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      if (rows.length === 0) { res.status(404).json({ code: 'NOT_FOUND' }); return; }
      const tenant = rows[0];
      if (plane === 'openclaw') {
        if (tenant.platform !== 'feishu') {
          res.status(409).json({ code: 'UNSUPPORTED_PLATFORM', message: `platform ${tenant.platform} has no feishu message plane` });
          return;
        }
        if (!tenant.app_id || !tenant.app_secret || String(tenant.app_id).startsWith('placeholder-')) {
          res.status(409).json({ code: 'NO_BOT_CREDENTIALS', message: 'Bind a Feishu app (appId/appSecret) before switching to the openclaw plane' });
          return;
        }
      }

      const result = await switchTenantMessagePlane(tenantId, plane);
      if (!result.ok) {
        res.status(500).json({ code: 'SWITCH_FAILED', steps: result.steps, warnings: result.warnings });
        return;
      }
      // Persist the desired plane AFTER the rollout patches succeeded, so a
      // failed switch never records a state the workloads don't reflect.
      await pool.query(
        `UPDATE tenants SET message_plane = $1, updated_at = NOW() WHERE tenant_id = $2`,
        [plane, tenantId],
      );
      res.json({ ok: true, plane, steps: result.steps, warnings: result.warnings });
    } catch (err: unknown) {
      const e = err as any;
      console.error('message-plane switch failed:', e?.message ?? e);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PATCH /v1/tenants/:id/profile — update company name / contact info（对话回写）
  router.patch('/v1/tenants/:id/profile', async (req: Request, res: Response) => {
    try {
      const { companyName, contactEmail } = req.body ?? {};
      const updates: string[] = [];
      const params: any[] = [];

      if (companyName && typeof companyName === 'string' && companyName.trim()) {
        updates.push(`company_name = $${params.length + 1}`);
        params.push(companyName.trim().slice(0, 200));
      }
      if (contactEmail && typeof contactEmail === 'string' && contactEmail.trim()) {
        updates.push(`contact_email = $${params.length + 1}`);
        params.push(contactEmail.trim().slice(0, 200));
      }
      if (!updates.length) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'companyName or contactEmail is required' });
        return;
      }

      params.push(req.params.id);
      const result = await pool.query(
        `UPDATE tenants SET ${updates.join(', ')}, updated_at = NOW() WHERE tenant_id = $${params.length}`,
        params,
      );
      if (result.rowCount === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      res.json({ ok: true, tenantId: req.params.id });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Update tenant profile failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Update failed' });
    }
  });

  // PATCH /v1/tenants/:id/deployment — rolling update deployment image
  router.patch('/v1/tenants/:id/deployment', async (req: Request, res: Response) => {
    try {
      const { service, image } = req.body;

      if (!service || !['dealclaw-agent', 'nexus-gateway'].includes(service)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'service must be dealclaw-agent or nexus-gateway' });
        return;
      }
      if (!image || typeof image !== 'string') {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'image must be a non-empty string' });
        return;
      }

      const tenantId = req.params.id;
      const { rows } = await pool.query('SELECT k8s_namespace, status, agent_endpoint FROM tenants WHERE tenant_id = $1', [tenantId]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (rows[0].status === 'destroyed') {
        res.status(400).json({ code: 'TENANT_DESTROYED', message: 'Tenant has been destroyed' });
        return;
      }
      if (rows[0].agent_endpoint) {
        res.status(400).json({
          code: 'EXTERNAL_AGENT',
          message: '该租户使用外部（中央）Agent，镜像由 ArgoCD/GitOps 管理，不能在此更新',
        });
        return;
      }

      const { k8s_namespace: namespace } = rows[0];
      const deploymentName = `${service}-${tenantId}`;
      const fullImage = normalizeImage(service, image);

      const { patchDeploymentImage } = await import('../services/k8s-client.js');
      await patchDeploymentImage({ namespace, name: deploymentName, image: fullImage });

      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, $2, $2, $3)`,
        [tenantId, rows[0].status, `Deployment ${service} updated to ${image}`],
      );

      res.json({
        ok: true,
        tenantId,
        service,
        deployment: deploymentName,
        image: fullImage,
        action: 'rolling_update',
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Patch deployment failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Deployment update failed' });
    }
  });

  // PATCH /v1/tenants/:id/deployment/scale — scale deployment replicas (suspend/resume)
  router.patch('/v1/tenants/:id/deployment/scale', async (req: Request, res: Response) => {
    try {
      const { service, replicas } = req.body;

      if (!service || !['dealclaw-agent', 'nexus-gateway'].includes(service)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'service must be dealclaw-agent or nexus-gateway' });
        return;
      }
      if (typeof replicas !== 'number' || replicas < 0) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'replicas must be a non-negative integer' });
        return;
      }

      const tenantId = req.params.id;
      const { rows } = await pool.query('SELECT k8s_namespace, status, agent_endpoint FROM tenants WHERE tenant_id = $1', [tenantId]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (rows[0].agent_endpoint) {
        res.status(400).json({
          code: 'EXTERNAL_AGENT',
          message: '该租户使用外部（中央）Agent，扩缩容由 ArgoCD/GitOps 管理，不能在此操作',
        });
        return;
      }

      const { k8s_namespace: namespace } = rows[0];
      const deploymentName = `${service}-${tenantId}`;

      const { scaleDeployment } = await import('../services/k8s-client.js');
      await scaleDeployment({ namespace, name: deploymentName, replicas });

      res.json({
        ok: true,
        tenantId,
        service,
        deployment: deploymentName,
        replicas,
        action: replicas === 0 ? 'suspend' : 'resume',
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Scale deployment failed:', e);
      if (/404|not found/i.test(e.message || '')) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Deployment not found' });
        return;
      }
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Scale failed' });
    }
  });

  // POST /v1/tenants/:id/backup — create a backup/archive Job for tenant data
  router.post('/v1/tenants/:id/backup', async (req: Request, res: Response) => {
    try {
      const { mode } = req.body ?? {};
      const backupMode = mode === 'archive' ? 'archive' : 'backup';

      const { rows } = await pool.query('SELECT tenant_id, status FROM tenants WHERE tenant_id = $1', [req.params.id]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const result = await backupTenantData(req.params.id, config, { mode: backupMode });

      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, $2, $2, $3)`,
        [req.params.id, rows[0].status, `${backupMode} Job ${result.jobName} — ${result.ok ? 'created' : 'failed'}`],
      );

      res.status(result.ok ? 200 : 500).json({
        ok: result.ok,
        tenantId: req.params.id,
        mode: backupMode,
        jobName: result.jobName,
        warnings: result.warnings,
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Backup tenant data failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Backup failed' });
    }
  });

  // POST /v1/tenants/:id/restore — restore tenant data from OSS
  router.post('/v1/tenants/:id/restore', async (req: Request, res: Response) => {
    try {
      const { source } = req.body ?? {};
      const restoreSource = source === 'backup' ? 'backup' : 'archive';

      const { rows } = await pool.query('SELECT tenant_id, status FROM tenants WHERE tenant_id = $1', [req.params.id]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const result = await restoreTenantData(req.params.id, config, { source: restoreSource });

      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, $2, $2, $3)`,
        [req.params.id, rows[0].status, `restore Job ${result.jobName} (source=${restoreSource}) — ${result.ok ? 'created' : 'failed'}`],
      );

      res.status(result.ok ? 200 : 500).json({
        ok: result.ok,
        tenantId: req.params.id,
        source: restoreSource,
        jobName: result.jobName,
        warnings: result.warnings,
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Restore tenant data failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Restore failed' });
    }
  });

  // POST /v1/tenants/batch/deployment — rolling update all active tenants
  router.post('/v1/tenants/batch/deployment', async (req: Request, res: Response) => {
    try {
      const { service, image } = req.body;

      if (!service || !['dealclaw-agent', 'nexus-gateway'].includes(service)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'service must be dealclaw-agent or nexus-gateway' });
        return;
      }
      if (!image || typeof image !== 'string') {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'image must be a non-empty string' });
        return;
      }

      const fullImage = normalizeImage(service, image);

      const { rows } = await pool.query(
        `SELECT tenant_id, k8s_namespace FROM tenants WHERE status NOT IN ('destroyed') AND k8s_namespace IS NOT NULL`,
      );

      if (!rows.length) {
        res.json({ ok: true, updated: 0, results: [] });
        return;
      }

      const { patchDeploymentImage } = await import('../services/k8s-client.js');
      const results: Array<{ tenantId: string; deployment: string; ok: boolean; skipped?: boolean; error?: string }> = [];

      for (const row of rows) {
        const deploymentName = `${service}-${row.tenant_id}`;
        try {
          await patchDeploymentImage({ namespace: row.k8s_namespace, name: deploymentName, image: fullImage });
          results.push({ tenantId: row.tenant_id, deployment: deploymentName, ok: true });
        } catch (err: unknown) {
          const e = err as any;
          const msg = e.message || String(e);
          // 404 = deployment doesn't exist for this tenant (e.g. older tenants without nexus-gateway)
          const skipped = /404|not found/i.test(msg);
          results.push({ tenantId: row.tenant_id, deployment: deploymentName, ok: false, skipped, error: msg });
          if (!skipped) {
            console.error(`[batch-rollout] ${deploymentName}: ${msg}`);
          }
        }
      }

      const successCount = results.filter(r => r.ok).length;
      const skippedCount = results.filter(r => r.skipped).length;
      res.json({
        ok: true,
        updated: successCount,
        total: rows.length,
        failed: rows.length - successCount - skippedCount,
        skipped: skippedCount,
        service,
        image: fullImage,
        results,
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Batch deployment update failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Batch update failed' });
    }
  });

  // ── Feishu app binding ──
  // GET /v1/tenants/:id/feishu-binding — current binding state
  router.get('/v1/tenants/:id/feishu-binding', async (req: Request, res: Response) => {
    try {
      const binding = await getTenantFeishuBinding(pool, req.params.id);
      if (!binding) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      res.json({ ok: true, binding });
    } catch (err: unknown) {
      console.error('Get feishu binding failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to get binding' });
    }
  });

  // PUT /v1/tenants/:id/feishu-binding — bind / rotate the Feishu app for
  // this tenant's agent. Verifies the credentials against the Feishu open
  // API first, then updates DB + K8s secret and (re)deploys nexus-gateway.
  router.put('/v1/tenants/:id/feishu-binding', async (req: Request, res: Response) => {
    try {
      const { appId, appSecret } = req.body ?? {};
      if (!appId || typeof appId !== 'string' || !appSecret || typeof appSecret !== 'string') {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'appId and appSecret are required' });
        return;
      }
      const result = await bindTenantFeishuApp(pool, config, req.params.id, { appId, appSecret });
      res.json({
        ...result,
        message: result.restarted
          ? `已绑定 ${result.appId}，网关 ${result.gatewayDeployment} 已滚动重启（约 10–30 秒生效）`
          : `已绑定 ${result.appId}，网关 ${result.gatewayDeployment} 部署于 ${result.gatewayNamespace}（约 10–30 秒生效）`,
      });
    } catch (err: unknown) {
      const e = err as any;
      if (e instanceof FeishuBindingError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      console.error('Bind feishu app failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || '绑定失败' });
    }
  });

  // DELETE /v1/tenants/:id/feishu-binding — unbind: the Feishu connection is
  // disabled (bot Secret rotated to placeholders + gateway rolled), but the
  // gateway itself is KEPT — it doubles as the tenant's LLM egress proxy.
  router.delete('/v1/tenants/:id/feishu-binding', async (req: Request, res: Response) => {
    try {
      const result = await unbindTenantFeishuApp(pool, config, req.params.id);
      res.json({
        ...result,
        message: `已解绑飞书应用；网关 ${result.gatewayKept} 保留（LLM 出口代理）${
          result.restarted ? '，已滚动重启以断开飞书连接' : ''
        }`,
      });
    } catch (err: unknown) {
      const e = err as any;
      if (e instanceof FeishuBindingError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      console.error('Unbind feishu app failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || '解绑失败' });
    }
  });

  // GET /v1/tenants/:id/skill-env — effective skill-env view for the detail
  // card (merged global defaults + tenant overrides + supplier id).
  router.get('/v1/tenants/:id/skill-env', async (req: Request, res: Response) => {
    try {
      let canDecrypt = false;
      try {
        canDecrypt = getMasterKey() !== null;
      } catch {
        canDecrypt = false;
      }
      const view = await getTenantSkillEnvView(pool, req.params.id, canDecrypt);
      res.json(view);
    } catch (err: unknown) {
      const e = err as any;
      if (e instanceof SkillEnvError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      console.error('Get skill-env view failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to load skill-env' });
    }
  });

  // POST /v1/tenants/:id/skill-env/sync — manually (re)push the skill-env
  // Secret to this tenant's agent and ensure the volume mount exists.
  router.post('/v1/tenants/:id/skill-env/sync', async (req: Request, res: Response) => {
    try {
      const result = await pushTenantSkillEnv(pool, config, req.params.id);
      res.json({
        ...result,
        message: result.rollout === 'restarted'
          ? '已推送并挂载：agent 滚动重启一次后生效（首次挂载），此后改 Key 免重启'
          : result.rollout === 'skipped'
            ? '该租户无独立 agent（或 dry-run），未推送'
            : '已推送：约 1 分钟内自动生效（skill 下次调用即用新值）',
      });
    } catch (err: unknown) {
      const e = err as any;
      if (e instanceof SkillEnvError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      console.error('Push skill-env failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || '推送失败' });
    }
  });

  // PATCH /v1/tenants/:id/mio-supplier-id — set or clear the tenant's Mio CDP
  // supplier id (optional, unique per live tenant). Persists on the tenants
  // row, injects MIO_CDP_SUPPLIER_ID into the agent-config Secret and rolls
  // the agent Pod so skills pick it up from the environment. Empty string or
  // null clears it.
  router.patch('/v1/tenants/:id/mio-supplier-id', async (req: Request, res: Response) => {
    try {
      const { supplierId } = req.body ?? {};
      if (supplierId !== undefined && supplierId !== null && typeof supplierId !== 'string') {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'supplierId must be a string or null' });
        return;
      }
      const result = await updateTenantMioSupplier(pool, config, req.params.id, supplierId ?? null);
      res.json({
        ...result,
        message: result.restarted
          ? `供应商 ID 已${result.supplierId ? `设为 ${result.supplierId}` : '清除'}，agent 已滚动重启（约 10–30 秒生效）`
          : `供应商 ID 已${result.supplierId ? `设为 ${result.supplierId}` : '清除'}`,
      });
    } catch (err: unknown) {
      const e = err as any;
      if (e instanceof MioSupplierError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      console.error('Update mio supplier id failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || '更新失败' });
    }
  });

  // PATCH /v1/tenants/:id/status — update tenant status
  router.patch('/v1/tenants/:id/status', async (req: Request, res: Response) => {
    try {
      const { status: newStatus, reason } = req.body;
      const validStatuses = [
        'pending', 'provisioning', 'provisioning_failed',
        'active', 'low_credits', 'suspended', 'grace', 'destroyed',
      ] as const;

      if (!validStatuses.includes(newStatus)) {
        res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        });
        return;
      }

      const { rows } = await pool.query(`SELECT status FROM tenants WHERE tenant_id = $1`, [req.params.id]);

      if (rows.length === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const oldStatus = rows[0].status;

      await pool.query(
        `UPDATE tenants SET status = $1, updated_at = NOW() WHERE tenant_id = $2`,
        [newStatus, req.params.id],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)`,
        [req.params.id, oldStatus, newStatus, reason ?? 'Status updated via API'],
      );

      res.json({ ok: true, fromStatus: oldStatus, toStatus: newStatus });
    } catch (err) {
      console.error('Update tenant status failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Failed to update status' });
    }
  });

  return router;
}
