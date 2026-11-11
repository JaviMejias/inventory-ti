BEGIN;

CREATE TYPE "ImportReviewTargetType" AS ENUM ('CANDIDATE', 'RECORD');
CREATE TYPE "ImportReviewAction" AS ENUM ('HOLD', 'EXCLUDE', 'LINK_EXISTING', 'PROPOSE_NEW');

CREATE TABLE "ImportBatch" (
  "id" UUID NOT NULL,
  "previewId" VARCHAR(64) NOT NULL,
  "sourceFileName" VARCHAR(255) NOT NULL,
  "sourceHash" VARCHAR(64) NOT NULL,
  "payloadDigest" VARCHAR(64) NOT NULL,
  "databaseSnapshotDigest" VARCHAR(64) NOT NULL,
  "rulesVersion" VARCHAR(100) NOT NULL,
  "asOf" VARCHAR(10) NOT NULL,
  "workbook" JSONB NOT NULL,
  "preview" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "targetCount" INTEGER NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ImportBatch_version_check" CHECK ("version" >= 1),
  CONSTRAINT "ImportBatch_targetCount_check" CHECK ("targetCount" >= 0),
  CONSTRAINT "ImportBatch_digests_check" CHECK (
    "previewId" ~ '^[a-f0-9]{64}$' AND "sourceHash" ~ '^[a-f0-9]{64}$' AND
    "payloadDigest" ~ '^[a-f0-9]{64}$' AND "databaseSnapshotDigest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "ImportBatch_snapshot_check" CHECK ((
    jsonb_typeof("workbook") = 'object' AND jsonb_typeof("preview") = 'object' AND
    "preview" @> '{"mode":"PREVIEW","canApply":false,"persisted":false,"comparisonMode":"DATABASE"}'::jsonb AND
    "preview" ?& ARRAY['previewId', 'rulesVersion', 'payloadDigest', 'databaseSnapshotDigest', 'candidates', 'records'] AND
    "preview"->>'previewId' = "previewId" AND "preview"->>'rulesVersion' = "rulesVersion" AND
    "preview"->>'payloadDigest' = "payloadDigest" AND "preview"->>'databaseSnapshotDigest' = "databaseSnapshotDigest" AND
    jsonb_typeof("preview"->'candidates') = 'array' AND jsonb_typeof("preview"->'records') = 'array'
  ) IS TRUE)
);

CREATE UNIQUE INDEX "ImportBatch_previewId_key" ON "ImportBatch"("previewId");
CREATE INDEX "ImportBatch_createdAt_id_idx" ON "ImportBatch"("createdAt", "id");
CREATE INDEX "ImportBatch_sourceHash_idx" ON "ImportBatch"("sourceHash");

CREATE TABLE "ImportReviewDecision" (
  "id" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "batchVersion" INTEGER NOT NULL,
  "requestId" UUID NOT NULL,
  "targetType" "ImportReviewTargetType" NOT NULL,
  "targetId" VARCHAR(64) NOT NULL,
  "action" "ImportReviewAction" NOT NULL,
  "linkedAssetId" UUID,
  "note" VARCHAR(2000) NOT NULL,
  "reviewedById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportReviewDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportReviewDecision_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ImportReviewDecision_linkedAssetId_fkey" FOREIGN KEY ("linkedAssetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ImportReviewDecision_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ImportReviewDecision_version_check" CHECK ("batchVersion" >= 2),
  CONSTRAINT "ImportReviewDecision_target_check" CHECK ("targetId" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ImportReviewDecision_note_check" CHECK (length(btrim("note")) > 0),
  CONSTRAINT "ImportReviewDecision_link_check" CHECK (("action" = 'LINK_EXISTING') = ("linkedAssetId" IS NOT NULL)),
  CONSTRAINT "ImportReviewDecision_record_action_check" CHECK ("targetType" = 'CANDIDATE' OR "action" IN ('HOLD', 'EXCLUDE'))
);

CREATE UNIQUE INDEX "ImportReviewDecision_batchId_batchVersion_key" ON "ImportReviewDecision"("batchId", "batchVersion");
CREATE UNIQUE INDEX "ImportReviewDecision_batchId_requestId_key" ON "ImportReviewDecision"("batchId", "requestId");
CREATE INDEX "ImportReviewDecision_batchId_targetType_targetId_batchVersion_idx" ON "ImportReviewDecision"("batchId", "targetType", "targetId", "batchVersion" DESC);

CREATE FUNCTION guard_import_batch_snapshot() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Import review provenance cannot be deleted' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'New import batches start at version 1' USING ERRCODE = '23514';
    END IF;
    IF NEW."targetCount" <> jsonb_array_length(NEW."preview"->'candidates') + (
      SELECT count(*) FROM jsonb_array_elements(NEW."preview"->'records') WHERE value->>'kind' NOT IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY')
    ) THEN
      RAISE EXCEPTION 'Review target count does not match snapshot' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW."id", NEW."previewId", NEW."sourceFileName", NEW."sourceHash", NEW."payloadDigest", NEW."databaseSnapshotDigest", NEW."rulesVersion", NEW."asOf", NEW."workbook", NEW."preview", NEW."targetCount", NEW."createdById", NEW."createdAt")
      IS DISTINCT FROM ROW(OLD."id", OLD."previewId", OLD."sourceFileName", OLD."sourceHash", OLD."payloadDigest", OLD."databaseSnapshotDigest", OLD."rulesVersion", OLD."asOf", OLD."workbook", OLD."preview", OLD."targetCount", OLD."createdById", OLD."createdAt") THEN
      RAISE EXCEPTION 'Import source and snapshot are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'Import review versions must increase by one' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImportBatch_snapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportBatch"
FOR EACH ROW EXECUTE FUNCTION guard_import_batch_snapshot();

CREATE FUNCTION guard_import_review_decision() RETURNS trigger AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE;
  target JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Import review decisions are append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW."batchVersion" <> batch."version" THEN
    RAISE EXCEPTION 'Decision does not match batch version' USING ERRCODE = '23514';
  END IF;
  IF NEW."targetType" = 'CANDIDATE' THEN
    SELECT value INTO target FROM jsonb_array_elements(batch."preview"->'candidates') WHERE value->>'id' = NEW."targetId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Candidate does not belong to this snapshot' USING ERRCODE = '23514';
    END IF;
    IF NEW."action" = 'LINK_EXISTING' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(target->'existingAssets') WHERE value->>'id' = NEW."linkedAssetId"::text
    ) THEN
      RAISE EXCEPTION 'Asset was not suggested by this snapshot' USING ERRCODE = '23514';
    END IF;
    IF NEW."action" = 'PROPOSE_NEW' AND (jsonb_array_length(target->'serials') + jsonb_array_length(target->'tags') = 0 OR jsonb_array_length(target->'existingAssets') > 0) THEN
      RAISE EXCEPTION 'New asset proposal requires identity without an existing match' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT value INTO target FROM jsonb_array_elements(batch."preview"->'records')
    WHERE value->>'id' = NEW."targetId" AND value->>'kind' NOT IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Record is not a stand-alone review target' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImportReviewDecision_append_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportReviewDecision"
FOR EACH ROW EXECUTE FUNCTION guard_import_review_decision();

CREATE FUNCTION verify_import_review_version() RETURNS trigger AS $$
DECLARE
  current_version INTEGER;
  decision_count BIGINT;
BEGIN
  SELECT "version" INTO current_version FROM "ImportBatch" WHERE "id" = NEW."id";
  SELECT count(*) INTO decision_count FROM "ImportReviewDecision" WHERE "batchId" = NEW."id";
  IF current_version <> decision_count + 1 THEN
    RAISE EXCEPTION 'Each review version requires one decision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ImportBatch_review_version_guard" AFTER INSERT OR UPDATE ON "ImportBatch"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_review_version();

COMMIT;
