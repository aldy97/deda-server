-- 将旧教材模式历史数据归一到唯一的英语对话顶层模式。
UPDATE "device_configs"
SET "mode" = 'english_chat', "conversationModeKey" = NULL
WHERE "mode" IN ('textbook_learning', 'locked_unit', 'free_textbook');

UPDATE "messages"
SET "mode" = 'english_chat', "conversationModeKey" = NULL
WHERE "mode" IN ('textbook_learning', 'locked_unit', 'free_textbook');

-- 仅删除教材分类及其级联子模式，保留自由对话分类和三个子模式。
DELETE FROM "conversation_mode_categories"
WHERE "key" = 'textbook_learning';

INSERT INTO "conversation_mode_categories" (
    "id", "key", "name", "description", "sortOrder", "isActive", "createdAt", "updatedAt"
)
VALUES (
    gen_random_uuid()::text,
    'english_chat',
    '英语对话',
    '围绕孩子兴趣进行开放式英语对话',
    1,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "device_configs"
DROP COLUMN "textbookId",
DROP COLUMN "unitId";

ALTER TABLE "messages"
DROP COLUMN "hitUnitIds",
DROP COLUMN "textbookId",
DROP COLUMN "unitId";

DROP TABLE "units";
DROP TABLE "textbooks";
DROP TABLE "textbook_sync_logs";
