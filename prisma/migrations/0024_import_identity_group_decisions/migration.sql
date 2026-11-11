BEGIN;

CREATE TABLE "ImportIdentityGroupDecision" (
  "id" UUID PRIMARY KEY,
  "reviewId" UUID NOT NULL REFERENCES "ImportIdentityGroupReview"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" >= 1),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-identity-group-decision-1'),
  "groupId" UUID NOT NULL,
  "groupKey" VARCHAR(64) NOT NULL CHECK ("groupKey" ~ '^[a-f0-9]{64}$'),
  "batchVersion" INTEGER NOT NULL CHECK ("batchVersion" >= 1),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "projectionId" VARCHAR(64) NOT NULL CHECK ("projectionId" ~ '^[a-f0-9]{64}$'),
  "projection" JSONB NOT NULL,
  "action" "ImportReviewAction" NOT NULL,
  "linkedAssetId" UUID REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "note" VARCHAR(2000) NOT NULL CHECK (length(btrim("note")) BETWEEN 1 AND 2000),
  "evidenceReference" VARCHAR(500) NOT NULL CHECK (length(btrim("evidenceReference")) BETWEEN 1 AND 500),
  "evidenceReviews" JSONB NOT NULL CHECK (jsonb_typeof("evidenceReviews") = 'array' AND jsonb_array_length("evidenceReviews") <= 100),
  "reviewedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("action" = 'LINK_EXISTING') = ("linkedAssetId" IS NOT NULL)),
  CHECK ((
    "projection" @> '{"scope":"IDENTITY_GROUP_EFFECTIVE_PREVIEW","rulesVersion":"mda-identity-group-projection-1","canApply":false,"persisted":false,"reviewPersisted":true,"affectsCurrentState":false,"groupedPilotImplemented":false}'::jsonb AND
    "projection"->>'reviewId' = "reviewId"::text AND "projection"->>'projectionId' = "projectionId" AND
    "projection"->>'batchVersion' = "batchVersion"::text AND "projection"->>'sourceRevision' = "sourceRevision"::text AND
    jsonb_typeof("projection"->'groups') = 'array' AND jsonb_array_length("projection"->'groups') BETWEEN 1 AND 25
  ) IS TRUE)
);
CREATE UNIQUE INDEX "ImportIdentityGroupDecision_reviewId_requestId_key" ON "ImportIdentityGroupDecision"("reviewId", "requestId");
CREATE UNIQUE INDEX "ImportIdentityGroupDecision_reviewId_version_key" ON "ImportIdentityGroupDecision"("reviewId", "version");
CREATE INDEX "ImportIdentityGroupDecision_reviewId_groupKey_version_idx" ON "ImportIdentityGroupDecision"("reviewId", "groupKey", "version");

CREATE FUNCTION guard_import_identity_group_decision() RETURNS trigger AS $$
DECLARE
  review "ImportIdentityGroupReview"%ROWTYPE;
  batch "ImportBatch"%ROWTYPE;
  actor "User"%ROWTYPE;
  selected_group JSONB;
  saved_group JSONB;
  entry JSONB;
  evidence "ImportHistoricalEvidence"%ROWTYPE;
  evidence_version INTEGER;
  current_asset UUID;
  key_payload TEXT;
  actionable BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Identity group decisions are immutable' USING ERRCODE = '23514'; END IF;
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Identity group decision writes require READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO review FROM "ImportIdentityGroupReview" WHERE "id" = NEW."reviewId";
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = review."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."reviewedById" FOR SHARE;
  IF review."id" IS NULL OR actor."role" IS DISTINCT FROM 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL OR
    EXISTS (SELECT 1 FROM "ImportIdentityGroupRelease" WHERE "reviewId" = review."id") OR
    batch."version" IS DISTINCT FROM NEW."batchVersion" OR
    (SELECT count(*) FROM "ImportSourceRevision" WHERE "batchId" = batch."id") <> NEW."sourceRevision" OR
    NEW."projection"->>'batchId' IS DISTINCT FROM batch."id"::text OR NEW."projection"->>'sourceHash' IS DISTINCT FROM review."sourceHash" OR
    NEW."projection"->>'reviewedPlanId' IS DISTINCT FROM review."planId" OR
    NEW."projection"->>'asOf' IS DISTINCT FROM to_char(clock_timestamp() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') OR
    NEW."version" <> coalesce((SELECT max("version") FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id"), 0) + 1 OR
    NEW."createdAt" > clock_timestamp() AT TIME ZONE 'UTC' OR
    (SELECT count(*) FROM "ImportIdentityGroupRow" WHERE "reviewId" = review."id" AND "isReserved") <> jsonb_array_length(review."plan"->'observations') THEN
    RAISE EXCEPTION 'Group decision requires active complete review, current versions and configured JEFE' USING ERRCODE = '23514';
  END IF;
  key_payload := '["IMPORT_IDENTITY_GROUP","' || review."sourceHash" || '","' || review."id"::text || '","' || NEW."groupId"::text || '"]';
  IF NEW."groupKey" IS DISTINCT FROM encode(sha256(convert_to(key_payload, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'Group decision requires its stable source/review/group key' USING ERRCODE = '23514';
  END IF;
  SELECT value INTO saved_group FROM jsonb_array_elements(review."plan"->'proposedGroups') WHERE value->>'groupId' = NEW."groupId"::text;
  SELECT value INTO selected_group FROM jsonb_array_elements(NEW."projection"->'groups') WHERE value->>'groupKey' = NEW."groupKey";
  IF saved_group IS NULL OR selected_group IS NULL OR selected_group->>'groupId' IS DISTINCT FROM NEW."groupId"::text OR
    selected_group->>'reviewId' IS DISTINCT FROM review."id"::text OR
    selected_group->'recordIds' IS DISTINCT FROM saved_group->'recordIds' OR
    selected_group->'serialNumber' IS DISTINCT FROM saved_group->'serialNumber' OR selected_group->'assetTag' IS DISTINCT FROM saved_group->'assetTag' OR
    jsonb_typeof(selected_group->'evidence') IS DISTINCT FROM 'array' OR
    (SELECT count(*) FROM jsonb_array_elements(NEW."projection"->'groups') g WHERE g->>'groupKey' = NEW."groupKey") <> 1 THEN
    RAISE EXCEPTION 'Group decision cannot rewrite reserved membership or physical identity' USING ERRCODE = '23514';
  END IF;
  actionable := NEW."action" IN ('LINK_EXISTING', 'PROPOSE_NEW');
  IF actionable AND (jsonb_typeof(selected_group->'candidates') IS DISTINCT FROM 'array' OR
    jsonb_array_length(selected_group->'candidates') <> 1 OR
    NEW."projection"->'projectionValidationComplete' IS DISTINCT FROM 'true'::jsonb OR
    NEW."projection"->'blockers' IS DISTINCT FROM '[]'::jsonb) THEN
    RAISE EXCEPTION 'Operational proposals require an unblocked group projection' USING ERRCODE = '23514';
  END IF;
  IF NEW."action" = 'PROPOSE_NEW' AND EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'candidates') c
    WHERE (c->>'existingAssetCount')::integer <> 0) THEN
    RAISE EXCEPTION 'New group proposal conflicts with an existing match' USING ERRCODE = '23514';
  END IF;
  IF NEW."action" = 'LINK_EXISTING' THEN
    IF jsonb_array_length(selected_group->'candidates') <> 1 OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(selected_group->'candidates') c WHERE c->>'existingAssetCount' = '1' AND
      jsonb_array_length(c->'existingAssets') = 1 AND c->'existingAssets'->0->>'id' = NEW."linkedAssetId"::text
    ) OR EXISTS (
      SELECT 1 FROM (SELECT DISTINCT ON ("groupKey") "groupKey", "action", "linkedAssetId"
        FROM "ImportIdentityGroupDecision" WHERE "reviewId" = review."id" ORDER BY "groupKey", "version" DESC) latest
      WHERE "groupKey" <> NEW."groupKey" AND "action" = 'LINK_EXISTING' AND "linkedAssetId" = NEW."linkedAssetId"
    ) THEN RAISE EXCEPTION 'Existing group proposal requires a unique unclaimed suggested asset' USING ERRCODE = '23514'; END IF;
  END IF;
  IF (SELECT count(DISTINCT e->>'evidenceId') FROM jsonb_array_elements(NEW."evidenceReviews") e) <> jsonb_array_length(NEW."evidenceReviews") THEN
    RAISE EXCEPTION 'Evidence reviews must be distinct' USING ERRCODE = '23514';
  END IF;
  IF actionable OR jsonb_array_length(NEW."evidenceReviews") > 0 THEN
    IF jsonb_array_length(NEW."evidenceReviews") <> (SELECT count(*) FROM "ImportHistoricalEvidence" e
      WHERE e."sourceHash" = review."sourceHash" AND selected_group->'recordIds' ? e."recordId") OR
      jsonb_array_length(NEW."evidenceReviews") <> jsonb_array_length(selected_group->'evidence') THEN
      RAISE EXCEPTION 'Group decision requires complete explicit archived evidence coverage' USING ERRCODE = '23514';
    END IF;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW."evidenceReviews") LOOP
    SELECT * INTO evidence FROM "ImportHistoricalEvidence" WHERE "id" = (entry->>'evidenceId')::uuid;
    SELECT coalesce(max("version"), 0) INTO evidence_version FROM "ImportEvidenceAmendment" WHERE "evidenceId" = evidence."id";
    IF evidence_version > 0 THEN
      SELECT "assetId" INTO current_asset FROM "ImportEvidenceAmendment" WHERE "evidenceId" = evidence."id" AND "version" = evidence_version;
    ELSE current_asset := evidence."assetId"; END IF;
    IF evidence."id" IS NULL OR evidence."sourceHash" IS DISTINCT FROM review."sourceHash" OR
      NOT (selected_group->'recordIds' ? evidence."recordId") OR
      (entry->>'expectedEvidenceVersion')::integer IS DISTINCT FROM evidence_version OR
      coalesce(entry->>'disposition', '') NOT IN ('CONFIRM_GROUP_MEMBERSHIP', 'EXCLUDE_FROM_GROUP_PILOT') OR
      length(btrim(coalesce(entry->>'note', ''))) NOT BETWEEN 1 AND 2000 OR
      length(btrim(coalesce(entry->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500 OR
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected_group->'evidence') e WHERE e->>'id' = evidence."id"::text AND
        e->>'recordId' = evidence."recordId" AND e->>'evidenceVersion' = evidence_version::text AND
        e->'currentAssetId' = coalesce(to_jsonb(current_asset::text), 'null'::jsonb)) OR
      EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = evidence."id") OR
      EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = evidence."id") THEN
      RAISE EXCEPTION 'Evidence review must preserve current unused original provenance and version' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportIdentityGroupDecision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportIdentityGroupDecision"
FOR EACH ROW EXECUTE FUNCTION guard_import_identity_group_decision();

COMMIT;
