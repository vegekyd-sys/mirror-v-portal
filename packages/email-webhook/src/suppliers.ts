/**
 * 供应商（租户）注册表。
 *
 * 系统会卖给多个客户，每个客户一个 supplier_id。绑定表按 supplier_id 隔离：
 * 一次调用只能看到和操作一家的数据。
 *
 * **supplier_id 不是凭据**，它只是范围标识。认证仍然靠全局的 X-Admin-Token
 * （由 openclaw 持有，用户身份由 openclaw 自己判断），所以 supplier_id 可以
 * 是可读的业务 ID，放日志和工单里都没问题。
 */

import { query } from "./db/pool.js";
import { logger } from "./logger.js";

/** 字母数字/下划线/短横，长度受限——避免被当作路径或注入。 */
export function isValidSupplierId(value: string): boolean {
  return Boolean(value) && value.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(value);
}

export interface Supplier {
  supplier_id: string;
  name: string;
  note: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function publicSupplier(s: Supplier): Record<string, unknown> {
  return { ...s };
}

interface Row {
  supplier_id: string;
  name: string;
  note: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toSupplier(row: Row): Supplier {
  return {
    supplier_id: row.supplier_id,
    name: row.name,
    note: row.note,
    active: row.active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const COLUMNS = `supplier_id, name, note, active, created_at, updated_at`;

export class SupplierStore {
  private ready: Promise<void> | null = null;

  private ensureTable(): Promise<void> {
    this.ready ??= (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS email_suppliers (
          supplier_id  VARCHAR(64)  PRIMARY KEY,
          name         TEXT         NOT NULL DEFAULT '',
          note         TEXT         NOT NULL DEFAULT '',
          active       BOOLEAN      NOT NULL DEFAULT TRUE,
          created_at   TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
          updated_at   TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp()
        )
      `);
    })();
    return this.ready;
  }

  async get(supplierId: string): Promise<Supplier | null> {
    if (!supplierId) return null;
    await this.ensureTable();
    const { rows } = await query<Row>(
      `SELECT ${COLUMNS} FROM email_suppliers WHERE supplier_id = $1`,
      [supplierId.trim()],
    );
    const row = rows[0];
    return row ? toSupplier(row) : null;
  }

  async all(): Promise<Supplier[]> {
    await this.ensureTable();
    const { rows } = await query<Row>(
      `SELECT ${COLUMNS} FROM email_suppliers ORDER BY supplier_id`,
    );
    return rows.map(toSupplier);
  }

  async count(): Promise<number> {
    await this.ensureTable();
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM email_suppliers`,
    );
    const row = rows[0];
    return row ? Number.parseInt(row.count, 10) : 0;
  }

  /**
   * 登记或更新。name/note 传空串时保留原值 —— 与历史行为一致，
   * 调用方只想改其中一项时不必把另一项也带上。
   */
  async upsert(supplierId: string, name = "", note = ""): Promise<Supplier> {
    await this.ensureTable();
    const id = supplierId.trim();
    const { rows } = await query<Row>(
      `INSERT INTO email_suppliers (supplier_id, name, note, created_at, updated_at)
       VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())
       ON CONFLICT (supplier_id) DO UPDATE SET
         name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE email_suppliers.name END,
         note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE email_suppliers.note END,
         updated_at = clock_timestamp()
       RETURNING ${COLUMNS}`,
      [id, name.trim(), note.trim()],
    );
    logger.info(`供应商已保存: ${id}`);
    return toSupplier(rows[0] as Row);
  }

  async setActive(supplierId: string, active: boolean): Promise<Supplier | null> {
    await this.ensureTable();
    const { rows } = await query<Row>(
      `UPDATE email_suppliers SET active = $2, updated_at = clock_timestamp()
       WHERE supplier_id = $1 RETURNING ${COLUMNS}`,
      [supplierId.trim(), active],
    );
    const row = rows[0];
    if (!row) return null;
    logger.info(`供应商 ${supplierId} 已${active ? "启用" : "停用"}`);
    return toSupplier(row);
  }

  async delete(supplierId: string): Promise<boolean> {
    await this.ensureTable();
    const { rowCount } = await query(`DELETE FROM email_suppliers WHERE supplier_id = $1`, [
      supplierId.trim(),
    ]);
    if (!rowCount) return false;
    logger.info(`供应商已删除: ${supplierId}`);
    return true;
  }
}
