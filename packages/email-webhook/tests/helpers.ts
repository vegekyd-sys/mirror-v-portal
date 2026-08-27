/**
 * 测试脚手架。
 *
 * 存储层跑在真实的 Postgres 上（和 credits-ledger 一样），本地起一个一次性实例即可：
 *
 *   docker run -d --name ewh-pg -e POSTGRES_PASSWORD=devpass \
 *     -e POSTGRES_DB=email_webhook_test -p 15432:5432 postgres:16-alpine
 *
 * 换别的库就设 TEST_DATABASE_URL。
 */

import { getSettings, resetSettings } from "../src/config.js";
import type { Settings } from "../src/config.js";
import { query } from "../src/db/pool.js";

export const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ??
  "postgresql://postgres:devpass@localhost:15432/email_webhook_test";

// pool.ts 在首次 query 时读 DATABASE_URL，所以要在任何用例跑起来之前就位
process.env["DATABASE_URL"] = TEST_DATABASE_URL;

/** 本服务会读的环境变量，构造前先清干净，避免开发机上的值渗进来。 */
const OWNED_ENV = [
  "HOST", "PORT", "LOG_LEVEL", "ROUTE_PREFIX",
  "RESEND_SIGNING_SECRET", "ALLOW_UNSIGNED", "SIGNATURE_TOLERANCE_SECONDS",
  "RESEND_API_KEY", "RESEND_API_BASE_URL", "RESEND_TIMEOUT_SECONDS",
  "EMAIL_CONTENT_PREVIEW_CHARS",
  "REDIS_ADDR", "REDIS_PASSWORD", "REDIS_DB", "REDIS_KEY_PREFIX",
  "NOTIFY_EVENTS", "FEISHU_TIMEOUT_SECONDS", "FEISHU_MENTION_EVENTS",
  "DEFAULT_SUPPLIER_ID", "ADMIN_TOKEN",
  "LEAD_BACKEND", "LEAD_TABLE", "LEAD_EMAIL_COLUMN", "LEAD_STATUS_COLUMN", "LEAD_UPDATED_COLUMN",
];

export function makeSettings(overrides: Record<string, string> = {}): Settings {
  const saved = { ...process.env };

  for (const key of OWNED_ENV) delete process.env[key];
  Object.assign(process.env, {
    LOG_LEVEL: "silent",
    ADMIN_TOKEN: "test-admin-token",
    ...overrides,
  });

  resetSettings();
  const settings = getSettings();

  process.env = saved;
  process.env["DATABASE_URL"] = TEST_DATABASE_URL;
  resetSettings();
  return settings;
}

/**
 * 清表。用例之间靠它隔离 —— vitest.config.ts 里关掉了文件级并行，
 * 所以不会有别的用例正在写。
 */
export async function resetTables(): Promise<void> {
  // 表可能还没建（store 是按需建表的），IF EXISTS 兜住
  await query(`
    DO $$
    BEGIN
      IF to_regclass('email_bindings') IS NOT NULL THEN TRUNCATE email_bindings; END IF;
      IF to_regclass('email_suppliers') IS NOT NULL THEN TRUNCATE email_suppliers; END IF;
      IF to_regclass('email_events') IS NOT NULL THEN TRUNCATE email_events; END IF;
    END $$;
  `);
}

export const ADMIN_HEADERS = {
  "x-admin-token": "test-admin-token",
  "x-supplier-id": "supplier_test",
};
