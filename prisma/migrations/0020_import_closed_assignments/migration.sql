BEGIN;

ALTER TABLE "Assignment" ADD COLUMN "importedHistory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Assignment" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_end_metadata_consistent";
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_import_actor_consistent" CHECK (
  ("importedHistory" AND "createdById" IS NULL AND "endedById" IS NULL AND "endedAt" IS NOT NULL AND "endedAt" > "startedAt"
    AND "personId" IS NULL AND "expectedReturnAt" IS NULL AND "returnStatus" IS NOT NULL AND "returnRecordedAt" IS NOT NULL)
  OR (NOT "importedHistory" AND "createdById" IS NOT NULL AND
    (("endedAt" IS NULL AND "endedById" IS NULL) OR ("endedAt" IS NOT NULL AND "endedById" IS NOT NULL)))
);

CREATE TABLE "ImportAssignmentApplication" (
  "id" UUID NOT NULL PRIMARY KEY,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL,
  "plan" JSONB NOT NULL,
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportAssignmentApplication_assetId_requestId_key" ON "ImportAssignmentApplication"("assetId", "requestId");
CREATE UNIQUE INDEX "ImportAssignmentApplication_planId_key" ON "ImportAssignmentApplication"("planId");
CREATE INDEX "ImportAssignmentApplication_assetId_appliedAt_id_idx" ON "ImportAssignmentApplication"("assetId", "appliedAt", "id");

CREATE TABLE "ImportAssignmentItem" (
  "id" UUID NOT NULL PRIMARY KEY,
  "applicationId" UUID NOT NULL REFERENCES "ImportAssignmentApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "periodId" UUID NOT NULL,
  "assignmentId" UUID NOT NULL REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "startEvidenceId" UUID NOT NULL,
  "endEvidenceId" UUID NOT NULL CHECK ("endEvidenceId" <> "startEvidenceId"),
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object')
);
CREATE UNIQUE INDEX "ImportAssignmentItem_assignmentId_key" ON "ImportAssignmentItem"("assignmentId");
CREATE UNIQUE INDEX "ImportAssignmentItem_applicationId_periodId_key" ON "ImportAssignmentItem"("applicationId", "periodId");

CREATE TABLE "ImportAssignmentEvidenceUse" (
  "evidenceId" UUID NOT NULL PRIMARY KEY REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "itemId" UUID NOT NULL REFERENCES "ImportAssignmentItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "endpoint" VARCHAR(5) NOT NULL CHECK ("endpoint" IN ('START', 'END'))
);
CREATE UNIQUE INDEX "ImportAssignmentEvidenceUse_itemId_endpoint_key" ON "ImportAssignmentEvidenceUse"("itemId", "endpoint");

CREATE FUNCTION guard_import_assignment_application() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical assignment receipts are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  IF NEW."rulesVersion" <> 'mda-closed-assignment-plan-1' OR NEW."plan"->>'planId' IS DISTINCT FROM NEW."planId" OR
    NEW."plan"->'assetBefore'->>'id' IS DISTINCT FROM NEW."assetId"::text OR NOT ((
      NEW."plan" @> '{"scope":"CLOSED_ASSIGNMENT_HISTORY_PLAN","planValidationComplete":true,"affectsCurrentState":false}'::jsonb AND
      jsonb_typeof(NEW."plan"->'periods') = 'array' AND jsonb_array_length(NEW."plan"->'periods') BETWEEN 1 AND 25
    ) IS TRUE) THEN RAISE EXCEPTION 'Historical receipt requires a valid closed assignment plan' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportAssignmentApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_application();

CREATE FUNCTION guard_import_assignment_period() RETURNS trigger AS $$
BEGIN
  -- All writers serialize on the asset, including legacy SQL writers.
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  IF NEW."importedHistory" THEN
    IF NEW."endedAt" IS NULL OR NEW."endedAt" <= NEW."startedAt" OR NEW."startedAt" < TIMESTAMP '1900-01-01' OR
      NEW."endedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR NEW."createdAt" < NEW."endedAt" OR
      NOT EXISTS (SELECT 1 FROM "Asset" a JOIN "Product" p ON p."id" = a."productId" WHERE a."id" = NEW."assetId" AND p."trackingMode" = 'ASSET'
        AND (a."status" <> 'DECOMMISSIONED' OR a."decommissionedAt" IS NOT NULL) AND (a."decommissionedAt" IS NULL OR NEW."endedAt" <= a."decommissionedAt")) THEN
      RAISE EXCEPTION 'Imported assignments require a past closed period before any decommission' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW."importedHistory" OR EXISTS (SELECT 1 FROM "Assignment" WHERE "assetId" = NEW."assetId" AND "importedHistory")) AND EXISTS (
    SELECT 1 FROM "Assignment" a WHERE a."assetId" = NEW."assetId" AND a."id" <> NEW."id" AND
      NEW."startedAt" < coalesce(a."endedAt", 'infinity'::timestamp) AND coalesce(NEW."endedAt", 'infinity'::timestamp) > a."startedAt"
  ) THEN RAISE EXCEPTION 'Assignments cannot overlap imported closed history' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_import_period_guard" BEFORE INSERT OR UPDATE ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_period();

CREATE FUNCTION guard_import_assignment_item() RETURNS trigger AS $$
DECLARE
  application "ImportAssignmentApplication"%ROWTYPE;
  assignment "Assignment"%ROWTYPE;
  start_evidence "ImportHistoricalEvidence"%ROWTYPE;
  end_evidence "ImportHistoricalEvidence"%ROWTYPE;
  period JSONB;
  proposal JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical assignment items are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO application FROM "ImportAssignmentApplication" WHERE "id" = NEW."applicationId";
  SELECT value INTO period FROM jsonb_array_elements(application."plan"->'periods') WHERE value->>'periodId' = NEW."periodId"::text;
  proposal := period->'proposedAssignment';
  IF period IS NULL OR NEW."snapshot" IS DISTINCT FROM period OR period->>'valid' IS DISTINCT FROM 'true' OR
    period->>'confirmation' IS DISTINCT FROM 'VERIFIED_CLOSED_ASSIGNMENT' OR
    period->'start'->>'evidenceId' IS DISTINCT FROM NEW."startEvidenceId"::text OR period->'end'->>'evidenceId' IS DISTINCT FROM NEW."endEvidenceId"::text OR
    length(btrim(coalesce(period->'start'->>'dateEvidenceReference', ''))) = 0 OR length(btrim(coalesce(period->'end'->>'dateEvidenceReference', ''))) = 0 THEN
    RAISE EXCEPTION 'Historical assignment item must retain its confirmed period and timestamp proof' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO assignment FROM "Assignment" WHERE "id" = NEW."assignmentId";
  IF assignment."id" IS NULL OR NOT assignment."importedHistory" OR assignment."assetId" IS DISTINCT FROM application."assetId" OR
    assignment."createdById" IS NOT NULL OR assignment."endedById" IS NOT NULL OR
    assignment."startedAt" IS DISTINCT FROM (proposal->>'startedAt')::timestamptz AT TIME ZONE 'UTC' OR
    assignment."endedAt" IS DISTINCT FROM (proposal->>'endedAt')::timestamptz AT TIME ZONE 'UTC' OR
    assignment."startedAt" IS DISTINCT FROM (period->'start'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC' OR
    assignment."endedAt" IS DISTINCT FROM (period->'end'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC' OR
    assignment."recipientType"::text IS DISTINCT FROM proposal->>'recipientType' OR assignment."personName" IS DISTINCT FROM proposal->>'personName' OR
    assignment."officeName" IS DISTINCT FROM proposal->>'officeName' OR assignment."assignmentType"::text IS DISTINCT FROM proposal->>'assignmentType' OR
    assignment."returnStatus"::text IS DISTINCT FROM proposal->>'returnStatus' OR
    assignment."ticketReference" IS DISTINCT FROM proposal->>'ticketReference' OR assignment."otReference" IS DISTINCT FROM proposal->>'otReference' OR
    assignment."returnTicketReference" IS DISTINCT FROM proposal->>'returnTicketReference' OR assignment."returnOtReference" IS DISTINCT FROM proposal->>'returnOtReference' OR
    assignment."notes" IS DISTINCT FROM period->>'note' OR assignment."returnNotes" IS DISTINCT FROM period->>'evidenceReference' OR
    assignment."createdAt" IS DISTINCT FROM application."appliedAt" OR assignment."returnRecordedAt" IS DISTINCT FROM application."appliedAt" THEN
    RAISE EXCEPTION 'Imported assignment must match its immutable proposal without historical actors' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO start_evidence FROM "ImportHistoricalEvidence" WHERE "id" = NEW."startEvidenceId";
  SELECT * INTO end_evidence FROM "ImportHistoricalEvidence" WHERE "id" = NEW."endEvidenceId";
  IF start_evidence."id" IS NULL OR end_evidence."id" IS NULL OR start_evidence."assetId" IS DISTINCT FROM application."assetId" OR
    end_evidence."assetId" IS DISTINCT FROM application."assetId" OR start_evidence."kind" NOT IN ('USAGE_OBSERVATION', 'LOAN_OBSERVATION') OR
    end_evidence."kind" NOT IN ('RECEIPT_OBSERVATION', 'USAGE_OBSERVATION') OR
    (start_evidence."sourceHash" = end_evidence."sourceHash" AND start_evidence."recordId" = end_evidence."recordId") THEN
    RAISE EXCEPTION 'Closed assignment requires two distinct linked physical endpoint observations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportAssignmentItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_item();

CREATE FUNCTION guard_import_assignment_evidence_use() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Assignment evidence ownership is immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "id" = NEW."itemId" AND
    CASE NEW."endpoint" WHEN 'START' THEN "startEvidenceId" = NEW."evidenceId" WHEN 'END' THEN "endEvidenceId" = NEW."evidenceId" ELSE false END) THEN
    RAISE EXCEPTION 'Evidence ownership must match its exact endpoint' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentEvidenceUse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportAssignmentEvidenceUse"
FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_evidence_use();

CREATE FUNCTION verify_import_assignment_complete() RETURNS trigger AS $$
DECLARE current_asset "Asset"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'Assignment' THEN
    IF NEW."importedHistory" AND NOT EXISTS (SELECT 1 FROM "ImportAssignmentItem" i WHERE i."assignmentId" = NEW."id" AND
      (SELECT count(*) FROM "ImportAssignmentEvidenceUse" WHERE "itemId" = i."id") = 2) THEN
      RAISE EXCEPTION 'Imported assignments require a complete immutable origin receipt' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (SELECT count(*) FROM "ImportAssignmentItem" WHERE "applicationId" = NEW."id") <> jsonb_array_length(NEW."plan"->'periods') THEN
      RAISE EXCEPTION 'Every historical period requires one imported assignment item' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO current_asset FROM "Asset" WHERE "id" = NEW."assetId";
    IF current_asset."status"::text IS DISTINCT FROM NEW."plan"->'assetBefore'->>'status' OR
      current_asset."isActive" IS DISTINCT FROM (NEW."plan"->'assetBefore'->>'isActive')::boolean OR
      current_asset."decommissionedAt" IS DISTINCT FROM (NEW."plan"->'assetBefore'->>'decommissionedAt')::timestamptz AT TIME ZONE 'UTC' OR
      current_asset."updatedAt" IS DISTINCT FROM (NEW."plan"->'assetBefore'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' THEN
      RAISE EXCEPTION 'Historical application cannot change current asset state' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Assignment_import_origin_guard" AFTER INSERT ON "Assignment"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_assignment_complete();
CREATE CONSTRAINT TRIGGER "ImportAssignmentApplication_complete_guard" AFTER INSERT ON "ImportAssignmentApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_assignment_complete();

COMMIT;
