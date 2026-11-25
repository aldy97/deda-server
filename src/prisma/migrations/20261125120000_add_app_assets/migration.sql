-- 展示型 Elly 素材（AppAsset）：运营上传、小程序按 key 展示、失败回退包内图。
-- 每个 key 最多一条 published，由 partial unique index 兜底。

-- CreateTable
CREATE TABLE "app_assets" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "app_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_assets_key_version_key" ON "app_assets"("key", "version");

-- CreateIndex
CREATE INDEX "app_assets_key_status_idx" ON "app_assets"("key", "status");

-- Partial unique index：每个 key 最多一条 published。
CREATE UNIQUE INDEX "app_assets_one_published_per_key" ON "app_assets"("key") WHERE "status" = 'published';
