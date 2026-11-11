BEGIN;

CREATE TABLE "ImportGroupAssignmentCorrection" (
  "id" UUID PRIMARY KEY,
  "itemId" UUID NOT NULL REFERENCES "ImportGroupAssignmentItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" BETWEEN 1 AND 1000),
  "previousId" UUID REFERENCES "ImportGroupAssignmentCorrection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "correctionPlanId" VARCHAR(64) NOT NULL CHECK ("correctionPlanId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-group-assignment-correction-application-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 2000),
  "supportingReference" TEXT NOT NULL CHECK (length(btrim("supportingReference")) BETWEEN 1 AND 500),
  "assetSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("assetSnapshot") = 'object'),
  "custodySnapshot" JSONB NOT NULL CHECK (jsonb_typeof("custodySnapshot") = 'array'),
  "correctedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" VARCHAR(20) NOT NULL DEFAULT (pg_current_xact_id())::text,
  CHECK (("version" = 1) = ("previousId" IS NULL))
);
CREATE UNIQUE INDEX "ImportGroupAssignmentCorrection_itemId_version_key" ON "ImportGroupAssignmentCorrection"("itemId", "version");
CREATE UNIQUE INDEX "ImportGroupAssignmentCorrection_itemId_requestId_key" ON "ImportGroupAssignmentCorrection"("itemId", "requestId");
CREATE UNIQUE INDEX "ImportGroupAssignmentCorrection_previousId_key" ON "ImportGroupAssignmentCorrection"("previousId");
CREATE UNIQUE INDEX "ImportGroupAssignmentCorrection_correctionPlanId_key" ON "ImportGroupAssignmentCorrection"("correctionPlanId");
CREATE INDEX "ImportGroupAssignmentCorrection_createdTransactionId_idx" ON "ImportGroupAssignmentCorrection"("createdTransactionId");

CREATE VIEW "AssignmentEffective" AS
SELECT a."id", a."assetId", a."personId",
  CASE WHEN c."id" IS NULL THEN a."personName" ELSE c."plan"->'proposed'->>'personName' END AS "personName",
  CASE WHEN c."id" IS NULL THEN a."recipientType" ELSE (c."plan"->'proposed'->>'recipientType')::"AssignmentRecipientType" END AS "recipientType",
  CASE WHEN c."id" IS NULL THEN a."officeName" ELSE c."plan"->'proposed'->>'officeName' END AS "officeName",
  CASE WHEN c."id" IS NULL THEN a."assignmentType" ELSE (c."plan"->'proposed'->>'assignmentType')::"AssignmentType" END AS "assignmentType",
  a."expectedReturnAt", a."ticketReference", a."otReference",
  CASE WHEN c."id" IS NULL THEN a."notes" ELSE c."plan"->'proposed'->>'note' END AS "notes",
  a."returnTicketReference", a."returnOtReference",
  CASE WHEN c."id" IS NULL THEN a."returnNotes" ELSE c."plan"->'proposed'->>'evidenceReference' END AS "returnNotes",
  CASE WHEN c."id" IS NULL THEN a."returnStatus" ELSE (c."plan"->'proposed'->>'returnStatus')::"AssetStatus" END AS "returnStatus",
  a."returnRecordedAt", a."createdById", a."importedHistory", a."endedById",
  CASE WHEN c."id" IS NULL THEN a."startedAt" ELSE (c."plan"->'proposed'->>'startedAt')::timestamptz AT TIME ZONE 'UTC' END AS "startedAt",
  CASE WHEN c."id" IS NULL THEN a."endedAt" ELSE (c."plan"->'proposed'->>'endedAt')::timestamptz AT TIME ZONE 'UTC' END AS "endedAt",
  a."createdAt", c."id" AS "correctionId", c."version" AS "correctionVersion", c."correctedById", c."correctedAt"
FROM "Assignment" a LEFT JOIN "ImportGroupAssignmentItem" i ON i."assignmentId" = a."id"
LEFT JOIN LATERAL (SELECT * FROM "ImportGroupAssignmentCorrection" WHERE "itemId" = i."id" ORDER BY "version" DESC LIMIT 1) c ON true;

CREATE FUNCTION import_group_assignment_values(a "Assignment") RETURNS JSONB AS $$
  SELECT jsonb_build_object('assetId', a."assetId", 'personId', a."personId", 'recipientType', a."recipientType",
    'personName', a."personName", 'officeName', a."officeName", 'assignmentType', a."assignmentType",
    'startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"),
    'returnStatus', a."returnStatus", 'assignedById', a."createdById", 'returnedById', a."endedById",
    'ticketReference', a."ticketReference", 'otReference', a."otReference", 'returnTicketReference', a."returnTicketReference", 'returnOtReference', a."returnOtReference");
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION import_group_assignment_json(a "Assignment") RETURNS JSONB AS $$
  SELECT to_jsonb(a) || jsonb_build_object('startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"),
    'createdAt', import_group_assignment_iso(a."createdAt"), 'returnRecordedAt', import_group_assignment_iso(a."returnRecordedAt"), 'expectedReturnAt', import_group_assignment_iso(a."expectedReturnAt"));
$$ LANGUAGE sql IMMUTABLE;

-- Preserve the complete existing source guards, changing only their history reads.
DO $$
DECLARE definition TEXT; patched TEXT;
BEGIN
  definition := pg_get_functiondef('assert_import_group_assignment_period("ImportGroupAssignmentApplication",jsonb,uuid)'::regprocedure);
  patched := replace(definition, 'FROM "Assignment" a WHERE a."assetId" = receipt."assetId" AND a."id" IS DISTINCT FROM ignored_assignment_id',
    'FROM "AssignmentEffective" a WHERE a."assetId" = receipt."assetId" AND a."id" IS DISTINCT FROM ignored_assignment_id');
  IF patched = definition THEN RAISE EXCEPTION 'Expected group period history guard was not found'; END IF;
  EXECUTE patched;
  definition := pg_get_functiondef('assert_import_group_assignment_context("ImportGroupAssignmentApplication")'::regprocedure);
  patched := replace(definition, 'INTO assignment_context FROM "Assignment" a', 'INTO assignment_context FROM "AssignmentEffective" a');
  IF patched = definition THEN RAISE EXCEPTION 'Expected group context history guard was not found'; END IF;
  EXECUTE patched;
  definition := pg_get_functiondef('guard_import_retirement_application()'::regprocedure);
  patched := replace(definition, 'FROM "Assignment" WHERE "assetId" = NEW."assetId"', 'FROM "AssignmentEffective" WHERE "assetId" = NEW."assetId"');
  IF patched = definition THEN RAISE EXCEPTION 'Expected retirement history guard was not found'; END IF;
  EXECUTE patched;
END;
$$;

CREATE OR REPLACE FUNCTION guard_import_assignment_period() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  IF NEW."importedHistory" AND (NEW."endedAt" IS NULL OR NEW."endedAt" <= NEW."startedAt" OR NEW."startedAt" < TIMESTAMP '1900-01-01'
    OR NEW."endedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR NEW."createdAt" < NEW."endedAt"
    OR NOT EXISTS (SELECT 1 FROM "Asset" a JOIN "Product" p ON p."id" = a."productId" WHERE a."id" = NEW."assetId" AND p."trackingMode" = 'ASSET'
      AND (a."status" <> 'DECOMMISSIONED' OR a."decommissionedAt" IS NOT NULL) AND (a."decommissionedAt" IS NULL OR NEW."endedAt" <= a."decommissionedAt"))) THEN
    RAISE EXCEPTION 'Imported assignments require a past closed period before any decommission' USING ERRCODE = '23514';
  END IF;
  IF (NEW."importedHistory" OR EXISTS (SELECT 1 FROM "Assignment" WHERE "assetId" = NEW."assetId" AND "importedHistory")) AND EXISTS (
    SELECT 1 FROM "AssignmentEffective" a WHERE a."assetId" = NEW."assetId" AND a."id" <> NEW."id"
      AND NEW."startedAt" < coalesce(a."endedAt", 'infinity'::timestamp) AND coalesce(NEW."endedAt", 'infinity'::timestamp) > a."startedAt") THEN
    RAISE EXCEPTION 'Assignments cannot overlap imported closed history' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_group_assignment_correction(event "ImportGroupAssignmentCorrection") RETURNS void AS $$
DECLARE
  item "ImportGroupAssignmentItem"%ROWTYPE; origin "ImportGroupAssignmentApplication"%ROWTYPE;
  previous "ImportGroupAssignmentCorrection"%ROWTYPE; assignment "Assignment"%ROWTYPE; actor "User"%ROWTYPE;
  period JSONB; original_period JSONB; before_values JSONB; proposed JSONB; request JSONB; custody JSONB;
  origin_proof JSONB; audit_proof JSONB; chain_proof JSONB; parent "ImportIdentityGroupApplication"%ROWTYPE;
  current_asset "Asset"%ROWTYPE; physical "ImportIdentityGroupApplicationItem"%ROWTYPE; changes JSONB; current_asset_json JSONB; custody_json JSONB;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO item FROM "ImportGroupAssignmentItem" WHERE "id" = event."itemId";
  SELECT * INTO origin FROM "ImportGroupAssignmentApplication" WHERE "id" = item."applicationId";
  SELECT * INTO assignment FROM "Assignment" WHERE "id" = item."assignmentId";
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = assignment."assetId";
  SELECT * INTO physical FROM "ImportIdentityGroupApplicationItem" WHERE "id" = origin."itemId";
  SELECT * INTO actor FROM "User" WHERE "id" = event."correctedById";
  SELECT * INTO previous FROM "ImportGroupAssignmentCorrection" WHERE "itemId" = item."id" AND "id" <> event."id" ORDER BY "version" DESC LIMIT 1;
  IF item."id" IS NULL OR origin."id" IS NULL OR NOT assignment."importedHistory" OR assignment."endedAt" IS NULL
    OR actor."role" IS DISTINCT FROM 'JEFE' OR actor."isActive" IS DISTINCT FROM true OR actor."passwordHash" IS NULL
    OR event."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text
    OR event."correctedAt" < (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond'
    OR event."correctedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR event."correctedAt" < origin."appliedAt"
    OR event."version" <> coalesce(previous."version", 0) + 1 OR event."previousId" IS DISTINCT FROM previous."id"
    OR (SELECT count(*) FROM "ImportGroupAssignmentCorrection" WHERE "itemId" = item."id" AND "id" <> event."id") <> event."version" - 1
    OR (previous."id" IS NOT NULL AND event."correctedAt" < previous."correctedAt") THEN
    RAISE EXCEPTION 'Correction requires exact sequential origin, active JEFE and current capture transaction' USING ERRCODE = '23514';
  END IF;
  IF current_asset."productId"::text IS DISTINCT FROM physical."result"->>'productId'
    OR import_identifier_key(current_asset."serialNumber") IS DISTINCT FROM import_identifier_key(physical."result"->>'serialNumber')
    OR import_identifier_key(current_asset."assetTag") IS DISTINCT FROM import_identifier_key(physical."result"->>'assetTag')
    OR NOT EXISTS (SELECT 1 FROM "Product" WHERE "id" = current_asset."productId" AND "trackingMode" = 'ASSET')
    OR (current_asset."status" = 'DECOMMISSIONED' AND current_asset."decommissionedAt" IS NULL)
    OR (SELECT count(*) FROM "Assignment" WHERE "assetId" = assignment."assetId" AND "endedAt" IS NULL) <> (CASE WHEN current_asset."status" = 'ASSIGNED' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Correction requires current physical identity, product and coherent custody' USING ERRCODE = '23514';
  END IF;
  original_period := item."snapshot"; period := event."plan"->'proposedPeriod'; proposed := event."plan"->'proposed';
  SELECT p.* INTO parent FROM "ImportIdentityGroupApplication" p JOIN "ImportIdentityGroupApplicationItem" g ON g."applicationId" = p."id" WHERE g."id" = origin."itemId";
  SELECT to_jsonb(origin) || jsonb_build_object('appliedAt', import_group_assignment_iso(origin."appliedAt"), 'items',
    (SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('assignment', import_group_assignment_json(a) || '{"importHistory":null}'::jsonb,
      'evidenceUses', (SELECT jsonb_agg(to_jsonb(u) ORDER BY u."endpoint") FROM "ImportGroupAssignmentEvidenceUse" u WHERE u."itemId" = i."id")) ORDER BY i."periodId")
      FROM "ImportGroupAssignmentItem" i JOIN "Assignment" a ON a."id" = i."assignmentId" WHERE i."applicationId" = origin."id")) INTO origin_proof;
  SELECT coalesce(jsonb_agg(jsonb_build_object('action', a."action", 'entityType', a."entityType", 'entityId', a."entityId", 'userId', a."userId")
      ORDER BY (a."entityType" || a."entityId" || a."action" || a."userId"::text) COLLATE "C"), '[]'::jsonb) INTO audit_proof
    FROM "AuditLog" a WHERE a."userId" = origin."appliedById" AND
      ((a."action" = 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED' AND a."entityType" = 'ImportGroupAssignmentApplication' AND a."entityId" = origin."id"::text)
       OR (a."action" = 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED' AND a."entityType" = 'Assignment' AND a."entityId" IN
         (SELECT "assignmentId"::text FROM "ImportGroupAssignmentItem" WHERE "applicationId" = origin."id")));
  SELECT coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('correctedAt', import_group_assignment_iso(c."correctedAt")) ORDER BY c."version"), '[]'::jsonb)
    INTO chain_proof FROM "ImportGroupAssignmentCorrection" c WHERE c."itemId" = item."id" AND c."id" <> event."id";
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(origin."plan"->'periods') p WHERE p = original_period)
    OR import_group_assignment_values(assignment) IS DISTINCT FROM original_period->'proposedAssignment'
    OR assignment."notes" IS DISTINCT FROM original_period->>'note' OR assignment."returnNotes" IS DISTINCT FROM original_period->>'evidenceReference'
    OR assignment."createdById" IS NOT NULL OR assignment."endedById" IS NOT NULL OR assignment."personId" IS NOT NULL
    OR assignment."expectedReturnAt" IS NOT NULL OR assignment."createdAt" IS DISTINCT FROM origin."appliedAt" OR assignment."returnRecordedAt" IS DISTINCT FROM origin."appliedAt"
    OR (SELECT count(*) FROM "ImportGroupAssignmentEvidenceUse" WHERE "itemId" = item."id") <> 2
    OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "itemId" = item."id" AND "linkId" = item."startLinkId" AND "endpoint" = 'START')
    OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "itemId" = item."id" AND "linkId" = item."endLinkId" AND "endpoint" = 'END')
    OR EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "assignmentId" = assignment."id") THEN
    RAISE EXCEPTION 'Correction must retain immutable assignment and two permanent origin endpoints' USING ERRCODE = '23514';
  END IF;
  IF previous."id" IS NULL THEN
    before_values := original_period->'proposedAssignment' || jsonb_build_object('note', original_period->'note', 'evidenceReference', original_period->'evidenceReference',
      'startDateEvidenceReference', original_period->'start'->'dateEvidenceReference', 'endDateEvidenceReference', original_period->'end'->'dateEvidenceReference');
  ELSE before_values := previous."plan"->'proposed'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a."id"), '[]'::jsonb) INTO custody FROM "Assignment" a WHERE a."assetId" = assignment."assetId" AND a."endedAt" IS NULL;
  SELECT coalesce(jsonb_agg(import_group_assignment_json(a) ORDER BY a."id"), '[]'::jsonb) INTO custody_json FROM "Assignment" a WHERE a."assetId" = assignment."assetId" AND a."endedAt" IS NULL;
  current_asset_json := to_jsonb(current_asset) || jsonb_build_object('createdAt', import_group_assignment_iso(current_asset."createdAt"),
    'updatedAt', import_group_assignment_iso(current_asset."updatedAt"), 'decommissionedAt', import_group_assignment_iso(current_asset."decommissionedAt"));
  IF event."assetSnapshot" IS DISTINCT FROM (SELECT to_jsonb(a) FROM "Asset" a WHERE a."id" = assignment."assetId") OR event."custodySnapshot" IS DISTINCT FROM custody THEN
    RAISE EXCEPTION 'Correction cannot change current asset or open custody' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('field', field, 'before', before_values->field, 'after', proposed->field) ORDER BY position), '[]'::jsonb) INTO changes
    FROM unnest(ARRAY['assetId','personId','recipientType','personName','officeName','assignmentType','startedAt','endedAt','returnStatus','assignedById','returnedById',
      'ticketReference','otReference','returnTicketReference','returnOtReference','note','evidenceReference','startDateEvidenceReference','endDateEvidenceReference']) WITH ORDINALITY AS fields(field, position)
    WHERE before_values->field IS DISTINCT FROM proposed->field;
  IF NOT ((event."plan" @> '{"rulesVersion":"mda-group-assignment-correction-plan-1","scope":"GROUP_CLOSED_ASSIGNMENT_CORRECTION_PLAN","persisted":false,"canApply":false,"affectsCurrentState":false,"evidenceRelinked":false,"operationalHistoryApplied":false,"correctionApplicationImplemented":false,"planValidationComplete":true,"blockers":[]}'::jsonb) IS TRUE)
    OR event."plan"->>'mode' IS DISTINCT FROM 'CORRECTION_REVIEW_ONLY'
    OR event."plan"->>'timeZone' IS DISTINCT FROM 'America/Santiago'
    OR event."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(event."correctedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD')
    OR event."plan"->'currentAsset' IS DISTINCT FROM current_asset_json OR event."plan"->'currentCustody' IS DISTINCT FROM custody_json
    OR event."plan"->'originalAssignment' IS DISTINCT FROM import_group_assignment_json(assignment) || '{"importHistory":null}'::jsonb
    OR event."plan"->'originalPeriod' IS DISTINCT FROM original_period OR event."plan"->'changes' IS DISTINCT FROM changes
    OR event."plan"->'sources' IS DISTINCT FROM period->'sources' OR event."plan"->'warnings' IS DISTINCT FROM period->'warnings'
    OR event."plan"->'acknowledgedWarnings' IS DISTINCT FROM period->'acknowledgedWarnings'
    OR event."plan"->'ownership' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(u) ORDER BY u."endpoint") FROM "ImportGroupAssignmentEvidenceUse" u WHERE u."itemId" = item."id")
    OR event."plan"->>'correctionPlanId' IS DISTINCT FROM event."correctionPlanId"
    OR event."correctionPlanId" IS DISTINCT FROM import_group_assignment_digest(event."plan" - ARRAY['correctionPlanId','mode','persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','correctionApplicationImplemented','planValidationComplete'])
    OR event."plan"->>'originPlanId' IS DISTINCT FROM origin."planId" OR event."plan"->>'groupApplicationId' IS DISTINCT FROM origin."id"::text
    OR event."plan"->>'assignmentItemId' IS DISTINCT FROM item."id"::text OR event."plan"->>'assignmentId' IS DISTINCT FROM assignment."id"::text
    OR event."plan"->>'assetId' IS DISTINCT FROM assignment."assetId"::text OR event."plan"->>'itemId' IS DISTINCT FROM origin."itemId"::text
    OR event."plan"->>'applicationId' IS DISTINCT FROM parent."id"::text OR event."plan"->>'batchId' IS DISTINCT FROM parent."batchId"::text
    OR event."plan"->>'reviewId' IS DISTINCT FROM parent."reviewId"::text
    OR event."plan"->>'originReceiptDigest' IS DISTINCT FROM import_group_assignment_digest(origin_proof)
    OR event."plan"->>'originAuditDigest' IS DISTINCT FROM import_group_assignment_digest(audit_proof)
    OR event."plan"->>'correctionChainDigest' IS DISTINCT FROM import_group_assignment_digest(chain_proof)
    OR event."plan"->>'currentCorrectionVersion' IS DISTINCT FROM (event."version" - 1)::text
    OR event."plan"->>'currentCorrectionId' IS DISTINCT FROM event."previousId"::text
    OR event."plan"->>'reason' IS DISTINCT FROM event."reason" OR event."plan"->>'supportingReference' IS DISTINCT FROM event."supportingReference"
    OR event."plan"->'before' IS DISTINCT FROM before_values OR before_values = proposed
    OR period->>'periodId' IS DISTINCT FROM item."periodId"::text
    OR period->'start'->>'evidenceId' IS DISTINCT FROM original_period->'start'->>'evidenceId'
    OR period->'end'->>'evidenceId' IS DISTINCT FROM original_period->'end'->>'evidenceId'
    OR proposed IS DISTINCT FROM period->'proposedAssignment' || jsonb_build_object('note', period->'note', 'evidenceReference', period->'evidenceReference',
      'startDateEvidenceReference', period->'start'->'dateEvidenceReference', 'endDateEvidenceReference', period->'end'->'dateEvidenceReference') THEN
    RAISE EXCEPTION 'Correction must match exact reviewed origin, previous version and changed proposal' USING ERRCODE = '23514';
  END IF;
  request := jsonb_build_object('requestId', event."requestId", 'correctionPlanId', event."correctionPlanId", 'confirmation', 'APPLY_GROUP_ASSIGNMENT_CORRECTION',
    'plan', jsonb_build_object('expectedOriginPlanId', origin."planId", 'expectedCorrectionVersion', event."version" - 1, 'reason', event."reason", 'supportingReference', event."supportingReference",
      'correction', jsonb_build_object('start', (period->'start') - 'evidenceId', 'end', (period->'end') - 'evidenceId', 'recipient', period->'recipient',
        'assignmentType', period->'assignmentType', 'returnStatus', period->'returnStatus', 'note', period->'note', 'evidenceReference', period->'evidenceReference', 'acknowledgedWarnings', period->'acknowledgedWarnings')));
  IF import_group_assignment_digest(request) IS DISTINCT FROM event."requestDigest" THEN
    RAISE EXCEPTION 'Correction request digest must bind its exact confirmed intent' USING ERRCODE = '23514';
  END IF;
  origin."appliedAt" := event."correctedAt";
  origin."plan" := jsonb_set(origin."plan", '{periods}', jsonb_build_array(period));
  PERFORM assert_import_group_assignment_period(origin, period, assignment."id");
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_group_assignment_correction() RETURNS trigger AS $$
DECLARE batch_id UUID; source_hash TEXT; asset_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Assignment corrections are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  SELECT p."batchId", p."sourceHash", a."assetId" INTO batch_id, source_hash, asset_id FROM "ImportGroupAssignmentItem" i
    JOIN "ImportGroupAssignmentApplication" a ON a."id" = i."applicationId" JOIN "ImportIdentityGroupApplicationItem" g ON g."id" = a."itemId"
    JOIN "ImportIdentityGroupApplication" p ON p."id" = g."applicationId" WHERE i."id" = NEW."itemId";
  PERFORM 1 FROM "ImportBatch" WHERE "id" = batch_id FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment",
    "ImportGroupHistoryApplication", "ImportGroupHistoryLink", "ImportGroupAssignmentCorrection" IN EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM "Asset" WHERE "id" = asset_id FOR UPDATE;
  PERFORM 1 FROM "User" WHERE "id" = NEW."correctedById" FOR SHARE;
  PERFORM assert_import_group_assignment_correction(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupAssignmentCorrection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupAssignmentCorrection"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_correction();
CREATE TRIGGER "ImportGroupAssignmentCorrection_truncate_guard" BEFORE TRUNCATE ON "ImportGroupAssignmentCorrection"
FOR EACH STATEMENT EXECUTE FUNCTION guard_import_group_assignment_correction();

CREATE FUNCTION verify_import_group_assignment_correction() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_group_assignment_correction(NEW);
  IF NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "action" = 'IMPORT_GROUP_ASSIGNMENT_CORRECTED' AND "entityType" = 'ImportGroupAssignmentCorrection'
    AND "entityId" = NEW."id"::text AND "userId" = NEW."correctedById") THEN
    RAISE EXCEPTION 'Correction and audit must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportGroupAssignmentCorrection_complete" AFTER INSERT ON "ImportGroupAssignmentCorrection"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_group_assignment_correction();

CREATE FUNCTION guard_group_correction_current_state() RETURNS trigger AS $$
DECLARE asset_id UUID; old_asset_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'Asset' THEN asset_id := OLD."id"; old_asset_id := OLD."id";
  ELSE
    IF TG_OP <> 'DELETE' THEN asset_id := NEW."assetId"; END IF;
    IF TG_OP <> 'INSERT' THEN old_asset_id := OLD."assetId"; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportGroupAssignmentCorrection" c JOIN "ImportGroupAssignmentItem" i ON i."id" = c."itemId"
    JOIN "Assignment" a ON a."id" = i."assignmentId" WHERE c."createdTransactionId" = pg_current_xact_id()::text
      AND c."correctedAt" >= (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond' AND a."assetId" IN (asset_id, old_asset_id)) THEN
    RAISE EXCEPTION 'Correction cannot mutate current asset or custody in its creating transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_group_correction_current_guard" BEFORE UPDATE OR DELETE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_group_correction_current_state();
CREATE TRIGGER "Assignment_group_correction_current_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_group_correction_current_state();

CREATE FUNCTION guard_asset_effective_history_boundary() RETURNS trigger AS $$
BEGIN
  IF NEW."decommissionedAt" IS NOT NULL AND NEW."decommissionedAt" IS DISTINCT FROM OLD."decommissionedAt" THEN
    PERFORM assert_import_group_assignment_isolation();
    IF EXISTS (SELECT 1 FROM "AssignmentEffective" WHERE "assetId" = NEW."id" AND ("endedAt" IS NULL OR "endedAt" > NEW."decommissionedAt")) THEN
      RAISE EXCEPTION 'Terminal date cannot precede effective custody history' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_effective_history_boundary_guard" BEFORE UPDATE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_asset_effective_history_boundary();

COMMIT;
