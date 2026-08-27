/**
 * 时间戳格式：微秒精度 + `+00:00` 偏移，和 Python 版的
 * `datetime.now(timezone.utc).isoformat()` 一致。
 *
 * 只用于展示（飞书卡片里的「发生于」）和 Redis 线索状态的 updated_at。
 * 事件的 received_at 由 Postgres 的 clock_timestamp() 生成，游标比较也交给
 * 数据库按 timestamptz 做，不再依赖字符串格式。
 */
export function nowIso(): string {
  return new Date().toISOString().replace(/Z$/, "000+00:00");
}
