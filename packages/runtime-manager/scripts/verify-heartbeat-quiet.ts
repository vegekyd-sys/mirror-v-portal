import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
const s = new Store(loadConfig()),
  scheduler = new Scheduler(s);
try {
  const t = "5dadf73b-7b9f-4b5b-a910-0eaf4df43fb2";
  const job = (
    await s.pool.query(
      "SELECT * FROM elastic_schedules WHERE tenant_id=$1 AND name='nexus-heartbeat-acceptance' AND enabled ORDER BY created_at DESC LIMIT 1",
      [t],
    )
  ).rows[0];
  if (!job) throw Error("ACTIVE_TEST_JOB_REQUIRED");
  const r = (
    await s.pool.query(
      "SELECT * FROM elastic_runs WHERE tenant_id=$1 AND session_key=$2 ORDER BY created_at DESC LIMIT 1",
      [t, job.session_key],
    )
  ).rows[0];
  for (let i = 0; i < 120; i++) {
    const done = (
      await s.pool.query(
        "SELECT id FROM elastic_runs WHERE schedule_id=$1 AND status='succeeded' AND delivery='sent'",
        [job.id],
      )
    ).rowCount;
    if (done) {
      console.log("HEARTBEAT_ALERT_DELIVERED");
      break;
    }
    if (i === 119) throw Error("HEARTBEAT_NOT_DELIVERED");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const result = await scheduler.command(r, randomUUID(), {
    action: "update",
    id: job.id,
    schedule: { kind: "every", everySeconds: 60 },
    prompt:
      "管理员静默验收：没有需要提醒的事项。不要使用工具，只回复 HEARTBEAT_OK。",
  });
  console.log("QUIET_CHECK_SCHEDULED", JSON.stringify(result));
  for (let i = 0; i < 150; i++) {
    const done = (
      await s.pool.query(
        "SELECT 1 FROM elastic_events WHERE kind='heartbeat-quiet' AND data->>'scheduleId'=$1",
        [job.id],
      )
    ).rowCount;
    if (done) {
      await scheduler.command(r, randomUUID(), {
        action: "remove",
        id: job.id,
      });
      console.log("QUIET_VERIFIED_AND_TEST_CANCELLED");
      break;
    }
    if (i === 149) throw Error("QUIET_NOT_VERIFIED");
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await s.pool.end();
}
