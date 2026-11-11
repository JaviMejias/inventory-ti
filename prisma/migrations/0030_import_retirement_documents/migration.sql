BEGIN;

CREATE TABLE "ImportRetirementReconciliation" (
  "id" UUID NOT NULL PRIMARY KEY,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceVersion" INTEGER NOT NULL CHECK ("evidenceVersion" BETWEEN 0 AND 1000),
  "amendmentId" UUID REFERENCES "ImportEvidenceAmendment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-retirement-document-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "recordedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" TEXT NOT NULL DEFAULT (pg_current_xact_id())::text,
  CHECK (("evidenceVersion" = 0 AND "amendmentId" IS NULL) OR ("evidenceVersion" > 0 AND "amendmentId" IS NOT NULL))
);
CREATE UNIQUE INDEX "ImportRetirementReconciliation_planId_key" ON "ImportRetirementReconciliation"("planId");
CREATE UNIQUE INDEX "ImportRetirementReconciliation_assetId_requestId_key" ON "ImportRetirementReconciliation"("assetId", "requestId");
CREATE UNIQUE INDEX "ImportRetirementReconciliation_evidenceId_evidenceVersion_key" ON "ImportRetirementReconciliation"("evidenceId", "evidenceVersion");
CREATE INDEX "ImportRetirementReconciliation_assetId_recordedAt_id_idx" ON "ImportRetirementReconciliation"("assetId", "recordedAt", "id");
CREATE INDEX "ImportRetirementReconciliation_createdTransactionId_idx" ON "ImportRetirementReconciliation"("createdTransactionId");

CREATE FUNCTION assert_import_retirement_document(receipt "ImportRetirementReconciliation", completed BOOLEAN) RETURNS void AS $$
DECLARE
  asset "Asset"%ROWTYPE; product "Product"%ROWTYPE; actor "User"%ROWTYPE;
  evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE; capture "ImportHistoryCapture"%ROWTYPE;
  legacy "ImportRetirementApplication"%ROWTYPE; grouped "ImportGroupRetirementApplication"%ROWTYPE;
  request JSONB; expected_asset JSONB; expected_source JSONB; warnings JSONB := '[]'::jsonb; issue JSONB;
  acknowledged JSONB; assignments JSONB; revisions JSONB; received_text TEXT; received_day TEXT;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO asset FROM "Asset" WHERE "id" = receipt."assetId" FOR UPDATE;
  SELECT * INTO product FROM "Product" WHERE "id" = asset."productId" FOR SHARE;
  SELECT * INTO actor FROM "User" WHERE "id" = receipt."recordedById" FOR SHARE;
  SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = receipt."evidenceId";
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
  IF actor."id" IS NULL OR actor."role" <> 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL THEN
    RAISE EXCEPTION 'Document reconciliation requires an active configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF receipt."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR
    receipt."recordedAt" < date_trunc('milliseconds', transaction_timestamp() AT TIME ZONE 'UTC') OR receipt."recordedAt" > clock_timestamp() AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Document reconciliation requires its own transaction and actual capture time' USING ERRCODE = '23514';
  END IF;
  IF asset."id" IS NULL OR asset."isActive" OR asset."status" <> 'DECOMMISSIONED' OR product."trackingMode" <> 'ASSET' OR
    (asset."decommissionedAt" IS NOT NULL AND (asset."decommissionedAt" < TIMESTAMP '1900-01-01' OR asset."decommissionedAt" > clock_timestamp() AT TIME ZONE 'UTC')) OR
    EXISTS (SELECT 1 FROM "AssignmentEffective" WHERE "assetId" = asset."id" AND
      ("endedAt" IS NULL OR "endedAt" <= "startedAt" OR "endedAt" > asset."decommissionedAt")) THEN
    RAISE EXCEPTION 'Document reconciliation requires a coherent preexisting terminal and custody history' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Asset" WHERE "id" = asset."id" AND xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text) THEN
    RAISE EXCEPTION 'Document reconciliation cannot create or update its terminal before recording either' USING ERRCODE = '23514';
  END IF;
  PERFORM assert_import_identity_unreserved(evidence."sourceHash", evidence."candidateId", evidence."recordId");
  PERFORM assert_import_group_source_unconsumed(evidence."sourceHash", evidence."candidateId", evidence."recordId");
  IF evidence."id" IS NULL OR evidence."kind" IS DISTINCT FROM 'RETIREMENT_OBSERVATION' OR evidence."assetId" IS DISTINCT FROM asset."id" OR
    evidence."effectiveDay" IS NOT NULL OR evidence."evidenceVersion" IS DISTINCT FROM receipt."evidenceVersion" OR
    evidence."amendmentId" IS DISTINCT FROM receipt."amendmentId" OR evidence."sourceRevision" IS DISTINCT FROM receipt."sourceRevision" OR
    capture."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1' OR
    NOT ((evidence."snapshot" @> '{"identityLinkBlocked":false,"datePrecision":"UNKNOWN","historicalActorId":null}'::jsonb) IS TRUE) OR
    (import_identifier_key(evidence."snapshot"->'effective'->>'serialKey') IS NOT NULL AND
      evidence."snapshot"->'effective'->>'serialKey' IS DISTINCT FROM import_identifier_key(asset."serialNumber")) OR
    (import_identifier_key(evidence."snapshot"->'effective'->>'tagKey') IS NOT NULL AND
      evidence."snapshot"->'effective'->>'tagKey' IS DISTINCT FROM import_identifier_key(asset."assetTag")) THEN
    RAISE EXCEPTION 'Document reconciliation requires the exact linked current undated evidence' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c
      WHERE r."batchId" = capture."batchId" AND r."revision" > receipt."sourceRevision" AND c->>'candidateId' = evidence."candidateId") OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(evidence."snapshot"->'issues') i WHERE i->>'severity' = 'BLOCKING') OR
    EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication" WHERE "evidenceId" = evidence."id") THEN
    RAISE EXCEPTION 'Document reconciliation cannot waive source conflicts or reuse applied evidence' USING ERRCODE = '23514';
  END IF;
  expected_asset := to_jsonb(asset) || jsonb_build_object('createdAt', import_group_assignment_iso(asset."createdAt"),
    'updatedAt', import_group_assignment_iso(asset."updatedAt"), 'decommissionedAt', import_group_assignment_iso(asset."decommissionedAt"));
  IF receipt."plan"->'assetBefore' IS DISTINCT FROM expected_asset OR receipt."plan"->'productBefore' IS DISTINCT FROM
    jsonb_build_object('id', product."id", 'trackingMode', product."trackingMode", 'isActive', product."isActive", 'updatedAt', import_group_assignment_iso(product."updatedAt")) THEN
    RAISE EXCEPTION 'Document reconciliation must preserve the entire current asset unchanged' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO legacy FROM "ImportRetirementApplication" WHERE "assetId" = asset."id";
  SELECT * INTO grouped FROM "ImportGroupRetirementApplication" WHERE "assetId" = asset."id";
  IF (legacy."id" IS NOT NULL AND grouped."id" IS NOT NULL) OR
    (legacy."id" IS NOT NULL AND legacy."decommissionedAt" IS DISTINCT FROM asset."decommissionedAt") OR
    (grouped."id" IS NOT NULL AND grouped."decommissionedAt" IS DISTINCT FROM asset."decommissionedAt") OR
    receipt."plan"->'existingRetirement' IS DISTINCT FROM jsonb_build_object('effectiveAt', import_group_assignment_iso(asset."decommissionedAt"),
      'datePrecision', CASE WHEN asset."decommissionedAt" IS NULL THEN 'UNKNOWN' ELSE 'INSTANT' END,
      'dateOrigin', CASE WHEN grouped."id" IS NOT NULL THEN 'GROUP_VERIFIED_IMPORT_RECEIPT' WHEN legacy."id" IS NOT NULL THEN 'VERIFIED_IMPORT_RECEIPT' ELSE 'CURRENT_ASSET' END,
      'legacyApplicationId', legacy."id", 'groupApplicationId', grouped."id", 'confirmsSourceDate', false) THEN
    RAISE EXCEPTION 'Existing retirement provenance must not be replaced or attributed to the selected source' USING ERRCODE = '23514';
  END IF;
  received_text := btrim(coalesce(evidence."snapshot"->'effective'->'fields'->>'receivedDate', ''));
  IF import_identifier_key(received_text) IS NOT NULL THEN
    received_day := left(received_text, 10);
    IF received_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?)?$' OR
      received_day < '1900-01-01' OR received_day > to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR
      to_char(received_day::date, 'YYYY-MM-DD') <> received_day THEN
      RAISE EXCEPTION 'Source reception must remain known or explicitly unknown' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF asset."decommissionedAt" IS NOT NULL AND left(import_group_assignment_iso(asset."decommissionedAt"), 10) < received_day THEN
    RAISE EXCEPTION 'Document reconciliation must expose conflicting reception chronology' USING ERRCODE = '23514';
  END IF;
  expected_source := jsonb_build_object('evidenceId', evidence."id", 'captureId', evidence."captureId", 'batchId', capture."batchId", 'sourceHash', evidence."sourceHash",
    'recordId', evidence."recordId", 'candidateId', evidence."candidateId", 'kind', evidence."kind", 'sheet', evidence."snapshot"->'original'->'sheet',
    'row', evidence."snapshot"->'original'->'row', 'sourceRevision', evidence."sourceRevision", 'capturedSourceRevision', capture."sourceRevision",
    'evidenceVersion', evidence."evidenceVersion", 'amendmentId', evidence."amendmentId", 'effectiveDay', NULL, 'datePrecision', 'UNKNOWN',
    'sourceReceivedDay', received_day, 'fields', evidence."snapshot"->'effective'->'fields', 'snapshotDigest', import_group_assignment_digest(evidence."snapshot"));
  IF receipt."plan"->'source' IS DISTINCT FROM expected_source THEN RAISE EXCEPTION 'Document source provenance must match its current version exactly' USING ERRCODE = '23514'; END IF;
  FOR issue IN SELECT value FROM jsonb_array_elements(evidence."snapshot"->'issues') LOOP
    IF issue->>'severity' = 'WARNING' THEN warnings := warnings || jsonb_build_array(jsonb_build_object('id', import_group_assignment_digest(jsonb_build_object('evidenceId', evidence."id", 'issue', issue)), 'evidenceId', evidence."id", 'issue', issue)); END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'), '[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(warnings) w;
  request := receipt."plan"->'request';
  IF request->'acknowledgedWarnings' IS DISTINCT FROM acknowledged OR receipt."plan"->'warnings' IS DISTINCT FROM warnings OR
    request->>'evidenceId' IS DISTINCT FROM evidence."id"::text OR length(btrim(coalesce(request->>'note', ''))) NOT BETWEEN 1 AND 2000 OR
    length(btrim(coalesce(request->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500 OR
    request - ARRAY['evidenceId','note','evidenceReference','acknowledgedWarnings'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Document reconciliation needs an exact documentary intent and reviewed warnings, never a supplied retirement date' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a."id", 'startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"),
    'recipientType', a."recipientType", 'personName', a."personName", 'officeName', a."officeName", 'assignmentType', a."assignmentType", 'returnStatus', a."returnStatus") ORDER BY a."id"), '[]'::jsonb)
    INTO assignments FROM "AssignmentEffective" a WHERE a."assetId" = asset."id";
  SELECT coalesce(jsonb_agg(jsonb_build_object('batchId', r."batchId", 'revision', r."revision", 'changes',
    (SELECT jsonb_agg(jsonb_build_object('candidateId', c->>'candidateId')) FROM jsonb_array_elements(r."changes") c)) ORDER BY r."batchId", r."revision"), '[]'::jsonb)
    INTO revisions FROM "ImportSourceRevision" r WHERE r."batchId" = capture."batchId";
  IF receipt."plan"->>'rulesVersion' IS DISTINCT FROM receipt."rulesVersion" OR receipt."plan"->>'planId' IS DISTINCT FROM receipt."planId" OR
    receipt."planId" IS DISTINCT FROM import_group_assignment_digest(receipt."plan" - ARRAY['planId','mode','persisted','canApply','planValidationComplete']) OR
    receipt."requestDigest" IS DISTINCT FROM import_group_assignment_digest(jsonb_build_object('requestId', receipt."requestId", 'planId', receipt."planId", 'confirmation', 'RECONCILE_EXISTING_RETIREMENT_DOCUMENT_ONLY', 'plan', request)) OR
    receipt."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR
    receipt."plan"->>'currentAssignmentsDigest' IS DISTINCT FROM import_group_assignment_digest(assignments) OR
    receipt."plan"->>'sourceRevisionsDigest' IS DISTINCT FROM import_group_assignment_digest(revisions) OR
    NOT ((receipt."plan" @> '{"scope":"EXISTING_RETIREMENT_DOCUMENT_RECONCILIATION","mode":"RETIREMENT_DOCUMENT_PLAN","persisted":false,"canApply":false,"affectsCurrentState":false,"confirmsSourceDate":false,"consumesOperationalEvidence":false,"historicalActorKnown":false,"planValidationComplete":true,"blockers":[],"sourceRetirement":{"effectiveAt":null,"datePrecision":"UNKNOWN","historicalActorId":null}}'::jsonb) IS TRUE) THEN
    RAISE EXCEPTION 'Document reconciliation requires an exact reviewed plan, context and intention without operational effects' USING ERRCODE = '23514';
  END IF;
  IF completed AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entityType" = 'ImportRetirementReconciliation' AND a."entityId" = receipt."id"::text AND
    a."action" = 'IMPORT_RETIREMENT_DOCUMENT_RECONCILED' AND a."userId" = receipt."recordedById" AND
    a.xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text AND
    a."metadata" = jsonb_build_object('assetId', receipt."assetId", 'evidenceId', receipt."evidenceId", 'evidenceVersion', receipt."evidenceVersion", 'planId', receipt."planId", 'affectsCurrentState', false, 'confirmsSourceDate', false, 'consumesOperationalEvidence', false)) THEN
    RAISE EXCEPTION 'Document reconciliation requires its matching atomic audit' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_retirement_document() RETURNS trigger AS $$
DECLARE source_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Document reconciliation receipts are immutable' USING ERRCODE = '23514'; END IF;
  SELECT "sourceHash" INTO source_hash FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  PERFORM 1 FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId" FOR NO KEY UPDATE;
  PERFORM assert_import_retirement_document(NEW, false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportRetirementReconciliation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportRetirementReconciliation" FOR EACH ROW EXECUTE FUNCTION guard_import_retirement_document();
CREATE TRIGGER "ImportRetirementReconciliation_truncate_guard" BEFORE TRUNCATE ON "ImportRetirementReconciliation" FOR EACH STATEMENT EXECUTE FUNCTION guard_import_retirement_document();

CREATE FUNCTION complete_import_retirement_document() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_retirement_document(NEW, true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportRetirementReconciliation_complete" AFTER INSERT ON "ImportRetirementReconciliation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_import_retirement_document();

CREATE FUNCTION guard_retirement_document_asset() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ImportRetirementReconciliation" WHERE "assetId" = OLD."id" AND "createdTransactionId" = pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Document reconciliation cannot modify its asset, even after early constraints' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_retirement_document_guard" BEFORE UPDATE OR DELETE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_asset();

CREATE FUNCTION guard_retirement_document_audit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "ImportRetirementReconciliation") THEN RAISE EXCEPTION 'Document reconciliation audit is immutable' USING ERRCODE = '23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM "ImportRetirementReconciliation" WHERE "id"::text = OLD."entityId") THEN
    RAISE EXCEPTION 'Document reconciliation audit is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_retirement_document_guard" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_audit();
CREATE TRIGGER "AuditLog_retirement_document_truncate_guard" BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION guard_retirement_document_audit();

CREATE FUNCTION guard_retirement_document_context() RETURNS trigger AS $$
DECLARE previous JSONB; proposed JSONB; receipt "ImportRetirementReconciliation"%ROWTYPE;
BEGIN
  previous := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  proposed := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  FOR receipt IN SELECT * FROM "ImportRetirementReconciliation" WHERE "createdTransactionId" = pg_current_xact_id()::text LOOP
    IF (TG_TABLE_NAME = 'Assignment' AND receipt."assetId"::text IN (previous->>'assetId', proposed->>'assetId')) OR
      (TG_TABLE_NAME = 'ImportEvidenceAmendment' AND receipt."evidenceId"::text IN (previous->>'evidenceId', proposed->>'evidenceId')) OR
      (TG_TABLE_NAME = 'ImportSourceRevision' AND receipt."plan"->'source'->>'batchId' IN (previous->>'batchId', proposed->>'batchId')) OR
      (TG_TABLE_NAME = 'Product' AND receipt."plan"->'assetBefore'->>'productId' IN (previous->>'id', proposed->>'id')) THEN
      RAISE EXCEPTION 'Document reconciliation context cannot change in its recording transaction' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_retirement_document_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_context();
CREATE TRIGGER "ImportEvidenceAmendment_retirement_document_guard" BEFORE INSERT ON "ImportEvidenceAmendment" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_context();
CREATE TRIGGER "ImportSourceRevision_retirement_document_guard" BEFORE INSERT ON "ImportSourceRevision" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_context();
CREATE TRIGGER "Product_retirement_document_guard" BEFORE UPDATE OR DELETE ON "Product" FOR EACH ROW EXECUTE FUNCTION guard_retirement_document_context();

COMMIT;
