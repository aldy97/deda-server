-- AlterTable: llm_usage_logs 增加失败细节紧凑串（如 "ECONNRESET: socket hang up"），
-- 供 dashboard 失败列表与链路节点直接展示，避免翻容器日志
ALTER TABLE "llm_usage_logs" ADD COLUMN "failureDetail" VARCHAR(200);
