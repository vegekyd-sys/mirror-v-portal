/**
 * Notification-contact lock semantics (first-capture-wins).
 *
 * The tenant notification contact must be the FIRST person to DM the bot
 * after binding (almost always the binding admin) — never "the last person
 * who spoke", and never an employee talking in a group. These tests pin
 * the API contract of PATCH/DELETE /v1/tenants/:id/contact:
 *
 *   - PATCH only lands while im_open_id IS NULL (first-capture-wins)
 *   - PATCH on an already-captured tenant answers { captured: false }, 200
 *   - DELETE resets the contact (admin escape hatch)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { ProvisioningConfig } from '../config.js';

process.env.PROVISIONING_API_TOKEN = 'test-token';

const config: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-test',
  imageRegistry: 'test-registry/dealclaw',
  nexusGatewayImageTag: 'test',
  dealclawAgentImageTag: 'test',
  agentPvcSize: '10Gi',
  agentPvcStorageClass: 'alibabacloud-cnfs-nas',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
  ossBucket: 'dealclaw-backup',
  ossSecretName: 'dealclaw-oss',
  backupImage: 'test/ossutil',
  creditsLedgerUrl: 'http://credits-ledger:8081',
  creditsLedgerToken: '',
  llmPushWorkerIntervalMs: 100,
  llmPushLeaseSeconds: 600,
};

/** Stateful fake pool: models the tenants.im_open_id column only. */
function makePool(tenantExists = true) {
  const state = { exists: tenantExists, imOpenId: null as string | null };
  const pool = {
    state,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('AND im_open_id IS NULL')) {
        // first-capture-wins UPDATE
        if (!state.exists) return { rows: [], rowCount: 0 };
        if (state.imOpenId !== null) return { rows: [], rowCount: 0 };
        state.imOpenId = String(params?.[1] ?? '');
        return { rows: [], rowCount: 1 };
      }
      // SELECT of the tenant's current contact — used by the PATCH fallback
      // ("already captured?") and by DELETE (pre-reset snapshot for audit).
      if (sql.includes('FROM tenants WHERE tenant_id') && sql.trim().startsWith('SELECT')) {
        return { rows: state.exists ? [{ platform: 'feishu', im_open_id: state.imOpenId }] : [], rowCount: state.exists ? 1 : 0 };
      }
      if (sql.includes('SET im_open_id = NULL')) {
        // DELETE reset
        if (!state.exists) return { rows: [], rowCount: 0 };
        state.imOpenId = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO tenant_status_log')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

const auth = { Authorization: 'Bearer test-token' };

describe('PATCH /v1/tenants/:id/contact — first-capture-wins', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(makePool(), config);
  });

  it('captures the first DM sender (captured: true)', async () => {
    const res = await request(app)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_admin' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, captured: true });
  });

  it('does NOT overwrite an already-captured contact (captured: false)', async () => {
    const pool = makePool();
    const app2 = createApp(pool, config);
    await request(app2)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_admin' });
    // A different employee DMs later — must not steal the contact.
    const res = await request(app2)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_employee' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, captured: false });
    expect(pool.state.imOpenId).toBe('ou_admin');
  });

  it('rejects a missing imOpenId', async () => {
    const res = await request(app)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown tenant', async () => {
    const app3 = createApp(makePool(false), config);
    const res = await request(app3)
      .patch('/v1/tenants/ghost/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/tenants/:id/contact — admin reset', () => {
  it('clears the captured contact so the next DM re-captures', async () => {
    const pool = makePool();
    const app4 = createApp(pool, config);
    await request(app4)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_wrong_person' });
    const del = await request(app4)
      .delete('/v1/tenants/tid1/contact')
      .set(auth);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect(pool.state.imOpenId).toBeNull();
    // Next DM re-captures.
    const again = await request(app4)
      .patch('/v1/tenants/tid1/contact')
      .set(auth)
      .send({ platform: 'feishu', imOpenId: 'ou_admin' });
    expect(again.body).toEqual({ ok: true, captured: true });
    expect(pool.state.imOpenId).toBe('ou_admin');
  });

  it('404s for an unknown tenant', async () => {
    const app5 = createApp(makePool(false), config);
    const res = await request(app5)
      .delete('/v1/tenants/ghost/contact')
      .set(auth);
    expect(res.status).toBe(404);
  });
});
