-- CreateTable
CREATE TABLE "voice_speed_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "normalSpd" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "sleepSpd" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_speed_config_pkey" PRIMARY KEY ("id")
);

-- 种子全局语速默认值：非哄睡 0.7 / 哄睡 0.5（产品决策，替代原三档映射与 env SPEECH_RATE_MAP_JSON）
INSERT INTO "voice_speed_config" ("id", "normalSpd", "sleepSpd", "updatedAt") VALUES
    ('default', 0.7, 0.5, CURRENT_TIMESTAMP);
