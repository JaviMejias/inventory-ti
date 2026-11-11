BEGIN;

CREATE TABLE "ImportRetirementApplication" (
  "id" UUID NOT NULL PRIMARY KEY,
  "assetId" UUID NOT NULL REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceId" UUID NOT NULL REFERENCES "ImportHistoricalEvidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "evidenceVersion" INTEGER NOT NULL CHECK ("evidenceVersion" BETWEEN 0 AND 1000),
  "amendmentId" UUID REFERENCES "ImportEvidenceAmendment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" BETWEEN 0 AND 1000),
  "decommissionedAt" TIMESTAMP(3) NOT NULL,
  "requestId" UUID NOT NULL,
  "requestDigest" VARCHAR(64) NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "planId" VARCHAR(64) NOT NULL CHECK ("planId" ~ '^[a-f0-9]{64}$'),
  "rulesVersion" VARCHAR(100) NOT NULL CHECK ("rulesVersion" = 'mda-retirement-plan-1'),
  "plan" JSONB NOT NULL CHECK (jsonb_typeof("plan") = 'object'),
  "result" JSONB NOT NULL CHECK (jsonb_typeof("result") = 'object'),
  "appliedById" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("decommissionedAt" >= TIMESTAMP '1900-01-01' AND "decommissionedAt" <= "appliedAt"),
  CHECK (("evidenceVersion" = 0 AND "amendmentId" IS NULL) OR ("evidenceVersion" > 0 AND "amendmentId" IS NOT NULL))
);
CREATE UNIQUE INDEX "ImportRetirementApplication_assetId_key" ON "ImportRetirementApplication"("assetId");
CREATE UNIQUE INDEX "ImportRetirementApplication_evidenceId_key" ON "ImportRetirementApplication"("evidenceId");
CREATE UNIQUE INDEX "ImportRetirementApplication_planId_key" ON "ImportRetirementApplication"("planId");
CREATE UNIQUE INDEX "ImportRetirementApplication_assetId_requestId_key" ON "ImportRetirementApplication"("assetId", "requestId");
CREATE INDEX "ImportRetirementApplication_assetId_appliedAt_id_idx" ON "ImportRetirementApplication"("assetId", "appliedAt", "id");

CREATE FUNCTION guard_import_retirement_application() RETURNS trigger AS $$
DECLARE
  evidence "ImportHistoricalEvidenceCurrent"%ROWTYPE;
  current_asset "Asset"%ROWTYPE;
  current_product "Product"%ROWTYPE;
  actor "User"%ROWTYPE;
  batch_id UUID;
  source_hash TEXT;
  proposal JSONB;
  request JSONB;
  received_text TEXT;
  received_day TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Historical retirement receipts are immutable' USING ERRCODE = '23514'; END IF;
  SELECT "sourceHash" INTO source_hash FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId";
  IF source_hash IS NULL THEN RAISE EXCEPTION 'Retirement requires archived evidence' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(source_hash, 0));
  PERFORM 1 FROM "ImportHistoricalEvidence" WHERE "id" = NEW."evidenceId" FOR NO KEY UPDATE;
  SELECT * INTO evidence FROM "ImportHistoricalEvidenceCurrent" WHERE "id" = NEW."evidenceId";
  SELECT * INTO current_asset FROM "Asset" WHERE "id" = NEW."assetId" FOR UPDATE;
  SELECT * INTO current_product FROM "Product" WHERE "id" = current_asset."productId" FOR SHARE;
  SELECT * INTO actor FROM "User" WHERE "id" = NEW."appliedById" FOR SHARE;
  IF actor."id" IS NULL OR actor."role" <> 'JEFE' OR NOT actor."isActive" OR actor."passwordHash" IS NULL THEN
    RAISE EXCEPTION 'Retirement applier must be an active configured JEFE' USING ERRCODE = '23514';
  END IF;
  IF current_asset."id" IS NULL OR NOT current_asset."isActive" OR current_asset."status" IN ('ASSIGNED', 'DECOMMISSIONED') OR
    current_asset."decommissionedAt" IS NOT NULL OR current_product."trackingMode" IS DISTINCT FROM 'ASSET' THEN
    RAISE EXCEPTION 'Retirement requires a nonterminal unassigned physical asset' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Assignment" WHERE "assetId" = NEW."assetId" AND
    ("endedAt" IS NULL OR "endedAt" > NEW."decommissionedAt" OR "endedAt" <= "startedAt")) THEN
    RAISE EXCEPTION 'Retirement cannot close or contradict assignment history' USING ERRCODE = '23514';
  END IF;
  IF evidence."kind" IS DISTINCT FROM 'RETIREMENT_OBSERVATION' OR evidence."assetId" IS DISTINCT FROM NEW."assetId" OR
    evidence."effectiveDay" IS NOT NULL OR evidence."evidenceVersion" IS DISTINCT FROM NEW."evidenceVersion" OR
    evidence."amendmentId" IS DISTINCT FROM NEW."amendmentId" OR evidence."sourceRevision" IS DISTINCT FROM NEW."sourceRevision" OR
    NOT ((evidence."snapshot" @> '{"identityLinkBlocked":false,"historicalActorId":null,"datePrecision":"UNKNOWN"}'::jsonb) IS TRUE) THEN
    RAISE EXCEPTION 'Retirement requires the exact linked current evidence without invented dates or actors' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "ImportAssignmentEvidenceUse" WHERE "evidenceId" = NEW."evidenceId") OR
    EXISTS (SELECT 1 FROM "ImportAssignmentItem" WHERE "startEvidenceId" = NEW."evidenceId" OR "endEvidenceId" = NEW."evidenceId") THEN
    RAISE EXCEPTION 'Historical evidence already belongs to an assignment' USING ERRCODE = '23514';
  END IF;
  SELECT "batchId" INTO batch_id FROM "ImportHistoryCapture" WHERE "id" = evidence."captureId" AND "rulesVersion" = 'mda-history-evidence-1';
  IF batch_id IS NULL OR EXISTS (SELECT 1 FROM "ImportSourceRevision" r CROSS JOIN LATERAL jsonb_array_elements(r."changes") c(value)
    WHERE r."batchId" = batch_id AND r."revision" > NEW."sourceRevision" AND c.value->>'candidateId' = evidence."candidateId") THEN
    RAISE EXCEPTION 'Retirement evidence requires compatible and current source interpretation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(evidence."snapshot"->'issues') i WHERE i->>'severity' = 'BLOCKING') THEN
    RAISE EXCEPTION 'Retirement cannot waive source blockers' USING ERRCODE = '23514';
  END IF;
  proposal := NEW."plan"->'proposedRetirement'; request := NEW."plan"->'request';
  IF NEW."plan"->>'planId' IS DISTINCT FROM NEW."planId" OR NEW."plan"->>'planRulesVersion' IS DISTINCT FROM NEW."rulesVersion" OR
    NOT ((NEW."plan" @> '{"scope":"HISTORICAL_RETIREMENT_PLAN","planValidationComplete":true,"canApply":false,"persisted":false,"affectsCurrentState":false}'::jsonb AND
      jsonb_typeof(NEW."plan"->'blockers') = 'array' AND jsonb_array_length(NEW."plan"->'blockers') = 0) IS TRUE) OR
    request->>'confirmation' IS DISTINCT FROM 'VERIFIED_HISTORICAL_RETIREMENT' OR request->>'evidenceId' IS DISTINCT FROM NEW."evidenceId"::text OR
    length(btrim(coalesce(request->>'note', ''))) NOT BETWEEN 1 AND 2000 OR
    length(btrim(coalesce(request->>'evidenceReference', ''))) NOT BETWEEN 1 AND 500 OR
    length(btrim(coalesce(request->>'dateEvidenceReference', ''))) NOT BETWEEN 1 AND 500 OR
    coalesce(request->>'confirmedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' OR
    (request->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."decommissionedAt" OR
    NEW."appliedAt" > clock_timestamp() AT TIME ZONE 'UTC' OR
    NOT ((proposal @> '{"status":"DECOMMISSIONED","isActive":false,"historicalActorId":null}'::jsonb) IS TRUE) OR
    proposal->>'assetId' IS DISTINCT FROM NEW."assetId"::text OR
    (proposal->>'decommissionedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."decommissionedAt" THEN
    RAISE EXCEPTION 'Retirement receipt requires a complete confirmed proposal and exact timestamp proof' USING ERRCODE = '23514';
  END IF;
  IF NEW."plan"->'source'->>'evidenceId' IS DISTINCT FROM NEW."evidenceId"::text OR
    NEW."plan"->'source'->>'captureId' IS DISTINCT FROM evidence."captureId"::text OR
    NEW."plan"->'source'->>'batchId' IS DISTINCT FROM batch_id::text OR
    NEW."plan"->'source'->>'sourceHash' IS DISTINCT FROM evidence."sourceHash" OR
    NEW."plan"->'source'->>'recordId' IS DISTINCT FROM evidence."recordId" OR
    NEW."plan"->'source'->>'candidateId' IS DISTINCT FROM evidence."candidateId" OR
    NEW."plan"->'source'->>'evidenceVersion' IS DISTINCT FROM NEW."evidenceVersion"::text OR
    NEW."plan"->'source'->>'amendmentId' IS DISTINCT FROM NEW."amendmentId"::text OR
    NEW."plan"->'source'->>'sourceRevision' IS DISTINCT FROM NEW."sourceRevision"::text OR
    NEW."plan"->'source'->'fields' IS DISTINCT FROM evidence."snapshot"->'effective'->'fields' THEN
    RAISE EXCEPTION 'Retirement must retain its exact physical source and interpretation' USING ERRCODE = '23514';
  END IF;
  IF NEW."plan"->'assetBefore'->>'id' IS DISTINCT FROM current_asset."id"::text OR
    NEW."plan"->'assetBefore'->>'productId' IS DISTINCT FROM current_asset."productId"::text OR
    NEW."plan"->'assetBefore'->>'serialNumber' IS DISTINCT FROM current_asset."serialNumber" OR
    NEW."plan"->'assetBefore'->>'assetTag' IS DISTINCT FROM current_asset."assetTag" OR
    NEW."plan"->'assetBefore'->>'status' IS DISTINCT FROM current_asset."status"::text OR
    NEW."plan"->'assetBefore'->>'isActive' IS DISTINCT FROM current_asset."isActive"::text OR
    (NEW."plan"->'assetBefore'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM current_asset."updatedAt" OR
    (NEW."plan"->'assetBefore'->'product'->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM current_product."updatedAt" THEN
    RAISE EXCEPTION 'Retirement plan must match current asset and product state' USING ERRCODE = '23514';
  END IF;
  IF NOT ((NEW."result" @> '{"status":"DECOMMISSIONED","isActive":false}'::jsonb) IS TRUE) OR
    NEW."result"->>'id' IS DISTINCT FROM NEW."assetId"::text OR
    NEW."result"->>'productId' IS DISTINCT FROM current_asset."productId"::text OR
    NEW."result"->>'serialNumber' IS DISTINCT FROM current_asset."serialNumber" OR NEW."result"->>'assetTag' IS DISTINCT FROM current_asset."assetTag" OR
    (NEW."result"->>'decommissionedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."decommissionedAt" OR
    (NEW."result"->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW."appliedAt" THEN
    RAISE EXCEPTION 'Retirement result must preserve identity and its exact terminal state' USING ERRCODE = '23514';
  END IF;
  received_text := btrim(coalesce(evidence."snapshot"->'effective'->'fields'->>'receivedDate', ''));
  IF upper(received_text) NOT IN ('', 'N/A', 'NA', 'N.A.', 'S/N', 'SIN SERIE', 'SIN ACTIVO', '-') THEN
    received_day := left(received_text, 10);
    IF received_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?)?$' OR
      received_day < '1900-01-01' OR received_day > to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') OR
      to_char(received_day::date, 'YYYY-MM-DD') <> received_day THEN
      RAISE EXCEPTION 'Retirement cannot ignore an invalid receipt day' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."plan"->'source'->>'sourceReceivedDay' IS DISTINCT FROM received_day THEN
    RAISE EXCEPTION 'Retirement must preserve its actual source receipt bound' USING ERRCODE = '23514';
  END IF;
  IF received_day IS NOT NULL AND left(request->>'confirmedAt', 10) < received_day THEN
    RAISE EXCEPTION 'Retirement cannot precede the known local receipt day' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(evidence."snapshot"->'issues') i WHERE i->>'severity' = 'WARNING' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."plan"->'warnings') w WHERE w->'issue' = i AND request->'acknowledgedWarnings' ? (w->>'id')
  )) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(request->'acknowledgedWarnings') a(value) WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."plan"->'warnings') w WHERE w->>'id' = a.value
  )) THEN RAISE EXCEPTION 'Retirement requires exact acknowledgement of every source warning' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportRetirementApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ImportRetirementApplication"
FOR EACH ROW EXECUTE FUNCTION guard_import_retirement_application();

CREATE FUNCTION guard_import_retirement_asset() RETURNS trigger AS $$
DECLARE application "ImportRetirementApplication"%ROWTYPE;
BEGIN
  SELECT * INTO application FROM "ImportRetirementApplication" WHERE "assetId" = OLD."id";
  IF application."id" IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."status" = 'DECOMMISSIONED' THEN
    RAISE EXCEPTION 'Imported retirement state is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'DECOMMISSIONED' OR NEW."isActive" OR NEW."decommissionedAt" IS DISTINCT FROM application."decommissionedAt" OR
    NEW."updatedAt" IS DISTINCT FROM application."appliedAt" OR
    (to_jsonb(NEW) - ARRAY['status','isActive','decommissionedAt','updatedAt']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','isActive','decommissionedAt','updatedAt']) THEN
    RAISE EXCEPTION 'Imported retirement may change only its confirmed terminal state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Asset_import_retirement_guard" BEFORE UPDATE OR DELETE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION guard_import_retirement_asset();

CREATE FUNCTION verify_import_retirement_complete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Asset" WHERE "id" = NEW."assetId" AND "status" = 'DECOMMISSIONED' AND NOT "isActive" AND
    "decommissionedAt" = NEW."decommissionedAt" AND "updatedAt" = NEW."appliedAt") THEN
    RAISE EXCEPTION 'Retirement receipt and terminal asset update must commit together' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "ImportRetirementApplication_complete_guard" AFTER INSERT ON "ImportRetirementApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_import_retirement_complete();

CREATE FUNCTION guard_retirement_evidence_amendment() RETURNS trigger AS $$
BEGIN
  -- The existing alphabetically earlier amendment guard already holds the source/evidence locks.
  IF EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" = NEW."evidenceId") THEN
    RAISE EXCEPTION 'Applied retirement evidence cannot be amended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportEvidenceAmendment_retirement_guard" BEFORE INSERT ON "ImportEvidenceAmendment"
FOR EACH ROW EXECUTE FUNCTION guard_retirement_evidence_amendment();

CREATE FUNCTION guard_retirement_assignment_boundary() RETURNS trigger AS $$
DECLARE retirement_at TIMESTAMP(3);
BEGIN
  -- The existing assignment period guard locks this asset first.
  SELECT "decommissionedAt" INTO retirement_at FROM "ImportRetirementApplication" WHERE "assetId" = NEW."assetId";
  IF retirement_at IS NOT NULL AND (NEW."endedAt" IS NULL OR NEW."endedAt" > retirement_at) THEN
    RAISE EXCEPTION 'Assignments cannot extend beyond an imported retirement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Assignment_retirement_boundary_guard" BEFORE INSERT OR UPDATE ON "Assignment"
FOR EACH ROW EXECUTE FUNCTION guard_retirement_assignment_boundary();

CREATE FUNCTION guard_retirement_assignment_evidence() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ImportRetirementApplication" WHERE "evidenceId" IN (NEW."startEvidenceId", NEW."endEvidenceId")) THEN
    RAISE EXCEPTION 'Retirement evidence cannot become an assignment endpoint' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImportAssignmentItem_retirement_guard" BEFORE INSERT ON "ImportAssignmentItem"
FOR EACH ROW EXECUTE FUNCTION guard_retirement_assignment_evidence();

COMMIT;
