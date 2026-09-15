/**
 * 全局默认配置的 DB 集成测试（真 Postgres + 真 AES-256-GCM）。
 *
 * 单元测试用替身证明了逻辑；这里证明「落到真库里的确实是密文、且种子幂等
 * 不回滚」——即 ticket 的硬性要求：DB 存密文、仓库无明文、已存在不覆盖。
 * 数据库不可用时整体 skip（与 api.test.ts 同一约定）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { decryptValue } from '../services/crypto.js';
import { listGlobalDefaults, seedGlobalDefaults, upsertGlobalDefault } from '../services/global-defaults.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/dealclaw_test';
const TEST_KEY = 'b'.repeat(64);
/** 仅本测试使用的占位密钥（不是真 key）。 */
const PLACEHOLDER_RESEND = 'placeholder-resend-key-0001';
const PLACEHOLDER_WEBHOOK = 'placeholder-webhook-token-0002';

const MANAGED_KEYS = ['RESEND_API_KEY', 'WEBHOOK_ADMIN_TOKEN', 'UN_COMTRADE_API_KEY', 'WTO_API_KEY', 'PRIMARY_GROUP_RULE'];

let pool: pg.Pool | null = null;
let dbAvailable = false;
const savedKey = process.env.RUNTIME_CONFIG_KEY;

const dbIt = (name: string, fn: (ctx: TestContext) => Promise<void> | void) => {
  it(name, async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    await fn(ctx);
  });
};

beforeAll(async () => {
  process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
  try {
    pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
    await migrate(pool);
    await pool.query('DELETE FROM global_defaults WHERE key = ANY($1::text[])', [MANAGED_KEYS]);
    dbAvailable = true;
  } catch {
    console.warn('[global-defaults-db] database unavailable — skipping');
    pool = null;
  }
});

afterAll(async () => {
  if (pool) {
    await pool.query('DELETE FROM global_defaults WHERE key = ANY($1::text[])', [MANAGED_KEYS]).catch(() => {});
    await pool.end();
  }
  if (savedKey === undefined) delete process.env.RUNTIME_CONFIG_KEY;
  else process.env.RUNTIME_CONFIG_KEY = savedKey;
});

describe('global_defaults（真库）', () => {
  dbIt('种子写入密文：库里不是明文，列表也不回显明文', async () => {
    const res = await seedGlobalDefaults(pool as pg.Pool, {
      DEFAULT_RESEND_API_KEY: PLACEHOLDER_RESEND,
      DEFAULT_WEBHOOK_ADMIN_TOKEN: PLACEHOLDER_WEBHOOK,
    } as NodeJS.ProcessEnv);
    expect(res.inserted).toContain('RESEND_API_KEY');
    expect(res.failed).toEqual([]);

    const { rows } = await (pool as pg.Pool).query(
      "SELECT value_encrypted FROM global_defaults WHERE key = 'RESEND_API_KEY'",
    );
    expect(rows[0].value_encrypted).not.toContain(PLACEHOLDER_RESEND);
    expect(rows[0].value_encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decryptValue(rows[0].value_encrypted)).toBe(PLACEHOLDER_RESEND);

    const items = await listGlobalDefaults(pool as pg.Pool);
    const resend = items.find((i) => i.key === 'RESEND_API_KEY');
    expect(resend).toMatchObject({ configured: true, length: PLACEHOLDER_RESEND.length, isSecret: true });
    expect(JSON.stringify(items)).not.toContain(PLACEHOLDER_RESEND);
    expect(JSON.stringify(items)).not.toContain(PLACEHOLDER_WEBHOOK);
    // env 未提供的 key：未配置（但不阻断）
    expect(items.find((i) => i.key === 'WTO_API_KEY')?.configured).toBe(false);
  });

  dbIt('二次种子幂等：不覆盖已存在的值', async () => {
    const again = await seedGlobalDefaults(pool as pg.Pool, {
      DEFAULT_RESEND_API_KEY: 'another-placeholder-value',
    } as NodeJS.ProcessEnv);
    expect(again.inserted).not.toContain('RESEND_API_KEY');
    expect(again.skipped).toContain('RESEND_API_KEY');

    const { rows } = await (pool as pg.Pool).query(
      "SELECT value_encrypted FROM global_defaults WHERE key = 'RESEND_API_KEY'",
    );
    expect(decryptValue(rows[0].value_encrypted)).toBe(PLACEHOLDER_RESEND);
  });

  dbIt('PUT 覆盖写：更新后解密为新值，updated_by 落审计字段', async () => {
    const saved = await upsertGlobalDefault(pool as pg.Pool, {
      key: 'WTO_API_KEY',
      value: 'placeholder-wto-key-0003',
      updatedBy: 'maqing',
    });
    expect(saved).toMatchObject({ key: 'WTO_API_KEY', length: 'placeholder-wto-key-0003'.length, updatedBy: 'maqing' });

    const items = await listGlobalDefaults(pool as pg.Pool);
    expect(items.find((i) => i.key === 'WTO_API_KEY')).toMatchObject({ configured: true, updatedBy: 'maqing' });
  });

  dbIt('主密钥缺失时 fail-closed：configured=false、length=null（不把解不开当已配置）', async () => {
    delete process.env.RUNTIME_CONFIG_KEY;
    try {
      const items = await listGlobalDefaults(pool as pg.Pool);
      const resend = items.find((i) => i.key === 'RESEND_API_KEY');
      expect(resend?.configured).toBe(false);
      expect(resend?.length).toBeNull();
    } finally {
      process.env.RUNTIME_CONFIG_KEY = TEST_KEY;
    }
  });
});
