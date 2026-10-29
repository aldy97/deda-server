-- 将旧「每日进度」拆成：每集可变进度 + 每日分配档案 + 不可变事件。
-- 所有旧 Progress 先回填 DailyRecord / Event，再删除旧 playDate 字段。

ALTER TABLE "adventure_progresses"
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "adventure_daily_records" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "assignedDate" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "completedDate" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "adventure_daily_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "adventure_events" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "dailyRecordId" TEXT NOT NULL,
  "turnId" TEXT,
  "eventType" TEXT NOT NULL,
  "segmentOrder" INTEGER,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "adventure_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "adventure_daily_records_deviceId_assignedDate_key"
  ON "adventure_daily_records"("deviceId", "assignedDate");
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_events_eventKey_key"
  ON "adventure_events"("eventKey");

INSERT INTO "adventure_daily_records" (
  "id", "deviceId", "episodeId", "assignedDate", "status", "assignedAt",
  "completedAt", "completedDate", "createdAt", "updatedAt"
)
SELECT
  md5('adventure-daily:' || p."id"),
  p."deviceId",
  p."episodeId",
  p."playDate",
  CASE WHEN p."status" = 'completed' THEN 'completed' ELSE 'in_progress' END,
  p."createdAt",
  CASE WHEN p."status" = 'completed' THEN COALESCE(p."completedAt", p."updatedAt") END,
  CASE WHEN p."status" = 'completed' THEN p."playDate" END,
  p."createdAt",
  p."updatedAt"
FROM "adventure_progresses" p
ON CONFLICT ("deviceId", "assignedDate") DO NOTHING;

UPDATE "adventure_progresses"
SET "completedAt" = "updatedAt"
WHERE "status" = 'completed' AND "completedAt" IS NULL;

INSERT INTO "adventure_events" (
  "id", "eventKey", "deviceId", "episodeId", "dailyRecordId", "eventType", "createdAt"
)
SELECT
  md5('adventure-event:' || d."id" || ':assigned'),
  'daily:' || d."id" || ':assigned',
  d."deviceId", d."episodeId", d."id", 'daily_assigned', d."assignedAt"
FROM "adventure_daily_records" d
ON CONFLICT ("eventKey") DO NOTHING;

INSERT INTO "adventure_events" (
  "id", "eventKey", "deviceId", "episodeId", "dailyRecordId", "eventType", "createdAt"
)
SELECT
  md5('adventure-event:' || d."id" || ':completed'),
  'daily:' || d."id" || ':completed',
  d."deviceId", d."episodeId", d."id", 'completed', d."completedAt"
FROM "adventure_daily_records" d
WHERE d."status" = 'completed'
ON CONFLICT ("eventKey") DO NOTHING;

-- 旧模型允许同一集跨天重播；新进度每设备每集仅一行，保留最近的可变状态。
-- 被合并行的每日分配与完成历史已保存在上面两张审计表中。
DELETE FROM "adventure_progresses" older
USING "adventure_progresses" newer
WHERE older."deviceId" = newer."deviceId"
  AND older."episodeId" = newer."episodeId"
  AND (
    older."updatedAt" < newer."updatedAt"
    OR (older."updatedAt" = newer."updatedAt" AND older."id" < newer."id")
  );

DROP INDEX IF EXISTS "adventure_progresses_deviceId_playDate_key";
ALTER TABLE "adventure_progresses" DROP COLUMN IF EXISTS "playDate";

CREATE UNIQUE INDEX IF NOT EXISTS "adventure_progresses_deviceId_episodeId_key"
  ON "adventure_progresses"("deviceId", "episodeId");
CREATE INDEX IF NOT EXISTS "adventure_progresses_deviceId_status_completedAt_idx"
  ON "adventure_progresses"("deviceId", "status", "completedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_daily_records_deviceId_assignedDate_key"
  ON "adventure_daily_records"("deviceId", "assignedDate");
CREATE INDEX IF NOT EXISTS "adventure_daily_records_deviceId_completedDate_idx"
  ON "adventure_daily_records"("deviceId", "completedDate");
CREATE INDEX IF NOT EXISTS "adventure_daily_records_deviceId_status_idx"
  ON "adventure_daily_records"("deviceId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "adventure_events_eventKey_key"
  ON "adventure_events"("eventKey");
CREATE INDEX IF NOT EXISTS "adventure_events_deviceId_createdAt_idx"
  ON "adventure_events"("deviceId", "createdAt");
CREATE INDEX IF NOT EXISTS "adventure_events_dailyRecordId_createdAt_idx"
  ON "adventure_events"("dailyRecordId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_daily_records_deviceId_fkey') THEN
    ALTER TABLE "adventure_daily_records" ADD CONSTRAINT "adventure_daily_records_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_daily_records_episodeId_fkey') THEN
    ALTER TABLE "adventure_daily_records" ADD CONSTRAINT "adventure_daily_records_episodeId_fkey"
      FOREIGN KEY ("episodeId") REFERENCES "adventure_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_events_deviceId_fkey') THEN
    ALTER TABLE "adventure_events" ADD CONSTRAINT "adventure_events_deviceId_fkey"
      FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_events_episodeId_fkey') THEN
    ALTER TABLE "adventure_events" ADD CONSTRAINT "adventure_events_episodeId_fkey"
      FOREIGN KEY ("episodeId") REFERENCES "adventure_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adventure_events_dailyRecordId_fkey') THEN
    ALTER TABLE "adventure_events" ADD CONSTRAINT "adventure_events_dailyRecordId_fkey"
      FOREIGN KEY ("dailyRecordId") REFERENCES "adventure_daily_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
