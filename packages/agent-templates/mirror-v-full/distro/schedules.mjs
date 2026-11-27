// The distro workspace's schedules.json (key, name, cron, enabled, prompt) as Portal system
// schedules (scheduler.ts ensureSystemSchedules). The Portal registers them after the first chat
// turn; on a standalone install scripts/v-schedule.py registers the same list with OpenClaw cron.
export const PORTAL_KIND = Object.freeze({
  // Maintenance that usually has nothing to say: the Portal's heartbeat trigger (quiet = HEARTBEAT_OK).
  "heartbeat-maintenance": "heartbeat",
  "feishu-docs-sync": "heartbeat",
  "memory-import-catchup": "heartbeat",
});

export function portalSchedules(list, tz) {
  if (!Array.isArray(list) || !list.length) throw Error("SCHEDULES_EMPTY");
  const names = new Set();
  return list.map((item) => {
    if (typeof item.key !== "string" || typeof item.name !== "string" || typeof item.cron !== "string" || typeof item.prompt !== "string") throw Error(`SCHEDULE_INVALID:${item.key}`);
    if (names.has(item.name)) throw Error(`SCHEDULE_NAME_REPEATED:${item.name}`);
    names.add(item.name);
    if (item.cron.trim().split(/\s+/).length !== 5) throw Error(`SCHEDULE_CRON_INVALID:${item.key}`);
    return {
      name: item.name,
      kind: PORTAL_KIND[item.key] ?? "cron",
      schedule: { kind: "cron", expr: item.cron, tz },
      prompt: item.prompt,
      ...(item.enabled === false ? { enabled: false } : {}),
    };
  });
}
