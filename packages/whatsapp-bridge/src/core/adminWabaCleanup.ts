import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

/**
 * 测试期 WhatsApp Bridge 数据清理。
 *
 * 默认清的都是运行期数据：消息、会话、买家、webhook 幂等记录、WABA/手机号绑定。
 * 默认**不清** FeishuApp / AppSetting（它们存凭据或全局配置，误删会让整套桥接失联）。
 *
 * 安全分层：
 *   1) 路由层要求 WHATSAPP_ALLOW_DB_CLEANUP=1 + 独立 X-WhatsApp-Cleanup-Token；
 *   2) 本模块默认 dryRun=true，只返回会删多少；
 *   3) 真删必须 confirm 精确匹配；includeConfig 有更强确认串；
 *   4) 可传 supplierId，只清一个测试租户，避免把其他人的测试一锅端。
 */

export const CLEANUP_CONFIRM = "DELETE_WHATSAPP_TEST_DATA";
export const CLEANUP_WITH_CONFIG_CONFIRM = "DELETE_WHATSAPP_TEST_DATA_AND_CONFIG";

export class AdminWabaCleanupError extends Error {
  readonly statusCode: number;
  readonly code:
    | "CLEANUP_INVALID_INPUT"
    | "CLEANUP_CONFIRMATION_REQUIRED"
    | "CLEANUP_CONFIG_REQUIRES_GLOBAL";

  constructor(
    code: AdminWabaCleanupError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "AdminWabaCleanupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type CleanupDb = Pick<
  Prisma.TransactionClient,
  | "message"
  | "platformThread"
  | "conversation"
  | "customer"
  | "webhookEvent"
  | "wabaPhone"
  | "wabaOnboarding"
  | "feishuApp"
  | "appSetting"
>;

export type WhatsappCleanupCounts = {
  messages: number;
  platformThreads: number;
  conversations: number;
  customers: number;
  webhookEvents: number;
  wabaPhones: number;
  wabaOnboardings: number;
  feishuApps: number;
  appSettings: number;
};

type NormalizedCleanup = {
  supplierId?: string;
  dryRun: boolean;
  includeConfig: boolean;
};

function emptyCounts(): WhatsappCleanupCounts {
  return {
    messages: 0,
    platformThreads: 0,
    conversations: 0,
    customers: 0,
    webhookEvents: 0,
    wabaPhones: 0,
    wabaOnboardings: 0,
    feishuApps: 0,
    appSettings: 0,
  };
}

function normalizeCleanupInput(input: unknown): NormalizedCleanup {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdminWabaCleanupError(
      "CLEANUP_INVALID_INPUT",
      "request body must be a JSON object",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["supplierId", "dryRun", "confirm", "includeConfig"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new AdminWabaCleanupError(
      "CLEANUP_INVALID_INPUT",
      "request body contains unsupported fields",
      400,
    );
  }

  const supplierId = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  if (
    supplierId &&
    (supplierId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(supplierId))
  ) {
    throw new AdminWabaCleanupError(
      "CLEANUP_INVALID_INPUT",
      "supplierId must be a valid tenant identifier when provided",
      400,
    );
  }

  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw new AdminWabaCleanupError("CLEANUP_INVALID_INPUT", "dryRun must be boolean", 400);
  }
  if (body.includeConfig !== undefined && typeof body.includeConfig !== "boolean") {
    throw new AdminWabaCleanupError(
      "CLEANUP_INVALID_INPUT",
      "includeConfig must be boolean",
      400,
    );
  }
  if (body.confirm !== undefined && typeof body.confirm !== "string") {
    throw new AdminWabaCleanupError("CLEANUP_INVALID_INPUT", "confirm must be string", 400);
  }

  const dryRun = body.dryRun !== false;
  const includeConfig = body.includeConfig === true;
  if (includeConfig && supplierId) {
    throw new AdminWabaCleanupError(
      "CLEANUP_CONFIG_REQUIRES_GLOBAL",
      "includeConfig=true only supports global cleanup; never delete shared credentials in supplier scope",
      400,
    );
  }

  if (!dryRun) {
    const expected = includeConfig ? CLEANUP_WITH_CONFIG_CONFIRM : CLEANUP_CONFIRM;
    if (body.confirm !== expected) {
      throw new AdminWabaCleanupError(
        "CLEANUP_CONFIRMATION_REQUIRED",
        `set confirm to ${expected} before destructive cleanup`,
        400,
      );
    }
  }

  return { supplierId: supplierId || undefined, dryRun, includeConfig };
}

function scopeWhere(supplierId?: string) {
  return supplierId ? { supplierId } : {};
}

async function countData(db: CleanupDb, input: NormalizedCleanup): Promise<WhatsappCleanupCounts> {
  const supplierId = input.supplierId;
  const counts = emptyCounts();
  counts.messages = await db.message.count({ where: scopeWhere(supplierId) });
  counts.platformThreads = await db.platformThread.count({
    where: supplierId ? { conversation: { supplierId } } : {},
  });
  counts.conversations = await db.conversation.count({ where: scopeWhere(supplierId) });
  counts.customers = await db.customer.count({ where: scopeWhere(supplierId) });
  counts.webhookEvents = await db.webhookEvent.count({ where: scopeWhere(supplierId) });
  counts.wabaPhones = await db.wabaPhone.count({ where: scopeWhere(supplierId) });
  counts.wabaOnboardings = await db.wabaOnboarding.count({
    where: supplierId ? { partnerCustomerId: supplierId } : {},
  });
  if (input.includeConfig) {
    counts.feishuApps = await db.feishuApp.count();
    counts.appSettings = await db.appSetting.count();
  }
  return counts;
}

async function deleteData(
  db: CleanupDb,
  input: NormalizedCleanup,
): Promise<WhatsappCleanupCounts> {
  const supplierId = input.supplierId;
  const deleted = emptyCounts();

  // FK 顺序：Message/PlatformThread → Conversation → Customer。
  deleted.messages = (await db.message.deleteMany({ where: scopeWhere(supplierId) })).count;
  deleted.platformThreads = (
    await db.platformThread.deleteMany({
      where: supplierId ? { conversation: { supplierId } } : {},
    })
  ).count;
  deleted.conversations = (
    await db.conversation.deleteMany({ where: scopeWhere(supplierId) })
  ).count;
  deleted.customers = (await db.customer.deleteMany({ where: scopeWhere(supplierId) })).count;

  // 独立运行数据与路由/绑定。
  deleted.webhookEvents = (
    await db.webhookEvent.deleteMany({ where: scopeWhere(supplierId) })
  ).count;
  deleted.wabaPhones = (
    await db.wabaPhone.deleteMany({ where: scopeWhere(supplierId) })
  ).count;
  deleted.wabaOnboardings = (
    await db.wabaOnboarding.deleteMany({
      where: supplierId ? { partnerCustomerId: supplierId } : {},
    })
  ).count;

  // 凭据与全局 KV 默认保留；只有全局清理 + 更强确认串时才进这里。
  if (input.includeConfig) {
    deleted.feishuApps = (await db.feishuApp.deleteMany()).count;
    deleted.appSettings = (await db.appSetting.deleteMany()).count;
  }

  return deleted;
}

/**
 * 预览或执行 WhatsApp Bridge 数据清理。
 * 路由层负责环境开关与 cleanup token；本模块只负责输入、确认串、事务与删除顺序。
 */
export async function cleanupWhatsappData(input: unknown) {
  const normalized = normalizeCleanupInput(input);
  const scope = normalized.supplierId ? { supplierId: normalized.supplierId } : { all: true };
  const preview = await countData(prisma, normalized);

  if (normalized.dryRun) {
    return {
      ok: true as const,
      dryRun: true as const,
      scope,
      includeConfig: normalized.includeConfig,
      wouldDelete: preview,
      note: "dry-run only; send dryRun:false with the required confirm string to delete",
    };
  }

  const deleted = await prisma.$transaction(
    async (tx) => deleteData(tx, normalized),
    { isolationLevel: "Serializable" },
  );

  return {
    ok: true as const,
    dryRun: false as const,
    scope,
    includeConfig: normalized.includeConfig,
    preview,
    deleted,
  };
}
