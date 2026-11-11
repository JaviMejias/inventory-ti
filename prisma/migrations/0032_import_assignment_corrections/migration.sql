BEGIN;

CREATE TABLE "ImportAssignmentCorrection" (
  "id" UUID PRIMARY KEY,
  "itemId" UUID NOT NULL REFERENCES "ImportAssignmentItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" BETWEEN 1 AND 1000),
  "previousId" UUID REFERENCES "ImportAssignmentCorrection"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL, "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "correctionPlanId" VARCHAR(64) NOT NULL CHECK ("correctionPlanId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-legacy-assignment-correction-application-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 2000),
  "supportingReference" TEXT NOT NULL CHECK (length(btrim("supportingReference")) BETWEEN 1 AND 500),
  "assetSnapshot" JSONB NOT NULL, "custodySnapshot" JSONB NOT NULL,
  "correctedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" VARCHAR(20) NOT NULL DEFAULT (pg_current_xact_id())::text,
  CHECK (("version" = 1) = ("previousId" IS NULL))
);
CREATE UNIQUE INDEX "ImportAssignmentCorrection_itemId_version_key" ON "ImportAssignmentCorrection"("itemId", "version");
CREATE UNIQUE INDEX "ImportAssignmentCorrection_itemId_requestId_key" ON "ImportAssignmentCorrection"("itemId", "requestId");
CREATE UNIQUE INDEX "ImportAssignmentCorrection_previousId_key" ON "ImportAssignmentCorrection"("previousId");
CREATE UNIQUE INDEX "ImportAssignmentCorrection_correctionPlanId_key" ON "ImportAssignmentCorrection"("correctionPlanId");
CREATE INDEX "ImportAssignmentCorrection_createdTransactionId_idx" ON "ImportAssignmentCorrection"("createdTransactionId");

CREATE FUNCTION legacy_correction_assignment_json(a "Assignment") RETURNS JSONB AS $$
  SELECT to_jsonb(a) || jsonb_build_object('startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"),
    'createdAt', import_group_assignment_iso(a."createdAt"), 'returnRecordedAt', import_group_assignment_iso(a."returnRecordedAt"), 'expectedReturnAt', import_group_assignment_iso(a."expectedReturnAt"));
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION legacy_correction_history(asset_id UUID, ignored_id UUID) RETURNS JSONB AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a."id", 'startedAt', coalesce(c."plan"->'proposed'->'startedAt', to_jsonb(import_group_assignment_iso(a."startedAt"))),
    'endedAt', coalesce(c."plan"->'proposed'->'endedAt', to_jsonb(import_group_assignment_iso(a."endedAt")), 'null'::jsonb),
    'recipientType', coalesce(c."plan"->'proposed'->'recipientType', to_jsonb(a."recipientType")), 'personName', CASE WHEN c."id" IS NULL THEN to_jsonb(a."personName") ELSE c."plan"->'proposed'->'personName' END,
    'officeName', CASE WHEN c."id" IS NULL THEN to_jsonb(a."officeName") ELSE c."plan"->'proposed'->'officeName' END,
    'assignmentType', coalesce(c."plan"->'proposed'->'assignmentType', to_jsonb(a."assignmentType")),
    'returnStatus', CASE WHEN c."id" IS NULL THEN to_jsonb(a."returnStatus") ELSE c."plan"->'proposed'->'returnStatus' END) ORDER BY a."id"), '[]'::jsonb)
  FROM "Assignment" a LEFT JOIN "ImportAssignmentItem" i ON i."assignmentId" = a."id" LEFT JOIN "ImportGroupAssignmentItem" g ON g."assignmentId" = a."id"
  LEFT JOIN LATERAL (SELECT * FROM (SELECT "id", "plan", "version" FROM "ImportAssignmentCorrection" WHERE "itemId" = i."id" AND "id" IS DISTINCT FROM ignored_id
    UNION ALL SELECT "id", "plan", "version" FROM "ImportGroupAssignmentCorrection" WHERE "itemId" = g."id") versions ORDER BY "version" DESC LIMIT 1) c ON true
  WHERE a."assetId" = asset_id;
$$ LANGUAGE sql;

CREATE FUNCTION legacy_correction_evidence_json(evidence_id UUID) RETURNS JSONB AS $$
  SELECT to_jsonb(e) || jsonb_build_object('capturedAt',import_group_assignment_iso(e."capturedAt"),'assetId',v."assetId",'effectiveDay',v."effectiveDay",'snapshot',v."snapshot",
    'effectiveSourceRevision',v."sourceRevision",'evidenceVersion',v."evidenceVersion",'amendmentId',v."amendmentId",'amendedAt',import_group_assignment_iso(m."amendedAt"),
    'capturedAssetId',e."assetId",'capturedEffectiveDay',e."effectiveDay",'capturedSourceRevision',h."sourceRevision",
    'capture',jsonb_build_object('batchId',h."batchId",'sourceRevision',h."sourceRevision",'rulesVersion',h."rulesVersion"),
    'assignmentUse',(SELECT jsonb_build_object('itemId',u."itemId",'endpoint',u."endpoint") FROM "ImportAssignmentEvidenceUse" u WHERE u."evidenceId" = e."id"),
    'groupAssignmentUse',NULL,'retirementUse',NULL,'groupRetirementUse',NULL,'groupHistoryLink',NULL)
  FROM "ImportHistoricalEvidence" e JOIN "ImportHistoricalEvidenceCurrent" v USING ("id") JOIN "ImportHistoryCapture" h ON h."id" = e."captureId"
  LEFT JOIN "ImportEvidenceAmendment" m ON m."id" = v."amendmentId" WHERE e."id" = evidence_id;
$$ LANGUAGE sql;

CREATE FUNCTION assert_legacy_correction_period(asset_json JSONB, period JSONB, capture_time TIMESTAMP, ignored_assignment UUID) RETURNS void AS $$
DECLARE side TEXT; e "ImportHistoricalEvidenceCurrent"%ROWTYPE; h "ImportHistoryCapture"%ROWTYPE; issue JSONB;
  sources JSONB := '[]'::jsonb; warnings JSONB := '[]'::jsonb; acknowledged JSONB; endpoint JSONB; fields JSONB; proposed JSONB; start_at TIMESTAMP; end_at TIMESTAMP;
BEGIN
  IF period - ARRAY['periodId','confirmation','start','end','recipient','assignmentType','returnStatus','note','evidenceReference','acknowledgedWarnings','sources','proposedAssignment','warnings','blockers','valid'] <> '{}'::jsonb OR
    (period->'start') - ARRAY['evidenceId','confirmedAt','dateEvidenceReference'] <> '{}'::jsonb OR (period->'end') - ARRAY['evidenceId','confirmedAt','dateEvidenceReference'] <> '{}'::jsonb OR
    (period->'recipient') - ARRAY['type','name'] <> '{}'::jsonb THEN RAISE EXCEPTION 'Legacy correction period shape is strict' USING ERRCODE = '23514'; END IF;
  start_at := (period->'start'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC'; end_at := (period->'end'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC';
  IF period->>'confirmation' IS DISTINCT FROM 'VERIFIED_CLOSED_ASSIGNMENT' OR start_at IS NULL OR end_at IS NULL OR start_at < TIMESTAMP '1900-01-01' OR end_at <= start_at OR end_at > capture_time OR
    (asset_json->>'status' = 'DECOMMISSIONED' AND asset_json->>'decommissionedAt' IS NULL) OR
    (asset_json->>'decommissionedAt' IS NOT NULL AND end_at > (asset_json->>'decommissionedAt')::timestamptz AT TIME ZONE 'UTC') OR
    asset_json->'product'->>'trackingMode' IS DISTINCT FROM 'ASSET' OR coalesce(period->>'assignmentType','') NOT IN ('STANDARD','LOAN') OR
    coalesce(period->>'returnStatus','') NOT IN ('AVAILABLE','UNDER_REVIEW','IN_REPAIR') OR coalesce(period->'recipient'->>'type','') NOT IN ('PERSON','OFFICE') OR
    length(btrim(coalesce(period->'recipient'->>'name',''))) NOT BETWEEN 1 AND 160 OR import_identifier_key(period->'recipient'->>'name') IS NULL OR
    (period->'recipient'->>'type' = 'PERSON' AND (length(period->'recipient'->>'name') > 150 OR period->'recipient'->>'name' !~ '\s+\S+')) OR
    length(btrim(coalesce(period->>'note',''))) NOT BETWEEN 1 AND 2000 OR length(btrim(coalesce(period->>'evidenceReference',''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Legacy correction requires a proven past closed period, recipient and return before retirement' USING ERRCODE = '23514';
  END IF;
  FOREACH side IN ARRAY ARRAY['start','end'] LOOP
    endpoint := period->side;
    SELECT * INTO e FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = (endpoint->>'evidenceId')::uuid;
    SELECT * INTO h FROM "ImportHistoryCapture" WHERE "id" = e."captureId";
    IF e."id" IS NULL OR e."assetId"::text IS DISTINCT FROM asset_json->>'id' OR h."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1' OR e."sourceHash" IS DISTINCT FROM h."sourceHash" OR
      e."capturedAt" > capture_time OR EXISTS (SELECT 1 FROM "ImportEvidenceAmendment" WHERE "id" = e."amendmentId" AND "amendedAt" > capture_time) OR
      coalesce(endpoint->>'confirmedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' OR
      EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" WHERE "evidenceId" = e."id") OR EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "evidenceId" = e."id") OR
      EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = e."id") OR EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication" WHERE "evidenceId" = e."id") OR
      (side = 'start' AND e."kind" NOT IN ('USAGE_OBSERVATION','LOAN_OBSERVATION')) OR (side = 'end' AND e."kind" NOT IN ('RECEIPT_OBSERVATION','USAGE_OBSERVATION')) OR
      (e."effectiveDay" IS NOT NULL AND left(endpoint->>'confirmedAt',10) <> e."effectiveDay") OR
      NOT ((e."snapshot" @> '{"historicalActorId":null,"identityLinkBlocked":false,"affectsCurrentState":false}'::jsonb) IS TRUE) OR
      length(btrim(coalesce(endpoint->>'dateEvidenceReference',''))) NOT BETWEEN 1 AND 500 OR
      (import_identifier_key(e."snapshot"->'effective'->>'serialKey') IS NOT NULL AND e."snapshot"->'effective'->>'serialKey' IS DISTINCT FROM import_identifier_key(asset_json->>'serialNumber')) OR
      (import_identifier_key(e."snapshot"->'effective'->>'tagKey') IS NOT NULL AND e."snapshot"->'effective'->>'tagKey' IS DISTINCT FROM import_identifier_key(asset_json->>'assetTag')) THEN
      RAISE EXCEPTION 'Legacy correction endpoint requires exact linked identity, date and independent proof' USING ERRCODE = '23514';
    END IF;
    PERFORM assert_import_identity_unreserved(e."sourceHash", e."candidateId", e."recordId");
    PERFORM assert_import_group_source_unconsumed(e."sourceHash", e."candidateId", e."recordId");
    fields := e."snapshot"->'effective'->'fields';
    IF side = 'start' AND ((coalesce(import_identifier_key(fields->>'officeText'), import_identifier_key(fields->>'recipientText')) IS NOT NULL AND
      coalesce(import_identifier_key(fields->>'officeText'), import_identifier_key(fields->>'recipientText')) IS DISTINCT FROM import_identifier_key(period->'recipient'->>'name')) OR
      (import_identifier_key(fields->>'officeText') IS NOT NULL AND period->'recipient'->>'type' <> 'OFFICE') OR
      ((e."kind" = 'LOAN_OBSERVATION' OR e."snapshot"->'original'->>'sheet' = 'NB Prestamo' OR import_identifier_key(fields->>'loanDate') IS NOT NULL OR import_identifier_key(fields->>'loanCode') IS NOT NULL) AND period->>'assignmentType' <> 'LOAN')) THEN
      RAISE EXCEPTION 'Legacy correction cannot contradict a reported recipient or loan' USING ERRCODE = '23514';
    END IF;
    sources := sources || jsonb_build_array(jsonb_build_object('endpoint', side, 'evidenceId', e."id", 'captureId', e."captureId", 'batchId', h."batchId", 'sourceHash', e."sourceHash", 'recordId', e."recordId", 'candidateId', e."candidateId", 'kind', e."kind", 'sheet', e."snapshot"->'original'->'sheet', 'row', e."snapshot"->'original'->'row', 'sourceRevision', e."sourceRevision", 'evidenceVersion', e."evidenceVersion", 'amendmentId', e."amendmentId", 'capturedSourceRevision', h."sourceRevision", 'effectiveDay', e."effectiveDay", 'datePrecision', e."snapshot"->'datePrecision', 'fields', fields, 'snapshotDigest', import_group_assignment_digest(e."snapshot")));
    FOR issue IN SELECT value FROM jsonb_array_elements(e."snapshot"->'issues') LOOP
      IF issue->>'severity' = 'BLOCKING' AND issue->>'code' NOT IN ('EXISTING_TERMINAL_STATE_CONFLICT','CROSS_SHEET_STATE_CONFLICT','AVAILABILITY_ASSIGNMENT_CONFLICT') THEN RAISE EXCEPTION 'Legacy correction cannot waive archived blockers' USING ERRCODE = '23514'; END IF;
      IF issue->>'severity' = 'WARNING' OR issue->>'code' IN ('EXISTING_TERMINAL_STATE_CONFLICT','CROSS_SHEET_STATE_CONFLICT','AVAILABILITY_ASSIGNMENT_CONFLICT') THEN
        warnings := warnings || jsonb_build_array(jsonb_build_object('id', import_group_assignment_digest(jsonb_build_object('evidenceId',e."id",'issue',issue)), 'evidenceId', e."id", 'issue', issue, 'contextualOnly', issue->>'code' IN ('EXISTING_TERMINAL_STATE_CONFLICT','CROSS_SHEET_STATE_CONFLICT','AVAILABILITY_ASSIGNMENT_CONFLICT')));
      END IF;
    END LOOP;
  END LOOP;
  IF sources->0->>'sourceHash' = sources->1->>'sourceHash' AND sources->0->>'recordId' = sources->1->>'recordId' THEN RAISE EXCEPTION 'Legacy endpoints must be physically distinct' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'),'[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(warnings) w;
  proposed := jsonb_build_object('assetId', asset_json->'id', 'personId', NULL, 'recipientType', period->'recipient'->'type',
    'personName', CASE WHEN period->'recipient'->>'type' = 'PERSON' THEN period->'recipient'->'name' ELSE 'null'::jsonb END,
    'officeName', CASE WHEN period->'recipient'->>'type' = 'OFFICE' THEN period->'recipient'->'name' ELSE 'null'::jsonb END,
    'assignmentType', period->'assignmentType', 'startedAt', import_group_assignment_iso(start_at), 'endedAt', import_group_assignment_iso(end_at), 'returnStatus', period->'returnStatus', 'assignedById', NULL, 'returnedById', NULL,
    'ticketReference', CASE WHEN import_identifier_key(sources->0->'fields'->>'outgoingTicket') IS NOT NULL THEN sources->0->'fields'->>'outgoingTicket' END,
    'otReference', CASE WHEN import_identifier_key(sources->0->'fields'->>'outgoingOt') IS NOT NULL THEN sources->0->'fields'->>'outgoingOt' END,
    'returnTicketReference', CASE WHEN sources->1->>'kind' = 'RECEIPT_OBSERVATION' AND import_identifier_key(sources->1->'fields'->>'incomingTicket') IS NOT NULL THEN sources->1->'fields'->>'incomingTicket' END,
    'returnOtReference', CASE WHEN sources->1->>'kind' = 'RECEIPT_OBSERVATION' AND import_identifier_key(sources->1->'fields'->>'incomingOt') IS NOT NULL THEN sources->1->'fields'->>'incomingOt' END);
  IF period->'sources' IS DISTINCT FROM sources OR period->'warnings' IS DISTINCT FROM warnings OR period->'acknowledgedWarnings' IS DISTINCT FROM acknowledged OR
    period->'proposedAssignment' IS DISTINCT FROM proposed OR period->'blockers' IS DISTINCT FROM '[]'::jsonb OR period->'valid' IS DISTINCT FROM 'true'::jsonb OR
    EXISTS (SELECT 1 FROM jsonb_each(proposed) p WHERE p.key IN ('ticketReference','otReference','returnTicketReference','returnOtReference') AND length(p.value #>> '{}') > 160) THEN
    RAISE EXCEPTION 'Legacy correction must retain exact source versions, derived references, warnings and proposed values' USING ERRCODE = '23514';
  END IF;
  IF ignored_assignment IS NOT NULL AND EXISTS (SELECT 1 FROM "AssignmentEffective" a WHERE a."assetId"::text = asset_json->>'id' AND a."id" <> ignored_assignment AND start_at < coalesce(a."endedAt", 'infinity'::timestamp) AND end_at > a."startedAt") THEN
    RAISE EXCEPTION 'Legacy correction cannot overlap other effective history or current custody' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_assignment_correction(event "ImportAssignmentCorrection", completed BOOLEAN) RETURNS void AS $$
DECLARE i "ImportAssignmentItem"%ROWTYPE; origin "ImportAssignmentApplication"%ROWTYPE; a "Assignment"%ROWTYPE; asset "Asset"%ROWTYPE; product "Product"%ROWTYPE;
  previous "ImportAssignmentCorrection"%ROWTYPE; actor "User"%ROWTYPE; member RECORD; p JSONB; request JSONB; asset_json JSONB; asset_before JSONB;
  custody JSONB; history JSONB; revisions JSONB; origin_json JSONB; audits JSONB; chain JSONB; before_values JSONB; proposed JSONB; changes JSONB; normalized_revisions JSONB; validation_hash TEXT;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO i FROM "ImportAssignmentItem" WHERE "id" = event."itemId";
  SELECT * INTO origin FROM "ImportAssignmentApplication" WHERE "id" = i."applicationId";
  SELECT * INTO a FROM "Assignment" WHERE "id" = i."assignmentId";
  SELECT * INTO asset FROM "Asset" WHERE "id" = a."assetId";
  SELECT * INTO product FROM "Product" WHERE "id" = asset."productId";
  SELECT * INTO actor FROM "User" WHERE "id" = event."correctedById";
  SELECT * INTO previous FROM "ImportAssignmentCorrection" WHERE "itemId" = i."id" AND "id" <> event."id" ORDER BY "version" DESC LIMIT 1;
  IF i."id" IS NULL OR origin."rulesVersion" IS DISTINCT FROM 'mda-closed-assignment-plan-2' OR origin."assetId" IS DISTINCT FROM a."assetId" OR
    actor."role" IS DISTINCT FROM 'JEFE' OR actor."isActive" IS DISTINCT FROM true OR actor."passwordHash" IS NULL OR
    event."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR event."correctedAt" < date_trunc('milliseconds', transaction_timestamp() AT TIME ZONE 'UTC') OR event."correctedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR event."correctedAt" < origin."appliedAt" OR
    event."version" <> coalesce(previous."version",0) + 1 OR event."previousId" IS DISTINCT FROM previous."id" OR
    (SELECT count(*) FROM "ImportAssignmentCorrection" WHERE "itemId" = i."id" AND "id" <> event."id") <> event."version" - 1 OR
    (previous."id" IS NOT NULL AND event."correctedAt" < previous."correctedAt") OR product."trackingMode" IS DISTINCT FROM 'ASSET' OR
    (SELECT count(*) FROM "Assignment" WHERE "assetId" = asset."id" AND "endedAt" IS NULL) <> (CASE WHEN asset."status" = 'ASSIGNED' THEN 1 ELSE 0 END) OR
    EXISTS (SELECT 1 FROM "Asset" WHERE "id" = asset."id" AND xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text) THEN
    RAISE EXCEPTION 'Legacy correction requires sequential proven origin, unchanged current asset, configured JEFE and its capture transaction' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportRetirementReconciliation" WHERE "assetId" = asset."id" AND "createdTransactionId" = pg_current_xact_id()::text) OR
    EXISTS (SELECT 1 FROM "ImportGroupRetirementDocument" WHERE "assetId" = asset."id" AND "createdTransactionId" = pg_current_xact_id()::text) OR
    EXISTS (SELECT 1 FROM "ImportGroupAssignmentCorrection" c JOIN "ImportGroupAssignmentItem" g ON g."id" = c."itemId" JOIN "Assignment" s ON s."id" = g."assignmentId" WHERE s."assetId" = asset."id" AND c."createdTransactionId" = pg_current_xact_id()::text) THEN RAISE EXCEPTION 'Legacy correction cannot change an already captured documentary context' USING ERRCODE = '23514'; END IF;
  asset_json := to_jsonb(asset) || jsonb_build_object('createdAt', import_group_assignment_iso(asset."createdAt"), 'updatedAt', import_group_assignment_iso(asset."updatedAt"), 'decommissionedAt', import_group_assignment_iso(asset."decommissionedAt"));
  asset_before := jsonb_build_object('id', asset."id", 'productId', asset."productId", 'serialNumber', asset."serialNumber", 'assetTag', asset."assetTag", 'status', asset."status", 'isActive', asset."isActive", 'decommissionedAt', import_group_assignment_iso(asset."decommissionedAt"), 'updatedAt', import_group_assignment_iso(asset."updatedAt"), 'product', jsonb_build_object('id',product."id",'trackingMode',product."trackingMode",'isActive',product."isActive",'updatedAt',import_group_assignment_iso(product."updatedAt")));
  SELECT coalesce(jsonb_agg(legacy_correction_assignment_json(s) ORDER BY s."id"),'[]'::jsonb) INTO custody FROM "Assignment" s WHERE s."assetId" = asset."id" AND s."endedAt" IS NULL;
  IF event."assetSnapshot" IS DISTINCT FROM asset_json OR event."custodySnapshot" IS DISTINCT FROM custody OR event."plan"->'currentAsset' IS DISTINCT FROM asset_json OR event."plan"->'currentCustody' IS DISTINCT FROM custody THEN RAISE EXCEPTION 'Legacy correction cannot mutate asset metadata or custody' USING ERRCODE = '23514'; END IF;
  IF jsonb_array_length(origin."plan"->'periods') NOT BETWEEN 1 AND 25 OR (SELECT count(*) FROM "ImportAssignmentItem" WHERE "applicationId" = origin."id") <> jsonb_array_length(origin."plan"->'periods') OR
    NOT ((origin."plan" @> '{"planRulesVersion":"mda-closed-assignment-plan-2","scope":"CLOSED_ASSIGNMENT_HISTORY_PLAN","mode":"CLOSED_ASSIGNMENT_PLAN","persisted":false,"canApply":false,"affectsCurrentState":false,"planValidationComplete":true}'::jsonb) IS TRUE) OR
    origin."plan"->'assetBefore'->>'id' IS DISTINCT FROM origin."assetId"::text OR origin."plan"->>'planId' IS DISTINCT FROM origin."planId" OR
    origin."plan"->'summary' IS DISTINCT FROM jsonb_build_object('periodCount',jsonb_array_length(origin."plan"->'periods'),'validCount',jsonb_array_length(origin."plan"->'periods'),'blockingCount',0,'warningCount',(SELECT coalesce(sum(jsonb_array_length(warnings_period.value->'warnings')),0) FROM jsonb_array_elements(origin."plan"->'periods') warnings_period(value))) OR
    origin."planId" IS DISTINCT FROM import_group_assignment_digest(origin."plan" - ARRAY['planId','mode','persisted','canApply','affectsCurrentState','planValidationComplete','summary']) THEN RAISE EXCEPTION 'Legacy correction requires complete original plan coverage and digest' USING ERRCODE = '23514'; END IF;
  request := jsonb_build_object('requestId',origin."requestId",'planId',origin."planId",'confirmation','APPLY_CLOSED_ASSIGNMENT_HISTORY','plan', jsonb_build_object('periods',
    (SELECT jsonb_agg(value - ARRAY['sources','proposedAssignment','warnings','blockers','valid'] ORDER BY value->>'periodId') FROM jsonb_array_elements(origin."plan"->'periods'))));
  IF import_group_assignment_digest(request) IS DISTINCT FROM origin."requestDigest" THEN RAISE EXCEPTION 'Legacy origin intent digest cannot be replaced' USING ERRCODE = '23514'; END IF;
  FOR member IN SELECT m.*, legacy_correction_assignment_json(s) AS assignment_json FROM "ImportAssignmentItem" m JOIN "Assignment" s ON s."id" = m."assignmentId" WHERE m."applicationId" = origin."id" LOOP
    SELECT value INTO p FROM jsonb_array_elements(origin."plan"->'periods') WHERE value->>'periodId' = member."periodId"::text;
    IF p IS DISTINCT FROM member."snapshot" OR NOT ((member.assignment_json @> '{"importedHistory":true,"personId":null,"createdById":null,"endedById":null,"expectedReturnAt":null}'::jsonb) IS TRUE) OR
      member.assignment_json->>'createdAt' IS DISTINCT FROM import_group_assignment_iso(origin."appliedAt") OR member.assignment_json->>'returnRecordedAt' IS DISTINCT FROM import_group_assignment_iso(origin."appliedAt") OR
      EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" WHERE "assignmentId" = member."assignmentId") OR
      (SELECT count(*) FROM "ImportAssignmentEvidenceUse" WHERE "itemId" = member."id") <> 2 OR
      NOT EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "itemId" = member."id" AND "endpoint" = 'START' AND "evidenceId" = member."startEvidenceId") OR
      NOT EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "itemId" = member."id" AND "endpoint" = 'END' AND "evidenceId" = member."endEvidenceId") OR
      member.assignment_json->>'notes' IS DISTINCT FROM p->>'note' OR member.assignment_json->>'returnNotes' IS DISTINCT FROM p->>'evidenceReference' OR
      (SELECT jsonb_object_agg(key, member.assignment_json->key) FROM unnest(ARRAY['assetId','personId','recipientType','personName','officeName','assignmentType','startedAt','endedAt','returnStatus','ticketReference','otReference','returnTicketReference','returnOtReference']) key) || '{"assignedById":null,"returnedById":null}'::jsonb IS DISTINCT FROM p->'proposedAssignment' THEN
      RAISE EXCEPTION 'Legacy correction must preserve every original assignment, snapshot and exclusive endpoint' USING ERRCODE = '23514';
    END IF;
    PERFORM assert_legacy_correction_period(origin."plan"->'assetBefore', p, origin."appliedAt", NULL);
    IF (SELECT count(*) FROM "AuditLog" l WHERE l."action" = 'IMPORT_CLOSED_ASSIGNMENT_ADDED' AND l."entityType" = 'Assignment' AND l."entityId" = member."assignmentId"::text AND l."userId" = origin."appliedById" AND l."metadata" = jsonb_build_object('assetId',origin."assetId",'applicationId',origin."id",'periodId',member."periodId",'historicalActorsKnown',false,'affectsCurrentState',false)) <> 1 THEN RAISE EXCEPTION 'Legacy origin assignment audit metadata is inconsistent' USING ERRCODE = '23514'; END IF;
  END LOOP;
  SELECT to_jsonb(origin) || jsonb_build_object('appliedAt',import_group_assignment_iso(origin."appliedAt"),'items',(SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object('assignment',legacy_correction_assignment_json(s) || '{"groupImportHistory":null}'::jsonb,'evidenceUses',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u."endpoint") FROM "ImportAssignmentEvidenceUse" u WHERE u."itemId" = m."id")) ORDER BY m."periodId") FROM "ImportAssignmentItem" m JOIN "Assignment" s ON s."id" = m."assignmentId" WHERE m."applicationId" = origin."id")) INTO origin_json;
  SELECT coalesce(jsonb_agg(jsonb_build_object('action',l."action",'entityType',l."entityType",'entityId',l."entityId",'userId',l."userId",'metadata',l."metadata") ORDER BY (l."entityType" || l."entityId" || l."action" || l."userId"::text) COLLATE "C"),'[]'::jsonb) INTO audits FROM "AuditLog" l WHERE
    (l."action" = 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED' AND l."entityType" = 'ImportAssignmentApplication' AND l."entityId" = origin."id"::text) OR
    (l."action" = 'IMPORT_CLOSED_ASSIGNMENT_ADDED' AND l."entityType" = 'Assignment' AND l."entityId" IN (SELECT "assignmentId"::text FROM "ImportAssignmentItem" WHERE "applicationId" = origin."id"));
  IF jsonb_array_length(audits) <> jsonb_array_length(origin."plan"->'periods') + 1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(audits) l WHERE l->>'userId' IS DISTINCT FROM origin."appliedById"::text) THEN RAISE EXCEPTION 'Legacy correction requires complete origin audits' USING ERRCODE = '23514'; END IF;
  IF (SELECT count(*) FROM "AuditLog" l WHERE l."action" = 'IMPORT_CLOSED_ASSIGNMENTS_APPLIED' AND l."entityType" = 'ImportAssignmentApplication' AND l."entityId" = origin."id"::text AND l."userId" = origin."appliedById" AND l."metadata" = jsonb_build_object('assetId',origin."assetId",'planId',origin."planId",'periodCount',jsonb_array_length(origin."plan"->'periods'),'affectsCurrentState',false)) <> 1 THEN RAISE EXCEPTION 'Legacy root audit metadata is inconsistent' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('correctedAt',import_group_assignment_iso(c."correctedAt")) ORDER BY c."version"),'[]'::jsonb) INTO chain FROM "ImportAssignmentCorrection" c WHERE c."itemId" = i."id" AND c."id" <> event."id";
  before_values := coalesce(previous."plan"->'proposed', i."snapshot"->'proposedAssignment' || jsonb_build_object('note',i."snapshot"->'note','evidenceReference',i."snapshot"->'evidenceReference','startDateEvidenceReference',i."snapshot"->'start'->'dateEvidenceReference','endDateEvidenceReference',i."snapshot"->'end'->'dateEvidenceReference'));
  p := event."plan"->'proposedPeriod'; proposed := p->'proposedAssignment' || jsonb_build_object('note',p->'note','evidenceReference',p->'evidenceReference','startDateEvidenceReference',p->'start'->'dateEvidenceReference','endDateEvidenceReference',p->'end'->'dateEvidenceReference');
  SELECT coalesce(jsonb_agg(jsonb_build_object('field',field,'before',before_values->field,'after',proposed->field) ORDER BY position),'[]'::jsonb) INTO changes FROM unnest(ARRAY['assetId','personId','recipientType','personName','officeName','assignmentType','startedAt','endedAt','returnStatus','assignedById','returnedById','ticketReference','otReference','returnTicketReference','returnOtReference','note','evidenceReference','startDateEvidenceReference','endDateEvidenceReference']) WITH ORDINALITY f(field,position) WHERE before_values->field IS DISTINCT FROM proposed->field;
  history := legacy_correction_history(asset."id",event."id");
  SELECT coalesce(jsonb_agg(jsonb_build_object('batchId',r."batchId",'revision',r."revision",'changes',r."changes") ORDER BY r."batchId",r."revision"),'[]'::jsonb) INTO revisions FROM "ImportSourceRevision" r WHERE r."batchId" IN (SELECT c."batchId" FROM "ImportAssignmentItem" m JOIN "ImportHistoricalEvidence" e ON e."id" IN (m."startEvidenceId",m."endEvidenceId") JOIN "ImportHistoryCapture" c ON c."id" = e."captureId" WHERE m."applicationId" = origin."id");
  SELECT coalesce(jsonb_agg(r || jsonb_build_object('changes',(SELECT jsonb_agg(jsonb_build_object('candidateId',ch->>'candidateId')) FROM jsonb_array_elements(r->'changes') ch))),'[]'::jsonb) INTO normalized_revisions FROM jsonb_array_elements(revisions) r;
  validation_hash := import_group_assignment_digest(jsonb_build_object('planRulesVersion','mda-closed-assignment-plan-2','scope','CLOSED_ASSIGNMENT_HISTORY_PLAN','checkedAsOf',event."plan"->'checkedAsOf','assetBefore',asset_before,
    'currentAssignmentsDigest',import_group_assignment_digest((SELECT coalesce(jsonb_agg(s ORDER BY s->>'id'),'[]'::jsonb) FROM jsonb_array_elements(history) s WHERE s->>'id' <> a."id"::text)),
    'sourceRevisionsDigest',import_group_assignment_digest(normalized_revisions),'periods',jsonb_build_array(p)));
  IF NOT ((event."plan" @> '{"rulesVersion":"mda-legacy-assignment-correction-plan-1","scope":"LEGACY_CLOSED_ASSIGNMENT_CORRECTION_PLAN","mode":"CORRECTION_REVIEW_ONLY","canApply":false,"persisted":false,"affectsCurrentState":false,"evidenceRelinked":false,"operationalHistoryApplied":false,"correctionApplicationImplemented":false,"planValidationComplete":true,"blockers":[]}'::jsonb) IS TRUE) OR
    event."plan"->>'correctionPlanId' IS DISTINCT FROM event."correctionPlanId" OR event."correctionPlanId" IS DISTINCT FROM import_group_assignment_digest(event."plan" - ARRAY['correctionPlanId','mode','persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','correctionApplicationImplemented','planValidationComplete']) OR
    event."plan"->>'originReceiptDigest' IS DISTINCT FROM import_group_assignment_digest(origin_json) OR event."plan"->>'originAuditDigest' IS DISTINCT FROM import_group_assignment_digest(audits) OR event."plan"->>'correctionChainDigest' IS DISTINCT FROM import_group_assignment_digest(chain) OR
    event."plan"->>'currentCorrectionVersion' IS DISTINCT FROM (event."version" - 1)::text OR event."plan"->>'currentCorrectionId' IS DISTINCT FROM event."previousId"::text OR
    event."plan"->>'assetId' IS DISTINCT FROM asset."id"::text OR event."plan"->>'applicationId' IS DISTINCT FROM origin."id"::text OR event."plan"->>'assignmentItemId' IS DISTINCT FROM i."id"::text OR event."plan"->>'assignmentId' IS DISTINCT FROM a."id"::text OR event."plan"->>'originPlanId' IS DISTINCT FROM origin."planId" OR
    event."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(event."correctedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago','YYYY-MM-DD') OR event."plan"->>'timeZone' IS DISTINCT FROM 'America/Santiago' OR
    event."plan"->>'reason' IS DISTINCT FROM event."reason" OR event."plan"->>'supportingReference' IS DISTINCT FROM event."supportingReference" OR
    event."plan"->'before' IS DISTINCT FROM before_values OR event."plan"->'proposed' IS DISTINCT FROM proposed OR changes = '[]'::jsonb OR event."plan"->'changes' IS DISTINCT FROM changes OR
    event."plan"->'originalPeriod' IS DISTINCT FROM i."snapshot" OR event."plan"->'originalAssignment' IS DISTINCT FROM legacy_correction_assignment_json(a) || '{"groupImportHistory":null}'::jsonb OR
    event."plan"->'ownership' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(u) ORDER BY u."endpoint") FROM "ImportAssignmentEvidenceUse" u WHERE u."itemId" = i."id") OR
    p->>'periodId' IS DISTINCT FROM i."periodId"::text OR p->'start'->>'evidenceId' IS DISTINCT FROM i."startEvidenceId"::text OR p->'end'->>'evidenceId' IS DISTINCT FROM i."endEvidenceId"::text OR
    event."plan"->'sources' IS DISTINCT FROM p->'sources' OR event."plan"->'warnings' IS DISTINCT FROM p->'warnings' OR event."plan"->'acknowledgedWarnings' IS DISTINCT FROM p->'acknowledgedWarnings' OR
    event."plan"->>'validationContextPlanId' IS DISTINCT FROM validation_hash OR event."plan"->'currentEvidence' IS DISTINCT FROM (SELECT jsonb_agg(legacy_correction_evidence_json(e."id") ORDER BY e."id") FROM "ImportHistoricalEvidence" e WHERE e."id" IN (i."startEvidenceId",i."endEvidenceId")) OR
    event."plan"->>'currentContextDigest' IS DISTINCT FROM import_group_assignment_digest(jsonb_build_object('currentAsset',asset_json,'asset',asset_before,'custody',custody,'assignments',history,'revisions',revisions)) THEN
    RAISE EXCEPTION 'Legacy correction must match its exact reviewed origin, chain, proposal and current context' USING ERRCODE = '23514';
  END IF;
  request := jsonb_build_object('requestId',event."requestId",'correctionPlanId',event."correctionPlanId",'confirmation','APPLY_LEGACY_ASSIGNMENT_CORRECTION','plan',event."plan"->'request');
  IF import_group_assignment_digest(request) IS DISTINCT FROM event."requestDigest" OR event."plan"->'request' IS DISTINCT FROM jsonb_build_object('expectedOriginPlanId',origin."planId",'expectedCorrectionVersion',event."version" - 1,'reason',event."reason",'supportingReference',event."supportingReference",'correction', p - ARRAY['periodId','confirmation','sources','proposedAssignment','warnings','blockers','valid','start','end'] || jsonb_build_object('start',(p->'start') - 'evidenceId','end',(p->'end') - 'evidenceId')) THEN RAISE EXCEPTION 'Legacy correction requires exact confirmed intent' USING ERRCODE = '23514'; END IF;
  PERFORM assert_legacy_correction_period(asset_before,p,event."correctedAt",a."id");
  IF EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") ch WHERE r."batchId" IN (SELECT (s->>'batchId')::uuid FROM jsonb_array_elements(p->'sources') s) AND EXISTS (SELECT 1 FROM jsonb_array_elements(p->'sources') s WHERE s->>'candidateId' = ch->>'candidateId' AND s->>'batchId' = r."batchId"::text AND r."revision" > (s->>'sourceRevision')::integer)) THEN RAISE EXCEPTION 'Legacy correction source was revised' USING ERRCODE = '23514'; END IF;
  IF completed AND NOT EXISTS (SELECT 1 FROM "AuditLog" l WHERE l."action" = 'IMPORT_LEGACY_ASSIGNMENT_CORRECTED' AND l."entityType" = 'ImportAssignmentCorrection' AND l."entityId" = event."id"::text AND l."userId" = event."correctedById" AND l.xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::bigint::text AND
    l."metadata" = jsonb_build_object('assetId',asset."id",'applicationId',origin."id",'assignmentItemId',i."id",'assignmentId',a."id",'version',event."version",'previousId',event."previousId",'affectsCurrentState',false)) THEN RAISE EXCEPTION 'Legacy correction and exact audit must commit atomically' USING ERRCODE = '23514'; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_assignment_correction() RETURNS trigger AS $$
DECLARE hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Legacy correction receipts are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  FOR hash IN SELECT DISTINCT e."sourceHash" FROM "ImportAssignmentItem" i JOIN "ImportHistoricalEvidence" e ON e."id" IN (i."startEvidenceId",i."endEvidenceId") WHERE i."applicationId" = (SELECT "applicationId" FROM "ImportAssignmentItem" WHERE "id" = NEW."itemId") ORDER BY e."sourceHash" LOOP PERFORM pg_advisory_xact_lock(hashtextextended(hash,0)); END LOOP;
  LOCK TABLE "Asset", "Product", "Assignment", "User", "AuditLog", "ImportAssignmentApplication", "ImportAssignmentItem", "ImportAssignmentEvidenceUse", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportSourceRevision", "ImportAssignmentCorrection", "ImportGroupAssignmentCorrection", "ImportIdentityGroupRow", "ImportIdentityGroupRelease" IN EXCLUSIVE MODE NOWAIT;
  PERFORM assert_import_assignment_correction(NEW,false); RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentCorrection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportAssignmentCorrection" FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_correction();
CREATE TRIGGER "ImportAssignmentCorrection_truncate_guard" BEFORE TRUNCATE ON "ImportAssignmentCorrection" FOR EACH STATEMENT EXECUTE FUNCTION guard_import_assignment_correction();
CREATE FUNCTION complete_import_assignment_correction() RETURNS trigger AS $$
BEGIN PERFORM assert_import_assignment_correction(NEW,true); RETURN NULL; END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportAssignmentCorrection_complete" AFTER INSERT ON "ImportAssignmentCorrection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_import_assignment_correction();

CREATE FUNCTION guard_legacy_correction_context() RETURNS trigger AS $$
DECLARE old_json JSONB; new_json JSONB; c RECORD;
BEGIN
  old_json := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END; new_json := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  FOR c IN SELECT e.*, a."assetId", a."id" AS assignment_id, a."productId" AS product_id FROM "ImportAssignmentCorrection" e JOIN "ImportAssignmentItem" i ON i."id" = e."itemId" JOIN (SELECT s."id",s."assetId",p."productId" FROM "Assignment" s JOIN "Asset" p ON p."id" = s."assetId") a ON a."id" = i."assignmentId" WHERE e."createdTransactionId" = pg_current_xact_id()::text LOOP
    IF (TG_TABLE_NAME = 'Asset' AND c."assetId"::text IN (old_json->>'id',new_json->>'id')) OR
      (TG_TABLE_NAME IN ('Assignment','InventoryMovement') AND c."assetId"::text IN (old_json->>'assetId',new_json->>'assetId')) OR
      (TG_TABLE_NAME IN ('Product','InventoryStock') AND c.product_id::text IN (old_json->>'id',new_json->>'id',old_json->>'productId',new_json->>'productId')) OR
      (TG_TABLE_NAME = 'User' AND c."correctedById"::text IN (old_json->>'id',new_json->>'id')) OR
      TG_TABLE_NAME IN ('ImportEvidenceAmendment','ImportSourceRevision','ImportHistoryCapture','ImportHistoricalEvidence','ImportGroupAssignmentCorrection','ImportAssignmentCorrection','ImportRetirementReconciliation','ImportGroupRetirementDocument','ImportIdentityGroupReview','ImportIdentityGroupRow','ImportIdentityGroupRelease','ImportIdentityGroupDecision') OR
      (TG_TABLE_NAME = 'AuditLog' AND new_json->>'entityType' IN ('Assignment','ImportAssignmentApplication')) THEN
      RAISE EXCEPTION 'Legacy correction context cannot change in its capture transaction, even after early constraints' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_legacy_correction_context" BEFORE UPDATE OR DELETE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "Assignment_legacy_correction_context" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "Product_legacy_correction_context" BEFORE UPDATE OR DELETE ON "Product" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "User_legacy_correction_context" BEFORE UPDATE OR DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "InventoryStock_legacy_correction_context" BEFORE INSERT OR UPDATE OR DELETE ON "InventoryStock" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "InventoryMovement_legacy_correction_context" BEFORE INSERT OR UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportEvidenceAmendment_legacy_correction_context" BEFORE INSERT ON "ImportEvidenceAmendment" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportSourceRevision_legacy_correction_context" BEFORE INSERT ON "ImportSourceRevision" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportHistoryCapture_legacy_correction_context" BEFORE INSERT ON "ImportHistoryCapture" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportHistoricalEvidence_legacy_correction_context" BEFORE INSERT ON "ImportHistoricalEvidence" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportGroupAssignmentCorrection_legacy_correction_context" BEFORE INSERT ON "ImportGroupAssignmentCorrection" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportAssignmentCorrection_context" BEFORE INSERT ON "ImportAssignmentCorrection" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportRetirementReconciliation_legacy_correction_context" BEFORE INSERT ON "ImportRetirementReconciliation" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportGroupRetirementDocument_legacy_correction_context" BEFORE INSERT ON "ImportGroupRetirementDocument" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportIdentityGroupReview_legacy_correction_context" BEFORE INSERT ON "ImportIdentityGroupReview" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportIdentityGroupRow_legacy_correction_context" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupRow" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportIdentityGroupRelease_legacy_correction_context" BEFORE INSERT ON "ImportIdentityGroupRelease" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "ImportIdentityGroupDecision_legacy_correction_context" BEFORE INSERT ON "ImportIdentityGroupDecision" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();
CREATE TRIGGER "AuditLog_legacy_correction_context" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_context();

CREATE FUNCTION guard_legacy_correction_audit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "ImportAssignmentCorrection") THEN RAISE EXCEPTION 'Legacy correction audits are immutable' USING ERRCODE = '23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM "ImportAssignmentCorrection" c JOIN "ImportAssignmentItem" i ON i."id" = c."itemId" WHERE (OLD."entityType" = 'ImportAssignmentCorrection' AND OLD."entityId" = c."id"::text) OR
    (OLD."entityType" = 'ImportAssignmentApplication' AND OLD."entityId" = i."applicationId"::text) OR (OLD."entityType" = 'Assignment' AND OLD."entityId" IN (SELECT "assignmentId"::text FROM "ImportAssignmentItem" WHERE "applicationId" = i."applicationId"))) THEN
    RAISE EXCEPTION 'Legacy correction and origin audits are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_legacy_correction_guard" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_legacy_correction_audit();
CREATE TRIGGER "AuditLog_legacy_correction_truncate_guard" BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION guard_legacy_correction_audit();

CREATE OR REPLACE VIEW "AssignmentEffective" AS
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
LEFT JOIN "ImportAssignmentItem" l ON l."assignmentId" = a."id"
LEFT JOIN LATERAL (SELECT * FROM (SELECT "id", "version", "plan", "correctedById", "correctedAt" FROM "ImportGroupAssignmentCorrection" WHERE "itemId" = i."id"
UNION ALL SELECT "id", "version", "plan", "correctedById", "correctedAt" FROM "ImportAssignmentCorrection" WHERE "itemId" = l."id") versions ORDER BY "version" DESC LIMIT 1) c ON true;

COMMIT;
