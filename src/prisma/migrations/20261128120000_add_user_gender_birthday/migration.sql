-- AlterTable
ALTER TABLE "users" ADD COLUMN "gender" TEXT,
ADD COLUMN "birthday" TEXT;

-- DropIndex
-- 反馈回写手机号后，多个家长账号可能填写同一号码；展示层用「重复」标记载荷。
DROP INDEX "users_phone_key";
