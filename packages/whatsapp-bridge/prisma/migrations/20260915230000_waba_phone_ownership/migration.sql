-- WhatsApp 多租户共享 WABA：归属从「WABA 级」下移到「手机号级」。
--
-- 语义（2026-09-15 决策）：
--   · 一个 WABA 可被多个 supplier（partnerCustomerId）共享；
--   · 但每个手机号只能归一家 —— 靠 WabaPhone.phoneNumber 全局唯一约束兜底；
--   · 存量不考虑（用户明确：当前没有正式运营），因此新列直接 NOT NULL 且默认空串起步。
--
-- 添加列并建唯一索引；已有行 supplierId 为空串（视为无主，重新导入即会被正确归属）。

-- AlterTable
ALTER TABLE "WabaPhone" ADD COLUMN "supplierId" TEXT NOT NULL DEFAULT '';

-- CreateIndex：手机号全局唯一（一个号只能属于一家）
CREATE UNIQUE INDEX "WabaPhone_phoneNumber_key" ON "WabaPhone"("phoneNumber");

-- CreateIndex
CREATE INDEX "WabaPhone_supplierId_idx" ON "WabaPhone"("supplierId");
