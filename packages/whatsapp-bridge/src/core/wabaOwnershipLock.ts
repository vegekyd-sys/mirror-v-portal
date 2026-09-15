import type { Prisma } from "@prisma/client";

/**
 * Serialize every WABA/phone ownership mutation across server processes.
 *
 * **全局加锁顺序**：所有 `phone:` 键（升序）→ 所有 `waba:` 键（升序）。
 * 这不是巧合而是约定 —— 每个调用方都必须一次性把本事务要用到的 key 全部传进来，
 * 由本函数统一排序。曾经出现过 unbind 先锁 waba 再锁 phone、import 先锁 phone 再锁 waba，
 * 两者并发命中同一 (waba, phone) 就是 ABBA 死锁；分多次调用也会退化成同样的问题。
 *
 * 如果某个流程必须先读库才知道要锁哪些 waba（例如按手机号反查），
 * 那就先锁 phone、读库、再锁 waba —— 仍然落在同一个顺序上。
 */
export async function lockWabaOwnershipKeys(
  tx: Prisma.TransactionClient,
  wabaIds: string | string[],
  phones: string[],
): Promise<void> {
  const wabaList = typeof wabaIds === "string" ? (wabaIds ? [wabaIds] : []) : wabaIds;
  const keys = [
    ...new Set([
      ...phones.map((phone) => `phone:${phone}`),
      ...wabaList.map((wabaId) => `waba:${wabaId}`),
    ]),
  ].sort();
  for (const key of keys) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  }
}
