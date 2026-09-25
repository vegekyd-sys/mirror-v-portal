/**
 * Admin Auth Service — JWT-based token login for admin dashboard.
 *
 * Flow:
 *   1. Admin receives a login token (32-char hex, one-time setup)
 *   2. POST /v1/admin/auth/login { token } → returns JWT session token
 *   3. All admin API calls include Authorization: Bearer <jwt>
 *   4. JWT valid for 24h, contains userId + username + role
 *
 * Token management:
 *   - Login tokens stored as SHA-256 hash in admin_users.token_hash
 *   - Session JWTs signed with HMAC-SHA256 using ADMIN_JWT_SECRET
 *   - Active admin users can create tokens for new users
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || randomBytes(32).toString('hex');
const TOKEN_BYTES = 32; // 256-bit login tokens
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'operator';
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface JwtPayload {
  sub: string;       // user id
  username: string;
  displayName: string;
  role: string;
  iat: number;
  exp: number;
}

// ── Token generation / verification ──

/** Generate a new login token (32-char hex). Only stored as hash. */
export function generateLoginToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Hash a login token for storage */
function hashToken(token: string): string {
  return createHmac('sha256', JWT_SECRET).update(token).digest('hex');
}

/** Sign a JWT session token */
function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + SESSION_DURATION_MS / 1000 };

  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const toSign = `${enc(header)}.${enc(fullPayload)}`;
  const sig = createHmac('sha256', JWT_SECRET).update(toSign).digest('base64url');

  return `${toSign}.${sig}`;
}

/** Verify and decode a JWT session token. Returns payload or null. */
export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, sigB64] = parts;
    const toVerify = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac('sha256', JWT_SECRET).update(toVerify).digest('base64url');

    const actual = Uint8Array.from(Buffer.from(sigB64));
    const expected = Uint8Array.from(Buffer.from(expectedSig));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const payload: JwtPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Auth operations ──

/** Login: verify token, return JWT */
export async function login(token: string): Promise<{ jwt: string; user: AdminUser } | null> {
  const tokenHash = hashToken(token);

  const { rows } = await query(
    `SELECT id, username, display_name, role, is_active, created_at, last_login_at
     FROM admin_users
     WHERE token_hash = $1 AND is_active = true`,
    [tokenHash]
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  const user: AdminUser = {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    isActive: r.is_active,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };

  // Update last_login_at
  await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const jwt = signJwt({
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  });

  return { jwt, user };
}

/** Create a new admin user and return their login token */
export async function createAdminUser(params: {
  username: string;
  displayName: string;
  role?: 'admin' | 'operator';
  createdBy: string;
}): Promise<{ user: AdminUser; loginToken: string } | null> {
  const loginToken = generateLoginToken();
  const tokenHash = hashToken(loginToken);
  const id = `adm_${randomBytes(8).toString('hex')}`;

  try {
    const { rows } = await query(
      `INSERT INTO admin_users (id, username, display_name, token_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, display_name, role, is_active, created_at, last_login_at`,
      [id, params.username, params.displayName, tokenHash, params.role ?? 'admin', params.createdBy]
    );

    const r = rows[0];
    return {
      user: {
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        isActive: r.is_active,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      },
      loginToken,
    };
  } catch (err: any) {
    if (err.code === '23505') {
      // unique violation — username or token_hash collision
      console.error(`Admin user creation failed: ${err.detail}`);
      return null;
    }
    throw err;
  }
}

/** List all admin users (excludes token hashes) */
export async function listAdminUsers(): Promise<AdminUser[]> {
  const { rows } = await query(
    `SELECT id, username, display_name, role, is_active, created_at, last_login_at
     FROM admin_users
     ORDER BY created_at DESC`
  );
  return rows.map((r: any) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    isActive: r.is_active,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));
}

/** Regenerate a user's login token (invalidates old one) */
export async function regenerateToken(
  userId: string,
  requestedBy: string
): Promise<{ loginToken: string } | null> {
  const loginToken = generateLoginToken();
  const tokenHash = hashToken(loginToken);

  const { rowCount } = await query(
    `UPDATE admin_users SET token_hash = $1 WHERE id = $2 AND is_active = true`,
    [tokenHash, userId]
  );

  if ((rowCount ?? 0) === 0) return null;
  return { loginToken };
}

/** Deactivate a user (soft delete — can re-activate) */
export async function deactivateUser(userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE admin_users SET is_active = false WHERE id = $1`,
    [userId]
  );
  return (rowCount ?? 0) > 0;
}

/** Activate a previously deactivated user */
export async function activateUser(userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE admin_users SET is_active = true WHERE id = $1`,
    [userId]
  );
  return (rowCount ?? 0) > 0;
}

/** Seed initial admin user (admin/管理员) if table is empty */
export async function seedInitialAdmin(): Promise<{ loginToken: string } | null> {
  const { rows } = await query('SELECT COUNT(*) as cnt FROM admin_users');
  if (Number(rows[0].cnt) > 0) return null;

  const result = await createAdminUser({
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    createdBy: 'system',
  });

  if (!result) return null;
  return { loginToken: result.loginToken };
}
