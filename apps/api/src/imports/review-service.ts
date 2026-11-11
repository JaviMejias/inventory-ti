import { Prisma, type ImportBatch, type ImportReviewDecision, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { ApiError } from '../lib/errors.js';
import { buildWorkbookPreview, previewDate, previewRulesVersion, workbookPayloadDigest } from './preview.js';
import type { BatchCreateInput, BatchListQuery, DecisionListQuery, ReviewDecisionInput } from './review-schemas.js';
import { workbookPreviewSchema } from './schemas.js';
import { readPreviewAssets } from './snapshot.js';
import { readResolvedSource } from './source-service.js';
import { buildResolvedPreview } from './identity.js';

const metadataSelect = {
  id: true, previewId: true, sourceFileName: true, sourceHash: true, payloadDigest: true, databaseSnapshotDigest: true,
  rulesVersion: true, asOf: true, version: true, targetCount: true, createdById: true, createdAt: true, updatedAt: true
} satisfies Prisma.ImportBatchSelect;
type BatchMetadata = Prisma.ImportBatchGetPayload<{ select: typeof metadataSelect }>;
const targetsSchema = z.object({
  candidates: z.array(z.object({ id: z.string(), serials: z.array(z.string()), tags: z.array(z.string()), existingAssets: z.array(z.object({ id: z.string() })) })),
  records: z.array(z.object({ id: z.string(), kind: z.string() }))
});

function json(value: unknown): Prisma.InputJsonValue {
  // Values originate from strict DTOs/the preview builder, with Dates serialized to ISO.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function batchDto(batch: BatchMetadata) {
  return { ...batch, mode: 'REVIEW' as const, persisted: true, canApply: false };
}

function targets(preview: unknown) {
  const parsed = targetsSchema.safeParse(preview);
  if (!parsed.success) throw new ApiError(409, 'INVALID_REVIEW_SNAPSHOT', 'Saved review snapshot cannot be interpreted');
  return parsed.data;
}

async function requireBatch(database: Pick<PrismaClient, 'importBatch'>, id: string) {
  const batch = await database.importBatch.findUnique({ where: { id }, select: metadataSelect });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  return batch;
}

async function reviewSummary(database: Prisma.TransactionClient, batch: BatchMetadata) {
  const counts = await database.$queryRaw<{ action: string; count: number }[]>`
    SELECT "action", count(*)::integer AS "count" FROM (
      SELECT DISTINCT ON ("targetType", "targetId") "action"
      FROM "ImportReviewDecision" WHERE "batchId" = ${batch.id}::uuid
      ORDER BY "targetType", "targetId", "batchVersion" DESC
    ) latest GROUP BY "action"`;
  const count = (action: string) => counts.find((row) => row.action === action)?.count ?? 0;
  const reviewedTargetCount = counts.reduce((sum, row) => sum + row.count, 0);
  const unreviewedCount = batch.targetCount - reviewedTargetCount;
  const holdCount = count('HOLD');
  return { targetCount: batch.targetCount, reviewedTargetCount, unreviewedCount, holdCount,
    excludedCount: count('EXCLUDE'), linkedCount: count('LINK_EXISTING'), newProposalCount: count('PROPOSE_NEW'),
    pendingTargetCount: unreviewedCount + holdCount, decisionCoverageComplete: unreviewedCount + holdCount === 0 };
}

export async function createImportBatch(database: PrismaClient, input: BatchCreateInput, actorId: string) {
  const saved = await database.importBatch.findUnique({ where: { previewId: input.previewId }, select: metadataSelect });
  if (saved) {
    if (saved.payloadDigest !== workbookPayloadDigest(input.workbook)) throw new ApiError(409, 'PREVIEW_PAYLOAD_CONFLICT', 'Saved preview belongs to a different source payload');
    return { batch: batchDto(saved), reused: true };
  }
  const preview = buildWorkbookPreview(input.workbook, await readPreviewAssets(database), previewDate(), 'DATABASE');
  if (preview.previewId !== input.previewId) throw new ApiError(409, 'PREVIEW_STALE', 'Generate a current preview before saving the batch');
  const targetCount = preview.candidates.length + preview.records.filter((record) => !['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind)).length;
  try {
    return await database.$transaction(async (transaction) => {
      const existing = await transaction.importBatch.findUnique({ where: { previewId: preview.previewId }, select: metadataSelect });
      if (existing) return { batch: batchDto(existing), reused: true };
      const batch = await transaction.importBatch.create({ select: metadataSelect, data: {
        previewId: preview.previewId, sourceFileName: input.workbook.source.fileName, sourceHash: input.workbook.source.sha256,
        payloadDigest: preview.payloadDigest, databaseSnapshotDigest: preview.databaseSnapshotDigest!, rulesVersion: preview.rulesVersion,
        asOf: preview.asOf, workbook: json(input.workbook), preview: json(preview), targetCount, createdById: actorId
      } });
      await transaction.auditLog.create({ data: { userId: actorId, entityType: 'ImportBatch', entityId: batch.id, action: 'IMPORT_BATCH_STAGED',
        metadata: { previewId: batch.previewId, sourceHash: batch.sourceHash, payloadDigest: batch.payloadDigest, rulesVersion: batch.rulesVersion } } });
      return { batch: batchDto(batch), reused: false };
    }, { timeout: 15000 });
  } catch (error) {
    // A simultaneous retry can win the unique previewId; never overwrite its source or author.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await database.importBatch.findUnique({ where: { previewId: preview.previewId }, select: metadataSelect });
      if (existing) return { batch: batchDto(existing), reused: true };
    }
    throw error;
  }
}

export async function listImportBatches(database: PrismaClient, query: BatchListQuery) {
  return database.$transaction(async (transaction) => {
    const where = query.sourceHash ? { sourceHash: query.sourceHash } : {};
    const batches = await transaction.importBatch.findMany({ where, select: metadataSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit, skip: query.offset });
    const total = await transaction.importBatch.count({ where });
    return { batches: batches.map(batchDto), total, limit: query.limit, offset: query.offset, hasMore: query.offset + batches.length < total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getImportBatch(database: PrismaClient, id: string) {
  return database.$transaction(async (transaction) => {
    const batch = await requireBatch(transaction, id);
    return { batch: batchDto(batch), reviewSummary: await reviewSummary(transaction, batch) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getImportSnapshot(database: PrismaClient, id: string) {
  const batch = await database.importBatch.findUnique({ where: { id }, select: { preview: true } });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  return { batchId: id, persisted: true, canApply: false, snapshot: batch.preview };
}

async function freshness(database: Pick<PrismaClient, 'asset'>, batch: Pick<ImportBatch, 'workbook' | 'rulesVersion' | 'databaseSnapshotDigest' | 'asOf'>) {
  const parsed = workbookPreviewSchema.safeParse(batch.workbook);
  if (!parsed.success) throw new ApiError(409, 'INVALID_REVIEW_SNAPSHOT', 'Saved source cannot be interpreted');
  const current = buildWorkbookPreview(parsed.data, await readPreviewAssets(database), previewDate(), 'DATABASE');
  const rulesChanged = batch.rulesVersion !== previewRulesVersion;
  const databaseChanged = current.databaseSnapshotDigest !== batch.databaseSnapshotDigest;
  return { stale: rulesChanged || databaseChanged, rulesChanged, databaseChanged, reviewDateChanged: batch.asOf !== current.asOf,
    checkedAsOf: current.asOf, currentPreviewId: current.previewId, canApply: false };
}

export async function getImportFreshness(database: PrismaClient, id: string) {
  const batch = await database.importBatch.findUnique({ where: { id } });
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
  return { batchId: id, ...await freshness(database, batch) };
}

function validateTarget(preview: unknown, input: ReviewDecisionInput) {
  const snapshot = targets(preview);
  if (input.targetType === 'RECORD') {
    const record = snapshot.records.find((record) => record.id === input.targetId && !['ASSET_OBSERVATION', 'RETIREMENT_HISTORY'].includes(record.kind));
    if (!record) throw new ApiError(400, 'INVALID_REVIEW_TARGET', 'Record is not a stand-alone target in this batch');
    return;
  }
  const candidate = snapshot.candidates.find((candidate) => candidate.id === input.targetId);
  if (!candidate) throw new ApiError(400, 'INVALID_REVIEW_TARGET', 'Candidate does not belong to this batch');
  if (input.action === 'LINK_EXISTING' && !candidate.existingAssets.some((asset) => asset.id === input.linkedAssetId)) throw new ApiError(409, 'ASSET_NOT_SUGGESTED', 'Select an existing asset suggested by this snapshot');
  if (input.action === 'PROPOSE_NEW' && (candidate.serials.length + candidate.tags.length === 0 || candidate.existingAssets.length > 0)) throw new ApiError(409, 'NEW_ASSET_PROPOSAL_CONFLICT', 'Candidate requires identity without an existing match');
}

export async function appendReviewDecision(database: PrismaClient, id: string, input: ReviewDecisionInput, actorId: string) {
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
    const batch = await transaction.importBatch.findUnique({ where: { id } });
    if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import review batch not found');
    const previous = await transaction.importReviewDecision.findUnique({ where: { batchId_requestId: { batchId: id, requestId: input.requestId } } });
    if (previous) {
      if (previous.reviewedById !== actorId || previous.batchVersion !== input.expectedVersion + 1 || previous.sourceRevision !== (input.expectedSourceRevision ?? 0) || previous.targetType !== input.targetType || previous.targetId !== input.targetId || previous.action !== input.action || previous.linkedAssetId !== (input.linkedAssetId ?? null) || previous.note !== input.note) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Request id already belongs to a different decision');
      }
      return { batch: batchDto(batch), decision: previous, reused: true };
    }
    if (batch.version !== input.expectedVersion) throw new ApiError(409, 'REVIEW_VERSION_CONFLICT', 'Reload the batch before saving a decision', { currentVersion: batch.version });
    const resolved = await readResolvedSource(transaction, id);
    if (resolved.sourceContext.revision !== (input.expectedSourceRevision ?? 0)) throw new ApiError(409, 'SOURCE_REVISION_CONFLICT', 'Reload the source before recording a decision', { currentRevision: resolved.sourceContext.revision });
    validateTarget(batch.preview, { ...input, action: input.action === 'LINK_EXISTING' || input.action === 'PROPOSE_NEW' ? 'HOLD' : input.action });
    if (input.action === 'LINK_EXISTING' || input.action === 'PROPOSE_NEW') {
      const preview = buildResolvedPreview(resolved.original, resolved.workbook, await readPreviewAssets(transaction), previewDate(), 'DATABASE');
      if (preview.databaseSnapshotDigest !== batch.databaseSnapshotDigest || preview.rulesVersion !== batch.rulesVersion) throw new ApiError(409, 'BATCH_SNAPSHOT_STALE', 'The saved rules or inventory snapshot changed; generate a new preview');
      validateTarget(preview, input);
    }
    const updated = await transaction.importBatch.update({ where: { id }, data: { version: { increment: 1 } }, select: metadataSelect });
    const decision = await transaction.importReviewDecision.create({ data: {
      batchId: id, batchVersion: updated.version, sourceRevision: resolved.sourceContext.revision, requestId: input.requestId, targetType: input.targetType, targetId: input.targetId,
      action: input.action, linkedAssetId: input.linkedAssetId ?? null, note: input.note, reviewedById: actorId
    } });
    await transaction.auditLog.create({ data: { userId: actorId, entityType: 'ImportBatch', entityId: id, action: 'IMPORT_REVIEW_DECISION_RECORDED',
      metadata: { version: updated.version, decisionId: decision.id, targetType: decision.targetType, targetId: decision.targetId, action: decision.action, linkedAssetId: decision.linkedAssetId } } });
    return { batch: batchDto(updated), decision, reused: false };
  }, { timeout: 15000 });
}

export async function listReviewDecisions(database: PrismaClient, id: string, query: DecisionListQuery) {
  return database.$transaction(async (transaction) => {
    await requireBatch(transaction, id);
    const filter = Prisma.sql`WHERE "batchId" = ${id}::uuid
      AND (${query.targetType ?? null}::"ImportReviewTargetType" IS NULL OR "targetType" = ${query.targetType ?? null}::"ImportReviewTargetType")
      AND (${query.targetId ?? null}::text IS NULL OR "targetId" = ${query.targetId ?? null}::text)`;
    const selected = query.mode === 'latest'
      ? Prisma.sql`SELECT DISTINCT ON ("targetType", "targetId") * FROM "ImportReviewDecision" ${filter} ORDER BY "targetType", "targetId", "batchVersion" DESC`
      : Prisma.sql`SELECT * FROM "ImportReviewDecision" ${filter}`;
    const decisions = await transaction.$queryRaw<ImportReviewDecision[]>(Prisma.sql`SELECT * FROM (${selected}) selected ORDER BY "batchVersion" DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
    const [count] = await transaction.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT count(*)::integer AS total FROM (${selected}) selected`);
    return { decisions, mode: query.mode, total: count.total, limit: query.limit, offset: query.offset, hasMore: query.offset + decisions.length < count.total };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
