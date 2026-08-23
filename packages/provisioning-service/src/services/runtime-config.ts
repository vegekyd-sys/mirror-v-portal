/**
 * Per-tenant runtime configuration management.
 *
 * Admin-dashboard maintains key/value pairs (provider credentials etc.) in
 * the runtime_configs table: global defaults plus optional per-tenant
 * overrides. When a tenant is provisioned, the merged result is materialized
 * as the `tenant-config` Secret in the tenant's own namespace — the Secret
 * that the dealclaw-agent Deployment references via envFrom.
 */

import type pg from 'pg';
import { encryptValue, decryptValue } from './crypto.js';

/** Config keys must be valid environment variable names (envFrom constraint). */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_LENGTH = 8192;

/** Known runtime keys (from docs/openclaw-runtime.md). Custom keys are allowed too. */
export const PRESET_RUNTIME_KEYS: Array<{ key: string; description: string; isSecret: boolean }> = [
  { key: 'DEEPSEEK_API_KEY', description: 'DeepSeek 模型 API Key（必需，缺失时 agent 拒绝启动；仅开通/重启时经 envFrom 注入）', isSecret: true },
  { key: 'APIFY_TOKEN', description: 'Apify 集成 Token（skill 经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'APIFY_API_KEY', description: 'Apify API Key（skill 经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'MIO_CDP_APP_KEY', description: 'Mio CDP AppKey（skill 经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'MIO_CDP_APP_SECRET', description: 'Mio CDP AppSecret（skill 经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'APOLLO_API_KEY', description: 'Apollo.io 获客数据 API Key（skill 经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'WEBHOOK_ADMIN_TOKEN', description: '邮箱绑定等 skill 的 X-Admin-Token（经 work/mio-api/.env 读取，改动免重启）', isSecret: true },
  { key: 'UN_COMTRADE_API_KEY', description: 'UN Comtrade 数据 API Key（市场报告 skill，经 .env 读取）', isSecret: true },
  { key: 'WTO_API_KEY', description: 'WTO 数据 API Key（市场报告 skill，经 .env 读取）', isSecret: true },
];

export interface RuntimeConfigInput {
  /** null = global default scope */
  tenantId: string | null;
  key: string;
  value: string;
  isSecret?: boolean;
  description?: string;
}

export interface RuntimeConfigRow {
  key: string;
  tenantId: string | null;
  isSecret: boolean;
  description: string | null;
  updatedAt: string;
  /** Masked or decrypted-for-display value (never the raw encrypted blob). */
  displayValue: string;
}

export function validateConfigKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error(`Invalid config key "${String(key)}" — must match ${KEY_PATTERN} (valid env var name)`);
  }
  return key;
}

export function validateConfigValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Config value must be a non-empty string (use DELETE to remove a key)');
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(`Config value too long (max ${MAX_VALUE_LENGTH} chars)`);
  }
  return value;
}

/** Merge global defaults with tenant overrides → key → decrypted value. */
export function mergeConfigRows(
  globalRows: Array<{ config_key: string; encrypted_value: string }>,
  tenantRows: Array<{ config_key: string; encrypted_value: string }>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const row of [...globalRows, ...tenantRows]) {
    merged[row.config_key] = decryptValue(row.encrypted_value);
  }
  return merged;
}

/**
 * Resolve the effective runtime config for a tenant (global defaults merged
 * with the tenant's overrides), fully decrypted. Used at provisioning time to
 * build the tenant-config Secret.
 */
export async function resolveTenantConfig(
  pool: pg.Pool,
  tenantId: string,
): Promise<Record<string, string>> {
  const { rows: globalRows } = await pool.query(
    'SELECT config_key, encrypted_value FROM runtime_configs WHERE tenant_id IS NULL',
  );
  const { rows: tenantRows } = await pool.query(
    'SELECT config_key, encrypted_value FROM runtime_configs WHERE tenant_id = $1',
    [tenantId],
  );
  return mergeConfigRows(globalRows, tenantRows);
}

/** Upsert a config entry in the given scope (global when tenantId is null). */
export async function upsertRuntimeConfig(pool: pg.Pool, input: RuntimeConfigInput): Promise<void> {
  const key = validateConfigKey(input.key);
  const value = validateConfigValue(input.value);
  const encrypted = encryptValue(value);
  const isSecret = input.isSecret !== false;
  const description = input.description?.slice(0, 255) ?? null;

  if (input.tenantId === null) {
    await pool.query(
      `INSERT INTO runtime_configs (tenant_id, config_key, encrypted_value, is_secret, description, updated_at)
       VALUES (NULL, $1, $2, $3, $4, NOW())
       ON CONFLICT (config_key) WHERE tenant_id IS NULL
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                     is_secret = EXCLUDED.is_secret,
                     description = EXCLUDED.description,
                     updated_at = NOW()`,
      [key, encrypted, isSecret, description],
    );
  } else {
    await pool.query(
      `INSERT INTO runtime_configs (tenant_id, config_key, encrypted_value, is_secret, description, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tenant_id, config_key) WHERE tenant_id IS NOT NULL
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                     is_secret = EXCLUDED.is_secret,
                     description = EXCLUDED.description,
                     updated_at = NOW()`,
      [input.tenantId, key, encrypted, isSecret, description],
    );
  }
}

/** Delete a config entry in the given scope. Returns number of deleted rows. */
export async function deleteRuntimeConfig(
  pool: pg.Pool,
  tenantId: string | null,
  key: string,
): Promise<number> {
  const validKey = validateConfigKey(key);
  const result = tenantId === null
    ? await pool.query('DELETE FROM runtime_configs WHERE tenant_id IS NULL AND config_key = $1', [validKey])
    : await pool.query('DELETE FROM runtime_configs WHERE tenant_id = $1 AND config_key = $2', [tenantId, validKey]);
  return result.rowCount ?? 0;
}

/**
 * List config entries for display. Secret values are masked; non-secret
 * values are decrypted and shown (they were explicitly marked non-secret).
 * When the master key is unavailable everything is masked and
 * keyConfigured=false is signalled by the caller.
 */
export async function listRuntimeConfigs(
  pool: pg.Pool,
  tenantId: string | null,
  canDecrypt: boolean,
): Promise<RuntimeConfigRow[]> {
  const { rows } = tenantId === null
    ? await pool.query(
        'SELECT config_key, tenant_id, encrypted_value, is_secret, description, updated_at FROM runtime_configs WHERE tenant_id IS NULL ORDER BY config_key',
      )
    : await pool.query(
        'SELECT config_key, tenant_id, encrypted_value, is_secret, description, updated_at FROM runtime_configs WHERE tenant_id = $1 ORDER BY config_key',
        [tenantId],
      );

  return rows.map((r: any) => {
    let displayValue = '••••••••';
    if (!r.is_secret && canDecrypt) {
      try {
        displayValue = decryptValue(r.encrypted_value);
      } catch {
        displayValue = '(解密失败)';
      }
    }
    return {
      key: r.config_key,
      tenantId: r.tenant_id ?? null,
      isSecret: r.is_secret,
      description: r.description ?? null,
      updatedAt: r.updated_at,
      displayValue,
    };
  });
}
