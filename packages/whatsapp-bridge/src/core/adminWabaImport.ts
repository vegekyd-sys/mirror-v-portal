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
    | "ADMIN_IMPORT_PHONE_CONFLICT";

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
  const allowed = new Set(["partnerCustomerId", "wabaId"]);
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
  return { partnerCustomerId, wabaId };
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

  const phones = [
    ...new Set(
      ycloudPhones.phones
        .map((phone) => normalizeYCloudPhone(phone.phoneNumber))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ].sort();
  if (!phones.length) {
    throw new AdminWabaImportError(
      "ADMIN_IMPORT_WABA_NOT_FOUND",
      "YCloud returned no valid phone numbers for this WhatsApp business account",
      404,
    );
  }

  await prisma.$transaction(
    async (tx) => {
      await lockWabaOwnershipKeys(tx, normalized.wabaId, phones);

      const connectedOwners = await tx.wabaOnboarding.findMany({
        where: { wabaId: normalized.wabaId, status: "CONNECTED" },
        select: { partnerCustomerId: true },
      });
      if (
        connectedOwners.some(
          (owner) => owner.partnerCustomerId !== normalized.partnerCustomerId,
        )
      ) {
        throw new AdminWabaImportError(
          "ADMIN_IMPORT_WABA_OWNED",
          "WhatsApp business account is already connected to another tenant",
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
          where: { wabaId_phoneNumber: { wabaId: normalized.wabaId, phoneNumber } },
          update: { updatedAt: new Date() },
          create: { wabaId: normalized.wabaId, phoneNumber },
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
