/**
 * 线索（lead）状态更新 —— 可插拔后端。
 *
 * DealClaw 的线索表结构尚未确认，所以这里只定义统一接口 + 三个实现：
 *   noop      : 只记日志（默认，schema 确认前用这个）
 *   redis     : 状态写 Redis Hash，随时可查，无需业务库
 *   postgres  : 直接 UPDATE 业务表，把 LEAD_TABLE/LEAD_*_COLUMN 填上即可
 *
 * 拿到真实 schema 后，正常情况下只要切 LEAD_BACKEND=postgres 并配好表名列名，
 * 不需要动这个文件。
 */

import type { Redis } from "ioredis";
import type { Settings } from "./config.js";
import { query } from "./db/pool.js";
import type { InboundEvent } from "./events.js";
import { isUpgrade } from "./events.js";
import { logger } from "./logger.js";
import { nowIso } from "./time.js";

export interface LeadResult {
  backend: string;
  /** 是否找到对应线索 */
  matched: boolean;
  /** 是否真的写入了新状态 */
  updated: boolean;
  previous_status: string | null;
  new_status: string | null;
  /** 实际用于匹配的线索邮箱，便于确认方向没搞反 */
  lead_email: string;
  /** 未更新时说明原因 */
  reason: string;
}

function result(backend: string, patch: Partial<LeadResult> = {}): LeadResult {
  return {
    backend,
    matched: false,
    updated: false,
    previous_status: null,
    new_status: null,
    lead_email: "",
    reason: "",
    ...patch,
  };
}

export interface LeadUpdater {
  readonly name: string;
  apply(event: InboundEvent): Promise<LeadResult>;
}

export class NoopLeadUpdater implements LeadUpdater {
  readonly name = "noop";

  async apply(event: InboundEvent): Promise<LeadResult> {
    const status = event.status;
    if (!status) return result(this.name, { reason: "event type has no status mapping" });
    logger.info(
      `lead status (noop): lead=${event.leadEmail} email_id=${event.emailId} -> ${status}`,
    );
    return result(this.name, {
      new_status: status,
      lead_email: event.leadEmail,
      reason: "lead backend disabled",
    });
  }
}

export class RedisLeadUpdater implements LeadUpdater {
  readonly name = "redis";
  private readonly client: Redis;
  private readonly keyPrefix: string;

  constructor(client: Redis, keyPrefix: string) {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  private key(recipient: string): string {
    return `${this.keyPrefix}:lead:${recipient.toLowerCase()}`;
  }

  async apply(event: InboundEvent): Promise<LeadResult> {
    const status = event.status;
    // 用 leadEmail 而不是收件人：收信事件里线索在 from 侧
    const recipient = event.leadEmail;
    if (!status) return result(this.name, { reason: "event type has no status mapping" });
    if (!recipient) {
      return result(this.name, { new_status: status, reason: "event carries no lead address" });
    }

    const key = this.key(recipient);
    const current = await this.client.hget(key, "status");
    if (!isUpgrade(current, status)) {
      return result(this.name, {
        matched: true,
        previous_status: current,
        new_status: status,
        lead_email: recipient,
        reason: `status ${status} does not supersede ${current}`,
      });
    }

    await this.client.hset(key, {
      status,
      email_id: event.emailId,
      event_type: event.eventType,
      updated_at: nowIso(),
    });
    return result(this.name, {
      matched: true,
      updated: true,
      previous_status: current,
      new_status: status,
      lead_email: recipient,
    });
  }
}

/** Postgres 标识符引用。表名列名来自配置，必须转义后再拼进 SQL。 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PostgresLeadUpdater implements LeadUpdater {
  readonly name = "postgres";
  private readonly settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  async apply(event: InboundEvent): Promise<LeadResult> {
    const s = this.settings;
    const status = event.status;
    const recipient = event.leadEmail;
    if (!status) return result(this.name, { reason: "event type has no status mapping" });
    if (!recipient) {
      return result(this.name, { new_status: status, reason: "event carries no lead address" });
    }

    const table = ident(s.leadTable);
    const emailCol = ident(s.leadEmailColumn);
    const statusCol = ident(s.leadStatusColumn);

    const { rows } = await query<Record<string, string | null>>(
      `SELECT ${statusCol} AS status FROM ${table} WHERE ${emailCol} = $1 LIMIT 1`,
      [recipient],
    );
    const row = rows[0];
    if (row === undefined) {
      return result(this.name, { new_status: status, reason: "no matching lead" });
    }

    const current = row["status"] ?? null;
    if (!isUpgrade(current, status)) {
      return result(this.name, {
        matched: true,
        previous_status: current,
        new_status: status,
        reason: `status ${status} does not supersede ${current}`,
      });
    }

    const assignments = [`${statusCol} = $1`];
    const params: unknown[] = [status];
    if (s.leadUpdatedColumn) {
      assignments.push(`${ident(s.leadUpdatedColumn)} = clock_timestamp()`);
    }
    params.push(recipient);
    const { rowCount } = await query(
      `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${emailCol} = $${params.length}`,
      params,
    );

    return result(this.name, {
      matched: true,
      updated: (rowCount ?? 0) > 0,
      previous_status: current,
      new_status: status,
      lead_email: recipient,
    });
  }
}

export function buildLeadUpdater(settings: Settings, redisClient: Redis | null): LeadUpdater {
  const backend = settings.leadBackend;

  if (backend === "redis") {
    if (redisClient === null) {
      logger.warn("LEAD_BACKEND=redis 但 REDIS_ADDR 未配置，回落到 noop");
      return new NoopLeadUpdater();
    }
    return new RedisLeadUpdater(redisClient, settings.redisKeyPrefix);
  }

  if (backend === "postgres") {
    if (!settings.leadTable) {
      logger.warn("LEAD_BACKEND=postgres 但 LEAD_TABLE 未配置，回落到 noop");
      return new NoopLeadUpdater();
    }
    return new PostgresLeadUpdater(settings);
  }

  return new NoopLeadUpdater();
}
