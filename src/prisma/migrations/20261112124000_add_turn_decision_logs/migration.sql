-- CreateTable
CREATE TABLE "turn_decision_logs" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "deviceId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'baidu-rtc',
    "safetyLayer" TEXT,
    "safetyCategory" TEXT,
    "safetyBlocked" BOOLEAN NOT NULL DEFAULT false,
    "safetySource" TEXT NOT NULL DEFAULT 'none',
    "safetyMatched" VARCHAR(64),
    "intent" TEXT,
    "intentSource" TEXT,
    "asrText" VARCHAR(200),
    "reviewLabel" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "turn_decision_logs_turnId_key" ON "turn_decision_logs"("turnId");

-- CreateIndex
CREATE INDEX "turn_decision_logs_createdAt_safetyCategory_idx" ON "turn_decision_logs"("createdAt", "safetyCategory");

-- CreateIndex
CREATE INDEX "turn_decision_logs_createdAt_intent_intentSource_idx" ON "turn_decision_logs"("createdAt", "intent", "intentSource");

-- CreateIndex
CREATE INDEX "turn_decision_logs_createdAt_safetySource_idx" ON "turn_decision_logs"("createdAt", "safetySource");
