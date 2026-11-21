-- IP/角色 → timbreId 权威映射。
-- 产品决策（2026-11-21）：Elly=1000957（保持 staging 现值），Polly=1001022（有意调整）。
-- 种子即现行 CHARACTER_TIMBRE_JSON 的等价迁移；部署后 getvalue 由依赖 env 转为读本表。
CREATE TABLE "character_timbre" (
    "characterKey" TEXT NOT NULL,
    "timbreId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_timbre_pkey" PRIMARY KEY ("characterKey")
);

INSERT INTO "character_timbre" ("characterKey", "timbreId", "updatedAt") VALUES
    ('elly', '1000957', CURRENT_TIMESTAMP),
    ('polly', '1001022', CURRENT_TIMESTAMP);
