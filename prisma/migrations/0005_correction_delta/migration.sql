ALTER TABLE "CorrectionRequest" ADD COLUMN "delta" INTEGER;

DO $$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  WHERE correction."status" IS DISTINCT FROM 'APPROVED'::"CorrectionStatus"
     OR correction."compensatingMovementId" IS NULL;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: requests must be APPROVED and have a compensating movement. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  LEFT JOIN "InventoryMovement" AS compensating
    ON compensating."id" = correction."compensatingMovementId"
  WHERE compensating."id" IS NULL;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: compensating movement does not exist. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  JOIN "InventoryMovement" AS compensating
    ON compensating."id" = correction."compensatingMovementId"
  WHERE compensating."movementType" IS DISTINCT FROM 'ADJUSTMENT'::"MovementType"
     OR compensating."quantity" = 0;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: compensating movements must be non-zero ADJUSTMENTs. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  LEFT JOIN "InventoryMovement" AS original
    ON original."id" = correction."originalMovementId"
  WHERE original."id" IS NULL;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: original movement does not exist. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  JOIN "InventoryMovement" AS original
    ON original."id" = correction."originalMovementId"
  JOIN "InventoryMovement" AS compensating
    ON compensating."id" = correction."compensatingMovementId"
  WHERE compensating."id" = original."id"
     OR compensating."productId" IS DISTINCT FROM original."productId"
     OR compensating."locationId" IS DISTINCT FROM original."locationId";

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: original and compensating movements are inconsistent. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."id"::text, ', ' ORDER BY correction."id")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  JOIN "InventoryMovement" AS compensating
    ON compensating."id" = correction."compensatingMovementId"
  WHERE compensating."reference" IS DISTINCT FROM ('correction:' || correction."id")
     OR (
       SELECT COUNT(*)
       FROM "InventoryMovement" AS referenced
       WHERE referenced."reference" = ('correction:' || correction."id")
     ) <> 1;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: compensating movement reference is missing, inconsistent, or ambiguous. IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."originalMovementId"::text, ', ' ORDER BY correction."originalMovementId")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  GROUP BY correction."originalMovementId"
  HAVING COUNT(*) > 1;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: more than one correction exists for an original movement. Original movement IDs: %', invalid_ids;
  END IF;

  SELECT string_agg(correction."compensatingMovementId"::text, ', ' ORDER BY correction."compensatingMovementId")
  INTO invalid_ids
  FROM "CorrectionRequest" AS correction
  WHERE correction."compensatingMovementId" IS NOT NULL
  GROUP BY correction."compensatingMovementId"
  HAVING COUNT(*) > 1;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot recover CorrectionRequest.delta: a compensating movement is linked to multiple corrections. Movement IDs: %', invalid_ids;
  END IF;
END $$;

UPDATE "CorrectionRequest" AS correction
SET "delta" = compensating."quantity"
FROM "InventoryMovement" AS compensating
WHERE correction."compensatingMovementId" = compensating."id"
  AND correction."delta" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CorrectionRequest" WHERE "delta" IS NULL) THEN
    RAISE EXCEPTION 'Cannot make CorrectionRequest.delta required: existing requests need an explicit compensating delta';
  END IF;
END $$;

ALTER TABLE "CorrectionRequest" ALTER COLUMN "delta" SET NOT NULL;
