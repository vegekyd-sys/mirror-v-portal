import { prisma } from "../prisma";
import { listWhatsAppPhones } from "../channel/whatsapp/ycloud";
import { lockWabaOwnershipKeys } from "./wabaOwnershipLock";

export class AdminWabaImportError extends Error {
  readonly statusCode: number;
  readonly code:
    | "ADMIN_IMPORT_INVALID_INPUT"
    | "ADMIN_IMPORT_INVALID_WABA"
    | "ADMIN_IMPORT_YCLOUD_FAILED"
    | "ADMIN_IMPORT_WABA_NOT_FOUND"
    | "ADMIN_IMPORT_WABA_OWNED"
    | "ADMIN_IMPORT_PHONE_CONFLICT"
    | "ADMIN_IMPORT_PHONES_REQUIRED"
    | "ADMIN_IMPORT_PHONE_NOT_ON_WABA"
    | "ADMIN_IMPORT_PHONE_OWNED_BY_OTHER_TENANT";

  constructor(
    code: AdminWabaImportError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "AdminWabaImportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type NormalizedImport = {
  partnerCustomerId: string;
  wabaId: string;
  /** 本次要绑定的手机号（E.164，如 +8615895553765）。
   *  必填：一个 WABA 可被多个 supplier 共享，归属只能落在手机号这一级。 */
  phoneNumbers: string[];
};

function normalizeImportInput(input: unknown): NormalizedImport {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_INVALID_INPUT",
      "request body must be a JSON object",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["partnerCustomerId", "wabaId", "phoneNumbers"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_INVALID_INPUT",
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
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_INVALID_INPUT",
      "partnerCustomerId is required and must be a valid tenant identifier",
      400,
    );
  }

  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";
  // Meta business identifiers are unsigned decimal strings. Keep them as strings to avoid
  // JavaScript precision loss and reject whitespace, signs, scientific notation, and leading 0.
  if (!/^[1-9]\d{4,31}$/.test(wabaId)) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_INVALID_WABA",
      "wabaId must be a 5-32 digit decimal identifier",
      400,
    );
  }
  // 手机号：必填且非空。一个号只能归一家 → 绑定必须明确到号（2026-09-15 决策）。
  const rawPhones = body.phoneNumbers;
  if (!Array.isArray(rawPhones) || rawPhones.length === 0) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_PHONES_REQUIRED",
      "phoneNumbers is required and must be a non-empty array of E.164 numbers",
      400,
    );
  }
  const phoneNumbers = [
    ...new Set(
      rawPhones
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeYCloudPhone(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
  if (!phoneNumbers.length) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_PHONES_REQUIRED",
      "phoneNumbers contains no valid E.164 number (example: +8615895553765)",
      400,
    );
  }

  return { partnerCustomerId, wabaId, phoneNumbers };
}

function normalizeYCloudPhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  const normalized = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : undefined;
}

/**
 * Operator-only recovery path for a WABA already visible to the configured YCloud account.
 * The public result deliberately contains no WABA identifier.
 */
export async function importExistingWaba(input: unknown) {
  const normalized = normalizeImportInput(input);

  let ycloudPhones: Awaited<ReturnType<typeof listWhatsAppPhones>>;
  try {
    ycloudPhones = await listWhatsAppPhones(normalized.wabaId);
  } catch {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_YCLOUD_FAILED",
      "YCloud could not verify the WhatsApp business account",
      502,
    );
  }

  const allPhones = [
    ...new Set(
      ycloudPhones.phones
        .map((phone) => normalizeYCloudPhone(phone.phoneNumber))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ].sort();
  if (!allPhones.length) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_WABA_NOT_FOUND",
      "YCloud returned no valid phone numbers for this WhatsApp business account",
      404,
    );
  }

  // 请求里的号必须是该 WABA 真实拥有的号（防止把手写错的号绑进来）。
  const notOnWaba = normalized.phoneNumbers.filter((phone) => !allPhones.includes(phone));
  if (notOnWaba.length) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_PHONE_NOT_ON_WABA",
      "one or more phone numbers do not belong to this WhatsApp business account",
      404,
    );
  }
  const phones = normalized.phoneNumbers;

  await prisma.$transaction(
    async (tx) => {
      await lockWabaOwnershipKeys(tx, normalized.wabaId, phones);

      // 一个 WABA 可被多个 supplier 共享 —— 不再做 WABA 级独占检查。
      // 独占性只落在手机号上：被别人占用的号一律拒绝（见下）。
      const ownedRows = await tx.wabaPhone.findMany({
        where: { phoneNumber: { in: phones } },
        select: { phoneNumber: true, supplierId: true },
      });
      const takenByOthers = ownedRows.filter(
        (row) => row.supplierId && row.supplierId !== normalized.partnerCustomerId,
      );
      if (takenByOthers.length) {
        throw new AdminWabaImportError(
          "ADMIN_IMPORT_PHONE_OWNED_BY_OTHER_TENANT",
          "one or more phone numbers are already owned by another tenant",
          409,
        );
      }

      const phoneConflicts = await tx.wabaPhone.findMany({
        where: {
          phoneNumber: { in: phones },
          wabaId: { not: normalized.wabaId },
        },
        select: { phoneNumber: true },
      });
      if (phoneConflicts.length) {
        throw new AdminWabaImportError(
          "ADMIN_IMPORT_PHONE_CONFLICT",
          "one or more phone numbers are already mapped to another WhatsApp business account",
          409,
        );
      }

      const existing = await tx.wabaOnboarding.findFirst({
        where: {
          wabaId: normalized.wabaId,
          partnerCustomerId: normalized.partnerCustomerId,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      const data = {
        onboardingType: "WHATSAPP_BUSINESS_PLATFORM",
        onboardingUrl: null,
        expiresAt: null,
        status: "CONNECTED",
        updateEvent: "ADMIN_EXISTING_WABA_IMPORT",
      } as const;
      if (existing) {
        await tx.wabaOnboarding.update({ where: { id: existing.id }, data });
      } else {
        await tx.wabaOnboarding.create({
          data: {
            partnerCustomerId: normalized.partnerCustomerId,
            wabaId: normalized.wabaId,
            ...data,
          },
        });
      }

      for (const phoneNumber of phones) {
        await tx.wabaPhone.upsert({
          // 手机号全局唯一 → 以 phoneNumber 为键幂等 upsert（重复导入同一个号不报错）
          where: { phoneNumber },
          update: {
            wabaId: normalized.wabaId,
            supplierId: normalized.partnerCustomerId,
            updatedAt: new Date(),
          },
          create: {
            wabaId: normalized.wabaId,
            phoneNumber,
            supplierId: normalized.partnerCustomerId,
          },
        });
      }
    },
    { isolationLevel: "Serializable" },
  );

  return {
    ok: true as const,
    partnerCustomerId: normalized.partnerCustomerId,
    status: "CONNECTED" as const,
    phones,
  };
}
