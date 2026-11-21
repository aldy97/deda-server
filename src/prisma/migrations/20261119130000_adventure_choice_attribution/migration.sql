-- 注意：prisma migrate dev 原本还在这里生成了一条
--   DROP INDEX "parent_reports_generationStatus_nextRetryAt_idx";
-- 那是仓库既存漂移（该索引由 20261031100000_add_parent_report_generation_state 创建，
-- 真实库里都存在，但 schema.prisma 的 ParentReport 未声明 @@index）被 migrate dev
-- 顺手补齐的结果，与本迁移无关，且会在生产上删掉家长报告重试调度的索引。已剔除。
-- 漂移本身另行修复，不在本 PR 范围内。

-- AlterTable
ALTER TABLE "adventure_events" ADD COLUMN     "episodeVersionId" TEXT;

-- CreateIndex
CREATE INDEX "adventure_events_episodeId_eventType_createdAt_idx" ON "adventure_events"("episodeId", "eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "adventure_events" ADD CONSTRAINT "adventure_events_episodeVersionId_fkey" FOREIGN KEY ("episodeVersionId") REFERENCES "adventure_episode_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
