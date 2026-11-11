BEGIN;

ALTER TABLE "ImportReviewDecision" ADD COLUMN "sourceRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("sourceRevision" BETWEEN 0 AND 1000);

CREATE FUNCTION import_identifier_key(value TEXT) RETURNS TEXT AS $$
  SELECT CASE WHEN key IN ('', 'N/A', 'NA', 'N.A.', 'S/N', 'SIN SERIE', 'SIN ACTIVO', '-') THEN NULL ELSE key END
  FROM (SELECT upper(btrim(regexp_replace(replace(value, chr(160), ' '), '\s+', ' ', 'g'))) AS key) normalized;
$$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE FUNCTION import_identity_column(sheet TEXT, field TEXT) RETURNS TEXT AS $$
  SELECT CASE WHEN field = 'serialNumber' THEN CASE
    WHEN sheet = 'Baja 2026' THEN 'E'
    WHEN sheet IN ('Baja 2025', 'NB Prestamo', 'Bodega 2', 'Bodega 1', 'Recepción', 'KIT CONTINGENCIA', 'CE', 'Transitorio') THEN 'F'
    WHEN sheet IN ('FORTIGATE', 'Control Desvinculados', 'Baja 2024', 'Desvinculados', 'Caja Negra') THEN 'D'
    WHEN sheet = 'Inventario MDA 2' THEN 'G' END
  WHEN field = 'assetTag' THEN CASE
    WHEN sheet = 'Baja 2026' THEN 'F'
    WHEN sheet IN ('Baja 2025', 'Bodega 2', 'Bodega 1', 'Recepción', 'KIT CONTINGENCIA', 'CE', 'Transitorio') THEN 'G'
    WHEN sheet IN ('FORTIGATE', 'Control Desvinculados', 'Desvinculados') THEN 'E'
    WHEN sheet IN ('Baja 2024', 'Caja Negra') THEN 'F'
    WHEN sheet = 'Inventario MDA 2' THEN 'H' END END;
$$ LANGUAGE SQL IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION guard_import_source_revision() RETURNS trigger AS $$
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Source batch not found' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(batch."sourceHash", 0));
  SELECT coalesce(max("revision"), 0) INTO prior FROM "ImportSourceRevision" WHERE "batchId" = NEW."batchId";
  IF batch."version" IS DISTINCT FROM NEW."expectedBatchVersion" OR NEW."revision" <> prior + 1 THEN
    RAISE EXCEPTION 'Source correction revision must match the current batch and history' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(DISTINCT (value->>'recordId', value->>'field')) FROM jsonb_array_elements(NEW."changes")) <> jsonb_array_length(NEW."changes") THEN
    RAISE EXCEPTION 'A field may only be corrected once per revision' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."changes") WHERE value->>'field' IN ('serialNumber', 'assetTag')) AND (
    (SELECT count(DISTINCT value->>'candidateId') FROM jsonb_array_elements(NEW."changes")) <> 1 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."changes") WHERE value->>'field' NOT IN ('serialNumber', 'assetTag')) OR
    (SELECT count(DISTINCT value->>'action') FROM jsonb_array_elements(NEW."changes")) <> 1
  ) THEN RAISE EXCEPTION 'Identity review is restricted to one physical candidate' USING ERRCODE = '23514'; END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(NEW."changes") LOOP
    IF NOT ((change->>'field' IN ('equipmentType', 'brand', 'model', 'receivedDate', 'serialNumber', 'assetTag') AND change->>'action' IN ('REPLACE', 'RESTORE') AND
      change ?& ARRAY['recordId', 'candidateId', 'sheet', 'row', 'column', 'originalCell', 'beforeCell', 'afterCell']) IS TRUE) THEN
      RAISE EXCEPTION 'Only supported source fields can be corrected' USING ERRCODE = '23514';
    END IF;
    IF change->>'field' IN ('serialNumber', 'assetTag') AND
      (import_identity_column(change->>'sheet', change->>'field') IS NULL OR change->>'column' IS DISTINCT FROM import_identity_column(change->>'sheet', change->>'field')) THEN
      RAISE EXCEPTION 'Identity correction must use its contextual source column' USING ERRCODE = '23514';
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
    IF change->>'field' IN ('serialNumber', 'assetTag') AND change->>'action' = 'REPLACE' AND (
      import_identifier_key(change->>'value') IS NULL OR length(change->>'value') > CASE WHEN change->>'field' = 'serialNumber' THEN 160 ELSE 100 END
    ) THEN RAISE EXCEPTION 'Identity replacement must be a usable bounded identifier' USING ERRCODE = '23514'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_import_review_decision() RETURNS trigger AS $$
DECLARE
  batch "ImportBatch"%ROWTYPE;
  target JSONB;
  latest_change JSONB;
  serials JSONB;
  tags JSONB;
  current_revision INTEGER;
  identity_changed BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Import review decisions are append-only' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO batch FROM "ImportBatch" WHERE "id" = NEW."batchId" FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW."batchVersion" <> batch."version" THEN
    RAISE EXCEPTION 'Decision does not match batch version' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max("revision"), 0) INTO current_revision FROM "ImportSourceRevision" WHERE "batchId" = NEW."batchId";
  IF NEW."sourceRevision" <> current_revision THEN
    RAISE EXCEPTION 'Decision must reference the current source revision' USING ERRCODE = '23514';
  END IF;
  IF NEW."targetType" = 'CANDIDATE' THEN
    SELECT value INTO target FROM jsonb_array_elements(batch."preview"->'candidates') WHERE value->>'id' = NEW."targetId";
    IF NOT FOUND THEN RAISE EXCEPTION 'Candidate does not belong to this snapshot' USING ERRCODE = '23514'; END IF;
    SELECT EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
      WHERE r."batchId" = NEW."batchId" AND c.value->>'candidateId' = NEW."targetId" AND c.value->>'field' IN ('serialNumber', 'assetTag')) INTO identity_changed;
    IF identity_changed THEN
      serials := target->'serials'; tags := target->'tags';
      SELECT c.value INTO latest_change FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
        WHERE r."batchId" = NEW."batchId" AND c.value->>'candidateId' = NEW."targetId" AND c.value->>'field' = 'serialNumber'
        ORDER BY r."revision" DESC LIMIT 1;
      IF FOUND AND latest_change->>'action' = 'REPLACE' THEN serials := jsonb_build_array(import_identifier_key(latest_change->>'value')); END IF;
      SELECT c.value INTO latest_change FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
        WHERE r."batchId" = NEW."batchId" AND c.value->>'candidateId' = NEW."targetId" AND c.value->>'field' = 'assetTag'
        ORDER BY r."revision" DESC LIMIT 1;
      IF FOUND AND latest_change->>'action' = 'REPLACE' THEN tags := jsonb_build_array(import_identifier_key(latest_change->>'value')); END IF;
      IF NEW."action" = 'LINK_EXISTING' AND NOT EXISTS (
        SELECT 1 FROM "Asset" WHERE "id" = NEW."linkedAssetId" AND (serials ? import_identifier_key("serialNumber") OR tags ? import_identifier_key("assetTag"))
      ) THEN RAISE EXCEPTION 'Asset does not match the reviewed identity' USING ERRCODE = '23514'; END IF;
      IF NEW."action" = 'PROPOSE_NEW' AND (jsonb_array_length(serials) + jsonb_array_length(tags) = 0 OR EXISTS (
        SELECT 1 FROM "Asset" WHERE serials ? import_identifier_key("serialNumber") OR tags ? import_identifier_key("assetTag")
      )) THEN RAISE EXCEPTION 'Reviewed identity requires no existing match for a new proposal' USING ERRCODE = '23514'; END IF;
    ELSE
      IF NEW."action" = 'LINK_EXISTING' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(target->'existingAssets') WHERE value->>'id' = NEW."linkedAssetId"::text
      ) THEN RAISE EXCEPTION 'Asset was not suggested by this snapshot' USING ERRCODE = '23514'; END IF;
      IF NEW."action" = 'PROPOSE_NEW' AND (jsonb_array_length(target->'serials') + jsonb_array_length(target->'tags') = 0 OR jsonb_array_length(target->'existingAssets') > 0) THEN
        RAISE EXCEPTION 'New asset proposal requires identity without an existing match' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    SELECT value INTO target FROM jsonb_array_elements(batch."preview"->'records')
      WHERE value->>'id' = NEW."targetId" AND value->>'kind' NOT IN ('ASSET_OBSERVATION', 'RETIREMENT_HISTORY');
    IF NOT FOUND THEN RAISE EXCEPTION 'Record is not a stand-alone review target' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
