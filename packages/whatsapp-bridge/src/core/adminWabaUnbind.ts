import { prisma } from "../prisma";
import { lockWabaOwnershipKeys } from "./wabaOwnershipLock";

/**
 * 解绑手机号（手机号级归属，2026-09-15 决策）。
 *
 * 语义：
 *   · **只停路由** —— 删掉我方 `WabaPhone` 归属行，不调用 YCloud/Meta 释放号码（那不可逆）。
 *   · **只能解绑自己的号** —— 别人的号一律拒绝并且**不做任何改动**（隔离硬要求）。
 *   · 逐个处理：成功进 `unbound`，失败进 `rejected`（带原因），互不影响。
 *   · 解掉某 supplier 在该 WABA 的最后一个号后，把它的 onboarding 置 DISCONNECTED，
 *     否则 `GET /api/whatsapp/wabas` 还会显示 CONNECTED。
 */

export class AdminWabaUnbindError extends Error {
  readonly statusCode: number;
  readonly code: "ADMIN_UNBIND_INVALID_INPUT";

  constructor(code: AdminWabaUnbindError["code"], message: string, statusCode: number) {
    super(message);
    this.name = "AdminWabaUnbindError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type NormalizedUnbind = {
  partnerCustomerId: string;
  phoneNumbers: string[];
};

function normalizePhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  const normalized = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : undefined;
}

function normalizeUnbindInput(input: unknown): NormalizedUnbind {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "request body must be a JSON object",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["partnerCustomerId", "phoneNumbers"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "request body contains unsupported fields",
      400,
    );
  }
  const partnerCustomerId =
    typeof body.partnerCustomerId === "string" ? body.partnerCustomerId.trim() : "";
  if (
    !partnerCustomerId ||
    partnerCustomerId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(partnerCustomerId)
  ) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "partnerCustomerId is required and must be a valid tenant identifier",
      400,
    );
  }
  const rawPhones = body.phoneNumbers;
  if (!Array.isArray(rawPhones) || rawPhones.length === 0) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "phoneNumbers is required and must be a non-empty array of E.164 numbers",
      400,
    );
  }
  const phoneNumbers = [
    ...new Set(
      rawPhones
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizePhone(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
  if (!phoneNumbers.length) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "phoneNumbers contains no valid E.164 number (example: +8615895553765)",
      400,
    );
  }
  return { partnerCustomerId, phoneNumbers };
}

export async function unbindWabaPhones(input: unknown) {
  const normalized = normalizeUnbindInput(input);

  const existing = await prisma.wabaPhone.findMany({
    where: { phoneNumber: { in: normalized.phoneNumbers } },
    select: { phoneNumber: true, wabaId: true, supplierId: true },
  });
  const byPhone = new Map(existing.map((row) => [row.phoneNumber, row]));
  // 归属校验放在事务外先算一遍给响应；真正的删除在事务内按锁定后的状态再确认一次。
  const targetWabaIds = new Set(existing.map((row) => row.wabaId));

  const result = await prisma.$transaction(
    async (tx) => {
      for (const wabaId of targetWabaIds) {
        await lockWabaOwnershipKeys(tx, wabaId, []);
      }
      await lockWabaOwnershipKeys(
        tx,
        [...targetWabaIds].sort()[0] || "unbind",
        normalized.phoneNumbers,
      );

      const unbound: string[] = [];
      const rejected: Array<{ phoneNumber: string; reason: string }> = [];

      for (const phoneNumber of normalized.phoneNumbers) {
        const row = byPhone.get(phoneNumber);
        if (!row) {
          rejected.push({ phoneNumber, reason: "not_bound" });
          continue;
        }
        // 隔离红线：只允许解绑自己绑过的号；别人的号连存在性都不对外暴露细节。
        if (row.supplierId !== normalized.partnerCustomerId) {
          rejected.push({ phoneNumber, reason: "not_owned_by_caller" });
          continue;
        }
        const deleted = await tx.wabaPhone.deleteMany({
          where: { phoneNumber, supplierId: normalized.partnerCustomerId },
        });
        if (deleted.count === 1) {
          unbound.push(phoneNumber);
        } else {
          rejected.push({ phoneNumber, reason: "not_owned_by_caller" });
        }
      }

      // 该 supplier 在这些 WABA 上已无号 → 置 DISCONNECTED（否则 /wabas 仍显示已连接）
      const disconnected: string[] = [];
      for (const wabaId of new Set(existing.map((row) => row.wabaId))) {
        const remaining = await tx.wabaPhone.count({
          where: { wabaId, supplierId: normalized.partnerCustomerId },
        });
        if (remaining === 0) {
          const updated = await tx.wabaOnboarding.updateMany({
            where: {
              wabaId,
              partnerCustomerId: normalized.partnerCustomerId,
              status: "CONNECTED",
            },
            data: { status: "DISCONNECTED" },
          });
          if (updated.count > 0) disconnected.push(wabaId);
        }
      }

      return { unbound, rejected, disconnected };
    },
    { isolationLevel: "Serializable" },
  );

  return {
    ok: result.rejected.length === 0,
    partnerCustomerId: normalized.partnerCustomerId,
    unbound: result.unbound,
    rejected: result.rejected,
    // 只回数量，不回 wabaId —— 与「不对外暴露 WABA 标识」的既有口径一致
    disconnected: result.disconnected.length,
  };
}
