/**
 * 管理接口的认证与授权。
 *
 *   X-Admin-Token   -> 认证：证明调用方可信（openclaw 持有）
 *   X-Supplier-Id   -> 授权范围：这次操作哪一家的数据
 *
 * supplier_id 不是凭据，只是范围标识——用户身份由 openclaw 自己判断，
 * 它决定把哪个 supplier_id 传进来。所以这个值可以是可读的业务 ID。
 */

import { timingSafeEqual } from "node:crypto";
import type { AppState } from "./state.js";
import { isValidSupplierId } from "./suppliers.js";

/** 对应 FastAPI 的 HTTPException：响应体是 {"detail": ...}。 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;

  constructor(statusCode: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/** 一次调用的身份。supplierId 决定能看到／操作哪些绑定。 */
export interface Caller {
  isAdmin: boolean;
  supplierId: string;
}

function tokenEquals(a: string, b: string): boolean {
  // 必须先编码成 bytes 再比：长度不同时 timingSafeEqual 会抛，
  // 那样任何人发一个长度不对的头就能把请求打成 500。
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 从 Authorization 头解析 Bearer token。 */
export function bearerToken(authorization: string | undefined): string {
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

/** 平台级鉴权。未配置 ADMIN_TOKEN 时整体关闭，避免裸奔接收 app_secret。 */
export function requireAdmin(state: AppState, token: string): void {
  const configured = state.settings.adminToken;
  if (!configured) {
    throw new HttpError(503, "ADMIN_TOKEN not configured; admin API disabled");
  }
  if (!token || !tokenEquals(token, configured)) {
    throw new HttpError(401, "invalid admin token");
  }
}

export async function resolveCaller(
  state: AppState,
  adminToken: string,
  supplierId: string,
  allSuppliers = false,
): Promise<Caller> {
  requireAdmin(state, adminToken);

  if (allSuppliers) return { isAdmin: true, supplierId: "" };

  const target = (supplierId || "").trim();
  if (!target) {
    throw new HttpError(
      400,
      "missing X-Supplier-Id header (or use ?all_suppliers=true for cross-tenant read)",
    );
  }
  if (!isValidSupplierId(target)) {
    throw new HttpError(400, "invalid supplier_id");
  }

  const supplier = await state.suppliers.get(target);
  if (supplier !== null && !supplier.active) {
    throw new HttpError(403, `supplier ${target} is deactivated`);
  }

  return { isAdmin: true, supplierId: target };
}

/** 查询参数里的布尔值。FastAPI 认这几种写法。 */
export function queryBool(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** 头可能是数组（重复头），统一取第一个。 */
export function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
