/**
 * External API keys — authenticate third-party (Mio) access to token
 * accounting endpoints (e.g. /v1/llm-usage/supplier-summary).
 *
 * Only the SHA-256 hash is stored; the plaintext is returned exactly once
 * on create. A key may be scoped to a single supplier (NULL = all suppliers).
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

const KEY_PREFIX = 'dlk_';

export interface ExternalApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  supplierId: string | null;
  status: string;
  createdAt: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export async function createExternalApiKey(
  pool: pg.Pool,
  params: { name: string; supplierId: string | null; createdBy?: string },
): Promise<{ key: string; id: string }> {
  const key = generateKey();
  const id = randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO external_api_keys (id, name, key_hash, key_prefix, supplier_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, params.name, hashKey(key), key.slice(0, 12), params.supplierId, params.createdBy ?? null],
  );
  return { key, id };
}

export async function listExternalApiKeys(pool: pg.Pool): Promise<ExternalApiKeyRow[]> {
  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, supplier_id, status, created_at
       FROM external_api_keys
      ORDER BY created_at DESC`,
  );
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    supplierId: r.supplier_id,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function revokeExternalApiKey(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE external_api_keys SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Validate a bearer key → active key record (with supplier scope), or null. */
export async function findValidExternalApiKey(
  pool: pg.Pool,
  key: string,
): Promise<{ id: string; supplierId: string | null } | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const { rows } = await pool.query(
    `SELECT id, supplier_id FROM external_api_keys
      WHERE key_hash = $1 AND status = 'active'`,
    [hashKey(key)],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, supplierId: rows[0].supplier_id };
}
