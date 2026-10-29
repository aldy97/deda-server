-- 同时兼容全新数据库与曾通过 db push 创建冒险三表的开发库。
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "characterKey" TEXT NOT NULL DEFAULT 'elly';

DO $$
BEGIN
  IF to_regclass('public.adventure_episodes') IS NOT NULL THEN
    ALTER TABLE "adventure_episodes" ADD COLUMN IF NOT EXISTS "characterKey" TEXT NOT NULL DEFAULT 'elly';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "adventure_episodes" (
    "id" TEXT NOT NULL,
    "characterKey" TEXT NOT NULL DEFAULT 'elly',
    "season" INTEGER NOT NULL DEFAULT 1,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "recap" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_episodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "adventure_segments" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "interactionType" TEXT,
    "options" JSONB,
    "fallbackText" TEXT,
    "exitText" TEXT,
    "rewardStar" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_segments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "adventure_progresses" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "nextSegmentOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "waitingSince" TIMESTAMP(3),
    "stars" INTEGER NOT NULL DEFAULT 0,
    "offTopicCount" INTEGER NOT NULL DEFAULT 0,
    "playDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_progresses_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "adventure_episodes" DROP CONSTRAINT IF EXISTS "adventure_episodes_season_episodeNumber_key";
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_episodes_characterKey_season_episodeNumber_key" ON "adventure_episodes"("characterKey", "season", "episodeNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_segments_episodeId_order_key" ON "adventure_segments"("episodeId", "order");
CREATE INDEX IF NOT EXISTS "adventure_progresses_status_waitingSince_idx" ON "adventure_progresses"("status", "waitingSince");
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_progresses_deviceId_playDate_key" ON "adventure_progresses"("deviceId", "playDate");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_segments_episodeId_fkey') THEN
    ALTER TABLE "adventure_segments" ADD CONSTRAINT "adventure_segments_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "adventure_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_progresses_deviceId_fkey') THEN
    ALTER TABLE "adventure_progresses" ADD CONSTRAINT "adventure_progresses_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_progresses_episodeId_fkey') THEN
    ALTER TABLE "adventure_progresses" ADD CONSTRAINT "adventure_progresses_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "adventure_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
