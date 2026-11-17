-- 冒险内容版本化：整集快照 + 进度锁版 + retire 墓碑 + 内容操作审计。
-- 全部新增列可空，对空库与存量库均安全；无任何破坏性变更。

-- 1. adventure_episodes：墓碑与当前版本指针
ALTER TABLE "adventure_episodes" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);
ALTER TABLE "adventure_episodes" ADD COLUMN IF NOT EXISTS "currentVersionId" TEXT;

CREATE INDEX IF NOT EXISTS "adventure_episodes_characterKey_season_retiredAt_idx"
    ON "adventure_episodes"("characterKey", "season", "retiredAt");

-- 2. adventure_episode_versions：整集内容快照（已发布版本不可变）
CREATE TABLE IF NOT EXISTS "adventure_episode_versions" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contentHash" TEXT,
    "changeNote" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adventure_episode_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "adventure_episode_versions_episodeId_version_key"
    ON "adventure_episode_versions"("episodeId", "version");
CREATE INDEX IF NOT EXISTS "adventure_episode_versions_episodeId_status_idx"
    ON "adventure_episode_versions"("episodeId", "status");
CREATE INDEX IF NOT EXISTS "adventure_episode_versions_contentHash_idx"
    ON "adventure_episode_versions"("contentHash");

DO $$
BEGIN
    ALTER TABLE "adventure_episode_versions"
        ADD CONSTRAINT "adventure_episode_versions_episodeId_fkey"
        FOREIGN KEY ("episodeId") REFERENCES "adventure_episodes"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- 3. adventure_content_audit_logs：append-only 审计，故意无外键
CREATE TABLE IF NOT EXISTS "adventure_content_audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "episodeId" TEXT,
    "episodeVersionId" TEXT,
    "businessKey" TEXT NOT NULL,
    "actorUsername" TEXT NOT NULL,
    "actorDisplayName" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "reason" TEXT,
    "detail" JSONB,
    "sourceBundleHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adventure_content_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "adventure_content_audit_logs_episodeId_createdAt_idx"
    ON "adventure_content_audit_logs"("episodeId", "createdAt");
CREATE INDEX IF NOT EXISTS "adventure_content_audit_logs_actorUsername_createdAt_idx"
    ON "adventure_content_audit_logs"("actorUsername", "createdAt");
CREATE INDEX IF NOT EXISTS "adventure_content_audit_logs_action_createdAt_idx"
    ON "adventure_content_audit_logs"("action", "createdAt");

-- 4. 回填：把每集当前的 segments 表内容固化为 version 1。
--    contentHash 留空——迁移环境无法复现应用层 canonical sha256。
INSERT INTO "adventure_episode_versions" (
    "id", "episodeId", "version", "status", "payload", "contentHash", "changeNote",
    "createdBy", "createdByName", "publishedAt", "publishedBy", "supersededById",
    "createdAt", "updatedAt"
)
SELECT
    md5(random()::text || clock_timestamp()::text || e."id"),
    e."id",
    1,
    CASE WHEN e."published" THEN 'published' ELSE 'draft' END,
    jsonb_build_object(
        'title', e."title",
        'recap', e."recap",
        'segments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'order', s."order",
                'kind', s."kind",
                'text', s."text",
                'interactionType', s."interactionType",
                'options', s."options",
                'fallbackText', s."fallbackText",
                'exitText', s."exitText",
                'rewardStar', s."rewardStar"
            ) ORDER BY s."order" ASC)
            FROM "adventure_segments" s
            WHERE s."episodeId" = e."id"
        ), '[]'::jsonb)
    ),
    NULL,
    'migration baseline',
    'system:migration',
    'system:migration',
    CASE WHEN e."published" THEN CURRENT_TIMESTAMP ELSE NULL END,
    CASE WHEN e."published" THEN 'system:migration' ELSE NULL END,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "adventure_episodes" e
WHERE NOT EXISTS (
    SELECT 1 FROM "adventure_episode_versions" v
    WHERE v."episodeId" = e."id" AND v."version" = 1
);

UPDATE "adventure_episodes" e
SET "currentVersionId" = v."id"
FROM "adventure_episode_versions" v
WHERE v."episodeId" = e."id"
  AND v."version" = 1
  AND e."currentVersionId" IS NULL;

-- 5. adventure_progresses：锁定孩子当前所在的版本
ALTER TABLE "adventure_progresses" ADD COLUMN IF NOT EXISTS "episodeVersionId" TEXT;

UPDATE "adventure_progresses" p
SET "episodeVersionId" = e."currentVersionId"
FROM "adventure_episodes" e
WHERE e."id" = p."episodeId"
  AND p."episodeVersionId" IS NULL
  AND e."currentVersionId" IS NOT NULL;
