-- CreateTable
CREATE TABLE "parent_reports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "generationStatus" TEXT NOT NULL DEFAULT 'pending',
    "expressionObservation" TEXT,
    "emotionObservation" TEXT,
    "thinkingObservation" TEXT,
    "suggestion" TEXT,
    "generatorModel" TEXT,
    "generatedAt" TIMESTAMP(3),
    "feedback" TEXT,
    "feedbackAt" TIMESTAMP(3),
    "feedbackUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_plans" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetDays" INTEGER NOT NULL DEFAULT 21,
    "startDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "habit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_daily_records" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "recordDate" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "habit_daily_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parent_reports_deviceId_reportDate_key" ON "parent_reports"("deviceId", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "habit_plans_deviceId_key_key" ON "habit_plans"("deviceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "habit_daily_records_planId_recordDate_key" ON "habit_daily_records"("planId", "recordDate");

-- AddForeignKey
ALTER TABLE "parent_reports" ADD CONSTRAINT "parent_reports_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_plans" ADD CONSTRAINT "habit_plans_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_daily_records" ADD CONSTRAINT "habit_daily_records_planId_fkey" FOREIGN KEY ("planId") REFERENCES "habit_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
