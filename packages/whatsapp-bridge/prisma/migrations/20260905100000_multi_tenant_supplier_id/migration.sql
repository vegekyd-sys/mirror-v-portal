-- 多租户改造：核心表加 supplierId（租户标识 = partnerCustomerId）。
-- 不回填历史数据（用户明确决定），新列可空；新部署后由反查逻辑逐步写入。

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "Message" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "supplierId" TEXT;

-- CreateIndex
CREATE INDEX "Customer_supplierId_idx" ON "Customer"("supplierId");
CREATE INDEX "Conversation_supplierId_idx" ON "Conversation"("supplierId");
CREATE INDEX "Message_supplierId_idx" ON "Message"("supplierId");
CREATE INDEX "WebhookEvent_supplierId_idx" ON "WebhookEvent"("supplierId");

-- CreateTable：企业号 ↔ WABA 映射，供 inbound 消息按 businessPhone 反查租户
CREATE TABLE "WabaPhone" (
    "id" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WabaPhone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WabaPhone_wabaId_phoneNumber_key" ON "WabaPhone"("wabaId", "phoneNumber");
CREATE INDEX "WabaPhone_phoneNumber_idx" ON "WabaPhone"("phoneNumber");
CREATE INDEX "WabaPhone_wabaId_idx" ON "WabaPhone"("wabaId");
