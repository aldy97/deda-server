-- Remove legacy single-value feedback columns.
-- Per-user feedback is stored exclusively in parent_report_feedbacks.
ALTER TABLE "parent_reports"
  DROP COLUMN "feedback",
  DROP COLUMN "feedbackAt",
  DROP COLUMN "feedbackUserId";
