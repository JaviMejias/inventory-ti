BEGIN;

CREATE TABLE "ImportSourceRevision" (
  "id" UUID NOT NULL PRIMARY KEY,
  "batchId" UUID NOT NULL REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "revision" INTEGER NOT NULL CHECK ("revision" BETWEEN 1 AND 1000),
  "expectedBatchVersion" INTEGER NOT NULL CHECK ("expectedBatchVersion" >= 1),
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "note" VARCHAR(2000) NOT NULL CHECK (length(btrim("note")) > 0),
  "evidenceReference" VARCHAR(500) NOT NULL CHECK (length(btrim("evidenceReference")) > 0),
  "changes" JSONB NOT NULL CHECK ((jsonb_typeof("changes") = 'array' AND jsonb_array_length("changes") BETWEEN 1 AND 25) IS TRUE),
  "reviewedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ImportSourceRevision_batchId_revision_key" ON "ImportSourceRevision"("batchId", "revision");
CREATE UNIQUE INDEX "ImportSourceRevision_batchId_requestId_key" ON "ImportSourceRevision"("batchId", "requestId");

CREATE FUNCTION guard_import_source_revision() RETURNS trigger AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE;
  prior INTEGER;
  change JSONB;
  record JSONB;
  previous_cell JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Source correction history is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  SELECT coalesce(max("revision"), 0) INTO prior FROM "ImportSourceRevision" WHERE "batchId" = NEW."batchId";
  IF NOT FOUND OR batch."version" IS DISTINCT FROM NEW."expectedBatchVersion" OR NEW."revision" <> prior + 1 THEN
    RAISE EXCEPTION 'Source correction revision must match the current batch and history' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(DISTINCT (value->>'recordId', value->>'field')) FROM jsonb_array_elements(NEW."changes")) <> jsonb_array_length(NEW."changes") THEN
    RAISE EXCEPTION 'A field may only be corrected once per revision' USING ERRCODE = '23514';
  END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(NEW."changes") LOOP
    IF NOT ((change->>'field' IN ('equipmentType', 'brand', 'model', 'receivedDate') AND change->>'action' IN ('REPLACE', 'RESTORE') AND
      change ?& ARRAY['recordId', 'candidateId', 'sheet', 'row', 'column', 'originalCell', 'beforeCell', 'afterCell']) IS TRUE) THEN
      RAISE EXCEPTION 'Only supported source fields can be corrected' USING ERRCODE = '23514';
    END IF;
    SELECT value INTO record FROM jsonb_array_elements(batch."preview"->'records') WHERE value->>'id' = change->>'recordId';
    IF NOT FOUND OR NOT ((record->>'kind' IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY') AND record->>'sheet' = change->>'sheet' AND record->>'row' = change->>'row' AND record->'fields' ? (change->>'field')) IS TRUE) OR
      coalesce(record->'originalCells'->(change->>'column'), 'null'::jsonb) IS DISTINCT FROM change->'originalCell' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(batch."preview"->'candidates') c WHERE c->>'id' = change->>'candidateId' AND c->'recordIds' ? (change->>'recordId')
      ) THEN
      RAISE EXCEPTION 'Correction must retain its mapped physical source and original value' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "ImportApplicationItem" WHERE "sourceHash" = batch."sourceHash" AND "candidateId" = change->>'candidateId') THEN
      RAISE EXCEPTION 'Applied source candidates cannot be reinterpreted' USING ERRCODE = '23514';
    END IF;
    SELECT c.value->'afterCell' INTO previous_cell FROM "ImportSourceRevision" r
      CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
      WHERE r."batchId" = NEW."batchId" AND c.value->>'recordId' = change->>'recordId' AND c.value->>'field' = change->>'field'
      ORDER BY r."revision" DESC LIMIT 1;
    IF NOT FOUND THEN previous_cell := change->'originalCell'; END IF;
    IF previous_cell IS DISTINCT FROM change->'beforeCell' OR
      (change->>'action' = 'RESTORE' AND change->'afterCell' IS DISTINCT FROM change->'originalCell') OR
      (change->>'action' = 'REPLACE' AND NOT ((
        jsonb_typeof(change->'value') = 'string' AND change->'afterCell'->>'value' = change->>'value' AND
        change->'afterCell'->>'type' = CASE WHEN change->>'field' = 'receivedDate' THEN 'date' ELSE 'text' END
      ) IS TRUE)) THEN
      RAISE EXCEPTION 'Source correction must retain before/after values and restore the actual original' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportSourceRevision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportSourceRevision"
FOR EACH ROW EXECUTE FUNCTION guard_import_source_revision();

COMMIT;
