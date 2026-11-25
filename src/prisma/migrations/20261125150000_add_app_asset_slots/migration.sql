-- 展示位注册表：key = page/suffix。迁移只 seed 内置探针，
-- 业务展示位由 dashboard 创建（staging / prod 各自建，不做跨环境搬运）。

CREATE TABLE "app_asset_slots" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_asset_slots_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "app_asset_slots_enabled_idx" ON "app_asset_slots"("enabled");
CREATE INDEX "app_asset_slots_page_idx" ON "app_asset_slots"("page");

INSERT INTO "app_asset_slots" ("key", "label", "page", "enabled", "createdAt", "updatedAt")
VALUES ('diagnostics/remote-probe', '远程素材探针', 'diagnostics', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
