import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../prisma";
import { AdminWabaImportError, importExistingWaba } from "./adminWabaImport";

const ASSERTION_VERSION = "v1";
const MAX_ASSERTION_AGE_SECONDS = 120;
const MAX_FUTURE_SKEW_SECONDS = 30;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,86}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class SkillWabaBindError extends Error {
  readonly statusCode: number;
  readonly code:
    | "WHATSAPP_SKILL_BIND_INVALID_INPUT"
    | "WHATSAPP_SKILL_BIND_ASSERTION_EXPIRED"
    | "WHATSAPP_SKILL_BIND_INVALID_ASSERTION"
    | "WHATSAPP_SKILL_BIND_ASSERTION_REPLAYED"
    | "WHATSAPP_SKILL_BIND_ASSERTION_UNAVAILABLE"
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

export interface SkillWabaBindInput {
  supplierId: string;
  wabaId: string;
  assertion: {
    version: typeof ASSERTION_VERSION;
    issuedAt: number;
    nonce: string;
    signature: string;
  };
}

function invalidInput(): never {
  throw new SkillWabaBindError(
    "WHATSAPP_SKILL_BIND_INVALID_INPUT",
    "invalid existing WhatsApp business account binding request",
    400,
  );
}

export function normalizeSkillWabaBindInput(input: unknown): SkillWabaBindInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidInput();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["supplierId", "wabaId", "assertion"].includes(key))) {
    invalidInput();
  }
  const supplierId = typeof body.supplierId === "string" ? body.supplierId.trim() : "";
  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(supplierId) || !/^[1-9]\d{4,31}$/.test(wabaId)) {
    invalidInput();
  }
  if (!body.assertion || typeof body.assertion !== "object" || Array.isArray(body.assertion)) {
    invalidInput();
  }
  const assertion = body.assertion as Record<string, unknown>;
  if (Object.keys(assertion).some((key) => !["version", "issuedAt", "nonce", "signature"].includes(key))) {
    invalidInput();
  }
  if (
    assertion.version !== ASSERTION_VERSION ||
    !Number.isSafeInteger(assertion.issuedAt) ||
    !NONCE_PATTERN.test(typeof assertion.nonce === "string" ? assertion.nonce : "") ||
    !SIGNATURE_PATTERN.test(typeof assertion.signature === "string" ? assertion.signature : "")
  ) {
    invalidInput();
  }
  return {
    supplierId,
    wabaId,
    assertion: {
      version: ASSERTION_VERSION,
      issuedAt: assertion.issuedAt as number,
      nonce: assertion.nonce as string,
      signature: assertion.signature as string,
    },
  };
}

function assertFresh(input: SkillWabaBindInput, nowSeconds: number): void {
  const age = nowSeconds - input.assertion.issuedAt;
  if (age > MAX_ASSERTION_AGE_SECONDS || age < -MAX_FUTURE_SKEW_SECONDS) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_ASSERTION_EXPIRED",
      "tenant-machine assertion is outside the allowed time window",
      401,
    );
  }
}

async function verifyWithProvisioning(input: SkillWabaBindInput): Promise<void> {
  if (!config.provisioning.apiToken) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_ASSERTION_UNAVAILABLE",
      "tenant-machine assertion verification is not configured",
      503,
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `${config.provisioning.baseUrl.replace(/\/$/, "")}/v1/internal/tenant-machine-assertions/verify-whatsapp-binding`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.provisioning.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_ASSERTION_UNAVAILABLE",
      "tenant-machine assertion verifier is unavailable",
      503,
    );
  }
  if (!response.ok) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_ASSERTION_UNAVAILABLE",
      "tenant-machine assertion verifier is unavailable",
      503,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!result || typeof result !== "object" || (result as { valid?: unknown }).valid !== true) {
    throw new SkillWabaBindError(
      "WHATSAPP_SKILL_BIND_INVALID_ASSERTION",
      "tenant-machine assertion is invalid for this supplier",
      401,
    );
  }
}

async function claimAssertionNonce(input: SkillWabaBindInput, now: Date): Promise<void> {
  const nonceHash = createHash("sha256").update(input.assertion.nonce).digest("hex");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.tenantMachineAssertionReplay.deleteMany({ where: { expiresAt: { lt: now } } });
      await tx.tenantMachineAssertionReplay.create({
        data: {
          supplierId: input.supplierId,
          nonceHash,
          expiresAt: new Date((input.assertion.issuedAt + MAX_ASSERTION_AGE_SECONDS) * 1000),
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new SkillWabaBindError(
        "WHATSAPP_SKILL_BIND_ASSERTION_REPLAYED",
        "tenant-machine assertion was already used",
        409,
      );
    }
    throw error;
  }
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

/** Explicit Skill path authenticated by a short-lived, single-use tenant-machine assertion. */
export async function bindExistingWabaForTenantMachine(input: unknown, now = new Date()) {
  const normalized = normalizeSkillWabaBindInput(input);
  assertFresh(normalized, Math.floor(now.getTime() / 1000));
  await verifyWithProvisioning(normalized);
  await claimAssertionNonce(normalized, now);
  try {
    return await importExistingWaba({
      partnerCustomerId: normalized.supplierId,
      wabaId: normalized.wabaId,
    });
  } catch (error) {
    if (error instanceof AdminWabaImportError) throw mapImportError(error);
    throw error;
  }
}
