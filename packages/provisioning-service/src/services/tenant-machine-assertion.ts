import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { getSecret } from './k8s-client.js';

export const TENANT_MACHINE_ASSERTION_VERSION = 'v1';
export const TENANT_MACHINE_ASSERTION_ACTION = 'bind-existing-waba';
export const TENANT_MACHINE_ASSERTION_AUDIENCE = 'whatsapp-bridge';

const SUPPLIER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const WABA_ID_PATTERN = /^[1-9]\d{4,31}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,86}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TenantMachineAssertionInput {
  supplierId: string;
  wabaId: string;
  assertion: {
    version: typeof TENANT_MACHINE_ASSERTION_VERSION;
    issuedAt: number;
    nonce: string;
    signature: string;
  };
}

interface TenantMachineRow {
  tenant_id: string;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
}

export class TenantMachineAssertionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantMachineAssertionError';
  }
}

export function tenantMachineAssertionSigningInput(input: TenantMachineAssertionInput): string {
  return [
    'dealclaw-tenant-machine-assertion',
    input.assertion.version,
    TENANT_MACHINE_ASSERTION_ACTION,
    TENANT_MACHINE_ASSERTION_AUDIENCE,
    input.supplierId,
    input.wabaId,
    String(input.assertion.issuedAt),
    input.assertion.nonce,
  ].join('\n');
}

export function normalizeTenantMachineAssertionInput(input: unknown): TenantMachineAssertionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['supplierId', 'wabaId', 'assertion'].includes(key))) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  const supplierId = typeof body.supplierId === 'string' ? body.supplierId.trim() : '';
  const wabaId = typeof body.wabaId === 'string' ? body.wabaId.trim() : '';
  if (!SUPPLIER_ID_PATTERN.test(supplierId) || !WABA_ID_PATTERN.test(wabaId)) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  if (!body.assertion || typeof body.assertion !== 'object' || Array.isArray(body.assertion)) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  const assertion = body.assertion as Record<string, unknown>;
  if (Object.keys(assertion).some((key) => !['version', 'issuedAt', 'nonce', 'signature'].includes(key))) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  if (
    assertion.version !== TENANT_MACHINE_ASSERTION_VERSION ||
    !Number.isSafeInteger(assertion.issuedAt) ||
    !NONCE_PATTERN.test(typeof assertion.nonce === 'string' ? assertion.nonce : '') ||
    !SIGNATURE_PATTERN.test(typeof assertion.signature === 'string' ? assertion.signature : '')
  ) {
    throw new TenantMachineAssertionError(400, 'INVALID_ASSERTION', 'invalid tenant-machine assertion');
  }
  return {
    supplierId,
    wabaId,
    assertion: {
      version: TENANT_MACHINE_ASSERTION_VERSION,
      issuedAt: assertion.issuedAt as number,
      nonce: assertion.nonce as string,
      signature: assertion.signature as string,
    },
  };
}

type MachineTokenLoader = (namespace: string, tenantId: string) => Promise<string | null>;

async function loadGatewayToken(namespace: string, tenantId: string): Promise<string | null> {
  const secret = await getSecret(namespace, `dealclaw-agent-config-${tenantId}`);
  const encoded = secret?.data?.OPENCLAW_GATEWAY_TOKEN;
  if (!encoded) return null;
  try {
    const token = Buffer.from(encoded, 'base64').toString('utf8');
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Verify a tenant-machine assertion against the server-created gateway token
 * in that tenant's K8s Secret. The token is never returned by this service.
 */
export async function verifyTenantMachineAssertion(
  pool: Pick<pg.Pool, 'query'>,
  rawInput: unknown,
  tokenLoader: MachineTokenLoader = loadGatewayToken,
): Promise<boolean> {
  const input = normalizeTenantMachineAssertionInput(rawInput);
  const { rows } = await pool.query<TenantMachineRow>(
    `SELECT tenant_id, k8s_namespace, agent_endpoint
       FROM tenants
      WHERE mio_cdp_supplier_id = $1 AND status <> 'destroyed'`,
    [input.supplierId],
  );
  if (rows.length !== 1 || !rows[0].k8s_namespace || rows[0].agent_endpoint) return false;

  let token: string | null;
  try {
    token = await tokenLoader(rows[0].k8s_namespace, rows[0].tenant_id);
  } catch {
    throw new TenantMachineAssertionError(
      503,
      'ASSERTION_VERIFIER_UNAVAILABLE',
      'tenant-machine assertion verifier unavailable',
    );
  }
  if (!token) return false;

  const expected = createHmac('sha256', token)
    .update(tenantMachineAssertionSigningInput(input))
    .digest();
  const provided = Buffer.from(input.assertion.signature, 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
