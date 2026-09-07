-- Short-lived tenant-machine assertion replay ledger. It stores only a
-- one-way nonce hash; no WABA identifier or machine credential is persisted.
CREATE TABLE "TenantMachineAssertionReplay" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantMachineAssertionReplay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantMachineAssertionReplay_supplierId_nonceHash_key"
    ON "TenantMachineAssertionReplay"("supplierId", "nonceHash");
CREATE INDEX "TenantMachineAssertionReplay_expiresAt_idx"
    ON "TenantMachineAssertionReplay"("expiresAt");
