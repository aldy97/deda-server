-- CreateTable
CREATE TABLE "parent_report_feedbacks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "report_date" TEXT NOT NULL,
    "is_useful" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_report_feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parent_report_feedbacks_user_id_device_id_report_date_key" ON "parent_report_feedbacks"("user_id", "device_id", "report_date");

-- CreateIndex
CREATE INDEX "parent_report_feedbacks_device_id_report_date_idx" ON "parent_report_feedbacks"("device_id", "report_date");

-- AddForeignKey
ALTER TABLE "parent_report_feedbacks" ADD CONSTRAINT "parent_report_feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_report_feedbacks" ADD CONSTRAINT "parent_report_feedbacks_device_id_report_date_fkey" FOREIGN KEY ("device_id", "report_date") REFERENCES "parent_reports"("deviceId", "reportDate") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill feedback whose owner is known; legacy columns remain intact.
INSERT INTO "parent_report_feedbacks" (
    "id",
    "user_id",
    "device_id",
    "report_date",
    "is_useful",
    "created_at",
    "updated_at"
)
SELECT
    'prf_' || md5("id" || ':' || "feedbackUserId"),
    "feedbackUserId",
    "deviceId",
    "reportDate",
    "feedback" = 'useful',
    COALESCE("feedbackAt", "createdAt"),
    COALESCE("feedbackAt", "createdAt")
FROM "parent_reports"
WHERE "feedbackUserId" IS NOT NULL
  AND "feedback" IN ('useful', 'not_useful')
ON CONFLICT ("user_id", "device_id", "report_date") DO NOTHING;
