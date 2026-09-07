import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { ProvisioningConfig } from '../config.js';
import {
  encryptValue,
  decryptValue,
  isEncrypted,
  maskValue,
  getMasterKey,
  MasterKeyError,
} from '../services/crypto.js';
import {
  validateConfigKey,
  validateConfigValue,
  mergeConfigRows,
  PRESET_RUNTIME_KEYS,
} from '../services/runtime-config.js';

// 32-byte key as 64 hex chars
const TEST_KEY = 'a'.repeat(64);

const baseConfig: ProvisioningConfig = {
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

interface FakeQuery { sql: string; params?: unknown[] }

/** Minimal pg.Pool stand-in that records queries and returns canned rows. */
function makeFakePool(opts: { tenantExists?: boolean; deleteRowCount?: number } = {}) {
  const queries: FakeQuery[] = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('FROM tenants')) {
        return { rows: opts.tenantExists === false ? [] : [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO runtime_configs')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM runtime_configs')) {
        return { rows: [], rowCount: opts.deleteRowCount ?? 1 };
      }
      if (sql.includes('FROM runtime_configs')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

describe('crypto (AES-256-GCM envelope)', () => {
  const savedKey = process.env.RUNTIME_CONFIG_KEY;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.RUNTIME_CONFIG_KEY;
    else process.env.RUNTIME_CONFIG_KEY = savedKey;
  });

  it('getMasterKey returns null when unset (fail-closed callers)', () => {
    delete process.env.RUNTIME_CONFIG_KEY;
    expect(getMasterKey()).toBeNull();
  });

  it('encrypt requires a configured master key', () => {
    delete process.env.RUNTIME_CONFIG_KEY;
    expect(() => encryptValue('secret')).toThrow(MasterKeyError);
  });

  it('rejects malformed master keys', () => {
    process.env.RUNTIME_CONFIG_KEY = 'not-a-valid-key';
    expect(() => getMasterKey()).toThrow(MasterKeyError);
  });

  it('round-trips values with a valid hex key', () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const plaintext = 'sk-very-secret-value-123';
    const stored = encryptValue(plaintext);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(decryptValue(stored)).toBe(plaintext);
  });

  it('round-trips unicode values', () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const plaintext = '密码-🔑-value';
    expect(decryptValue(encryptValue(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    expect(encryptValue('same')).not.toBe(encryptValue('same'));
  });

  it('accepts base64-encoded 32-byte keys', () => {
    process.env.RUNTIME_CONFIG_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(decryptValue(encryptValue('x'))).toBe('x');
  });

  it('fails to decrypt when tampered', () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const stored = encryptValue('payload');
    const parts = stored.split(':');
    // flip a character in the ciphertext part
    const data = Buffer.from(parts[4], 'base64');
    data[0] = data[0] ^ 0xff;
    parts[4] = data.toString('base64');
    expect(() => decryptValue(parts.join(':'))).toThrow();
  });

  it('maskValue never exposes the full value', () => {
    expect(maskValue('sk-1234567890abcdef')).toMatch(/^sk-•••/);
    expect(maskValue('sk-1234567890abcdef')).not.toContain('1234567890abcdef');
    expect(maskValue('short')).toBe('••••••••');
  });
});

describe('runtime-config validation & merge (pure)', () => {
  const savedKey = process.env.RUNTIME_CONFIG_KEY;

  beforeEach(() => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.RUNTIME_CONFIG_KEY;
    else process.env.RUNTIME_CONFIG_KEY = savedKey;
  });

  it('accepts valid env-var-style keys', () => {
    expect(validateConfigKey('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY');
    expect(validateConfigKey('_PRIVATE')).toBe('_PRIVATE');
    expect(validateConfigKey('a1')).toBe('a1');
  });

  it('rejects keys that would break envFrom injection', () => {
    expect(() => validateConfigKey('has-dash')).toThrow();
    expect(() => validateConfigKey('9lives')).toThrow();
    expect(() => validateConfigKey('has space')).toThrow();
    expect(() => validateConfigKey('')).toThrow();
    expect(() => validateConfigKey(123 as any)).toThrow();
    expect(() => validateConfigKey('x'.repeat(200))).toThrow();
  });

  it('rejects empty or oversized values', () => {
    expect(() => validateConfigValue('')).toThrow();
    expect(() => validateConfigValue(null as any)).toThrow();
    expect(() => validateConfigValue('x'.repeat(9000))).toThrow();
    expect(validateConfigValue('ok')).toBe('ok');
  });

  it('tenant rows override global defaults on merge', () => {
    const globalRows = [
      { config_key: 'DEEPSEEK_API_KEY', encrypted_value: encryptValue('global-key') },
      { config_key: 'APOLLO_API_KEY', encrypted_value: encryptValue('global-apollo') },
    ];
    const tenantRows = [
      { config_key: 'DEEPSEEK_API_KEY', encrypted_value: encryptValue('tenant-key') },
    ];
    const merged = mergeConfigRows(globalRows, tenantRows);
    expect(merged['DEEPSEEK_API_KEY']).toBe('tenant-key');
    expect(merged['APOLLO_API_KEY']).toBe('global-apollo');
  });

  it('presets are intentionally empty — any key:value is allowed', () => {
    expect(PRESET_RUNTIME_KEYS).toHaveLength(0);
  });
});

describe('runtime-config admin API', () => {
  const savedToken = process.env.PROVISIONING_API_TOKEN;
  const savedKey = process.env.RUNTIME_CONFIG_KEY;
  const authHeader = { Authorization: 'Bearer test-token' };

  beforeEach(() => {
    process.env.PROVISIONING_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.PROVISIONING_API_TOKEN;
    else process.env.PROVISIONING_API_TOKEN = savedToken;
    if (savedKey === undefined) delete process.env.RUNTIME_CONFIG_KEY;
    else process.env.RUNTIME_CONFIG_KEY = savedKey;
  });

  function buildApp(pool = makeFakePool()) {
    return { app: createApp(pool, baseConfig), pool };
  }

  it('requires bearer auth on all runtime-config routes', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/v1/admin/runtime-configs/presets')).status).toBe(401);
    expect((await request(app).get('/v1/admin/runtime-configs')).status).toBe(401);
    expect(
      (await request(app).put('/v1/admin/runtime-configs').send({ key: 'A', value: 'b' })).status,
    ).toBe(401);
    expect((await request(app).delete('/v1/admin/runtime-configs/A')).status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/v1/admin/runtime-configs/presets')
      .set({ Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('returns an empty preset list (any key allowed)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/v1/admin/runtime-configs/presets').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.presets).toEqual([]);
  });

  it('rejects invalid keys with 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'bad-key!', value: 'v' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('rejects empty values with 400', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'GOOD_KEY', value: '' });
    expect(res.status).toBe(400);
  });

  it('fails closed with 503 when RUNTIME_CONFIG_KEY is unset', async () => {
    delete process.env.RUNTIME_CONFIG_KEY;
    const { app } = buildApp();
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'APIFY_TOKEN', value: 'sk-test' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('RUNTIME_CONFIG_KEY_NOT_CONFIGURED');
  });

  it('rejects writes to deprecated keys (DEEPSEEK_API_KEY) with 400 DEPRECATED', async () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const { app } = buildApp();
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'DEEPSEEK_API_KEY', value: 'sk-test' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DEPRECATED');
    expect(res.body.message).toMatch(/LLM_PROVIDERS/);
  });

  it('upserts an encrypted value into the global scope', async () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const pool = makeFakePool();
    const { app } = buildApp(pool);
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ key: 'APIFY_TOKEN', value: 'sk-secret', description: 'main key' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const insert = pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO runtime_configs'));
    expect(insert).toBeTruthy();
    // stored value must be encrypted, never plaintext
    expect(String(insert!.params![1])).toMatch(/^enc:v1:/);
    expect(String(insert!.params![1])).not.toContain('sk-secret');
    expect(decryptValue(String(insert!.params![1]))).toBe('sk-secret');
  });

  it('routes tenant-scoped upserts with the tenant id parameter', async () => {
    process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    const pool = makeFakePool();
    const { app } = buildApp(pool);
    const res = await request(app)
      .put('/v1/admin/runtime-configs')
      .set(authHeader)
      .send({ tenantId: 'tenant-123', key: 'APIFY_TOKEN', value: 'v' });
    expect(res.status).toBe(200);
    const insert = pool.queries.find((q: FakeQuery) => q.sql.startsWith('INSERT INTO runtime_configs'));
    expect(insert!.params![0]).toBe('tenant-123');
  });

  it('returns 404 when deleting a missing entry', async () => {
    const { app } = buildApp(makeFakePool({ deleteRowCount: 0 }));
    const res = await request(app)
      .delete('/v1/admin/runtime-configs/MISSING_KEY')
      .set(authHeader);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown tenant scope', async () => {
    const { app } = buildApp(makeFakePool({ tenantExists: false }));
    const res = await request(app)
      .get('/v1/admin/runtime-configs?tenantId=ghost')
      .set(authHeader);
    expect(res.status).toBe(404);
  });

  it('lists global entries masked without decrypting secrets', async () => {
    const pool = makeFakePool();
    // override the runtime_configs SELECT to return one encrypted row
    pool.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM runtime_configs')) {
        return {
          rows: [{
            config_key: 'DEEPSEEK_API_KEY',
            tenant_id: null,
            encrypted_value: 'enc:v1:aaa:bbb:ccc',
            is_secret: true,
            description: null,
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const { app } = buildApp(pool);
    const res = await request(app).get('/v1/admin/runtime-configs').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].displayValue).toBe('••••••••');
    expect(JSON.stringify(res.body)).not.toContain('enc:v1:aaa');
  });
});
