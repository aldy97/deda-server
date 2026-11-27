-- 设备网络心跳日聚合：MQTT query 心跳内存聚合后 5 分钟 flush。
-- 无外键：删除 devices 不影响历史聚合。
CREATE TABLE "device_network_daily" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "wifiHeartbeats" INTEGER NOT NULL DEFAULT 0,
    "fourGHeartbeats" INTEGER NOT NULL DEFAULT 0,
    "unknownHeartbeats" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_network_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_network_daily_date_deviceId_key" ON "device_network_daily"("date", "deviceId");
CREATE INDEX "device_network_daily_date_idx" ON "device_network_daily"("date");
