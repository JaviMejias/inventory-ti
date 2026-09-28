DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Assignment"
    WHERE "createdById" IS NULL
       OR ("endedAt" IS NULL AND "endedById" IS NOT NULL)
       OR ("endedAt" IS NOT NULL AND "endedById" IS NULL)
       OR ("endedAt" IS NOT NULL AND "endedAt" <= "startedAt")
  ) THEN
    RAISE EXCEPTION 'Assignment data violates the Phase 6B integrity preconditions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Asset" asset
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_count
      FROM "Assignment" assignment
      WHERE assignment."assetId" = asset.id
        AND assignment."endedAt" IS NULL
    ) active_assignments ON TRUE
    WHERE (asset.status = 'ASSIGNED' AND active_assignments.active_count <> 1)
       OR (asset.status <> 'ASSIGNED' AND active_assignments.active_count <> 0)
  ) THEN
    RAISE EXCEPTION 'Asset and Assignment status are inconsistent';
  END IF;
END;
$$;

ALTER TABLE "Assignment"
ALTER COLUMN "createdById" SET NOT NULL;

ALTER TABLE "Assignment"
DROP CONSTRAINT "Assignment_createdById_fkey";

ALTER TABLE "Assignment"
DROP CONSTRAINT "Assignment_endedById_fkey";

ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_endedById_fkey"
FOREIGN KEY ("endedById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "Assignment_createdById_idx" ON "Assignment"("createdById");

ALTER TABLE "Assignment"
ADD CONSTRAINT "Assignment_end_metadata_consistent"
CHECK (("endedAt" IS NULL AND "endedById" IS NULL) OR ("endedAt" IS NOT NULL AND "endedById" IS NOT NULL));

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

CREATE TRIGGER "Assignment_history_immutable"
BEFORE UPDATE OR DELETE ON "Assignment"
FOR EACH ROW
EXECUTE FUNCTION prevent_assignment_history_mutation();

CREATE OR REPLACE FUNCTION validate_asset_assignment_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_asset_id UUID;
  asset_status "AssetStatus";
  active_assignment_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'Assignment' THEN
    IF TG_OP = 'DELETE' THEN
      affected_asset_id := OLD."assetId";
    ELSE
      affected_asset_id := NEW."assetId";
    END IF;
  ELSE
    affected_asset_id := NEW.id;
  END IF;

  SELECT asset.status
  INTO asset_status
  FROM "Asset" asset
  WHERE asset.id = affected_asset_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)
  INTO active_assignment_count
  FROM "Assignment" assignment
  WHERE assignment."assetId" = affected_asset_id
    AND assignment."endedAt" IS NULL;

  IF (asset_status = 'ASSIGNED'::"AssetStatus" AND active_assignment_count <> 1)
     OR (asset_status <> 'ASSIGNED'::"AssetStatus" AND active_assignment_count <> 0) THEN
    RAISE EXCEPTION 'Asset and Assignment status must remain consistent';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Assignment_asset_status_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "Assignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_asset_assignment_consistency();

CREATE CONSTRAINT TRIGGER "Asset_assignment_status_consistency"
AFTER INSERT OR UPDATE ON "Asset"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_asset_assignment_consistency();
