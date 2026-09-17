import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { createWeComBindingRoutes } from '../routes/wecom-binding.js';
import { createDingTalkBindingRoutes } from '../routes/dingtalk-binding.js';

// Regression test: the enterprise (WeCom/DingTalk) binding routes must be
// MOUNTED and reachable — the original defect was that app.ts imported the
// route creators but never app.use'd them, so every endpoint returned the
// 404 fallback ("Route not found"). These tests hit the routers directly via
// supertest and assert the handler ran (200/202, or a business-level 404 like
// NOT_BOUND — NOT the generic Route-not-found 404).
const TID = 'topenc1aw00000000000000000000';
const NS = `dealclaw-${TID}`;

const config: ProvisioningConfig = {
  port: 0,
  databaseUrl: '',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-nexus-production',
  imageRegistry: 'test',
  nexusGatewayImageTag: 'test',
  dealclawAgentImageTag: 'test',
  agentPvcSize: '1Gi',
  agentPvcStorageClass: 'test',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: '',
  ossBucket: '',
  ossSecretName: '',
  backupImage: '',
  creditsLedgerUrl: '',
  creditsLedgerToken: '',
  llmPushWorkerIntervalMs: 100,
  llmPushLeaseSeconds: 600,
};

function makePool(): pg.Pool {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM tenants WHERE tenant_id = $1')) {
        return {
          rows: [{ tenant_id: TID, status: 'active', k8s_namespace: NS, message_plane: 'openclaw', agent_endpoint: null }],
          rowCount: 1,
        };
      }
      // All binding-table reads (status get + conflict check) default to empty.
      return { rows: [], rowCount: 1 };
    },
  };
  return pool as unknown as pg.Pool;
}

function createApp() {
  const app = express();
  app.use(express.json());
  // Mount WITHOUT auth middleware — these tests exercise route registration
  // + handler wiring, not auth.
  app.use(createWeComBindingRoutes(makePool(), config));
  app.use(createDingTalkBindingRoutes(makePool(), config));
  return app;
}

describe('enterprise binding routes are mounted', () => {
  it('GET wecom-binding returns 200 (not the 404 fallback)', async () => {
    const res = await request(createApp()).get(`/v1/admin/tenants/${TID}/wecom-binding`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bound: false, botId: null, status: 'unbound', lastError: null });
  });

  it('GET dingtalk-binding returns 200 (not the 404 fallback)', async () => {
    const res = await request(createApp()).get(`/v1/admin/tenants/${TID}/dingtalk-binding`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bound: false, clientId: null, status: 'unbound', lastError: null });
  });

  it('POST wecom-binding/bind returns 202 (dry-run)', async () => {
    const res = await request(createApp())
      .post(`/v1/admin/tenants/${TID}/wecom-binding/bind`)
      .send({ botId: 'bot_1234', secret: 'secret12' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, tenantId: TID, botId: 'bot_1234', restarted: false });
  });

  it('POST dingtalk-binding/bind returns 202 (dry-run)', async () => {
    const res = await request(createApp())
      .post(`/v1/admin/tenants/${TID}/dingtalk-binding/bind`)
      .send({ clientId: 'cli_1234', clientSecret: 'secret12' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, tenantId: TID, clientId: 'cli_1234', restarted: false });
  });

  it('POST wecom-binding/unbind runs the handler (business 404 NOT_BOUND, not route-not-found)', async () => {
    const res = await request(createApp()).post(`/v1/admin/tenants/${TID}/wecom-binding/unbind`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_BOUND');
  });

  it('POST dingtalk-binding/unbind runs the handler (business 404 NOT_BOUND, not route-not-found)', async () => {
    const res = await request(createApp()).post(`/v1/admin/tenants/${TID}/dingtalk-binding/unbind`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_BOUND');
  });
});
