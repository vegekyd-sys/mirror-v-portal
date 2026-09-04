import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

export type AppEnv = "development" | "test" | "production";

function resolveAppEnv(): AppEnv {
  const fromEnv = process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim();
  if (fromEnv === "production" || fromEnv === "prod") return "production";
  if (fromEnv === "test") return "test";
  if (fromEnv === "development" || fromEnv === "dev") return "development";

  const cmd = process.env.npm_lifecycle_event;
  if (cmd === "start:prod" || cmd === "start") return "production";
  if (cmd === "start:test" || cmd === "test") return "test";
  return "development";
}

function loadEnvFile(relativePath: string, override: boolean): boolean {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return false;
  dotenv.config({ path: fullPath, override });
  return true;
}

/** 把 USER/PASSWORD 拼进 Prisma 可用的 DATABASE_URL；
 *  DATABASE_SCHEMA 写入 ?schema=（默认 public）。
 */
function resolveDatabaseUrl(): void {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return;

  const user = process.env.DATABASE_USER?.trim();
  const password = process.env.DATABASE_PASSWORD?.trim() ?? "";
  const schema = process.env.DATABASE_SCHEMA?.trim() || "public";

  if (!raw.startsWith("postgres://") && !raw.startsWith("postgresql://")) {
    return;
  }

  try {
    const url = new URL(raw);
    if (user && !url.username) {
      url.username = user;
      url.password = password;
    }
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString().replace(/^postgres:\/\//, "postgresql://");
  } catch {
    // 保持原值
  }
}

/** 加载顺序（后者覆盖前者）：常驻 → 环境 → 本地覆盖 → 兼容旧 .env */
export function loadEnvFiles(): AppEnv {
  const appEnv = resolveAppEnv();
  process.env.APP_ENV = appEnv;
  process.env.NODE_ENV = appEnv;

  const loaded: string[] = [];
  if (loadEnvFile(".env.shared", false)) loaded.push(".env.shared");
  if (loadEnvFile(`.env.${appEnv}`, true)) loaded.push(`.env.${appEnv}`);
  if (loadEnvFile(`.env.${appEnv}.local`, true)) loaded.push(`.env.${appEnv}.local`);
  if (loadEnvFile(".env.local", true)) loaded.push(".env.local");
  if (loadEnvFile(".env", true)) loaded.push(".env");

  resolveDatabaseUrl();

  if (process.env.DEBUG_ENV === "1") {
    console.info(`[env] APP_ENV=${appEnv} loaded: ${loaded.join(" → ") || "(none)"}`);
  }

  return appEnv;
}

export const appEnv = loadEnvFiles();
