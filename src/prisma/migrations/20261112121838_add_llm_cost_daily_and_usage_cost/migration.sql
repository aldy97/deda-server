-- AlterTable
ALTER TABLE "llm_usage_logs" ADD COLUMN     "cacheHitInputTokens" INTEGER,
ADD COLUMN     "costMicroCny" INTEGER;

-- CreateTable
CREATE TABLE "llm_cost_daily" (
    "id" TEXT NOT NULL,
    "billDate" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'aliyun',
    "productCode" TEXT NOT NULL,
    "productName" TEXT,
    "billingItem" TEXT NOT NULL,
    "billingItemCode" TEXT NOT NULL DEFAULT '',
    "instanceId" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'unknown',
    "tier" TEXT NOT NULL DEFAULT 'small',
    "itemKind" TEXT NOT NULL,
    "subscriptionType" TEXT NOT NULL DEFAULT 'PayAsYouGo',
    "usage" INTEGER,
    "usageUnit" TEXT,
    "grossMicroCny" INTEGER NOT NULL,
    "payableMicroCny" INTEGER NOT NULL,
    "cashMicroCny" INTEGER NOT NULL DEFAULT 0,
    "resourcePackMicroCny" INTEGER NOT NULL DEFAULT 0,
    "couponMicroCny" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_cost_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_cost_daily_dedupeKey_key" ON "llm_cost_daily"("dedupeKey");

-- CreateIndex
CREATE INDEX "llm_cost_daily_billDate_idx" ON "llm_cost_daily"("billDate");

-- CreateIndex
CREATE INDEX "llm_cost_daily_billDate_tier_idx" ON "llm_cost_daily"("billDate", "tier");
