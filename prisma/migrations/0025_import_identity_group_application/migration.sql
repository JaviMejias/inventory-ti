BEGIN;

CREATE TABLE "ImportIdentityGroupApplication" (
  "id" UUID PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "plan" JSONB NOT NULL,
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("plan" @> '{"scope":"IDENTITY_GROUP_ASSET_PILOT","planRulesVersion":"mda-identity-group-pilot-1","planValidationComplete":true,"canApply":false,"persisted":false,"affectsCurrentState":false,"evidenceRelinked":false}'::jsonb
    AND "plan"->>'planId' = "planId" AND "plan"->>'batchId' = "batchId"::text AND "plan"->>'reviewId' = "reviewId"::text
    AND "plan"->>'sourceHash' = "sourceHash" AND jsonb_typeof("plan"->'operations') = 'array'
    AND jsonb_array_length("plan"->'operations') BETWEEN 1 AND 25) IS TRUE)
);
CREATE UNIQUE INDEX "ImportIdentityGroupApplication_planId_key" ON "ImportIdentityGroupApplication"("planId");
CREATE UNIQUE INDEX "ImportIdentityGroupApplication_reviewId_requestId_key" ON "ImportIdentityGroupApplication"("reviewId", "requestId");
CREATE INDEX "ImportIdentityGroupApplication_reviewId_appliedAt_id_idx" ON "ImportIdentityGroupApplication"("reviewId", "appliedAt", "id");

CREATE TABLE "ImportIdentityGroupApplicationItem" (
  "id" UUID PRIMARY KEY,
  "applicationId" UUID NOT NULL REFERENCES "ImportIdentityGroupApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "groupKey" VARCHAR(64) NOT NULL CHECK ("groupKey" ~ '^[a-f0-9]{64}$'),
  "groupId" UUID NOT NULL,
  "decisionId" UUID NOT NULL REFERENCES "ImportIdentityGroupDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "operation" JSONB NOT NULL,
  "result" JSONB NOT NULL
);
CREATE UNIQUE INDEX "ImportIdentityGroupApplicationItem_applicationId_groupKey_key" ON "ImportIdentityGroupApplicationItem"("applicationId", "groupKey");
CREATE UNIQUE INDEX "ImportIdentityGroupApplicationItem_applicationId_assetId_key" ON "ImportIdentityGroupApplicationItem"("applicationId", "assetId");
CREATE INDEX "ImportIdentityGroupApplicationItem_assetId_idx" ON "ImportIdentityGroupApplicationItem"("assetId");

CREATE TABLE "ImportIdentityGroupRowUse" (
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "recordId" VARCHAR(64) NOT NULL CHECK ("recordId" ~ '^[a-f0-9]{64}$'),
  "originalCandidateId" VARCHAR(64) NOT NULL CHECK ("originalCandidateId" ~ '^[a-f0-9]{64}$'),
  "reviewId" UUID NOT NULL,
  "itemId" UUID NOT NULL REFERENCES "ImportIdentityGroupApplicationItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  PRIMARY KEY ("sourceHash", "recordId"),
  FOREIGN KEY ("reviewId", "recordId") REFERENCES "ImportIdentityGroupRow"("reviewId", "recordId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ImportIdentityGroupRowUse_reviewId_recordId_key" ON "ImportIdentityGroupRowUse"("reviewId", "recordId");
CREATE INDEX "ImportIdentityGroupRowUse_sourceHash_originalCandidateId_idx" ON "ImportIdentityGroupRowUse"("sourceHash", "originalCandidateId");
CREATE INDEX "ImportIdentityGroupRowUse_itemId_idx" ON "ImportIdentityGroupRowUse"("itemId");

CREATE FUNCTION assert_import_group_source_unconsumed(source_hash TEXT, candidate_id TEXT, record_id TEXT) RETURNS void AS $$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Import identity reservation writes require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  IF EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash" = source_hash
    AND ("originalCandidateId" = candidate_id OR "recordId" = record_id)) THEN
    RAISE EXCEPTION 'Source was already applied through a group pilot' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_import_identity_unreserved(source_hash TEXT, candidate_id TEXT, record_id TEXT) RETURNS void AS $$
BEGIN
  PERFORM assert_import_group_source_unconsumed(source_hash, candidate_id, record_id);
  IF EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" r WHERE r."sourceHash" = source_hash
    AND (r."originalCandidateId" = candidate_id OR r."recordId" = record_id)
    AND NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" x WHERE x."reviewId" = r."reviewId")) THEN
    RAISE EXCEPTION 'Source belongs to an active identity grouping review' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_group_reservation_consumption() RETURNS trigger AS $$
BEGIN
  PERFORM assert_import_group_source_unconsumed(NEW."sourceHash", NEW."originalCandidateId", NEW."recordId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupRow_00_consumption_guard" BEFORE INSERT ON "ImportIdentityGroupRow"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_reservation_consumption();

CREATE FUNCTION guard_import_group_application() RETURNS trigger AS $$
DECLARE review "ImportIdentityGroupReview"%ROWTYPE; batch "ImportBatch"%ROWTYPE; actor "User"%ROWTYPE;
  operation JSONB; verified_group JSONB; decision "ImportIdentityGroupDecision"%ROWTYPE; source_row "ImportIdentityGroupRow"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group application receipts are immutable' USING ERRCODE = '23514'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Group applications require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id" = NEW."reviewId";
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."appliedById" FOR SHARE;
  IF review."id" IS NULL OR review."batchId" IS DISTINCT FROM batch."id" OR review."sourceHash" IS DISTINCT FROM NEW."sourceHash"
    OR batch."sourceHash" IS DISTINCT FROM NEW."sourceHash" OR actor."role" IS DISTINCT FROM 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL
    OR EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId" = review."id")
    OR NEW."plan"->>'batchVersion' IS DISTINCT FROM batch."version"::text
    OR (NEW."plan"->>'sourceRevision')::integer IS DISTINCT FROM (SELECT count(*)::integer FROM "ImportSourceRevision" WHERE "batchId" = batch."id")
    OR (NEW."plan"->>'decisionVersion')::integer IS DISTINCT FROM (SELECT max("version") FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id")
    OR NEW."plan"->>'checkedAsOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD')
    OR NEW."appliedAt" > clock_timestamp() AT TIME ZONE 'UTC'
    OR (SELECT count(DISTINCT value->>'groupKey') FROM jsonb_array_elements(NEW."plan"->'operations')) <> jsonb_array_length(NEW."plan"->'operations') THEN
    RAISE EXCEPTION 'Group application requires active review, current versions and configured JEFE' USING ERRCODE = '23514';
  END IF;
  FOR operation IN SELECT value FROM jsonb_array_elements(NEW."plan"->'operations') LOOP
    SELECT * INTO decision FROM "ImportIdentityGroupDecision" WHERE "id" = (operation->>'decisionId')::uuid;
    SELECT value INTO verified_group FROM jsonb_array_elements(review."plan"->'proposedGroups') WHERE value->>'groupId' = operation->>'groupId';
    IF decision."id" IS NULL OR decision."reviewId" IS DISTINCT FROM review."id" OR decision."groupKey" IS DISTINCT FROM operation->>'groupKey'
      OR decision."groupId"::text IS DISTINCT FROM operation->>'groupId' OR decision."projectionId" IS DISTINCT FROM NEW."plan"->>'projectionId'
      OR decision."id" IS DISTINCT FROM (SELECT "id" FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id" AND "groupKey" = decision."groupKey" ORDER BY "version" DESC LIMIT 1)
      OR operation->'valid' IS DISTINCT FROM 'true'::jsonb OR operation->'blockers' IS DISTINCT FROM '[]'::jsonb
      OR NOT ((operation->>'type' = 'CREATE_ASSET' AND decision."action" = 'PROPOSE_NEW' AND operation->>'confirmation' = 'AVAILABLE_UNASSIGNED')
        OR (operation->>'type' = 'UPDATE_METADATA' AND decision."action" = 'LINK_EXISTING' AND decision."linkedAssetId"::text = operation->>'assetId')) THEN
      RAISE EXCEPTION 'Group application requires latest exact operational decision' USING ERRCODE = '23514';
    END IF;
    IF verified_group IS NULL OR (operation->>'type' = 'CREATE_ASSET' AND (
      import_identifier_key(operation->'values'->>'serialNumber') IS DISTINCT FROM import_identifier_key(verified_group->>'serialNumber')
      OR import_identifier_key(operation->'values'->>'assetTag') IS DISTINCT FROM import_identifier_key(verified_group->>'assetTag')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(operation->'source') r WHERE r->>'statusEvidence' IS DISTINCT FROM 'AVAILABLE'
        OR r->>'kind' = 'RETIREMENT_HISTORY'
        OR EXISTS (SELECT 1 FROM unnest(ARRAY['recipientText','officeText','loanCode','loanDate','usedDate','outgoingTicket','outgoingOt','details']) f
          WHERE import_identifier_key(r->'fields'->>f) IS NOT NULL)))) THEN
      RAISE EXCEPTION 'New group asset requires exact verified identity and available unused source' USING ERRCODE = '23514';
    END IF;
    FOR source_row IN SELECT * FROM "ImportIdentityGroupRow" WHERE "reviewId" = review."id" AND "groupId" = decision."groupId" LOOP
      IF NOT source_row."isReserved" OR EXISTS (SELECT 1 FROM "ImportIdentityGroupRowUse" WHERE "sourceHash" = NEW."sourceHash" AND "recordId" = source_row."recordId")
        OR EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "sourceHash" = NEW."sourceHash" AND "candidateId" = source_row."originalCandidateId")
        OR EXISTS (SELECT 1 FROM "ImportHistoricalEvidence" e WHERE e."sourceHash" = NEW."sourceHash" AND e."recordId" = source_row."recordId" AND
          (EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = e."id") OR EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = e."id"))) THEN
        RAISE EXCEPTION 'Group source must be reserved and unused by all importers' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF jsonb_typeof(operation->'source') IS DISTINCT FROM 'array' OR jsonb_typeof(operation->'deduplication') IS DISTINCT FROM 'array'
      OR jsonb_array_length(operation->'source') <> (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId" = review."id" AND "groupId" = decision."groupId")
      OR jsonb_array_length(operation->'source') NOT BETWEEN 1 AND 25
      OR (SELECT count(DISTINCT r->>'recordId') FROM jsonb_array_elements(operation->'source') r) <> jsonb_array_length(operation->'source')
      OR jsonb_array_length(operation->'deduplication') <> jsonb_array_length(operation->'source') THEN
      RAISE EXCEPTION 'Group application must retain complete source membership' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_application();

CREATE FUNCTION guard_import_group_application_item() RETURNS trigger AS $$
DECLARE application "ImportIdentityGroupApplication"%ROWTYPE; planned JSONB; current_asset "Asset"%ROWTYPE; product "Product"%ROWTYPE; field TEXT; field_value JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Group application items are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO application FROM "ImportIdentityGroupApplication" WHERE "id" = NEW."applicationId";
  SELECT value INTO planned FROM jsonb_array_elements(application."plan"->'operations') WHERE value->>'groupKey' = NEW."groupKey";
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  SELECT * INTO product FROM "Product" WHERE "id" = current_asset."productId" FOR SHARE;
  IF planned IS NULL OR NEW."operation" IS DISTINCT FROM planned OR NEW."groupId"::text IS DISTINCT FROM planned->>'groupId'
    OR NEW."decisionId"::text IS DISTINCT FROM planned->>'decisionId' OR current_asset."id" IS NULL OR NOT current_asset."isActive"
    OR current_asset."status" = 'DECOMMISSIONED' OR product."trackingMode" IS DISTINCT FROM 'ASSET' OR NOT product."isActive"
    OR product."id"::text IS DISTINCT FROM planned->'product'->>'id'
    OR product."updatedAt" IS DISTINCT FROM (planned->'product'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC'
    OR (NEW."result" - ARRAY['product','importRetirement','createdAt','updatedAt','decommissionedAt']) IS DISTINCT FROM (to_jsonb(current_asset) - ARRAY['createdAt','updatedAt','decommissionedAt']) THEN
    RAISE EXCEPTION 'Group item must retain exact plan, product and asset result' USING ERRCODE = '23514';
  END IF;
  IF planned->>'type' = 'CREATE_ASSET' THEN
    IF current_asset."status" <> 'AVAILABLE' OR current_asset."createdAt" < application."appliedAt" OR current_asset."decommissionedAt" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "Assignment" WHERE "assetId" = current_asset."id") THEN
      RAISE EXCEPTION 'New group asset must be available and unassigned' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF current_asset."id"::text IS DISTINCT FROM planned->>'assetId' OR current_asset."productId"::text IS DISTINCT FROM planned->'before'->>'productId'
      OR current_asset."serialNumber" IS DISTINCT FROM planned->'before'->>'serialNumber' OR current_asset."assetTag" IS DISTINCT FROM planned->'before'->>'assetTag'
      OR current_asset."status"::text IS DISTINCT FROM planned->'before'->>'status' THEN
      RAISE EXCEPTION 'Metadata application cannot change identity or operational state' USING ERRCODE = '23514';
    END IF;
  END IF;
  FOR field, field_value IN SELECT entry.k, entry.v FROM jsonb_each(planned->'values') entry(k,v) LOOP
    IF field <> 'productId' AND planned->>'type' = 'UPDATE_METADATA' AND field NOT IN ('technicalCondition','usagePurpose','location','sector','ipAddress','hostname','loanCode','notes') THEN
      RAISE EXCEPTION 'Group metadata fields are restricted' USING ERRCODE = '23514';
    END IF;
    IF to_jsonb(current_asset)->field IS DISTINCT FROM field_value THEN RAISE EXCEPTION 'Asset values differ from confirmed group plan' USING ERRCODE = '23514'; END IF;
  END LOOP;
  IF planned->>'type' = 'UPDATE_METADATA' THEN
    FOREACH field IN ARRAY ARRAY['technicalCondition','usagePurpose','location','sector','ipAddress','hostname','loanCode','notes'] LOOP
      IF NOT (planned->'values' ? field) AND to_jsonb(current_asset)->field IS DISTINCT FROM planned->'before'->field THEN
        RAISE EXCEPTION 'Unselected metadata must remain unchanged' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupApplicationItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupApplicationItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_application_item();

CREATE FUNCTION guard_import_group_row_use() RETURNS trigger AS $$
DECLARE item "ImportIdentityGroupApplicationItem"%ROWTYPE; application "ImportIdentityGroupApplication"%ROWTYPE; source_row "ImportIdentityGroupRow"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Consumed group rows are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO item FROM "ImportIdentityGroupApplicationItem" WHERE "id" = NEW."itemId";
  SELECT * INTO application FROM "ImportIdentityGroupApplication" WHERE "id" = item."applicationId";
  PERFORM pg_advisory_xact_lock(hashtextextended(application."sourceHash", 0));
  SELECT * INTO source_row FROM "ImportIdentityGroupRow" WHERE "reviewId" = NEW."reviewId" AND "recordId" = NEW."recordId";
  IF source_row."reviewId" IS NULL OR NOT source_row."isReserved" OR application."reviewId" IS DISTINCT FROM NEW."reviewId"
    OR application."sourceHash" IS DISTINCT FROM NEW."sourceHash" OR source_row."sourceHash" IS DISTINCT FROM NEW."sourceHash"
    OR source_row."originalCandidateId" IS DISTINCT FROM NEW."originalCandidateId" OR source_row."groupId" IS DISTINCT FROM item."groupId"
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(item."operation"->'source') r WHERE r->>'recordId' = NEW."recordId" AND r->>'originalCandidateId' = NEW."originalCandidateId")
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(item."operation"->'deduplication') r WHERE r->>'recordId' = NEW."recordId" AND r->>'sourceHash' = NEW."sourceHash"
      AND r->>'key' = encode(sha256(convert_to('["IMPORT_SOURCE_ROW","' || NEW."sourceHash" || '","' || NEW."recordId" || '"]', 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'Consumed row must retain exact source and group membership' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupRowUse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupRowUse"
FOR EACH ROW EXECUTE FUNCTION guard_import_group_row_use();

CREATE FUNCTION verify_import_group_application_complete() RETURNS trigger AS $$
DECLARE item "ImportIdentityGroupApplicationItem"%ROWTYPE; current_asset "Asset"%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM "ImportIdentityGroupApplicationItem" WHERE "applicationId" = NEW."id") <> jsonb_array_length(NEW."plan"->'operations') THEN
    RAISE EXCEPTION 'Every planned group requires one operational receipt' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT * FROM "ImportIdentityGroupApplicationItem" WHERE "applicationId" = NEW."id" LOOP
    SELECT * INTO current_asset FROM "Asset" WHERE "id" = item."assetId";
    IF (item."result" - ARRAY['product','importRetirement','createdAt','updatedAt','decommissionedAt']) IS DISTINCT FROM (to_jsonb(current_asset) - ARRAY['createdAt','updatedAt','decommissionedAt']) THEN
      RAISE EXCEPTION 'Applied asset result cannot change while constructing a receipt' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM "ImportIdentityGroupRowUse" WHERE "itemId" = item."id") <> jsonb_array_length(item."operation"->'source') THEN
      RAISE EXCEPTION 'Every applied observation requires global consumption provenance' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportIdentityGroupApplication_complete_guard" AFTER INSERT ON "ImportIdentityGroupApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_group_application_complete();

COMMIT;
