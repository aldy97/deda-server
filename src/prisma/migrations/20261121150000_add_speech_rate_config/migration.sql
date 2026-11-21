-- CreateTable
CREATE TABLE "speech_rate_configs" (
    "tier" TEXT NOT NULL,
    "spd" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "speech_rate_configs_pkey" PRIMARY KEY ("tier")
);

-- 种子默认 0.7 系档位映射（产品决策，替代原 env SPEECH_RATE_MAP_JSON 的值）
INSERT INTO "speech_rate_configs" ("tier", "spd", "updatedAt") VALUES
    ('slow', 0.56, CURRENT_TIMESTAMP),
    ('normal', 0.7, CURRENT_TIMESTAMP),
    ('fast', 0.875, CURRENT_TIMESTAMP);
