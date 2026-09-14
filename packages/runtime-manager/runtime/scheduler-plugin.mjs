import fs from "node:fs";
import { randomUUID } from "node:crypto";
const root = "/tmp/nexus-schedule-rpc";
export default {
  id: "nexus-scheduler",
  name: "Nexus schedules",
  register(api) {
    api.registerTool({
      name: "nexus_schedule",
      label: "Cron 与 heartbeat",
      description:
        "管理持久化 Cron 定时任务和 heartbeat 周期检查。Sandbox 休眠后仍会被 Nexus 唤醒，结果回到当前飞书会话。设置、查看、修改、取消定时任务或心跳时必须使用此工具，不能编辑 OpenClaw 配置或本地 cron 文件。只有返回 durable:true 才确认创建成功。默认时区 Asia/Shanghai；最短周期60秒。",
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
          "NEXUS_SCHEDULE_ACK_TIMEOUT: 不要宣称成功，请先 list 核对是否已创建",
        );
      },
    });
  },
};
