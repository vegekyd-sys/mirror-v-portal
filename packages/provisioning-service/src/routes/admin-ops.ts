/**
 * Admin/ops routes: image release registry, rollout promotion, tenant chat
 * proxy, and default-tenant bootstrap trigger.
 *
 * Image release flow (registry sync replaces the old Jenkins post-build
 * hook, which was removed):
 *   provisioning-service pulls tags from the container registry
 *   (Docker v2 API — see services/registry-sync.ts) into image_releases,
 *   on boot + every 30 min and on demand via POST /v1/admin/image-releases/sync
 *   → admin console lists releases → operator promotes a tag
 *   (POST /v1/admin/image-releases/promote) → rollout_targets is updated →
 *   ops-agent's rollout cron reads GET /v1/admin/rollout-targets and rolls
 *   all tenants to the promoted tag (env ROLLOUT_*_TAG remains the fallback).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { ensureDefaultTenant } from '../services/default-tenant.js';
import { syncImageReleases } from '../services/registry-sync.js';

const RELEASE_SERVICES = ['dealclaw-agent', 'nexus-gateway'] as const;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createAdminOpsRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) {
    router.use(authMiddleware);
  }

  const adminIdentity = (req: Request): string => {
    const u = (req as any).adminUser;
    if (u && (u.username || u.sub)) return String(u.username || u.sub);
    return 'service-token';
  };

  // POST /v1/admin/image-releases/sync — pull the current tag list from the
  // container registry into image_releases (manual refresh; also runs on
  // boot + every 30 min, see index.ts). Idempotent.
  router.post('/v1/admin/image-releases/sync', async (_req: Request, res: Response) => {
    try {
      const result = await syncImageReleases(pool, config);
      res.json({ ...result, ok: result.ok });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Registry sync failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Sync failed' });
    }
  });

  // GET /v1/admin/image-releases — list releases (newest first).
  // Marks which release (if any) is the current rollout target per service.
  router.get('/v1/admin/image-releases', async (req: Request, res: Response) => {
    try {
      const service = typeof req.query.service === 'string' ? req.query.service : null;
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);

      const { rows: targets } = await pool.query('SELECT service, tag FROM rollout_targets');
      const promoted = new Map(targets.map((t: any) => [t.service, t.tag]));

      // Sort by CI build number when the tag carries one (registry-synced
      // rows share the same created_at, so build number is the real order).
      const { rows } = service && RELEASE_SERVICES.includes(service as any)
        ? await pool.query(
            `SELECT id, service, tag, image, git_commit, build_number, build_env, created_by, notes, created_at
             FROM image_releases WHERE service = $1
             ORDER BY (CASE WHEN build_number ~ '^[0-9]+$' THEN build_number::bigint END) DESC NULLS LAST,
                      created_at DESC, id DESC
             LIMIT $2`,
            [service, limit],
          )
        : await pool.query(
            `SELECT id, service, tag, image, git_commit, build_number, build_env, created_by, notes, created_at
             FROM image_releases
             ORDER BY (CASE WHEN build_number ~ '^[0-9]+$' THEN build_number::bigint END) DESC NULLS LAST,
                      created_at DESC, id DESC
             LIMIT $1`,
            [limit],
          );

      res.json({
        ok: true,
        releases: rows.map((r: any) => ({ ...r, promoted: promoted.get(r.service) === r.tag })),
        rolloutTargets: targets,
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('List image releases failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'List failed' });
    }
  });

  // POST /v1/admin/image-releases/promote — set the rollout target tag for a
  // service. ops-agent's rollout cron will roll all tenants to this tag.
  router.post('/v1/admin/image-releases/promote', async (req: Request, res: Response) => {
    try {
      const { service, tag } = req.body ?? {};

      if (!service || !RELEASE_SERVICES.includes(service)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: `service must be one of: ${RELEASE_SERVICES.join(', ')}` });
        return;
      }
      if (!tag || typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'tag must match ' + TAG_PATTERN });
        return;
      }

      // Only promote tags that were actually recorded (prevents typos from
      // rolling all tenants to a nonexistent image).
      const { rows } = await pool.query(
        'SELECT image FROM image_releases WHERE service = $1 AND tag = $2',
        [service, tag],
      );
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: `Image release ${service}:${tag} not found — run a registry sync first` });
        return;
      }

      await pool.query(
        `INSERT INTO rollout_targets (service, tag, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (service) DO UPDATE SET tag = EXCLUDED.tag, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [service, tag, adminIdentity(req)],
      );

      res.json({ ok: true, service, tag, image: rows[0].image, action: 'promoted' });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Promote image release failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Promote failed' });
    }
  });

  // GET /v1/admin/rollout-targets — consumed by ops-agent rollout cron
  // (service token auth). Empty list means "no promoted target yet" — the
  // caller falls back to its ROLLOUT_*_TAG env vars.
  router.get('/v1/admin/rollout-targets', async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        'SELECT service, tag, updated_by, updated_at FROM rollout_targets ORDER BY service',
      );
      res.json({ ok: true, targets: rows });
    } catch (err: unknown) {
      const e = err as any;
      console.error('List rollout targets failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'List failed' });
    }
  });

  // POST /v1/admin/tenants/:id/chat — proxy a web-chat message to the
  // tenant's dealclaw-agent bridge (POST /execute, synchronous, no auth on
  // the bridge itself — it lives inside the cluster network only).
  router.post('/v1/admin/tenants/:id/chat', async (req: Request, res: Response) => {
    try {
      const message = req.body?.message;
      if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'message must be a non-empty string' });
        return;
      }

      const tenantId = req.params.id;
      const { rows } = await pool.query(
        'SELECT tenant_id, status, k8s_namespace, agent_endpoint FROM tenants WHERE tenant_id = $1',
        [tenantId],
      );
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (rows[0].status !== 'active') {
        res.status(400).json({
          code: 'TENANT_NOT_ACTIVE',
          message: `租户当前状态为 ${rows[0].status}，无法对话（需 active）`,
        });
        return;
      }

      // Explicit agent_endpoint wins (e.g. legacy external-agent rows);
      // otherwise fall back to the per-tenant agent in its namespace.
      const agentUrl = rows[0].agent_endpoint
        ? `${String(rows[0].agent_endpoint).replace(/\/$/, '')}/execute`
        : `http://dealclaw-agent-${tenantId}.${rows[0].k8s_namespace || `dealclaw-${tenantId}`}:18789/execute`;

      // Chat user identity: the logged-in admin (or console when called
      // with the service token). Session continuity on the agent side is
      // derived from sha256(tenant\0channel\0userId).
      const adminUser = (req as any).adminUser;
      const userId = adminUser?.sub ? `admin-${String(adminUser.sub)}` : 'admin-console';

      let data: any = {};
      try {
        const agentRes = await fetch(agentUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DealClaw-Tenant-ID': tenantId,
            'X-DealClaw-User-ID': userId,
            'X-DealClaw-Channel': 'web',
          },
          body: JSON.stringify({ intent: { text: message.trim() } }),
          // Agent executes synchronously, up to ~120s; give it a bit of slack.
          signal: AbortSignal.timeout(125_000),
        });
        data = await agentRes.json().catch(() => ({}));
        if (!agentRes.ok) {
          res.status(502).json({
            code: 'AGENT_ERROR',
            message: data?.error || data?.message || `Agent returned HTTP ${agentRes.status}`,
          });
          return;
        }
      } catch (fetchErr: unknown) {
        const fe = fetchErr as any;
        const timedOut = fe?.name === 'TimeoutError' || fe?.name === 'AbortError';
        res.status(504).json({
          code: timedOut ? 'AGENT_TIMEOUT' : 'AGENT_UNREACHABLE',
          message: timedOut
            ? 'Agent 响应超时（125s），请稍后重试'
            : `无法连接租户 Agent：${fe?.message || fe}（请确认 dealclaw-agent Pod 正在运行）`,
        });
        return;
      }

      const result = data?.result ?? data ?? {};
      const reply = result.summary || result.text || result.message || '';
      res.json({
        ok: true,
        tenantId,
        reply,
        meta: {
          channel: 'web',
          userId,
          rawStatus: result.status ?? null,
        },
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Chat proxy failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Chat failed' });
    }
  });

  // POST /v1/admin/default-tenant/ensure — (re)run default-tenant bootstrap.
  // Called automatically at boot; exposed here for manual retry after the
  // admin configures the model key in 运行时配置.
  router.post('/v1/admin/default-tenant/ensure', async (_req: Request, res: Response) => {
    try {
      const result = await ensureDefaultTenant(pool, config);
      res.json({ ok: result.action !== 'failed', ...result });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Ensure default tenant failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Ensure failed' });
    }
  });

  return router;
}
