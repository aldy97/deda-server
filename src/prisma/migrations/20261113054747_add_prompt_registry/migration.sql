-- 注意：prisma migrate dev 原本还在这里生成了一条
--   DROP INDEX "parent_reports_generationStatus_nextRetryAt_idx";
-- 那是仓库既存漂移（该索引由 20261031100000_add_parent_report_generation_state 创建，
-- 真实库里都存在，但 schema.prisma 的 ParentReport 未声明 @@index）被 migrate dev
-- 顺手补齐的结果，与本迁移无关，且会在生产上删掉家长报告重试调度的索引。已剔除。
-- 漂移本身另行修复，不在本 PR 范围内。

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "scene" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "renderSchema" JSONB,
    "draftRevision" INTEGER,
    "publishedRevision" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "changeNote" TEXT,
    "authorUsername" TEXT NOT NULL,
    "authorDisplayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "prompt_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_key" ON "prompt_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_template_versions_templateId_revision_key" ON "prompt_template_versions"("templateId", "revision");

-- AddForeignKey
ALTER TABLE "prompt_template_versions" ADD CONSTRAINT "prompt_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "prompt_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
