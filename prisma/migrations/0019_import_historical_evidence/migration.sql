BEGIN;

CREATE TABLE "ImportHistoryCapture" (
  "id" UUID NOT NULL PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "batchVersion" INTEGER NOT NULL CHECK ("batchVersion" >= 1),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "historyPreviewId" VARCHAR(64) NOT NULL CHECK ("historyPreviewId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK (length(btrim("rulesVersion")) > 0),
  "note" VARCHAR(2000) NOT NULL CHECK (length(btrim("note")) > 0),
  "evidenceReference" VARCHAR(500) NOT NULL CHECK (length(btrim("evidenceReference")) > 0),
  "selection" JSONB NOT NULL CHECK ((jsonb_typeof("selection") = 'array' AND jsonb_array_length("selection") BETWEEN 1 AND 25) IS TRUE),
  "capturedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportHistoryCapture_batchId_requestId_key" ON "ImportHistoryCapture"("batchId", "requestId");
CREATE INDEX "ImportHistoryCapture_batchId_capturedAt_id_idx" ON "ImportHistoryCapture"("batchId", "capturedAt", "id");

CREATE TABLE "ImportHistoricalEvidence" (
  "id" UUID NOT NULL PRIMARY KEY,
  "captureId" UUID NOT NULL REFERENCES "ImportHistoryCapture"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceHash" VARCHAR(64) NOT NULL CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "recordId" VARCHAR(64) NOT NULL CHECK ("recordId" ~ '^[a-f0-9]{64}$'),
  "candidateId" VARCHAR(64) NOT NULL CHECK ("candidateId" ~ '^[a-f0-9]{64}$'),
  "kind" VARCHAR(40) NOT NULL CHECK ("kind" IN ('RECEIPT_OBSERVATION', 'USAGE_OBSERVATION', 'LOAN_OBSERVATION', 'RETIREMENT_OBSERVATION')),
  "effectiveDay" VARCHAR(10) CHECK ("effectiveDay" IS NULL OR (
    "effectiveDay" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "effectiveDay" >= '1900-01-01' AND to_char("effectiveDay"::date, 'YYYY-MM-DD') = "effectiveDay"
  )),
  "assetId" UUID REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "snapshot" JSONB NOT NULL CHECK ((jsonb_typeof("snapshot") = 'object' AND "snapshot" @> '{"affectsCurrentState":false,"historicalActorId":null}'::jsonb) IS TRUE),
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportHistoricalEvidence_sourceHash_recordId_kind_key" ON "ImportHistoricalEvidence"("sourceHash", "recordId", "kind");
CREATE UNIQUE INDEX "ImportHistoricalEvidence_captureId_recordId_kind_key" ON "ImportHistoricalEvidence"("captureId", "recordId", "kind");
CREATE INDEX "ImportHistoricalEvidence_assetId_capturedAt_id_idx" ON "ImportHistoricalEvidence"("assetId", "capturedAt", "id");

CREATE FUNCTION guard_import_history_capture() RETURNS trigger AS $$
DECLARE batch "ImportBatch"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical captures are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW."batchVersion" IS DISTINCT FROM batch."version" OR NEW."sourceHash" IS DISTINCT FROM batch."sourceHash" THEN
    RAISE EXCEPTION 'Historical capture must retain its current batch and source' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  IF NEW."sourceRevision" <> (SELECT coalesce(max("revision"), 0) FROM "ImportSourceRevision" WHERE "batchId" = NEW."batchId") OR
    (SELECT count(DISTINCT (value->>'recordId', value->>'kind')) FROM jsonb_array_elements(NEW."selection")) <> jsonb_array_length(NEW."selection") THEN
    RAISE EXCEPTION 'Historical capture requires current source revision and distinct observations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportHistoryCapture_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportHistoryCapture"
FOR EACH ROW EXECUTE FUNCTION guard_import_history_capture();

CREATE FUNCTION guard_import_historical_evidence() RETURNS trigger AS $$
DECLARE
  capture "ImportHistoryCapture"%ROWTYPE;
  batch "ImportBatch"%ROWTYPE;
  original_record JSONB;
  selected JSONB;
  latest_decision "ImportReviewDecision"%ROWTYPE;
  identity_revision INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical evidence is immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO capture FROM "ImportHistoryCapture" WHERE "id" = NEW."captureId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Historical capture not found' USING ERRCODE = '23514'; END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = capture."batchId";
  SELECT value INTO selected FROM jsonb_array_elements(capture."selection") WHERE value->>'recordId' = NEW."recordId" AND value->>'kind' = NEW."kind";
  IF NOT FOUND OR selected IS DISTINCT FROM NEW."snapshot" OR NEW."sourceHash" IS DISTINCT FROM capture."sourceHash" OR
    NEW."snapshot"->>'candidateId' IS DISTINCT FROM NEW."candidateId" OR NEW."snapshot"->>'assetId' IS DISTINCT FROM NEW."assetId"::text OR
    NEW."snapshot"->>'effectiveDay' IS DISTINCT FROM NEW."effectiveDay" OR NOT ((
      NEW."snapshot"->>'datePrecision' = CASE WHEN NEW."effectiveDay" IS NULL THEN 'UNKNOWN' ELSE 'DAY' END
    ) IS TRUE) THEN
    RAISE EXCEPTION 'Historical evidence must match its immutable capture selection' USING ERRCODE = '23514';
  END IF;
  SELECT value INTO original_record FROM jsonb_array_elements(batch."preview"->'records') WHERE value->>'id' = NEW."recordId";
  IF NOT FOUND OR NEW."snapshot"->'original' IS DISTINCT FROM original_record OR NOT ((original_record->>'kind' IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY')) IS TRUE) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(batch."preview"->'candidates') c WHERE c->>'id' = NEW."candidateId" AND c->'recordIds' ? NEW."recordId"
  ) OR NOT ((
    NEW."snapshot"->'effective'->>'id' = NEW."recordId" AND NEW."snapshot"->'effective'->>'sheet' = original_record->>'sheet' AND
    NEW."snapshot"->'effective'->>'row' = original_record->>'row'
  ) IS TRUE) THEN
    RAISE EXCEPTION 'Historical evidence must retain a mapped physical source and its original record' USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" = 'RETIREMENT_OBSERVATION' AND (NEW."effectiveDay" IS NOT NULL OR NOT ((
    original_record->>'kind' = 'RETIREMENT_HISTORY' OR original_record->>'statusEvidence' = 'DECOMMISSIONED'
  ) IS TRUE)) THEN RAISE EXCEPTION 'Retirement observations do not invent a retirement date' USING ERRCODE = '23514'; END IF;
  IF NEW."effectiveDay" > to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'Unconfirmed future dates cannot become historical effective days' USING ERRCODE = '23514';
  END IF;
  IF NEW."assetId" IS NULL THEN
    IF NEW."snapshot"->'linkBasis' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unlinked evidence cannot claim a reviewed asset' USING ERRCODE = '23514'; END IF;
  ELSIF NEW."snapshot"->'linkBasis'->>'type' = 'PILOT_RECEIPT' THEN
    IF NOT EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "id"::text = NEW."snapshot"->'linkBasis'->>'id' AND
      "sourceHash" = NEW."sourceHash" AND "candidateId" = NEW."candidateId" AND "assetId" = NEW."assetId") THEN
      RAISE EXCEPTION 'Historical link must match its pilot receipt' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."snapshot"->'linkBasis'->>'type' = 'REVIEW_DECISION' THEN
    SELECT * INTO latest_decision FROM "ImportReviewDecision" WHERE "batchId" = capture."batchId" AND "targetType" = 'CANDIDATE' AND
      "targetId" = NEW."candidateId" AND "batchVersion" <= capture."batchVersion" ORDER BY "batchVersion" DESC LIMIT 1;
    SELECT coalesce(max(r."revision"), 0) INTO identity_revision FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
      WHERE r."batchId" = capture."batchId" AND r."revision" <= capture."sourceRevision" AND c.value->>'candidateId' = NEW."candidateId" AND c.value->>'field' IN ('serialNumber', 'assetTag');
    IF latest_decision."id"::text IS DISTINCT FROM NEW."snapshot"->'linkBasis'->>'id' OR latest_decision."action" IS DISTINCT FROM 'LINK_EXISTING' OR
      latest_decision."linkedAssetId" IS DISTINCT FROM NEW."assetId" OR latest_decision."sourceRevision" < identity_revision THEN
      RAISE EXCEPTION 'Historical link requires its latest reviewed identity decision' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'Historical asset link requires explicit provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportHistoricalEvidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportHistoricalEvidence"
FOR EACH ROW EXECUTE FUNCTION guard_import_historical_evidence();

CREATE FUNCTION verify_import_history_complete() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM "ImportHistoricalEvidence" WHERE "captureId" = NEW."id") <> jsonb_array_length(NEW."selection") THEN
    RAISE EXCEPTION 'Every historical selection requires one immutable evidence item' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportHistoryCapture_complete_guard" AFTER INSERT ON "ImportHistoryCapture"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_history_complete();

COMMIT;
