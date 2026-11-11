BEGIN;

CREATE TABLE "ImportIdentityGroupReview" (
  "id" UUID PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "batchVersion" INTEGER NOT NULL CHECK ("batchVersion" >= 1),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "plan" JSONB NOT NULL,
  "reviewedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportIdentityGroupReview_plan_check" CHECK ((
    "plan" @> '{"scope":"PHYSICAL_IDENTITY_GROUP_PLAN","rulesVersion":"mda-identity-group-plan-1","proposalValidationComplete":true,"canApply":false,"persisted":false,"affectsCurrentState":false}'::jsonb AND
    "plan"->>'planId' = "planId" AND "plan"->>'sourceHash' = "sourceHash" AND "plan"->>'batchId' = "batchId"::text AND
    "plan"->>'batchVersion' = "batchVersion"::text AND "plan"->>'sourceRevision' = "sourceRevision"::text AND
    "plan"->'request'->>'confirmation' = 'REVIEW_PHYSICAL_IDENTITY_GROUPS' AND
    length(btrim(coalesce("plan"->'request'->>'note', ''))) BETWEEN 1 AND 2000 AND
    jsonb_typeof("plan"->'blockers') = 'array' AND jsonb_array_length("plan"->'blockers') = 0 AND
    jsonb_typeof("plan"->'observations') = 'array' AND jsonb_array_length("plan"->'observations') BETWEEN 1 AND 25 AND
    jsonb_typeof("plan"->'originalCandidates') = 'array' AND jsonb_array_length("plan"->'originalCandidates') BETWEEN 1 AND 25 AND
    jsonb_typeof("plan"->'proposedGroups') = 'array' AND jsonb_array_length("plan"->'proposedGroups') BETWEEN 1 AND 25
  ) IS TRUE)
);
CREATE UNIQUE INDEX "ImportIdentityGroupReview_batchId_requestId_key" ON "ImportIdentityGroupReview"("batchId", "requestId");
CREATE INDEX "ImportIdentityGroupReview_batchId_createdAt_id_idx" ON "ImportIdentityGroupReview"("batchId", "createdAt", "id");

CREATE TABLE "ImportIdentityGroupRow" (
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "recordId" VARCHAR(64) NOT NULL CHECK ("recordId" ~ '^[a-f0-9]{64}$'),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "originalCandidateId" VARCHAR(64) NOT NULL CHECK ("originalCandidateId" ~ '^[a-f0-9]{64}$'),
  "groupId" UUID NOT NULL,
  "snapshot" JSONB NOT NULL,
  "isReserved" BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY ("reviewId", "recordId")
);
CREATE INDEX "ImportIdentityGroupRow_sourceHash_recordId_idx" ON "ImportIdentityGroupRow"("sourceHash", "recordId");
CREATE UNIQUE INDEX "ImportIdentityGroupRow_active_source_record_key" ON "ImportIdentityGroupRow"("sourceHash", "recordId") WHERE "isReserved";
CREATE INDEX "ImportIdentityGroupRow_sourceHash_originalCandidateId_idx" ON "ImportIdentityGroupRow"("sourceHash", "originalCandidateId");

CREATE TABLE "ImportIdentityGroupRelease" (
  "id" UUID PRIMARY KEY,
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "note" VARCHAR(2000) NOT NULL CHECK (length(btrim("note")) BETWEEN 1 AND 2000),
  "releasedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportIdentityGroupRelease_reviewId_key" ON "ImportIdentityGroupRelease"("reviewId");

CREATE FUNCTION assert_import_identity_unreserved(source_hash TEXT, candidate_id TEXT, record_id TEXT) RETURNS void AS $$
BEGIN
  -- Advisory-lock revalidation needs a fresh statement snapshot after a competing commit.
  -- API mutation services use READ COMMITTED; snapshot-isolated direct writes fail closed.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Import identity reservation writes require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" r WHERE r."sourceHash" = source_hash AND
    (r."originalCandidateId" = candidate_id OR r."recordId" = record_id) AND
    NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" x WHERE x."reviewId" = r."reviewId")) THEN
    RAISE EXCEPTION 'Source belongs to an active identity grouping review' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_import_identity_group_review() RETURNS trigger AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE;
  actor "User"%ROWTYPE;
  observation JSONB;
  original_record JSONB;
  candidate JSONB;
  original_candidate JSONB;
  proposed_group JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Identity grouping reviews are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."reviewedById" FOR SHARE;
  IF actor."role" IS DISTINCT FROM 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL OR
    batch."version" IS DISTINCT FROM NEW."batchVersion" OR batch."sourceHash" IS DISTINCT FROM NEW."sourceHash" OR
    (SELECT count(*) FROM "ImportSourceRevision" WHERE "batchId" = NEW."batchId") <> NEW."sourceRevision" OR
    NEW."createdAt" > clock_timestamp() AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Identity review requires current source/version and configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(DISTINCT value->>'recordId') FROM jsonb_array_elements(NEW."plan"->'observations')) <> jsonb_array_length(NEW."plan"->'observations') OR
    (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(NEW."plan"->'originalCandidates')) <> jsonb_array_length(NEW."plan"->'originalCandidates') OR
    (SELECT count(DISTINCT value->>'groupId') FROM jsonb_array_elements(NEW."plan"->'proposedGroups')) <> jsonb_array_length(NEW."plan"->'proposedGroups') THEN
    RAISE EXCEPTION 'Identity review requires distinct observations, candidates and groups' USING ERRCODE = '23514';
  END IF;
  FOR candidate IN SELECT value FROM jsonb_array_elements(NEW."plan"->'originalCandidates') LOOP
    SELECT value INTO original_candidate FROM jsonb_array_elements(batch."preview"->'candidates') WHERE value->>'id' = candidate->>'candidateId';
    IF NOT FOUND OR jsonb_typeof(candidate->'recordIds') IS DISTINCT FROM 'array' OR
      jsonb_array_length(candidate->'recordIds') <> jsonb_array_length(original_candidate->'recordIds') OR
      NOT ((candidate->'recordIds') @> (original_candidate->'recordIds') AND (original_candidate->'recordIds') @> (candidate->'recordIds')) OR
      (SELECT count(*) FROM jsonb_array_elements(NEW."plan"->'observations') o WHERE o->>'originalCandidateId' = candidate->>'candidateId') <> jsonb_array_length(candidate->'recordIds') THEN
      RAISE EXCEPTION 'Identity review must preserve complete original candidate membership' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR proposed_group IN SELECT value FROM jsonb_array_elements(NEW."plan"->'proposedGroups') LOOP
    IF jsonb_typeof(proposed_group->'recordIds') IS DISTINCT FROM 'array' OR jsonb_array_length(proposed_group->'recordIds') NOT BETWEEN 1 AND 25 OR
      (SELECT count(*) FROM jsonb_array_elements(NEW."plan"->'observations') o WHERE o->>'proposedGroupId' = proposed_group->>'groupId') <> jsonb_array_length(proposed_group->'recordIds') OR
      length(btrim(coalesce(proposed_group->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'Identity groups require exact membership and verification reference' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR observation IN SELECT value FROM jsonb_array_elements(NEW."plan"->'observations') LOOP
    SELECT value INTO original_record FROM jsonb_array_elements(batch."preview"->'records') WHERE value->>'id' = observation->>'recordId';
    IF NOT FOUND OR original_record->>'kind' NOT IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY') OR
      observation->>'sheet' IS DISTINCT FROM original_record->>'sheet' OR observation->>'row' IS DISTINCT FROM original_record->>'row' OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."plan"->'originalCandidates') c
        WHERE c->>'candidateId' = observation->>'originalCandidateId' AND c->'recordIds' ? (observation->>'recordId')) OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."plan"->'proposedGroups') g
        WHERE g->>'groupId' = observation->>'proposedGroupId' AND g->'recordIds' ? (observation->>'recordId')) THEN
      RAISE EXCEPTION 'Identity review requires original physical row lineage' USING ERRCODE = '23514';
    END IF;
    PERFORM assert_import_identity_unreserved(NEW."sourceHash", observation->>'originalCandidateId', observation->>'recordId');
    IF EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "sourceHash" = NEW."sourceHash" AND "candidateId" = observation->>'originalCandidateId') OR
      EXISTS (SELECT 1 FROM "ImportHistoricalEvidence" e WHERE e."sourceHash" = NEW."sourceHash" AND e."recordId" = observation->>'recordId' AND (
        EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" u WHERE u."evidenceId" = e."id") OR
        EXISTS (SELECT 1 FROM "ImportAssignmentItem" i WHERE i."startEvidenceId" = e."id" OR i."endEvidenceId" = e."id") OR
        EXISTS (SELECT 1 FROM "ImportRetirementApplication" a WHERE a."evidenceId" = e."id"))) THEN
      RAISE EXCEPTION 'Applied source lineage cannot be regrouped' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupReview_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupReview"
FOR EACH ROW EXECUTE FUNCTION guard_import_identity_group_review();

CREATE FUNCTION guard_import_identity_group_row() RETURNS trigger AS $$
DECLARE review "ImportIdentityGroupReview"%ROWTYPE; observation JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."isReserved" AND NOT NEW."isReserved" AND
    (to_jsonb(NEW) - 'isReserved') = (to_jsonb(OLD) - 'isReserved') AND
    EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId" = OLD."reviewId") THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Identity grouping row provenance is immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id" = NEW."reviewId";
  PERFORM pg_advisory_xact_lock(hashtextextended(review."sourceHash", 0));
  SELECT value INTO observation FROM jsonb_array_elements(review."plan"->'observations') WHERE value->>'recordId' = NEW."recordId";
  IF NOT FOUND OR NOT NEW."isReserved" OR NEW."sourceHash" IS DISTINCT FROM review."sourceHash" OR NEW."snapshot" IS DISTINCT FROM observation OR
    NEW."originalCandidateId" IS DISTINCT FROM observation->>'originalCandidateId' OR NEW."groupId"::text IS DISTINCT FROM observation->>'proposedGroupId' OR
    EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId" = NEW."reviewId") OR
    EXISTS (SELECT 1 FROM "ImportIdentityGroupRow" r WHERE r."sourceHash" = NEW."sourceHash" AND r."reviewId" <> NEW."reviewId" AND
      (r."recordId" = NEW."recordId" OR r."originalCandidateId" = NEW."originalCandidateId") AND
      NOT EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" x WHERE x."reviewId" = r."reviewId")) THEN
    RAISE EXCEPTION 'Identity grouping row must match its unique active review provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupRow_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupRow"
FOR EACH ROW EXECUTE FUNCTION guard_import_identity_group_row();

CREATE FUNCTION verify_import_identity_group_complete() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId" = NEW."id") <> jsonb_array_length(NEW."plan"->'observations') THEN
    RAISE EXCEPTION 'Every reviewed observation requires immutable row provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportIdentityGroupReview_complete_guard" AFTER INSERT ON "ImportIdentityGroupReview"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_identity_group_complete();

CREATE FUNCTION guard_import_identity_group_release() RETURNS trigger AS $$
DECLARE review "ImportIdentityGroupReview"%ROWTYPE; actor "User"%ROWTYPE; source_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Identity grouping releases are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id" = NEW."reviewId";
  SELECT "sourceHash" INTO source_hash FROM "ImportBatch" WHERE "id" = review."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."releasedById" FOR SHARE;
  IF review."id" IS NULL OR actor."role" IS DISTINCT FROM 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL OR
    NEW."createdAt" > clock_timestamp() AT TIME ZONE 'UTC' OR
    (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId" = review."id") <> jsonb_array_length(review."plan"->'observations') THEN
    RAISE EXCEPTION 'Release requires complete review and configured JEFE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupRelease_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupRelease"
FOR EACH ROW EXECUTE FUNCTION guard_import_identity_group_release();

CREATE FUNCTION release_import_identity_group_rows() RETURNS trigger AS $$
BEGIN
  UPDATE "ImportIdentityGroupRow" SET "isReserved" = false WHERE "reviewId" = NEW."reviewId";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupRelease_rows" AFTER INSERT ON "ImportIdentityGroupRelease"
FOR EACH ROW EXECUTE FUNCTION release_import_identity_group_rows();

CREATE FUNCTION guard_import_legacy_identity_reservation() RETURNS trigger AS $$
DECLARE source_hash TEXT; entry JSONB; evidence "ImportHistoricalEvidence"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME IN ('ImportApplication', 'ImportApplicationItem') THEN
    source_hash := NEW."sourceHash";
    PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
    IF TG_TABLE_NAME = 'ImportApplicationItem' THEN
      PERFORM assert_import_identity_unreserved(source_hash, NEW."candidateId", NULL);
    ELSE
      FOR entry IN SELECT value FROM jsonb_array_elements(NEW."plan"->'operations') LOOP
        PERFORM assert_import_identity_unreserved(source_hash, entry->>'candidateId', NULL);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ImportSourceRevision' THEN
    SELECT "sourceHash" INTO source_hash FROM "ImportBatch" WHERE "id" = NEW."batchId";
    PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
    FOR entry IN SELECT value FROM jsonb_array_elements(NEW."changes") LOOP
      PERFORM assert_import_identity_unreserved(source_hash, entry->>'candidateId', entry->>'recordId');
    END LOOP;
  ELSE
    FOR evidence IN SELECT * FROM "ImportHistoricalEvidence" WHERE "id" IN (
      CASE WHEN TG_TABLE_NAME = 'ImportAssignmentItem' THEN (to_jsonb(NEW)->>'startEvidenceId')::uuid ELSE (to_jsonb(NEW)->>'evidenceId')::uuid END,
      (to_jsonb(NEW)->>'endEvidenceId')::uuid) ORDER BY "sourceHash", "id" LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(evidence."sourceHash", 0));
      PERFORM assert_import_identity_unreserved(evidence."sourceHash", evidence."candidateId", evidence."recordId");
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportApplication_identity_group_guard" BEFORE INSERT ON "ImportApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_legacy_identity_reservation();
CREATE TRIGGER "ImportApplicationItem_identity_group_guard" BEFORE INSERT ON "ImportApplicationItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_legacy_identity_reservation();
CREATE TRIGGER "ImportSourceRevision_identity_group_guard" BEFORE INSERT ON "ImportSourceRevision"
FOR EACH ROW EXECUTE FUNCTION guard_import_legacy_identity_reservation();
CREATE TRIGGER "ImportAssignmentItem_00_identity_group_guard" BEFORE INSERT ON "ImportAssignmentItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_legacy_identity_reservation();
CREATE TRIGGER "ImportRetirementApplication_identity_group_guard" BEFORE INSERT ON "ImportRetirementApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_legacy_identity_reservation();

COMMIT;
