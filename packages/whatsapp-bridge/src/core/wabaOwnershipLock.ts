import type { Prisma } from "@prisma/client";

/** Serialize every CONNECTED WABA/phone ownership mutation across server processes. */
export async function lockWabaOwnershipKeys(
  tx: Prisma.TransactionClient,
  wabaId: string,
  phones: string[],
): Promise<void> {
  const keys = [`waba:${wabaId}`, ...phones.map((phone) => `phone:${phone}`)].sort();
  for (const key of keys) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
  }
}
