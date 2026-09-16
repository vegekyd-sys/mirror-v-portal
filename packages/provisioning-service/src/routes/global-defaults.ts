/**
 * 全局默认配置接口（工单 5）。
 *
 *   GET  /v1/admin/global-defaults            只回「已配置/未配置 + 长度 + 更新时间 + 更新人」
 *   PUT  /v1/admin/global-defaults            写入/更新（只写不回显）
 *   POST /v1/admin/global-defaults/dry-run    只算不改：受影响租户清单 + 需要更新/已最新
 *   POST /v1/admin/global-defaults/apply      人工触发：逐个下发 + 每租户回执
 *
 * 鉴权：沿用本服务既有 service-token / admin-JWT 中间件，**另外要求超管**
 * （createSuperAdminMiddleware：只有 admin 角色的 JWT 通过，服务令牌与其他角色 403）。
 *
 * 审计（决策 3）：每次「修改」与每次「下发」都写 audit_logs，记录
 * who / when / 改了哪个 key / 影响范围 / 结果，**不记录任何明文值**。
 * 全局 audit 中间件还会兜底记一条请求级记录，body 里的 `value` 已在
 * services/audit.ts 的 BODY_SANITIZERS 里强制打码。
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest, writeAuditLog, type AuditEntry } from '../services/audit.js';
import { MasterKeyError, getMasterKey } from '../services/crypto.js';
import {
  GlobalDefaultError,
  applyGlobalDefaults,
  dryRunGlobalDefaults,
  listGlobalDefaults,
  upsertGlobalDefault,
} from '../services/global-defaults.js';
import { createSuperAdminMiddleware } from '../middleware/auth.js';

const PATH_BASE = '/v1/admin/global-defaults';

export function createGlobalDefaultRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);
  // 超管门禁必须在 authMiddleware 之后（req.adminUser 由它填充），且**逐路由**挂载：
  // 该 router 是 app.use(router) 无路径挂载，若用 router.use(middleware) 会把门禁
  // 施加到所有落到本 router 的请求（包括本 router 不匹配、应继续往下走的路径）。
  const superAdmin = createSuperAdminMiddleware();

  const auditFor = (req: Request, entry: Omit<AuditEntry, 'actor' | 'actorType'>) => {
    const { actor, actorType } = actorFromRequest(req);
    return writeAuditLog(pool, { ...entry, actor, actorType });
  };

  /** RUNTIME_CONFIG_KEY 是否可用（不可用时列表只能显示「未配置」，也不能写入）。 */
  const masterKeyAvailable = (): boolean => {
    try {
      return getMasterKey() !== null;
    } catch {
      return false;
    }
  };

  // GET /v1/admin/global-defaults — 列表（永不回显明文）
  router.get(PATH_BASE, superAdmin, async (_req: Request, res: Response) => {
    try {
      const items = await listGlobalDefaults(pool);
      res.json({ ok: true, items, keyConfigured: masterKeyAvailable() });
    } catch (err) {
      console.error('[global-defaults] list failed:', err);
      res.status(500).json({ code: 'INTERNAL', message: '读取默认配置失败' });
    }
  });

  // PUT /v1/admin/global-defaults — 写入/更新一个默认项（只写不回显）
  router.put(PATH_BASE, superAdmin, async (req: Request, res: Response) => {
    try {
      const { key, value } = req.body ?? {};
      const { actor } = actorFromRequest(req);
      const saved = await upsertGlobalDefault(pool, { key, value, updatedBy: actor });

      // 审计：key / 长度 / 更新人，绝不含值。
      await auditFor(req, {
        action: 'global-default.update',
        method: 'PUT',
        path: PATH_BASE,
        resourceType: 'global_default',
        resourceId: saved.key,
        newValue: { key: saved.key, isSecret: saved.isSecret, length: saved.length, updatedBy: saved.updatedBy },
        statusCode: 200,
      });

      res.json({
        ok: true,
        key: saved.key,
        isSecret: saved.isSecret,
        configured: true,
        length: saved.length,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
        hint: '已保存：仅影响此后新建的 Agent。存量 Agent 需点「同步到存量 Agent」（先 dryRun）才会更新。',
      });
    } catch (err) {
      sendError(res, err, '保存默认配置失败');
    }
  });

  // POST /v1/admin/global-defaults/dry-run — 只算不改
  router.post(`${PATH_BASE}/dry-run`, superAdmin, async (req: Request, res: Response) => {
    try {
      const tenantIds = normalizeTenantIds(req.body?.tenantIds);
      if (tenantIds === 'invalid') {
        res.status(400).json({ code: 'VALIDATION', message: 'tenantIds 必须是字符串数组' });
        return;
      }
      const keys = normalizeKeys(req.body?.keys);
      if (keys === 'invalid') {
        res.status(400).json({ code: 'VALIDATION', message: 'keys 必须是字符串数组' });
        return;
      }
      const report = await dryRunGlobalDefaults(pool, config, { tenantIds, keys });
      res.json({ ok: true, ...report });
    } catch (err) {
      sendError(res, err, '生成 dryRun 报告失败');
    }
  });

  // POST /v1/admin/global-defaults/apply — 人工触发的逐个下发
  router.post(`${PATH_BASE}/apply`, superAdmin, async (req: Request, res: Response) => {
    try {
      const tenantIds = normalizeTenantIds(req.body?.tenantIds);
      if (tenantIds === 'invalid') {
        res.status(400).json({ code: 'VALIDATION', message: 'tenantIds 必须是字符串数组' });
        return;
      }
      const result = await applyGlobalDefaults(pool, config, { tenantIds });
      const { actor, actorType } = actorFromRequest(req);

      // 审计：影响范围 + 逐个结果（成功/失败原因），绝不含值。
      await writeAuditLog(pool, {
        actor,
        actorType,
        action: 'global-default.apply',
        method: 'POST',
        path: `${PATH_BASE}/apply`,
        resourceType: 'global_default',
        resourceId: 'apply',
        newValue: {
          scope: tenantIds ? 'partial' : 'all',
          requestedTenantIds: tenantIds ?? null,
          attempted: result.attempted,
          succeeded: result.succeeded,
          failed: result.failed,
          failures: result.receipts
            .filter((r) => !r.ok)
            .map((r) => ({ tenantId: r.tenantId, error: r.error })),
        },
        statusCode: 200,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, '下发默认配置失败');
    }
  });

  return router;
}

function normalizeTenantIds(raw: unknown): string[] | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return 'invalid';
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  return ids.length ? ids : undefined;
}

function normalizeKeys(raw: unknown): string[] | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return 'invalid';
  const keys = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  return keys.length ? keys : undefined;
}

/** 错误 → HTTP：主密钥缺失 503；校验类 400；其余 500。响应体永不含值。 */
function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof MasterKeyError) {
    res.status(503).json({ code: 'RUNTIME_CONFIG_KEY_NOT_CONFIGURED', message: err.message });
    return;
  }
  if (err instanceof GlobalDefaultError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof Error && (err.message.startsWith('Unknown global default key') || err.message.startsWith('Invalid config key'))) {
    res.status(400).json({ code: 'VALIDATION', message: err.message });
    return;
  }
  console.error(`[global-defaults] ${fallback}:`, err);
  res.status(500).json({ code: 'INTERNAL', message: fallback });
}
