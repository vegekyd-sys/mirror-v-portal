import { Router, type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { provisionTenant, deprovisionTenant, backupTenantData, restoreTenantData } from '../services/provisioning.js';
import { getTenantRuntimeStatus } from '../services/k8s-client.js';
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
      const { companyName, contactEmail, contactPhone, planTier, quotaAgents, quotaCreditsMonthly, botAppId, botAppSecret } = req.body;

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
      // Tenant workloads are isolated by names/labels inside one runtime namespace.
      const k8sNs = config.runtimeNamespace;
      const creditsAccountId = `credits-${tenantId.slice(0, 16)}`;

      // NS3 FIX: Wrap DB operations in transaction to prevent partial writes.
      // K8s provisioning happens after commit; if it fails, tenant status gets updated.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO tenants (tenant_id, company_name, contact_email, contact_phone, plan_tier, k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly, app_id, app_secret)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tenantId, safeName, safeEmail, safePhone, safePlanTier, k8sNs, creditsAccountId, safeQuotaAgents, safeQuotaCredits, safeAppId, safeAppSecret],
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
          res.status(409).json({ code: 'DUPLICATE', message: 'Tenant with this email already exists' });
          return;
        }
        throw dbErr;
      } finally {
        client.release();
      }

      // Provision K8s resources (after DB commit — if this fails, update status)
      let provisionResult;
      try {
        provisionResult = await provisionTenant({
          tenantId,
          companyName: safeName,
          contactEmail,
          planTier: safePlanTier,
          quotaAgents: safeQuotaAgents,
          quotaCreditsMonthly: safeQuotaCredits,
          appId: safeAppId || undefined,
          appSecret: safeAppSecret || undefined,
        }, {
          dryRun: config.k8sDryRun,
          runtimeNamespace: config.runtimeNamespace,
          imageRegistry: config.imageRegistry,
          nexusGatewayImageTag: config.nexusGatewayImageTag,
          dealclawAgentImageTag: config.dealclawAgentImageTag,
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

      res.status(201).json({
        ok: true,
        tenant: {
          tenantId,
          companyName: safeName,
          contactEmail: safeEmail,
          planTier: safePlanTier,
          status: 'pending',
          quotaAgents: safeQuotaAgents,
          quotaCreditsMonthly: safeQuotaCredits,
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
                created_at, updated_at
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
          namespace: config.runtimeNamespace,
          tenantId: req.params.id,
          deployments: [],
          pods: [],
        });
        return;
      }

      const runtime = await getTenantRuntimeStatus(config.runtimeNamespace, req.params.id);
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
        `SELECT tenant_id, company_name, contact_email, plan_tier, status, quota_credits_monthly, created_at
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
          quotaCreditsMonthly: Number(t.quota_credits_monthly),
          createdAt: t.created_at,
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
        runtimeNamespace: config.runtimeNamespace,
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
      const { rows } = await pool.query('SELECT k8s_namespace, status FROM tenants WHERE tenant_id = $1', [tenantId]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (rows[0].status === 'destroyed') {
        res.status(400).json({ code: 'TENANT_DESTROYED', message: 'Tenant has been destroyed' });
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
      const { rows } = await pool.query('SELECT k8s_namespace, status FROM tenants WHERE tenant_id = $1', [tenantId]);
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
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
