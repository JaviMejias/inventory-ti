import { Prisma, type PrismaClient } from '@prisma/client';

import { ApiError } from '../lib/errors.js';
import { buildHistoricalObservations, historicalLinkBasis, historyRequestDigest, historyRulesVersion, type HistoryAppliedItem } from './history.js';
import type { HistoryCaptureInput, HistoryPageQuery } from './history-schemas.js';
import { buildResolvedPreview } from './identity.js';
import { importPlanDigest, type PlanDecision } from './plan.js';
import { buildWorkbookPreview, previewDate } from './preview.js';
import { readPreviewAssets } from './snapshot.js';
import { readResolvedSource } from './source-service.js';
import { currentHistoricalEvidence, latestAmendmentInclude } from './evidence-current.js';

const receiptInclude = { items: { orderBy: [{ recordId: 'asc' as const }, { kind: 'asc' as const }] } };
const captureSelect = { id: true, batchId: true, batchVersion: true, sourceRevision: true, sourceHash: true, historyPreviewId: true,
  note: true, evidenceReference: true, rulesVersion: true, capturedById: true, capturedAt: true };
const scope = { scope: 'HISTORICAL_EVIDENCE_ONLY' as const, affectsCurrentState: false, canApply: false };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

export async function readHistoryPreview(transaction: Prisma.TransactionClient, id: string) {
  const resolved = await readResolvedSource(transaction, id);
  const asOf = previewDate();
  const original = buildWorkbookPreview(resolved.original, [], asOf);
  const effective = buildResolvedPreview(resolved.original, resolved.workbook, await readPreviewAssets(transaction), asOf, 'DATABASE');
  const decisions = await transaction.$queryRaw<PlanDecision[]>`
    SELECT DISTINCT ON ("targetType", "targetId") "id", "targetType", "targetId", "action", "linkedAssetId", "batchVersion", "sourceRevision"
    FROM "ImportReviewDecision" WHERE "batchId" = ${id}::uuid ORDER BY "targetType", "targetId", "batchVersion" DESC`;
  const applied: HistoryAppliedItem[] = await transaction.importApplicationItem.findMany({ where: { sourceHash: resolved.batch.sourceHash },
    select: { id: true, candidateId: true, assetId: true }, orderBy: { candidateId: 'asc' }, take: 15001 });
  if (applied.length > 15000) throw new ApiError(409, 'HISTORY_SOURCE_LIMIT', 'Historical application evidence exceeds the supported source limit');
  const stored = await transaction.importHistoricalEvidence.findMany({ where: { sourceHash: resolved.batch.sourceHash },
    select: { id: true, captureId: true, recordId: true, kind: true, assetId: true, capturedAt: true }, orderBy: [{ recordId: 'asc' }, { kind: 'asc' }], take: 60001 });
  if (stored.length > 60000) throw new ApiError(409, 'HISTORY_SOURCE_LIMIT', 'Historical evidence exceeds the supported source limit');
  const observations = buildHistoricalObservations(original, effective, resolved.sourceContext);
  const storedByKey = new Map(stored.map((entry) => [entry.recordId + ':' + entry.kind, entry]));
  const historyPreviewId = importPlanDigest({ rulesVersion: historyRulesVersion, sourceRulesVersion: effective.rulesVersion,
    batchId: id, batchVersion: resolved.batch.version, sourceRevision: resolved.sourceContext.revision, payloadDigest: effective.payloadDigest,
    databaseSnapshotDigest: effective.databaseSnapshotDigest, asOf, applied, decisions, stored: stored.map(({ id, recordId, kind }) => ({ id, recordId, kind })) });
  return { resolved, effective, observations, decisions, applied, storedByKey, historyPreviewId };
}

export async function previewHistoricalEvidence(database: PrismaClient, id: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    const view = await readHistoryPreview(transaction, id);
    const observations = view.observations.slice(query.offset, query.offset + query.limit).map((observation) => {
      const candidateAssets = [...new Set([...observation.suggestedAssets.map((asset) => asset.id),
        ...view.applied.filter((item) => item.candidateId === observation.candidateId).map((item) => item.assetId)])];
      return { ...observation, stored: view.storedByKey.get(observation.recordId + ':' + observation.kind) ?? null,
        linkOptions: candidateAssets.flatMap((assetId) => {
          const basis = historicalLinkBasis(observation, assetId, view.decisions, view.applied, view.resolved.sourceContext);
          return basis ? [{ assetId, basis }] : [];
        }) };
    });
    const total = view.observations.length;
    return { ...scope, mode: 'HISTORY_PREVIEW', persisted: false, batchId: id, batchVersion: view.resolved.batch.version,
      sourceRevision: view.resolved.sourceContext.revision, historyRulesVersion, historyPreviewId: view.historyPreviewId,
      observations, total, limit: query.limit, offset: query.offset, hasMore: query.offset + observations.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}

export async function captureHistoricalEvidence(database: PrismaClient, id: string, input: HistoryCaptureInput, actorId: string) {
  try {
    return await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
      await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
      const batch = await transaction.importBatch.findUnique({ where: { id } });
      if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
      const requestDigest = historyRequestDigest(input);
      const previous = await transaction.importHistoryCapture.findUnique({ where: { batchId_requestId: { batchId: id, requestId: input.requestId } }, include: receiptInclude });
      if (previous) {
        if (previous.capturedById !== actorId || previous.requestDigest !== requestDigest) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id belongs to a different historical capture');
        return { ...scope, persisted: true, capture: previous, reused: true };
      }
      if (batch.version !== input.expectedVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the review batch before capturing evidence', { currentVersion: batch.version });
      await transaction.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${batch.sourceHash}, 0))`;
      for (const assetId of [...new Set(input.records.flatMap((entry) => entry.assetId ? [entry.assetId] : []))].sort()) {
        const rows = await transaction.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Asset" WHERE "id" = ${assetId}::uuid FOR SHARE`;
        if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Linked asset not found');
      }
      const view = await readHistoryPreview(transaction, id);
      if (view.resolved.sourceContext.revision !== input.expectedSourceRevision) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source interpretation before capturing evidence', { currentRevision: view.resolved.sourceContext.revision });
      const selected = input.records.map((entry) => {
        const observation = view.observations.find((observation) => observation.recordId === entry.recordId && observation.kind === entry.kind);
        if (!observation) throw new ApiError(400, 'INVALID_HISTORICAL_TARGET', 'Select a mapped physical historical observation from this batch');
        const stored = view.storedByKey.get(entry.recordId + ':' + entry.kind);
        if (stored) throw new ApiError(409, 'HISTORY_EVIDENCE_ALREADY_CAPTURED', 'This source observation is already captured', { evidenceId: stored.id, captureId: stored.captureId });
        const linkBasis = historicalLinkBasis(observation, entry.assetId, view.decisions, view.applied, view.resolved.sourceContext);
        if (linkBasis === undefined) throw new ApiError(409, 'HISTORY_ASSET_LINK_UNCONFIRMED', 'Asset linkage requires an unambiguous reviewed identity or its pilot receipt');
        return { ...observation, assetId: entry.assetId, linkBasis };
      }).sort((a, b) => (a.recordId + a.kind).localeCompare(b.recordId + b.kind));
      if (view.historyPreviewId !== input.historyPreviewId) throw new ApiError(409, 'HISTORY_PREVIEW_CHANGED', 'Generate and review the current historical preview');
      const capture = await transaction.importHistoryCapture.create({ data: { batchId: id, batchVersion: batch.version, sourceRevision: input.expectedSourceRevision,
        sourceHash: batch.sourceHash, requestId: input.requestId, requestDigest, historyPreviewId: input.historyPreviewId,
        note: input.note, evidenceReference: input.evidenceReference, rulesVersion: historyRulesVersion, selection: json(selected), capturedById: actorId } });
      for (const observation of selected) await transaction.importHistoricalEvidence.create({ data: { captureId: capture.id, sourceHash: batch.sourceHash,
        recordId: observation.recordId, candidateId: observation.candidateId, kind: observation.kind, effectiveDay: observation.effectiveDay,
        assetId: observation.assetId, snapshot: json(observation) } });
      await transaction.auditLog.create({ data: { userId: actorId, action: 'IMPORT_HISTORY_EVIDENCE_CAPTURED', entityType: 'ImportHistoryCapture', entityId: capture.id,
        metadata: { batchId: id, batchVersion: batch.version, sourceRevision: input.expectedSourceRevision, sourceHash: batch.sourceHash, recordCount: selected.length, affectsCurrentState: false } } });
      return { ...scope, persisted: true, capture: await transaction.importHistoryCapture.findUniqueOrThrow({ where: { id: capture.id }, include: receiptInclude }), reused: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new ApiError(409, 'HISTORY_CAPTURE_CONFLICT', 'Source evidence or request was already captured; retrieve the original receipt');
      if (['P2034', 'P2028'].includes(error.code) || (error.code === 'P2010' && ['55P03', '40P01', '40001'].includes(String(error.meta?.code)))) {
        throw new ApiError(409, 'HISTORY_CAPTURE_BUSY', 'Historical capture is busy; retry with the same request id');
      }
    }
    throw error;
  }
}

export async function listHistoryCaptures(database: PrismaClient, id: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.importBatch.findUnique({ where: { id }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    const captures = await transaction.importHistoryCapture.findMany({ where: { batchId: id }, select: captureSelect, orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importHistoryCapture.count({ where: { batchId: id } });
    return { ...scope, captures, total, limit: query.limit, offset: query.offset, hasMore: query.offset + captures.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getHistoryCapture(database: PrismaClient, id: string, captureId: string) {
  const capture = await database.importHistoryCapture.findFirst({ where: { id: captureId, batchId: id }, include: receiptInclude });
  if (!capture) throw new ApiError(404, 'NOT_FOUND', 'Historical capture not found in this batch');
  return { ...scope, persisted: true, capture };
}

export async function listAssetImportedEvidence(database: PrismaClient, assetId: string, query: HistoryPageQuery) {
  return database.$transaction(async (transaction) => {
    if (!await transaction.asset.findUnique({ where: { id: assetId }, select: { id: true } })) throw new ApiError(404, 'NOT_FOUND', 'Asset not found');
    const candidates = Prisma.sql`SELECT "id" FROM "ImportHistoricalEvidence" WHERE "assetId" = ${assetId}::uuid
      UNION SELECT "evidenceId" FROM "ImportEvidenceAmendment" WHERE "assetId" = ${assetId}::uuid`;
    const ids = await transaction.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ImportHistoricalEvidenceCurrent" WHERE "assetId" = ${assetId}::uuid AND "id" IN (${candidates})
      ORDER BY "capturedAt" DESC, "id" DESC LIMIT ${query.limit} OFFSET ${query.offset}`;
    const stored = await transaction.importHistoricalEvidence.findMany({ where: { id: { in: ids.map((entry) => entry.id) } },
      include: { ...latestAmendmentInclude, capture: { select: captureSelect } }, orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }] });
    const evidence = stored.map(currentHistoricalEvidence);
    const [count] = await transaction.$queryRaw<{ total: number }[]>`SELECT count(*)::integer AS total FROM "ImportHistoricalEvidenceCurrent" WHERE "assetId" = ${assetId}::uuid AND "id" IN (${candidates})`;
    const total = count!.total;
    return { ...scope, evidence, total, limit: query.limit, offset: query.offset, hasMore: query.offset + evidence.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
