-- AlterTable
ALTER TABLE "adventure_video_jobs" ADD COLUMN     "storyboardApprovedAt" TIMESTAMP(3),
ADD COLUMN     "storyboardApprovedBy" VARCHAR(64),
ADD COLUMN     "storyboardRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "voiceTextHash" VARCHAR(64),
ADD COLUMN     "voiceTotalSec" DOUBLE PRECISION;
