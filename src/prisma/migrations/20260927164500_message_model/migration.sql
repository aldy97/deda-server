-- 细颗粒度消息模型：一行一条消息,一轮问答由 turnId 关联
-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "conversationId" TEXT,
    "hitUnitIds" TEXT[],
    "textbookId" TEXT,
    "unitId" TEXT,
    "mode" TEXT,
    "conversationModeKey" TEXT,
    "cefrLevel" TEXT,
    "rawPayload" JSONB,
    "spokeAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- 旧 conversations 表在初始迁移中没有该列；回放 backfill 前补齐，NULL 表示旧记录无模式键。
ALTER TABLE "conversations" ADD COLUMN "conversationModeKey" TEXT;

-- Backfill: 每条 conversation 拆成 user + assistant 两条消息,turnId = 原行 id
INSERT INTO "messages" ("id", "deviceId", "turnId", "role", "content", "status", "conversationId", "hitUnitIds", "textbookId", "unitId", "mode", "conversationModeKey", "cefrLevel", "rawPayload", "spokeAt", "createdAt")
SELECT gen_random_uuid()::text, c."deviceId", c."id", 'user', c."asrText", 'completed', c."conversationId", c."hitUnitIds", c."textbookId", c."unitId", c."mode", c."conversationModeKey", c."cefrLevel", c."rawPayload", c."spokeAt", c."createdAt"
FROM "conversations" c
WHERE c."asrText" IS NOT NULL AND c."deletedAt" IS NULL;

INSERT INTO "messages" ("id", "deviceId", "turnId", "role", "content", "status", "conversationId", "hitUnitIds", "textbookId", "unitId", "mode", "conversationModeKey", "cefrLevel", "rawPayload", "spokeAt", "createdAt")
SELECT gen_random_uuid()::text, c."deviceId", c."id", 'assistant', c."aiReply", 'completed', c."conversationId", '{}', c."textbookId", c."unitId", c."mode", c."conversationModeKey", c."cefrLevel", NULL, c."spokeAt" + interval '1 second', c."createdAt"
FROM "conversations" c
WHERE c."aiReply" IS NOT NULL AND c."deletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_role_key" ON "messages"("conversationId", "role");

-- CreateIndex
CREATE INDEX "messages_deviceId_spokeAt_idx" ON "messages"("deviceId", "spokeAt");

-- CreateIndex
CREATE INDEX "messages_turnId_idx" ON "messages"("turnId");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropTable
DROP TABLE "conversations";
