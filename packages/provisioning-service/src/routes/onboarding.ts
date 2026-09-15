/**
 * 一键开通流水线（工单 1，FDE 版）。
 *
 *   POST /v1/admin/onboarding/quick-start
 *   body { companyName, contactPhone, intDialingCode, planTier }
 *   → 查/建米奥供应商 → 建租户（复用 services/tenant-create.ts，合并全局默认）
 *   → 启动飞书扫码 → 返回 { tenantId, supplierId, deviceCode, qrUrl, status }
 *
 * 供应商判定（与 mio-supplier.ts 的存量补录同口径，绝不自动取第一条）：
 *   - 唯一精确命中（名称忽略大小写/首尾空格相等）→ 取其 `id`；
 *   - 0 条精确命中 → quickRegister 新建供应商；
 *   - 多条精确命中 → 409 + 候选列表，由操作者指定。
 *
 * 权限形态：本接口沿用本服务既有 service-token / admin-JWT 鉴权，**不加 FDE
 * 专属校验**——按「后续可直接开放给销售/CSM」的形态设计，本期只在前端按角色
 * 收敛入口（admin-web 的 QUICK_START_ROLES）。
 *
 * 兼容性：建租户不额外传飞书凭据，因此走「先建客户记录、等扫码绑定后自动
 * provision」的既有路径（返回 status=pending、provisioned=false）——
 * POST /v1/tenants 本身的行为未做任何改动。
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest, writeAuditLog } from '../services/audit.js';
import {
  MioApiError,
  quickRegisterMioSupplier,
  searchMioSuppliers,
  type MioSupplierRecord,
} from '../services/mio-supplier-client.js';
import { isExactCompanyNameMatch } from '../services/mio-supplier.js';
import { TenantCreateError, createTenant } from '../services/tenant-create.js';
import {
  FeishuAppScanError,
  FeishuAppScanStore,
  scanStatusMessage,
} from '../services/feishu-app-scan.js';

const PATH_QUICK_START = '/v1/admin/onboarding/quick-start';
const PLAN_TIERS = ['starter', 'pro', 'enterprise'] as const;
/** 米奥候选最多回传条数（模糊命中可能很多，仅供操作者人工挑选）。 */
const MAX_CANDIDATES = 20;

export function createOnboardingRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  /**
   * 与 routes/feishu-app-scan.ts 共用的扫码会话 store（app.ts 注入同一实例），
   * 否则本接口产出的 deviceCode 在 status 轮询接口里查不到。
   */
  scanStore: FeishuAppScanStore = new FeishuAppScanStore(),
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  router.post(PATH_QUICK_START, async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
    const contactPhoneRaw = typeof body.contactPhone === 'string' ? body.contactPhone.trim() : '';
    const intDialingCode =
      typeof body.intDialingCode === 'string' && body.intDialingCode.trim() ? body.intDialingCode.trim() : '+86';
    const planTier = (PLAN_TIERS as readonly string[]).includes(body.planTier) ? body.planTier : 'starter';

    if (!companyName) {
      res.status(400).json({ code: 'VALIDATION', message: '企业名称（companyName）不能为空' });
      return;
    }
    const phoneDigits = contactPhoneRaw.replace(/[^0-9]/g, '');
    if (!phoneDigits) {
      res.status(400).json({ code: 'VALIDATION', message: '联系人手机号必填（含国际区号，如 +86 13800000000）' });
      return;
    }
    if (intDialingCode.length > 8) {
      res.status(400).json({ code: 'VALIDATION', message: '国际区号格式不正确（如 +86）' });
      return;
    }
    // 库里存带区号的完整号码；米奥侧用区号 + 纯数字分开传。
    const contactPhone = contactPhoneRaw.startsWith('+') ? contactPhoneRaw : `${intDialingCode}${phoneDigits}`;

    // 供应商已在本次流程里创建成功但后续步骤失败时，把它带回错误响应，
    // 避免操作者重复创建（米奥按同名会判重复）。
    let createdSupplier: { supplierId: string; name: string | null } | null = null;

    try {
      // ① 查供应商（模糊 → 只认唯一精确命中）
      const search = await searchMioSuppliers(config, { search: companyName });
      const exact = search.items.filter((i) => isExactCompanyNameMatch(i.name, companyName));

      if (exact.length > 1) {
        // 绝不自动取第一条：回候选列表让操作者指定。
        res.status(409).json({
          code: 'MULTIPLE_MATCHES',
          message: `米奥侧有 ${exact.length} 个名称完全一致的供应商，请人工确认要绑定哪一个`,
          candidates: exact.slice(0, MAX_CANDIDATES).map(toCandidate),
        });
        return;
      }

      let supplierId: string;
      let supplierName: string | null;
      let supplierCreated = false;

      if (exact.length === 1) {
        supplierId = exact[0].id;
        supplierName = exact[0].name;
      } else {
        // ② 0 条精确命中 → 快速创建（同名重复等业务失败原样透出）
        const registered = await quickRegisterMioSupplier(config, {
          companyName,
          mobile: phoneDigits,
          intDialingCode,
        });
        supplierId = registered.supplierId;
        supplierName = registered.name;
        supplierCreated = true;
        createdSupplier = { supplierId, name: supplierName };
      }

      // ③ 建租户（复用 tenant-create：含全局默认配置合并；无飞书凭据 → 先建记录）
      const outcome = await createTenant(
        { pool, config },
        {
          companyName,
          contactPhone,
          planTier,
          mioCdpSupplierId: supplierId,
        },
      );

      // ④ 启动扫码（与 feishu-app-scan 路由共用 store）
      const session = await scanStore.start();

      await writeAuditLog(pool, {
        ...actorFromRequest(req),
        action: 'onboarding.quick-start',
        method: 'POST',
        path: PATH_QUICK_START,
        resourceType: 'tenant',
        resourceId: outcome.tenant.tenantId,
        tenantId: outcome.tenant.tenantId,
        newValue: {
          companyName,
          planTier,
          supplierId,
          supplierCreated,
          deviceCode: session.deviceCode,
          tenantStatus: outcome.tenant.status,
          missingDefaultKeys: outcome.missingDefaultKeys,
        },
        statusCode: 201,
      });

      res.status(201).json({
        ok: true,
        tenantId: outcome.tenant.tenantId,
        supplierId,
        deviceCode: session.deviceCode,
        qrUrl: session.qrUrl,
        qrDataUri: session.qrDataUri,
        expireIn: session.expireIn,
        // status = 租户状态（无飞书凭据时 pending，扫码绑定后自动开通）
        status: outcome.tenant.status,
        scanStatus: session.status,
        scanMessage: scanStatusMessage(session),
        provisioned: outcome.provisioned,
        supplier: { supplierId, name: supplierName, created: supplierCreated },
        tenant: outcome.tenant,
        warnings: outcome.provisioning?.warnings ?? [],
      });
    } catch (err: unknown) {
      sendQuickStartError(res, err, createdSupplier);
    }
  });

  return router;
}

function toCandidate(item: MioSupplierRecord) {
  return { id: item.id, code: item.code, name: item.name };
}

/**
 * 错误映射：米奥业务错误原样透出上游 msg；建租户/扫码错误按其 status/code 回。
 * 只有「本次已创建的供应商 id」会被带回错误体，绝不回显任何凭据或默认值。
 */
function sendQuickStartError(
  res: Response,
  err: unknown,
  createdSupplier: { supplierId: string; name: string | null } | null,
): void {
  const supplier = createdSupplier ? { supplier: createdSupplier } : {};

  if (err instanceof MioApiError) {
    const status =
      err.kind === 'business' ? 409 : err.kind === 'input' ? 400 : err.kind === 'config' ? 503 : err.status;
    console.error(`[onboarding] mio error (${err.kind}): ${err.message}`);
    res.status(status).json({ code: err.code, message: err.message, ...supplier });
    return;
  }
  if (err instanceof TenantCreateError) {
    console.error(`[onboarding] tenant create failed: ${err.code} ${err.message}`);
    res.status(err.status).json({ code: err.code, message: err.message, ...supplier });
    return;
  }
  if (err instanceof FeishuAppScanError) {
    console.error(`[onboarding] scan start failed: ${err.code} ${err.message}`);
    res.status(err.status).json({ code: err.code, message: err.message, ...supplier });
    return;
  }
  console.error('[onboarding] quick-start failed:', err);
  res.status(500).json({
    code: 'INTERNAL',
    message: err instanceof Error ? err.message : '一键开通失败',
    ...supplier,
  });
}
