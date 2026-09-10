/**
 * Chat API keys — authenticate third-party HTTP access to the agent
 * conversation endpoint (POST /api/external/chat).
 *
 * Scoped per tenant (one enterprise = one tenant); optionally bound to a
 * single agent. Unlike external-api-keys.ts (read-only, supplier-scoped),
 * these keys authorize WRITE access — triggering agent execution + LLM
 * calls that bill the tenant's credit account via llm-proxy.
 *
 * Storage mirrors external-api-keys: only the SHA-256 hash is stored; the
 * plaintext is returned exactly once on create. Key prefix `dlck_` (vs the
 * read-only `dlk_`) lets log/audit lines distinguish a chat key at a glance.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

const KEY_PREFIX = 'dlck_';

export interface ChatApiKeyRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  name: string;
  keyPrefix: string;
  status: string;
  ipAllowlist: string[] | null;
  rateLimitRpm: number;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** A validated key — what the auth middleware needs to authorize a request. */
export interface ValidChatApiKey {
  id: string;
  tenantId: string;
  agentId: string | null;
  ipAllowlist: string[] | null;
  rateLimitRpm: number;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export async function createChatApiKey(
  pool: pg.Pool,
  params: {
    tenantId: string;
    agentId?: string | null;
    name: string;
    ipAllowlist?: string[] | null;
    rateLimitRpm?: number;
    createdBy?: string;
  },
): Promise<{ key: string; id: string }> {
  const key = generateKey();
  const id = randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO chat_api_keys
       (id, tenant_id, agent_id, name, key_hash, key_prefix, ip_allowlist, rate_limit_rpm, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      params.tenantId,
      params.agentId ?? null,
      params.name,
      hashKey(key),
      key.slice(0, 12),
      params.ipAllowlist ? JSON.stringify(params.ipAllowlist) : null,
      params.rateLimitRpm ?? 60,
      params.createdBy ?? null,
    ],
  );
  return { key, id };
}

export async function listChatApiKeys(
  pool: pg.Pool,
  tenantId?: string,
): Promise<ChatApiKeyRow[]> {
  const sql = tenantId
    ? `SELECT id, tenant_id, agent_id, name, key_prefix, status, ip_allowlist,
              rate_limit_rpm, created_at, revoked_at, last_used_at
         FROM chat_api_keys
        WHERE tenant_id = $1
        ORDER BY created_at DESC`
    : `SELECT id, tenant_id, agent_id, name, key_prefix, status, ip_allowlist,
              rate_limit_rpm, created_at, revoked_at, last_used_at
         FROM chat_api_keys
        ORDER BY created_at DESC`;
  const { rows } = tenantId
    ? await pool.query(sql, [tenantId])
    : await pool.query(sql);
  return rows.map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    status: r.status,
    ipAllowlist: Array.isArray(r.ip_allowlist) ? r.ip_allowlist : null,
    rateLimitRpm: r.rate_limit_rpm,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function revokeChatApiKey(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE chat_api_keys SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Validate a Bearer key → active key record, or null. */
export async function findValidChatApiKey(
  pool: pg.Pool,
  key: string,
): Promise<ValidChatApiKey | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const { rows } = await pool.query(
    `SELECT id, tenant_id, agent_id, ip_allowlist, rate_limit_rpm
       FROM chat_api_keys
      WHERE key_hash = $1 AND status = 'active'`,
    [hashKey(key)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    ipAllowlist: Array.isArray(r.ip_allowlist) ? r.ip_allowlist : null,
    rateLimitRpm: r.rate_limit_rpm,
  };
}

/** Refresh last_used_at — fire-and-forget, never blocks the request. */
export function touchChatApiKeyLastUsed(pool: pg.Pool, id: string): void {
  pool
    .query('UPDATE chat_api_keys SET last_used_at = NOW() WHERE id = $1', [id])
    .catch(() => {
      /* last_used_at is advisory only */
    });
}
