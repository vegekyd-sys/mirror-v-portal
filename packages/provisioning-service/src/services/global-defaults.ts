/**
 * 全局默认配置（「默认配置」页的数据 + 业务层）。
 *
 * 定位：所有 Agent 的共性默认项，改一处 → 新建 Agent 自动继承；存量 Agent
 * 需要「dryRun 报告 → 人工确认 → 逐个下发」（不允许自动全量）。
 *
 * 数据面：global_defaults 表（key / value_encrypted / is_secret / updated_by
 * / updated_at）。**值复用 runtime_configs 已验证的 AES-256-GCM 机制**
 * （services/crypto.ts，密钥 RUNTIME_CONFIG_KEY）——不新造密钥、不新造算法。
 *
 * 首次录入（决策 1）：运维把值写进 K8s Secret → 以 env 形式注入
 * provisioning-service（DEFAULT_RESEND_API_KEY / DEFAULT_WEBHOOK_ADMIN_TOKEN /
 * DEFAULT_UN_COMTRADE_API_KEY / DEFAULT_WTO_API_KEY / DEFAULT_PRIMARY_GROUP_RULE）
 * → 服务启动时 seedGlobalDefaults() **幂等种子**：ON CONFLICT DO NOTHING，
 * 已存在不覆盖；env 缺失不阻断启动。之后一律走 admin 页修改。
 *
 * 审计（决策 3）：本模块只回执「改了哪个 key / 影响范围 / 结果」，从不返回
 * 或记录明文值；审计写入由 routes/global-defaults.ts 负责（不记值）。
 */

import type pg from 'pg';
import { encryptValue, getMasterKey, decryptValue } from './crypto.js';
import { validateConfigKey } from './runtime-config.js';
import {
  REQUIRED_TENANT_DEFAULT_KEYS,
  readGlobalDefaults,
  parseEnvFile,
} from './tenant-env.js';
import { getSecret } from './k8s-client.js';
import {
  pushTenantSkillEnv,
  SKILL_ENV_SECRET_NAME,
  type SkillEnvRollout,
} from './skill-env.js';
import type { ProvisioningConfig } from '../config.js';

export type GlobalDefaultGroup = 'secret' | 'group' | 'skill';

export interface GlobalDefaultSpec {
  key: string;
  /** 页面分组：密钥 / 群与绑定 / skill 默认。 */
  group: GlobalDefaultGroup;
  isSecret: boolean;
  /** 启动种子读取的 env 名（仅首次，已存在不覆盖）。 */
  envVar: string;
  description: string;
  /** 枚举型配置的合法值（非枚举项留空）。 */
  allowedValues?: string[];
  /** 枚举型配置的缺省值（env 未提供时用它做种子）。 */
  defaultValue?: string;
}

/** 主群规则：第一个群自动设为主群（决策 4，作为全局默认项，可配置）。 */
export const PRIMARY_GROUP_RULE_KEY = 'PRIMARY_GROUP_RULE';
export const PRIMARY_GROUP_RULE_VALUES = ['first_group', 'manual'] as const;
export const PRIMARY_GROUP_RULE_DEFAULT = 'first_group';

/**
 * 首批纳入的配置项（工单 5）。**扩展方式：在此数组加一项即可**——
 * 页面分组、启动种子 env 名、是否敏感、枚举校验都由它驱动。
 * 注意：key 必须同时是合法环境变量名（它会并进租户 skill env）。
 */
export const GLOBAL_DEFAULT_SPECS: GlobalDefaultSpec[] = [
  {
    key: 'RESEND_API_KEY',
    group: 'secret',
    isSecret: true,
    envVar: 'DEFAULT_RESEND_API_KEY',
    description: 'Resend 发信 API Key（所有 Agent 同值，客户无需再配）',
  },
  {
    key: 'WEBHOOK_ADMIN_TOKEN',
    group: 'secret',
    isSecret: true,
    envVar: 'DEFAULT_WEBHOOK_ADMIN_TOKEN',
    description: '邮件 Webhook 管理令牌（所有 Agent 同值）',
  },
  {
    key: 'UN_COMTRADE_API_KEY',
    group: 'secret',
    isSecret: true,
    envVar: 'DEFAULT_UN_COMTRADE_API_KEY',
    description: '联合国贸发（UN Comtrade）API Key（所有 Agent 同值）',
  },
  {
    key: 'WTO_API_KEY',
    group: 'secret',
    isSecret: true,
    envVar: 'DEFAULT_WTO_API_KEY',
    description: 'WTO API Key（所有 Agent 同值）',
  },
  {
    key: PRIMARY_GROUP_RULE_KEY,
    group: 'group',
    isSecret: false,
    envVar: 'DEFAULT_PRIMARY_GROUP_RULE',
    description: '多群规则：第一个群自动设为主群（first_group）/ 不自动设主群（manual）',
    allowedValues: [...PRIMARY_GROUP_RULE_VALUES],
    defaultValue: PRIMARY_GROUP_RULE_DEFAULT,
  },
  // 预留（工单 5「预留：默认 skill env、默认开关」）：新增默认项时在此追加，
  // group 用 'skill'。
];

export const GLOBAL_DEFAULT_KEYS: string[] = GLOBAL_DEFAULT_SPECS.map((s) => s.key);

export function getGlobalDefaultSpec(key: string): GlobalDefaultSpec | undefined {
  return GLOBAL_DEFAULT_SPECS.find((s) => s.key === key);
}

/** 校验 key 在册且是合法环境变量名；不在册直接拒绝（避免变成第二张 runtime_configs）。 */
export function validateGlobalDefaultKey(key: unknown): string {
  const valid = validateConfigKey(key);
  if (!getGlobalDefaultSpec(valid)) {
    throw new Error(
      `Unknown global default key "${valid}" — 允许的 key：${GLOBAL_DEFAULT_KEYS.join(', ')}（新增默认项请在 GLOBAL_DEFAULT_SPECS 登记）`,
    );
  }
  return valid;
}

export class GlobalDefaultError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalDefaultError';
  }
}

/** 校验枚举型配置的取值。 */
export function validateGlobalDefaultValue(key: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GlobalDefaultError(400, 'VALIDATION', '配置值不能为空（空值请用 DELETE 语义，本期未开放）');
  }
  const spec = getGlobalDefaultSpec(key);
  if (spec?.allowedValues && !spec.allowedValues.includes(value)) {
    throw new GlobalDefaultError(
      400,
      'VALIDATION',
      `${key} 取值必须是 ${spec.allowedValues.join(' / ')} 之一`,
    );
  }
  return value;
}

// ── 启动种子（幂等：已存在不覆盖） ─────────────────────────────────────────

export interface SeedResult {
  /** 本次新写入的 key。 */
  inserted: string[];
  /** 已存在、按幂等语义跳过的 key。 */
  skipped: string[];
  /** env 未提供值、无法种子的 key。 */
  missingEnv: string[];
  /** 写入失败（DB/加密）的 key —— 不阻断启动。 */
  failed: Array<{ key: string; error: string }>;
}

/**
 * 从 env 幂等种子 global_defaults：
 *   - 读取 spec.envVar，值非空才处理；
 *   - INSERT ... ON CONFLICT (key) DO NOTHING → 已存在不覆盖（运维页面改过的值不会被启动流程回滚）；
 *   - env 缺失、DB 报错、主密钥不可用都只记录，**绝不阻断启动**。
 * 日志只出现 key 名，绝不出现值。
 */
export async function seedGlobalDefaults(
  pool: Pick<pg.Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const result: SeedResult = { inserted: [], skipped: [], missingEnv: [], failed: [] };
  for (const spec of GLOBAL_DEFAULT_SPECS) {
    const raw = env[spec.envVar];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      // 枚举型配置有缺省值（主群规则默认 first_group），env 未提供也落一次种子。
      if (!spec.defaultValue) {
        result.missingEnv.push(spec.key);
        continue;
      }
    }
    const effective = value || (spec.defaultValue as string);
    try {
      const encrypted = encryptValue(effective);
      const res = await pool.query(
        `INSERT INTO global_defaults (key, value_encrypted, is_secret, updated_by, updated_at)
         VALUES ($1, $2, $3, 'seed:env', NOW())
         ON CONFLICT (key) DO NOTHING`,
        [spec.key, encrypted, spec.isSecret],
      );
      if ((res.rowCount ?? 0) > 0) result.inserted.push(spec.key);
      else result.skipped.push(spec.key);
    } catch (err: unknown) {
      result.failed.push({ key: spec.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    action: 'global-defaults.seed',
    message: 'global defaults seeded from env',
    inserted: result.inserted,
    skipped: result.skipped,
    missingEnv: result.missingEnv,
    failed: result.failed.map((f) => f.key),
  }));

  return result;
}

// ── 读取 / 写入 ────────────────────────────────────────────────────────────

export interface GlobalDefaultViewItem {
  key: string;
  isSecret: boolean;
  group: GlobalDefaultGroup;
  description: string;
  /** 是否已有值（有行且能解密）。 */
  configured: boolean;
  /** 明文长度（用于人工核对是否填错），**不返回明文**。 */
  length: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * 列表：**永不回显明文**。只给「已配置/未配置 + 长度 + 更新时间 + 更新人」。
 * 未配置的 key 也出现在列表里（按 catalog 补全），便于页面直接渲染待填项。
 */
export async function listGlobalDefaults(pool: pg.Pool): Promise<GlobalDefaultViewItem[]> {
  const { rows } = await pool.query<{
    key: string;
    value_encrypted: string;
    is_secret: boolean;
    updated_by: string | null;
    updated_at: string | null;
  }>('SELECT key, value_encrypted, is_secret, updated_by, updated_at FROM global_defaults');

  const canDecrypt = canDecryptMasterKey();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const keys = [...new Set([...GLOBAL_DEFAULT_KEYS, ...rows.map((r) => r.key)])].sort();
  return keys.map((key): GlobalDefaultViewItem => {
    const spec = getGlobalDefaultSpec(key);
    const row = byKey.get(key);
    let length: number | null = null;
    if (row && canDecrypt) {
      try {
        length = decryptValue(row.value_encrypted).length;
      } catch {
        length = null;
      }
    }
    return {
      key,
      isSecret: spec?.isSecret ?? row?.is_secret ?? true,
      group: spec?.group ?? 'skill',
      description: spec?.description ?? '',
      configured: Boolean(row) && length !== null,
      length,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

function canDecryptMasterKey(): boolean {
  try {
    return getMasterKey() !== null;
  } catch {
    return false;
  }
}

export interface UpsertGlobalDefaultInput {
  key: string;
  value: string;
  /** 审计用：谁改的（超管 username / sub）。 */
  updatedBy: string;
}

export interface UpsertGlobalDefaultResult {
  key: string;
  isSecret: boolean;
  length: number;
  updatedAt: string;
  updatedBy: string;
}

/** 写入/更新一个默认项。只写不回显：返回值里没有任何明文。 */
export async function upsertGlobalDefault(
  pool: pg.Pool,
  input: UpsertGlobalDefaultInput,
): Promise<UpsertGlobalDefaultResult> {
  const key = validateGlobalDefaultKey(input.key);
  const value = validateGlobalDefaultValue(key, input.value);
  const spec = getGlobalDefaultSpec(key) as GlobalDefaultSpec;
  const encrypted = encryptValue(value);

  const { rows } = await pool.query(
    `INSERT INTO global_defaults (key, value_encrypted, is_secret, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value_encrypted = EXCLUDED.value_encrypted,
           is_secret       = EXCLUDED.is_secret,
           updated_by      = EXCLUDED.updated_by,
           updated_at      = NOW()
     RETURNING updated_at, updated_by`,
    [key, encrypted, spec.isSecret, input.updatedBy],
  );

  return {
    key,
    isSecret: spec.isSecret,
    length: value.length,
    updatedAt: rows[0]?.updated_at ?? new Date().toISOString(),
    updatedBy: rows[0]?.updated_by ?? input.updatedBy,
  };
}

// ── 存量下发：dryRun 报告 + 人工确认 apply ─────────────────────────────────

export type GlobalDefaultTenantState = 'needs_update' | 'up_to_date' | 'skipped';

export interface GlobalDefaultTargetTenant {
  tenantId: string;
  companyName: string | null;
  status: string;
  k8sNamespace: string | null;
  hasOwnAgent: boolean;
}

/** 存量下发对象：未销毁租户（含无独立 agent 的，逐个标注 skipped 原因）。 */
export async function listGlobalDefaultTargets(
  pool: pg.Pool,
  tenantIds?: string[],
): Promise<GlobalDefaultTargetTenant[]> {
  const ids = Array.isArray(tenantIds) && tenantIds.length
    ? tenantIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
    : null;
  const { rows } = await pool.query<{
    tenant_id: string;
    company_name: string | null;
    status: string;
    k8s_namespace: string | null;
    agent_endpoint: string | null;
  }>(
    `SELECT tenant_id, company_name, status, k8s_namespace, agent_endpoint
       FROM tenants
      WHERE status <> 'destroyed'
        AND ($1::text[] IS NULL OR tenant_id = ANY($1::text[]))
      ORDER BY created_at, tenant_id`,
    [ids],
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    companyName: r.company_name,
    status: r.status,
    k8sNamespace: r.k8s_namespace,
    hasOwnAgent: Boolean(r.k8s_namespace) && !r.agent_endpoint,
  }));
}

export interface GlobalDefaultDryRunEntry {
  tenantId: string;
  companyName: string | null;
  state: GlobalDefaultTenantState;
  /** 需要更新的 key（只给 key 名，不含值）。 */
  changedKeys: string[];
  /** state=up_to_date 时表示已是最新；skipped 时为跳过原因。 */
  detail?: string;
}

export interface GlobalDefaultDryRunReport {
  dryRun: true;
  keys: string[];
  summary: {
    total: number;
    needsUpdate: number;
    upToDate: number;
    skipped: number;
    /** 本次默认值里没有值的 key（下发时这些 key 会被跳过的依据）。 */
    unconfiguredKeys: string[];
  };
  tenants: GlobalDefaultDryRunEntry[];
}

/**
 * dryRun：**不写任何东西**，只算「改了哪些 key 会影响谁」。
 * 判定口径 = 目标租户当前 skill-env Secret 的 .env 里这些 key 的值是否与
 * global_defaults 现值一致（不一致或缺失 = needs_update）。
 * 报告里只有 key 名与状态，**不含任何明文值**。
 */
export async function dryRunGlobalDefaults(
  pool: pg.Pool,
  config: ProvisioningConfig,
  options: { tenantIds?: string[]; keys?: string[] } = {},
): Promise<GlobalDefaultDryRunReport> {
  const keys = (options.keys?.length ? options.keys : GLOBAL_DEFAULT_KEYS).map((k) => validateGlobalDefaultKey(k));
  const defaults = await readGlobalDefaults(pool);
  const unconfiguredKeys = keys.filter((k) => !defaults.values[k]);
  const targets = await listGlobalDefaultTargets(pool, options.tenantIds);

  const tenants: GlobalDefaultDryRunEntry[] = [];
  for (const t of targets) {
    if (!t.hasOwnAgent) {
      tenants.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        state: 'skipped',
        changedKeys: [],
        detail: '该租户无独立 agent（外部托管或未开通），不参与下发',
      });
      continue;
    }
    if (config.k8sDryRun) {
      tenants.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        state: 'skipped',
        changedKeys: [],
        detail: '服务处于 K8S_DRY_RUN，无法读取租户 Secret 计算差异',
      });
      continue;
    }

    let current: Record<string, string> = {};
    try {
      const secret = await getSecret(t.k8sNamespace as string, SKILL_ENV_SECRET_NAME);
      const encoded = secret?.data?.['.env'];
      if (typeof encoded === 'string' && encoded.length) {
        current = parseEnvFile(Buffer.from(encoded, 'base64').toString('utf8'));
      }
    } catch (err: unknown) {
      tenants.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        state: 'skipped',
        changedKeys: [],
        detail: `读取 skill-env Secret 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const changedKeys = keys.filter((k) => {
      const next = defaults.values[k];
      if (next === undefined) return false; // 默认值缺失 → 无法下发该 key
      return current[k] !== next;
    });
    tenants.push({
      tenantId: t.tenantId,
      companyName: t.companyName,
      state: changedKeys.length ? 'needs_update' : 'up_to_date',
      changedKeys,
      detail: changedKeys.length ? '需要更新' : '已是最新',
    });
  }

  return {
    dryRun: true,
    keys,
    summary: {
      total: tenants.length,
      needsUpdate: tenants.filter((t) => t.state === 'needs_update').length,
      upToDate: tenants.filter((t) => t.state === 'up_to_date').length,
      skipped: tenants.filter((t) => t.state === 'skipped').length,
      unconfiguredKeys,
    },
    tenants,
  };
}

export interface GlobalDefaultApplyReceipt {  tenantId: string;
  companyName: string | null;
  ok: boolean;
  rollout?: SkillEnvRollout;
  error?: string;
}

export interface GlobalDefaultApplyResult {
  /** 本次实际尝试下发的租户数。 */
  attempted: number;
  succeeded: number;
  failed: number;
  receipts: GlobalDefaultApplyReceipt[];
}

/**
 * 下发（**必须人工触发**：只在 POST /v1/admin/global-defaults/apply 里调用）。
 * 逐个租户重写 skill-env Secret（内容 = runtime_configs + global_defaults 合并
 * 后的 .env，与新建租户一致），每个租户给一条回执；失败不中断其余租户。
 */
export async function applyGlobalDefaults(
  pool: pg.Pool,
  config: ProvisioningConfig,
  options: { tenantIds?: string[] } = {},
): Promise<GlobalDefaultApplyResult> {
  const targets = await listGlobalDefaultTargets(pool, options.tenantIds);
  const receipts: GlobalDefaultApplyReceipt[] = [];

  for (const t of targets) {
    if (!t.hasOwnAgent) {
      receipts.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        ok: false,
        error: '该租户无独立 agent（外部托管或未开通），不支持下发',
      });
      continue;
    }
    try {
      const res = await pushTenantSkillEnv(pool, config, t.tenantId);
      receipts.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        ok: true,
        rollout: res.rollout,
      });
    } catch (err: unknown) {
      receipts.push({
        tenantId: t.tenantId,
        companyName: t.companyName,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = receipts.filter((r) => r.ok).length;
  return { attempted: receipts.length, succeeded, failed: receipts.length - succeeded, receipts };
}
