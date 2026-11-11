BEGIN;

CREATE TABLE "ImportGroupHistoryApplication" (
  "id" UUID PRIMARY KEY,
  "itemId" UUID NOT NULL REFERENCES "ImportIdentityGroupApplicationItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-group-history-link-application-1'),
  "plan" JSONB NOT NULL,
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("plan" @> '{"scope":"IDENTITY_GROUP_HISTORY_LINK_PLAN","rulesVersion":"mda-group-history-link-plan-2","planValidationComplete":true,"persisted":false,"canApply":false,"affectsCurrentState":false,"evidenceRelinked":false}'::jsonb
    AND "plan"->>'historyLinkPlanId' = "planId" AND "plan"->>'itemId' = "itemId"::text
    AND jsonb_typeof("plan"->'operations') = 'array' AND jsonb_array_length("plan"->'operations') BETWEEN 1 AND 25) IS TRUE)
);
CREATE UNIQUE INDEX "ImportGroupHistoryApplication_planId_key" ON "ImportGroupHistoryApplication"("planId");
CREATE UNIQUE INDEX "ImportGroupHistoryApplication_itemId_requestId_key" ON "ImportGroupHistoryApplication"("itemId", "requestId");
CREATE INDEX "ImportGroupHistoryApplication_itemId_appliedAt_id_idx" ON "ImportGroupHistoryApplication"("itemId", "appliedAt", "id");

CREATE TABLE "ImportGroupHistoryLink" (
  "id" UUID PRIMARY KEY,
  "historyApplicationId" UUID NOT NULL REFERENCES "ImportGroupHistoryApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" = 1),
  "evidenceVersion" INTEGER NOT NULL CHECK ("evidenceVersion" BETWEEN 0 AND 1000),
  "amendmentId" UUID REFERENCES "ImportEvidenceAmendment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "operation" JSONB NOT NULL,
  "projection" JSONB NOT NULL
);
CREATE UNIQUE INDEX "ImportGroupHistoryLink_evidenceId_key" ON "ImportGroupHistoryLink"("evidenceId");
CREATE INDEX "ImportGroupHistoryLink_historyApplicationId_idx" ON "ImportGroupHistoryLink"("historyApplicationId");
CREATE INDEX "ImportGroupHistoryLink_assetId_id_idx" ON "ImportGroupHistoryLink"("assetId", "id");

CREATE FUNCTION guard_import_group_history_application() RETURNS trigger AS $$
DECLARE item "ImportIdentityGroupApplicationItem"%ROWTYPE; application "ImportIdentityGroupApplication"%ROWTYPE;
  actor "User"%ROWTYPE; current_asset "Asset"%ROWTYPE; current_product "Product"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group history receipts are immutable' USING ERRCODE = '23514'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Group history writes require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = NEW."itemId";
  SELECT * INTO application FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  PERFORM 1 FROM "ImportBatch" WHERE "id" = application."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(application."sourceHash", 0));
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."appliedById" FOR SHARE;
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = item."assetId" FOR SHARE;
  SELECT * INTO current_product FROM "Product" WHERE "id" = current_asset."productId" FOR SHARE;
  IF item."id" IS NULL OR actor."role" IS DISTINCT FROM 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL
    OR NEW."plan"->>'batchId' IS DISTINCT FROM application."batchId"::text
    OR NEW."plan"->>'reviewId' IS DISTINCT FROM application."reviewId"::text
    OR NEW."plan"->>'applicationId' IS DISTINCT FROM application."id"::text
    OR NEW."plan"->>'applicationPlanId' IS DISTINCT FROM application."planId"
    OR NEW."plan"->>'groupKey' IS DISTINCT FROM item."groupKey" OR NEW."plan"->>'groupId' IS DISTINCT FROM item."groupId"::text
    OR NEW."plan"->>'sourceHash' IS DISTINCT FROM application."sourceHash"
    OR current_product."trackingMode" IS DISTINCT FROM 'ASSET'
    OR current_asset."productId"::text IS DISTINCT FROM item."result"->>'productId'
    OR import_identifier_key(current_asset."serialNumber") IS DISTINCT FROM import_identifier_key(item."result"->>'serialNumber')
    OR import_identifier_key(current_asset."assetTag") IS DISTINCT FROM import_identifier_key(item."result"->>'assetTag')
    OR NEW."plan"->'asset'->>'id' IS DISTINCT FROM current_asset."id"::text
    OR NEW."plan"->'asset'->>'updatedAt' IS NULL
    OR (NEW."plan"->'asset'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM current_asset."updatedAt"
    OR NEW."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD')
    OR NEW."appliedAt" > clock_timestamp() AT TIME ZONE 'UTC'
    OR (SELECT count(DISTINCT op->>'evidenceId') FROM jsonb_array_elements(NEW."plan"->'operations') op) <> jsonb_array_length(NEW."plan"->'operations') THEN
    RAISE EXCEPTION 'Group history receipt requires exact applied group, current identity and configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM "ImportIdentityGroupRowUse" WHERE "itemId" = item."id") <> jsonb_array_length(item."operation"->'source')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(item."operation"->'source') r WHERE NOT EXISTS (
      SELECT 1 FROM "ImportIdentityGroupRowUse" u WHERE u."itemId" = item."id" AND u."sourceHash" = application."sourceHash"
        AND u."recordId" = r->>'recordId' AND u."originalCandidateId" = r->>'originalCandidateId' AND u."reviewId" = application."reviewId")) THEN
    RAISE EXCEPTION 'Group history requires complete permanent source consumption' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupHistoryApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupHistoryApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_history_application();

CREATE FUNCTION guard_import_group_history_link() RETURNS trigger AS $$
DECLARE receipt "ImportGroupHistoryApplication"%ROWTYPE; item "ImportIdentityGroupApplicationItem"%ROWTYPE;
  application "ImportIdentityGroupApplication"%ROWTYPE; evidence "ImportHistoricalEvidence"%ROWTYPE;
  current_evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE; capture "ImportHistoryCapture"%ROWTYPE;
  planned JSONB; expected_projection JSONB; identity_projection BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group history links are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO receipt FROM "ImportGroupHistoryApplication" WHERE "id" = NEW."historyApplicationId";
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = receipt."itemId";
  SELECT * INTO application FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  PERFORM pg_advisory_xact_lock(hashtextextended(application."sourceHash", 0));
  PERFORM 1 FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId" FOR NO KEY UPDATE;
  SELECT * INTO evidence FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  SELECT * INTO current_evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = NEW."evidenceId";
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
  SELECT op INTO planned FROM jsonb_array_elements(receipt."plan"->'operations') op WHERE op->>'evidenceId' = NEW."evidenceId"::text;
  IF planned IS NULL OR planned IS DISTINCT FROM NEW."operation" OR planned->>'action' IS DISTINCT FROM 'LINK_TO_APPLIED_GROUP'
    OR planned->'valid' IS DISTINCT FROM 'true'::jsonb OR planned->'blockers' IS DISTINCT FROM '[]'::jsonb
    OR planned->'historicalActorId' IS DISTINCT FROM 'null'::jsonb OR planned->'savedGroupLink' IS DISTINCT FROM 'null'::jsonb
    OR length(btrim(coalesce(planned->>'note', ''))) NOT BETWEEN 1 AND 2000
    OR length(btrim(coalesce(planned->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500
    OR evidence."sourceHash" IS DISTINCT FROM application."sourceHash" OR capture."sourceHash" IS DISTINCT FROM evidence."sourceHash"
    OR capture."rulesVersion" IS DISTINCT FROM 'mda-history-evidence-1'
    OR NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" u WHERE u."itemId" = item."id" AND u."sourceHash" = evidence."sourceHash"
      AND u."recordId" = evidence."recordId" AND u."originalCandidateId" = evidence."candidateId")
    OR NEW."assetId" IS DISTINCT FROM item."assetId" OR planned->>'proposedAssetId' IS DISTINCT FROM NEW."assetId"::text
    OR NEW."evidenceVersion" IS DISTINCT FROM current_evidence."evidenceVersion" OR NEW."amendmentId" IS DISTINCT FROM current_evidence."amendmentId"
    OR NEW."sourceRevision" IS DISTINCT FROM current_evidence."sourceRevision"
    OR planned->>'expectedEvidenceVersion' IS DISTINCT FROM NEW."evidenceVersion"::text
    OR planned->>'evidenceVersion' IS DISTINCT FROM NEW."evidenceVersion"::text
    OR planned->>'amendmentId' IS DISTINCT FROM NEW."amendmentId"::text
    OR planned->>'effectiveSourceRevision' IS DISTINCT FROM NEW."sourceRevision"::text
    OR planned->'originalSnapshot' IS DISTINCT FROM evidence."snapshot" OR planned->'currentSnapshot' IS DISTINCT FROM current_evidence."snapshot"
    OR planned->>'currentAssetId' IS DISTINCT FROM current_evidence."assetId"::text
    OR planned->>'effectiveDay' IS DISTINCT FROM current_evidence."effectiveDay"
    OR (current_evidence."assetId" IS NOT NULL AND current_evidence."assetId" <> NEW."assetId")
    OR EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id")
    OR EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = evidence."id")
    OR EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c
      WHERE r."batchId" = capture."batchId" AND r."revision" > current_evidence."sourceRevision" AND c->>'candidateId' = evidence."candidateId") THEN
    RAISE EXCEPTION 'Group history link requires exact current unused evidence and physical membership' USING ERRCODE = '23514';
  END IF;
  identity_projection := current_evidence."snapshot"->'effective'->>'serialKey' IS DISTINCT FROM import_identifier_key(item."result"->>'serialNumber')
    OR current_evidence."snapshot"->'effective'->>'tagKey' IS DISTINCT FROM import_identifier_key(item."result"->>'assetTag');
  IF (current_evidence."assetId" = NEW."assetId" AND NOT identity_projection)
    OR planned->'requiresIdentityProjection' IS DISTINCT FROM to_jsonb(identity_projection)
    OR planned->'proposedIdentity' IS DISTINCT FROM jsonb_build_object('serialNumber', item."result"->'serialNumber', 'assetTag', item."result"->'assetTag')
    OR (SELECT count(*) FROM jsonb_array_elements(planned->'warnings')) <> (CASE WHEN identity_projection THEN 1 ELSE 0 END)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(planned->'warnings') w WHERE w IS DISTINCT FROM jsonb_build_object(
      'code', 'GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED', 'id', encode(sha256(convert_to(
        '{"code":"GROUP_HISTORY_IDENTITY_PROJECTION_REQUIRED","evidenceId":"' || evidence."id"::text || '","evidenceVersion":' || NEW."evidenceVersion"::text || ',"itemId":"' || item."id"::text || '"}', 'UTF8')), 'hex')))
    OR (SELECT count(*) FROM jsonb_array_elements(planned->'acknowledgedWarnings')) <> (CASE WHEN identity_projection THEN 1 ELSE 0 END)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(planned->'warnings') w WHERE NOT (planned->'acknowledgedWarnings' @> jsonb_build_array(w->'id'))) THEN
    RAISE EXCEPTION 'Group history projection requires exact identity and explicit warning acknowledgement' USING ERRCODE = '23514';
  END IF;
  expected_projection := current_evidence."snapshot" || jsonb_build_object('assetId', NEW."assetId"::text, 'identityLinkBlocked', false,
    'linkBasis', jsonb_build_object('type', 'APPLIED_IDENTITY_GROUP', 'id', item."id"::text),
    'effective', current_evidence."snapshot"->'effective' || jsonb_build_object(
      'serialKey', import_identifier_key(item."result"->>'serialNumber'), 'tagKey', import_identifier_key(item."result"->>'assetTag'),
      'fields', current_evidence."snapshot"->'effective'->'fields' || jsonb_build_object('serialNumber', item."result"->'serialNumber', 'assetTag', item."result"->'assetTag')));
  IF NEW."projection" IS DISTINCT FROM expected_projection THEN
    RAISE EXCEPTION 'Group history projection cannot alter dates, actors, original data or unrelated fields' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportGroupHistoryLink_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportGroupHistoryLink"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_history_link();

CREATE FUNCTION verify_import_group_history_complete() RETURNS trigger AS $$
DECLARE item "ImportIdentityGroupApplicationItem"%ROWTYPE; current_asset "Asset"%ROWTYPE; current_product "Product"%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM "ImportGroupHistoryLink" WHERE "historyApplicationId" = NEW."id") <> jsonb_array_length(NEW."plan"->'operations') THEN
    RAISE EXCEPTION 'Every confirmed evidence requires exactly one immutable history link' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE "entityId" = NEW."id"::text AND "entityType" = 'ImportGroupHistoryApplication'
    AND "action" = 'IMPORT_GROUP_HISTORY_LINKS_SAVED' AND "userId" = NEW."appliedById") THEN
    RAISE EXCEPTION 'Group history confirmation requires its atomic audit record' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = NEW."itemId";
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = item."assetId";
  SELECT * INTO current_product FROM "Product" WHERE "id" = current_asset."productId";
  IF current_asset."productId"::text IS DISTINCT FROM NEW."plan"->'asset'->>'productId'
    OR import_identifier_key(current_asset."serialNumber") IS DISTINCT FROM import_identifier_key(item."result"->>'serialNumber')
    OR import_identifier_key(current_asset."assetTag") IS DISTINCT FROM import_identifier_key(item."result"->>'assetTag')
    OR current_asset."updatedAt" IS DISTINCT FROM (NEW."plan"->'asset'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC'
    OR current_product."trackingMode" IS DISTINCT FROM 'ASSET'
    OR current_product."updatedAt" IS DISTINCT FROM (NEW."plan"->'asset'->'product'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC'
    OR EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" l JOIN "ImportHistoricalEvidenceCurrent" e ON e."id" = l."evidenceId"
      WHERE l."historyApplicationId" = NEW."id" AND (l."evidenceVersion" IS DISTINCT FROM e."evidenceVersion" OR l."amendmentId" IS DISTINCT FROM e."amendmentId"
        OR l."sourceRevision" IS DISTINCT FROM e."sourceRevision" OR l."operation"->'currentSnapshot' IS DISTINCT FROM e."snapshot")) THEN
    RAISE EXCEPTION 'Group history context cannot change while constructing its receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportGroupHistoryApplication_complete_guard" AFTER INSERT ON "ImportGroupHistoryApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_group_history_complete();

CREATE FUNCTION guard_import_group_history_amendment() RETURNS trigger AS $$
DECLARE evidence "ImportHistoricalEvidence"%ROWTYPE; batch_id UUID;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Projected group evidence amendment checks require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO evidence FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  SELECT "batchId" INTO batch_id FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId";
  PERFORM 1 FROM "ImportBatch" WHERE "id" = batch_id FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(evidence."sourceHash", 0));
  IF EXISTS (SELECT 1 FROM "ImportGroupHistoryLink" WHERE "evidenceId" = NEW."evidenceId") THEN
    RAISE EXCEPTION 'Projected group evidence requires a separate history correction workflow' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportEvidenceAmendment_group_history_guard" BEFORE INSERT ON "ImportEvidenceAmendment"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_history_amendment();

COMMIT;
