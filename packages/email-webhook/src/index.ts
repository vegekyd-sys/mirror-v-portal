/** 进程入口：起 HTTP 服务，处理优雅退出。 */

import { buildApp } from "./app.js";
import { getSettings } from "./config.js";
import { feishuEnabled, redisEnabled, resendApiEnabled } from "./config.js";
import { closePool, query } from "./db/pool.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const settings = getSettings();

  // 数据库是硬依赖：绑定表、供应商表、事件、幂等全在里面。
  // 与其起来之后每个请求都 500，不如启动就失败，让编排系统看得见。
  if (!settings.databaseUrl) {
    throw new Error("DATABASE_URL 未配置");
  }
  await query("SELECT 1");

  const app = await buildApp({ settings });
  const state = app.state;

  app.log.info(
    "启动完成 version=%s 验签=%s Resend正文=%s 线索后端=%s Redis=%s 飞书=%s 管理接口=%s 路由前缀=%s",
    VERSION,
    settings.signingSecret
      ? "on"
      : settings.allowUnsigned
        ? "OFF(ALLOW_UNSIGNED)"
        : "on(未配密钥,将全部拒绝)",
    resendApiEnabled(settings) ? "on" : "off(未配 RESEND_API_KEY)",
    state.leads.name,
    redisEnabled(settings),
    feishuEnabled(settings),
    settings.adminToken ? "on" : "off(未配 ADMIN_TOKEN)",
    settings.routePrefix || "(无)",
  );

  await app.listen({ host: settings.host, port: settings.port });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，开始优雅退出`);
    try {
      // 先停止接新请求，让在处理的 webhook 走完
      await app.close();
      if (state.redis !== null) await state.redis.quit();
      await closePool();
    } catch (err) {
      app.log.error({ err }, "退出过程中出错");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
