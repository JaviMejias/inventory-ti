BEGIN;

CREATE TABLE "ImportGroupAssignmentApplication" (
  "id" UUID PRIMARY KEY,
  "itemId" UUID NOT NULL REFERENCES "ImportIdentityGroupApplicationItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL DEFAULT 'mda-group-closed-assignment-application-1'
    CHECK ("rulesVersion" = 'mda-group-closed-assignment-application-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "assetSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("assetSnapshot") = 'object'),
  "custodySnapshot" JSONB NOT NULL CHECK (jsonb_typeof("custodySnapshot") = 'array'),
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" VARCHAR(20) NOT NULL DEFAULT (pg_current_xact_id())::text
);
CREATE UNIQUE INDEX "ImportGroupAssignmentApplication_planId_key" ON "ImportGroupAssignmentApplication"("planId");
CREATE UNIQUE INDEX "ImportGroupAssignmentApplication_itemId_requestId_key" ON "ImportGroupAssignmentApplication"("itemId", "requestId");
CREATE INDEX "ImportGroupAssignmentApplication_itemId_appliedAt_id_idx" ON "ImportGroupAssignmentApplication"("itemId", "appliedAt", "id");
CREATE INDEX "ImportGroupAssignmentApplication_assetId_idx" ON "ImportGroupAssignmentApplication"("assetId");
CREATE INDEX "ImportGroupAssignmentApplication_createdTransactionId_assetId_idx" ON "ImportGroupAssignmentApplication"("createdTransactionId", "assetId");

CREATE TABLE "ImportGroupAssignmentItem" (
  "id" UUID PRIMARY KEY,
  "applicationId" UUID NOT NULL REFERENCES "ImportGroupAssignmentApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "periodId" UUID NOT NULL,
  "assignmentId" UUID NOT NULL REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "startLinkId" UUID NOT NULL REFERENCES "ImportGroupHistoryLink"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "endLinkId" UUID NOT NULL REFERENCES "ImportGroupHistoryLink"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object'),
  CHECK ("startLinkId" <> "endLinkId")
);
CREATE UNIQUE INDEX "ImportGroupAssignmentItem_assignmentId_key" ON "ImportGroupAssignmentItem"("assignmentId");
CREATE UNIQUE INDEX "ImportGroupAssignmentItem_applicationId_periodId_key" ON "ImportGroupAssignmentItem"("applicationId", "periodId");
CREATE INDEX "ImportGroupAssignmentItem_startLinkId_idx" ON "ImportGroupAssignmentItem"("startLinkId");
CREATE INDEX "ImportGroupAssignmentItem_endLinkId_idx" ON "ImportGroupAssignmentItem"("endLinkId");

CREATE TABLE "ImportGroupAssignmentEvidenceUse" (
  "evidenceId" UUID PRIMARY KEY REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "linkId" UUID NOT NULL REFERENCES "ImportGroupHistoryLink"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "itemId" UUID NOT NULL REFERENCES "ImportGroupAssignmentItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "endpoint" VARCHAR(5) NOT NULL CHECK ("endpoint" IN ('START', 'END'))
);
CREATE UNIQUE INDEX "ImportGroupAssignmentEvidenceUse_linkId_key" ON "ImportGroupAssignmentEvidenceUse"("linkId");
CREATE UNIQUE INDEX "ImportGroupAssignmentEvidenceUse_itemId_endpoint_key" ON "ImportGroupAssignmentEvidenceUse"("itemId", "endpoint");

-- Match importPlanDigest's recursive key ordering without adding an extension.
CREATE FUNCTION import_group_assignment_canonical(value JSONB) RETURNS TEXT AS $$
DECLARE result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(e.key)::text || ':' || import_group_assignment_canonical(e.value), ',' ORDER BY e.key COLLATE "C"), '') || '}'
        INTO result FROM jsonb_each(value) e;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(import_group_assignment_canonical(e.value), ',' ORDER BY e.ordinality), '') || ']'
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e;
    ELSE result := value::text;
  END CASE;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION import_group_assignment_digest(value JSONB) RETURNS TEXT AS $$
  SELECT encode(sha256(convert_to(import_group_assignment_canonical(value), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION import_group_assignment_iso(value TIMESTAMP) RETURNS TEXT AS $$
  SELECT to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION import_group_assignment_reference(value TEXT) RETURNS TEXT AS $$
BEGIN
  IF import_identifier_key(value) IS NULL THEN RETURN NULL; END IF;
  IF length(value) > 160 THEN RAISE EXCEPTION 'Group assignment source reference exceeds 160 characters' USING ERRCODE = '23514'; END IF;
  RETURN value;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION assert_import_group_assignment_isolation() RETURNS void AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Group assignment writes require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_group_assignment_context(receipt "ImportGroupAssignmentApplication") RETURNS void AS $$
DECLARE
  item "ImportIdentityGroupApplicationItem"%ROWTYPE;
  parent "ImportIdentityGroupApplication"%ROWTYPE;
  current_asset "Asset"%ROWTYPE;
  product "Product"%ROWTYPE;
  actor "User"%ROWTYPE;
  source_rows JSONB;
  parent_proof JSONB;
  expected_asset JSONB;
  current_custody JSONB;
  assignment_context JSONB;
  revision_context JSONB;
  history_proofs JSONB;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = receipt."itemId";
  SELECT * INTO parent FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = receipt."assetId";
  SELECT * INTO product FROM "Product" WHERE "id" = current_asset."productId";
  SELECT * INTO actor FROM "User" WHERE "id" = receipt."appliedById";
  IF item."id" IS NULL OR parent."id" IS NULL OR current_asset."id" IS NULL OR item."assetId" IS DISTINCT FROM receipt."assetId"
    OR actor."role" IS DISTINCT FROM 'JEFE' OR actor."isActive" IS DISTINCT FROM true OR actor."passwordHash" IS NULL
    OR product."trackingMode" IS DISTINCT FROM 'ASSET' OR item."result"->>'id' IS DISTINCT FROM receipt."assetId"::text
    OR item."result"->>'productId' IS DISTINCT FROM current_asset."productId"::text
    OR import_identifier_key(item."result"->>'serialNumber') IS DISTINCT FROM import_identifier_key(current_asset."serialNumber")
    OR import_identifier_key(item."result"->>'assetTag') IS DISTINCT FROM import_identifier_key(current_asset."assetTag")
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(parent."plan"->'operations') op WHERE op = item."operation")
    OR item."operation"->>'groupId' IS DISTINCT FROM item."groupId"::text
    OR item."operation"->>'groupKey' IS DISTINCT FROM item."groupKey"
    OR item."operation"->>'decisionId' IS DISTINCT FROM item."decisionId"::text
    OR receipt."appliedAt" < parent."appliedAt" OR receipt."appliedAt" > clock_timestamp() AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Group assignments require exact applied identity, physical product and active configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF item."operation"->>'type' = 'CREATE_ASSET' THEN
    IF item."result"->>'productId' IS DISTINCT FROM item."operation"->'values'->>'productId'
      OR import_identifier_key(item."result"->>'serialNumber') IS DISTINCT FROM import_identifier_key(item."operation"->'values'->>'serialNumber')
      OR import_identifier_key(item."result"->>'assetTag') IS DISTINCT FROM import_identifier_key(item."operation"->'values'->>'assetTag') THEN
      RAISE EXCEPTION 'Group result must retain its original created identity' USING ERRCODE = '23514';
    END IF;
  ELSIF item."operation"->>'type' = 'UPDATE_METADATA' THEN
    IF item."result"->>'id' IS DISTINCT FROM item."operation"->'before'->>'id'
      OR item."result"->>'productId' IS DISTINCT FROM item."operation"->'before'->>'productId'
      OR import_identifier_key(item."result"->>'serialNumber') IS DISTINCT FROM import_identifier_key(item."operation"->'before'->>'serialNumber')
      OR import_identifier_key(item."result"->>'assetTag') IS DISTINCT FROM import_identifier_key(item."operation"->'before'->>'assetTag') THEN
      RAISE EXCEPTION 'Group metadata result must retain its original physical identity' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'Unsupported applied group operation' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u."recordId"), '[]'::jsonb) INTO source_rows FROM "ImportIdentityGroupRowUse" u WHERE u."itemId" = item."id";
  IF jsonb_typeof(item."operation"->'source') IS DISTINCT FROM 'array'
    OR jsonb_array_length(item."operation"->'source') NOT BETWEEN 1 AND 25
    OR jsonb_array_length(source_rows) <> jsonb_array_length(item."operation"->'source')
    OR (SELECT count(DISTINCT r->>'recordId') FROM jsonb_array_elements(item."operation"->'source') r) <> jsonb_array_length(source_rows)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(item."operation"->'source') r WHERE NOT EXISTS (
      SELECT 1 FROM "ImportIdentityGroupRowUse" u JOIN "ImportIdentityGroupRow" g ON g."reviewId" = u."reviewId" AND g."recordId" = u."recordId"
      WHERE u."itemId" = item."id" AND u."sourceHash" = parent."sourceHash" AND u."reviewId" = parent."reviewId"
        AND u."recordId" = r->>'recordId' AND u."originalCandidateId" = r->>'originalCandidateId' AND g."groupId" = item."groupId"
        AND g."snapshot"->>'sheet' = r->>'sheet' AND g."snapshot"->>'row' = r->>'row')) THEN
    RAISE EXCEPTION 'Group assignment requires complete permanent physical source consumption' USING ERRCODE = '23514';
  END IF;
  SELECT to_jsonb(parent) || jsonb_build_object('appliedAt', import_group_assignment_iso(parent."appliedAt"), 'items',
    (SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('rows',
      (SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u."recordId"), '[]'::jsonb) FROM "ImportIdentityGroupRowUse" u WHERE u."itemId" = i."id")) ORDER BY i."groupKey")
      FROM "ImportIdentityGroupApplicationItem" i WHERE i."applicationId" = parent."id")) INTO parent_proof;
  expected_asset := jsonb_build_object('id', current_asset."id", 'productId', current_asset."productId", 'serialNumber', current_asset."serialNumber",
    'assetTag', current_asset."assetTag", 'status', current_asset."status", 'isActive', current_asset."isActive",
    'decommissionedAt', import_group_assignment_iso(current_asset."decommissionedAt"), 'updatedAt', import_group_assignment_iso(current_asset."updatedAt"),
    'product', jsonb_build_object('id', product."id", 'trackingMode', product."trackingMode", 'isActive', product."isActive", 'updatedAt', import_group_assignment_iso(product."updatedAt")));
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a."id"), '[]'::jsonb) INTO current_custody FROM "Assignment" a WHERE a."assetId" = receipt."assetId" AND a."endedAt" IS NULL;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a."id", 'startedAt', import_group_assignment_iso(a."startedAt"), 'endedAt', import_group_assignment_iso(a."endedAt"),
    'recipientType', a."recipientType", 'personName', a."personName", 'officeName', a."officeName", 'assignmentType', a."assignmentType", 'returnStatus', a."returnStatus") ORDER BY a."id"), '[]'::jsonb)
    INTO assignment_context FROM "Assignment" a WHERE a."assetId" = receipt."assetId"
    AND NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" i WHERE i."applicationId" = receipt."id" AND i."assignmentId" = a."id");
  SELECT coalesce(jsonb_agg(jsonb_build_object('batchId', r."batchId", 'revision', r."revision", 'changes',
      (SELECT jsonb_agg(jsonb_build_object('candidateId', c.value->'candidateId') ORDER BY c.ordinality)
        FROM jsonb_array_elements(r."changes") WITH ORDINALITY c)) ORDER BY r."batchId", r."revision"), '[]'::jsonb)
    INTO revision_context FROM "ImportSourceRevision" r WHERE r."batchId" IN (
      SELECT c."batchId" FROM "ImportHistoryCapture" c JOIN "ImportHistoricalEvidence" e ON e."captureId" = c."id"
      JOIN "ImportIdentityGroupRowUse" u ON u."sourceHash" = e."sourceHash" AND u."recordId" = e."recordId" WHERE u."itemId" = item."id");
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', h."id", 'planId', h."planId", 'requestDigest', h."requestDigest", 'appliedById', h."appliedById", 'appliedAt', import_group_assignment_iso(h."appliedAt")) ORDER BY h."id"), '[]'::jsonb)
    INTO history_proofs FROM "ImportGroupHistoryApplication" h WHERE h."itemId" = item."id";
  IF NOT ((receipt."plan" @> '{"scope":"GROUP_CLOSED_ASSIGNMENT_HISTORY_PLAN","rulesVersion":"mda-group-closed-assignment-plan-1","planValidationComplete":true,"persisted":false,"canApply":false,"affectsCurrentState":false,"evidenceRelinked":false,"operationalHistoryApplied":false,"closedAssignmentApplicationImplemented":false}'::jsonb
      AND jsonb_typeof(receipt."plan"->'periods') = 'array' AND jsonb_array_length(receipt."plan"->'periods') BETWEEN 1 AND 25
      AND jsonb_typeof(receipt."plan"->'historyLinks') = 'array'
      AND jsonb_array_length(receipt."plan"->'historyLinks') = 2 * jsonb_array_length(receipt."plan"->'periods')) IS TRUE)
    OR receipt."plan"->>'planId' IS DISTINCT FROM receipt."planId"
    OR receipt."planId" IS DISTINCT FROM import_group_assignment_digest(receipt."plan" - ARRAY['planId','persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','closedAssignmentApplicationImplemented','planValidationComplete','summary'])
    OR receipt."plan"->>'itemId' IS DISTINCT FROM item."id"::text OR receipt."plan"->>'groupId' IS DISTINCT FROM item."groupId"::text
    OR receipt."plan"->>'groupKey' IS DISTINCT FROM item."groupKey" OR receipt."plan"->>'sourceHash' IS DISTINCT FROM parent."sourceHash"
    OR receipt."plan"->>'batchId' IS DISTINCT FROM parent."batchId"::text OR receipt."plan"->>'reviewId' IS DISTINCT FROM parent."reviewId"::text
    OR receipt."plan"->>'applicationId' IS DISTINCT FROM parent."id"::text OR receipt."plan"->>'applicationPlanId' IS DISTINCT FROM parent."planId"
    OR receipt."plan"->'sourceRows' IS DISTINCT FROM source_rows OR receipt."plan"->>'applicationProofDigest' IS DISTINCT FROM import_group_assignment_digest(parent_proof)
    OR receipt."plan"->'assetBefore' IS DISTINCT FROM expected_asset OR receipt."assetSnapshot" IS DISTINCT FROM to_jsonb(current_asset)
    OR receipt."custodySnapshot" IS DISTINCT FROM current_custody
    OR receipt."plan"->>'currentAssignmentsDigest' IS DISTINCT FROM import_group_assignment_digest(assignment_context)
    OR receipt."plan"->>'sourceRevisionsDigest' IS DISTINCT FROM import_group_assignment_digest(revision_context)
    OR receipt."plan"->'historyReceiptProofs' IS DISTINCT FROM history_proofs
    OR receipt."plan"->>'timeZone' IS DISTINCT FROM 'America/Santiago'
    OR receipt."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD')
    OR jsonb_array_length(current_custody) <> (CASE WHEN current_asset."status" = 'ASSIGNED' THEN 1 ELSE 0 END)
    OR (current_asset."status" = 'DECOMMISSIONED' AND current_asset."decommissionedAt" IS NULL)
    OR (SELECT count(DISTINCT p->>'periodId') FROM jsonb_array_elements(receipt."plan"->'periods') p) <> jsonb_array_length(receipt."plan"->'periods')
    OR (SELECT count(DISTINCT l->>'id') FROM jsonb_array_elements(receipt."plan"->'historyLinks') l) <> jsonb_array_length(receipt."plan"->'historyLinks')
    OR (SELECT count(DISTINCT l->>'evidenceId') FROM jsonb_array_elements(receipt."plan"->'historyLinks') l) <> jsonb_array_length(receipt."plan"->'historyLinks') THEN
    RAISE EXCEPTION 'Group assignment plan, full asset, open custody and saved context must match exactly' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_group_assignment_period(receipt "ImportGroupAssignmentApplication", period JSONB, ignored_assignment_id UUID DEFAULT NULL) RETURNS void AS $$
DECLARE
  item "ImportIdentityGroupApplicationItem"%ROWTYPE;
  parent "ImportIdentityGroupApplication"%ROWTYPE;
  link "ImportGroupHistoryLink"%ROWTYPE;
  history "ImportGroupHistoryApplication"%ROWTYPE;
  evidence "ImportHistoricalEvidence"%ROWTYPE;
  current_evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE;
  capture "ImportHistoryCapture"%ROWTYPE;
  side TEXT;
  source JSONB;
  physical JSONB;
  projection JSONB;
  expected_source JSONB;
  selected_link JSONB;
  snapshot JSONB;
  issue JSONB;
  warnings JSONB := '[]'::jsonb;
  acknowledged JSONB;
  contextual BOOLEAN;
  confirmed TIMESTAMP;
  start_at TIMESTAMP;
  end_at TIMESTAMP;
  start_fields JSONB;
  end_fields JSONB;
  start_kind TEXT;
  end_kind TEXT;
  start_sheet TEXT;
  start_record TEXT;
  expected_proposal JSONB;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  IF NOT ((period @> '{"valid":true,"confirmation":"VERIFIED_CLOSED_ASSIGNMENT","blockers":[]}'::jsonb
    AND period->'blockers' = '[]'::jsonb AND jsonb_typeof(period->'sources') = 'array' AND jsonb_array_length(period->'sources') = 2
    AND jsonb_typeof(period->'warnings') = 'array' AND jsonb_typeof(period->'acknowledgedWarnings') = 'array') IS TRUE)
    OR length(btrim(coalesce(period->>'note', ''))) NOT BETWEEN 1 AND 2000
    OR length(btrim(coalesce(period->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500
    OR coalesce(period->>'assignmentType', '') NOT IN ('STANDARD', 'LOAN')
    OR coalesce(period->>'returnStatus', '') NOT IN ('AVAILABLE', 'UNDER_REVIEW', 'IN_REPAIR')
    OR coalesce(period->'recipient'->>'type', '') NOT IN ('PERSON', 'OFFICE')
    OR import_identifier_key(period->'recipient'->>'name') IS NULL
    OR length(period->'recipient'->>'name') > (CASE WHEN period->'recipient'->>'type' = 'PERSON' THEN 150 ELSE 160 END)
    OR (period->'recipient'->>'type' = 'PERSON' AND period->'recipient'->>'name' !~ '\s+\S+')
    OR (SELECT count(DISTINCT s->>'endpoint') FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' IN ('start', 'end')) <> 2 THEN
    RAISE EXCEPTION 'Group period requires a complete confirmed closed proposal' USING ERRCODE = '23514';
  END IF;
  PERFORM (period->>'periodId')::uuid;
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = receipt."itemId";
  SELECT * INTO parent FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  FOREACH side IN ARRAY ARRAY['start', 'end'] LOOP
    SELECT s INTO source FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' = side;
    SELECT * INTO link FROM "ImportGroupHistoryLink" WHERE "id"::text = source->>'groupHistoryLinkId';
    SELECT * INTO history FROM "ImportGroupHistoryApplication" WHERE "id" = link."historyApplicationId";
    SELECT * INTO evidence FROM "ImportHistoricalEvidence" WHERE "id" = link."evidenceId";
    SELECT * INTO current_evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = link."evidenceId";
    SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
    SELECT r INTO physical FROM jsonb_array_elements(item."operation"->'source') r WHERE r->>'recordId' = evidence."recordId";
    IF link."id" IS NULL OR history."itemId" IS DISTINCT FROM receipt."itemId" OR link."assetId" IS DISTINCT FROM receipt."assetId" OR link."version" <> 1
      OR evidence."id" IS NULL OR current_evidence."id" IS NULL OR physical IS NULL
      OR evidence."sourceHash" IS DISTINCT FROM parent."sourceHash" OR capture."sourceHash" IS DISTINCT FROM parent."sourceHash"
      OR capture."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1'
      OR physical->>'originalCandidateId' IS DISTINCT FROM evidence."candidateId"
      OR (current_evidence."assetId" IS NOT NULL AND current_evidence."assetId" <> receipt."assetId")
      OR link."evidenceVersion" IS DISTINCT FROM current_evidence."evidenceVersion" OR link."amendmentId" IS DISTINCT FROM current_evidence."amendmentId"
      OR link."sourceRevision" IS DISTINCT FROM current_evidence."sourceRevision" OR link."sourceRevision" < capture."sourceRevision"
      OR (link."evidenceVersion" = 0) IS DISTINCT FROM (link."amendmentId" IS NULL)
      OR period->side->>'evidenceId' IS DISTINCT FROM evidence."id"::text
      OR history."plan"->>'historyLinkPlanId' IS DISTINCT FROM history."planId"
      OR history."plan"->>'applicationId' IS DISTINCT FROM parent."id"::text
      OR history."plan"->>'applicationPlanId' IS DISTINCT FROM parent."planId"
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history."plan"->'operations') op WHERE op = link."operation")
      OR link."operation"->'originalSnapshot' IS DISTINCT FROM evidence."snapshot" OR link."operation"->'currentSnapshot' IS DISTINCT FROM current_evidence."snapshot"
      OR link."operation"->>'evidenceId' IS DISTINCT FROM evidence."id"::text
      OR link."operation"->>'captureId' IS DISTINCT FROM capture."id"::text OR link."operation"->>'captureBatchId' IS DISTINCT FROM capture."batchId"::text
      OR link."operation"->>'capturedSourceRevision' IS DISTINCT FROM capture."sourceRevision"::text
      OR link."operation"->>'capturedAssetId' IS DISTINCT FROM evidence."assetId"::text
      OR link."operation"->>'currentAssetId' IS DISTINCT FROM current_evidence."assetId"::text
      OR link."operation"->>'kind' IS DISTINCT FROM evidence."kind" OR link."operation"->>'effectiveDay' IS DISTINCT FROM current_evidence."effectiveDay"
      OR link."operation"->>'recordId' IS DISTINCT FROM evidence."recordId" OR link."operation"->>'originalCandidateId' IS DISTINCT FROM evidence."candidateId"
      OR link."operation"->>'sheet' IS DISTINCT FROM physical->>'sheet' OR link."operation"->>'row' IS DISTINCT FROM physical->>'row'
      OR receipt."appliedAt" < history."appliedAt"
      OR EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id")
      OR EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "startEvidenceId" = evidence."id" OR "endEvidenceId" = evidence."id")
      OR EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = evidence."id")
      OR EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" u JOIN "ImportGroupAssignmentItem" i ON i."id" = u."itemId"
        WHERE (u."evidenceId" = evidence."id" OR u."linkId" = link."id") AND (i."applicationId" <> receipt."id" OR i."periodId"::text <> period->>'periodId'))
      OR EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c
        WHERE r."batchId" = capture."batchId" AND r."revision" > link."sourceRevision" AND c->>'candidateId' = evidence."candidateId") THEN
      RAISE EXCEPTION 'Group endpoint must retain its exact unused selected link and current archive provenance' USING ERRCODE = '23514';
    END IF;
    FOREACH snapshot IN ARRAY ARRAY[evidence."snapshot", current_evidence."snapshot"] LOOP
      IF NOT ((snapshot @> '{"historicalActorId":null,"affectsCurrentState":false}'::jsonb AND jsonb_typeof(snapshot->'issues') = 'array'
        AND jsonb_typeof(snapshot->'effective'->'fields') = 'object') IS TRUE)
        OR snapshot->>'recordId' IS DISTINCT FROM evidence."recordId" OR snapshot->>'candidateId' IS DISTINCT FROM evidence."candidateId"
        OR snapshot->>'kind' IS DISTINCT FROM evidence."kind" OR snapshot->'original'->>'id' IS DISTINCT FROM evidence."recordId"
        OR snapshot->'effective'->>'id' IS DISTINCT FROM evidence."recordId" OR snapshot->'original' IS DISTINCT FROM evidence."snapshot"->'original'
        OR snapshot->'original'->>'sheet' IS DISTINCT FROM physical->>'sheet' OR snapshot->'effective'->>'sheet' IS DISTINCT FROM physical->>'sheet'
        OR snapshot->'original'->>'row' IS DISTINCT FROM physical->>'row' OR snapshot->'effective'->>'row' IS DISTINCT FROM physical->>'row'
        OR snapshot->>'datePrecision' IS DISTINCT FROM (CASE WHEN snapshot->>'effectiveDay' IS NULL THEN 'UNKNOWN' ELSE 'DAY' END) THEN
        RAISE EXCEPTION 'Group endpoint snapshots must preserve complete original physical provenance' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF evidence."snapshot"->>'effectiveDay' IS DISTINCT FROM evidence."effectiveDay"
      OR current_evidence."snapshot"->>'effectiveDay' IS DISTINCT FROM current_evidence."effectiveDay" THEN
      RAISE EXCEPTION 'Group endpoint source day must match its archive' USING ERRCODE = '23514';
    END IF;
    projection := current_evidence."snapshot" || jsonb_build_object('assetId', receipt."assetId"::text, 'identityLinkBlocked', false,
      'linkBasis', jsonb_build_object('type', 'APPLIED_IDENTITY_GROUP', 'id', receipt."itemId"::text),
      'effective', current_evidence."snapshot"->'effective' || jsonb_build_object('serialKey', import_identifier_key(item."result"->>'serialNumber'),
        'tagKey', import_identifier_key(item."result"->>'assetTag'), 'fields', current_evidence."snapshot"->'effective'->'fields' ||
        jsonb_build_object('serialNumber', item."result"->'serialNumber', 'assetTag', item."result"->'assetTag')));
    IF link."projection" IS DISTINCT FROM projection THEN RAISE EXCEPTION 'Group endpoint projection must retain all nonidentity archive fields' USING ERRCODE = '23514'; END IF;
    expected_source := jsonb_build_object('endpoint', side, 'evidenceId', evidence."id", 'captureId', capture."id", 'batchId', capture."batchId",
      'sourceHash', evidence."sourceHash", 'recordId', evidence."recordId", 'candidateId', evidence."candidateId", 'kind', evidence."kind",
      'sheet', physical->'sheet', 'row', physical->'row', 'sourceRevision', link."sourceRevision", 'evidenceVersion', link."evidenceVersion",
      'amendmentId', link."amendmentId", 'capturedSourceRevision', capture."sourceRevision", 'effectiveDay', current_evidence."effectiveDay",
      'datePrecision', projection->'datePrecision', 'fields', projection->'effective'->'fields', 'snapshotDigest', import_group_assignment_digest(projection),
      'groupHistoryLinkId', link."id", 'groupHistoryLinkVersion', link."version", 'historyApplicationId', history."id", 'historyLinkPlanId', history."planId");
    selected_link := to_jsonb(link) || jsonb_build_object('historyLinkPlanId', history."planId", 'confirmedById', history."appliedById",
      'confirmedAt', import_group_assignment_iso(history."appliedAt"), 'capturedAssetId', evidence."assetId", 'currentAssetId', current_evidence."assetId",
      'currentEvidenceVersion', current_evidence."evidenceVersion", 'currentAmendmentId', current_evidence."amendmentId",
      'currentSourceRevision', current_evidence."sourceRevision", 'currentSnapshot', current_evidence."snapshot", 'groupAssignmentUse', NULL);
    IF source IS DISTINCT FROM expected_source OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(receipt."plan"->'historyLinks') l WHERE l = selected_link) THEN
      RAISE EXCEPTION 'Group period must pin the complete selected endpoint and history receipt' USING ERRCODE = '23514';
    END IF;
    IF length(btrim(coalesce(period->side->>'dateEvidenceReference', ''))) NOT BETWEEN 1 AND 500
      OR coalesce(period->side->>'confirmedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN
      RAISE EXCEPTION 'Group endpoints require explicit timestamp and independent date proof' USING ERRCODE = '23514';
    END IF;
    confirmed := (period->side->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC';
    IF confirmed < TIMESTAMP '1900-01-01' OR confirmed > receipt."appliedAt"
      OR left(period->side->>'confirmedAt', 10) < '1900-01-01'
      OR (current_evidence."effectiveDay" IS NOT NULL AND left(period->side->>'confirmedAt', 10) <> current_evidence."effectiveDay")
      OR (side = 'start' AND evidence."kind" NOT IN ('USAGE_OBSERVATION', 'LOAN_OBSERVATION'))
      OR (side = 'end' AND evidence."kind" NOT IN ('RECEIPT_OBSERVATION', 'USAGE_OBSERVATION')) THEN
      RAISE EXCEPTION 'Group endpoint requires a past instant on its source local day and an allowed kind' USING ERRCODE = '23514';
    END IF;
    FOR issue IN SELECT value FROM jsonb_array_elements(projection->'issues') LOOP
      contextual := issue->>'code' IN ('EXISTING_TERMINAL_STATE_CONFLICT', 'CROSS_SHEET_STATE_CONFLICT', 'AVAILABILITY_ASSIGNMENT_CONFLICT');
      IF coalesce(issue->>'severity', '') NOT IN ('BLOCKING', 'WARNING', 'INFO') OR issue->>'code' IS NULL
        OR (issue->>'severity' = 'BLOCKING' AND NOT contextual) THEN
        RAISE EXCEPTION 'Group assignment cannot waive a noncontextual source blocker' USING ERRCODE = '23514';
      END IF;
      IF issue->>'severity' = 'WARNING' OR contextual THEN
        warnings := warnings || jsonb_build_array(jsonb_build_object('id', import_group_assignment_digest(jsonb_build_object('evidenceId', evidence."id", 'issue', issue)),
          'evidenceId', evidence."id", 'issue', issue, 'contextualOnly', contextual));
      END IF;
    END LOOP;
    IF side = 'start' THEN
      start_at := confirmed; start_fields := projection->'effective'->'fields'; start_kind := evidence."kind";
      start_sheet := physical->>'sheet'; start_record := evidence."recordId";
    ELSE
      end_at := confirmed; end_fields := projection->'effective'->'fields'; end_kind := evidence."kind";
      IF start_record = evidence."recordId" THEN RAISE EXCEPTION 'Group endpoints require distinct physical records' USING ERRCODE = '23514'; END IF;
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(to_jsonb(w.id) ORDER BY w.id), '[]'::jsonb) INTO acknowledged FROM (SELECT DISTINCT value->>'id' AS id FROM jsonb_array_elements(warnings)) w;
  IF period->'warnings' IS DISTINCT FROM warnings OR period->'acknowledgedWarnings' IS DISTINCT FROM acknowledged
    OR end_at <= start_at
    OR EXISTS (SELECT 1 FROM "Asset" a WHERE a."id" = receipt."assetId" AND a."decommissionedAt" IS NOT NULL AND end_at > a."decommissionedAt")
    OR EXISTS (SELECT 1 FROM "Assignment" a WHERE a."assetId" = receipt."assetId" AND a."id" IS DISTINCT FROM ignored_assignment_id
      AND start_at < coalesce(a."endedAt", 'infinity'::timestamp) AND end_at > a."startedAt")
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(receipt."plan"->'periods') p WHERE p->>'periodId' <> period->>'periodId'
      AND start_at < (p->'end'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC' AND end_at > (p->'start'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC')
    OR (coalesce(import_identifier_key(start_fields->>'officeText'), import_identifier_key(start_fields->>'recipientText')) IS NOT NULL
      AND coalesce(import_identifier_key(start_fields->>'officeText'), import_identifier_key(start_fields->>'recipientText')) IS DISTINCT FROM import_identifier_key(period->'recipient'->>'name'))
    OR (import_identifier_key(start_fields->>'officeText') IS NOT NULL AND period->'recipient'->>'type' <> 'OFFICE')
    OR ((start_kind = 'LOAN_OBSERVATION' OR start_sheet = 'NB Prestamo' OR import_identifier_key(start_fields->>'loanCode') IS NOT NULL
      OR import_identifier_key(start_fields->>'loanDate') IS NOT NULL) AND period->>'assignmentType' <> 'LOAN') THEN
    RAISE EXCEPTION 'Group period must retain recognized warnings, source recipient, loan type and nonoverlapping history' USING ERRCODE = '23514';
  END IF;
  expected_proposal := jsonb_build_object('assetId', receipt."assetId", 'personId', NULL, 'recipientType', period->'recipient'->'type',
    'personName', CASE WHEN period->'recipient'->>'type' = 'PERSON' THEN period->'recipient'->'name' ELSE 'null'::jsonb END,
    'officeName', CASE WHEN period->'recipient'->>'type' = 'OFFICE' THEN period->'recipient'->'name' ELSE 'null'::jsonb END,
    'assignmentType', period->'assignmentType', 'startedAt', import_group_assignment_iso(start_at), 'endedAt', import_group_assignment_iso(end_at),
    'returnStatus', period->'returnStatus', 'assignedById', NULL, 'returnedById', NULL,
    'ticketReference', import_group_assignment_reference(start_fields->>'outgoingTicket'), 'otReference', import_group_assignment_reference(start_fields->>'outgoingOt'),
    'returnTicketReference', import_group_assignment_reference(CASE WHEN end_kind = 'RECEIPT_OBSERVATION' THEN end_fields->>'incomingTicket' END),
    'returnOtReference', import_group_assignment_reference(CASE WHEN end_kind = 'RECEIPT_OBSERVATION' THEN end_fields->>'incomingOt' END));
  IF period->'proposedAssignment' IS DISTINCT FROM expected_proposal THEN
    RAISE EXCEPTION 'Group assignment proposal must be derived exactly from its confirmed physical sources' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_group_assignment_item(item "ImportGroupAssignmentItem") RETURNS void AS $$
DECLARE receipt "ImportGroupAssignmentApplication"%ROWTYPE; assignment "Assignment"%ROWTYPE; period JSONB; proposal JSONB;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO receipt FROM "ImportGroupAssignmentApplication" WHERE "id" = item."applicationId";
  SELECT p INTO period FROM jsonb_array_elements(receipt."plan"->'periods') p WHERE p->>'periodId' = item."periodId"::text;
  IF receipt."id" IS NULL OR period IS NULL OR item."snapshot" IS DISTINCT FROM period
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' = 'start' AND s->>'groupHistoryLinkId' = item."startLinkId"::text)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(period->'sources') s WHERE s->>'endpoint' = 'end' AND s->>'groupHistoryLinkId' = item."endLinkId"::text)
    OR EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "assignmentId" = item."assignmentId") THEN
    RAISE EXCEPTION 'Group item must retain its exact planned period and exclusive assignment origin' USING ERRCODE = '23514';
  END IF;
  PERFORM assert_import_group_assignment_period(receipt, period, item."assignmentId");
  proposal := period->'proposedAssignment';
  SELECT * INTO assignment FROM "Assignment" WHERE "id" = item."assignmentId";
  IF assignment."id" IS NULL OR assignment."importedHistory" IS DISTINCT FROM true OR assignment."assetId" IS DISTINCT FROM receipt."assetId"
    OR assignment."personId" IS NOT NULL OR assignment."createdById" IS NOT NULL OR assignment."endedById" IS NOT NULL OR assignment."expectedReturnAt" IS NOT NULL
    OR assignment."startedAt" IS DISTINCT FROM (proposal->>'startedAt')::timestamptz AT TIME ZONE 'UTC'
    OR assignment."endedAt" IS DISTINCT FROM (proposal->>'endedAt')::timestamptz AT TIME ZONE 'UTC'
    OR assignment."createdAt" IS DISTINCT FROM receipt."appliedAt" OR assignment."returnRecordedAt" IS DISTINCT FROM receipt."appliedAt"
    OR assignment."recipientType"::text IS DISTINCT FROM proposal->>'recipientType' OR assignment."personName" IS DISTINCT FROM proposal->>'personName'
    OR assignment."officeName" IS DISTINCT FROM proposal->>'officeName' OR assignment."assignmentType"::text IS DISTINCT FROM proposal->>'assignmentType'
    OR assignment."returnStatus"::text IS DISTINCT FROM proposal->>'returnStatus'
    OR assignment."ticketReference" IS DISTINCT FROM proposal->>'ticketReference' OR assignment."otReference" IS DISTINCT FROM proposal->>'otReference'
    OR assignment."returnTicketReference" IS DISTINCT FROM proposal->>'returnTicketReference' OR assignment."returnOtReference" IS DISTINCT FROM proposal->>'returnOtReference'
    OR assignment."notes" IS DISTINCT FROM period->>'note' OR assignment."returnNotes" IS DISTINCT FROM period->>'evidenceReference' THEN
    RAISE EXCEPTION 'Imported group assignment must exactly match its closed actorless proposal and capture time' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_group_assignment_application() RETURNS trigger AS $$
DECLARE item "ImportIdentityGroupApplicationItem"%ROWTYPE; parent "ImportIdentityGroupApplication"%ROWTYPE; period JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group assignment receipts are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  IF NEW."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'Group assignment receipt must retain its actual creating transaction' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = NEW."itemId";
  SELECT * INTO parent FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  IF parent."id" IS NULL THEN RAISE EXCEPTION 'Group assignment requires its applied group parent' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "ImportBatch" WHERE "id" = parent."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(parent."sourceHash", 0));
  -- Never acquire capture-batch row locks after the source advisory lock.
  LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoryCapture", "ImportHistoricalEvidence", "ImportEvidenceAmendment",
    "ImportGroupHistoryApplication", "ImportGroupHistoryLink" IN EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  PERFORM 1 FROM "Product" WHERE "id" = (item."result"->>'productId')::uuid FOR SHARE;
  PERFORM 1 FROM "User" WHERE "id" = NEW."appliedById" FOR SHARE;
  IF NEW."appliedAt" < (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond' THEN
    RAISE EXCEPTION 'Group assignment capture cannot predate its transaction' USING ERRCODE = '23514';
  END IF;
  PERFORM assert_import_group_assignment_context(NEW);
  FOR period IN SELECT value FROM jsonb_array_elements(NEW."plan"->'periods') LOOP
    PERFORM assert_import_group_assignment_period(NEW, period);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupAssignmentApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupAssignmentApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_application();

CREATE FUNCTION guard_import_group_assignment_item() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group assignment items are immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_item(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupAssignmentItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupAssignmentItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_item();

CREATE FUNCTION guard_import_group_assignment_evidence_use() RETURNS trigger AS $$
DECLARE item "ImportGroupAssignmentItem"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group assignment evidence ownership is immutable' USING ERRCODE = '23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO item FROM "ImportGroupAssignmentItem" WHERE "id" = NEW."itemId";
  IF item."id" IS NULL OR NOT EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" l WHERE l."id" = NEW."linkId" AND l."evidenceId" = NEW."evidenceId"
    AND (CASE NEW."endpoint" WHEN 'START' THEN l."id" = item."startLinkId" WHEN 'END' THEN l."id" = item."endLinkId" ELSE false END)) THEN
    RAISE EXCEPTION 'Group evidence use must match its exact selected link and endpoint' USING ERRCODE = '23514';
  END IF;
  PERFORM assert_import_group_assignment_item(item);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupAssignmentEvidenceUse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupAssignmentEvidenceUse"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_evidence_use();

CREATE FUNCTION guard_import_group_assignment_immutable() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" WHERE "assignmentId" = OLD."id") THEN
    RAISE EXCEPTION 'Imported group assignments are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_group_import_immutable_guard" BEFORE UPDATE OR DELETE ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_immutable();

-- Keep the transaction identity explicitly: xmin can belong to a savepoint's subtransaction.
-- These write guards remain effective after SET CONSTRAINTS ALL IMMEDIATE consumes deferred events.
CREATE FUNCTION guard_import_group_assignment_current_asset() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ImportGroupAssignmentApplication" r WHERE r."assetId" = OLD."id"
    AND r."createdTransactionId" = pg_current_xact_id()::text
    AND r."appliedAt" >= (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond') THEN
    RAISE EXCEPTION 'Group history application cannot mutate the current asset in its creating transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_group_import_current_guard" BEFORE UPDATE OR DELETE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_current_asset();

CREATE FUNCTION guard_import_group_assignment_current_custody() RETURNS trigger AS $$
DECLARE receipt "ImportGroupAssignmentApplication"%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM "ImportGroupAssignmentApplication" r
    WHERE r."createdTransactionId" = pg_current_xact_id()::text
      AND r."appliedAt" >= (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 millisecond' AND
      ((TG_OP <> 'DELETE' AND r."assetId" = NEW."assetId") OR (TG_OP <> 'INSERT' AND r."assetId" = OLD."assetId")) LIMIT 1;
  IF receipt."id" IS NOT NULL THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Group history application cannot mutate existing custody in its creating transaction' USING ERRCODE = '23514';
    END IF;
    IF NEW."importedHistory" IS DISTINCT FROM true OR NEW."endedAt" IS NULL OR NEW."personId" IS NOT NULL OR NEW."expectedReturnAt" IS NOT NULL
      OR NEW."createdAt" IS DISTINCT FROM receipt."appliedAt" OR NEW."returnRecordedAt" IS DISTINCT FROM receipt."appliedAt"
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(receipt."plan"->'periods') p
        WHERE NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" i WHERE i."applicationId" = receipt."id" AND i."periodId"::text = p->>'periodId')
        AND NEW."notes" IS NOT DISTINCT FROM p->>'note' AND NEW."returnNotes" IS NOT DISTINCT FROM p->>'evidenceReference'
        AND p->'proposedAssignment' = jsonb_build_object('assetId', NEW."assetId", 'personId', NEW."personId", 'recipientType', NEW."recipientType",
          'personName', NEW."personName", 'officeName', NEW."officeName", 'assignmentType', NEW."assignmentType",
          'startedAt', import_group_assignment_iso(NEW."startedAt"), 'endedAt', import_group_assignment_iso(NEW."endedAt"),
          'returnStatus', NEW."returnStatus", 'assignedById', NEW."createdById", 'returnedById', NEW."endedById",
          'ticketReference', NEW."ticketReference", 'otReference', NEW."otReference", 'returnTicketReference', NEW."returnTicketReference", 'returnOtReference', NEW."returnOtReference")) THEN
      RAISE EXCEPTION 'Group history application can only add its planned closed custody periods' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_group_import_current_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_assignment_current_custody();

CREATE FUNCTION guard_import_assignment_group_origin() RETURNS trigger AS $$
DECLARE assignment_asset UUID;
BEGIN
  SELECT "assetId" INTO assignment_asset FROM "Assignment" WHERE "id" = NEW."assignmentId";
  PERFORM 1 FROM "Asset" WHERE "id" = assignment_asset FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ImportGroupAssignmentItem" WHERE "assignmentId" = NEW."assignmentId") THEN
    RAISE EXCEPTION 'Imported assignments cannot have two origin receipts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentItem_group_origin_guard" BEFORE INSERT ON "ImportAssignmentItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_assignment_group_origin();

CREATE FUNCTION verify_import_group_assignment_complete() RETURNS trigger AS $$
DECLARE item "ImportGroupAssignmentItem"%ROWTYPE;
BEGIN
  PERFORM assert_import_group_assignment_context(NEW);
  IF (SELECT count(*) FROM "ImportGroupAssignmentItem" WHERE "applicationId" = NEW."id") <> jsonb_array_length(NEW."plan"->'periods')
    OR NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "entityType" = 'ImportGroupAssignmentApplication' AND "entityId" = NEW."id"::text
      AND "action" = 'IMPORT_GROUP_CLOSED_ASSIGNMENTS_APPLIED' AND "userId" = NEW."appliedById") THEN
    RAISE EXCEPTION 'Group assignment receipt requires all planned items and its atomic root audit' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT * FROM "ImportGroupAssignmentItem" WHERE "applicationId" = NEW."id" LOOP
    PERFORM assert_import_group_assignment_item(item);
    IF (SELECT count(*) FROM "ImportGroupAssignmentEvidenceUse" WHERE "itemId" = item."id") <> 2
      OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" u JOIN "ImportGroupHistoryLink" l ON l."id" = u."linkId"
        WHERE u."itemId" = item."id" AND u."endpoint" = 'START' AND u."linkId" = item."startLinkId" AND u."evidenceId" = l."evidenceId")
      OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" u JOIN "ImportGroupHistoryLink" l ON l."id" = u."linkId"
        WHERE u."itemId" = item."id" AND u."endpoint" = 'END' AND u."linkId" = item."endLinkId" AND u."evidenceId" = l."evidenceId")
      OR NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "entityType" = 'Assignment' AND "entityId" = item."assignmentId"::text
        AND "action" = 'IMPORT_GROUP_CLOSED_ASSIGNMENT_ADDED' AND "userId" = NEW."appliedById") THEN
      RAISE EXCEPTION 'Every group assignment requires two exact evidence uses and its atomic assignment audit' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportGroupAssignmentApplication_complete_guard" AFTER INSERT ON "ImportGroupAssignmentApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_group_assignment_complete();

CREATE OR REPLACE FUNCTION verify_import_assignment_complete() RETURNS trigger AS $$
DECLARE current_asset "Asset"%ROWTYPE; group_item "ImportGroupAssignmentItem"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'Assignment' THEN
    SELECT * INTO group_item FROM "ImportGroupAssignmentItem" WHERE "assignmentId" = NEW."id";
    IF group_item."id" IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "assignmentId" = NEW."id") THEN
        RAISE EXCEPTION 'Imported assignments cannot have two origin receipts' USING ERRCODE = '23514';
      END IF;
      PERFORM assert_import_group_assignment_item(group_item);
      IF (SELECT count(*) FROM "ImportGroupAssignmentEvidenceUse" WHERE "itemId" = group_item."id") <> 2
        OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" u JOIN "ImportGroupHistoryLink" l ON l."id" = u."linkId"
          WHERE u."itemId" = group_item."id" AND u."endpoint" = 'START' AND u."linkId" = group_item."startLinkId" AND u."evidenceId" = l."evidenceId")
        OR NOT EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" u JOIN "ImportGroupHistoryLink" l ON l."id" = u."linkId"
          WHERE u."itemId" = group_item."id" AND u."endpoint" = 'END' AND u."linkId" = group_item."endLinkId" AND u."evidenceId" = l."evidenceId") THEN
        RAISE EXCEPTION 'Imported group assignments require two validated endpoint uses' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."importedHistory" AND NOT EXISTS (SELECT 1 FROM "ImportAssignmentItem" i WHERE i."assignmentId" = NEW."id" AND
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

COMMIT;
