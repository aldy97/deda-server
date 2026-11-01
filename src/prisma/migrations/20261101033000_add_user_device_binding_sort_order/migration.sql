-- Add each parent's independent device ordering.
ALTER TABLE "user_device_bindings"
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Preserve a deterministic order for existing bindings.
WITH ranked_bindings AS (
  SELECT
    "id",
    CAST(
      ROW_NUMBER() OVER (
        PARTITION BY "userId"
        ORDER BY "createdAt" ASC, "deviceId" ASC, "id" ASC
      ) - 1 AS INTEGER
    ) AS "newSortOrder"
  FROM "user_device_bindings"
)
UPDATE "user_device_bindings" AS binding
SET "sortOrder" = ranked."newSortOrder"
FROM ranked_bindings AS ranked
WHERE binding."id" = ranked."id";

CREATE INDEX "user_device_bindings_userId_sortOrder_idx"
ON "user_device_bindings"("userId", "sortOrder");
