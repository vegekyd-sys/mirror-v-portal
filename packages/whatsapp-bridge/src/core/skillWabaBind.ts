import { config } from "../config";
import { AdminWabaImportError, importExistingWaba } from "./adminWabaImport";

export class SkillWabaBindError extends Error {
  readonly statusCode: number;
  readonly code:
    | "WHATSAPP_SKILL_BIND_DISABLED"
    | "WHATSAPP_SKILL_BIND_INVALID_INPUT"
    | "WHATSAPP_SKILL_BIND_SUPPLIER_NOT_ALLOWED"
    | "WHATSAPP_SKILL_BIND_YCLOUD_FAILED"
    | "WHATSAPP_SKILL_BIND_WABA_NOT_FOUND"
    | "WHATSAPP_SKILL_BIND_WABA_OWNED"
    | "WHATSAPP_SKILL_BIND_PHONE_CONFLICT";

  constructor(
    code: SkillWabaBindError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "SkillWabaBindError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeSupplier(input: unknown): { partnerCustomerId: string; wabaId: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_INVALID_INPUT",
      "request body must be a JSON object",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["supplierId", "wabaId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_INVALID_INPUT",
      "request body contains unsupported fields",
      400,
    );
  }

  const supplierId = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  if (
    !supplierId ||
    supplierId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(supplierId)
  ) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_INVALID_INPUT",
      "supplierId is required and must be a valid supplier identifier",
      400,
    );
  }
  return { partnerCustomerId: supplierId, wabaId: body.wabaId };
}

function mapImportError(error: AdminWabaImportError): SkillWabaBindError {
  const codes: Record<AdminWabaImportError["code"], SkillWabaBindError["code"]> = {
    ADMIN_IMPORT_INVALID_INPUT: "WHATSAPP_SKILL_BIND_INVALID_INPUT",
    ADMIN_IMPORT_INVALID_WABA: "WHATSAPP_SKILL_BIND_INVALID_INPUT",
    ADMIN_IMPORT_YCLOUD_FAILED: "WHATSAPP_SKILL_BIND_YCLOUD_FAILED",
    ADMIN_IMPORT_WABA_NOT_FOUND: "WHATSAPP_SKILL_BIND_WABA_NOT_FOUND",
    ADMIN_IMPORT_WABA_OWNED: "WHATSAPP_SKILL_BIND_WABA_OWNED",
    ADMIN_IMPORT_PHONE_CONFLICT: "WHATSAPP_SKILL_BIND_PHONE_CONFLICT",
  };
  return new SkillWabaBindError(codes[error.code], error.message, error.statusCode);
}

/**
 * Temporary feature-first entry point for explicitly allowlisted suppliers.
 * It deliberately has no caller token and delegates all YCloud verification and ownership writes
 * to the same importer used by the operator-only API.
 */
export async function bindExistingWabaForAllowedSupplier(input: unknown) {
  const allowlist = config.skillBindAllowedSuppliers;
  if (!allowlist.length) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_DISABLED",
      "existing WhatsApp business account Skill binding is not enabled",
      503,
    );
  }
  const normalized = normalizeSupplier(input);
  if (!allowlist.includes(normalized.partnerCustomerId)) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_SUPPLIER_NOT_ALLOWED",
      "supplier is not enabled for existing WhatsApp business account Skill binding",
      403,
    );
  }

  try {
    return await importExistingWaba(normalized);
  } catch (error) {
    if (error instanceof AdminWabaImportError) throw mapImportError(error);
    throw error;
  }
}
