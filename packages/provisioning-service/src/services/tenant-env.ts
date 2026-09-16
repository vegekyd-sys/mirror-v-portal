/**
 * 租户生效 env 的唯一合并口径。
 *
 * 一个租户最终写进 `skill-env` Secret（.env）的 key 有三个来源，优先级从低到高：
 *   1. runtime_configs 全局默认行（管理员在「运行时配置」页维护）
 *   2. global_defaults 行（「默认配置」页维护：全 Agent 共用的 4 个共享 key
 *      + 主群规则等）
 *   3. runtime_configs 租户覆盖行（该租户单独覆盖）
 *
 * 建租户（tenant-create → provisioning.buildEnvFileContent）与 skill-env 推送
 * （pushTenantSkillEnv / updateSkillEnvSecret）都走这里，保证「新建继承」与
 * 「存量下发」写出来的 .env 完全一致。
 *
 * 缺省不阻断：global_defaults 里缺 key 时不会报错，只是把 key 记进
 * missingDefaults，由调用方标记「未就绪」。
 *
 * 本模块不依赖 global-defaults.ts（避免循环依赖）：它只做 DB 读取 + 解密 +
 * 合并。目录/catalog 与审计在 global-defaults.ts。
 */

import type pg from 'pg';
import { mergeConfigRows } from './runtime-config.js';
import { decryptValue } from './crypto.js';

/** runtime_configs 的最小投影（加密值 + key）。 */
interface RuntimeConfigScope {
  config_key: string;
  encrypted_value: string;
}

/**
 * 「默认配置」页必须配齐的共享 key（全 Agent 同值）。缺任一项时租户 env
 * 标记未就绪（不阻断开通）。
 */
export const REQUIRED_TENANT_DEFAULT_KEYS: string[] = [
  'RESEND_API_KEY',
  'WEBHOOK_ADMIN_TOKEN',
  'UN_COMTRADE_API_KEY',
  'WTO_API_KEY',
];

export interface GlobalDefaultsReadResult {
  /** 解密后的 key → value（解密失败的 key 不进 values）。 */
  values: Record<string, string>;
  /** 存在但当前主密钥解不开的 key（通常 RUNTIME_CONFIG_KEY 变更过）。 */
  undecryptable: string[];
}

/**
 * 读取 global_defaults 并解密。主密钥不可用（RUNTIME_CONFIG_KEY 未配置）或
 * 某个值解密失败时，只跳过该值并记录，不抛错——保证建租户/推送不被默认配置
 * 读取问题整体阻断。
 */
export async function readGlobalDefaults(pool: pg.Pool): Promise<GlobalDefaultsReadResult> {
  const { rows } = await pool.query<{ key: string; value_encrypted: string }>(
    'SELECT key, value_encrypted FROM global_defaults ORDER BY key',
  );
  const values: Record<string, string> = {};
  const undecryptable: string[] = [];
  for (const row of rows) {
    try {
      values[row.key] = decryptValue(row.value_encrypted);
    } catch {
      undecryptable.push(row.key);
    }
  }
  return { values, undecryptable };
}

export interface EffectiveTenantEnv {
  /** 合并后的租户 env（未过滤 LLM_PROVIDERS / 弃用 key —— 由 buildEnvFileContent 处理）。 */
  env: Record<string, string>;
  /** REQUIRED_TENANT_DEFAULT_KEYS 里在本租户 env 中为空/缺失的 key。 */
  missingDefaults: string[];
  /** global_defaults 中当前无法解密的 key。 */
  undecryptableDefaults: string[];
}

function splitRuntimeConfigRows(
  rows: Array<{ config_key: string; encrypted_value: string }>,
): Record<string, string> {
  return mergeConfigRows(rows, []);
}

/**
 * 解析一个租户的生效 env：runtime_configs 全局行 → global_defaults →
 * runtime_configs 租户覆盖行（后者覆盖前者）。
 */
export async function resolveEffectiveTenantEnv(
  pool: pg.Pool,
  tenantId: string,
  requiredKeys: string[] = REQUIRED_TENANT_DEFAULT_KEYS,
): Promise<EffectiveTenantEnv> {
  const { rows: globalRows } = await pool.query<RuntimeConfigScope>(
    'SELECT config_key, encrypted_value FROM runtime_configs WHERE tenant_id IS NULL',
  );
  const { rows: tenantRows } = await pool.query<RuntimeConfigScope>(
    'SELECT config_key, encrypted_value FROM runtime_configs WHERE tenant_id = $1',
    [tenantId],
  );
  const defaults = await readGlobalDefaults(pool);

  const env: Record<string, string> = {
    ...splitRuntimeConfigRows(globalRows),
    ...defaults.values,
    ...mergeConfigRows([], tenantRows),
  };

  const missingDefaults = requiredKeys.filter((k) => !env[k]);
  return { env, missingDefaults, undecryptableDefaults: defaults.undecryptable };
}

/** `.env`（KEY=value 行）解析：忽略空行与注释，值为第一段 `=` 之后的内容。 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}
