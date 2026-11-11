BEGIN;

CREATE TABLE "ImportEvidenceAmendment" (
  "id" UUID NOT NULL PRIMARY KEY,
  "evidenceId" UUID NOT NULL REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" BETWEEN 1 AND 1000),
  "previousAmendmentId" UUID,
  "batchVersion" INTEGER NOT NULL CHECK ("batchVersion" >= 1),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "amendmentPlanId" VARCHAR(64) NOT NULL CHECK ("amendmentPlanId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-history-amendment-1'),
  "assetId" UUID REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "effectiveDay" VARCHAR(10) CHECK ("effectiveDay" IS NULL OR (
    "effectiveDay" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "effectiveDay" >= '1900-01-01' AND to_char("effectiveDay"::date, 'YYYY-MM-DD') = "effectiveDay"
  )),
  "snapshot" JSONB NOT NULL CHECK ((jsonb_typeof("snapshot") = 'object' AND "snapshot" @> '{"affectsCurrentState":false,"historicalActorId":null}'::jsonb) IS TRUE),
  "note" VARCHAR(2000) NOT NULL CHECK (length(btrim("note")) > 0),
  "evidenceReference" VARCHAR(500) NOT NULL CHECK (length(btrim("evidenceReference")) > 0),
  "amendedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "amendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportEvidenceAmendment_evidenceId_version_key" ON "ImportEvidenceAmendment"("evidenceId", "version");
CREATE UNIQUE INDEX "ImportEvidenceAmendment_evidenceId_requestId_key" ON "ImportEvidenceAmendment"("evidenceId", "requestId");
CREATE INDEX "ImportEvidenceAmendment_assetId_evidenceId_version_idx" ON "ImportEvidenceAmendment"("assetId", "evidenceId", "version");
CREATE INDEX "ImportAssignmentItem_startEvidenceId_idx" ON "ImportAssignmentItem"("startEvidenceId");
CREATE INDEX "ImportAssignmentItem_endEvidenceId_idx" ON "ImportAssignmentItem"("endEvidenceId");

CREATE VIEW "ImportHistoricalEvidenceCurrent" AS
SELECT e."id", e."captureId", e."sourceHash", e."recordId", e."candidateId", e."kind", e."capturedAt",
  CASE WHEN a."id" IS NULL THEN e."assetId" ELSE a."assetId" END AS "assetId",
  CASE WHEN a."id" IS NULL THEN e."effectiveDay" ELSE a."effectiveDay" END AS "effectiveDay",
  CASE WHEN a."id" IS NULL THEN e."snapshot" ELSE a."snapshot" END AS "snapshot",
  coalesce(a."sourceRevision", c."sourceRevision") AS "sourceRevision",
  coalesce(a."version", 0) AS "evidenceVersion", a."id" AS "amendmentId"
FROM "ImportHistoricalEvidence" e JOIN "ImportHistoryCapture" c ON c."id" = e."captureId"
LEFT JOIN LATERAL (SELECT * FROM "ImportEvidenceAmendment" WHERE "evidenceId" = e."id" ORDER BY "version" DESC LIMIT 1) a ON true;

CREATE FUNCTION guard_import_evidence_amendment() RETURNS trigger AS $$
DECLARE
  evidence "ImportHistoricalEvidence"%ROWTYPE;
  capture "ImportHistoryCapture"%ROWTYPE;
  batch "ImportBatch"%ROWTYPE;
  previous "ImportEvidenceAmendment"%ROWTYPE;
  latest_decision "ImportReviewDecision"%ROWTYPE;
  identity_revision INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical evidence amendments are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO evidence FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = capture."batchId" FOR NO KEY UPDATE;
  IF batch."id" IS NULL THEN RAISE EXCEPTION 'Evidence amendment requires its original batch' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(evidence."sourceHash", 0));
  PERFORM 1 FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId" FOR NO KEY UPDATE;
  SELECT * INTO previous FROM "ImportEvidenceAmendment" WHERE "evidenceId" = NEW."evidenceId" ORDER BY "version" DESC LIMIT 1;
  IF NEW."version" <> coalesce(previous."version", 0) + 1 OR NEW."previousAmendmentId" IS DISTINCT FROM previous."id" THEN
    RAISE EXCEPTION 'Evidence amendment versions require the exact preceding event' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = NEW."evidenceId") OR
    EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "startEvidenceId" = NEW."evidenceId" OR "endEvidenceId" = NEW."evidenceId") THEN
    RAISE EXCEPTION 'Applied assignment evidence cannot be amended' USING ERRCODE = '23514';
  END IF;
  IF NEW."batchVersion" <> batch."version" OR NEW."sourceRevision" <> (SELECT coalesce(max("revision"), 0) FROM "ImportSourceRevision" WHERE "batchId" = batch."id") OR
    capture."rulesVersion" <> 'mda-history-evidence-1' THEN
    RAISE EXCEPTION 'Evidence amendment requires the current batch and source revisions' USING ERRCODE = '23514';
  END IF;
  IF NEW."snapshot"->'original' IS DISTINCT FROM evidence."snapshot"->'original' OR
    NEW."snapshot"->>'recordId' IS DISTINCT FROM evidence."recordId" OR NEW."snapshot"->>'candidateId' IS DISTINCT FROM evidence."candidateId" OR
    NEW."snapshot"->>'kind' IS DISTINCT FROM evidence."kind" OR NEW."snapshot"->>'assetId' IS DISTINCT FROM NEW."assetId"::text OR
    NEW."snapshot"->>'effectiveDay' IS DISTINCT FROM NEW."effectiveDay" OR
    NEW."snapshot"->'effective'->>'id' IS DISTINCT FROM evidence."recordId" OR
    NEW."snapshot"->'effective'->>'sheet' IS DISTINCT FROM evidence."snapshot"->'original'->>'sheet' OR
    NEW."snapshot"->'effective'->>'row' IS DISTINCT FROM evidence."snapshot"->'original'->>'row' OR
    NEW."snapshot"->>'datePrecision' IS DISTINCT FROM (CASE WHEN NEW."effectiveDay" IS NULL THEN 'UNKNOWN' ELSE 'DAY' END) THEN
    RAISE EXCEPTION 'Evidence amendment must retain original physical provenance and consistent effective fields' USING ERRCODE = '23514';
  END IF;
  IF (evidence."kind" = 'RETIREMENT_OBSERVATION' AND NEW."effectiveDay" IS NOT NULL) OR
    NEW."effectiveDay" > to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'Evidence amendment cannot invent a retirement or future date' USING ERRCODE = '23514';
  END IF;
  IF NEW."assetId" IS NULL THEN
    IF NEW."snapshot"->'linkBasis' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unlinked amendment cannot claim an asset basis' USING ERRCODE = '23514'; END IF;
  ELSE
    PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR SHARE;
    IF NEW."snapshot"->'linkBasis'->>'type' = 'PILOT_RECEIPT' THEN
      IF NOT EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "id"::text = NEW."snapshot"->'linkBasis'->>'id' AND
        "sourceHash" = evidence."sourceHash" AND "candidateId" = evidence."candidateId" AND "assetId" = NEW."assetId") THEN
        RAISE EXCEPTION 'Amendment link must match its pilot receipt' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."snapshot"->'linkBasis'->>'type' = 'REVIEW_DECISION' THEN
      SELECT * INTO latest_decision FROM "ImportReviewDecision" WHERE "batchId" = batch."id" AND "targetType" = 'CANDIDATE' AND
        "targetId" = evidence."candidateId" ORDER BY "batchVersion" DESC LIMIT 1;
      SELECT coalesce(max(r."revision"), 0) INTO identity_revision FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
        WHERE r."batchId" = batch."id" AND c.value->>'candidateId' = evidence."candidateId" AND c.value->>'field' IN ('serialNumber', 'assetTag');
      IF latest_decision."id"::text IS DISTINCT FROM NEW."snapshot"->'linkBasis'->>'id' OR latest_decision."action" IS DISTINCT FROM 'LINK_EXISTING' OR
        latest_decision."linkedAssetId" IS DISTINCT FROM NEW."assetId" OR latest_decision."sourceRevision" < identity_revision OR
        NEW."snapshot"->>'identityLinkBlocked' IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'Amendment link requires the current verified identity decision' USING ERRCODE = '23514';
      END IF;
    ELSE RAISE EXCEPTION 'Amendment link requires explicit provenance' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportEvidenceAmendment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportEvidenceAmendment"
FOR EACH ROW EXECUTE FUNCTION guard_import_evidence_amendment();

CREATE OR REPLACE FUNCTION guard_import_assignment_application() RETURNS trigger AS $$
DECLARE source_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical assignment receipts are immutable' USING ERRCODE = '23514'; END IF;
  IF NEW."rulesVersion" <> 'mda-closed-assignment-plan-2' OR NEW."plan"->>'planId' IS DISTINCT FROM NEW."planId" OR
    NEW."plan"->'assetBefore'->>'id' IS DISTINCT FROM NEW."assetId"::text OR NOT ((
      NEW."plan" @> '{"scope":"CLOSED_ASSIGNMENT_HISTORY_PLAN","planValidationComplete":true,"affectsCurrentState":false}'::jsonb AND
      jsonb_typeof(NEW."plan"->'periods') = 'array' AND jsonb_array_length(NEW."plan"->'periods') BETWEEN 1 AND 25
    ) IS TRUE) THEN RAISE EXCEPTION 'Historical receipt requires a valid closed assignment plan' USING ERRCODE = '23514'; END IF;
  FOR source_hash IN SELECT DISTINCT e."sourceHash" FROM jsonb_array_elements(NEW."plan"->'periods') p
    CROSS JOIN LATERAL jsonb_array_elements(p->'sources') s JOIN "ImportHistoricalEvidence" e ON e."id"::text = s->>'evidenceId'
    ORDER BY e."sourceHash" LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  END LOOP;
  PERFORM e."id" FROM "ImportHistoricalEvidence" e WHERE e."id"::text IN (
    SELECT s->>'evidenceId' FROM jsonb_array_elements(NEW."plan"->'periods') p CROSS JOIN LATERAL jsonb_array_elements(p->'sources') s
  ) ORDER BY e."id" FOR NO KEY UPDATE;
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_import_assignment_item() RETURNS trigger AS $$
DECLARE
  application "ImportAssignmentApplication"%ROWTYPE;
  assignment "Assignment"%ROWTYPE;
  start_evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE;
  end_evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE;
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
  SELECT * INTO start_evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = NEW."startEvidenceId";
  SELECT * INTO end_evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = NEW."endEvidenceId";
  IF start_evidence."id" IS NULL OR end_evidence."id" IS NULL OR start_evidence."assetId" IS DISTINCT FROM application."assetId" OR
    end_evidence."assetId" IS DISTINCT FROM application."assetId" OR start_evidence."kind" NOT IN ('USAGE_OBSERVATION', 'LOAN_OBSERVATION') OR
    end_evidence."kind" NOT IN ('RECEIPT_OBSERVATION', 'USAGE_OBSERVATION') OR
    (start_evidence."sourceHash" = end_evidence."sourceHash" AND start_evidence."recordId" = end_evidence."recordId") THEN
    RAISE EXCEPTION 'Closed assignment requires two distinct linked physical endpoint observations' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' = 'start' AND
    s->>'evidenceId' = start_evidence."id"::text AND s->>'evidenceVersion' = start_evidence."evidenceVersion"::text AND
    s->>'amendmentId' IS NOT DISTINCT FROM start_evidence."amendmentId"::text AND s->>'sourceRevision' = start_evidence."sourceRevision"::text) OR
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' = 'end' AND
    s->>'evidenceId' = end_evidence."id"::text AND s->>'evidenceVersion' = end_evidence."evidenceVersion"::text AND
    s->>'amendmentId' IS NOT DISTINCT FROM end_evidence."amendmentId"::text AND s->>'sourceRevision' = end_evidence."sourceRevision"::text) THEN
    RAISE EXCEPTION 'Imported period must retain its exact current evidence versions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
