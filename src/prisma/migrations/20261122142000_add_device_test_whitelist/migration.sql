-- 测试设备白名单：冒险测试与哄睡测试共用的设备级资格闸。
-- 软删除保留撤销记录；外键 CASCADE 保证设备 wipe 后资格自动失效。

-- CreateTable
CREATE TABLE "device_test_whitelist" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedReason" TEXT,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_test_whitelist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_test_whitelist_deviceId_key" ON "device_test_whitelist"("deviceId");

-- CreateIndex
CREATE INDEX "device_test_whitelist_active_idx" ON "device_test_whitelist"("active");

-- AddForeignKey
ALTER TABLE "device_test_whitelist" ADD CONSTRAINT "device_test_whitelist_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
