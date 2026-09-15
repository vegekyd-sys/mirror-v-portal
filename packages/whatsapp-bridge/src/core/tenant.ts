import { prisma } from "../prisma";
import { toE164 } from "../lib/phone";

export class TenantContextError extends Error {
  readonly code: "TENANT_CONTEXT_REQUIRED" | "TENANT_CONTEXT_CONFLICT" | "TENANT_CONTEXT_INVALID";
  readonly statusCode = 400;

  constructor(code: TenantContextError["code"], message: string) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
  }
}

export class WabaTenantError extends Error {
  readonly code: "WABA_TENANT_MISMATCH" | "WABA_TENANT_AMBIGUOUS" | "WABA_PHONE_BINDING_MISSING";
  readonly statusCode: number;

  constructor(code: WabaTenantError["code"], message: string, statusCode = 403) {
    super(message);
    this.name = "WabaTenantError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function resolveTenantContext(input: {
  partnerCustomerId?: string;
  supplierId?: string;
}): string {
  const partnerCustomerId = input.partnerCustomerId?.trim() || "";
  const supplierId = input.supplierId?.trim() || "";
  if (partnerCustomerId && supplierId && partnerCustomerId !== supplierId) {
    throw new TenantContextError(
      "TENANT_CONTEXT_CONFLICT",
      "partnerCustomerId 与 supplierId 不一致",
    );
  }
  const tenantId = partnerCustomerId || supplierId;
  if (!tenantId) {
    throw new TenantContextError(
      "TENANT_CONTEXT_REQUIRED",
      "缺少租户上下文：请显式传入 partnerCustomerId 或 supplierId",
    );
  }
  if (tenantId.length > 128) {
    throw new TenantContextError("TENANT_CONTEXT_INVALID", "租户 ID 过长（最多 128 字符）");
  }
  return tenantId;
}

type WabaOwnerRow = {
  wabaId: string | null;
  partnerCustomerId: string;
  status: string;
};

export function selectTenantOwnedWaba(
  supplierId: string,
  wabaId: string,
  rows: WabaOwnerRow[],
): WabaOwnerRow {
  const connected = rows.filter((row) => row.wabaId === wabaId && row.status === "CONNECTED");
  const owners = new Set(connected.map((row) => row.partnerCustomerId));
  // 共享 WABA：一个 WABA 多个 CONNECTED owner 是正常状态，不再据 owner 数量判冲突，
  // 只要求调用方自己确实在 owner 里。
  if (!owners.has(supplierId)) {
    throw new WabaTenantError(
      "WABA_TENANT_MISMATCH",
      "该 wabaId 未绑定到当前租户，或绑定尚未处于 CONNECTED 状态",
    );
  }
  return connected.find((row) => row.partnerCustomerId === supplierId)!;
}

export async function assertTenantOwnsWaba(supplierId: string, wabaIdRaw: string) {
  const wabaId = wabaIdRaw.trim();
  const rows = await prisma.wabaOnboarding.findMany({
    where: { wabaId },
    select: { wabaId: true, partnerCustomerId: true, status: true },
  });
  return selectTenantOwnedWaba(supplierId, wabaId, rows);
}

export function selectConversationWaba(
  supplierId: string,
  candidateWabaIds: string[],
  rows: WabaOwnerRow[],
): string {
  const candidates = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.wabaId &&
            candidateWabaIds.includes(row.wabaId) &&
            row.partnerCustomerId === supplierId &&
            row.status === "CONNECTED",
        )
        .map((row) => row.wabaId as string),
    ),
  ];
  if (candidates.length === 0) {
    throw new WabaTenantError(
      "WABA_PHONE_BINDING_MISSING",
      "该会话的企业号未绑定到当前租户的 CONNECTED WABA",
      409,
    );
  }
  if (candidates.length > 1) {
    throw new WabaTenantError(
      "WABA_TENANT_AMBIGUOUS",
      "该会话企业号匹配多个当前租户 WABA，已拒绝回发",
      409,
    );
  }
  // 共享 WABA（2026-09-15）：一个 WABA 会有多个 CONNECTED 的 supplier，
  // 所以**不再**因「该 WABA 还有别的 owner」拒绝回发 —— 隔离由手机号级归属保证
  // （能走到这里，已确认该企业号属于本 supplier）。
  return candidates[0];
}

export async function resolveConversationWabaId(
  supplierIdRaw: string | null | undefined,
  businessPhoneRaw: string,
): Promise<string> {
  const supplierId = supplierIdRaw?.trim();
  if (!supplierId) {
    throw new TenantContextError(
      "TENANT_CONTEXT_REQUIRED",
      "该会话缺少 supplierId，无法安全解析 WABA",
    );
  }
  const businessPhone = toE164(businessPhoneRaw);
  if (!businessPhone) {
    throw new WabaTenantError(
      "WABA_PHONE_BINDING_MISSING",
      "该会话缺少有效企业号，无法安全解析 WABA",
      409,
    );
  }

  const phoneRows = await prisma.wabaPhone.findMany({
    where: { phoneNumber: businessPhone },
    select: { wabaId: true },
  });
  const candidateWabaIds = [...new Set(phoneRows.map((row) => row.wabaId))];
  if (!candidateWabaIds.length) {
    throw new WabaTenantError(
      "WABA_PHONE_BINDING_MISSING",
      "该会话企业号尚未建立 WABA 映射",
      409,
    );
  }
  const rows = await prisma.wabaOnboarding.findMany({
    where: { wabaId: { in: candidateWabaIds } },
    select: { wabaId: true, partnerCustomerId: true, status: true },
  });
  return selectConversationWaba(supplierId, candidateWabaIds, rows);
}

export function webhookTenantKey(supplierId?: string, fallbackScope?: string): string {
  const tenant = supplierId?.trim();
  if (tenant) return `supplier:${tenant}`;
  const fallback = fallbackScope?.trim();
  return fallback ? `scope:${fallback}` : "legacy";
}
