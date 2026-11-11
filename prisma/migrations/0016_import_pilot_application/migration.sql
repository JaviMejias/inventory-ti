BEGIN;

CREATE TABLE "ImportApplication" (
  "id" UUID NOT NULL PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "batchVersion" INTEGER NOT NULL CHECK ("batchVersion" >= 2),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "plan" JSONB NOT NULL,
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportApplication_plan_check" CHECK ((
    "plan" @> '{"mode":"PILOT_PLAN","scope":"ASSET_PILOT","canApply":false,"planValidationComplete":true}'::jsonb AND
    "plan"->>'planId' = "planId" AND "plan"->>'batchId' = "batchId"::text AND
    "plan"->>'batchVersion' = "batchVersion"::text AND
    jsonb_typeof("plan"->'operations') = 'array' AND jsonb_array_length("plan"->'operations') BETWEEN 1 AND 25
  ) IS TRUE)
);
CREATE UNIQUE INDEX "ImportApplication_planId_key" ON "ImportApplication"("planId");
CREATE UNIQUE INDEX "ImportApplication_batchId_requestId_key" ON "ImportApplication"("batchId", "requestId");
CREATE INDEX "ImportApplication_batchId_createdAt_id_idx" ON "ImportApplication"("batchId", "createdAt", "id");

CREATE TABLE "ImportApplicationItem" (
  "id" UUID NOT NULL PRIMARY KEY,
  "applicationId" UUID NOT NULL REFERENCES "ImportApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "candidateId" VARCHAR(64) NOT NULL CHECK ("candidateId" ~ '^[a-f0-9]{64}$'),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "decisionId" UUID NOT NULL REFERENCES "ImportReviewDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "operation" JSONB NOT NULL,
  "result" JSONB NOT NULL
);
CREATE UNIQUE INDEX "ImportApplicationItem_sourceHash_candidateId_key" ON "ImportApplicationItem"("sourceHash", "candidateId");
CREATE UNIQUE INDEX "ImportApplicationItem_applicationId_candidateId_key" ON "ImportApplicationItem"("applicationId", "candidateId");
CREATE INDEX "ImportApplicationItem_assetId_idx" ON "ImportApplicationItem"("assetId");

CREATE FUNCTION guard_import_application() RETURNS trigger AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Import application receipts are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW."batchVersion" <> batch."version" OR NEW."sourceHash" <> batch."sourceHash" THEN
    RAISE EXCEPTION 'Application must reference the current review and source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_application();

CREATE FUNCTION guard_import_application_item() RETURNS trigger AS $$
DECLARE
  application "ImportApplication"%ROWTYPE;
  decision "ImportReviewDecision"%ROWTYPE;
  planned JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Import application items are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO application FROM "ImportApplication" WHERE "id" = NEW."applicationId";
  SELECT value INTO planned FROM jsonb_array_elements(application."plan"->'operations') WHERE value->>'candidateId' = NEW."candidateId";
  IF NOT FOUND OR NEW."sourceHash" <> application."sourceHash" OR NEW."operation" IS DISTINCT FROM planned THEN
    RAISE EXCEPTION 'Application item must match its approved operation and source' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO decision FROM "ImportReviewDecision"
  WHERE "batchId" = application."batchId" AND "targetType" = 'CANDIDATE' AND "targetId" = NEW."candidateId"
    AND "batchVersion" <= application."batchVersion" ORDER BY "batchVersion" DESC LIMIT 1;
  IF NOT FOUND OR decision."id" <> NEW."decisionId" OR planned->>'decisionId' IS DISTINCT FROM NEW."decisionId"::text OR NOT ((
    (planned->>'type' = 'CREATE_ASSET' AND decision."action" = 'PROPOSE_NEW') OR
    (planned->>'type' = 'UPDATE_METADATA' AND decision."action" = 'LINK_EXISTING' AND decision."linkedAssetId" = NEW."assetId")
  ) IS TRUE) THEN
    RAISE EXCEPTION 'Application requires its latest matching identity decision' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW."result"->>'id' = NEW."assetId"::text AND NEW."result"->>'status' = planned->>'resultingStatus') IS TRUE) THEN
    RAISE EXCEPTION 'Application result must identify the applied asset and state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportApplicationItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportApplicationItem"
FOR EACH ROW EXECUTE FUNCTION guard_import_application_item();

CREATE FUNCTION verify_import_application_complete() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "ImportApplicationItem" WHERE "applicationId" = NEW."id") <> jsonb_array_length(NEW."plan"->'operations') THEN
    RAISE EXCEPTION 'Every applied operation requires one immutable receipt item' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportApplication_complete_guard" AFTER INSERT ON "ImportApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_application_complete();

COMMIT;
