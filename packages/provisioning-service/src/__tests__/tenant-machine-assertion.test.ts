import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createTenantMachineAssertionRoutes } from '../routes/tenant-machine-assertions.js';
import {
  TENANT_MACHINE_ASSERTION_VERSION,
  tenantMachineAssertionSigningInput,
  verifyTenantMachineAssertion,
  type TenantMachineAssertionInput,
} from '../services/tenant-machine-assertion.js';

const TOKEN = 'a'.repeat(64);

function signedInput(overrides: Partial<TenantMachineAssertionInput> = {}): TenantMachineAssertionInput {
  const base: TenantMachineAssertionInput = {
    supplierId: 'supplier-123',
    wabaId: '12345678901',
    assertion: {
      version: TENANT_MACHINE_ASSERTION_VERSION,
      issuedAt: 1_789_000_000,
      nonce: 'nonce_abcdefghijklmnopqrstuvwxyz',
      signature: 'A'.repeat(43),
    },
  };
  const input = {
    ...base,
    ...overrides,
    assertion: { ...base.assertion, ...(overrides.assertion ?? {}) },
  };
  input.assertion.signature = createHmac('sha256', TOKEN)
    .update(tenantMachineAssertionSigningInput(input))
    .digest('base64url');
  return input;
}

function poolFor(rows: Array<Record<string, unknown>>) {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  return {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows };
    },
  };
}

describe('tenant-machine assertion verifier', () => {
  it('maps the exact supplier to one live tenant and verifies its K8s machine token', async () => {
    const pool = poolFor([
      { tenant_id: 'tenant-a', k8s_namespace: 'dealclaw-tenant-a', agent_endpoint: null },
    ]);
    const loads: string[][] = [];
    const valid = await verifyTenantMachineAssertion(pool as any, signedInput(), async (...args) => {
      loads.push(args);
      return TOKEN;
    });
    expect(valid).toBe(true);
    expect(pool.queries[0].params).toEqual(['supplier-123']);
    expect(loads).toEqual([['dealclaw-tenant-a', 'tenant-a']]);
  });

  it('exposes only a service-token-authenticated verifier, not an admin/user-token endpoint', async () => {
    const savedService = process.env.PROVISIONING_API_TOKEN;
    const savedJwt = process.env.ADMIN_JWT_SECRET;
    process.env.PROVISIONING_API_TOKEN = 'service-only-token';
    process.env.ADMIN_JWT_SECRET = 'admin-jwt-secret';
    try {
      const app = express();
      app.use(express.json());
      app.use(
        createTenantMachineAssertionRoutes(
          poolFor([]) as any,
          createAuthMiddleware('PROVISIONING_API_TOKEN'),
        ),
      );

      expect((await request(app).post('/v1/internal/tenant-machine-assertions/verify-whatsapp-binding').send({})).status)
        .toBe(401);

      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: 4_102_444_800 })).toString('base64url');
      const sig = createHmac('sha256', 'admin-jwt-secret').update(`${header}.${payload}`).digest('base64url');
      const adminJwt = `${header}.${payload}.${sig}`;
      expect((await request(app)
        .post('/v1/internal/tenant-machine-assertions/verify-whatsapp-binding')
        .set({ Authorization: `Bearer ${adminJwt}` })
        .send({})).status).toBe(401);

      const service = await request(app)
        .post('/v1/internal/tenant-machine-assertions/verify-whatsapp-binding')
        .set({ Authorization: 'Bearer service-only-token' })
        .send({});
      expect(service.status).toBe(400);
      expect(service.body).toEqual({ code: 'INVALID_ASSERTION', valid: false });
    } finally {
      if (savedService === undefined) delete process.env.PROVISIONING_API_TOKEN;
      else process.env.PROVISIONING_API_TOKEN = savedService;
      if (savedJwt === undefined) delete process.env.ADMIN_JWT_SECRET;
      else process.env.ADMIN_JWT_SECRET = savedJwt;
    }
  });

  it('binds supplier and WABA claims into the signature', async () => {
    const pool = poolFor([
      { tenant_id: 'tenant-a', k8s_namespace: 'dealclaw-tenant-a', agent_endpoint: null },
    ]);
    const original = signedInput();
    await expect(
      verifyTenantMachineAssertion(
        pool as any,
        { ...original, supplierId: 'supplier-999' },
        async () => TOKEN,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyTenantMachineAssertion(
        pool as any,
        { ...original, wabaId: '99999999999' },
        async () => TOKEN,
      ),
    ).resolves.toBe(false);
  });

  it('fails closed for missing, ambiguous, external, or secretless tenant machines', async () => {
    for (const rows of [
      [],
      [
        { tenant_id: 'a', k8s_namespace: 'dealclaw-a', agent_endpoint: null },
        { tenant_id: 'b', k8s_namespace: 'dealclaw-b', agent_endpoint: null },
      ],
      [{ tenant_id: 'a', k8s_namespace: null, agent_endpoint: null }],
      [{ tenant_id: 'a', k8s_namespace: 'dealclaw-a', agent_endpoint: 'http://external' }],
    ]) {
      await expect(verifyTenantMachineAssertion(poolFor(rows) as any, signedInput(), async () => TOKEN))
        .resolves.toBe(false);
    }
    const pool = poolFor([
      { tenant_id: 'a', k8s_namespace: 'dealclaw-a', agent_endpoint: null },
    ]);
    await expect(verifyTenantMachineAssertion(pool as any, signedInput(), async () => null))
      .resolves.toBe(false);
  });

  it('rejects extra fields and hides verifier failures behind a safe error', async () => {
    const input = { ...signedInput(), adminToken: 'not-accepted' };
    await expect(verifyTenantMachineAssertion(poolFor([]) as any, input, async () => TOKEN))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_ASSERTION' });

    const pool = poolFor([
      { tenant_id: 'a', k8s_namespace: 'dealclaw-a', agent_endpoint: null },
    ]);
    await expect(
      verifyTenantMachineAssertion(pool as any, signedInput(), async () => {
        throw new Error('private K8s detail');
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'ASSERTION_VERIFIER_UNAVAILABLE',
    });
  });
});
