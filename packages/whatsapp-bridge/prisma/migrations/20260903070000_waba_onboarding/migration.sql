-- CreateTable
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

-- CreateIndex
CREATE INDEX "WabaOnboarding_partnerCustomerId_idx" ON "WabaOnboarding"("partnerCustomerId");

-- CreateIndex
CREATE INDEX "WabaOnboarding_status_idx" ON "WabaOnboarding"("status");

-- CreateIndex
CREATE INDEX "WabaOnboarding_wabaId_idx" ON "WabaOnboarding"("wabaId");
