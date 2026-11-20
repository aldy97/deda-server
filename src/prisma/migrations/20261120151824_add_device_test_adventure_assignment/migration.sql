-- 注意：prisma migrate diff 原本还会生成一条
--   DROP INDEX "adventure_episodes_season_episodeNumber_key";
-- 那是仓库既存漂移（真实库里 adventure_episodes 的唯一约束名与 schema 的
--   @@unique([characterKey, season, episodeNumber]) 期望名不一致）被 diff 顺手
-- 报告的结果，与本迁移无关，且删掉会破坏集内唯一约束。已剔除，漂移另行修复。

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "testAdventureEpisodeId" TEXT,
ADD COLUMN     "testAdventureEpisodeVersionId" TEXT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_testAdventureEpisodeId_fkey" FOREIGN KEY ("testAdventureEpisodeId") REFERENCES "adventure_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_testAdventureEpisodeVersionId_fkey" FOREIGN KEY ("testAdventureEpisodeVersionId") REFERENCES "adventure_episode_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
