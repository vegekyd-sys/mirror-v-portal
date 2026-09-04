/**
 * 部署前的数据库准备：建 schema + 应用迁移。两步都幂等，可重复执行。
 * k8s 里由 initContainer 调用：`node dist/scripts/dbSetup.js`
 *
 * 为什么不直接在 initContainer 里跑 `prisma migrate deploy`：
 * 表要落在 DATABASE_SCHEMA 指定的 schema 里，而这个路由靠的是 DATABASE_URL
 * 上的 `?schema=` 参数 —— 那是 loadEnvFiles() 拼进去的，**prisma CLI 不走那段代码**。
 * 直接调 CLI 的话 schema 建出来了，表却会落进 public。
 * 所以这里先 loadEnvFiles() 把 URL 补全，再把 CLI 拉起来。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnvFiles } from "../loadEnv";

async function main() {
  loadEnvFiles();

  const schema = process.env.DATABASE_SCHEMA?.trim() || "public";
  const prisma = new PrismaClient();
  try {
    // 迁移文件自己也有 CREATE SCHEMA，但那是第一个迁移里的；
    // 这里先建一次，保证 ?schema= 指向的目标在连接时就存在。
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    console.log(`[db-setup] schema ready: ${schema}`);
  } finally {
    await prisma.$disconnect();
  }

  const cli = path.join(process.cwd(), "node_modules", ".bin", "prisma");
  const result = spawnSync(cli, ["migrate", "deploy"], {
    stdio: "inherit",
    env: process.env, // 已被 loadEnvFiles 补上 ?schema=
  });
  if (result.status !== 0) {
    console.error("[db-setup] prisma migrate deploy 失败");
    process.exit(result.status ?? 1);
  }
  console.log("[db-setup] migrations applied");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
