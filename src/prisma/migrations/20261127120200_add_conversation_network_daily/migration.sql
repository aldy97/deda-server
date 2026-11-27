-- 对话网络日聚合：消息落库时按 (date, deviceId) 累加。
-- 无外键：删除 messages / devices 不影响历史聚合。
CREATE TABLE "conversation_network_daily" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "wifiTurns" INTEGER NOT NULL DEFAULT 0,
    "fourGTurns" INTEGER NOT NULL DEFAULT 0,
    "unknownTurns" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_network_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_network_daily_date_deviceId_key" ON "conversation_network_daily"("date", "deviceId");
CREATE INDEX "conversation_network_daily_date_idx" ON "conversation_network_daily"("date");
