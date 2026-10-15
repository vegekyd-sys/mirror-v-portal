import fs from "node:fs";
import { randomUUID } from "node:crypto";
export function createPortalRuntimePlugin({ root = "/tmp/nexus-schedule-rpc", environmentFile = "/vercel/sandbox/agent-data/portal-environment.json" } = {}) {
return {
  id: "nexus-scheduler",
  name: "Portal runtime",
  register(api) {
    const schedule = {
      name: "portal_schedule",
      label: "Cron 与 heartbeat",
      description:
        "Portal 持久化定时任务与 heartbeat。调度器在沙盒外运行，到期唤醒沙盒，结果回到创建任务的对话。创建成功回执 durable:true。默认时区 Asia/Shanghai；最短周期60秒。",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["add", "list", "status", "update", "remove"],
          },
          kind: { type: "string", enum: ["cron", "heartbeat"] },
          name: { type: "string" },
          id: { type: "string" },
          prompt: { type: "string" },
          enabled: { type: "boolean" },
          schedule: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["at", "every", "cron"] },
              at: { type: "string", description: "带时区的 ISO 时间" },
              everySeconds: { type: "integer", minimum: 60 },
              expr: { type: "string", description: "五字段 Cron 表达式" },
              tz: { type: "string" },
            },
          },
        },
      },
      async execute(_id, args) {
        const current = JSON.parse(
          fs.readFileSync(root + "/current.json", "utf8"),
        );
        const id = randomUUID();
        const req = { id, nonce: current.nonce, args };
        const file = root + "/" + id;
        fs.writeFileSync(file + ".tmp", JSON.stringify(req));
        fs.renameSync(file + ".tmp", file + ".request");
        for (let i = 0; i < 240; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (fs.existsSync(file + ".response")) {
            const result = JSON.parse(
              fs.readFileSync(file + ".response", "utf8"),
            );
            fs.unlinkSync(file + ".response");
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: result,
            };
          }
        }
        throw Error(
          "PORTAL_SCHEDULE_ACK_TIMEOUT: durable acknowledgement unavailable; schedule state unknown",
        );
      },
    };
    api.registerTool(schedule);
    // Callable for explicitly allowlisted old integrations, absent from the
    // ordinary Portal tool list. Persistent schedule IDs and RPC stay stable.
    api.registerTool({ ...schedule, name: "nexus_schedule", description: "Portal 定时工具的兼容名称。" }, { optional: true });
    api.registerTool({
      name: "portal_environment",
      label: "Portal 运行环境",
      description: "读取 Portal 沙盒的运行环境事实：工作区、实际执行配置、npm 目录、休眠持久化、附件投递格式与调度接口。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const facts = JSON.parse(fs.readFileSync(environmentFile, "utf8"));
        return { content: [{ type: "text", text: JSON.stringify(facts) }], details: facts };
      },
    });
  },
};
}
export default createPortalRuntimePlugin();
