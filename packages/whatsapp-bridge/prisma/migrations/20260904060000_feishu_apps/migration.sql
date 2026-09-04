-- CreateTable
CREATE TABLE "FeishuApp" (
    "appId" TEXT NOT NULL,
    "appSecret" TEXT NOT NULL,
    "verificationToken" TEXT,
    "encryptKey" TEXT,
    "csChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuApp_pkey" PRIMARY KEY ("appId")
);

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "feishuAppId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_feishuAppId_idx" ON "Conversation"("feishuAppId");
