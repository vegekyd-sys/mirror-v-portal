import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config";

export class AdminAuthError extends Error {
  readonly statusCode: number;
  readonly code: "ADMIN_API_DISABLED" | "ADMIN_UNAUTHORIZED";

  constructor(code: AdminAuthError["code"], message: string, statusCode: number) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function tokenEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerToken(value: string | string[] | undefined): string {
  if (Array.isArray(value) || !value) return "";
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(value.trim());
  return match?.[1] || "";
}

/** Authenticate an operator without accepting credentials in the query string or body. */
export function requireBridgeAdmin(request: FastifyRequest): void {
  const configured = config.adminToken;
  if (!configured) {
    throw new AdminAuthError(
      "ADMIN_API_DISABLED",
      "WhatsApp bridge admin API is not configured",
      503,
    );
  }
  const supplied = bearerToken(request.headers.authorization);
  if (!supplied || !tokenEquals(supplied, configured)) {
    throw new AdminAuthError("ADMIN_UNAUTHORIZED", "invalid admin credentials", 401);
  }
}
