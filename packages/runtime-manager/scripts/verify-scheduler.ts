import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
const s = new Store(loadConfig());
await s.init();
try {
  const tenant = "5dadf73b-7b9f-4b5b-a910-0eaf4df43fb2";
  const prior = (
    await s.pool.query(
      "SELECT session_key FROM elastic_runs WHERE tenant_id=$1 AND channel='feishu' AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [tenant],
    )
  ).rows[0];
  if (!prior?.session_key.includes(":oc_")) throw Error("GROUP_NOT_FOUND");
  const at = new Date(Date.now() + 180000).toISOString();
  const text = `管理员授权的 Nexus Cron 和 heartbeat 验收。请调用 nexus_schedule 工具创建下面两项测试任务，并列出结果。不要编辑配置，不要用 exec，不要再次确认。\n1. name=nexus-cron-acceptance，kind=cron，schedule={kind:at,at:${at}}，prompt=只回复「Cron 冷启动验收成功：这是 Nexus 定时唤醒后的主动消息。」不要调用工具。\n2. name=nexus-heartbeat-acceptance，kind=heartbeat，schedule={kind:every,everySeconds:300}，prompt=只回复「Heartbeat 冷启动验收成功：这是周期检查主动唤醒后的消息。」不要调用工具。\n这两项仅用于管理员测试，后续由管理员取消。`;
  const r = await s.enqueue(
    tenant,
    "schedule-acceptance-" + randomUUID(),
    prior.session_key,
    text,
    "web",
  );
  console.log(JSON.stringify({ runId: r.id, at, session: prior.session_key }));
} finally {
  await s.close();
}
