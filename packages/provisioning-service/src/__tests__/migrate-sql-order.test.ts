import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 回归测试：migrate.ts 里 rollout_batch_tasks 的 scope 列补列语句，必须早于
// 引用 scope 的唯一索引创建语句。
//
// 根因（生产事故 2026-09-15）：CREATE TABLE IF NOT EXISTS 对存量库是 no-op，
// 不会补 scope 列；若 CREATE UNIQUE INDEX ... WHERE ... scope IS NULL 跑在
// ADD COLUMN 之前，存量库（表已存在但无 scope 列）会报
//   error: column "scope" does not exist
// 导致 provisioning-service 启动时 migrate 失败、CrashLoopBackOff。
describe('migrate.ts rollout_batch_tasks scope 补列顺序', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/db/migrate.ts'), 'utf8');

  const ADD_COLUMN = 'ALTER TABLE rollout_batch_tasks ADD COLUMN IF NOT EXISTS scope';
  const UNIQUE_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS rollout_batch_tasks_active_uq';

  it('SQL 里必须存在补列语句与唯一索引语句', () => {
    expect(src).toContain(ADD_COLUMN);
    expect(src).toContain(UNIQUE_INDEX);
  });

  it('补列语句必须位于唯一索引（引用 scope）之前', () => {
    expect(src.indexOf(ADD_COLUMN)).toBeGreaterThan(-1);
    expect(src.indexOf(UNIQUE_INDEX)).toBeGreaterThan(-1);
    expect(src.indexOf(ADD_COLUMN)).toBeLessThan(src.indexOf(UNIQUE_INDEX));
  });
});
