-- CreateTable
CREATE TABLE "adventure_video_jobs" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "episodeVersionId" TEXT NOT NULL,
    "businessKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'teaser',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "resolution" TEXT NOT NULL DEFAULT '720P',
    "renderer" TEXT NOT NULL DEFAULT 'wan3.0-video',
    "ttsMode" TEXT NOT NULL DEFAULT 'system',
    "voiceSetVersion" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "storyboard" JSONB,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "actualCostCents" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_video_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adventure_video_shots" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "startSec" INTEGER NOT NULL,
    "endSec" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "provider" TEXT,
    "providerTaskId" TEXT,
    "audioObjectKey" TEXT,
    "videoObjectKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_video_shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adventure_video_assets" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "durationSec" DOUBLE PRECISION,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_video_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adventure_video_voices" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "sampleObjectKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_video_voices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "adventure_video_jobs_requestId_key" ON "adventure_video_jobs"("requestId");

-- CreateIndex
CREATE INDEX "adventure_video_jobs_status_createdAt_idx" ON "adventure_video_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "adventure_video_jobs_episodeId_createdAt_idx" ON "adventure_video_jobs"("episodeId", "createdAt");

-- CreateIndex
CREATE INDEX "adventure_video_jobs_episodeVersionId_idx" ON "adventure_video_jobs"("episodeVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "adventure_video_shots_jobId_order_key" ON "adventure_video_shots"("jobId", "order");

-- CreateIndex
CREATE INDEX "adventure_video_assets_jobId_kind_idx" ON "adventure_video_assets"("jobId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "adventure_video_voices_role_key" ON "adventure_video_voices"("role");

-- AddForeignKey
ALTER TABLE "adventure_video_shots" ADD CONSTRAINT "adventure_video_shots_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "adventure_video_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adventure_video_assets" ADD CONSTRAINT "adventure_video_assets_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "adventure_video_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

