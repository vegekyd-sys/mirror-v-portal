/**
 * 代理邮箱 → 飞书通知渠道 的绑定表。
 *
 * 一个代理邮箱（如 thia@mail.dealclaw.io）绑定一套飞书凭据 + 群 ID。
 * 事件到达时按 event.agentEmail 反查，命中就用对应渠道发；
 * 查不到就回落到全局的自定义机器人 webhook。
 *
 * 字段一律 snake_case —— 它同时是 `/bindings` 接口的出参形状，不能改名。
 */

import { query } from "./db/pool.js";
import { logger } from "./logger.js";

/** 飞书用户 Open ID：ou_ 前缀 + 字母数字。空值表示不 @。 */
export function isValidMentionOpenId(value: string): boolean {
  return !value || /^ou_[a-zA-Z0-9]+$/.test(value);
}

function hint(secret: string): string {
  if (!secret) return "";
  return secret.length >= 12 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : "(已设置)";
}

/**
 * 一个代理邮箱可以同时配两种通道，用 prefer 决定优先走哪个。
 *
 * 自定义机器人：webhook URL + 负责人 Open ID（+ 可选验签码）。
 * 应用机器人：一套凭据能发任意群，适合以后按群细分。
 */
export interface Binding {
  agent_email: string;
  /** 所属供应商（租户）。一个代理邮箱只归一家，跨租户操作会被拒。 */
  supplier_id: string;
  webhook_url: string;
  /** 飞书机器人「签名校验」的密钥，没开就留空 */
  webhook_secret: string;
  app_id: string;
  app_secret: string;
  chat_id: string;
  /** 两个都配了时用哪个：custom / app */
  prefer: string;
  /** 卡片中要 @ 的负责人 Open ID（ou_ 开头） */
  mention_open_id: string;
  note: string;
  updated_at: string;
}

export function makeBinding(init: Partial<Binding> & { agent_email: string }): Binding {
  return {
    agent_email: init.agent_email,
    supplier_id: init.supplier_id ?? "",
    webhook_url: init.webhook_url ?? "",
    webhook_secret: init.webhook_secret ?? "",
    app_id: init.app_id ?? "",
    app_secret: init.app_secret ?? "",
    chat_id: init.chat_id ?? "",
    prefer: init.prefer ?? "custom",
    mention_open_id: init.mention_open_id ?? "",
    note: init.note ?? "",
    updated_at: init.updated_at ?? "",
  };
}

export function hasCustom(b: Binding): boolean {
  return Boolean(b.webhook_url);
}

export function hasApp(b: Binding): boolean {
  return Boolean(b.app_id && b.app_secret && b.chat_id);
}

/** 实际会走的通道。首选不可用时自动回落到另一个。 */
export function channelOf(b: Binding): "custom" | "app" | "none" {
  if (b.prefer === "app" && hasApp(b)) return "app";
  if (b.prefer === "custom" && hasCustom(b)) return "custom";
  if (hasCustom(b)) return "custom";
  if (hasApp(b)) return "app";
  return "none";
}

/** 对外展示用：两个密钥都只留前后几位。字段顺序保持与历史接口一致。 */
export function publicBinding(b: Binding): Record<string, unknown> {
  // webhook URL 尾部的 token 也是敏感的，只留前缀
  const url = b.webhook_url || "";
  const maskedUrl = url
    ? url.includes("/")
      ? `${url.slice(0, url.lastIndexOf("/") + 1)}…`
      : "…"
    : "";
  return {
    agent_email: b.agent_email,
    supplier_id: b.supplier_id,
    webhook_url: maskedUrl,
    app_id: b.app_id,
    chat_id: b.chat_id,
    prefer: b.prefer,
    mention_open_id: b.mention_open_id,
    note: b.note,
    updated_at: b.updated_at,
    webhook_secret_hint: hint(b.webhook_secret),
    app_secret_hint: hint(b.app_secret),
    channel: channelOf(b),
  };
}

const COLUMNS = `agent_email, supplier_id, webhook_url, webhook_secret, app_id,
                 app_secret, chat_id, prefer, mention_open_id, note, updated_at`;

interface Row {
  agent_email: string;
  supplier_id: string;
  webhook_url: string;
  webhook_secret: string;
  app_id: string;
  app_secret: string;
  chat_id: string;
  prefer: string;
  mention_open_id: string;
  note: string;
  updated_at: Date;
}

function toBinding(row: Row): Binding {
  return {
    agent_email: row.agent_email,
    supplier_id: row.supplier_id,
    webhook_url: row.webhook_url,
    webhook_secret: row.webhook_secret,
    app_id: row.app_id,
    app_secret: row.app_secret,
    chat_id: row.chat_id,
    prefer: row.prefer,
    mention_open_id: row.mention_open_id,
    note: row.note,
    updated_at: row.updated_at.toISOString(),
  };
}

export class BindingStore {
  private ready: Promise<void> | null = null;

  /** 建表按需执行一次。没有独立的迁移文件，服务对着空库直接能起。 */
  private ensureTable(): Promise<void> {
    this.ready ??= (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS email_bindings (
          agent_email      VARCHAR(320) PRIMARY KEY,
          supplier_id      VARCHAR(64)  NOT NULL DEFAULT '',
          webhook_url      TEXT         NOT NULL DEFAULT '',
          webhook_secret   TEXT         NOT NULL DEFAULT '',
          app_id           VARCHAR(128) NOT NULL DEFAULT '',
          app_secret       TEXT         NOT NULL DEFAULT '',
          chat_id          VARCHAR(128) NOT NULL DEFAULT '',
          prefer           VARCHAR(16)  NOT NULL DEFAULT 'custom',
          mention_open_id  VARCHAR(128) NOT NULL DEFAULT '',
          note             TEXT         NOT NULL DEFAULT '',
          updated_at       TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await query(
        `CREATE INDEX IF NOT EXISTS idx_email_bindings_supplier ON email_bindings(supplier_id)`,
      );
    })();
    return this.ready;
  }

  async get(agentEmail: string): Promise<Binding | null> {
    if (!agentEmail) return null;
    await this.ensureTable();
    const { rows } = await query<Row>(
      `SELECT ${COLUMNS} FROM email_bindings WHERE agent_email = $1`,
      [agentEmail.trim().toLowerCase()],
    );
    const row = rows[0];
    return row ? toBinding(row) : null;
  }

  async all(): Promise<Binding[]> {
    await this.ensureTable();
    const { rows } = await query<Row>(`SELECT ${COLUMNS} FROM email_bindings ORDER BY agent_email`);
    return rows.map(toBinding);
  }

  /** 只取某个供应商名下的绑定。租户隔离全靠这一层。 */
  async allFor(supplierId: string): Promise<Binding[]> {
    await this.ensureTable();
    const { rows } = await query<Row>(
      `SELECT ${COLUMNS} FROM email_bindings WHERE supplier_id = $1 ORDER BY agent_email`,
      [supplierId],
    );
    return rows.map(toBinding);
  }

  /** 取绑定并校验归属；不属于该供应商时当作不存在，避免泄露他人邮箱是否已绑定。 */
  async getOwned(agentEmail: string, supplierId: string): Promise<Binding | null> {
    const binding = await this.get(agentEmail);
    if (binding === null || binding.supplier_id !== supplierId) return null;
    return binding;
  }

  /** /health 用。只要计数和「有没有配 @ 人」，不必把整表拉出来。 */
  async stats(): Promise<{ count: number; anyMention: boolean }> {
    await this.ensureTable();
    const { rows } = await query<{ count: string; any_mention: boolean }>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(BOOL_OR(mention_open_id <> ''), FALSE) AS any_mention
       FROM email_bindings`,
    );
    const row = rows[0];
    return {
      count: row ? Number.parseInt(row.count, 10) : 0,
      anyMention: row ? row.any_mention : false,
    };
  }

  /** 新增或整条覆盖。同一个 agent_email 再次提交即覆盖（与历史行为一致）。 */
  async put(binding: Binding): Promise<Binding> {
    await this.ensureTable();
    const email = binding.agent_email.trim().toLowerCase();
    const { rows } = await query<Row>(
      `INSERT INTO email_bindings (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, clock_timestamp())
       ON CONFLICT (agent_email) DO UPDATE SET
         supplier_id = EXCLUDED.supplier_id,
         webhook_url = EXCLUDED.webhook_url,
         webhook_secret = EXCLUDED.webhook_secret,
         app_id = EXCLUDED.app_id,
         app_secret = EXCLUDED.app_secret,
         chat_id = EXCLUDED.chat_id,
         prefer = EXCLUDED.prefer,
         mention_open_id = EXCLUDED.mention_open_id,
         note = EXCLUDED.note,
         updated_at = clock_timestamp()
       RETURNING ${COLUMNS}`,
      [
        email,
        binding.supplier_id,
        binding.webhook_url,
        binding.webhook_secret,
        binding.app_id,
        binding.app_secret,
        binding.chat_id,
        binding.prefer,
        binding.mention_open_id,
        binding.note,
      ],
    );
    const saved = toBinding(rows[0] as Row);
    logger.info(`绑定已保存: ${saved.agent_email} -> chat ${saved.chat_id}`);
    return saved;
  }

  async delete(agentEmail: string): Promise<boolean> {
    await this.ensureTable();
    const key = agentEmail.trim().toLowerCase();
    const { rowCount } = await query(`DELETE FROM email_bindings WHERE agent_email = $1`, [key]);
    if (!rowCount) return false;
    logger.info(`绑定已删除: ${key}`);
    return true;
  }

  /** 删除某供应商名下全部绑定，返回删掉的条数。供 DELETE /suppliers/{id}?force 用。 */
  async deleteForSupplier(supplierId: string): Promise<number> {
    await this.ensureTable();
    const { rowCount } = await query(`DELETE FROM email_bindings WHERE supplier_id = $1`, [
      supplierId,
    ]);
    return rowCount ?? 0;
  }
}
