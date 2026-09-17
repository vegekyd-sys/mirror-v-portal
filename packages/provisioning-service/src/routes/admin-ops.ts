/**
 * Admin/ops routes: image release registry, rollout promotion, tenant chat
 * proxy.
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
import { syncImageReleases } from '../services/registry-sync.js';
import { actorFromRequest, writeAuditLog } from '../services/audit.js';
import { createExternalApiKey, listExternalApiKeys, revokeExternalApiKey } from '../services/external-api-keys.js';
import { createChatApiKey, listChatApiKeys, revokeChatApiKey } from '../services/chat-api-keys.js';
import { backfillChatlogEnv } from '../services/chatlog-backfill.js';
import { backfillSenderNames } from '../services/sender-name-backfill.js';
import { patchDeploymentEnvVar, restartDeployment } from '../services/k8s-client.js';
import {
  MioApiError,
  quickRegisterMioSupplier,
  searchMioSuppliers,
} from '../services/mio-supplier-client.js';
import {
  MioSupplierError,
  backfillTenantMioSuppliers,
  updateTenantMioSupplier,
} from '../services/mio-supplier.js';

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

  /**
   * 米奥接口错误 → HTTP 响应的统一映射。
   *
   * 关键点：**业务错误（kind='business'）把米奥原始 msg 原样透出**，不重写
   * 文案、不重试、不去重；调用方（admin SPA）直接展示给操作者。
   * status 由路由决定：写类接口（新建供应商）用 409，读类接口（搜索）用 502，
   * 因为读接口的业务失败本质是上游网关/凭据问题，不是「冲突」。
   * 任何情况下都不回显凭据（token 只存在于 env 与请求头）。
   */
  const sendMioError = (
    res: Response,
    err: unknown,
    opts: { businessStatus: number; fallback: string },
  ): void => {
    if (err instanceof MioApiError) {
      const status =
        err.kind === 'business'
          ? opts.businessStatus
          : err.kind === 'input'
            ? 400
            : err.kind === 'config'
              ? 503
              : err.status;
      res.status(status).json({
        ok: false,
        code: err.code,
        message: err.message,
        ...(err.kind === 'business' ? { upstreamCode: err.upstream?.code ?? null } : {}),
      });
      return;
    }
    if (err instanceof MioSupplierError) {
      res.status(err.status).json({ ok: false, code: err.code, message: err.message });
      return;
    }
    console.error('Mio operation failed:', err);
    const e = err as any;
    res.status(500).json({ ok: false, code: 'INTERNAL', message: e?.message || opts.fallback });
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

      // Audit snapshot BEFORE the update (old→new), so fleet regressions can
      // be traced even after rollout_targets is overwritten (see the
      // 2026-08-31 e3d43339.7 incident).
      const { rows: prevRows } = await pool.query(
        'SELECT tag, updated_by, updated_at FROM rollout_targets WHERE service = $1',
        [service],
      );
      const { actor, actorType } = actorFromRequest(req);

      await pool.query(
        `INSERT INTO rollout_targets (service, tag, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (service) DO UPDATE SET tag = EXCLUDED.tag, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [service, tag, actor],
      );

      await writeAuditLog(pool, {
        actor,
        actorType,
        action: 'image-release.promote',
        method: 'POST',
        path: '/v1/admin/image-releases/promote',
        resourceType: 'rollout_target',
        resourceId: service,
        oldValue: prevRows.length
          ? { tag: prevRows[0].tag, updatedBy: prevRows[0].updated_by, updatedAt: prevRows[0].updated_at }
          : null,
        newValue: { tag, image: rows[0].image },
        statusCode: 200,
      });

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

  // GET /v1/admin/audit-logs — paginated audit trail with filters.
  // Powers the admin console's 审计日志 page. Supported filters:
  //   actor, action (exact), tenantId, from/to (ISO datetime), limit/offset.
  router.get('/v1/admin/audit-logs', async (req: Request, res: Response) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        conditions.push(clause.replace('$?', `$${params.length}`));
      };

      const { actor, action, tenantId, from, to } = req.query as Record<string, string | undefined>;
      if (actor && actor.trim()) add('actor = $?', actor.trim());
      if (action && action.trim()) add('action = $?', action.trim());
      if (tenantId && tenantId.trim()) add('tenant_id = $?', tenantId.trim());
      if (from && /^\d{4}-\d{2}-\d{2}/.test(from)) add('created_at >= $?', from);
      if (to && /^\d{4}-\d{2}-\d{2}/.test(to)) {
        // Date-only "to" is inclusive: append one day so the last day shows.
        const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(to);
        add('created_at < $?', dayOnly ? `${to}T23:59:59.999Z` : to);
      }

      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT id, created_at, actor, actor_type, action, method, path,
                resource_type, resource_id, tenant_id,
                old_value, new_value, status_code, duration_ms, ip, request_id
         FROM audit_logs ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM audit_logs ${where}`,
        params,
      );

      res.json({
        ok: true,
        logs: rows.map((r: any) => ({
          ...r,
          old_value: typeof r.old_value === 'string' ? JSON.parse(r.old_value) : r.old_value,
          new_value: typeof r.new_value === 'string' ? JSON.parse(r.new_value) : r.new_value,
        })),
        total: totalRows[0]?.total ?? 0,
        limit,
        offset,
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('List audit logs failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'List failed' });
    }
  });

  // GET /v1/admin/llm-usage — LLM token usage across all tenants (proxy to
  // credits-ledger). Powers the admin console's usage summary card.
  // GET /v1/admin/llm-usage/summary?tenantId= — per-tenant aggregate.
  const proxyLlmUsage = async (
    ledgerPath: string,
    query: URLSearchParams,
    res: Response,
  ) => {
    try {
      const url = `${config.creditsLedgerUrl.replace(/\/$/, '')}${ledgerPath}?${query.toString()}`;
      const ledgerRes = await fetch(url, {
        headers: { Authorization: `Bearer ${config.creditsLedgerToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await ledgerRes.json().catch(() => ({}));
      if (!ledgerRes.ok) {
        res.status(502).json({
          code: 'LEDGER_ERROR',
          message: (data as any)?.message || `credits-ledger returned HTTP ${ledgerRes.status}`,
        });
        return;
      }
      res.json(data);
    } catch (err: unknown) {
      const e = err as any;
      res.status(502).json({ code: 'LEDGER_UNREACHABLE', message: `无法访问 credits-ledger：${e?.message || e}` });
    }
  };

  const parseDays = (raw: unknown): number =>
    Math.min(Math.max(Number(raw ?? 7) || 7, 1), 90);

  router.get('/v1/admin/llm-usage', async (req: Request, res: Response) => {
    await proxyLlmUsage('/v1/billing/llm-usage/tenants', new URLSearchParams({ days: String(parseDays(req.query.days)) }), res);
  });

  router.get('/v1/admin/llm-usage/summary', async (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    if (!tenantId) {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'tenantId is required' });
      return;
    }
    await proxyLlmUsage(
      '/v1/billing/llm-usage/summary',
      new URLSearchParams({ tenantId, days: String(parseDays(req.query.days)) }),
      res,
    );
  });

  // ── External API key management (admin console) ──
  // These keys authenticate third-party (Mio) access to /v1/llm-usage/*.
  // Plaintext is returned exactly once on create; only the hash is stored.

  // POST /v1/admin/external-api-keys — create a key.
  router.post('/v1/admin/external-api-keys', async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const supplierId = typeof req.body?.supplierId === 'string' && req.body.supplierId.trim()
        ? req.body.supplierId.trim()
        : null;
      if (!name) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'name is required' });
        return;
      }
      const { key, id } = await createExternalApiKey(pool, { name, supplierId, createdBy: adminIdentity(req) });

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'external-api-key.create',
        method: 'POST',
        path: '/v1/admin/external-api-keys',
        resourceType: 'external_api_key',
        resourceId: id,
        newValue: { name, supplierId, keyPrefix: key.slice(0, 12) },
        statusCode: 200,
      });

      res.json({ ok: true, id, name, keyPrefix: key.slice(0, 12), supplierId, key });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'create key failed' });
    }
  });

  // GET /v1/admin/external-api-keys — list keys (no plaintext).
  router.get('/v1/admin/external-api-keys', async (_req: Request, res: Response) => {
    try {
      const keys = await listExternalApiKeys(pool);
      res.json({ ok: true, keys });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'list keys failed' });
    }
  });

  // DELETE /v1/admin/external-api-keys/:id — revoke a key.
  router.delete('/v1/admin/external-api-keys/:id', async (req: Request, res: Response) => {
    try {
      // Snapshot the key row for the audit trail before revoking.
      const { rows: keyRows } = await pool.query(
        'SELECT name, supplier_id, key_prefix FROM external_api_keys WHERE id = $1 AND status = $2',
        [req.params.id, 'active'],
      );
      const revoked = await revokeExternalApiKey(pool, String(req.params.id));
      if (!revoked) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'key not found or already revoked' });
        return;
      }

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'external-api-key.revoke',
        method: 'DELETE',
        path: `/v1/admin/external-api-keys/${req.params.id}`,
        resourceType: 'external_api_key',
        resourceId: String(req.params.id),
        oldValue: keyRows.length
          ? { name: keyRows[0].name, supplierId: keyRows[0].supplier_id, keyPrefix: keyRows[0].key_prefix, status: 'active' }
          : { id: req.params.id, status: 'active' },
        newValue: { status: 'revoked' },
        statusCode: 200,
      });

      res.json({ ok: true });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'revoke key failed' });
    }
  });

  // ── Chat API key management (admin console) ──
  // These keys authenticate third-party HTTP access to POST /api/external/chat
  // (write — triggers agent execution + LLM billing via llm-proxy). Scoped per
  // tenant (one enterprise = one tenant); optionally bound to a single agent.
  // Plaintext is returned exactly once on create; only the hash is stored.

  // POST /v1/admin/chat-api-keys — create a key.
  router.post('/v1/admin/chat-api-keys', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId.trim() : '';
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const agentId = typeof req.body?.agentId === 'string' && req.body.agentId.trim()
        ? req.body.agentId.trim()
        : null;
      const ipAllowlist = Array.isArray(req.body?.ipAllowlist)
        ? req.body.ipAllowlist.filter((c: unknown) => typeof c === 'string' && c.trim()).map((c: string) => c.trim())
        : null;
      const rateLimitRpm = Number.isFinite(Number(req.body?.rateLimitRpm))
        ? Math.min(Math.max(Number(req.body.rateLimitRpm) || 60, 1), 600)
        : 60;

      if (!tenantId || !name) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'tenantId and name are required' });
        return;
      }
      // The key must bind to an existing, active tenant.
      const { rows: tenantRows } = await pool.query(
        'SELECT tenant_id, status FROM tenants WHERE tenant_id = $1',
        [tenantId],
      );
      if (tenantRows.length === 0) {
        res.status(404).json({ code: 'TENANT_NOT_FOUND', message: `tenant ${tenantId} not found` });
        return;
      }
      if (tenantRows[0].status !== 'active' && tenantRows[0].status !== 'provisioning') {
        res.status(400).json({ code: 'TENANT_NOT_ACTIVE', message: `tenant status is ${tenantRows[0].status}` });
        return;
      }

      const { key, id } = await createChatApiKey(pool, {
        tenantId,
        agentId,
        name,
        ipAllowlist: ipAllowlist && ipAllowlist.length ? ipAllowlist : null,
        rateLimitRpm,
        createdBy: adminIdentity(req),
      });

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'chat-api-key.create',
        method: 'POST',
        path: '/v1/admin/chat-api-keys',
        resourceType: 'chat_api_key',
        resourceId: id,
        newValue: { tenantId, agentId, name, keyPrefix: key.slice(0, 12), ipAllowlist, rateLimitRpm },
        statusCode: 200,
      });

      res.json({ ok: true, id, tenantId, agentId, name, keyPrefix: key.slice(0, 12), rateLimitRpm, key });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'create chat key failed' });
    }
  });

  // GET /v1/admin/chat-api-keys — list keys (no plaintext). Optional tenantId filter.
  router.get('/v1/admin/chat-api-keys', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : undefined;
      const keys = await listChatApiKeys(pool, tenantId || undefined);
      res.json({ ok: true, keys });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'list chat keys failed' });
    }
  });

  // DELETE /v1/admin/chat-api-keys/:id — revoke a key.
  router.delete('/v1/admin/chat-api-keys/:id', async (req: Request, res: Response) => {
    try {
      const { rows: keyRows } = await pool.query(
        'SELECT tenant_id, agent_id, name, key_prefix, rate_limit_rpm FROM chat_api_keys WHERE id = $1 AND status = $2',
        [req.params.id, 'active'],
      );
      const revoked = await revokeChatApiKey(pool, String(req.params.id));
      if (!revoked) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'key not found or already revoked' });
        return;
      }

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'chat-api-key.revoke',
        method: 'DELETE',
        path: `/v1/admin/chat-api-keys/${req.params.id}`,
        resourceType: 'chat_api_key',
        resourceId: String(req.params.id),
        oldValue: keyRows.length
          ? { tenantId: keyRows[0].tenant_id, agentId: keyRows[0].agent_id, name: keyRows[0].name, keyPrefix: keyRows[0].key_prefix, status: 'active' }
          : { id: req.params.id, status: 'active' },
        newValue: { status: 'revoked' },
        statusCode: 200,
      });

      res.json({ ok: true });
    } catch (err: unknown) {
      const e = err as any;
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'revoke chat key failed' });
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

  // POST /v1/admin/tenants/backfill-chatlog-env — 存量租户补 chatlog 所需
  // 的 PROVISIONING_SERVICE_URL / PROVISIONING_API_TOKEN 两个 env（插件上线
  // 前 provision 的 agent Deployment 没有这两个变量 → 对话 0 条）。幂等，
  // 可安全重跑。body: { restart?: boolean }（默认 true，patch 后 scale 0→N 重启）。
  router.post('/v1/admin/tenants/backfill-chatlog-env', async (req: Request, res: Response) => {
    try {
      const restart = req.body?.restart !== false;
      const result = await backfillChatlogEnv(pool, config, { restart });
      res.json({ ok: true, operator: adminIdentity(req), ...result });
    } catch (err: unknown) {
      const e = err as any;
      console.error('chatlog env backfill failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'backfill failed' });
    }
  });

  // POST /v1/admin/tenants/backfill-sender-names — 存量 sender_name 回填。
  // 用租户自己的飞书应用凭据（tenants.app_id/app_secret）调
  // contact.v3.user.batch_get，把 chat_messages 里 sender_name 缺失或等于
  // open_id 的行解析成真实姓名回填。幂等、可重跑。
  // body: { tenantId?: string }（可选，仅处理指定租户，便于单租户验收）。
  router.post('/v1/admin/tenants/backfill-sender-names', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.body?.tenantId === 'string' && req.body.tenantId.trim()
        ? req.body.tenantId.trim()
        : undefined;
      const result = await backfillSenderNames(pool, { tenantId });
      res.json({ ok: true, operator: adminIdentity(req), ...result });
    } catch (err: unknown) {
      const e = err as any;
      console.error('sender name backfill failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'backfill failed' });
    }
  });

  // PUT /v1/admin/tenants/:id/shared-session — toggle per-tenant cross-
  // channel session sharing (Feishu + WeChat DM history merged into a single
  // session). Patches the DEALCLAW_SHARED_DM_SESSION env var on the agent
  // Deployment and restarts it so write-config.mjs regenerates openclaw.json
  // with dmScope='main' (enabled) or the per-channel defaults (disabled).
  router.put('/v1/admin/tenants/:id/shared-session', async (req: Request, res: Response) => {
    try {
      const enabled = req.body?.enabled === true;
      const tenantId = req.params.id;

      const { rows } = await pool.query(
        'SELECT tenant_id, status, k8s_namespace, agent_endpoint, shared_dm_session FROM tenants WHERE tenant_id = $1',
        [tenantId],
      );
      if (!rows.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const tenant = rows[0];
      if (tenant.status === 'destroyed') {
        res.status(400).json({ code: 'TENANT_DESTROYED', message: '租户已销毁' });
        return;
      }
      if (tenant.agent_endpoint) {
        res.status(400).json({
          code: 'EXTERNAL_AGENT',
          message: '该租户使用外部（中央）Agent，环境变量由 ArgoCD/GitOps 管理，不能在此修改',
        });
        return;
      }

      const prevValue = Boolean(tenant.shared_dm_session);
      if (prevValue === enabled) {
        res.json({ ok: true, enabled, action: 'noop' });
        return;
      }

      // Persist the toggle BEFORE patching the Deployment so a DB failure is
      // never masked by a successful K8s patch. The reverse order (patch K8s
      // first) would leave the env set but the DB stale if the UPDATE throws.
      await pool.query(
        'UPDATE tenants SET shared_dm_session = $1, updated_at = NOW() WHERE tenant_id = $2',
        [enabled, tenantId],
      );

      // Patch the agent Deployment env so write-config.mjs picks up the
      // change on next boot, then restart (scale 0 → 1) so the new config
      // takes effect immediately. patchDeploymentEnvVar returns false when
      // the env is already at the target value (no-op) — in that case a
      // restart is unnecessary.
      const namespace = tenant.k8s_namespace || config.runtimeNamespace;
      const agentName = `dealclaw-agent-${tenantId}`;
      let restarted = false;
      if (!config.k8sDryRun) {
        const patched = await patchDeploymentEnvVar(
          namespace,
          agentName,
          'DEALCLAW_SHARED_DM_SESSION',
          enabled ? '1' : '0',
        );
        if (patched) {
          restarted = await restartDeployment(namespace, agentName);
        }
      }

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'tenant.shared-session',
        method: 'PUT',
        path: `/v1/admin/tenants/${tenantId}/shared-session`,
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        oldValue: { sharedDmSession: prevValue },
        newValue: { sharedDmSession: enabled, restarted },
        statusCode: 200,
      });

      res.json({
        ok: true,
        enabled,
        action: enabled ? 'enabled' : 'disabled',
      });
    } catch (err: unknown) {
      const e = err as any;
      console.error('Toggle shared session failed:', e);
      res.status(500).json({ code: 'INTERNAL', message: e.message || 'Toggle failed' });
    }
  });

  // ── 米奥（Mio）供应商：搜索 / 新建 / 存量补录 / 租户绑定 ──
  // 鉴权沿用本文件既有方案（createServiceOrAdminAuthMiddleware：服务 token
  // 或 admin JWT）。凭据 MIO_BLADE_AUTH 只从 env 读，不经过前端。

  // GET /v1/admin/mio-suppliers?search=<kw>&page=<n> — 只读代理，专供前端
  // 下拉：只回 {ok, items:[{id, code, name}], total}。
  // 注意：米奥侧是模糊匹配，可能 0 条也可能多条（多条由调用方人工选择）。
  router.get('/v1/admin/mio-suppliers', async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (!search) {
        res.status(400).json({
          code: 'BAD_REQUEST',
          message: 'search 不能为空：供应商搜索为模糊匹配，需提供公司名关键词',
        });
        return;
      }
      const page = Math.max(0, Math.floor(Number(req.query.page ?? 0) || 0));
      const result = await searchMioSuppliers(config, { search, page });
      res.json({ ok: true, items: result.items, total: result.total });
    } catch (err: unknown) {
      sendMioError(res, err, { businessStatus: 502, fallback: '搜索米奥供应商失败' });
    }
  });

  // POST /v1/admin/mio-suppliers — 代理 quickRegister 快速创建供应商。
  // 成功回 {ok, supplierId, name}；同名重复等业务失败按米奥原始 msg 回 409。
  // 返回的 password 字段一律忽略（不入库、不回显）。
  router.post('/v1/admin/mio-suppliers', async (req: Request, res: Response) => {
    try {
      const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : '';
      const mobile = typeof req.body?.mobile === 'string' ? req.body.mobile.trim() : '';
      const intDialingCode = typeof req.body?.intDialingCode === 'string' && req.body.intDialingCode.trim()
        ? req.body.intDialingCode.trim()
        : '+86';

      if (!companyName) {
        res.status(400).json({ code: 'BAD_REQUEST', message: '公司名称（companyName）不能为空' });
        return;
      }
      if (companyName.length > 200) {
        res.status(400).json({ code: 'BAD_REQUEST', message: '公司名称过长（上限 200 字符）' });
        return;
      }
      if (!mobile) {
        res.status(400).json({ code: 'BAD_REQUEST', message: '联系人手机号（mobile）不能为空' });
        return;
      }

      const created = await quickRegisterMioSupplier(config, { companyName, mobile, intDialingCode });

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'mio-supplier.create',
        method: 'POST',
        path: '/v1/admin/mio-suppliers',
        resourceType: 'mio_supplier',
        resourceId: created.supplierId,
        newValue: { supplierId: created.supplierId, name: created.name, intDialingCode },
        statusCode: 200,
      });

      res.json({ ok: true, supplierId: created.supplierId, name: created.name });
    } catch (err: unknown) {
      sendMioError(res, err, { businessStatus: 409, fallback: '创建米奥供应商失败' });
    }
  });

  // POST /v1/admin/mio-suppliers/backfill — 存量补录。
  // 入参 {tenantIds?: string[], dryRun?: boolean}（dryRun 默认 true，只报告不写库）。
  // 规则：company_name 非空 && mio_cdp_supplier_id 为空的租户按公司名搜索,
  // **只有唯一精确命中（忽略大小写/首尾空格的完整名称相等）才写入**；
  // 0 条或多条一律进 skipped，绝不自动取第一条。
  router.post('/v1/admin/mio-suppliers/backfill', async (req: Request, res: Response) => {
    try {
      const rawIds = req.body?.tenantIds;
      if (rawIds !== undefined && rawIds !== null && !Array.isArray(rawIds)) {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'tenantIds 必须是字符串数组' });
        return;
      }
      const tenantIds = Array.isArray(rawIds)
        ? rawIds.filter((v: unknown) => typeof v === 'string' && (v as string).trim()).map((v: string) => v.trim())
        : undefined;
      const dryRun = req.body?.dryRun !== false;

      const result = await backfillTenantMioSuppliers(pool, config, { tenantIds, dryRun });

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'mio-supplier.backfill',
        method: 'POST',
        path: '/v1/admin/mio-suppliers/backfill',
        resourceType: 'mio_supplier',
        newValue: {
          dryRun: result.dryRun,
          scanned: result.scanned,
          matched: result.matched,
          updated: result.updated,
          skipped: result.skipped.length,
          tenantIds: tenantIds ?? null,
        },
        statusCode: 200,
      });

      res.json({ ok: true, operator: adminIdentity(req), ...result });
    } catch (err: unknown) {
      sendMioError(res, err, { businessStatus: 409, fallback: '米奥供应商补录失败' });
    }
  });

  // POST /v1/admin/tenants/:tenantId/mio-supplier — 给已存在租户绑定/换绑
  // 米奥供应商 ID（body: {supplierId}；null/空串 = 清除）。
  // 复用 services/mio-supplier.ts 的服务函数（含唯一约束预检 + agent-config
  // Secret 注入 + agent 滚动重启）；唯一冲突已翻成可读中文。
  // 与 PATCH /v1/tenants/:id/mio-supplier-id 行为一致，只是路径挂在 /v1/admin 下。
  router.post('/v1/admin/tenants/:tenantId/mio-supplier', async (req: Request, res: Response) => {
    try {
      const { supplierId } = req.body ?? {};
      if (supplierId !== undefined && supplierId !== null && typeof supplierId !== 'string') {
        res.status(400).json({ code: 'BAD_REQUEST', message: 'supplierId 必须是字符串或 null' });
        return;
      }
      const tenantId = String(req.params.tenantId);
      const result = await updateTenantMioSupplier(pool, config, tenantId, supplierId ?? null);

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'tenant.mio-supplier',
        method: 'POST',
        path: `/v1/admin/tenants/${tenantId}/mio-supplier`,
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        newValue: { supplierId: result.supplierId, restarted: result.restarted },
        statusCode: 200,
      });

      res.json({
        ...result,
        message: result.restarted
          ? `供应商 ID 已${result.supplierId ? `设为 ${result.supplierId}` : '清除'}，agent 已滚动重启（约 10–30 秒生效）`
          : `供应商 ID 已${result.supplierId ? `设为 ${result.supplierId}` : '清除'}`,
      });
    } catch (err: unknown) {
      sendMioError(res, err, { businessStatus: 409, fallback: '更新米奥供应商 ID 失败' });
    }
  });

  return router;
}
