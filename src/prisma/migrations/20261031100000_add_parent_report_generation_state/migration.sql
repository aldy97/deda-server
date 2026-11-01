-- AlterTable
ALTER TABLE "parent_reports" ADD COLUMN "generationStartedAt" TIMESTAMP(3),
ADD COLUMN "generationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "generationError" TEXT,
ADD COLUMN "nextRetryAt" TIMESTAMP(3),
ADD COLUMN "promptVersion" TEXT;

-- CreateIndex
CREATE INDEX "parent_reports_generationStatus_nextRetryAt_idx" ON "parent_reports"("generationStatus", "nextRetryAt");
