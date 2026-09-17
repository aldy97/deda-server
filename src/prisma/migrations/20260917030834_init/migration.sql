-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "phone" TEXT,
    "nickname" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceCode" TEXT,
    "firmwareVersion" TEXT,
    "wifiName" TEXT,
    "ipAddress" TEXT,
    "networkType" TEXT,
    "macAddress" TEXT,
    "subnetMask" TEXT,
    "gateway" TEXT,
    "dns" TEXT,
    "timezone" TEXT,
    "topicAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_device_bindings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "isOwner" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_device_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "birthday" TEXT,
    "englishName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "child_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "textbooks" (
    "id" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cefrLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "textbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cefrLevel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_configs" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "textbookId" TEXT,
    "unitId" TEXT,
    "mode" TEXT NOT NULL,
    "cefrLevel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "asrText" TEXT,
    "aiReply" TEXT,
    "hitUnitIds" TEXT[],
    "textbookId" TEXT,
    "unitId" TEXT,
    "mode" TEXT,
    "cefrLevel" TEXT,
    "rawPayload" JSONB NOT NULL,
    "spokeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_stats" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "statDate" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "speakCount" INTEGER NOT NULL DEFAULT 0,
    "newWords" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalSpeakCount" INTEGER NOT NULL DEFAULT 0,
    "totalWords" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_openid_key" ON "users"("openid");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceId_key" ON "devices"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceCode_key" ON "devices"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "user_device_bindings_userId_deviceId_key" ON "user_device_bindings"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "textbooks_textbookId_key" ON "textbooks"("textbookId");

-- CreateIndex
CREATE UNIQUE INDEX "units_textbookId_unitId_key" ON "units"("textbookId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_conversationId_key" ON "conversations"("conversationId");

-- CreateIndex
CREATE INDEX "conversations_deviceId_spokeAt_idx" ON "conversations"("deviceId", "spokeAt");

-- CreateIndex
CREATE INDEX "conversations_deviceId_deletedAt_spokeAt_idx" ON "conversations"("deviceId", "deletedAt", "spokeAt");

-- CreateIndex
CREATE INDEX "learning_stats_deviceId_statDate_idx" ON "learning_stats"("deviceId", "statDate");

-- CreateIndex
CREATE UNIQUE INDEX "learning_stats_deviceId_statDate_key" ON "learning_stats"("deviceId", "statDate");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_logs_idempotencyKey_key" ON "webhook_logs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "webhook_logs_processed_createdAt_idx" ON "webhook_logs"("processed", "createdAt");

-- AddForeignKey
ALTER TABLE "user_device_bindings" ADD CONSTRAINT "user_device_bindings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_device_bindings" ADD CONSTRAINT "user_device_bindings_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_profiles" ADD CONSTRAINT "child_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_textbookId_fkey" FOREIGN KEY ("textbookId") REFERENCES "textbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_configs" ADD CONSTRAINT "device_configs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_stats" ADD CONSTRAINT "learning_stats_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
