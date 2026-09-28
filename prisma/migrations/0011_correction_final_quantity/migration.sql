BEGIN;

ALTER TABLE "CorrectionRequest" ADD COLUMN "correctedQuantity" INTEGER;

UPDATE "CorrectionRequest" AS correction
SET "correctedQuantity" = (
  CASE WHEN movement."movementType" = 'EXIT'
    THEN -ABS(movement."quantity"::bigint)
    ELSE movement."quantity"::bigint
  END + correction."delta" + COALESCE((
    SELECT SUM(previous."delta")
    FROM "CorrectionRequest" AS previous
    WHERE previous."originalMovementId" = correction."originalMovementId"
      AND previous."id" <> correction."id"
      AND previous."status" = 'APPROVED'
      AND previous."reviewedAt" <= correction."createdAt"
  ), 0)
)::integer
FROM "InventoryMovement" AS movement
WHERE movement."id" = correction."originalMovementId";

ALTER TABLE "CorrectionRequest" ALTER COLUMN "correctedQuantity" SET NOT NULL;

CREATE UNIQUE INDEX "CorrectionRequest_one_pending_per_movement"
ON "CorrectionRequest" ("originalMovementId") WHERE "status" = 'PENDING';

COMMIT;
