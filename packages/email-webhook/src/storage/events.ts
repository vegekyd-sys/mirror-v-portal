/**
 * 事件持久化。
 *
 * 取代了原来的「JSONL 落盘 + MySQL 可选双写」两条路：现在只有 PostgreSQL 一处，
 * 它同时承担三件事 ——
 *   1. 原始事件留存（raw 列存 Resend 的完整报文）
 *   2. **幂等**。message_id 上的唯一约束 + ON CONFLICT DO NOTHING，
 *      插入返回 0 行就说明是重复投递。原来靠 Redis SETNX，Redis 挂了会
 *      fail open 静默放行、导致重复推飞书；现在这个保证是数据库级的。
 *   3. /v1/events 的增量拉取数据源（received_at 上有游标索引）
 */

import { query } from "../db/pool.js";
import type { InboundEvent, JsonObject } from "../events.js";

const COLUMNS = `message_id, event_type, email_id, recipients, sender, lead_email,
                 subject, status, occurred_at, received_at, detail, received_for,
                 attachments, raw`;

/**
 * 游标字符串必须由 Postgres 生成，不能用 JS 的 Date.toISOString()。
 *
 * TIMESTAMPTZ 是微秒精度，而 JS Date 只有毫秒：`.123456` 被截成 `.123` 发回给
 * poller，下一轮 `received_at > '.123'` 会把同一条又捞出来，游标永远推不过去。
 * 这里输出的形状和历史格式一致（`...THH:MM:SS.ffffff+00:00`），poller 侧不用改。
 */
const CURSOR = `to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`;

export interface EventRow {
  message_id: string;
  event_type: string;
  /** 微秒精度的游标字符串，直接来自数据库 */
  cursor: string;
  raw: JsonObject;
}

export interface InsertResult {
  /** false = message_id 已存在，本次是重复投递 */
  inserted: boolean;
  /** 服务端收到的时间，也是 /v1/events 的游标值 */
  receivedAt: string;
}

export class EventStore {
  private ready: Promise<void> | null = null;

  /** 建表按需执行一次。没有独立的迁移文件，服务对着空库直接能起。 */
  private ensureTable(): Promise<void> {
    this.ready ??= (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS email_events (
          id            BIGSERIAL    PRIMARY KEY,
          message_id    VARCHAR(191) NOT NULL UNIQUE,
          event_type    VARCHAR(64)  NOT NULL,
          email_id      VARCHAR(191) NOT NULL DEFAULT '',
          recipients    TEXT[]       NOT NULL DEFAULT '{}',
          sender        VARCHAR(320) NOT NULL DEFAULT '',
          lead_email    VARCHAR(320) NOT NULL DEFAULT '',
          subject       TEXT         NOT NULL DEFAULT '',
          status        VARCHAR(32),
          occurred_at   VARCHAR(64)  NOT NULL DEFAULT '',
          -- clock_timestamp() 而不是 NOW()：NOW() 是事务开始时间，同一事务里
          -- 多条会拿到同一个值，游标按 > 比较就会漏事件
          received_at   TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
          detail        JSONB        NOT NULL DEFAULT '{}'::jsonb,
          received_for  TEXT[]       NOT NULL DEFAULT '{}',
          attachments   INTEGER      NOT NULL DEFAULT 0,
          raw           JSONB        NOT NULL
        )
      `);
      await query(
        `CREATE INDEX IF NOT EXISTS idx_email_events_cursor ON email_events(received_at, id)`,
      );
      await query(`CREATE INDEX IF NOT EXISTS idx_email_events_lead ON email_events(lead_email)`);
      await query(
        `CREATE INDEX IF NOT EXISTS idx_email_events_email_id ON email_events(email_id)`,
      );
      await query(`CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type)`);
    })();
    return this.ready;
  }

  /**
   * 写入一条事件。重复的 message_id 返回 inserted=false，调用方据此回
   * {"status":"duplicate"}，与历史行为一致。
   */
  async insert(event: InboundEvent): Promise<InsertResult> {
    await this.ensureTable();
    const { rows } = await query<{ cursor: string }>(
      `INSERT INTO email_events (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, clock_timestamp(), $10, $11, $12, $13)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING ${CURSOR} AS cursor`,
      [
        event.messageId,
        event.eventType,
        event.emailId,
        event.recipients,
        event.sender,
        event.leadEmail, // 出站取收件人、收信取发件人
        event.subject,
        event.status ?? null,
        event.occurredAt,
        JSON.stringify(event.detail),
        event.receivedFor,
        event.attachments,
        JSON.stringify(event.raw),
      ],
    );

    const row = rows[0];
    if (!row) return { inserted: false, receivedAt: "" };
    return { inserted: true, receivedAt: row.cursor };
  }

  /**
   * 按 received_at 增量读取，返回 [rows, hasMore]。
   *
   * after 是上次游标（ISO 时间戳字符串），只返回 received_at > after 的事件；
   * 传空串则从最早一条开始。比较交给 Postgres 按 timestamptz 做，不是字符串比较 ——
   * 所以 poller 存的是什么格式的时间戳都能正确解析。
   */
  async readSince(after = "", limit = 50): Promise<[EventRow[], boolean]> {
    await this.ensureTable();
    // 多取一条用来判断还有没有剩余，返回时再截掉
    const { rows } = after
      ? await query<EventRow>(
          `SELECT message_id, event_type, ${CURSOR} AS cursor, raw FROM email_events
           WHERE received_at > $1::timestamptz
           ORDER BY received_at, id LIMIT $2`,
          [after, limit + 1],
        )
      : await query<EventRow>(
          `SELECT message_id, event_type, ${CURSOR} AS cursor, raw FROM email_events
           ORDER BY received_at, id LIMIT $1`,
          [limit + 1],
        );

    if (rows.length > limit) return [rows.slice(0, limit), true];
    return [rows, false];
  }
}
