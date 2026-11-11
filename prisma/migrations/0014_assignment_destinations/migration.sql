BEGIN;

CREATE TYPE "AssignmentRecipientType" AS ENUM ('PERSON', 'OFFICE');
CREATE TYPE "AssignmentType" AS ENUM ('STANDARD', 'LOAN');

ALTER TABLE "Assignment"
  ALTER COLUMN "personName" DROP NOT NULL,
  ADD COLUMN "recipientType" "AssignmentRecipientType" NOT NULL DEFAULT 'PERSON',
  ADD COLUMN "officeName" VARCHAR(160),
  ADD COLUMN "assignmentType" "AssignmentType" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "expectedReturnAt" TIMESTAMP(3),
  ADD COLUMN "ticketReference" VARCHAR(160),
  ADD COLUMN "otReference" VARCHAR(160),
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "returnTicketReference" VARCHAR(160),
  ADD COLUMN "returnOtReference" VARCHAR(160),
  ADD COLUMN "returnNotes" TEXT,
  ADD COLUMN "returnStatus" "AssetStatus",
  ADD COLUMN "returnRecordedAt" TIMESTAMP(3);

ALTER TABLE "Assignment"
  ADD CONSTRAINT "Assignment_recipient_consistent" CHECK (
    ("recipientType" = 'PERSON' AND "personName" IS NOT NULL AND "officeName" IS NULL)
    OR ("recipientType" = 'OFFICE' AND "officeName" IS NOT NULL AND btrim("officeName") <> '' AND "personName" IS NULL AND "personId" IS NULL)
  ),
  ADD CONSTRAINT "Assignment_expected_return_consistent" CHECK (
    "expectedReturnAt" IS NULL OR ("assignmentType" = 'LOAN' AND "expectedReturnAt" > "startedAt")
  ),
  ADD CONSTRAINT "Assignment_return_metadata_consistent" CHECK (
    "endedAt" IS NOT NULL OR (
      "returnTicketReference" IS NULL AND "returnOtReference" IS NULL AND "returnNotes" IS NULL
      AND "returnStatus" IS NULL AND "returnRecordedAt" IS NULL
    )
  ),
  ADD CONSTRAINT "Assignment_return_status_valid" CHECK (
    "returnStatus" IS NULL OR "returnStatus" IN ('AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR')
  );

CREATE OR REPLACE FUNCTION prevent_assignment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Assignment records are immutable and cannot be deleted';
  END IF;

  IF OLD."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Closed Assignment records cannot be modified';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."assetId" IS DISTINCT FROM OLD."assetId"
     OR NEW."personId" IS DISTINCT FROM OLD."personId"
     OR NEW."personName" IS DISTINCT FROM OLD."personName"
     OR NEW."recipientType" IS DISTINCT FROM OLD."recipientType"
     OR NEW."officeName" IS DISTINCT FROM OLD."officeName"
     OR NEW."assignmentType" IS DISTINCT FROM OLD."assignmentType"
     OR NEW."expectedReturnAt" IS DISTINCT FROM OLD."expectedReturnAt"
     OR NEW."ticketReference" IS DISTINCT FROM OLD."ticketReference"
     OR NEW."otReference" IS DISTINCT FROM OLD."otReference"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Assignment history fields cannot be modified';
  END IF;

  IF NEW."endedAt" IS NULL OR NEW."endedById" IS NULL THEN
    RAISE EXCEPTION 'An active Assignment can only transition to a closed Assignment';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
