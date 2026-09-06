-- Webhook 幂等键按租户隔离。
-- 历史 supplierId=NULL 的行统一落在 legacy scope，保留原 provider+eventId 的去重语义。

ALTER TABLE "WebhookEvent" ADD COLUMN "tenantKey" TEXT;

UPDATE "WebhookEvent"
SET "tenantKey" = CASE
  WHEN "supplierId" IS NULL OR BTRIM("supplierId") = '' THEN 'legacy'
  ELSE 'supplier:' || "supplierId"
END;

ALTER TABLE "WebhookEvent"
  ALTER COLUMN "tenantKey" SET DEFAULT 'legacy',
  ALTER COLUMN "tenantKey" SET NOT NULL;

DROP INDEX "WebhookEvent_provider_eventId_key";
CREATE UNIQUE INDEX "WebhookEvent_provider_tenantKey_eventId_key"
  ON "WebhookEvent"("provider", "tenantKey", "eventId");
