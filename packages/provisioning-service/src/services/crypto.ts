/**
 * Envelope encryption for per-tenant runtime config values (provider keys etc).
 *
 * Values are encrypted with AES-256-GCM before being stored in the
 * runtime_configs table. The 256-bit master key comes from the
 * RUNTIME_CONFIG_KEY env var (64 hex chars or base64). When the key is not
 * configured every encrypt/decrypt fails closed — plaintext is never written
 * to the database.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

/** Error thrown when RUNTIME_CONFIG_KEY is missing or malformed. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/** Resolve the 32-byte master key from RUNTIME_CONFIG_KEY, or null if unset. */
export function getMasterKey(): Buffer | null {
  const raw = process.env.RUNTIME_CONFIG_KEY;
  if (!raw) return null;

  // 64 hex chars → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // base64 fallback — must decode to exactly 32 bytes
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    // fall through
  }
  throw new MasterKeyError(
    'RUNTIME_CONFIG_KEY is malformed — expected 64 hex chars or base64 encoding of 32 bytes',
  );
}

function requireKey(): Buffer {
  const key = getMasterKey();
  if (!key) {
    throw new MasterKeyError('RUNTIME_CONFIG_KEY is not configured');
  }
  return key;
}

/** Encrypt a plaintext value → "enc:v1:<iv>:<tag>:<ciphertext>" (base64 parts). */
export function encryptValue(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypt a stored value. Throws MasterKeyError / Error on failure. */
export function decryptValue(stored: string): string {
  if (!isEncrypted(stored)) {
    throw new Error('Value is not in encrypted format');
  }
  const key = requireKey();
  const [, , ivB64, tagB64, dataB64] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX) && stored.split(':').length === 5;
}

/** Mask a sensitive value for API responses (never returns the full value). */
export function maskValue(value: string): string {
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}•••${value.slice(-4)}`;
}
