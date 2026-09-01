import type pg from 'pg';

/**
 * 存量 sender_name 回填。
 *
 * 背景：会话列表（chat_messages.sessions）展示的「发言人名」来自
 * chat_messages.sender_name。dealclaw-chatlog 插件在 ingest 时把 OpenClaw
 * 框架解析出的显示名存进来；当租户飞书应用缺少 contact:user.base:readonly
 * 通讯录权限（或解析失败）时，框架回退存了 open_id 本身，于是界面显示成
 * ou_ 开头的一串。
 *
 * 两条扫码路径（自助入驻 / 管理后台扫码）已在 2026-08-30..31 补齐该权限，
 * 但存量租户仍需客户侧手动补开（见仓库根 feishu-contact-permission-guide.md）。
 * 客户补开权限后，新消息能正确解析姓名，但历史行的 sender_name 仍是 open_id，
 * 需要用租户自己的飞书应用凭据（tenants.app_id / app_secret）批量解析回填。
 *
 * 本函数遍历 chat_messages 里 sender_name 缺失或等于 open_id 的行，按租户
 * 分组，用各自应用调 contact.v3.user.batch_get 解析姓名并回填。幂等、可重跑。
 */

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_BATCH_GET_URL = 'https://open.feishu.cn/open-apis/contact/v3/user/batch_get';
/** 飞书 batch_get 单次 user_ids 上限（稳妥取 100）。 */
const BATCH_SIZE = 100;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SenderNameBackfillTenant {
  tenantId: string;
  appId: string;
  /** 成功解析到姓名的 open_id 数量 */
  resolved: number;
  /** 未能解析（用户不存在 / 无权限 / 已删除）的 open_id 数量 */
  unresolved: number;
  /** 实际回填的 chat_messages 行数 */
  updated: number;
  /** true = 无应用凭据，跳过 */
  skipped: boolean;
  error?: string;
}

export interface SenderNameBackfillResult {
  tenants: SenderNameBackfillTenant[];
  summary: {
    total: number;
    resolved: number;
    unresolved: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}

async function getTenantAccessToken(appId: string, appSecret: string, fetchImpl: FetchLike): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new Error(`无法访问飞书开放平台获取 tenant_access_token：${err?.message || err}`);
  }
  const body = await res.json().catch(() => ({} as any));
  if (!res.ok || (body as any)?.code !== 0) {
    throw new Error(`飞书 tenant_access_token 获取失败：${(body as any)?.msg || `HTTP ${res.status}`}`);
  }
  return (body as any)?.tenant_access_token as string;
}

async function batchGetUserNames(token: string, openIds: string[], fetchImpl: FetchLike): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let res: Response;
  try {
    res = await fetchImpl(FEISHU_BATCH_GET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user_ids: openIds, user_id_type: 'open_id' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new Error(`无法访问飞书 contact.v3.user.batch_get：${err?.message || err}`);
  }
  const body = await res.json().catch(() => ({} as any));
  if (!res.ok || (body as any)?.code !== 0) {
    throw new Error(`飞书 contact.v3.user.batch_get 失败：${(body as any)?.msg || `HTTP ${res.status}`}`);
  }
  const items: Array<{ open_id?: string; name?: string }> = (body as any)?.data?.items ?? [];
  for (const it of items) {
    if (it.open_id && it.name) map.set(it.open_id, it.name);
  }
  return map;
}

/**
 * 回填所有（或指定租户的）sender_name。
 * opts.tenantId 可选：仅处理该租户，便于单租户调试/验收。
 * opts.fetchImpl 可选：注入 fetch，测试用。
 */
export async function backfillSenderNames(
  pool: pg.Pool,
  opts: { tenantId?: string; fetchImpl?: FetchLike } = {},
): Promise<SenderNameBackfillResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const tenantFilter = opts.tenantId ? 'AND tenant_id = $1' : '';
  const filterParams: unknown[] = opts.tenantId ? [opts.tenantId] : [];

  // 1. 找出需要回填的 (tenant_id, sender_open_id) 对。
  const { rows: needsRows } = await pool.query(
    `SELECT DISTINCT tenant_id, sender_open_id
       FROM chat_messages
      WHERE sender_open_id IS NOT NULL
        AND (sender_name IS NULL OR sender_name = sender_open_id)
        ${tenantFilter}
      ORDER BY tenant_id`,
    filterParams,
  );

  // 按租户分组去重。
  const byTenant = new Map<string, Set<string>>();
  for (const r of needsRows as Array<{ tenant_id: string; sender_open_id: string }>) {
    if (!r.sender_open_id) continue;
    let set = byTenant.get(r.tenant_id);
    if (!set) {
      set = new Set();
      byTenant.set(r.tenant_id, set);
    }
    set.add(r.sender_open_id);
  }

  // 2. 取这些租户的应用凭据。
  const tenantIds = [...byTenant.keys()];
  const creds = new Map<string, { appId: string; appSecret: string }>();
  if (tenantIds.length) {
    const { rows: tenantRows } = await pool.query(
      `SELECT tenant_id, app_id, app_secret FROM tenants
        WHERE tenant_id = ANY($1::text[]) AND app_id IS NOT NULL AND app_secret IS NOT NULL`,
      [tenantIds],
    );
    for (const t of tenantRows as Array<{ tenant_id: string; app_id: string; app_secret: string }>) {
      creds.set(t.tenant_id, { appId: t.app_id, appSecret: t.app_secret });
    }
  }

  // 3. 逐租户解析 + 回填。
  const tenants: SenderNameBackfillTenant[] = [];
  let resolved = 0;
  let unresolved = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [tenantId, openIdSet] of byTenant) {
    const openIds = [...openIdSet];
    const cred = creds.get(tenantId);
    const t: SenderNameBackfillTenant = {
      tenantId,
      appId: cred?.appId ?? '',
      resolved: 0,
      unresolved: 0,
      updated: 0,
      skipped: false,
    };

    if (!cred) {
      t.skipped = true;
      skipped += 1;
      tenants.push(t);
      continue;
    }

    try {
      const token = await getTenantAccessToken(cred.appId, cred.appSecret, fetchImpl);
      const nameMap = new Map<string, string>();
      for (let i = 0; i < openIds.length; i += BATCH_SIZE) {
        const chunk = openIds.slice(i, i + BATCH_SIZE);
        const partial = await batchGetUserNames(token, chunk, fetchImpl);
        for (const [k, v] of partial) nameMap.set(k, v);
      }

      for (const [openId, name] of nameMap) {
        const { rowCount } = await pool.query(
          `UPDATE chat_messages SET sender_name = $1
            WHERE tenant_id = $2 AND sender_open_id = $3
              AND (sender_name IS NULL OR sender_name = sender_open_id)`,
          [name, tenantId, openId],
        );
        t.resolved += 1;
        t.updated += rowCount ?? 0;
        resolved += 1;
        updated += rowCount ?? 0;
      }
      t.unresolved = openIds.length - nameMap.size;
      unresolved += t.unresolved;

      tenants.push(t);
    } catch (err: any) {
      t.error = err?.message || String(err);
      failed += 1;
      tenants.push(t);
    }
  }

  return {
    tenants,
    summary: { total: tenants.length, resolved, unresolved, updated, skipped, failed },
  };
}
