/*
  Warnings:

  - Added the required column `content` to the `units` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "textbooks" ADD COLUMN     "promptTemplate" TEXT;

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "content" TEXT NOT NULL,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "difficulty" INTEGER;

-- CreateTable
CREATE TABLE "textbook_sync_logs" (
    "id" TEXT NOT NULL,
    "textbookId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "textbook_sync_logs_pkey" PRIMARY KEY ("id")
);
