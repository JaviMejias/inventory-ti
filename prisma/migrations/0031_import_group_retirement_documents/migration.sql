BEGIN;

CREATE TABLE "ImportGroupRetirementDocument" (
  "id" UUID PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "decisionId" UUID NOT NULL REFERENCES "ImportIdentityGroupDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "groupId" UUID NOT NULL,
  "groupKey" VARCHAR(64) NOT NULL CHECK ("groupKey" ~ '^[a-f0-9]{64}$'),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceVersion" INTEGER NOT NULL CHECK ("evidenceVersion" BETWEEN 0 AND 1000),
  "amendmentId" UUID REFERENCES "ImportEvidenceAmendment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-group-retirement-document-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "recordedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" TEXT NOT NULL DEFAULT (pg_current_xact_id())::text,
  CHECK (("evidenceVersion" = 0) = ("amendmentId" IS NULL))
);
CREATE UNIQUE INDEX "ImportGroupRetirementDocument_planId_key" ON "ImportGroupRetirementDocument"("planId");
CREATE UNIQUE INDEX "ImportGroupRetirementDocument_reviewId_requestId_key" ON "ImportGroupRetirementDocument"("reviewId", "requestId");
CREATE UNIQUE INDEX "ImportGroupRetirementDocument_evidenceId_evidenceVersion_key" ON "ImportGroupRetirementDocument"("evidenceId", "evidenceVersion");
CREATE INDEX "ImportGroupRetirementDocument_reviewId_recordedAt_id_idx" ON "ImportGroupRetirementDocument"("reviewId", "recordedAt", "id");
CREATE INDEX "ImportGroupRetirementDocument_createdTransactionId_idx" ON "ImportGroupRetirementDocument"("createdTransactionId");

CREATE FUNCTION assert_import_group_retirement_document(receipt "ImportGroupRetirementDocument", completed BOOLEAN) RETURNS void AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE; review "ImportIdentityGroupReview"%ROWTYPE; decision "ImportIdentityGroupDecision"%ROWTYPE;
  asset "Asset"%ROWTYPE; product "Product"%ROWTYPE; actor "User"%ROWTYPE;
  evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE; original "ImportHistoricalEvidence"%ROWTYPE; capture "ImportHistoryCapture"%ROWTYPE;
  legacy "ImportRetirementApplication"%ROWTYPE; grouped "ImportGroupRetirementApplication"%ROWTYPE;
  selected_group JSONB; request JSONB; source_row JSONB; pin JSONB; issue JSONB; fields JSONB; projection JSONB;
  coverage JSONB := '[]'::jsonb; consumption JSONB; expected_asset JSONB; assignments JSONB; revisions JSONB; receipts JSONB;
  warnings JSONB := '[]'::jsonb; group_warnings JSONB := '[]'::jsonb; acknowledged JSONB;
  received_text TEXT; received_day TEXT;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = receipt."batchId";
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id" = receipt."reviewId";
  SELECT * INTO decision FROM "ImportIdentityGroupDecision" WHERE "id" = receipt."decisionId";
  SELECT * INTO asset FROM "Asset" WHERE "id" = receipt."assetId";
  SELECT * INTO product FROM "Product" WHERE "id" = asset."productId";
  SELECT * INTO actor FROM "User" WHERE "id" = receipt."recordedById";
  SELECT * INTO legacy FROM "ImportRetirementApplication" WHERE "assetId" = asset."id";
  SELECT * INTO grouped FROM "ImportGroupRetirementApplication" WHERE "assetId" = asset."id";
  SELECT value INTO selected_group FROM jsonb_array_elements(decision."projection"->'groups') WHERE value->>'groupKey' = receipt."groupKey";
  request := receipt."plan"->'request';
  IF actor."role" IS DISTINCT FROM 'JEFE' OR actor."isActive" IS DISTINCT FROM true OR actor."passwordHash" IS NULL OR
    receipt."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR
    receipt."recordedAt" < date_trunc('milliseconds', transaction_timestamp() AT TIME ZONE 'UTC') OR receipt."recordedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR
    batch."id" IS NULL OR review."batchId" IS DISTINCT FROM batch."id" OR review."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR batch."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR
    EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId" = review."id") OR selected_group IS NULL OR
    decision."reviewId" IS DISTINCT FROM review."id" OR decision."action" IS DISTINCT FROM 'LINK_EXISTING' OR decision."linkedAssetId" IS DISTINCT FROM asset."id" OR
    decision."groupId" IS DISTINCT FROM receipt."groupId" OR decision."groupKey" IS DISTINCT FROM receipt."groupKey" OR
    decision."id" IS DISTINCT FROM (SELECT "id" FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id" AND "groupKey" = receipt."groupKey" ORDER BY "version" DESC LIMIT 1) OR
    decision."batchVersion" IS DISTINCT FROM batch."version" OR decision."sourceRevision" IS DISTINCT FROM (SELECT count(*)::integer FROM "ImportSourceRevision" WHERE "batchId" = batch."id") OR
    request->>'expectedBatchVersion' IS DISTINCT FROM batch."version"::text OR request->>'expectedSourceRevision' IS DISTINCT FROM decision."sourceRevision"::text OR
    request->>'expectedDecisionVersion' IS DISTINCT FROM (SELECT max("version")::text FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id") OR
    request->>'decisionId' IS DISTINCT FROM decision."id"::text OR request->>'projectionId' IS DISTINCT FROM decision."projectionId" OR
    receipt."plan"->>'projectionId' IS DISTINCT FROM decision."projectionId" OR request->>'groupKey' IS DISTINCT FROM receipt."groupKey" OR
    decision."projection"->>'asOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR
    receipt."groupKey" IS DISTINCT FROM import_group_assignment_digest(jsonb_build_array('IMPORT_IDENTITY_GROUP', receipt."sourceHash", review."id", receipt."groupId")) THEN
    RAISE EXCEPTION 'Group documents require current active review, exact latest decision, versions and configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF asset."id" IS NULL OR asset."isActive" OR asset."status" <> 'DECOMMISSIONED' OR product."trackingMode" <> 'ASSET' OR
    import_identifier_key(asset."serialNumber") IS DISTINCT FROM import_identifier_key(selected_group->>'serialNumber') OR
    import_identifier_key(asset."assetTag") IS DISTINCT FROM import_identifier_key(selected_group->>'assetTag') OR
    (asset."decommissionedAt" IS NOT NULL AND (asset."decommissionedAt" < TIMESTAMP '1900-01-01' OR asset."decommissionedAt" > clock_timestamp() AT TIME ZONE 'UTC')) OR
    EXISTS (SELECT 1 FROM "Asset" WHERE "id" = asset."id" AND xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text) OR
    EXISTS (SELECT 1 FROM "AssignmentEffective" WHERE "assetId" = asset."id" AND ("endedAt" IS NULL OR "endedAt" <= "startedAt" OR "endedAt" > asset."decommissionedAt")) OR
    (legacy."id" IS NOT NULL AND grouped."id" IS NOT NULL) OR
    (legacy."id" IS NOT NULL AND legacy."decommissionedAt" IS DISTINCT FROM asset."decommissionedAt") OR
    (grouped."id" IS NOT NULL AND grouped."decommissionedAt" IS DISTINCT FROM asset."decommissionedAt") THEN
    RAISE EXCEPTION 'Group documents require a preexisting unchanged coherent terminal and closed custody' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(selected_group->'candidates') <> 1 OR
    selected_group->'candidates'->0->'existingAssets' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('id', asset."id", 'productId', asset."productId", 'serialNumber', asset."serialNumber", 'assetTag', asset."assetTag", 'status', asset."status", 'isActive', asset."isActive", 'updatedAt', import_group_assignment_iso(asset."updatedAt"), 'product', jsonb_build_object('name', product."name"))) OR
    (SELECT count(*) FROM "Asset" a WHERE (import_identifier_key(selected_group->>'serialNumber') IS NOT NULL AND import_identifier_key(a."serialNumber") = import_identifier_key(selected_group->>'serialNumber')) OR
      (import_identifier_key(selected_group->>'assetTag') IS NOT NULL AND import_identifier_key(a."assetTag") = import_identifier_key(selected_group->>'assetTag'))) <> 1 THEN
    RAISE EXCEPTION 'Group document requires a fresh decision for the unique unchanged physical asset' USING ERRCODE = '23514';
  END IF;
  expected_asset := to_jsonb(asset) || jsonb_build_object('createdAt', import_group_assignment_iso(asset."createdAt"),
    'updatedAt', import_group_assignment_iso(asset."updatedAt"), 'decommissionedAt', import_group_assignment_iso(asset."decommissionedAt"));
  IF receipt."plan"->'assetSnapshot' IS DISTINCT FROM expected_asset OR receipt."plan"->'assetBefore' IS DISTINCT FROM
    jsonb_build_object('id', asset."id", 'productId', asset."productId", 'serialNumber', asset."serialNumber", 'assetTag', asset."assetTag", 'status', asset."status", 'isActive', asset."isActive", 'decommissionedAt', import_group_assignment_iso(asset."decommissionedAt"), 'updatedAt', import_group_assignment_iso(asset."updatedAt"),
      'product', jsonb_build_object('id', product."id", 'trackingMode', product."trackingMode", 'isActive', product."isActive", 'updatedAt', import_group_assignment_iso(product."updatedAt"))) OR
    receipt."plan"->'existingRetirement' IS DISTINCT FROM jsonb_build_object('effectiveAt', import_group_assignment_iso(asset."decommissionedAt"), 'datePrecision', CASE WHEN asset."decommissionedAt" IS NULL THEN 'UNKNOWN' ELSE 'INSTANT' END,
      'dateOrigin', CASE WHEN grouped."id" IS NOT NULL THEN 'GROUP_VERIFIED_IMPORT_RECEIPT' WHEN legacy."id" IS NOT NULL THEN 'VERIFIED_IMPORT_RECEIPT' ELSE 'CURRENT_ASSET' END, 'confirmsSourceDate', false) THEN
    RAISE EXCEPTION 'Group documents must preserve full terminal metadata and retirement provenance' USING ERRCODE = '23514';
  END IF;
  IF receipt."plan"->'sourceRows' IS DISTINCT FROM selected_group->'observations' OR jsonb_array_length(selected_group->'observations') NOT BETWEEN 1 AND 25 OR
    (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId" = review."id" AND "groupId" = receipt."groupId") <> jsonb_array_length(selected_group->'observations') THEN
    RAISE EXCEPTION 'Group documents require full reviewed physical membership' USING ERRCODE = '23514';
  END IF;
  FOR source_row IN SELECT value FROM jsonb_array_elements(selected_group->'observations') LOOP
    IF NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" r WHERE r."reviewId" = review."id" AND r."groupId" = receipt."groupId" AND r."isReserved" AND r."sourceHash" = receipt."sourceHash" AND r."recordId" = source_row->>'recordId' AND r."originalCandidateId" = source_row->>'originalCandidateId' AND r."snapshot"->>'sheet' = source_row->>'sheet' AND r."snapshot"->>'row' = source_row->>'row') OR
      EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" WHERE "sourceHash" = receipt."sourceHash" AND "recordId" = source_row->>'recordId' AND "isReserved" AND "reviewId" <> review."id") OR
      EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash" = receipt."sourceHash" AND "recordId" = source_row->>'recordId') OR
      EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "sourceHash" = receipt."sourceHash" AND "candidateId" = source_row->>'originalCandidateId') OR
      EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c WHERE r."batchId" = batch."id" AND r."revision" > review."sourceRevision" AND c->>'candidateId' = source_row->>'originalCandidateId') THEN
      RAISE EXCEPTION 'Group documentary source must remain reserved, unchanged and not consumed by an asset pilot' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sourceHash', u."sourceHash", 'recordId', u."recordId", 'reviewId', u."reviewId", 'applicationId', u."applicationId", 'assetId', a."assetId", 'batchId', a."batchId", 'origin', 'GROUP_RETIREMENT') ORDER BY u."recordId"), '[]'::jsonb)
    INTO consumption FROM "ImportGroupRetirementRowUse" u JOIN "ImportGroupRetirementApplication" a ON a."id" = u."applicationId"
    WHERE u."sourceHash" = receipt."sourceHash" AND u."recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(selected_group->'observations'));
  IF receipt."plan"->'sourceConsumption' IS DISTINCT FROM consumption OR (consumption <> '[]'::jsonb AND
    (jsonb_array_length(consumption) <> jsonb_array_length(selected_group->'observations') OR grouped."id" IS NULL OR
      grouped."reviewId" IS DISTINCT FROM review."id" OR grouped."batchId" IS DISTINCT FROM batch."id" OR grouped."groupKey" IS DISTINCT FROM receipt."groupKey" OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(consumption) c WHERE c->>'applicationId' IS DISTINCT FROM grouped."id"::text OR c->>'reviewId' IS DISTINCT FROM review."id"::text))) THEN
    RAISE EXCEPTION 'Only complete consumption by this exact existing group retirement may be documented' USING ERRCODE = '23514';
  END IF;
  receipts := '[]'::jsonb;
  IF legacy."id" IS NOT NULL THEN receipts := receipts || jsonb_build_array(jsonb_build_object('id', legacy."id", 'assetId', legacy."assetId", 'evidenceId', legacy."evidenceId", 'evidenceVersion', legacy."evidenceVersion", 'amendmentId', legacy."amendmentId", 'sourceRevision', legacy."sourceRevision", 'decommissionedAt', import_group_assignment_iso(legacy."decommissionedAt"), 'appliedAt', import_group_assignment_iso(legacy."appliedAt"), 'appliedById', legacy."appliedById", 'origin', 'LEGACY')); END IF;
  IF grouped."id" IS NOT NULL THEN receipts := receipts || jsonb_build_array(jsonb_build_object('id', grouped."id", 'assetId', grouped."assetId", 'evidenceId', grouped."evidenceId", 'evidenceVersion', grouped."evidenceVersion", 'amendmentId', grouped."amendmentId", 'sourceRevision', grouped."sourceRevision", 'decommissionedAt', import_group_assignment_iso(grouped."decommissionedAt"), 'appliedAt', import_group_assignment_iso(grouped."appliedAt"), 'appliedById', grouped."appliedById", 'batchId', grouped."batchId", 'reviewId', grouped."reviewId", 'groupKey', grouped."groupKey", 'groupId', grouped."groupId", 'origin', 'GROUP')); END IF;
  IF receipt."plan"->'retirementReceipts' IS DISTINCT FROM receipts THEN RAISE EXCEPTION 'Group document must expose exact existing retirement receipts without replacing provenance' USING ERRCODE = '23514'; END IF;
  IF jsonb_array_length(selected_group->'evidence') NOT BETWEEN 1 AND 100 OR
    jsonb_array_length(selected_group->'evidence') <> (SELECT count(*) FROM "ImportHistoricalEvidence" WHERE "sourceHash" = receipt."sourceHash" AND "recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(selected_group->'observations'))) OR
    (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(selected_group->'evidence')) <> jsonb_array_length(selected_group->'evidence') THEN
    RAISE EXCEPTION 'Group documents require complete version-pinned archive coverage' USING ERRCODE = '23514';
  END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(selected_group->'evidence') ORDER BY value->>'id' LOOP
    SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = (pin->>'id')::uuid;
    SELECT * INTO original FROM "ImportHistoricalEvidence" WHERE "id" = evidence."id";
    SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
    IF evidence."id" IS NULL OR evidence."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR capture."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR capture."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1' OR
      pin->>'recordId' IS DISTINCT FROM evidence."recordId" OR pin->>'candidateId' IS DISTINCT FROM evidence."candidateId" OR pin->>'captureId' IS DISTINCT FROM capture."id"::text OR pin->>'captureBatchId' IS DISTINCT FROM capture."batchId"::text OR
      pin->>'capturedSourceRevision' IS DISTINCT FROM capture."sourceRevision"::text OR pin->>'sourceRevision' IS DISTINCT FROM evidence."sourceRevision"::text OR pin->>'evidenceVersion' IS DISTINCT FROM evidence."evidenceVersion"::text OR
      pin->>'amendmentId' IS DISTINCT FROM evidence."amendmentId"::text OR pin->>'capturedAssetId' IS DISTINCT FROM original."assetId"::text OR pin->>'currentAssetId' IS DISTINCT FROM evidence."assetId"::text OR
      (evidence."assetId" IS NOT NULL AND evidence."assetId" <> asset."id") OR original."snapshot"->'original' IS DISTINCT FROM evidence."snapshot"->'original' OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'observations') r WHERE r->>'recordId' = evidence."recordId" AND r->>'originalCandidateId' = evidence."candidateId" AND r->>'sheet' = evidence."snapshot"->'original'->>'sheet' AND r->>'row' = evidence."snapshot"->'original'->>'row') OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(evidence."snapshot"->'issues') i WHERE i->>'severity' = 'BLOCKING') OR
      EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c WHERE r."batchId" = capture."batchId" AND r."revision" > evidence."sourceRevision" AND c->>'candidateId' = evidence."candidateId") OR
      (evidence."kind" = 'RECEIPT_OBSERVATION' AND asset."decommissionedAt" IS NOT NULL AND evidence."effectiveDay" > left(import_group_assignment_iso(asset."decommissionedAt"), 10)) THEN
      RAISE EXCEPTION 'Every group archive version must retain compatible current provenance and chronology' USING ERRCODE = '23514';
    END IF;
    coverage := coverage || jsonb_build_array(jsonb_build_object('evidenceId', evidence."id", 'recordId', evidence."recordId", 'kind', evidence."kind", 'capturedAssetId', original."assetId", 'currentAssetId', evidence."assetId", 'evidenceVersion', evidence."evidenceVersion", 'amendmentId', evidence."amendmentId", 'sourceRevision', evidence."sourceRevision", 'snapshotDigest', import_group_assignment_digest(evidence."snapshot"), 'issues', evidence."snapshot"->'issues', 'appliedByThisAssessment', false));
  END LOOP;
  IF receipt."plan"->'evidenceCoverage' IS DISTINCT FROM coverage THEN RAISE EXCEPTION 'Documentary archive coverage must match every current version' USING ERRCODE = '23514'; END IF;
  SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = receipt."evidenceId";
  SELECT * INTO original FROM "ImportHistoricalEvidence" WHERE "id" = receipt."evidenceId";
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
  IF evidence."id" IS NULL OR evidence."kind" IS DISTINCT FROM 'RETIREMENT_OBSERVATION' OR evidence."effectiveDay" IS NOT NULL OR
    NOT ((evidence."snapshot" @> '{"datePrecision":"UNKNOWN","historicalActorId":null}'::jsonb) IS TRUE) OR
    evidence."evidenceVersion" IS DISTINCT FROM receipt."evidenceVersion" OR evidence."amendmentId" IS DISTINCT FROM receipt."amendmentId" OR evidence."sourceRevision" IS DISTINCT FROM receipt."sourceRevision" OR
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'evidence') e WHERE e->>'id' = receipt."evidenceId"::text) OR
    EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id") OR EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = evidence."id") OR EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" WHERE "evidenceId" = evidence."id") OR
    EXISTS (SELECT 1 FROM "ImportRetirementReconciliation" WHERE "evidenceId" = evidence."id" AND "evidenceVersion" = receipt."evidenceVersion") OR
    EXISTS (SELECT 1 FROM "ImportGroupRetirementDocument" WHERE "evidenceId" = evidence."id" AND "evidenceVersion" = receipt."evidenceVersion" AND "id" <> receipt."id") THEN
    RAISE EXCEPTION 'Group document requires an exact unused undated observation without duplicate documentary confirmation' USING ERRCODE = '23514';
  END IF;
  fields := evidence."snapshot"->'effective'->'fields' || jsonb_build_object('serialNumber', selected_group->'serialNumber', 'assetTag', selected_group->'assetTag');
  projection := evidence."snapshot" || jsonb_build_object('assetId', asset."id", 'identityLinkBlocked', false, 'linkBasis', jsonb_build_object('type', 'REVIEWED_IDENTITY_GROUP_PROPOSAL', 'reviewId', review."id", 'groupId', receipt."groupId"),
    'effective', evidence."snapshot"->'effective' || jsonb_build_object('serialKey', import_identifier_key(selected_group->>'serialNumber'), 'tagKey', import_identifier_key(selected_group->>'assetTag'), 'fields', fields));
  IF receipt."plan"->'proposedEvidenceProjection' IS DISTINCT FROM projection OR receipt."plan"->'originalEvidence'->'snapshot' IS DISTINCT FROM original."snapshot" OR receipt."plan"->'currentEvidence'->'snapshot' IS DISTINCT FROM evidence."snapshot" THEN
    RAISE EXCEPTION 'Original, current and proposed group document identities must remain separate' USING ERRCODE = '23514';
  END IF;
  received_text := btrim(coalesce(fields->>'receivedDate', ''));
  IF import_identifier_key(received_text) IS NOT NULL THEN
    received_day := left(received_text, 10);
    IF received_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?)?$' OR received_day < '1900-01-01' OR
      received_day > to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR to_char(received_day::date, 'YYYY-MM-DD') <> received_day OR
      (asset."decommissionedAt" IS NOT NULL AND left(import_group_assignment_iso(asset."decommissionedAt"), 10) < received_day) THEN
      RAISE EXCEPTION 'Documentary chronology cannot contradict reception' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF receipt."plan"->'source' IS DISTINCT FROM jsonb_build_object('evidenceId', evidence."id", 'captureId', evidence."captureId", 'batchId', capture."batchId", 'sourceHash', evidence."sourceHash", 'recordId', evidence."recordId", 'candidateId', evidence."candidateId", 'kind', evidence."kind", 'sheet', evidence."snapshot"->'original'->'sheet', 'row', evidence."snapshot"->'original'->'row', 'sourceRevision', evidence."sourceRevision", 'capturedSourceRevision', capture."sourceRevision", 'evidenceVersion', evidence."evidenceVersion", 'amendmentId', evidence."amendmentId", 'effectiveDay', NULL, 'datePrecision', 'UNKNOWN', 'sourceReceivedDay', received_day, 'fields', fields, 'snapshotDigest', import_group_assignment_digest(projection)) THEN
    RAISE EXCEPTION 'Document source metadata must match its exact current version and reviewed projection' USING ERRCODE = '23514';
  END IF;
  FOR issue IN SELECT value FROM jsonb_array_elements(decision."projection"->'issues') LOOP
    IF (issue->>'candidateId' IS NOT NULL AND selected_group->'simulatedCandidateIds' ? (issue->>'candidateId')) OR (issue->>'candidateId' IS NULL AND (issue->>'sheet' IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'observations') r WHERE r->>'sheet' = issue->>'sheet' AND (issue->>'row' IS NULL OR r->>'row' = issue->>'row')))) THEN
      IF issue->>'severity' = 'BLOCKING' THEN RAISE EXCEPTION 'Group document cannot waive grouping blockers' USING ERRCODE = '23514'; END IF;
      IF issue->>'severity' = 'WARNING' THEN group_warnings := group_warnings || jsonb_build_array(jsonb_build_object('id', import_group_assignment_digest(issue), 'issue', issue)); END IF;
    END IF;
  END LOOP;
  FOR issue IN SELECT value FROM jsonb_array_elements(evidence."snapshot"->'issues') WHERE value->>'severity' = 'WARNING' LOOP
    warnings := warnings || jsonb_build_array(jsonb_build_object('id', import_group_assignment_digest(jsonb_build_object('evidenceId', evidence."id", 'issue', issue)), 'evidenceId', evidence."id", 'issue', issue));
  END LOOP;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'), '[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(warnings) w;
  IF receipt."plan"->'warnings' IS DISTINCT FROM warnings OR request->'document'->'acknowledgedWarnings' IS DISTINCT FROM acknowledged THEN RAISE EXCEPTION 'Exact historical warnings must be acknowledged' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'), '[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(group_warnings) w;
  IF receipt."plan"->'groupWarnings' IS DISTINCT FROM group_warnings OR request->'acknowledgedGroupWarnings' IS DISTINCT FROM acknowledged OR
    request->'document'->>'evidenceId' IS DISTINCT FROM receipt."evidenceId"::text OR request->>'expectedEvidenceVersion' IS DISTINCT FROM receipt."evidenceVersion"::text OR
    length(btrim(coalesce(request->'document'->>'note', ''))) NOT BETWEEN 1 AND 2000 OR length(btrim(coalesce(request->'document'->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500 OR
    (request->'document') - ARRAY['evidenceId','note','evidenceReference','acknowledgedWarnings'] <> '{}'::jsonb OR
    request - ARRAY['expectedBatchVersion','expectedSourceRevision','expectedDecisionVersion','projectionId','groupKey','decisionId','expectedEvidenceVersion','acknowledgedGroupWarnings','document'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Group documents require exact documentary intent and warnings, never a retirement date' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a."id", 'startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"), 'recipientType', a."recipientType", 'personName', a."personName", 'officeName', a."officeName", 'assignmentType', a."assignmentType", 'returnStatus', a."returnStatus") ORDER BY a."id"), '[]'::jsonb) INTO assignments FROM "AssignmentEffective" a WHERE a."assetId" = asset."id";
  SELECT coalesce(jsonb_agg(jsonb_build_object('batchId', r."batchId", 'revision', r."revision", 'changes', (SELECT jsonb_agg(jsonb_build_object('candidateId', c->>'candidateId')) FROM jsonb_array_elements(r."changes") c)) ORDER BY r."batchId", r."revision"), '[]'::jsonb) INTO revisions FROM "ImportSourceRevision" r WHERE r."batchId" IN (SELECT c."batchId" FROM "ImportHistoryCapture" c JOIN "ImportHistoricalEvidence" e ON e."captureId" = c."id" WHERE e."sourceHash" = receipt."sourceHash" AND e."recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(selected_group->'observations')));
  IF receipt."plan"->>'rulesVersion' IS DISTINCT FROM receipt."rulesVersion" OR receipt."plan"->>'planId' IS DISTINCT FROM receipt."planId" OR
    receipt."planId" IS DISTINCT FROM import_group_assignment_digest(receipt."plan" - ARRAY['planId','mode','persisted','canApply','planValidationComplete']) OR
    receipt."requestDigest" IS DISTINCT FROM import_group_assignment_digest(jsonb_build_object('requestId', receipt."requestId", 'planId', receipt."planId", 'confirmation', 'RECONCILE_GROUP_RETIREMENT_DOCUMENT_ONLY', 'plan', request)) OR
    receipt."plan"->>'decisionProofDigest' IS DISTINCT FROM import_group_assignment_digest(to_jsonb(decision) || jsonb_build_object('createdAt', import_group_assignment_iso(decision."createdAt"))) OR
    receipt."plan"->>'batchId' IS DISTINCT FROM batch."id"::text OR receipt."plan"->>'reviewId' IS DISTINCT FROM review."id"::text OR receipt."plan"->>'groupId' IS DISTINCT FROM receipt."groupId"::text OR
    receipt."plan"->>'groupKey' IS DISTINCT FROM receipt."groupKey" OR receipt."plan"->>'sourceHash' IS DISTINCT FROM receipt."sourceHash" OR receipt."plan"->>'decisionId' IS DISTINCT FROM decision."id"::text OR
    receipt."plan"->>'batchVersion' IS DISTINCT FROM request->>'expectedBatchVersion' OR receipt."plan"->>'sourceRevision' IS DISTINCT FROM request->>'expectedSourceRevision' OR receipt."plan"->>'decisionVersion' IS DISTINCT FROM request->>'expectedDecisionVersion' OR
    receipt."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR receipt."plan"->>'timeZone' IS DISTINCT FROM 'America/Santiago' OR
    receipt."plan"->>'currentAssignmentsDigest' IS DISTINCT FROM import_group_assignment_digest(assignments) OR receipt."plan"->>'sourceRevisionsDigest' IS DISTINCT FROM import_group_assignment_digest(revisions) OR
    NOT ((receipt."plan" @> '{"scope":"GROUP_RETIREMENT_DOCUMENT_RECONCILIATION","mode":"GROUP_RETIREMENT_DOCUMENT_PLAN","persisted":false,"canApply":false,"affectsCurrentState":false,"evidenceRelinked":false,"confirmsSourceDate":false,"consumesOperationalEvidence":false,"historicalActorKnown":false,"planValidationComplete":true,"blockers":[],"sourceRetirement":{"effectiveAt":null,"datePrecision":"UNKNOWN","historicalActorId":null}}'::jsonb) IS TRUE) THEN
    RAISE EXCEPTION 'Group document requires exact reviewed plan, context and independent confirmation' USING ERRCODE = '23514';
  END IF;
  IF completed AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entityType" = 'ImportGroupRetirementDocument' AND a."entityId" = receipt."id"::text AND a."action" = 'IMPORT_GROUP_RETIREMENT_DOCUMENT_RECONCILED' AND a."userId" = receipt."recordedById" AND a.xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text AND
    a."metadata" = jsonb_build_object('batchId', receipt."batchId", 'reviewId', receipt."reviewId", 'assetId', receipt."assetId", 'evidenceId', receipt."evidenceId", 'evidenceVersion', receipt."evidenceVersion", 'planId', receipt."planId", 'affectsCurrentState', false, 'confirmsSourceDate', false, 'consumesOperationalEvidence', false)) THEN
    RAISE EXCEPTION 'Group document requires its matching atomic audit' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_group_retirement_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group documentary receipts are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  PERFORM 1 FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."sourceHash", 0));
  LOCK TABLE "Asset", "Product", "Assignment", "User", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportSourceRevision", "ImportIdentityGroupReview", "ImportIdentityGroupRow", "ImportIdentityGroupRelease", "ImportIdentityGroupDecision", "ImportIdentityGroupRowUse", "ImportGroupRetirementRowUse", "ImportGroupAssignmentCorrection", "ImportRetirementReconciliation", "ImportGroupRetirementDocument" IN EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  PERFORM assert_import_group_retirement_document(NEW, false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupRetirementDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupRetirementDocument" FOR EACH ROW EXECUTE FUNCTION guard_import_group_retirement_document();
CREATE TRIGGER "ImportGroupRetirementDocument_truncate_guard" BEFORE TRUNCATE ON "ImportGroupRetirementDocument" FOR EACH STATEMENT EXECUTE FUNCTION guard_import_group_retirement_document();
CREATE FUNCTION complete_import_group_retirement_document() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_group_retirement_document(NEW, true);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportGroupRetirementDocument_complete" AFTER INSERT ON "ImportGroupRetirementDocument" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_import_group_retirement_document();

CREATE FUNCTION guard_group_retirement_document_duplicate() RETURNS trigger AS $$
DECLARE source_hash TEXT;
BEGIN
  SELECT "sourceHash" INTO source_hash FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  IF EXISTS (SELECT 1 FROM "ImportGroupRetirementDocument" WHERE "evidenceId" = NEW."evidenceId" AND "evidenceVersion" = NEW."evidenceVersion") THEN
    RAISE EXCEPTION 'Evidence version already has a group documentary receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportRetirementReconciliation_group_duplicate_guard" BEFORE INSERT ON "ImportRetirementReconciliation" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_duplicate();

CREATE FUNCTION guard_group_retirement_document_audit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "ImportGroupRetirementDocument") THEN RAISE EXCEPTION 'Group documentary audit is immutable' USING ERRCODE = '23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM "ImportGroupRetirementDocument" WHERE "id"::text = OLD."entityId") THEN
    RAISE EXCEPTION 'Group documentary audit is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_group_retirement_document_guard" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_audit();
CREATE TRIGGER "AuditLog_group_retirement_document_truncate_guard" BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION guard_group_retirement_document_audit();

CREATE FUNCTION guard_group_retirement_document_context() RETURNS trigger AS $$
DECLARE previous JSONB; proposed JSONB; receipt "ImportGroupRetirementDocument"%ROWTYPE;
BEGIN
  previous := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  proposed := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  FOR receipt IN SELECT * FROM "ImportGroupRetirementDocument" WHERE "createdTransactionId" = pg_current_xact_id()::text LOOP
    IF (TG_TABLE_NAME = 'Asset' AND receipt."assetId"::text IN (previous->>'id', proposed->>'id')) OR
      (TG_TABLE_NAME IN ('Assignment', 'InventoryMovement') AND receipt."assetId"::text IN (previous->>'assetId', proposed->>'assetId')) OR
      (TG_TABLE_NAME = 'ImportGroupAssignmentCorrection' AND EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" i JOIN "Assignment" a ON a."id" = i."assignmentId" WHERE i."id"::text IN (previous->>'itemId', proposed->>'itemId') AND a."assetId" = receipt."assetId")) OR
      (TG_TABLE_NAME IN ('ImportHistoryCapture', 'ImportHistoricalEvidence') AND receipt."sourceHash" IN (previous->>'sourceHash', proposed->>'sourceHash')) OR
      (TG_TABLE_NAME = 'ImportEvidenceAmendment' AND EXISTS (SELECT 1 FROM "ImportHistoricalEvidence" e WHERE e."id"::text IN (previous->>'evidenceId', proposed->>'evidenceId') AND e."sourceHash" = receipt."sourceHash" AND e."recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(receipt."plan"->'sourceRows')))) OR
      (TG_TABLE_NAME = 'ImportSourceRevision' AND EXISTS (SELECT 1 FROM "ImportHistoricalEvidence" e JOIN "ImportHistoryCapture" c ON c."id" = e."captureId" WHERE c."batchId"::text IN (previous->>'batchId', proposed->>'batchId') AND e."sourceHash" = receipt."sourceHash")) OR
      (TG_TABLE_NAME IN ('Product', 'InventoryStock') AND receipt."plan"->'assetBefore'->>'productId' IN (previous->>'id', proposed->>'id', previous->>'productId', proposed->>'productId')) OR
      (TG_TABLE_NAME = 'User' AND receipt."recordedById"::text IN (previous->>'id', proposed->>'id')) OR
      (TG_TABLE_NAME = 'ImportBatch' AND receipt."batchId"::text IN (previous->>'id', proposed->>'id')) OR
      (TG_TABLE_NAME = 'ImportIdentityGroupReview' AND receipt."reviewId"::text IN (previous->>'id', proposed->>'id')) OR
      (TG_TABLE_NAME IN ('ImportIdentityGroupRow', 'ImportIdentityGroupRelease', 'ImportIdentityGroupDecision', 'ImportGroupRetirementRowUse', 'ImportIdentityGroupRowUse') AND receipt."reviewId"::text IN (previous->>'reviewId', proposed->>'reviewId')) THEN
      RAISE EXCEPTION 'Group documentary context cannot change in its recording transaction, including after early constraints' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_group_document_context" BEFORE UPDATE OR DELETE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "Assignment_group_document_context" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportGroupAssignmentCorrection_group_document_context" BEFORE INSERT ON "ImportGroupAssignmentCorrection" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportHistoryCapture_group_document_context" BEFORE INSERT ON "ImportHistoryCapture" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportHistoricalEvidence_group_document_context" BEFORE INSERT ON "ImportHistoricalEvidence" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "InventoryMovement_group_document_context" BEFORE INSERT OR UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "InventoryStock_group_document_context" BEFORE INSERT OR UPDATE OR DELETE ON "InventoryStock" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "Product_group_document_context" BEFORE UPDATE OR DELETE ON "Product" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "User_group_document_context" BEFORE UPDATE OR DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportBatch_group_document_context" BEFORE UPDATE OR DELETE ON "ImportBatch" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportIdentityGroupReview_group_document_context" BEFORE UPDATE OR DELETE ON "ImportIdentityGroupReview" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportIdentityGroupRow_group_document_context" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupRow" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportIdentityGroupRelease_group_document_context" BEFORE INSERT ON "ImportIdentityGroupRelease" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportIdentityGroupDecision_group_document_context" BEFORE INSERT ON "ImportIdentityGroupDecision" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportGroupRetirementRowUse_group_document_context" BEFORE INSERT ON "ImportGroupRetirementRowUse" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportIdentityGroupRowUse_group_document_context" BEFORE INSERT ON "ImportIdentityGroupRowUse" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportEvidenceAmendment_group_document_context" BEFORE INSERT ON "ImportEvidenceAmendment" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();
CREATE TRIGGER "ImportSourceRevision_group_document_context" BEFORE INSERT ON "ImportSourceRevision" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_document_context();

COMMIT;
