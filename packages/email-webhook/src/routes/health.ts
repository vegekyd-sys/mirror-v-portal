import type { FastifyRequest } from "fastify";
import { VERSION } from "../version.js";
import { feishuEnabled, resendApiEnabled } from "../config.js";
import { query } from "../db/pool.js";
import type { AppState } from "../state.js";

async function redisOk(client: AppState["redis"]): Promise<boolean> {
  if (client === null) return false;
  try {
    return Boolean(await client.ping());
  } catch {
    return false;
  }
}

async function databaseOk(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** 验收标准 1：返回 ok。同时把各依赖的状态一并暴露，方便排查。 */
export async function healthHandler(request: FastifyRequest): Promise<Record<string, unknown>> {
  const state = request.server.state;
  const settings = state.settings;
  const [bindingStats, supplierCount, dbOk, cacheOk] = await Promise.all([
    state.bindings.stats().catch(() => ({ count: 0, anyMention: false })),
    state.suppliers.count().catch(() => 0),
    databaseOk(),
    redisOk(state.redis),
  ]);

  return {
    status: "ok",
    version: VERSION,
    checks: {
      signature_enforced: Boolean(settings.signingSecret) || !settings.allowUnsigned,
      signing_secret_configured: Boolean(settings.signingSecret),
      resend_api_configured: resendApiEnabled(settings),
      // 数据库是硬依赖：绑定表、供应商表、事件、幂等都靠它
      database_connected: dbOk,
      redis_connected: cacheOk,
      lead_backend: state.leads.name,
      feishu_configured: feishuEnabled(settings),
      feishu_mention_configured:
        Boolean(settings.feishuMentionOpenId) || bindingStats.anyMention,
      bindings: bindingStats.count,
      suppliers: supplierCount,
      default_supplier_id: settings.defaultSupplierId,
      admin_api: Boolean(settings.adminToken),
    },
  };
}
