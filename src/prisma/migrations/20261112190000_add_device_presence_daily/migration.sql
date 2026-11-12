-- CreateTable
CREATE TABLE "device_presence_daily" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_presence_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_presence_daily_date_idx" ON "device_presence_daily"("date");

-- CreateIndex
CREATE UNIQUE INDEX "device_presence_daily_deviceId_date_key" ON "device_presence_daily"("deviceId", "date");

-- AddForeignKey
ALTER TABLE "device_presence_daily" ADD CONSTRAINT "device_presence_daily_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;