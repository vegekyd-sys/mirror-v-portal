import { prisma } from "../prisma";
import { lockWabaOwnershipKeys } from "./wabaOwnershipLock";

/**
 * 解绑 supplierId ↔ wabaId（WABA 级归属，2026-09-16 回滚后的口径）。
 *
 * 语义：
 *   · **只解绑定** —— 把该租户在这个 WABA 上的 `CONNECTED` 行置为 `DISCONNECTED`。
 *     归属判定只认 `CONNECTED`（见 tenant.ts），所以置为 DISCONNECTED 就等于解绑生效。
 *   · **不碰手机号** —— 不删 `WabaPhone` 行（号码是 WABA 的映射，不归属某一家），
 *     也不调用 YCloud/Meta 释放号码（那是不可逆的外部动作）。
 *   · **只能解自己的绑定** —— 按 `partnerCustomerId` 收范围，别人的绑定一律不动。
 *   · **幂等** —— 重复解绑仍返回 200，只是如实回报「当前未绑定」/「已是解绑状态」。
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
  wabaId: string;
};

function normalizeUnbindInput(input: unknown): NormalizedUnbind {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "request body must be a JSON object",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["partnerCustomerId", "supplierId", "wabaId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "request body contains unsupported fields",
      400,
    );
  }

  // partnerCustomerId 是权威字段名；supplierId 是同一含义的别名，两边都给且不一致就拒绝。
  const partnerRaw = typeof body.partnerCustomerId === "string" ? body.partnerCustomerId.trim() : "";
  const supplierRaw = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  if (partnerRaw && supplierRaw && partnerRaw !== supplierRaw) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "partnerCustomerId 与 supplierId 不一致",
      400,
    );
  }
  const partnerCustomerId = partnerRaw || supplierRaw;
  if (
    !partnerCustomerId ||
    partnerCustomerId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(partnerCustomerId)
  ) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "partnerCustomerId (or supplierId) is required and must be a valid tenant identifier",
      400,
    );
  }

  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";
  // 与 adminWabaImport 同一套校验：Meta 业务标识是无符号十进制串。
  if (!/^[1-9]\d{4,31}$/.test(wabaId)) {
    throw new AdminWabaUnbindError(
      "ADMIN_UNBIND_INVALID_INPUT",
      "wabaId must be a 5-32 digit decimal identifier",
      400,
    );
  }

  return { partnerCustomerId, wabaId };
}

export type UnbindWabaResult = {
  ok: true;
  unbound: boolean;
  code: "WABA_UNBOUND" | "WABA_ALREADY_UNBOUND" | "WABA_NOT_BOUND";
  message: string;
  partnerCustomerId: string;
  wabaId: string;
  unboundRows: number;
  /** 明确回报：号码一律不动。 */
  phonesTouched: false;
};

/** 解绑当前租户与某个 WABA 的绑定（幂等）。 */
export async function unbindWabaTenant(input: unknown): Promise<UnbindWabaResult> {
  const { partnerCustomerId, wabaId } = normalizeUnbindInput(input);

  return prisma.$transaction(async (tx) => {
    // 与导入/认领共用同一把 WABA 级咨询锁，避免并发下互相踩。
    await lockWabaOwnershipKeys(tx, wabaId, []);

    const rows = await tx.wabaOnboarding.findMany({
      where: { wabaId, partnerCustomerId },
      select: { id: true, status: true },
    });

    const connectedIds = rows.filter((row) => row.status === "CONNECTED").map((row) => row.id);
    if (connectedIds.length === 0) {
      const existed = rows.length > 0;
      return {
        ok: true as const,
        unbound: false,
        code: existed ? ("WABA_ALREADY_UNBOUND" as const) : ("WABA_NOT_BOUND" as const),
        message: existed
          ? "该 WABA 与当前租户已是解绑状态"
          : "该 WABA 未绑定到当前租户（未绑定）",
        partnerCustomerId,
        wabaId,
        unboundRows: 0,
        phonesTouched: false as const,
      };
    }

    const updated = await tx.wabaOnboarding.updateMany({
      where: { id: { in: connectedIds } },
      data: { status: "DISCONNECTED" },
    });

    return {
      ok: true as const,
      unbound: true,
      code: "WABA_UNBOUND" as const,
      message: "已解绑该 WABA 与当前租户的绑定（号码未做任何改动）",
      partnerCustomerId,
      wabaId,
      unboundRows: updated.count,
      phonesTouched: false as const,
    };
  });
}
