CREATE TABLE "child_memories" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueText" TEXT,
    "normalizedValue" TEXT,
    "changeType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceTurnId" TEXT NOT NULL,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "extractorModel" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "supersededById" TEXT,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL,
    "lastInjectedAt" TIMESTAMP(3),
    "injectionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "child_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "child_memories_deviceId_key_version_key"
  ON "child_memories"("deviceId", "key", "version");
CREATE UNIQUE INDEX "child_memories_deviceId_sourceTurnId_key_key"
  ON "child_memories"("deviceId", "sourceTurnId", "key");
CREATE UNIQUE INDEX "child_memories_one_active_per_device_key"
  ON "child_memories"("deviceId", "key") WHERE "status" = 'active';
CREATE INDEX "child_memories_deviceId_status_key_lastInjectedAt_idx"
  ON "child_memories"("deviceId", "status", "key", "lastInjectedAt");
CREATE INDEX "child_memories_deviceId_key_validFrom_idx"
  ON "child_memories"("deviceId", "key", "validFrom");

ALTER TABLE "child_memories"
  ADD CONSTRAINT "child_memories_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
