import { prisma } from "../prisma";

/**
 * 测试期只读调试接口：把 9 张业务表的数据汇总成一个 JSON，按表名分组。
 *
 *   GET  /api/admin/whatsapp/debugTableList   （POST 同样可用，便于带 body 过滤）
 *   配套 POST /api/admin/whatsapp/debugCleanup
 *
 * 返回结构：顶层就是表名（`Customer` / `Conversation` / ...），另有 `_meta` 放元信息。
 *
 * 凭据类字段**固定脱敏**（FeishuApp.appSecret / verificationToken / encryptKey、
 * WabaOnboarding.onboardingUrl）—— 这个接口无鉴权，整包吐密钥会把凭据直接暴露出去；
 * 需要明文时再单独说，不要为此把开关放到请求里。
 */

export const DEBUG_TABLE_NAMES = [
  "Customer",
  "Conversation",
  "Message",
  "WebhookEvent",
  "PlatformThread",
  "WabaPhone",
  "WabaOnboarding",
  "FeishuApp",
  "AppSetting",
] as const;

export type DebugTableName = (typeof DEBUG_TABLE_NAMES)[number];

const MAX_LIMIT = 5000;

export const DEBUG_REDACTED_FIELDS: Record<string, string[]> = {
  FeishuApp: ["appSecret", "verificationToken", "encryptKey"],
  WabaOnboarding: ["onboardingUrl"],
};

export class AdminDebugTablesError extends Error {
  readonly statusCode: number;
  readonly code = "DEBUG_INVALID_INPUT" as const;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AdminDebugTablesError";
    this.statusCode = statusCode;
  }
}

type Row = Record<string, unknown>;

function redactRow(table: DebugTableName, row: Row): Row {
  const fields = DEBUG_REDACTED_FIELDS[table];
  if (!fields) return row;
  const next: Row = { ...row };
  for (const field of fields) {
    const value = next[field];
    if (value !== null && value !== undefined && value !== "") next[field] = "[redacted]";
  }
  return next;
}

async function loadTable(table: DebugTableName, take?: number): Promise<Row[]> {
  const args: { take?: number } = take ? { take } : {};
  switch (table) {
    case "Customer":
      return (await prisma.customer.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "Conversation":
      return (await prisma.conversation.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "Message":
      return (await prisma.message.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "WebhookEvent":
      return (await prisma.webhookEvent.findMany({
        ...args,
        orderBy: { receivedAt: "desc" },
      })) as unknown as Row[];
    case "PlatformThread":
      return (await prisma.platformThread.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "WabaPhone":
      return (await prisma.wabaPhone.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "WabaOnboarding":
      return (await prisma.wabaOnboarding.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "FeishuApp":
      return (await prisma.feishuApp.findMany({
        ...args,
        orderBy: { createdAt: "desc" },
      })) as unknown as Row[];
    case "AppSetting":
      return (await prisma.appSetting.findMany({
        ...args,
        orderBy: { key: "asc" },
      })) as unknown as Row[];
    default:
      return [];
  }
}

type NormalizedDebugQuery = { tables?: DebugTableName[]; limit?: number };

function normalizeInput(input: unknown): NormalizedDebugQuery {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdminDebugTablesError("query/body must be an object (or empty)", 400);
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set(["tables", "limit"]);
  const unknownField = Object.keys(body).find((key) => !allowed.has(key));
  if (unknownField) {
    throw new AdminDebugTablesError(
      `unsupported field "${unknownField}"; allowed: tables, limit`,
      400,
    );
  }

  let tables: DebugTableName[] | undefined;
  if (body.tables !== undefined) {
    const list = Array.isArray(body.tables)
      ? body.tables
      : typeof body.tables === "string"
        ? body.tables.split(",")
        : null;
    if (!list) {
      throw new AdminDebugTablesError("tables must be an array or comma-separated string", 400);
    }
    const names = list.map((item) => String(item).trim()).filter(Boolean);
    const unknown = names.filter((name) => !(DEBUG_TABLE_NAMES as readonly string[]).includes(name));
    if (unknown.length) {
      throw new AdminDebugTablesError(`unknown table(s): ${unknown.join(", ")}`, 400);
    }
    tables = names as DebugTableName[];
  }

  let limit: number | undefined;
  if (body.limit !== undefined) {
    const value = Number(body.limit);
    if (!Number.isInteger(value) || value <= 0 || value > MAX_LIMIT) {
      throw new AdminDebugTablesError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
    }
    limit = value;
  }

  return { tables, limit };
}

/** 按表名汇总全部（或指定的）表数据。默认不截断，可按 `limit` 每表取前 N 行。 */
export async function listAllDebugTables(input: unknown) {
  const { tables, limit } = normalizeInput(input);
  const wanted: DebugTableName[] = tables && tables.length ? tables : [...DEBUG_TABLE_NAMES];

  const grouped: Record<string, Row[]> = {};
  const counts: Record<string, number> = {};
  for (const table of wanted) {
    const rows = await loadTable(table, limit);
    grouped[table] = rows.map((row) => redactRow(table, row));
    counts[table] = rows.length;
  }

  return {
    _meta: {
      ok: true as const,
      schema: process.env.DATABASE_SCHEMA?.trim() || "public",
      generatedAt: new Date().toISOString(),
      tableCount: wanted.length,
      rowCount: Object.values(counts).reduce((sum, n) => sum + n, 0),
      limit: limit ?? null,
      counts,
      redactedFields: DEBUG_REDACTED_FIELDS,
    },
    ...grouped,
  };
}
