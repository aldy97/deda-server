ALTER TABLE "messages" DROP COLUMN "conversationModeKey";
ALTER TABLE "device_configs" DROP COLUMN "conversationModeKey";
DROP TABLE "conversation_modes";
DROP TABLE "conversation_mode_categories";