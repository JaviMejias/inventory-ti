BEGIN;

CREATE TABLE "ImportGroupRetirementApplication" (
  "id" UUID PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "decisionId" UUID NOT NULL REFERENCES "ImportIdentityGroupDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "groupId" UUID NOT NULL, "groupKey" VARCHAR(64) NOT NULL CHECK ("groupKey" ~ '^[a-f0-9]{64}$'),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "assetId" UUID NOT NULL UNIQUE REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL UNIQUE REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceVersion" INTEGER NOT NULL CHECK ("evidenceVersion" BETWEEN 0 AND 1000),
  "amendmentId" UUID REFERENCES "ImportEvidenceAmendment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "decommissionedAt" TIMESTAMP(3) NOT NULL,
  "requestId" UUID NOT NULL, "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL UNIQUE CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-group-retirement-application-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "assetSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("assetSnapshot") = 'object'),
  "result" JSONB NOT NULL CHECK (jsonb_typeof("result") = 'object'),
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTransactionId" VARCHAR(20) NOT NULL DEFAULT (pg_current_xact_id())::text,
  CHECK ("decommissionedAt" >= TIMESTAMP '1900-01-01' AND "decommissionedAt" <= "appliedAt"),
  CHECK (("evidenceVersion" = 0) = ("amendmentId" IS NULL)),
  UNIQUE ("reviewId", "requestId")
);
CREATE INDEX "ImportGroupRetirementApplication_reviewId_appliedAt_id_idx" ON "ImportGroupRetirementApplication"("reviewId", "appliedAt", "id");
CREATE INDEX "ImportGroupRetirementApplication_createdTransactionId_idx" ON "ImportGroupRetirementApplication"("createdTransactionId");
CREATE TABLE "ImportGroupRetirementRowUse" (
  "sourceHash" VARCHAR(64) NOT NULL, "recordId" VARCHAR(64) NOT NULL, "originalCandidateId" VARCHAR(64) NOT NULL,
  "reviewId" UUID NOT NULL,
  "applicationId" UUID NOT NULL REFERENCES "ImportGroupRetirementApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY ("sourceHash", "recordId"), UNIQUE ("reviewId", "recordId"),
  FOREIGN KEY ("reviewId", "recordId") REFERENCES "ImportIdentityGroupRow"("reviewId", "recordId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ImportGroupRetirementRowUse_sourceHash_originalCandidateId_idx" ON "ImportGroupRetirementRowUse"("sourceHash", "originalCandidateId");
CREATE INDEX "ImportGroupRetirementRowUse_applicationId_idx" ON "ImportGroupRetirementRowUse"("applicationId");

CREATE OR REPLACE FUNCTION assert_import_group_source_unconsumed(source_hash TEXT, candidate_id TEXT, record_id TEXT) RETURNS void AS $$
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  IF EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash"=source_hash AND ("originalCandidateId"=candidate_id OR "recordId"=record_id))
    OR EXISTS (SELECT 1 FROM "ImportGroupRetirementRowUse" WHERE "sourceHash"=source_hash AND ("originalCandidateId"=candidate_id OR "recordId"=record_id)) THEN
    RAISE EXCEPTION 'Source was already applied through a physical group' USING ERRCODE='23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_import_group_retirement(receipt "ImportGroupRetirementApplication", completed BOOLEAN) RETURNS void AS $$
DECLARE
  decision "ImportIdentityGroupDecision"%ROWTYPE; review "ImportIdentityGroupReview"%ROWTYPE; batch "ImportBatch"%ROWTYPE;
  asset "Asset"%ROWTYPE; before_asset "Asset"%ROWTYPE; product "Product"%ROWTYPE; actor "User"%ROWTYPE;
  evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE; original "ImportHistoricalEvidence"%ROWTYPE; capture "ImportHistoryCapture"%ROWTYPE;
  selected_group JSONB; pin JSONB; source_row JSONB; issue JSONB; projection JSONB; fields JSONB; request JSONB;
  group_warnings JSONB:='[]'::jsonb; warnings JSONB:='[]'::jsonb; received_text TEXT; received_day TEXT;
  assignments JSONB; revisions JSONB; expected_asset JSONB; acknowledged JSONB;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO batch FROM "ImportBatch" WHERE "id"=receipt."batchId";
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id"=receipt."reviewId";
  SELECT * INTO decision FROM "ImportIdentityGroupDecision" WHERE "id"=receipt."decisionId";
  SELECT * INTO asset FROM "Asset" WHERE "id"=receipt."assetId";
  SELECT * INTO actor FROM "User" WHERE "id"=receipt."appliedById";
  SELECT * INTO product FROM "Product" WHERE "id"=asset."productId";
  before_asset:=jsonb_populate_record(NULL::"Asset",receipt."assetSnapshot");
  SELECT value INTO selected_group FROM jsonb_array_elements(decision."projection"->'groups') WHERE value->>'groupKey'=receipt."groupKey";
  request:=receipt."plan"->'request';
  IF batch."id" IS NULL OR review."batchId" IS DISTINCT FROM batch."id" OR review."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR batch."sourceHash" IS DISTINCT FROM receipt."sourceHash"
    OR actor."role" IS DISTINCT FROM 'JEFE' OR actor."isActive" IS DISTINCT FROM true OR actor."passwordHash" IS NULL
    OR receipt."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR receipt."appliedAt"<(transaction_timestamp() AT TIME ZONE 'UTC')-INTERVAL '1 millisecond' OR receipt."appliedAt">clock_timestamp() AT TIME ZONE 'UTC'
    OR EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId"=review."id")
    OR decision."reviewId" IS DISTINCT FROM review."id" OR decision."action" IS DISTINCT FROM 'LINK_EXISTING' OR decision."linkedAssetId" IS DISTINCT FROM asset."id"
    OR decision."groupId" IS DISTINCT FROM receipt."groupId" OR decision."groupKey" IS DISTINCT FROM receipt."groupKey" OR selected_group IS NULL
    OR decision."id" IS DISTINCT FROM (SELECT "id" FROM "ImportIdentityGroupDecision" WHERE "reviewId"=review."id" AND "groupKey"=receipt."groupKey" ORDER BY "version" DESC LIMIT 1)
    OR decision."batchVersion" IS DISTINCT FROM batch."version" OR decision."sourceRevision" IS DISTINCT FROM (SELECT count(*)::integer FROM "ImportSourceRevision" WHERE "batchId"=batch."id")
    OR request->>'expectedBatchVersion' IS DISTINCT FROM batch."version"::text OR request->>'expectedSourceRevision' IS DISTINCT FROM decision."sourceRevision"::text
    OR request->>'expectedDecisionVersion' IS DISTINCT FROM (SELECT max("version")::text FROM "ImportIdentityGroupDecision" WHERE "reviewId"=review."id")
    OR request->>'decisionId' IS DISTINCT FROM decision."id"::text OR request->>'projectionId' IS DISTINCT FROM decision."projectionId" OR receipt."plan"->>'projectionId' IS DISTINCT FROM decision."projectionId"
    OR decision."projection"->>'asOf' IS DISTINCT FROM to_char(receipt."appliedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago','YYYY-MM-DD')
    OR request->>'groupKey' IS DISTINCT FROM receipt."groupKey" OR receipt."groupKey" IS DISTINCT FROM import_group_assignment_digest(jsonb_build_array('IMPORT_IDENTITY_GROUP',receipt."sourceHash",review."id",receipt."groupId")) THEN
    RAISE EXCEPTION 'Grouped retirement requires exact active review, latest decision, versions and configured JEFE' USING ERRCODE='23514';
  END IF;
  IF product."trackingMode" IS DISTINCT FROM 'ASSET' OR before_asset."id" IS DISTINCT FROM asset."id" OR before_asset."isActive" IS DISTINCT FROM true OR before_asset."status" IN ('ASSIGNED','DECOMMISSIONED') OR before_asset."decommissionedAt" IS NOT NULL
    OR import_identifier_key(asset."serialNumber") IS DISTINCT FROM import_identifier_key(selected_group->>'serialNumber') OR import_identifier_key(asset."assetTag") IS DISTINCT FROM import_identifier_key(selected_group->>'assetTag')
    OR EXISTS (SELECT 1 FROM "AssignmentEffective" WHERE "assetId"=asset."id" AND ("endedAt" IS NULL OR "endedAt">receipt."decommissionedAt" OR "endedAt"<="startedAt"))
    OR EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "assetId"=asset."id" OR "evidenceId"=receipt."evidenceId") THEN
    RAISE EXCEPTION 'Grouped retirement requires unchanged physical identity and nonterminal closed custody' USING ERRCODE='23514';
  END IF;
  IF completed THEN
    IF asset."status" IS DISTINCT FROM 'DECOMMISSIONED' OR asset."isActive" OR asset."decommissionedAt" IS DISTINCT FROM receipt."decommissionedAt" OR asset."updatedAt" IS DISTINCT FROM receipt."appliedAt"
      OR (to_jsonb(asset)-ARRAY['status','isActive','decommissionedAt','updatedAt']) IS DISTINCT FROM (receipt."assetSnapshot"-ARRAY['status','isActive','decommissionedAt','updatedAt']) THEN
      RAISE EXCEPTION 'Grouped retirement must commit exact terminal state without metadata changes' USING ERRCODE='23514'; END IF;
  ELSIF to_jsonb(asset) IS DISTINCT FROM receipt."assetSnapshot" THEN RAISE EXCEPTION 'Grouped retirement snapshot must match current asset' USING ERRCODE='23514'; END IF;
  expected_asset:=jsonb_build_object('id',before_asset."id",'productId',before_asset."productId",'serialNumber',before_asset."serialNumber",'assetTag',before_asset."assetTag",'status',before_asset."status",'isActive',before_asset."isActive",'decommissionedAt',NULL,'updatedAt',import_group_assignment_iso(before_asset."updatedAt"),
    'product',jsonb_build_object('id',product."id",'trackingMode',product."trackingMode",'isActive',product."isActive",'updatedAt',import_group_assignment_iso(product."updatedAt")));
  IF receipt."plan"->'assetBefore' IS DISTINCT FROM expected_asset OR receipt."result" IS DISTINCT FROM receipt."assetSnapshot"||jsonb_build_object('status','DECOMMISSIONED','isActive',false,'decommissionedAt',import_group_assignment_iso(receipt."decommissionedAt"),'updatedAt',import_group_assignment_iso(receipt."appliedAt")) THEN
    RAISE EXCEPTION 'Grouped retirement must preserve exact asset before and result' USING ERRCODE='23514'; END IF;
  IF receipt."plan"->'sourceRows' IS DISTINCT FROM selected_group->'observations' OR jsonb_array_length(selected_group->'observations') NOT BETWEEN 1 AND 25
    OR (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId"=review."id" AND "groupId"=receipt."groupId")<>jsonb_array_length(selected_group->'observations') THEN
    RAISE EXCEPTION 'Grouped retirement requires complete reviewed source membership' USING ERRCODE='23514'; END IF;
  FOR source_row IN SELECT value FROM jsonb_array_elements(selected_group->'observations') LOOP
    IF NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" r WHERE r."reviewId"=review."id" AND r."groupId"=receipt."groupId" AND r."isReserved" AND r."sourceHash"=receipt."sourceHash" AND r."recordId"=source_row->>'recordId' AND r."originalCandidateId"=source_row->>'originalCandidateId' AND r."snapshot"->>'sheet'=source_row->>'sheet' AND r."snapshot"->>'row'=source_row->>'row')
      OR EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash"=receipt."sourceHash" AND "recordId"=source_row->>'recordId')
      OR EXISTS (SELECT 1 FROM "ImportGroupRetirementRowUse" WHERE "sourceHash"=receipt."sourceHash" AND "recordId"=source_row->>'recordId' AND "applicationId"<>receipt."id")
      OR EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "sourceHash"=receipt."sourceHash" AND "candidateId"=source_row->>'originalCandidateId') THEN
      RAISE EXCEPTION 'Grouped retirement source is unreserved or already applied' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF jsonb_array_length(selected_group->'evidence')<>(SELECT count(*) FROM "ImportHistoricalEvidence" e WHERE e."sourceHash"=receipt."sourceHash" AND e."recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(selected_group->'observations')))
    OR (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(selected_group->'evidence'))<>jsonb_array_length(selected_group->'evidence') THEN
    RAISE EXCEPTION 'Grouped retirement requires complete current archive coverage' USING ERRCODE='23514'; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(selected_group->'evidence') LOOP
    SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id"=(pin->>'id')::uuid;
    SELECT * INTO original FROM "ImportHistoricalEvidence" WHERE "id"=evidence."id";
    SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id"=evidence."captureId";
    IF evidence."id" IS NULL OR evidence."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR capture."sourceHash" IS DISTINCT FROM receipt."sourceHash"
      OR pin->>'recordId' IS DISTINCT FROM evidence."recordId" OR pin->>'candidateId' IS DISTINCT FROM evidence."candidateId" OR pin->>'captureId' IS DISTINCT FROM capture."id"::text OR pin->>'captureBatchId' IS DISTINCT FROM capture."batchId"::text
      OR pin->>'capturedSourceRevision' IS DISTINCT FROM capture."sourceRevision"::text OR pin->>'sourceRevision' IS DISTINCT FROM evidence."sourceRevision"::text OR pin->>'evidenceVersion' IS DISTINCT FROM evidence."evidenceVersion"::text
      OR pin->>'amendmentId' IS DISTINCT FROM evidence."amendmentId"::text OR pin->>'capturedAssetId' IS DISTINCT FROM original."assetId"::text OR pin->>'currentAssetId' IS DISTINCT FROM evidence."assetId"::text
      OR original."snapshot"->'original' IS DISTINCT FROM evidence."snapshot"->'original'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'observations') r WHERE r->>'recordId'=evidence."recordId" AND r->>'originalCandidateId'=evidence."candidateId" AND r->>'sheet'=evidence."snapshot"->'original'->>'sheet' AND r->>'row'=evidence."snapshot"->'original'->>'row')
      OR EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId"=evidence."id") OR EXISTS (SELECT 1 FROM "ImportGroupAssignmentEvidenceUse" WHERE "evidenceId"=evidence."id") OR EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId"=evidence."id") OR EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" WHERE "evidenceId"=evidence."id") THEN
      RAISE EXCEPTION 'Grouped retirement must retain exact unused archive versions for every reviewed member' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id"=receipt."evidenceId";
  SELECT * INTO original FROM "ImportHistoricalEvidence" WHERE "id"=receipt."evidenceId";
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id"=evidence."captureId";
  IF evidence."kind" IS DISTINCT FROM 'RETIREMENT_OBSERVATION' OR evidence."effectiveDay" IS NOT NULL OR evidence."evidenceVersion" IS DISTINCT FROM receipt."evidenceVersion" OR evidence."amendmentId" IS DISTINCT FROM receipt."amendmentId" OR evidence."sourceRevision" IS DISTINCT FROM receipt."sourceRevision"
    OR (evidence."assetId" IS NOT NULL AND evidence."assetId"<>receipt."assetId") OR capture."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'evidence') e WHERE e->>'id'=receipt."evidenceId"::text)
    OR EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c WHERE r."batchId"=capture."batchId" AND r."revision">receipt."sourceRevision" AND c->>'candidateId'=evidence."candidateId")
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(evidence."snapshot"->'issues') i WHERE i->>'severity'='BLOCKING') THEN
    RAISE EXCEPTION 'Grouped retirement requires exact undated disposal evidence with current compatible source' USING ERRCODE='23514'; END IF;
  fields:=evidence."snapshot"->'effective'->'fields'||jsonb_build_object('serialNumber',selected_group->'serialNumber','assetTag',selected_group->'assetTag');
  projection:=evidence."snapshot"||jsonb_build_object('assetId',receipt."assetId",'identityLinkBlocked',false,'linkBasis',jsonb_build_object('type','REVIEWED_IDENTITY_GROUP_PROPOSAL','reviewId',review."id",'groupId',receipt."groupId"),
    'effective',evidence."snapshot"->'effective'||jsonb_build_object('serialKey',import_identifier_key(selected_group->>'serialNumber'),'tagKey',import_identifier_key(selected_group->>'assetTag'),'fields',fields));
  IF receipt."plan"->'proposedEvidenceProjection' IS DISTINCT FROM projection OR receipt."plan"->'source'->'fields' IS DISTINCT FROM fields OR receipt."plan"->'source'->>'snapshotDigest' IS DISTINCT FROM import_group_assignment_digest(projection)
    OR receipt."plan"->'originalEvidence'->'snapshot' IS DISTINCT FROM original."snapshot" OR receipt."plan"->'currentEvidence'->'snapshot' IS DISTINCT FROM evidence."snapshot"
    OR receipt."plan"->'source'->>'evidenceId' IS DISTINCT FROM evidence."id"::text OR receipt."plan"->'source'->>'captureId' IS DISTINCT FROM evidence."captureId"::text OR receipt."plan"->'source'->>'batchId' IS DISTINCT FROM capture."batchId"::text OR receipt."plan"->'source'->>'sourceHash' IS DISTINCT FROM receipt."sourceHash"
    OR receipt."plan"->'source'->>'recordId' IS DISTINCT FROM evidence."recordId" OR receipt."plan"->'source'->>'candidateId' IS DISTINCT FROM evidence."candidateId" OR receipt."plan"->'source'->>'evidenceVersion' IS DISTINCT FROM receipt."evidenceVersion"::text OR receipt."plan"->'source'->>'amendmentId' IS DISTINCT FROM receipt."amendmentId"::text OR receipt."plan"->'source'->>'sourceRevision' IS DISTINCT FROM receipt."sourceRevision"::text THEN
    RAISE EXCEPTION 'Grouped retirement must retain original, current and proposed source separately' USING ERRCODE='23514'; END IF;
  received_text:=fields->>'receivedDate';
  IF import_identifier_key(received_text) IS NOT NULL THEN
    received_day:=left(received_text,10);
    IF received_text!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?)?$' OR received_day<'1900-01-01' OR to_char(received_day::date,'YYYY-MM-DD')<>received_day OR received_day>to_char(receipt."appliedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago','YYYY-MM-DD') OR left(request->'plan'->>'confirmedAt',10)<received_day THEN
      RAISE EXCEPTION 'Grouped retirement cannot contradict receipt chronology' USING ERRCODE='23514'; END IF;
  END IF;
  IF receipt."plan"->'source'->>'sourceReceivedDay' IS DISTINCT FROM received_day OR request->'plan'->>'confirmation' IS DISTINCT FROM 'VERIFIED_HISTORICAL_RETIREMENT' OR request->'plan'->>'evidenceId' IS DISTINCT FROM receipt."evidenceId"::text OR request->>'expectedEvidenceVersion' IS DISTINCT FROM receipt."evidenceVersion"::text
    OR length(btrim(coalesce(request->'plan'->>'dateEvidenceReference',''))) NOT BETWEEN 1 AND 500 OR length(btrim(coalesce(request->'plan'->>'note',''))) NOT BETWEEN 1 AND 2000 OR length(btrim(coalesce(request->'plan'->>'evidenceReference',''))) NOT BETWEEN 1 AND 500
    OR coalesce(request->'plan'->>'confirmedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' OR (request->'plan'->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM receipt."decommissionedAt" THEN
    RAISE EXCEPTION 'Grouped retirement requires independently confirmed exact timestamp and proof' USING ERRCODE='23514'; END IF;
  IF receipt."plan"->'source' IS DISTINCT FROM jsonb_build_object('evidenceId',evidence."id",'captureId',evidence."captureId",'batchId',capture."batchId",'sourceHash',evidence."sourceHash",'recordId',evidence."recordId",'candidateId',evidence."candidateId",'kind',evidence."kind",'sheet',evidence."snapshot"->'original'->'sheet','row',evidence."snapshot"->'original'->'row','sourceRevision',evidence."sourceRevision",'capturedSourceRevision',capture."sourceRevision",'evidenceVersion',evidence."evidenceVersion",'amendmentId',evidence."amendmentId",'effectiveDay',NULL,'datePrecision','UNKNOWN','sourceReceivedDay',received_day,'fields',fields,'snapshotDigest',import_group_assignment_digest(projection)) THEN
    RAISE EXCEPTION 'Grouped retirement must retain complete exact source metadata and unknown date precision' USING ERRCODE='23514'; END IF;
  FOR issue IN SELECT value FROM jsonb_array_elements(decision."projection"->'issues') LOOP
    IF (issue->>'candidateId' IS NOT NULL AND selected_group->'simulatedCandidateIds' ? (issue->>'candidateId')) OR (issue->>'candidateId' IS NULL AND (issue->>'sheet' IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'observations') r WHERE r->>'sheet'=issue->>'sheet' AND (issue->>'row' IS NULL OR r->>'row'=issue->>'row')))) THEN
      IF issue->>'severity'='BLOCKING' THEN RAISE EXCEPTION 'Grouped retirement cannot waive grouping source blockers' USING ERRCODE='23514'; END IF;
      IF issue->>'severity'='WARNING' THEN group_warnings:=group_warnings||jsonb_build_array(jsonb_build_object('id',import_group_assignment_digest(issue),'issue',issue)); END IF;
    END IF;
  END LOOP;
  FOR issue IN SELECT value FROM jsonb_array_elements(evidence."snapshot"->'issues') WHERE value->>'severity'='WARNING' LOOP
    warnings:=warnings||jsonb_build_array(jsonb_build_object('id',import_group_assignment_digest(jsonb_build_object('evidenceId',evidence."id",'issue',issue)),'evidenceId',evidence."id",'issue',issue));
  END LOOP;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'),'[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(warnings) w;
  IF receipt."plan"->'warnings' IS DISTINCT FROM warnings OR request->'plan'->'acknowledgedWarnings' IS DISTINCT FROM acknowledged THEN RAISE EXCEPTION 'Grouped retirement needs exact historical warning acknowledgements' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(w->'id' ORDER BY w->>'id'),'[]'::jsonb) INTO acknowledged FROM jsonb_array_elements(group_warnings) w;
  IF receipt."plan"->'groupWarnings' IS DISTINCT FROM group_warnings OR request->'acknowledgedGroupWarnings' IS DISTINCT FROM acknowledged THEN RAISE EXCEPTION 'Grouped retirement needs exact grouping warning acknowledgements' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a."id",'startedAt',import_group_assignment_iso(a."startedAt"),'endedAt',import_group_assignment_iso(a."endedAt"),'recipientType',a."recipientType",'personName',a."personName",'officeName',a."officeName",'assignmentType',a."assignmentType",'returnStatus',a."returnStatus") ORDER BY a."id"),'[]'::jsonb) INTO assignments FROM "AssignmentEffective" a WHERE a."assetId"=asset."id";
  SELECT coalesce(jsonb_agg(jsonb_build_object('batchId',r."batchId",'revision',r."revision",'changes',(SELECT jsonb_agg(jsonb_build_object('candidateId',c->>'candidateId')) FROM jsonb_array_elements(r."changes") c)) ORDER BY r."batchId",r."revision"),'[]'::jsonb) INTO revisions FROM "ImportSourceRevision" r WHERE r."batchId" IN (SELECT c."batchId" FROM "ImportHistoryCapture" c JOIN "ImportHistoricalEvidence" e ON e."captureId"=c."id" WHERE e."sourceHash"=receipt."sourceHash" AND e."recordId" IN (SELECT value->>'recordId' FROM jsonb_array_elements(selected_group->'observations')));
  IF NOT ((receipt."plan" @> '{"scope":"GROUP_HISTORICAL_RETIREMENT_PLAN","rulesVersion":"mda-group-retirement-plan-1","mode":"GROUP_RETIREMENT_REVIEW_ONLY","persisted":false,"canApply":false,"affectsCurrentState":false,"evidenceRelinked":false,"operationalHistoryApplied":false,"retirementApplicationImplemented":false,"planValidationComplete":true,"blockers":[],"sourceRetirement":{"effectiveAt":null,"datePrecision":"UNKNOWN","historicalActorId":null}}'::jsonb) IS TRUE)
    OR receipt."plan"->>'planId' IS DISTINCT FROM receipt."planId" OR receipt."planId" IS DISTINCT FROM import_group_assignment_digest(receipt."plan"-ARRAY['planId','mode','persisted','canApply','affectsCurrentState','evidenceRelinked','operationalHistoryApplied','retirementApplicationImplemented','planValidationComplete','summary'])
    OR receipt."plan"->>'batchId' IS DISTINCT FROM batch."id"::text OR receipt."plan"->>'reviewId' IS DISTINCT FROM review."id"::text OR receipt."plan"->>'groupId' IS DISTINCT FROM receipt."groupId"::text OR receipt."plan"->>'groupKey' IS DISTINCT FROM receipt."groupKey" OR receipt."plan"->>'sourceHash' IS DISTINCT FROM receipt."sourceHash" OR receipt."plan"->>'decisionId' IS DISTINCT FROM decision."id"::text
    OR receipt."plan"->>'decisionVersion' IS DISTINCT FROM request->>'expectedDecisionVersion' OR receipt."plan"->>'decisionProofDigest' IS DISTINCT FROM import_group_assignment_digest(to_jsonb(decision)||jsonb_build_object('createdAt',import_group_assignment_iso(decision."createdAt")))
    OR receipt."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(receipt."appliedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago','YYYY-MM-DD') OR receipt."plan"->>'timeZone' IS DISTINCT FROM 'America/Santiago'
    OR receipt."plan"->>'currentAssignmentsDigest' IS DISTINCT FROM import_group_assignment_digest(assignments) OR receipt."plan"->>'sourceRevisionsDigest' IS DISTINCT FROM import_group_assignment_digest(revisions) OR receipt."plan"->'consumedSourceRows' IS DISTINCT FROM '[]'::jsonb
    OR receipt."plan"->'proposedRetirement' IS DISTINCT FROM jsonb_build_object('assetId',asset."id",'status','DECOMMISSIONED','isActive',false,'decommissionedAt',import_group_assignment_iso(receipt."decommissionedAt"),'historicalActorId',NULL)
    OR receipt."requestDigest" IS DISTINCT FROM import_group_assignment_digest(jsonb_build_object('requestId',receipt."requestId",'planId',receipt."planId",'confirmation','APPLY_GROUP_VERIFIED_HISTORICAL_RETIREMENT','plan',request)) THEN
    RAISE EXCEPTION 'Grouped retirement requires exact reviewed plan, context, decision proof and confirmed intent' USING ERRCODE='23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_group_retirement() RETURNS trigger AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Grouped retirement receipts are immutable' USING ERRCODE='23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  PERFORM 1 FROM "ImportBatch" WHERE "id"=NEW."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."sourceHash",0));
  LOCK TABLE "Product", "Asset", "Assignment", "ImportHistoricalEvidence", "ImportHistoryCapture", "ImportEvidenceAmendment", "ImportIdentityGroupReview", "ImportIdentityGroupRow", "ImportIdentityGroupRelease", "ImportIdentityGroupDecision", "ImportSourceRevision", "ImportIdentityGroupRowUse", "ImportGroupRetirementApplication", "ImportGroupRetirementRowUse" IN EXCLUSIVE MODE NOWAIT;
  PERFORM 1 FROM "Asset" WHERE "id"=NEW."assetId" FOR UPDATE;
  PERFORM 1 FROM "User" WHERE "id"=NEW."appliedById" FOR SHARE;
  PERFORM assert_import_group_retirement(NEW,false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupRetirementApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupRetirementApplication" FOR EACH ROW EXECUTE FUNCTION guard_import_group_retirement();
CREATE TRIGGER "ImportGroupRetirementApplication_truncate_guard" BEFORE TRUNCATE ON "ImportGroupRetirementApplication" FOR EACH STATEMENT EXECUTE FUNCTION guard_import_group_retirement();
CREATE FUNCTION guard_import_group_retirement_row() RETURNS trigger AS $$
DECLARE receipt "ImportGroupRetirementApplication"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Grouped retirement source consumption is immutable' USING ERRCODE='23514'; END IF;
  PERFORM assert_import_group_assignment_isolation();
  SELECT * INTO receipt FROM "ImportGroupRetirementApplication" WHERE "id"=NEW."applicationId";
  IF receipt."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR NEW."sourceHash" IS DISTINCT FROM receipt."sourceHash" OR NEW."reviewId" IS DISTINCT FROM receipt."reviewId"
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(receipt."plan"->'sourceRows') r WHERE r->>'recordId'=NEW."recordId" AND r->>'originalCandidateId'=NEW."originalCandidateId")
    OR EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash"=NEW."sourceHash" AND "recordId"=NEW."recordId") THEN
    RAISE EXCEPTION 'Grouped retirement consumption must be created with its exact receipt and source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupRetirementRowUse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupRetirementRowUse" FOR EACH ROW EXECUTE FUNCTION guard_import_group_retirement_row();
CREATE TRIGGER "ImportGroupRetirementRowUse_truncate_guard" BEFORE TRUNCATE ON "ImportGroupRetirementRowUse" FOR EACH STATEMENT EXECUTE FUNCTION guard_import_group_retirement_row();
CREATE FUNCTION verify_import_group_retirement_complete() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_group_retirement(NEW,true);
  IF (SELECT count(*) FROM "ImportGroupRetirementRowUse" WHERE "applicationId"=NEW."id")<>jsonb_array_length(NEW."plan"->'sourceRows')
    OR NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "entityType"='ImportGroupRetirementApplication' AND "entityId"=NEW."id"::text AND "action"='IMPORT_GROUP_RETIREMENT_APPLIED' AND "userId"=NEW."appliedById") THEN
    RAISE EXCEPTION 'Grouped retirement, complete source consumption and audit must commit together' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportGroupRetirementApplication_complete" AFTER INSERT ON "ImportGroupRetirementApplication" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_group_retirement_complete();
CREATE FUNCTION guard_group_retirement_asset() RETURNS trigger AS $$
DECLARE receipt "ImportGroupRetirementApplication"%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM "ImportGroupRetirementApplication" WHERE "assetId"=OLD."id";
  IF receipt."id" IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='DELETE' OR OLD."status"='DECOMMISSIONED' OR receipt."createdTransactionId" IS DISTINCT FROM pg_current_xact_id()::text OR NEW."status" IS DISTINCT FROM 'DECOMMISSIONED' OR NEW."isActive" OR NEW."decommissionedAt" IS DISTINCT FROM receipt."decommissionedAt" OR NEW."updatedAt" IS DISTINCT FROM receipt."appliedAt"
    OR (to_jsonb(NEW)-ARRAY['status','isActive','decommissionedAt','updatedAt']) IS DISTINCT FROM (receipt."assetSnapshot"-ARRAY['status','isActive','decommissionedAt','updatedAt']) THEN
    RAISE EXCEPTION 'Grouped imported retirement terminal state is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_group_retirement_guard" BEFORE UPDATE OR DELETE ON "Asset" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_asset();
CREATE FUNCTION guard_group_retirement_boundary() RETURNS trigger AS $$
DECLARE asset_id UUID; other_asset_id UUID; receipt "ImportGroupRetirementApplication"%ROWTYPE;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  IF TG_OP<>'DELETE' THEN asset_id:=NEW."assetId"; END IF;
  IF TG_OP<>'INSERT' THEN other_asset_id:=OLD."assetId"; END IF;
  PERFORM 1 FROM "Asset" WHERE "id" IN (asset_id,other_asset_id) ORDER BY "id" FOR UPDATE;
  FOR receipt IN SELECT * FROM "ImportGroupRetirementApplication" WHERE "assetId" IN (asset_id,other_asset_id) LOOP
    IF receipt."createdTransactionId"=pg_current_xact_id()::text OR (TG_OP<>'DELETE' AND NEW."assetId"=receipt."assetId" AND (NEW."endedAt" IS NULL OR NEW."endedAt">receipt."decommissionedAt")) THEN
      RAISE EXCEPTION 'Assignments cannot change with or extend beyond grouped retirement' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_group_retirement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Assignment" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_boundary();
CREATE FUNCTION guard_group_retirement_consumed_source() RETURNS trigger AS $$
DECLARE source_hash TEXT; record_id TEXT; candidate_id TEXT; review_id UUID;
BEGIN
  PERFORM assert_import_group_assignment_isolation();
  IF TG_TABLE_NAME='ImportEvidenceAmendment' THEN SELECT "sourceHash","recordId","candidateId" INTO source_hash,record_id,candidate_id FROM "ImportHistoricalEvidence" WHERE "id"=NEW."evidenceId";
  ELSIF TG_TABLE_NAME='ImportIdentityGroupRowUse' THEN source_hash:=NEW."sourceHash"; record_id:=NEW."recordId"; candidate_id:=NEW."originalCandidateId";
  ELSE review_id:=(to_jsonb(NEW)->>'reviewId')::uuid; END IF;
  IF source_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(source_hash,0));
    IF EXISTS (SELECT 1 FROM "ImportGroupRetirementRowUse" WHERE "sourceHash"=source_hash AND ("recordId"=record_id OR "originalCandidateId"=candidate_id)) THEN RAISE EXCEPTION 'Grouped retired source is permanently consumed' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication" WHERE "reviewId"=review_id AND "createdTransactionId"=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'Retirement review and decisions cannot change in their applying transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportEvidenceAmendment_group_retirement_guard" BEFORE INSERT ON "ImportEvidenceAmendment" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_consumed_source();
CREATE TRIGGER "ImportIdentityGroupRowUse_group_retirement_guard" BEFORE INSERT ON "ImportIdentityGroupRowUse" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_consumed_source();
CREATE TRIGGER "ImportIdentityGroupRelease_group_retirement_guard" BEFORE INSERT ON "ImportIdentityGroupRelease" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_consumed_source();
CREATE TRIGGER "ImportIdentityGroupDecision_group_retirement_guard" BEFORE INSERT ON "ImportIdentityGroupDecision" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_consumed_source();

CREATE FUNCTION guard_group_retirement_audit() RETURNS trigger AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication") THEN RAISE EXCEPTION 'Grouped retirement audit is immutable' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF OLD."entityType"='ImportGroupRetirementApplication' AND EXISTS (SELECT 1 FROM "ImportGroupRetirementApplication" WHERE "id"::text=OLD."entityId") THEN
    RAISE EXCEPTION 'Grouped retirement audit is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditLog_group_retirement_guard" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_group_retirement_audit();
CREATE TRIGGER "AuditLog_group_retirement_truncate_guard" BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION guard_group_retirement_audit();

COMMIT;
