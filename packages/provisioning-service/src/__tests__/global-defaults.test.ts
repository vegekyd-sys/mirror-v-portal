import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 替身：K8s / crypto ────────────────────────────────────────────────────
const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(async (_ns: string, _name: string): Promise<any> => null),
  putSecret: vi.fn(async (_ns: string, _name: string, _data: Record<string, string>): Promise<void> => undefined),
  getDeployment: vi.fn(async (_ns: string, _name: string): Promise<any> => null),
  patchDeployment: vi.fn(async (_ns: string, _name: string, _patch: unknown): Promise<boolean> => true),
  restartDeployment: vi.fn(async (_ns: string, _name: string): Promise<boolean> => true),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

/** 与真实 crypto 同语义的轻量替身：enc:<base64(明文)>（测试里可断言「库里不是明文」）。 */
const cryptoMocks = vi.hoisted(() => ({
  encryptValue: vi.fn((v: string) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`),
  decryptValue: vi.fn((v: string) =>
    v.startsWith('enc:') ? Buffer.from(v.slice(4), 'base64').toString('utf8') : v,
  ),
  getMasterKey: vi.fn((): Buffer | null => Buffer.alloc(32, 7)),
  isEncrypted: vi.fn((v: string) => v.startsWith('enc:')),
  maskValue: vi.fn(() => '••••••••'),
  MasterKeyError: class MasterKeyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MasterKeyError';
    }
  },
}));
vi.mock('../services/crypto.js', () => cryptoMocks);

import { createGlobalDefaultRoutes } from '../routes/global-defaults.js';
import { createApp } from '../app.js';
import { createServiceOrAdminAuthMiddleware } from '../middleware/auth.js';
import {
  GLOBAL_DEFAULT_KEYS,
  GlobalDefaultError,
  applyGlobalDefaults,
  dryRunGlobalDefaults,
  listGlobalDefaults,
  seedGlobalDefaults,
  upsertGlobalDefault,
  validateGlobalDefaultKey,
  validateGlobalDefaultValue,
} from '../services/global-defaults.js';
import { parseEnvFile, resolveEffectiveTenantEnv } from '../services/tenant-env.js';
import type { ProvisioningConfig } from '../config.js';

const SECRET_PLAINTEXT = 'test-resend-key-ABCDEFGH123456';

const enc = (v: string) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`;

const baseConfig: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: false,
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

const tenantRow = {
  tenant_id: 't1',
  company_name: 'Acme Ltd',
  status: 'active',
  k8s_namespace: 'dealclaw-t1',
  agent_endpoint: null,
  mio_cdp_supplier_id: null,
};

interface FakeQuery {
  sql: string;
  params?: unknown[];
}

function makeFakePool(
  opts: {
    defaultsRows?: any[];
    globalConfigRows?: any[];
    tenantConfigRows?: any[];
    tenants?: any[];
    insertRowCount?: number;
  } = {},
) {
  const queries: FakeQuery[] = [];
  const respond = (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('FROM global_defaults')) return { rows: opts.defaultsRows ?? [], rowCount: (opts.defaultsRows ?? []).length };
    if (sql.startsWith('INSERT INTO global_defaults')) return { rows: [{ updated_at: '2026-09-15T00:00:00.000Z', updated_by: 'maqing' }], rowCount: opts.insertRowCount ?? 1 };
    if (sql.includes('FROM runtime_configs WHERE tenant_id IS NULL')) return { rows: opts.globalConfigRows ?? [], rowCount: (opts.globalConfigRows ?? []).length };
    if (sql.includes('FROM runtime_configs WHERE tenant_id = $1')) return { rows: opts.tenantConfigRows ?? [], rowCount: (opts.tenantConfigRows ?? []).length };
    if (sql.includes('FROM tenants WHERE tenant_id = $1')) return { rows: [tenantRow], rowCount: 1 };
    if (sql.includes('FROM tenants')) return { rows: opts.tenants ?? [], rowCount: (opts.tenants ?? []).length };
    return { rows: [], rowCount: 1 };
  };
  const client = { query: async (sql: string, params?: unknown[]) => respond(sql, params), release: () => {} };
  const pool = {
    queries,
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => respond(sql, params),
  };
  return pool as any;
}

function signJwt(payload: object, secret: string): string {
  const encPart = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const toSign = `${encPart({ alg: 'HS256', typ: 'JWT' })}.${encPart(payload)}`;
  const sig = createHmac('sha256', secret).update(toSign).digest('base64url');
  return `${toSign}.${sig}`;
}

function jwtFor(role: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: 'adm_1', username: 'maqing', role, iat: now, exp: now + 3600 }, 'test-jwt-secret');
}

function makeApp(pool: any) {
  const app = express();
  app.use(express.json());
  app.use(createGlobalDefaultRoutes(pool, baseConfig, createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN')));
  return app;
}

beforeEach(() => {
  process.env.PROVISIONING_API_TOKEN = 'svc-token';
  process.env.ADMIN_JWT_SECRET = 'test-jwt-secret';
  vi.clearAllMocks();
  k8sMocks.getSecret.mockResolvedValue(null);
  k8sMocks.getDeployment.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.PROVISIONING_API_TOKEN;
  delete process.env.ADMIN_JWT_SECRET;
});

// ── catalog / 校验 ────────────────────────────────────────────────────────

describe('global-defaults catalog 校验', () => {
  it('catalog 覆盖 4 个共享 key + 主群规则', () => {
    expect(GLOBAL_DEFAULT_KEYS).toEqual([
      'RESEND_API_KEY',
      'WEBHOOK_ADMIN_TOKEN',
      'UN_COMTRADE_API_KEY',
      'WTO_API_KEY',
      'PRIMARY_GROUP_RULE',
    ]);
  });

  it('未登记的 key 直接拒绝（不会变成第二张 runtime_configs）', () => {
    expect(() => validateGlobalDefaultKey('SOME_OTHER_KEY')).toThrow(/Unknown global default key/);
    expect(validateGlobalDefaultKey('RESEND_API_KEY')).toBe('RESEND_API_KEY');
  });

  it('枚举项取值受约束，空值拒绝', () => {
    expect(validateGlobalDefaultValue('PRIMARY_GROUP_RULE', 'first_group')).toBe('first_group');
    expect(() => validateGlobalDefaultValue('PRIMARY_GROUP_RULE', 'nope')).toThrow(GlobalDefaultError);
    expect(() => validateGlobalDefaultValue('RESEND_API_KEY', '')).toThrow(GlobalDefaultError);
  });
});

// ── 启动种子（幂等 + 不阻断） ─────────────────────────────────────────────

describe('seedGlobalDefaults', () => {
  it('从 env 幂等种子：写入密文（库里不是明文）', async () => {
    const pool = makeFakePool();
    const res = await seedGlobalDefaults(pool, {
      DEFAULT_RESEND_API_KEY: SECRET_PLAINTEXT,
      DEFAULT_PRIMARY_GROUP_RULE: 'first_group',
    } as NodeJS.ProcessEnv);

    expect(res.inserted).toEqual(['RESEND_API_KEY', 'PRIMARY_GROUP_RULE']);
    // 没有提供值的 key 记 missingEnv，不阻断
    expect(res.missingEnv).toEqual(['WEBHOOK_ADMIN_TOKEN', 'UN_COMTRADE_API_KEY', 'WTO_API_KEY']);
    expect(res.failed).toEqual([]);

    const inserts = pool.queries.filter((q: FakeQuery) => q.sql.startsWith('INSERT INTO global_defaults'));
    expect(inserts).toHaveLength(2);
    expect(inserts.every((q: FakeQuery) => q.sql.includes('ON CONFLICT (key) DO NOTHING'))).toBe(true);
    const stored = inserts.map((q: FakeQuery) => q.params?.[1]);
    expect(stored).toContain(enc(SECRET_PLAINTEXT));
    expect(JSON.stringify(inserts)).not.toContain(SECRET_PLAINTEXT);
  });

  it('已存在则不覆盖（幂等）：rowCount=0 → skipped', async () => {
    const pool = makeFakePool({ insertRowCount: 0 });
    const res = await seedGlobalDefaults(pool, { DEFAULT_RESEND_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(res.inserted).toEqual([]);
    // PRIMARY_GROUP_RULE 有缺省值（first_group），所以总是会尝试落种子，
    // 这里同样命中 ON CONFLICT DO NOTHING → skipped。
    expect(res.skipped).toEqual(['RESEND_API_KEY', 'PRIMARY_GROUP_RULE']);
  });

  it('env 全缺时：枚举项用缺省值落种子，其余记 missingEnv', async () => {
    const pool = makeFakePool();
    const res = await seedGlobalDefaults(pool, {} as NodeJS.ProcessEnv);
    expect(res.inserted).toEqual(['PRIMARY_GROUP_RULE']);
    expect(res.missingEnv).toHaveLength(4);
    const insert = pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO global_defaults'));
    expect(insert?.params?.[1]).toBe(enc('first_group'));
  });

  it('加密失败（主密钥缺失）不抛错，只记 failed', async () => {
    cryptoMocks.encryptValue.mockImplementationOnce(() => {
      throw new Error('RUNTIME_CONFIG_KEY is not configured');
    });
    const pool = makeFakePool();
    const res = await seedGlobalDefaults(pool, { DEFAULT_RESEND_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(res.failed).toEqual([{ key: 'RESEND_API_KEY', error: 'RUNTIME_CONFIG_KEY is not configured' }]);
  });
});

// ── 列表 / 写入（只写不回显） ─────────────────────────────────────────────

describe('listGlobalDefaults', () => {
  it('返回已配置/未配置 + 长度 + 更新人，不给明文', async () => {
    const pool = makeFakePool({
      defaultsRows: [
        { key: 'RESEND_API_KEY', value_encrypted: enc(SECRET_PLAINTEXT), is_secret: true, updated_by: 'maqing', updated_at: '2026-09-15T01:00:00.000Z' },
      ],
    });
    const items = await listGlobalDefaults(pool);
    const resend = items.find((i) => i.key === 'RESEND_API_KEY')!;
    expect(resend.configured).toBe(true);
    expect(resend.length).toBe(SECRET_PLAINTEXT.length);
    expect(resend.updatedBy).toBe('maqing');
    // 未配置的 key 也要出现在列表里
    expect(items.find((i) => i.key === 'WTO_API_KEY')?.configured).toBe(false);
    expect(JSON.stringify(items)).not.toContain(SECRET_PLAINTEXT);
  });

  it('主密钥不可用时 length=null 且 configured=false（解密失败不当成已配置）', async () => {
    cryptoMocks.getMasterKey.mockReturnValueOnce(null);
    const pool = makeFakePool({
      defaultsRows: [{ key: 'RESEND_API_KEY', value_encrypted: enc('x'), is_secret: true, updated_by: null, updated_at: null }],
    });
    const items = await listGlobalDefaults(pool);
    expect(items.find((i) => i.key === 'RESEND_API_KEY')).toMatchObject({ configured: false, length: null });
  });
});

describe('upsertGlobalDefault', () => {
  it('写密文、只回长度，不回显明文', async () => {
    const pool = makeFakePool();
    const saved = await upsertGlobalDefault(pool, {
      key: 'RESEND_API_KEY',
      value: SECRET_PLAINTEXT,
      updatedBy: 'maqing',
    });
    const insert = pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO global_defaults'));
    expect(insert?.params?.[1]).toBe(enc(SECRET_PLAINTEXT));
    expect(insert?.params?.[2]).toBe(true); // is_secret
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    expect(saved.length).toBe(SECRET_PLAINTEXT.length);
  });
});

// ── 合并口径（tenant-env） ────────────────────────────────────────────────

describe('resolveEffectiveTenantEnv', () => {
  it('优先级：租户覆盖 > 全局默认 > runtime_configs 全局；缺 key 记入 missingDefaults', async () => {
    const pool = makeFakePool({
      globalConfigRows: [{ config_key: 'K', encrypted_value: enc('from-runtime-global') }],
      tenantConfigRows: [{ config_key: 'K', encrypted_value: enc('from-tenant') }],
      defaultsRows: [
        { key: 'K', value_encrypted: enc('from-global-defaults'), is_secret: true, updated_by: null, updated_at: null },
        { key: 'WTO_API_KEY', value_encrypted: enc('wto'), is_secret: true, updated_by: null, updated_at: null },
      ],
    });
    const { env, missingDefaults } = await resolveEffectiveTenantEnv(pool, 't1');
    expect(env.K).toBe('from-tenant');
    expect(env.WTO_API_KEY).toBe('wto');
    expect(missingDefaults).toEqual(['RESEND_API_KEY', 'WEBHOOK_ADMIN_TOKEN', 'UN_COMTRADE_API_KEY']);
  });

  it('parseEnvFile 解析 .env（忽略注释/空行）', () => {
    expect(parseEnvFile('# c\nA=1\n\nB=two=2\n')).toEqual({ A: '1', B: 'two=2' });
  });
});

// ── dryRun 报告 ──────────────────────────────────────────────────────────

describe('dryRunGlobalDefaults', () => {
  it('逐租户算差异：不一致=needs_update、一致=up_to_date、无独立 agent=skipped，且不写库', async () => {
    const pool = makeFakePool({
      defaultsRows: [
        { key: 'RESEND_API_KEY', value_encrypted: enc('new-key'), is_secret: true, updated_by: null, updated_at: null },
      ],
      tenants: [
        { tenant_id: 't1', company_name: 'A', status: 'active', k8s_namespace: 'dealclaw-t1', agent_endpoint: null },
        { tenant_id: 't2', company_name: 'B', status: 'active', k8s_namespace: 'dealclaw-t2', agent_endpoint: null },
        { tenant_id: 't3', company_name: 'C', status: 'pending', k8s_namespace: null, agent_endpoint: null },
      ],
    });
    k8sMocks.getSecret.mockImplementation(async (ns: string) => {
      const envContent = ns === 'dealclaw-t1' ? 'RESEND_API_KEY=old-key\n' : 'RESEND_API_KEY=new-key\n';
      return { type: 'Opaque', data: { '.env': Buffer.from(envContent, 'utf8').toString('base64') } } as any;
    });

    const report = await dryRunGlobalDefaults(pool, baseConfig, {});
    expect(report.summary).toMatchObject({ total: 3, needsUpdate: 1, upToDate: 1, skipped: 1 });
    const byId = Object.fromEntries(report.tenants.map((t) => [t.tenantId, t]));
    expect(byId.t1.state).toBe('needs_update');
    expect(byId.t1.changedKeys).toEqual(['RESEND_API_KEY']);
    expect(byId.t2.state).toBe('up_to_date');
    expect(byId.t3.state).toBe('skipped');
    // 报告里不能出现明文
    expect(JSON.stringify(report)).not.toContain('new-key');
    expect(JSON.stringify(report)).not.toContain('old-key');
    // 不写任何东西（无 global_defaults/tenants 写语句）
    const writes = pool.queries.filter((q: FakeQuery) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql));
    expect(writes).toHaveLength(0);
  });

  it('K8S_DRY_RUN 时逐个标 skipped（读不到 Secret 就不猜差异）', async () => {
    const pool = makeFakePool({
      tenants: [{ tenant_id: 't1', company_name: 'A', status: 'active', k8s_namespace: 'dealclaw-t1', agent_endpoint: null }],
    });
    const report = await dryRunGlobalDefaults(pool, { ...baseConfig, k8sDryRun: true }, {});
    expect(report.tenants[0]).toMatchObject({ state: 'skipped' });
    expect(JSON.stringify(report.tenants[0].detail)).toContain('K8S_DRY_RUN');
  });
});

// ── apply（人工触发，逐个回执） ──────────────────────────────────────────

describe('applyGlobalDefaults', () => {
  it('逐个下发 + 每个租户回执（含无独立 agent 的失败回执）', async () => {
    const pool = makeFakePool({
      defaultsRows: [{ key: 'RESEND_API_KEY', value_encrypted: enc('k'), is_secret: true, updated_by: null, updated_at: null }],
      tenants: [
        { tenant_id: 't1', company_name: 'A', status: 'active', k8s_namespace: 'dealclaw-t1', agent_endpoint: null },
        { tenant_id: 't9', company_name: 'Z', status: 'active', k8s_namespace: null, agent_endpoint: 'http://x' },
      ],
    });
    const result = await applyGlobalDefaults(pool, baseConfig, {});
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.receipts.find((r) => r.tenantId === 't1')?.ok).toBe(true);
    expect(result.receipts.find((r) => r.tenantId === 't9')?.ok).toBe(false);

    // 下发写的是合并后的 .env（含全局默认 key）
    const put = k8sMocks.putSecret.mock.calls.find((c: any[]) => c[1] === 'skill-env');
    expect(put?.[0]).toBe('dealclaw-t1');
    expect(String(put?.[2]?.['.env'])).toContain('RESEND_API_KEY=k');
  });
});

// ── HTTP 接口：仅超管 + 永不回显 ─────────────────────────────────────────

describe('HTTP /v1/admin/global-defaults', () => {
  it('通过 createApp 挂载：服务令牌 403、超管 200，且不影响后续路由（fall-through）', async () => {
    const pool = makeFakePool();
    const app = createApp(pool, baseConfig);

    const forbidden = await request(app)
      .get('/v1/admin/global-defaults')
      .set('Authorization', 'Bearer svc-token');
    expect(forbidden.status).toBe(403);

    const ok = await request(app)
      .get('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('admin')}`);
    expect(ok.status).toBe(200);

    // 挂载在 global-defaults 之后的 admin 路由不受影响（route-level 门禁不拦 for 其他路径）
    const other = await request(app)
      .get('/v1/admin/image-releases')
      .set('Authorization', 'Bearer svc-token');
    expect(other.status).not.toBe(403);
  });

  it('服务令牌无权限（仅超管）→ 403', async () => {
    const pool = makeFakePool();
    const res = await request(makeApp(pool))
      .get('/v1/admin/global-defaults')
      .set('Authorization', 'Bearer svc-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('operator 角色 → 403（角色不足）', async () => {
    const pool = makeFakePool();
    const res = await request(makeApp(pool))
      .put('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('operator')}`)
      .send({ key: 'RESEND_API_KEY', value: 'x' });
    expect(res.status).toBe(403);
  });

  it('超管 GET：只回状态/长度，永不回显明文', async () => {
    const pool = makeFakePool({
      defaultsRows: [{ key: 'RESEND_API_KEY', value_encrypted: enc(SECRET_PLAINTEXT), is_secret: true, updated_by: 'maqing', updated_at: '2026-09-15T01:00:00.000Z' }],
    });
    const res = await request(makeApp(pool))
      .get('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('admin')}`);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.key === 'RESEND_API_KEY');
    expect(item).toMatchObject({ configured: true, length: SECRET_PLAINTEXT.length, updatedBy: 'maqing' });
    expect(item.value).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PLAINTEXT);
  });

  it('超管 PUT：写密文 + 审计不含值', async () => {
    const pool = makeFakePool();
    const res = await request(makeApp(pool))
      .put('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('admin')}`)
      .send({ key: 'RESEND_API_KEY', value: SECRET_PLAINTEXT });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, key: 'RESEND_API_KEY', configured: true });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PLAINTEXT);

    const audit = pool.queries.find((q: FakeQuery) => q.sql.includes('INSERT INTO audit_logs'));
    expect(audit).toBeTruthy();
    expect(audit!.sql).toContain('audit_logs');
    expect(JSON.stringify(audit!.params)).not.toContain(SECRET_PLAINTEXT);
    const auditPayload = String(audit!.params?.[9] ?? '');
    expect(audit!.params?.[2]).toBe('global-default.update');
    expect(auditPayload).toContain('RESEND_API_KEY');
  });

  it('超管 PUT：未知 key / 空值 → 400', async () => {
    const pool = makeFakePool();
    const app = makeApp(pool);
    const bad = await request(app)
      .put('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('admin')}`)
      .send({ key: 'NOPE_KEY', value: 'x' });
    expect(bad.status).toBe(400);
    const empty = await request(app)
      .put('/v1/admin/global-defaults')
      .set('Authorization', `Bearer ${jwtFor('admin')}`)
      .send({ key: 'RESEND_API_KEY', value: '' });
    expect(empty.status).toBe(400);
  });

  it('dry-run / apply 需要人工触发（POST）+ 超管；apply 回回执并写审计', async () => {
    const pool = makeFakePool({
      tenants: [{ tenant_id: 't1', company_name: 'A', status: 'active', k8s_namespace: 'dealclaw-t1', agent_endpoint: null }],
      defaultsRows: [{ key: 'RESEND_API_KEY', value_encrypted: enc('k'), is_secret: true, updated_by: null, updated_at: null }],
    });
    const app = makeApp(pool);

    const noAuth = await request(app).post('/v1/admin/global-defaults/apply').send({});
    expect(noAuth.status).toBe(401);

    const apply = await request(app)
      .post('/v1/admin/global-defaults/apply')
      .set('Authorization', `Bearer ${jwtFor('admin')}`)
      .send({ tenantIds: ['t1'] });
    expect(apply.status).toBe(200);
    expect(apply.body).toMatchObject({ ok: true, attempted: 1, succeeded: 1 });

    const audit = pool.queries.filter((q: FakeQuery) => q.sql.includes('INSERT INTO audit_logs'));
    expect(JSON.stringify(audit.map((a: FakeQuery) => a.params))).toContain('global-default.apply');

    k8sMocks.getSecret.mockResolvedValue(null);
    const dry = await request(app)
      .post('/v1/admin/global-defaults/dry-run')
      .set('Authorization', `Bearer ${jwtFor('admin')}`)
      .send({});
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
  });
});
