-- CreateTable
CREATE TABLE "sleep_configs" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "durationMode" TEXT NOT NULL DEFAULT 'default',
    "durationMinutes" INTEGER,
    "contentType" TEXT NOT NULL DEFAULT 'story',
    "sleepTime" TEXT NOT NULL DEFAULT '21:30',
    "forceSleep" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sleep_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sleep_configs_deviceId_key" ON "sleep_configs"("deviceId");

-- AddForeignKey
ALTER TABLE "sleep_configs" ADD CONSTRAINT "sleep_configs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
