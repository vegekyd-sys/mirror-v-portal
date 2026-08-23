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

/**
 * Preset key suggestions for the admin UI (purely informational chips).
 * Intentionally empty: admins may configure ANY key:value pair — key names
 * only need to be valid env-var names (KEY_PATTERN). DEEPSEEK_API_KEY remains
 * envFrom-only and is not managed through the .env pipeline.
 */
export const PRESET_RUNTIME_KEYS: Array<{ key: string; description: string; isSecret: boolean }> = [];

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
