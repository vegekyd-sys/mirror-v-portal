/** Redis：幂等去重 + 线索状态缓存。未配置 REDIS_ADDR 时整体关闭。 */

import { Redis } from "ioredis";
import type { Settings } from "../config.js";
import { redisEnabled } from "../config.js";

/** REDIS_ADDR 既支持 host:port，也支持完整的 redis:// URL。 */
export function buildRedis(settings: Settings): Redis | null {
  if (!redisEnabled(settings)) return null;

  const common = {
    password: settings.redisPassword || undefined,
    db: settings.redisDb,
    connectTimeout: 3000,
    commandTimeout: 3000,
    // 连不上时不要无限重试堆积命令，让调用方的 try/catch 快速降级
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  };

  const addr = settings.redisAddr;
  if (addr.includes("://")) {
    return new Redis(addr, common);
  }

  const [host = "", port = ""] = addr.split(":");
  return new Redis({ ...common, host, port: Number.parseInt(port, 10) || 6379 });
}
