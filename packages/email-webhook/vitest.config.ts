import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 存储层测试对着同一个 Postgres 跑，用例之间靠 TRUNCATE 隔离，
    // 所以文件之间不能并行，否则会互相清表。整套只要 1 秒左右，不值得为并行做 schema 隔离。
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/db/pool.ts"],
    },
  },
});
