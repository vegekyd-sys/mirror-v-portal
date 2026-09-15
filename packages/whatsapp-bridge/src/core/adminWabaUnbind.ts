import { prisma } from "../prisma";
import { lockWabaOwnershipKeys } from "./wabaOwnershipLock";

/**
 * 解绑手机号（手机号级归属，2026-09-15 决策）。
 *
 * 语义：
 *   · **只停路由** —— 删掉我方 `WabaPhone` 归属行，不调用 YCloud/Meta 释放号码（那不可逆）。
 *   · **只能解绑自己的号** —— 别人的号一律拒绝并且**不做任何改动**（隔离硬要求）。
 *   · **幂等**：没有归属行的号不算失败，进 `notBound` —— 终态与解绑一致
 *     （该号不再路由给本租户），没有理由报错让调用方重试。
 *     注意这里**只能说「当前没有绑定」**：归属行删掉之后不留 tombstone，
 *     「本租户解绑过」和「从来没绑过」在库里无法区分，别对外说成「已解绑」。
 *   · 逐个处理：本次真的删掉的进 `unbound`，别家的号进 `rejected`（带原因），互不影响。
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

  const result = await prisma.$transaction(
    async (tx) => {
      // 加锁顺序：先 phone（请求里就有）→ 读库反查 waba → 再锁 waba。
      // 与 import 的 phone→waba 顺序一致，否则并发 import/unbind 会 ABBA 死锁。
      await lockWabaOwnershipKeys(tx, [], normalized.phoneNumbers);

      // 归属判定必须读**锁之后**的状态：事务外的快照会在并发绑定/解绑下
      // 把自己的号误判成 not_bound。
      const existing = await tx.wabaPhone.findMany({
        where: { phoneNumber: { in: normalized.phoneNumbers } },
        select: { phoneNumber: true, wabaId: true, supplierId: true },
      });
      const byPhone = new Map(existing.map((row) => [row.phoneNumber, row]));

      const unbound: string[] = [];
      const notBound: string[] = [];
      const rejected: Array<{ phoneNumber: string; reason: string }> = [];

      for (const phoneNumber of normalized.phoneNumbers) {
        const row = byPhone.get(phoneNumber);
        if (!row) {
          // 没有归属行 = 已经不路由给本租户，正是解绑要达到的终态 → 幂等成功。
          // 但只登记「当前没绑」这个事实，不推断它曾经绑过。
          notBound.push(phoneNumber);
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

      // 只有**真的解掉了号**的 WABA 才需要重算连接状态：全部 rejected 时不做任何改动。
      const touchedWabaIds = [
        ...new Set(
          unbound
            .map((phoneNumber) => byPhone.get(phoneNumber)?.wabaId)
            .filter((wabaId): wabaId is string => Boolean(wabaId)),
        ),
      ].sort();

      const disconnected: string[] = [];
      if (touchedWabaIds.length) {
        await lockWabaOwnershipKeys(tx, touchedWabaIds, []);
        // 该 supplier 在这些 WABA 上已无号 → 置 DISCONNECTED（否则 /wabas 仍显示已连接）
        for (const wabaId of touchedWabaIds) {
          const remaining = await tx.wabaPhone.count({
            where: { wabaId, supplierId: normalized.partnerCustomerId },
          });
          if (remaining > 0) continue;
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

      return { unbound, notBound, rejected, disconnected };
    },
    { isolationLevel: "Serializable" },
  );

  return {
    // 只有「别家的号」才算失败；重复解绑是成功。
    ok: result.rejected.length === 0,
    partnerCustomerId: normalized.partnerCustomerId,
    unbound: result.unbound,
    /** 本次请求时就没有归属行的号。不是失败（终态与 unbound 一致），
     *  但也**不等于**「本租户解绑过」—— 调用方要如实说成「当前未绑定」。 */
    notBound: result.notBound,
    rejected: result.rejected,
    // 只回数量，不回 wabaId —— 与「不对外暴露 WABA 标识」的既有口径一致
    disconnected: result.disconnected.length,
  };
}
