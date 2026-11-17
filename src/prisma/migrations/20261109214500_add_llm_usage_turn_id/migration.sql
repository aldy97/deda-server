-- AlterTable
ALTER TABLE "llm_usage_logs" ADD COLUMN     "turn_id" TEXT;

-- CreateIndex
CREATE INDEX "llm_usage_logs_turn_id_idx" ON "llm_usage_logs"("turn_id");
