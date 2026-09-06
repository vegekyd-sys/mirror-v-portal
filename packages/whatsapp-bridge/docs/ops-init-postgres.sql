-- =============================================================================
-- WhatsApp Platform Bridge — 上线建表 SQL（PostgreSQL）
-- =============================================================================
-- 用途：在目标库执行一次即可（测试 / 正式环境）
-- Schema：whatsapp_platform_bridge（与应用环境变量 DATABASE_SCHEMA 一致）
-- 说明：
--   1. 只创建本 schema 下的表，不影响同库其它业务表
--   2. 含 WabaOnboarding / WabaPhone（租户 WABA 绑定）。表若已存在会报错，请先确认未建过
--   3. 应用账号需对本 schema 有 USAGE + CREATE（或至少对下列表有 CRUD）
--   4. 能跑 Prisma 时优先：APP_ENV=... npm run prisma:migrate:deploy
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS whatsapp_platform_bridge;

SET search_path TO whatsapp_platform_bridge;

-- ---------------------------------------------------------------------------
-- 表
-- ---------------------------------------------------------------------------

CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "whatsappUserId" TEXT,
    "whatsappParentUserId" TEXT,
    "name" TEXT,
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "businessPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "sourceChatId" TEXT,
    "sourceOpenId" TEXT,
    "feishuAppId" TEXT,
    "supplierId" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "serviceWindowExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "status" TEXT NOT NULL DEFAULT 'received',
    "content" TEXT NOT NULL,
    "ycloudMessageId" TEXT,
    "wamid" TEXT,
    "feishuMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "supplierId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "processStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "supplierId" TEXT,
    "tenantKey" TEXT NOT NULL DEFAULT 'legacy',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "PlatformThread" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "rootMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WabaOnboarding" (
    "id" TEXT NOT NULL,
    "partnerCustomerId" TEXT NOT NULL,
    "onboardingType" TEXT NOT NULL DEFAULT 'WHATSAPP_BUSINESS_PLATFORM',
    "locale" TEXT,
    "onboardingUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "wabaId" TEXT,
    "wabaName" TEXT,
    "phoneNumberId" TEXT,
    "businessId" TEXT,
    "businessName" TEXT,
    "accountReviewStatus" TEXT,
    "businessVerificationStatus" TEXT,
    "ownershipType" TEXT,
    "messagingLimit" TEXT,
    "paymentMethodAttached" BOOLEAN,
    "updateEvent" TEXT,
    "lastEventId" TEXT,
    "sourceChatId" TEXT,
    "sourceOpenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WabaOnboarding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WabaPhone" (
    "id" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WabaPhone_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------

CREATE INDEX "Customer_phoneNumber_idx" ON "Customer"("phoneNumber");
CREATE INDEX "Customer_whatsappUserId_idx" ON "Customer"("whatsappUserId");
CREATE INDEX "Customer_whatsappParentUserId_idx" ON "Customer"("whatsappParentUserId");
CREATE INDEX "Customer_supplierId_idx" ON "Customer"("supplierId");

CREATE INDEX "Conversation_businessPhone_idx" ON "Conversation"("businessPhone");
CREATE INDEX "Conversation_feishuAppId_idx" ON "Conversation"("feishuAppId");
CREATE INDEX "Conversation_supplierId_idx" ON "Conversation"("supplierId");
CREATE UNIQUE INDEX "Conversation_customerId_businessPhone_key" ON "Conversation"("customerId", "businessPhone");

CREATE UNIQUE INDEX "Message_ycloudMessageId_key" ON "Message"("ycloudMessageId");
CREATE UNIQUE INDEX "Message_feishuMessageId_key" ON "Message"("feishuMessageId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_supplierId_idx" ON "Message"("supplierId");

CREATE UNIQUE INDEX "WebhookEvent_provider_tenantKey_eventId_key" ON "WebhookEvent"("provider", "tenantKey", "eventId");
CREATE INDEX "WebhookEvent_supplierId_idx" ON "WebhookEvent"("supplierId");

CREATE UNIQUE INDEX "PlatformThread_conversationId_platform_key" ON "PlatformThread"("conversationId", "platform");
CREATE UNIQUE INDEX "PlatformThread_platform_threadId_key" ON "PlatformThread"("platform", "threadId");

CREATE INDEX "WabaOnboarding_partnerCustomerId_idx" ON "WabaOnboarding"("partnerCustomerId");
CREATE INDEX "WabaOnboarding_status_idx" ON "WabaOnboarding"("status");
CREATE INDEX "WabaOnboarding_wabaId_idx" ON "WabaOnboarding"("wabaId");

CREATE UNIQUE INDEX "WabaPhone_wabaId_phoneNumber_key" ON "WabaPhone"("wabaId", "phoneNumber");
CREATE INDEX "WabaPhone_phoneNumber_idx" ON "WabaPhone"("phoneNumber");
CREATE INDEX "WabaPhone_wabaId_idx" ON "WabaPhone"("wabaId");

CREATE TABLE "FeishuApp" (
    "appId" TEXT NOT NULL,
    "appSecret" TEXT NOT NULL,
    "verificationToken" TEXT,
    "encryptKey" TEXT,
    "csChatId" TEXT,
    "inviteAppIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FeishuApp_pkey" PRIMARY KEY ("appId")
);

-- ---------------------------------------------------------------------------
-- 外键
-- ---------------------------------------------------------------------------

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformThread"
  ADD CONSTRAINT "PlatformThread_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 权限（按实际应用账号改用户名后执行）
-- ---------------------------------------------------------------------------
-- GRANT USAGE ON SCHEMA whatsapp_platform_bridge TO <app_user>;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA whatsapp_platform_bridge TO <app_user>;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA whatsapp_platform_bridge
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <app_user>;
